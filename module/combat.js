import { MORTAL_WOUND_STATE, requestSave } from "./damage.js";
import { localizeParam } from "./utils.js";
import { createCyberpunkChatMessage } from "./compat.js";

/** Cumulative penalty per extra action taken in the same turn (optional rule). */
const ACTION_PENALTY_STEP = -3;

/** The flag the optional action economy counts against. */
const ACTIONS_TAKEN_FLAG = "actionsTaken";

export class CyberpunkCombat extends Combat {

  /**
   * The d10 a whole side shares this round under the party-initiative rule.
   *
   * Only a GM can persist it: a player may update nothing on a Combat but `round`, `turn` and
   * `combatants` (`common/documents/combat.mjs` `#canUpdate`, 14.365.0), so a player rolling their
   * own initiative before the GM has rolled the side gets a die of their own.
   *
   * @param {"party"|"opposition"} side
   * @returns {Promise<number>}
   */
  async #sharedInitiativeDie(side) {
    const stored = this.getFlag("cyberpunk2020", "partyInitiative");
    if (stored?.round === this.round && Number.isFinite(stored[side])) return stored[side];

    const roll = await new Roll("1d10").evaluate();

    if (game.user.isGM) {
      const next = stored?.round === this.round ? { ...stored } : { round: this.round };
      next[side] = roll.total;
      await this.setFlag("cyberpunk2020", "partyInitiative", next);
    }

    return roll.total;
  }

  /** @override */
  async rollInitiative(ids, options = {}) {
    if (options.formula || !game.settings.get("cyberpunk2020", "partyInitiative")) {
      return super.rollInitiative(ids, options);
    }

    const sides = new Map();
    for (const id of (typeof ids === "string" ? [ids] : ids)) {
      const combatant = this.combatants.get(id);
      if (!combatant?.isOwner) continue;

      const side = combatant.isNPC ? "opposition" : "party";
      if (!sides.has(side)) sides.set(side, []);
      sides.get(side).push(id);
    }

    for (const [side, sideIds] of sides) {
      const die = await this.#sharedInitiativeDie(side);
      // The system formula leads with the individual d10; group initiative replaces exactly that
      // term, so every REF and modifier term still resolves per combatant.
      const formula = String(CONFIG.Combat.initiative.formula || game.system.initiative)
        .replace(/^\s*1d10/, String(die));
      await super.rollInitiative(sideIds, { ...options, formula });
    }

    return this;
  }

  /**
   * @override
   * Core calls this unbound (`combatants.contents.sort(this._sortCombatants)`), so it must not
   * reach for `this`.
   */
  _sortCombatants(a, b) {
    const ia = Number.isNumeric(a.initiative) ? a.initiative : -Infinity;
    const ib = Number.isNumeric(b.initiative) ? b.initiative : -Infinity;
    if (ia !== ib) return ib - ia;

    const ra = Number(a.actor?.system?.stats?.ref?.total) || 0;
    const rb = Number(b.actor?.system?.stats?.ref?.total) || 0;
    if (ra !== rb) return rb - ra;

    return a.id > b.id ? 1 : -1;
  }

  /** @override */
  async _onStartTurn(combatant, context) {
    await super._onStartTurn(combatant, context);

    const actor = combatant.actor;
    if (!actor) return;

    // unsetFlag always issues an update, even for a flag that is not there, and this runs on every
    // turn of every combatant.
    if (game.settings.get("cyberpunk2020", "actionEconomy")
      && actor.getFlag("cyberpunk2020", ACTIONS_TAKEN_FLAG) !== undefined) {
      await actor.unsetFlag("cyberpunk2020", ACTIONS_TAKEN_FLAG);
    }

    if (actor.woundState() < MORTAL_WOUND_STATE || actor.system.stabilized) return;

    await createCyberpunkChatMessage({
      speaker: ChatMessage.getSpeaker({ actor, token: combatant.token }),
      content: localizeParam("TurnStartDeathSave", { name: actor.name })
    });

    const save = await requestSave(actor, "death");
    if (!save.success) await actor.toggleStatusEffect("dead", { active: true, overlay: true });
  }
}

/**
 * The cumulative action-economy penalty for this actor, or null when the rule is off or the actor
 * is not in the running encounter — outside a turn order nothing ever resets the counter.
 *
 * @param {CyberpunkActor} actor
 * @returns {number|null}
 */
export function actionPenaltyFor(actor) {
  if (!game.settings.get("cyberpunk2020", "actionEconomy")) return null;
  if (!game.combat?.combatants.some(c => c.actorId === actor.id)) return null;

  const taken = Number(actor.getFlag("cyberpunk2020", ACTIONS_TAKEN_FLAG)) || 0;
  // Not `STEP * taken`: at zero that is -0, which the dialog would render as "-0".
  return taken ? ACTION_PENALTY_STEP * taken : 0;
}

/**
 * Charge one action against the economy. A no-op whenever `actionPenaltyFor` returns null.
 *
 * @param {CyberpunkActor} actor
 * @returns {Promise<void>}
 */
export async function chargeAction(actor) {
  if (actionPenaltyFor(actor) === null) return;

  const taken = Number(actor.getFlag("cyberpunk2020", ACTIONS_TAKEN_FLAG)) || 0;
  await actor.setFlag("cyberpunk2020", ACTIONS_TAKEN_FLAG, taken + 1);
}

/**
 * Tell the local player their combatant is up, or up next. `combatTurnChange` fires on every
 * client, so ownership is the whole filter; a GM owns everything and is left out deliberately.
 *
 * @param {Combat} combat
 * @param {object} previous
 * @param {object} current
 */
export function announceTurn(combat, previous, current) {
  if (game.user.isGM) return;
  // combatTurnChange is not gated on the encounter being the active one (`_manageTurnEvents` is
  // called unconditionally from `_onUpdate`, `client/documents/combat.mjs:647`, 14.365.0), while
  // core's own turn cue is (`:661`). Without this a second, idle encounter announces turns too.
  if (!combat.active || !combat.started) return;
  if (!game.settings.get("cyberpunk2020", "turnSound")) return;

  const turns = combat.turns;
  if (!turns.length) return;

  // Core already plays a turn cue with the same ownership filter (`client/documents/combat.mjs`
  // :661-665, 14.365.0), but only once a combat theme is chosen, and its default is "none".
  const coreIsSilent = game.settings.get("core", "combatTheme") === "none";

  const signal = (key, combatant) => {
    ui.notifications.info(localizeParam(key, { name: combatant.name }));
    if (coreIsSilent) foundry.audio.AudioHelper.play({ src: CONFIG.sounds.notification });
  };

  // Being current wins over being on deck: in a one- or two-combatant encounter the same actor is
  // both, and a round change would otherwise announce twice.
  const active = combat.combatants.get(current.combatantId);
  if (active?.actor?.isOwner) return signal("YourTurn", active);

  const onDeck = turns[(current.turn + 1) % turns.length];
  if (onDeck?.actor?.isOwner) signal("OnDeck", onDeck);
}
