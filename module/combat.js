import { MORTAL_WOUND_STATE, hiddenMessageMode, requestSave, tickDot } from "./damage.js";
import { displayName, localizeParam, localizeParamEscaped } from "./utils.js";
import { createCyberpunkChatMessage } from "./compat.js";
import { BaseDie } from "./dice.js";
import { DODGE_SKILL_ID, isCombatAutomationEnabled } from "./lookups.js";
import { SUPPRESSION_FLAG, ZONE_FLAG } from "./zones.js";

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

/** The dodge hand-off has no human in the loop — it is one flag write on the GM's client. */
const DODGE_QUERY_TIMEOUT_MS = 5000;

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
      // `render: false` rather than setFlag: nothing displays this flag, and a Combat update the
      // tracker is not viewing throws in core — `renderData.find(...)` is undefined and
      // `"turn" in data` follows it (`client/applications/sidebar/tabs/combat-tracker.mjs:186-188`,
      // 14.365.0). Suppressing the render this write does not need keeps the system out of it.
      //
      // ForcedReplacement, because a flag write otherwise **merges**: the previous round's other
      // side survived into the new round's object and the reader's own round test then accepted
      // it, so whichever side rolled second kept its first die for the rest of the fight (`T86`).
      // Scoped to this one flag rather than `recursive: false`, which would replace every other
      // module's flags with it.
      await this.update({
        "flags.cyberpunk2020.partyInitiative": new foundry.data.operators.ForcedReplacement(next)
      }, { render: false });
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

    // A turn that belongs to a token the players cannot see is announced and rolled to the GMs
    // alone; `combatant.hidden` is the combatant's own state, which a GM can set independently.
    const messageMode = hiddenMessageMode(combatant.hidden);

    // The flag test alone, deliberately: a counter charged before the rule (or the master switch)
    // went off would otherwise freeze for the life of the world and be resurrected by a later
    // re-enable. unsetFlag always issues an update, even for a flag that is not there, and this
    // runs on every turn of every combatant — which is what the test is for.
    if (actor.getFlag("cyberpunk2020", ACTIONS_TAKEN_FLAG) !== undefined) {
      await actor.unsetFlag("cyberpunk2020", ACTIONS_TAKEN_FLAG);
    }

    // A declared dodge lasts until the dodger's own next turn.
    if (actor.getFlag("cyberpunk2020", DODGING_FLAG) !== undefined) {
      await actor.unsetFlag("cyberpunk2020", DODGING_FLAG);
    }

    await tickDot(actor, { messageMode });

    // A corpse is asked for nothing: the Death Save at the bottom of this function is what writes
    // `dead`, and without this gate it kept asking every turn for ever — a success against the
    // threshold changed nothing, because no code reads the result of a save by an actor that is
    // already dead (`T116`). `resolveDefense` reads the same status list for the same reason
    // (`T43`). The burn above is deliberately outside the gate: a body still burns.
    if (actor.statuses.has("dead")) return;

    // Both turn-start saves split the same way with the master switch off, which is D22's own
    // worked example: the notice is management and stays, the roll and the status it writes are
    // resolution and go. What is left is a reminder the table acts on itself.
    const automated = isCombatAutomationEnabled();

    // "You may make one Save roll every turn until you succeed" (ch. 02:119, ch. 07:582) — the same
    // Stun Save the wound track modifies, so a character who goes down deeper stays down longer.
    if (actor.statuses.has("cpStunned")) {
      await createCyberpunkChatMessage({
        speaker: ChatMessage.getSpeaker({ actor, token: combatant.token }),
        content: localizeParamEscaped("TurnStartStunSave", { name: displayName(actor, combatant.token) })
      }, { messageMode });

      if (automated) {
        const recovery = await requestSave(actor, "stun", { messageMode });
        if (recovery.success) await actor.toggleStatusEffect("cpStunned", { active: false });
      }
    }

    if (actor.woundState() < MORTAL_WOUND_STATE || actor.system.stabilized) return;

    await createCyberpunkChatMessage({
      speaker: ChatMessage.getSpeaker({ actor, token: combatant.token }),
      content: localizeParamEscaped("TurnStartDeathSave", { name: displayName(actor, combatant.token) })
    }, { messageMode });

    if (!automated) return;

    const save = await requestSave(actor, "death", { messageMode });
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
  // The sub-setting is D25's opt-in penalty (build (a)); the master is what makes it "functional
  // only when both are on". The dialog and the roll both reach this, so the AND lives here.
  if (!isCombatAutomationEnabled()) return null;
  if (!game.settings.get("cyberpunk2020", "actionEconomy")) return null;
  if (!game.combat?.combatants.some(c => c.actorId === actor.id)) return null;

  const taken = Number(actor.getFlag("cyberpunk2020", ACTIONS_TAKEN_FLAG)) || 0;
  // Not `STEP * taken`: at zero that is -0, which the dialog would render as "-0".
  return taken ? ACTION_PENALTY_STEP * taken : 0;
}

/**
 * Which turn of which encounter is running. Null outside a started one, where the per-turn flags
 * have nothing to expire them and are therefore never written.
 *
 * @returns {string|null}
 */
export function currentTurnKey() {
  const combat = game.combat;
  return combat?.started ? `${combat.id}.${combat.round}.${combat.turn}` : null;
}

/**
 * Charge one action against the economy. A no-op whenever `actionPenaltyFor` returns null.
 *
 * @param {CyberpunkActor} actor
 * @param {string|null} [declaredIn] The turn key the action was declared in, for a charge that has
 *   to survive a wait. `_onStartTurn` clears the counter, and a contested melee can outlive the
 *   attacker's own next turn start — landing on the far side of that clear would open the new turn
 *   at -3 for an attack made in the previous one.
 * @returns {Promise<void>}
 */
export async function chargeAction(actor, declaredIn = currentTurnKey()) {
  if (actionPenaltyFor(actor) === null) return;
  if (declaredIn !== currentTurnKey()) return;

  const taken = Number(actor.getFlag("cyberpunk2020", ACTIONS_TAKEN_FLAG)) || 0;
  await actor.setFlag("cyberpunk2020", ACTIONS_TAKEN_FLAG, taken + 1);
}

/**
 * Clear the per-turn flags an encounter leaves behind. Both are cleared by the owner's own turn
 * start and by nothing else, so an encounter that ends mid-round carries them into the next fight —
 * three actions in fight A become a -9 on the first attack of fight B.
 *
 * @param {Combatant[]|Collection<Combatant>} combatants
 * @returns {Promise<void>}
 */
export async function clearTurnFlags(combatants) {
  if (!game.user.isActiveGM) return;

  for (const combatant of combatants) {
    const actor = combatant.actor;
    if (!actor) continue;

    for (const flag of [ACTIONS_TAKEN_FLAG, DODGING_FLAG]) {
      if (actor.getFlag("cyberpunk2020", flag) === undefined) continue;
      await actor.unsetFlag("cyberpunk2020", flag);
    }
  }
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
 * @param {string} [context.messageMode] Visibility of the pending notice, for a hidden defender
 * @param {boolean} [context.hideAttacker] The attacker is an ambusher — see the query below
 * @returns {Promise<{total: number, label: string, roll: Roll, hit: boolean}|null>} hit is the
 *   attacker's result: ch. 04 gives a tie to the defender. Null when the defender is incapacitated,
 *   which is what leaves the attack uncontested
 */
export async function resolveDefense(defender, attackTotal,
  { attackerName, itemName, messageMode, hideAttacker = false }) {
  // One gate covers both call sites: `__meleeBonk` and `__martialBonk` already read
  // `hit = defense ? defense.hit : true`, so a null here is the uncontested v1.1.x attack.
  if (!isCombatAutomationEnabled()) return null;

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
      // D31 — the notice is public, so an ambusher is not named on it either. `hideAttacker` is
      // the same flag the prompt takes, so the three surfaces move together (`T103`).
      content: hideAttacker
        ? localizeParamEscaped("DefensePendingHidden", { defender: displayName(defender) })
        : localizeParamEscaped("DefensePending",
          { attacker: attackerName, defender: displayName(defender) })
    }, { messageMode });

    try {
      // D29.5 — an ambusher's prompt keeps the number, which is what makes the defender's choice
      // informed, and drops what identifies them. The item name goes with the name: a weapon called
      // by its own name gives the ambusher away almost as surely.
      choice = await owner.query(
        "cyberpunk2020.defensePrompt",
        {
          attackerName: hideAttacker ? "" : attackerName,
          itemName: hideAttacker ? "" : itemName,
          defenderActorUuid: defender.uuid, attackTotal, choices: options
        },
        { timeout: DEFENSE_QUERY_TIMEOUT_MS }
      );
    } catch (err) {
      // The owner disconnected or the query outlived its deadline; the defense still has to happen.
    }
  }

  const picked = options.find(o => o.skillId === choice?.skillId) ?? options[0] ?? null;
  const extraMod = Number(choice?.extraMod) || 0;

  // Two levels since `T232`/D58: the skill, then the maneuver. A skill the book gives no maneuver
  // list to (Melee, Fencing, Dodge & Escape, Athletics — `07:982`) carries no `actions`, and its
  // own total is the answer. An unanswered prompt falls through to `options[0]`'s best action,
  // which is the auto-defence an NPC gets — silence must never cost the player anything.
  // `DEFENSIVE_MARTIAL_ACTIONS` leads with Dodge and `find` takes the first match, so a Dodge/Block
  // tie resolves to Dodge — D57's ruling, and the same order `defenseOptions` builds `dodging` from.
  const maneuver = picked?.actions?.find(row => row.action === choice?.action)
    ?? picked?.actions?.find(row => row.total === picked.total)
    ?? null;
  const base = maneuver?.total ?? picked?.total ?? (Number(defender.system.stats.ref.total) || 0);

  const roll = await new Roll(`${BaseDie} + @defense + @extraMod`, { defense: base, extraMod }).evaluate();

  // A defence built out of the Dodge maneuver takes the house rule's -2, whatever skill carried it
  // (`T161`, D39). Where there is no maneuver to pick, the plain Dodge skill is that defence.
  const dodged = maneuver ? maneuver.action === "Dodge" : picked?.skillId === DODGE_SKILL_ID;
  if (dodged) await declareDodge(defender);

  return {
    total: roll.total,
    label: picked?.label ?? "",
    action: maneuver?.action ?? null,
    roll,
    hit: attackTotal > roll.total
  };
}

/**
 * Record that this actor is dodging, until the start of their next turn. A no-op while the house
 * rule is off, so a world that never enables it does not accumulate the flag.
 *
 * Only inside a started encounter: the declaration lasts "until the dodger's own next turn", and
 * outside a turn order there is no such moment — a flag written there sat on the actor for the rest
 * of the session, taking -2 off every ranged attack against them with nothing on the sheet to show
 * it (`T39`). The setting's hint says so rather than leaving it to be discovered.
 *
 * @param {CyberpunkActor} actor
 * @returns {Promise<void>}
 */
export async function declareDodge(actor) {
  // The martial Dodge action reaches this outside any contest, so the master is ANDed here rather
  // than left to the gate on `resolveDefense`.
  if (!isCombatAutomationEnabled()) return;
  if (!game.settings.get("cyberpunk2020", "dodgeVsRanged")) return;

  // Which fight this actor is in is a world fact, and `game.combat` is not one: it is the viewing
  // client's own tracker selection, and a scene-bound encounter is neither `isActive`
  // (`client/documents/combat.mjs:118-121`) nor inferred (`client/applications/sidebar/tabs/
  // combat-tracker.mjs:759-767`, 14.365.0) from any other scene. The declaration crosses clients,
  // so both ends name the encounter instead of asking their own canvas (`T87`).
  const combat = game.combats.find(c =>
    c.started && c.combatants.some(combatant => combatant.actorId === actor.id));
  if (!combat) return;

  if (actor.isOwner) {
    await actor.setFlag("cyberpunk2020", DODGING_FLAG, true);
    return;
  }

  // The defense resolves on the **attacker's** client, which for a player attacking an NPC owns
  // nothing on the defender. The active GM is the single writer everywhere else here, so the
  // declaration is handed over rather than dropped (`T41`) — a rejected update would have taken the
  // attack card with it.
  const gm = game.users.activeGM;
  if (!gm) return;

  try {
    await gm.query("cyberpunk2020.declareDodge", { actorUuid: actor.uuid, combatId: combat.id },
      { timeout: DODGE_QUERY_TIMEOUT_MS });
  } catch (err) {
    // The GM went away mid-attack. The dodge is worth -2 on someone else's roll; the attack card is
    // worth more, and it is what this is holding up.
  }
}

/**
 * Write a dodge declaration handed over by another client. Runs on the active GM.
 *
 * @param {object} payload
 * @param {string} payload.actorUuid
 * @param {string} payload.combatId The encounter the sender read, validated here as a document
 * @returns {Promise<boolean>} whether the flag was written
 */
export async function applyDeclaredDodge({ actorUuid, combatId } = {}) {
  if (!isCombatAutomationEnabled()) return false;
  // Another client's payload, written with the GM's rights, so the sender's own conditions are
  // re-applied here rather than trusted: they guard the *state*, not the sender, and a query is
  // reachable from any player's console (`T82`). Sender identity discriminates nothing — any player
  // may legitimately be attacking any actor, which is why the hand-off exists at all.
  if (!game.settings.get("cyberpunk2020", "dodgeVsRanged")) return false;

  const actor = await fromUuid(String(actorUuid ?? ""));
  if (actor?.documentName !== "Actor") return false;

  // The named encounter, not `game.combat` — see `declareDodge`. The guard is unweakened: the
  // encounter has to exist, be started, and be one this actor is actually fighting in.
  const combat = game.combats.get(String(combatId ?? ""));
  if (!combat?.started) return false;
  if (!combat.combatants.some(combatant => combatant.actorId === actor.id)) return false;

  await actor.setFlag("cyberpunk2020", DODGING_FLAG, true);
  return true;
}

/**
 * The house-rule penalty a ranged attacker takes against a target who declared a dodge.
 *
 * @param {CyberpunkActor} [targetActor]
 * @returns {number} 0 when the rule is off, there is no target, or the target is not dodging
 */
export function dodgeRangedPenalty(targetActor) {
  if (!targetActor) return 0;
  // `__shootModTerms` always runs, so this read survives every other gate and takes its own AND.
  if (!isCombatAutomationEnabled()) return 0;
  if (!game.settings.get("cyberpunk2020", "dodgeVsRanged")) return 0;
  return targetActor.getFlag("cyberpunk2020", DODGING_FLAG) ? DODGE_VS_RANGED_PENALTY : 0;
}

/**
 * Sweep the zones an encounter left behind — the fire zones and the drawn craters both (D119).
 * RAW's zone lasts one attack; this system's lasts until the encounter ends or the GM deletes it,
 * so the end of the encounter is where the sweep belongs. Only Regions this system laid are
 * touched — a GM's own are left alone.
 *
 * @param {Combat} combat
 * @returns {Promise<void>}
 */
export async function clearSuppressionZones(combat) {
  if (!game.user.isActiveGM) return;

  // Every scene, not `combat.scene`: a zone is laid on the scene the shooter's canvas was showing,
  // which the encounter need not be bound to, and an encounter bound to no scene swept nothing at
  // all — so a crater or a fire zone outlived the fight it belonged to and sat on the map (`T118`).
  // Only Regions this system laid are touched; a GM's own are left alone.
  for (const scene of game.scenes) {
    const ids = scene.regions
      .filter(region => region.getFlag("cyberpunk2020", SUPPRESSION_FLAG)
        || region.getFlag("cyberpunk2020", ZONE_FLAG))
      .map(region => region.id);
    if (ids.length) await scene.deleteEmbeddedDocuments("Region", ids);
  }
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
