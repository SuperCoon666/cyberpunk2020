import { MORTAL_WOUND_STATE, requestSave, tickDot } from "./damage.js";
import { localizeParam } from "./utils.js";
import { createCyberpunkChatMessage } from "./compat.js";
import { BaseDie } from "./dice.js";
import { DODGE_SKILL_ID } from "./lookups.js";
import { SUPPRESSION_FLAG } from "./zones.js";

/** Cumulative penalty per extra action taken in the same turn (optional rule). */
const ACTION_PENALTY_STEP = -3;

/** The flag the optional action economy counts against. */
const ACTIONS_TAKEN_FLAG = "actionsTaken";

/** The flag a declared dodge sets, read by ranged attacks under the house rule. */
const DODGING_FLAG = "dodging";

/** House rule: what a declared dodge costs a ranged attacker. */
const DODGE_VS_RANGED_PENALTY = -2;

/**
 * The states that cannot oppose a melee attack at all. Ch. 07:569 — a failed Stun/Shock Save
 * "means the character is out of combat" — and `cpStunned` is exactly that state.
 */
const INCAPACITATED_STATUSES = ["dead", "cpStunned"];

/**
 * The querying side gives up at 30 s, so the owner's dialog closes at 25 and the defense rolls
 * itself: the answer has to be sent before the deadline, not on it.
 */
const DEFENSE_QUERY_TIMEOUT_MS = 30000;
export const DEFENSE_PROMPT_DEADLINE_MS = 25000;

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

    // A declared dodge lasts until the dodger's own next turn.
    if (actor.getFlag("cyberpunk2020", DODGING_FLAG) !== undefined) {
      await actor.unsetFlag("cyberpunk2020", DODGING_FLAG);
    }

    await tickDot(actor);

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
 * Roll the defender's side of an opposed melee attack. An NPC defends on the spot; a player
 * character's owner is asked which skill to use, and the best one is rolled anyway if they do not
 * answer in time — ignoring the prompt must never cost the player anything.
 *
 * @param {CyberpunkActor} defender
 * @param {number} attackTotal
 * @param {object} context
 * @param {string} context.attackerName
 * @param {string} context.itemName
 * @returns {Promise<{total: number, label: string, roll: Roll, hit: boolean}|null>} hit is the
 *   attacker's result: ch. 04 gives a tie to the defender. Null when the defender is incapacitated,
 *   which is what leaves the attack uncontested
 */
export async function resolveDefense(defender, attackTotal, { attackerName, itemName }) {
  // A Mortal but conscious defender still defends: his severity already reaches the roll through
  // the wound penalties folded into `ref.total`.
  if (INCAPACITATED_STATUSES.some(id => defender.statuses.has(id))) return null;

  const options = defender.defenseOptions();
  const owner = defender.type === "npc"
    ? null
    : game.users.players.find(u => u.active && defender.testUserPermission(u, "OWNER"));

  let choice = null;
  if (owner && options.length) {
    // Nothing else is posted until the answer arrives, so without this the attacker and the GM
    // watch a blank screen for up to 30 s while the defender is the only one who can see why.
    await createCyberpunkChatMessage({
      speaker: ChatMessage.getSpeaker({ actor: defender }),
      content: localizeParam("DefensePending", { attacker: attackerName, defender: defender.name })
    });

    try {
      choice = await owner.query(
        "cyberpunk2020.defensePrompt",
        { attackerName, itemName, defenderActorUuid: defender.uuid, attackTotal, choices: options },
        { timeout: DEFENSE_QUERY_TIMEOUT_MS }
      );
    } catch (err) {
      // The owner disconnected or the query outlived its deadline; the defense still has to happen.
    }
  }

  const picked = options.find(o => o.skillId === choice?.skillId) ?? options[0] ?? null;
  const extraMod = Number(choice?.extraMod) || 0;
  const base = picked?.total ?? (Number(defender.system.stats.ref.total) || 0);

  const roll = await new Roll(`${BaseDie} + @defense + @extraMod`, { defense: base, extraMod }).evaluate();

  if (picked?.skillId === DODGE_SKILL_ID) await declareDodge(defender);

  return {
    total: roll.total,
    label: picked?.label ?? "",
    roll,
    hit: attackTotal > roll.total
  };
}

/**
 * Record that this actor is dodging, until the start of their next turn. A no-op while the house
 * rule is off, so a world that never enables it does not accumulate the flag.
 *
 * @param {CyberpunkActor} actor
 * @returns {Promise<void>}
 */
export async function declareDodge(actor) {
  if (!game.settings.get("cyberpunk2020", "dodgeVsRanged")) return;
  // The defense is resolved on the attacker's client, which for a player attacking an NPC has no
  // permission on the defender. Losing the flag costs a -2; letting the rejected update propagate
  // would lose the attack card with it.
  if (!actor.isOwner) return;
  await actor.setFlag("cyberpunk2020", DODGING_FLAG, true);
}

/**
 * The house-rule penalty a ranged attacker takes against a target who declared a dodge.
 *
 * @param {CyberpunkActor} [targetActor]
 * @returns {number} 0 when the rule is off, there is no target, or the target is not dodging
 */
export function dodgeRangedPenalty(targetActor) {
  if (!targetActor) return 0;
  if (!game.settings.get("cyberpunk2020", "dodgeVsRanged")) return 0;
  return targetActor.getFlag("cyberpunk2020", DODGING_FLAG) ? DODGE_VS_RANGED_PENALTY : 0;
}

/**
 * Sweep the fire zones an encounter left behind. RAW's zone lasts one attack; this system's lasts
 * until the encounter ends or the GM deletes it, so the end of the encounter is where the sweep
 * belongs. Only Regions this system laid are touched — a GM's own are left alone.
 *
 * @param {Combat} combat
 * @returns {Promise<void>}
 */
export async function clearSuppressionZones(combat) {
  if (!game.user.isActiveGM) return;

  const scene = combat.scene;
  if (!scene) return;

  const ids = scene.regions
    .filter(region => region.getFlag("cyberpunk2020", SUPPRESSION_FLAG))
    .map(region => region.id);
  if (ids.length) await scene.deleteEmbeddedDocuments("Region", ids);
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
