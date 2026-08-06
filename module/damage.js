import { createCyberpunkChatMessage, renderCyberpunkTemplate } from "./compat.js";
import { localize, localizeParam, rollLocation, isRollableFormula } from "./utils.js";
import { CyberpunkActor } from "./actor/actor.js";
import { ATHLETICS_SKILL_ID, isCombatAutomationEnabled } from "./lookups.js";
import { Multiroll } from "./dice.js";

/**
 * The shape of flags.cyberpunk2020.attack. A card written by an older version is ignored rather
 * than guessed at, so the number changes whenever a field the apply path reads is added or moved.
 * 2: `kind` decides which apply path a card takes.
 * 3: the zone payload carries `sceneId`, and a spread carries its `corridor` and aimed location.
 * 4: the spread's `corridor.shooterTokenUuid` (`T235` — added at `T110` without a bump), and the
 *    ammunition snapshot carries `penHalvesSoft`/`penHalvesHard` and the electroshock save.
 */
export const ATTACK_FLAG_VERSION = 4;

/** The flag a damage-over-time effect burns down from, one tick per turn. */
const DOT_FLAG = "dot";

/** The victim's own record of how many electroshock hits they have taken, and when (`T98`). */
const SHOCK_FLAG = "shock";

/** Ch. 07:781 — *"reduced by -2 for every successive shot in a three-turn time period"*. */
const SHOCK_LADDER_STEP = -2;
const SHOCK_WINDOW_ROUNDS = 3;

/** Ch. 07:910 — soft armour at or under this stops nothing at all against a burn. */
const BURN_SOFT_SP_MINIMUM = 15;

/** Ch. 07:910 — a burn costs the soft armour it went through two points per tick. */
const BURN_ARMOR_WEAR = 2;

/** Only a cyberlimb absorbs a hit into its own SDP; Head and Torso implants do not. */
const LIMB_ZONES = new Set(["lArm", "rArm", "lLeg", "rLeg"]);

/** Ch. 06: a cyberlimb is useless at 20 points of damage and destroyed at 30. */
const LIMB_USELESS_AT = 20;
const LIMB_DESTROYED_AT = 30;

/** How many times a hit into a zone that no longer exists re-rolls its location (D38). */
const REDERIVE_ATTEMPTS = 6;

/** Ch. 07: a limb over the threshold in one hit is severed, the head kills outright. */
const SEVERABLE_ZONES = new Set(["Head", "lArm", "rArm", "lLeg", "rLeg"]);

/** woundState() counts wound slots four wide, so Mortal is the fourth. */
export const MORTAL_WOUND_STATE = 4;

/**
 * Whether this attacker is an ambusher — every token they have on the viewed scene is hidden.
 * An actor with no token there is not hidden: there is nothing on the map to give away.
 *
 * Here rather than on `CyberpunkItem`, because `zones.js` needs it too and importing `item.js`
 * there would close a cycle.
 *
 * @param {CyberpunkActor} [actor]
 * @returns {boolean}
 */
export function attackerIsHidden(actor) {
  const tokens = actor?.getActiveTokens?.(false, true) ?? [];
  return tokens.length > 0 && tokens.every(token => token.hidden);
}

/**
 * The querying side gives up at 30 s, so the owner's dialog closes at 25 and rolls itself: the
 * answer has to be sent before the deadline, not on it.
 */
const SAVE_QUERY_TIMEOUT_MS = 30000;
export const SAVE_PROMPT_DEADLINE_MS = 25000;

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The visibility a card about this token takes. Core does the same in the one place it faces the
 * question — `messageMode: messageMode ?? (combatant.hidden ? "gm" : undefined)`, *"Private rolls
 * for hidden combatants"* (`client/documents/combat.mjs:421`, 14.365.0) — and announcing an
 * ambusher by name, SP and wound level is what this avoids.
 *
 * @param {boolean} [hidden] Whether the token (or combatant) the card is about is hidden
 * @returns {"gm"|undefined} undefined leaves the poster's own chat mode alone
 */
export function hiddenMessageMode(hidden) {
  return hidden ? "gm" : undefined;
}

/**
 * The loaded ammunition's effect fields, taken at roll time.
 *
 * The ammunition in the weapon can change between the roll and the click, so these travel in the
 * card. The target's own state (SP, hardness, BTM, SDP) deliberately does not — it is read when
 * the damage is applied.
 *
 * @param {CyberpunkItem} item The weapon or cyberweapon being fired
 * @returns {object|null} null when the weapon has no ammunition item selected
 */
export function snapshotAmmo(item) {
  const sys = item._getWeaponSystem?.() ?? item.system ?? {};
  const ammo = item.actor?.items?.get(String(sys.ammoItemId ?? ""));
  if (ammo?.type !== "ammo") return null;

  const a = ammo.system ?? {};
  return {
    accuracyMod: numberOr(a.accuracyMod, 0),
    rawDamageMult: numberOr(a.rawDamageMult, 1),
    bonusDamageFormula: String(a.bonusDamageFormula ?? ""),
    armorMultSoft: numberOr(a.armorMultSoft, 1),
    armorMultHard: numberOr(a.armorMultHard, 1),
    penDamageMult: numberOr(a.penDamageMult, 1),
    // A field absent from an older document defaults to the flat AP rule, not to the slug's.
    penHalvesSoft: a.penHalvesSoft !== false,
    penHalvesHard: a.penHalvesHard !== false,
    stunSaveOnHit: !!a.stunSaveOnHit,
    stunSaveMod: numberOr(a.stunSaveMod, 0),
    dotEnabled: !!a.dotEnabled,
    dotTurns: numberOr(a.dotTurns, 0),
    dotDamageFormula: String(a.dotDamageFormula ?? ""),
    blastRadius: numberOr(a.blastRadius, 0),
    blastFullDamageWithin: numberOr(a.blastFullDamageWithin, 0),
    blastMultipliers: Array.isArray(a.blastMultipliers) ? [...a.blastMultipliers] : [],
    spreadMode: String(a.spreadMode ?? "single"),
    spreadWidthShort: numberOr(a.spreadWidthShort, 0),
    spreadWidthMedium: numberOr(a.spreadWidthMedium, 0),
    spreadWidthLong: numberOr(a.spreadWidthLong, 0),
    spreadDamageShort: String(a.spreadDamageShort ?? ""),
    spreadDamageMedium: String(a.spreadDamageMedium ?? ""),
    spreadDamageLong: String(a.spreadDamageLong ?? "")
  };
}

/**
 * Resolve one hit against one target. Pure: reads the target's derived data and returns the
 * breakdown, writing nothing.
 *
 * @param {object} hit
 * @param {number} hit.damage Rolled damage, ammunition raw multiplier already applied
 * @param {string} hit.zone Hit location key, e.g. "Torso"
 * @param {boolean} hit.ap Armour-piercing round
 * @param {object|null} hit.ammo Snapshot from snapshotAmmo
 * @param {CyberpunkActor} targetActor
 * @param {object} [options]
 * @param {number} [options.severanceThreshold] 0 disables the severance rule
 * @param {boolean} [options.doubleHead] Ch. 07's head rule. Off for damage that is not an attack
 * @returns {{sp: number, effSp: number, penetrating: number, headDoubled: boolean, btm: number,
 *            final: number, toSdp: number, severed: boolean}}
 */
export function resolveHit({ damage = 0, zone = "Torso", ap = false, ammo = null }, targetActor,
  { severanceThreshold = 0, doubleHead = true } = {}) {
  const location = targetActor?.system?.hitLocations?.[zone] ?? {};
  const sp = numberOr(location.stoppingPower, 0);

  const armorMult = location.hard
    ? numberOr(ammo?.armorMultHard, 1)
    : numberOr(ammo?.armorMultSoft, 1);

  let effSp = Math.floor(sp * armorMult);
  // RAW armour-piercing halves the armour whatever it is made of — ch. 07:865's *"normal AP ability
  // vs. all armors"* is stated of the slug too, so this half never branches on hardness.
  if (ap) effSp = Math.floor(effSp / 2);

  let penetrating = Math.max(0, Math.floor(damage) - effSp);
  // The second half does branch: a finned slug's penetrating damage survives hard armour whole
  // (ch. 07:865-873). Both flags default true, which is the flat AP rule (`T95`, D53 У3).
  const penHalves = location.hard
    ? (ammo?.penHalvesHard !== false)
    : (ammo?.penHalvesSoft !== false);
  if (ap && penHalves) penetrating = Math.floor(penetrating / 2);
  penetrating = Math.floor(penetrating * numberOr(ammo?.penDamageMult, 1));

  const headDoubled = doubleHead && zone === "Head" && penetrating > 0;
  if (headDoubled) penetrating *= 2;

  const btm = numberOr(targetActor?.system?.stats?.bt?.modifier, 0);

  // A cyberlimb takes the whole penetrating hit into its own SDP: no BTM, no wound track and, per
  // ch. 06, "no saving roll against shock and stun". The pool that absorbs is the pool that is
  // **left** — `sum` is what was installed, and reading it made a shot-off limb a permanent
  // shield (`T159`).
  const toCyberlimb = LIMB_ZONES.has(zone) && numberOr(targetActor?.system?.sdp?.current?.[zone], 0) > 0;
  const final = toCyberlimb || penetrating <= 0 ? 0 : Math.max(1, penetrating - btm);

  return {
    sp,
    effSp,
    penetrating,
    headDoubled,
    btm,
    final,
    toSdp: toCyberlimb ? penetrating : 0,
    // Measured after BTM — the threshold is tested against what reached the wound track. Strictly
    // greater, per the book's "more than 8 points", which is also what leaves 0 meaning off.
    severed: severanceThreshold > 0 && SEVERABLE_ZONES.has(zone) && final > severanceThreshold
  };
}

/**
 * Staged Penetration: every worn layer over a zone loses a point of SP per hit that got through it.
 * Written to the armor source here and nowhere else — the layering pass only reads it.
 *
 * @param {CyberpunkActor} actor
 * @param {Record<string, number>} hitsByZone Penetrating hits per zone
 * @param {object} [options]
 * @param {boolean} [options.softOnly] Skip hard armour — the burning rule wears soft armour only
 */
async function ablateArmor(actor, hitsByZone, { softOnly = false } = {}) {
  const updates = [];

  for (const armor of actor.itemTypes.armor) {
    if (!armor.system.equipped) continue;
    if (softOnly && armor.system.hard) continue;

    const update = {};
    for (const [zone, hits] of Object.entries(hitsByZone)) {
      const cover = armor.system.coverage?.[zone];
      const sp = numberOr(cover?.stoppingPower, 0);
      if (sp <= 0) continue;

      const ablation = numberOr(cover.ablation, 0);
      if (ablation >= sp) continue;
      update[`system.coverage.${zone}.ablation`] = Math.min(sp, ablation + hits);
    }

    if (!foundry.utils.isEmpty(update)) updates.push({ _id: armor.id, ...update });
  }

  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
}

/**
 * Roll one suppressive-fire save and post its card.
 *
 * Ch. 07:731 — *"rolling their Athletics Skill + REF + 1D10 and beating a save number"*. Unlike a
 * Stun or Death save this is a skill check, so it succeeds at or **above** the number rather than
 * under it, and the two must not be collapsed into one helper on that account.
 *
 * @param {CyberpunkActor} actor
 * @param {number} threshold The zone's save number
 * @param {object} [options]
 * @param {number} [options.mod] Situational modifier chosen by whoever rolls
 * @param {string} [options.messageMode] Visibility of the card, for a hidden token
 * @returns {Promise<{total: number, threshold: number, success: boolean}>}
 */
export async function rollZoneSave(actor, threshold, { mod = 0, messageMode } = {}) {
  const athletics = actor._getSkillByStableId(ATHLETICS_SKILL_ID);
  const bonus = (Number(actor.system.stats.ref.total) || 0)
    + CyberpunkActor.realSkillValue(athletics)
    + (Number(mod) || 0);

  const rolls = new Multiroll(localize("SaveZone"), localize("OverThresholdMessage"), { messageMode });
  rolls.addRoll(new Roll(bonus ? `1d10 + ${bonus}` : "1d10"), { name: localize("Save") });
  rolls.addRoll(new Roll(`${threshold}`), { name: localize("SaveZoneThreshold") });
  await rolls.defaultExecute();

  const total = rolls.rolls[0].total;
  return { total, threshold, success: total >= threshold };
}

/** The roll behind one save, whoever ends up asking for it. */
export function rollSaveOf(actor, kind, dc, mod = 0, messageMode = undefined) {
  return kind === "zone"
    ? rollZoneSave(actor, dc, { mod, messageMode })
    // A Stun or Death save derives its own threshold; `dc` overrides it for the rules that name a
    // threshold of their own — the severance save at Mortal 0 (`T144`) and the electroshock ladder
    // (`T98`). Tested for finiteness rather than truth: an electroshock threshold can reach exactly
    // 0, and `dc || undefined` would silently hand that save the victim's own number back.
    : actor.rollSave(kind, { mod, messageMode, threshold: Number.isFinite(dc) ? dc : undefined });
}

/**
 * Roll one save for the target. The GM's own client rolls unless the world asks a player
 * character's owner to roll their own, in which case the owner is queried.
 *
 * @param {CyberpunkActor} actor
 * @param {"stun"|"death"|"zone"} kind
 * @param {object} [options]
 * @param {number} [options.dc] The save number, for a zone save only
 * @param {string} [options.messageMode] Visibility of the card, for a hidden token
 * @returns {Promise<{total: number, threshold: number, success: boolean}>}
 */
export async function requestSave(actor, kind, { dc = null, messageMode } = {}) {
  const manual = game.settings.get("cyberpunk2020", "pcSaveMode") === "manual" && actor.type !== "npc";
  const owner = manual
    ? game.users.players.find(u => u.active && actor.testUserPermission(u, "OWNER"))
    : null;
  if (!owner) return rollSaveOf(actor, kind, dc, 0, messageMode);

  try {
    return await owner.query(
      "cyberpunk2020.savePrompt",
      { actorUuid: actor.uuid, kind, dc, messageMode },
      { timeout: SAVE_QUERY_TIMEOUT_MS }
    );
  } catch (err) {
    // The owner disconnected or the query outlived its deadline; the save still has to happen.
    return rollSaveOf(actor, kind, dc, 0, messageMode);
  }
}

/**
 * Arm the Stun Save an electroshock round forces, and count it into RAW's ladder.
 *
 * Ch. 07:780-782 — *"Tasers require the victim to make a save against stun… The save number is
 * reduced by -2 for every successive shot in a three-turn time period."* The count lives on the
 * **victim**, because the save is theirs: two shooters with tasers stack against one target. The
 * window is combat rounds (D52); outside an encounter there is no round counter, so nothing stacks
 * and nothing is written — a later fight must not inherit a ladder from a corridor ambush. The
 * ladder is uncapped on the owner's word, and the number it reaches is printed on the card.
 *
 * @param {CyberpunkActor} actor The victim
 * @param {object} ammo Snapshot from snapshotAmmo
 * @returns {Promise<{threshold: number, shot: number, stacked: boolean}>}
 */
async function armShockSave(actor, ammo) {
  const base = actor.stunThreshold() + numberOr(ammo.stunSaveMod, 0);
  const round = Number(game.combat?.round);
  if (!Number.isFinite(round)) return { threshold: base, shot: 1, stacked: false };

  const previous = actor.getFlag("cyberpunk2020", SHOCK_FLAG);
  // The shot and the two rounds before it, so a hit on round 5 stacks with round 3 and not with 2.
  const inWindow = Number.isFinite(previous?.round) && round - previous.round < SHOCK_WINDOW_ROUNDS;
  const priorShots = inWindow ? (Number(previous.shots) || 0) : 0;

  await actor.setFlag("cyberpunk2020", SHOCK_FLAG, { round, shots: priorShots + 1 });
  return {
    threshold: base + SHOCK_LADDER_STEP * priorShots,
    shot: priorShots + 1,
    stacked: true
  };
}

/** The largest a formula can roll, for comparing two fires without rolling either. */
function formulaCeiling(formula) {
  try {
    return new Roll(String(formula)).evaluateSync({ maximize: true }).total;
  } catch (err) {
    // A hand-written ammunition formula is user-authored data and reaches this before any roll of
    // it would; an unparseable one loses the comparison rather than throwing inside an attack.
    return 0;
  }
}

/**
 * Arm the damage-over-time burn an incendiary round leaves behind. Nothing to do while the
 * ammunition carries no burn, which is every round in the shipped packs.
 *
 * **A second ignition refreshes and escalates; there are never two fires** (D26.3): the larger
 * formula and the longer remaining duration each survive, chosen separately, so a weak round can
 * only ever add to a fire and never downgrade one. The corebook has no stacking rule at all.
 *
 * @param {CyberpunkActor} actor
 * @param {object|null} ammo Snapshot from snapshotAmmo
 * @param {string} zone The location the burn caught on — every tick is resolved against it
 */
async function startDot(actor, ammo, zone) {
  if (!ammo?.dotEnabled || !(ammo.dotTurns > 0) || !ammo.dotDamageFormula) return;
  // Refused at the write, so a formula nobody can roll never becomes a burn that ticks for ever
  // (`T119`, D33). `tickDot` guards the roll as well: a world can already be carrying one.
  if (!isRollableFormula(ammo.dotDamageFormula)) return;

  const turns = Math.floor(ammo.dotTurns);
  const formula = ammo.dotDamageFormula;
  const burning = actor.getFlag("cyberpunk2020", DOT_FLAG);

  if (!burning?.formula || !(burning.turns > 0)) {
    await actor.setFlag("cyberpunk2020", DOT_FLAG, { turns, formula, zone });
    return;
  }

  // The zone follows the formula that won: a fire is one fire, and it burns where the round that
  // set its intensity landed.
  const escalates = formulaCeiling(formula) > formulaCeiling(burning.formula);
  await actor.setFlag("cyberpunk2020", DOT_FLAG, {
    turns: Math.max(turns, Math.floor(burning.turns)),
    formula: escalates ? formula : burning.formula,
    zone: escalates ? zone : String(burning.zone || zone)
  });
}

/**
 * Burn one turn off a damage-over-time effect at the start of its victim's turn.
 *
 * Ch. 07:910, the burning round's own armour rule: *"Hard armors protect normally. Soft armors must
 * be >15SP to protect the target, and are damaged 2pts/hit."* It is expressed as an ammunition
 * snapshot so the rest of the tick is the arithmetic every other hit takes — BTM, the floor of 1, a
 * cyberlimb's own SDP. A pure SDP hit takes no save and this takes none either: it is not an attack.
 *
 * The two **per-attack** rules are both off, as one decision (D18): a burning turn is not a hit, so
 * it can neither sever a limb nor double a Head hit. Severance needs more than the threshold from
 * one single attack, several attacks in a turn never sum to it, and the head follows the same logic.
 *
 * @param {CyberpunkActor} actor
 * @param {object} [options]
 * @param {string} [options.messageMode] Visibility of the card, for a hidden token
 * @returns {Promise<void>}
 */
export async function tickDot(actor, { messageMode } = {}) {
  // Before the flag is read, so the burn *pauses* rather than expiring: it resumes with its
  // remaining turns intact if the table switches automation back on.
  if (!isCombatAutomationEnabled()) return;

  const dot = actor.getFlag("cyberpunk2020", DOT_FLAG);
  // User-authored flag data: a hand-edited or half-written one must not throw inside a turn change.
  if (!dot?.formula || !(dot.turns > 0)) return;
  // The throw this replaces took the whole turn start with it — no tick, no stun-recovery save and
  // no Death Save, every turn, for ever, because the flag was never decremented (`T119`).
  if (!isRollableFormula(dot.formula)) return;

  const roll = await new Roll(String(dot.formula)).evaluate();
  const zone = String(dot.zone || "Torso");
  const location = actor.system.hitLocations?.[zone] ?? {};
  const softStops = numberOr(location.stoppingPower, 0) > BURN_SOFT_SP_MINIMUM;

  const resolved = resolveHit({
    damage: Math.max(0, Math.floor(roll.total)),
    zone,
    ammo: { armorMultHard: 1, armorMultSoft: softStops ? 1 : 0 }
  }, actor, { doubleHead: false });

  // The wound track and a cyberlimb's SDP are exclusive by construction, so this is whichever
  // of the two the burn landed on.
  const damage = resolved.final + resolved.toSdp;
  await actor.applyDamage({
    wound: resolved.final,
    sdp: resolved.toSdp ? { [zone]: resolved.toSdp } : {}
  });

  if (game.settings.get("cyberpunk2020", "armorAblation")) {
    await ablateArmor(actor, { [zone]: BURN_ARMOR_WEAR }, { softOnly: true });
  }

  await createCyberpunkChatMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: localizeParam("DotTick", { name: actor.name, damage, turns: dot.turns - 1 }),
    rolls: [roll]
  }, { useDefaultRollMode: true, messageMode });

  const turns = Math.floor(dot.turns) - 1;
  if (turns > 0) await actor.setFlag("cyberpunk2020", DOT_FLAG, { ...dot, turns });
  else await actor.unsetFlag("cyberpunk2020", DOT_FLAG);
}

/**
 * Resolve a set of hits against one actor, write the result and post the breakdown.
 *
 * The single place damage lands on anybody, whichever card sent it: one target off an attack card,
 * or one of everybody a blast caught. Runs on a GM client only.
 *
 * @param {CyberpunkActor} actor
 * @param {object} attack
 * @param {Array<{zone: string, damage: number}>} attack.hits
 * @param {boolean} attack.ap
 * @param {object|null} attack.ammo
 * @param {string} attack.targetName
 * @param {string} [attack.messageMode] Visibility of the breakdown and of the saves behind it
 * @param {boolean} [attack.overallBody] An area effect, which damages the body rather than a
 *   location (`07:960`/`:966`) — so a burn it starts catches at the Torso rather than at the
 *   location this victim's share happened to roll
 * @returns {Promise<ChatMessage>} the breakdown card
 */
export async function applyHitsToActor(actor,
  { hits = [], ap = false, ammo = null, targetName = "", messageMode, overallBody = false } = {}) {
  const severanceThreshold = game.settings.get("cyberpunk2020", "severanceThreshold");

  const lines = [];
  const sdp = {};
  const penetratedZones = {};
  const severedLimbs = [];
  let wound = 0;
  let killed = false;
  let ignitionZone = null;

  // D38 — a hit into a zone that is no longer there still hits; its location is determined among
  // the zones that are. A cyberlimb with nothing left of its SDP is that case, and the running
  // `sdp` tally is what makes a limb shot away *earlier in the same attack* count as gone too.
  const zoneIsGone = zone => LIMB_ZONES.has(zone)
    && numberOr(actor.system.sdp?.sum?.[zone], 0) > 0
    && numberOr(actor.system.sdp?.current?.[zone], 0) - (sdp[zone] ?? 0) <= 0;

  for (const hit of hits) {
    let zone = hit.zone;
    // Bounded because the loop is a re-roll, not a search: Head and Torso are never cyberlimbs, so
    // in practice it ends on the first or second throw. Exhausting it leaves the hit where it was
    // rolled, where it now reaches the wound track rather than a limb that cannot absorb it.
    for (let attempt = 0; attempt < REDERIVE_ATTEMPTS && zoneIsGone(zone); attempt++) {
      zone = (await rollLocation(actor)).areaHit;
    }

    const resolved = resolveHit(
      { damage: hit.damage, zone, ap, ammo },
      actor,
      { severanceThreshold }
    );
    wound += resolved.final;
    // The first hit that actually got *in* is where a burn catches (D26.2): a burst across five
    // zones whose first hit the armour stopped ignites at the one that wounded, not at that one.
    if (ignitionZone === null && (resolved.final > 0 || resolved.toSdp > 0)) ignitionZone = zone;
    if (resolved.toSdp > 0) sdp[zone] = (sdp[zone] ?? 0) + resolved.toSdp;
    if (resolved.penetrating > 0) penetratedZones[zone] = (penetratedZones[zone] ?? 0) + 1;
    if (resolved.severed) {
      if (zone === "Head") killed = true;
      else severedLimbs.push({ zone: localize(zone) });
    }
    lines.push({ ...resolved, zone, damage: hit.damage });
  }

  await actor.applyDamage({ wound, sdp });

  if (game.settings.get("cyberpunk2020", "armorAblation")) await ablateArmor(actor, penetratedZones);

  const limbs = Object.keys(sdp).map(zone => {
    const taken = numberOr(actor.system.sdp?.sum?.[zone], 0) - numberOr(actor.system.sdp?.current?.[zone], 0);
    return {
      zone,
      current: numberOr(actor.system.sdp?.current?.[zone], 0),
      destroyed: taken >= LIMB_DESTROYED_AT,
      useless: taken >= LIMB_USELESS_AT && taken < LIMB_DESTROYED_AT
    };
  });

  // `T218`/D52 — an electroshock round asks for its Stun Save on the hit itself, at the round's own
  // number, whether or not anything reached the wound track. Armed before the card so the ladder's
  // state is printed rather than only felt; the roll itself is below, with the other saves.
  const shock = ammo?.stunSaveOnHit ? await armShockSave(actor, ammo) : null;

  const content = await renderCyberpunkTemplate(
    "systems/cyberpunk2020/templates/chat/damage-applied.hbs",
    { targetName, lines, wound, limbs, severedLimbs, killed, shock,
      totalDamage: actor.system.damage }
  );

  const card = await createCyberpunkChatMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    content
  }, { useDefaultRollMode: true, messageMode });

  if (killed) {
    await actor.toggleStatusEffect("dead", { active: true, overlay: true });
    return card;
  }

  // A hit that landed entirely in a cyberlimb ignites too (D26.4): ch. 07:910 conditions ignition
  // on nothing — *"Anything caught in the sweep between the two points is ignited"* — and a burning
  // metal arm burns. Only a hit the armour stopped leaves nothing to catch.
  if (ignitionZone !== null) {
    await startDot(actor, ammo, overallBody ? "Torso" : ignitionZone);
  }

  // Ch. 07:530 — a severed limb means *"an immediate Death Save at Mortal 0"*: the Save number with
  // no mortality penalty, which is `stunThreshold() + 3` evaluated at wound state 4, i.e. BT — not
  // the victim's own current, harsher threshold (`T144`). The head case never reaches here; it
  // killed outright above.
  if (severedLimbs.length) {
    const death = await requestSave(actor, "death",
      { dc: actor.system.stats.bt.total, messageMode });
    if (!death.success) await actor.toggleStatusEffect("dead", { active: true, overlay: true });
  }

  // One save for the whole attack, and — for the wound path — none at all when every hit went into
  // a cyberlimb: ch. 06, "no saving roll against shock and stun". An electroshock round is asked
  // for regardless, at its own threshold: RAW conditions that save on being hit, not on wounding.
  if (wound > 0 || shock) {
    const stun = await requestSave(actor, "stun", { dc: shock?.threshold ?? null, messageMode });
    if (!stun.success) await actor.toggleStatusEffect("cpStunned", { active: true });
  }

  // The mortality check reads a state rather than a delta, so it stays under the wound: an
  // electroshock hit that changed nothing must not ask a Mortal character to die again.
  if (wound > 0 && actor.woundState() >= MORTAL_WOUND_STATE) {
    const death = await requestSave(actor, "death", { messageMode });
    if (!death.success) await actor.toggleStatusEffect("dead", { active: true, overlay: true });
  }

  return card;
}

/**
 * Apply every hit an attack card recorded against one of its targets, then post the breakdown.
 *
 * Runs on a GM client only — either the click, or the active GM under the auto setting. The flags
 * are user-authored data, so their shape is validated rather than trusted.
 *
 * @param {ChatMessage} message
 * @param {object} options
 * @param {string} options.tokenId Which of the card's targets to apply to
 * @returns {Promise<ChatMessage|null>} the breakdown card, or null when nothing was applied
 */
export async function applyAttackFromMessage(message, { tokenId } = {}) {
  // Not defence in depth: a card written while automation was on keeps a valid payload after the
  // flip, so its button is what this refuses.
  if (!isCombatAutomationEnabled()) return null;

  const attack = message?.flags?.cyberpunk2020?.attack;
  if (attack?.version !== ATTACK_FLAG_VERSION) return null;
  if (attack.applied?.[tokenId]) return null;

  const target = attack.targets?.find(t => t.tokenId === tokenId);
  if (!target) {
    ui.notifications.warn(localize("NoTargetForApply"));
    return null;
  }

  const tokenDoc = await fromUuid(target.tokenUuid);
  // An unlinked token owns its own delta actor; writing to the base actor would wound every copy.
  const actor = tokenDoc?.actor ?? await fromUuid(target.actorUuid);
  if (!actor) {
    ui.notifications.warn(localize("NoTargetForApply"));
    return null;
  }

  // Keyed by token id rather than uuid: a uuid carries dots, and a dotted key in an update is
  // expanded into nested objects instead of being stored whole.
  await message.update({ [`flags.cyberpunk2020.attack.applied.${tokenId}`]: true });

  return applyHitsToActor(actor, {
    hits: attack.hits ?? [], ap: attack.ap, ammo: attack.ammo, targetName: target.name,
    messageMode: hiddenMessageMode(tokenDoc?.hidden)
  });
}
