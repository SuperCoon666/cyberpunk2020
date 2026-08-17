import { createCyberpunkChatMessage, renderCyberpunkTemplate } from "./compat.js";
import { displayName, localize, localizeParam, localizeParamEscaped, rollLocation, isRollableFormula } from "./utils.js";
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
 * 5: the payload carries `melee`/`mono` (shipped at `1f66757` without a bump, corrected here), and
 *    the ammunition snapshot carries `stunIgnoresArmor` (D62).
 * 6: the ammunition snapshot carries `overallBody`, which decides where a blast resolves (`T96`).
 * 7: the blast payload carries `levelId` and `throughWalls`, which decide whether walls stop it
 *    and which level's walls are asked (D72/D75).
 * 8: the ammunition snapshot carries `dotDamageFormulas`, a formula per burning turn, in place of
 *    the single `dotDamageFormula` (D85).
 * 9: `stunSavePenalty` replaces `stunSaveMod` and carries the opposite sign (D108) — a card written
 *    before this would lower the save number it was authored to raise.
 * 10: the spread's blast payload carries `levelId` too, so a shotgun pattern gates the same wall
 *     channel a blast does (D115, `T284`/`T287`).
 * 11: the suppression payload's `behaviour` no longer carries `attackerUuid` — the shooter is read
 *     from the card's own `attackerActorUuid` instead, so nothing identifying them is written onto
 *     a world-readable Region (`T115`, D131).
 * 12: the ammunition snapshot carries `damageFormula`, the round's own replacing damage (D147) —
 *     a card written before this has no field to read and would silently roll the weapon's.
 */
export const ATTACK_FLAG_VERSION = 12;

/** The flag a damage-over-time effect burns down from, one tick per turn. */
const DOT_FLAG = "dot";

/** The victim's own record of which rounds their electroshock hits landed on, and in whose
 *  encounter (`T98`, `T257`). */
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
    // The round's own accuracy, damage multiplier and bonus damage contribute nothing, and are not
    // offered on the sheet: the corebook gives ammunition a price and nothing else (`05:629`) —
    // damage is the weapon's (its DAM column) and accuracy is the weapon's WA. The one round the
    // book does describe is AP, whose half damage and half SP live in the AP block. Neutralised
    // here rather than only in the template so a round authored before this contributes nothing
    // either; the stored fields are untouched and come back with the DLC.
    accuracyMod: 0,
    rawDamageMult: 1,
    bonusDamageFormula: "",
    // D147 — the replacing formula is the one damage field a round does carry: the book's shotgun
    // table is a damage *per gauge* and it stands in for the weapon's own (`07:867-873`).
    damageFormula: String(a.damageFormula ?? ""),
    armorMultSoft: numberOr(a.armorMultSoft, 1),
    armorMultHard: numberOr(a.armorMultHard, 1),
    penDamageMult: numberOr(a.penDamageMult, 1),
    // A field absent from an older document defaults to the flat AP rule, not to the slug's.
    penHalvesSoft: a.penHalvesSoft !== false,
    penHalvesHard: a.penHalvesHard !== false,
    stunSaveOnHit: !!a.stunSaveOnHit,
    stunSavePenalty: numberOr(a.stunSavePenalty, 0),
    stunIgnoresArmor: !!a.stunIgnoresArmor,
    dotEnabled: !!a.dotEnabled,
    dotTurns: numberOr(a.dotTurns, 0),
    dotDamageFormulas: Array.isArray(a.dotDamageFormulas)
      ? a.dotDamageFormulas.map(f => String(f ?? ""))
      : [],
    blastRadius: numberOr(a.blastRadius, 0),
    overallBody: !!a.overallBody,
    blastFullDamageWithin: numberOr(a.blastFullDamageWithin, 0),
    blastMultipliers: Array.isArray(a.blastMultipliers) ? [...a.blastMultipliers] : [],
    blastThroughWalls: !!a.blastThroughWalls,
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
 * @param {boolean} hit.ap Armour-piercing round, or — for a melee hit — an edged weapon
 * @param {boolean} hit.mono A mono edge. Only read together with `ap`, and deliberately not with
 *   `melee`: ch. 07:1065 is stated of *all* mono-edge weapons, thrown ones included (`T242`, D67)
 * @param {boolean} hit.melee The hit came from a melee weapon, which meets armour by its own rules
 * @param {object|null} hit.ammo Snapshot from snapshotAmmo
 * @param {CyberpunkActor} targetActor
 * @param {object} [options]
 * @param {number} [options.severanceThreshold] 0 disables the severance rule
 * @param {boolean} [options.doubleHead] Ch. 07's head rule. Off for damage that is not an attack
 * @returns {{sp: number, effSp: number, penetrating: number, headDoubled: boolean, btm: number,
 *            final: number, toSdp: number, severed: boolean}}
 */
export function resolveHit({ damage = 0, zone = "Torso", ap = false, mono = false, melee = false,
  ammo = null }, targetActor, { severanceThreshold = 0, doubleHead = true } = {}) {
  const location = targetActor?.system?.hitLocations?.[zone] ?? {};
  const sp = numberOr(location.stoppingPower, 0);

  const armorMult = location.hard
    ? numberOr(ammo?.armorMultHard, 1)
    : numberOr(ammo?.armorMultSoft, 1);

  let effSp = Math.floor(sp * armorMult);

  if (ap && mono) {
    // Ch. 07:1065 — *"all mono-edge weapons are at 1/3xSP vs. soft armors, 2/3xSP vs. hard armors"*.
    // Stated unconditionally and already accounting for hardness, so it **replaces** the √ halving
    // rather than stacking with it (`AB-Q3`, D52) — stacking would give a mono knife 1/6 SP against
    // a flak vest, which no line in the book asks for. *"All mono-edge weapons"* is also why this
    // does not ask how the blade arrived: a thrown one is still a mono edge (`T242`, D67), and the
    // branch stays first so a mono blade never falls through to the plain edged rule below.
    effSp = Math.floor(sp * (location.hard ? 2 / 3 : 1 / 3));
  } else if (melee && ap) {
    // Ch. 07:462 — an edged weapon meets half SP from armour the table marks √, and full SP from
    // everything else. `edgedSp` is that stack, derived on the actor because the layers are
    // collapsed to one number long before this runs.
    effSp = Math.floor(numberOr(location.edgedSp, sp) * armorMult);
  } else if (ap) {
    // RAW armour-piercing halves the armour whatever it is made of — ch. 07:865's *"normal AP
    // ability vs. all armors"* is stated of the slug too, so this half never branches on hardness.
    effSp = Math.floor(effSp / 2);
  }

  let penetrating = Math.max(0, Math.floor(damage) - effSp);
  // The second half does branch: a finned slug's penetrating damage survives hard armour whole
  // (ch. 07:865-873). Both flags default true, which is the flat AP rule (`T95`, D53 У3). A blade
  // never halves its damage at all: ch. 07:462 limits itself to SP effectiveness, and the AP
  // round's halving is justified by its "lower damage capacity" (`AB-Q1a`, D53 У2) — which is a
  // property of the round and not of the delivery, so a thrown mono blade is out of it too
  // (`T242`, D67). Leaving it in would hand that blade 1/3 SP and then halve what got through.
  const penHalves = location.hard
    ? (ammo?.penHalvesHard !== false)
    : (ammo?.penHalvesSoft !== false);
  if (ap && !melee && !mono && penHalves) penetrating = Math.floor(penetrating / 2);
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
 * @param {TokenDocument} [options.token] The token the save is about — the prompt names it (D133)
 * @returns {Promise<{total: number, threshold: number, success: boolean}>}
 */
export async function requestSave(actor, kind, { dc = null, messageMode, token = null } = {}) {
  const manual = game.settings.get("cyberpunk2020", "pcSaveMode") === "manual" && actor.type !== "npc";
  const owner = manual
    ? game.users.players.find(u => u.active && actor.testUserPermission(u, "OWNER"))
    : null;
  if (!owner) return rollSaveOf(actor, kind, dc, 0, messageMode);

  try {
    return await owner.query(
      "cyberpunk2020.savePrompt",
      // The token rides beside the actor: the prompt renders on the owner's client, which cannot
      // tell which of a linked actor's placed tokens is being shot at (`T296`).
      { actorUuid: actor.uuid, tokenUuid: token?.uuid ?? "", kind, dc, messageMode },
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
 * window is combat rounds (D52) and it **slides with the shot** (D97): the flag records the rounds
 * its shots landed on, and each hit counts only those inside the three rounds ending on its own —
 * so rounds 1/3/5/7 give -0/-2/-2/-2. Carrying a running count forward instead made the ladder a
 * chain that never re-windowed, because every gap under three re-armed the whole tally (`T257`).
 *
 * The record also names its **encounter** (D94). Every `Combat` restarts at round 1, so without
 * that a new fight's first shot read the previous fight's late rounds as its own neighbours and
 * saved several steps down. Outside an encounter there is no counter at all, so nothing stacks and
 * nothing is written. The ladder is uncapped on the owner's word, and the number it reaches is
 * printed on the card.
 *
 * **A burst counts every round that landed** (D109): the book's unit is the round, in the ladder
 * (`07:782`), in full auto — *"one round hits the target"* (`07:718`) — and in the burst's own
 * *"how many rounds actually hit"* (`07:704`). Only **one** save is asked for them, which is a
 * deliberate simplification (owner, `AL-Q10`) against `07:548`'s save per damage taken; it is asked
 * at the number the **last** of those rounds left the victim at, so the ladder ends up where N
 * separate shots would have left it and only the number of rolls differs.
 *
 * @param {CyberpunkActor} actor The victim
 * @param {object} ammo Snapshot from snapshotAmmo
 * @param {number} landed Rounds that hit — the card's own hit count, never zero here
 * @param {string} [sceneId] The scene the hit happened on — see the fallback below
 * @returns {Promise<{threshold: number, shot: number, stacked: boolean}>}
 */
async function armShockSave(actor, ammo, landed, sceneId = "") {
  const base = actor.stunThreshold() - numberOr(ammo.stunSavePenalty, 0);
  // The victim's own encounter, never `game.combat`: that getter is the *applying* client's tracker
  // selection (`client/game.mjs:1692-1696`, 14.365.0) gated on `scene.isView`
  // (`client/documents/combat.mjs:118-121`), so a GM applying the card while viewing another scene
  // read null and the ladder silently stopped stacking — printing "no encounter running" under a
  // tracker visibly running one (`T290`, `T114`'s family). Which fight the victim is in is a world
  // fact, and this is `T87`'s resolution.
  const own = game.combats.find(c =>
    c.started && c.combatants.some(combatant => combatant.actorId === actor.id));
  // D144 — a victim the tracker never held (a bystander, a prisoner, an NPC the GM did not add)
  // stacks against the fight running on the scene the hit happened on, rather than getting every
  // shot at its base number. The scene comes from the card the apply path already holds, in
  // `T114`'s shape: naming a *parallel* fight wrongly is the accepted risk (two at once are rare),
  // reading the applying client's viewport is not.
  //
  // `zoneCombat`'s reading, one file away in `module/zones.js`, and deliberately not a fourth
  // predicate of its own (`T318`): `active` is a **world** singleton — activating one Combat clears
  // the flag on every other, with no scene filter (`dist/database/documents/combat.mjs`
  // `_preUpdateOperation`, 14.365.0) — so `active &&` as a *filter* found no fight at all on the
  // split party this ruling exists for, which is worse than the wrong-fight risk it accepted. A
  // fight bound to the card's own scene outranks a scene-less one (D155's ordering), `active` breaks
  // the tie inside a tier, and nothing is decided by collection order that a tier can decide.
  const running = sceneId
    ? game.combats.filter(c => c.started && (!c.scene || c.scene.id === sceneId))
    : [];
  const bound = running.filter(c => c.scene?.id === sceneId);
  const candidates = bound.length ? bound : running;
  const combat = own ?? candidates.find(c => c.active) ?? candidates[0] ?? null;
  if (!combat) return { threshold: base, shot: landed, stacked: false };
  const round = combat.round;

  const previous = actor.getFlag("cyberpunk2020", SHOCK_FLAG);
  // A record from another encounter counts for nothing, and so does one written before this shape
  // existed — it names no encounter, so a fight in progress across the upgrade restarts its ladder
  // once, at the victim's own number.
  const sameFight = previous?.combat === combat.id && Array.isArray(previous.rounds);
  // This round and the two before it, so a hit on round 5 stacks with round 3 and not with round 2.
  const shots = sameFight
    ? previous.rounds.filter(r => Number.isFinite(r) && r <= round && round - r < SHOCK_WINDOW_ROUNDS)
    : [];
  for (let i = 0; i < landed; i++) shots.push(round);

  // Only the window is kept: a round that can no longer count against any later shot cannot start
  // counting again, which is what keeps the ladder from re-arming across a lull in a long fight.
  await actor.setFlag("cyberpunk2020", SHOCK_FLAG,
    { combat: combat.id, rounds: shots });
  return {
    threshold: base + SHOCK_LADDER_STEP * (shots.length - 1),
    shot: shots.length,
    stacked: true
  };
}

/**
 * Arm the damage-over-time burn an incendiary round leaves behind. Nothing to do while the
 * ammunition carries no burn, which is every round in the shipped packs.
 *
 * **A new burn replaces the old one whole** (D88, reversing D26.3): its own list and its own turn
 * count, and the previous fire is dropped — so a 3-turn molotov does displace a 6-turn incendiary.
 * That downgrade is the accepted cost of the simple rule: D85 made a burn a *list*, which left
 * D26.3's «keep the larger formula» with nothing to compare. There are still never two fires.
 *
 * @param {CyberpunkActor} actor
 * @param {object|null} ammo Snapshot from snapshotAmmo
 * @param {string} zone The location the burn caught on — every tick is resolved against it
 */
async function startDot(actor, ammo, zone) {
  if (!ammo?.dotEnabled || !(ammo.dotTurns > 0)) return;

  // The burn is exactly as long as the turn count says; the list is read against it, so shortening
  // the count shortens the fire and a turn the GM never filled in simply does nothing (D87).
  const list = Array.isArray(ammo.dotDamageFormulas) ? ammo.dotDamageFormulas : [];
  const formulas = Array.from({ length: Math.floor(ammo.dotTurns) },
    (_, i) => String(list[i] ?? "").trim());
  // A fire with nothing to roll in any of its turns is not a fire.
  if (!formulas.some(formula => formula && isRollableFormula(formula))) return;

  await actor.setFlag("cyberpunk2020", DOT_FLAG, { turns: formulas.length, formulas, zone });
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
 * @param {TokenDocument} [options.token] The burning token — the card names it (D133)
 * @returns {Promise<void>}
 */
export async function tickDot(actor, { messageMode, token = null } = {}) {
  // Before the flag is read, so the burn *pauses* rather than expiring: it resumes with its
  // remaining turns intact if the table switches automation back on.
  if (!isCombatAutomationEnabled()) return;

  const dot = actor.getFlag("cyberpunk2020", DOT_FLAG);
  // User-authored flag data: a hand-edited or half-written one must not throw inside a turn change.
  const formulas = Array.isArray(dot?.formulas)
    ? dot.formulas
    // A fire armed before D85 carries one formula for the whole burn. Read here rather than
    // migrated: the flag is transient, and a world upgraded mid-encounter still finishes its fire.
    : (dot?.formula ? Array.from({ length: Math.max(1, Math.floor(dot.turns) || 0) }, () => dot.formula) : []);
  if (!formulas.length || !(dot.turns > 0)) return;

  // The flag counts the turns *left* and the list is as long as the burn, so this is which of them
  // is alight now. A hand-edited count longer than the list falls off the front and burns for free.
  const formula = String(formulas[formulas.length - Math.floor(dot.turns)] ?? "").trim();
  // The throw this replaces took the whole turn start with it — no tick, no stun-recovery save and
  // no Death Save, every turn, for ever, because the flag was never decremented (`T119`).
  if (formula && !isRollableFormula(formula)) return;

  // D87 — a turn with no formula of its own deals no damage rather than repeating the last, and it
  // must not reach the pipeline below at all: a hit that connects is floored at one point and soft
  // armour is worn two points a tick, so a turn that does nothing would still do both.
  const roll = formula ? await new Roll(formula).evaluate() : null;
  const rolled = Math.max(0, Math.floor(roll?.total ?? 0));
  const zone = String(dot.zone || "Torso");
  let damage = 0;

  if (rolled > 0) {
    const location = actor.system.hitLocations?.[zone] ?? {};
    const softStops = numberOr(location.stoppingPower, 0) > BURN_SOFT_SP_MINIMUM;

    const resolved = resolveHit({
      damage: rolled,
      zone,
      ammo: { armorMultHard: 1, armorMultSoft: softStops ? 1 : 0 }
    }, actor, { doubleHead: false });

    // The wound track and a cyberlimb's SDP are exclusive by construction, so this is whichever
    // of the two the burn landed on.
    damage = resolved.final + resolved.toSdp;
    await actor.applyDamage({
      wound: resolved.final,
      sdp: resolved.toSdp ? { [zone]: resolved.toSdp } : {}
    });

    if (game.settings.get("cyberpunk2020", "armorAblation")) {
      await ablateArmor(actor, { [zone]: BURN_ARMOR_WEAR }, { softOnly: true });
    }
  }

  // Posted even for a turn that dealt nothing: the fire is still burning and the count still fell,
  // and silence reads at the table as the fire having gone out.
  await createCyberpunkChatMessage({
    // The token as well as the actor (`T316`): `getSpeaker` fixes `alias` to `actor.name` before it
    // looks for a token at all (`client/documents/chat-message.mjs:228`, 14.365.0), so this card's
    // header carried the sheet name over a body that already names the token.
    speaker: ChatMessage.getSpeaker({ actor, token }),
    content: localizeParamEscaped("DotTick",
      { name: displayName(actor, token), damage, turns: dot.turns - 1 }),
    rolls: roll ? [roll] : []
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
 * @param {boolean} [attack.melee] The hits came from a melee weapon (`T94`)
 * @param {boolean} [attack.mono] A mono edge, read only with `ap` and `melee`
 * @param {object|null} attack.ammo
 * @param {string} attack.targetName
 * @param {string} [attack.messageMode] Visibility of the breakdown and of the saves behind it
 * @param {boolean} [attack.overallBody] An area effect that damages the body rather than a location
 *   (`07:960`/`:966`): every hit resolves at the Torso, so head doubling, severance and cyberlimb
 *   absorption are all out of reach and a burn it starts catches there too
 * @param {TokenDocument} [attack.token] The token that was hit — the save prompts name it (`T296`)
 * @param {string} [attack.sceneId] The scene the hit happened on, for the shock ladder's fallback
 * @returns {Promise<ChatMessage>} the breakdown card
 */
export async function applyHitsToActor(actor,
  { hits = [], ap = false, mono = false, melee = false, ammo = null, targetName = "", messageMode,
    overallBody = false, token = null, sceneId = "" } = {}) {
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
    // D52/`T96` — an overall-body hit resolves against the body as a whole, and the Torso is what
    // the book leaves meeting it. The three location rules fall out with the zone rather than being
    // switched off one by one: the Torso is not the Head, is not severable and is not a cyberlimb.
    // Forced here rather than at each caller, so the rule cannot arrive half applied.
    let zone = overallBody ? "Torso" : hit.zone;
    // Bounded because the loop is a re-roll, not a search: Head and Torso are never cyberlimbs, so
    // in practice it ends on the first or second throw.
    for (let attempt = 0; attempt < REDERIVE_ATTEMPTS && zoneIsGone(zone); attempt++) {
      zone = (await rollLocation(actor)).areaHit;
    }
    // D146 — the hit has to land on a zone that **exists**, so exhausting the throws must not leave
    // it where it was rolled. `zoneIsGone` reaches here for either kind of spent limb, and they fail
    // differently: one emptied inside this attack still reads above zero in `sdp.current`, so
    // `resolveHit` absorbs the whole hit into a pool `applyDamage` then floors at 0 (`T236`); one
    // emptied *before* the attack reads 0, so it absorbs nothing and the hit met the destroyed
    // limb's own SP and could sever it a second time (`T324`). The Torso is the deterministic answer
    // to both — every target has one and it can never be a cyberlimb.
    if (zoneIsGone(zone)) zone = "Torso";

    const resolved = resolveHit(
      { damage: hit.damage, zone, ap, mono, melee, ammo },
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
    // The card names the rule, not the location it was resolved at: "Torso" would read as a rolled
    // location and is exactly what an overall-body hit did not do.
    lines.push({ ...resolved, zone: overallBody ? "OverallBody" : zone, damage: hit.damage });
  }

  await actor.applyDamage({ wound, sdp });

  // Ch. 07:614 — stabilization holds *"unless another wound is taken"*, and nothing else in the
  // system ever clears the flag (`T219`, D52).
  if (wound > 0 && actor.system.stabilized) await actor.update({ "system.stabilized": false });

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
  //
  // D62 — but a bullet has to get in first: only a round whose charge reaches through armour asks
  // on a hit the armour stopped. `penetratedZones` is damage past SP, which is the intended reading
  // — a hit that landed entirely in a cyberlimb penetrated, even though `wound` stayed 0.
  const asksForShock = ammo?.stunSaveOnHit
    && (ammo.stunIgnoresArmor || Object.keys(penetratedZones).length > 0);
  const shock = asksForShock ? await armShockSave(actor, ammo, hits.length, sceneId) : null;

  const content = await renderCyberpunkTemplate(
    "systems/cyberpunk2020/templates/chat/damage-applied.hbs",
    { targetName, lines, wound, limbs, severedLimbs, killed, shock,
      totalDamage: actor.system.damage }
  );

  const card = await createCyberpunkChatMessage({
    // The token as well as the actor (`T316`) — `targetName` in the body is already the token's, and
    // the header printed the sheet's beside it.
    speaker: ChatMessage.getSpeaker({ actor, token }),
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
    await startDot(actor, ammo, ignitionZone);
  }

  // Ch. 07:530 — a severed limb means *"an immediate Death Save at Mortal 0"*: the Save number with
  // no mortality penalty, which is `stunThreshold() + 3` evaluated at wound state 4, i.e. BT — not
  // the victim's own current, harsher threshold (`T144`). The head case never reaches here; it
  // killed outright above.
  if (severedLimbs.length) {
    const death = await requestSave(actor, "death",
      { dc: actor.system.stats.bt.total, messageMode, token });
    if (!death.success) await actor.toggleStatusEffect("dead", { active: true, overlay: true });
  }

  // One save for the whole attack, and — for the wound path — none at all when every hit went into
  // a cyberlimb: ch. 06, "no saving roll against shock and stun". An electroshock round is asked
  // for regardless, at its own threshold: RAW conditions that save on being hit, not on wounding.
  if (wound > 0 || shock) {
    const stun = await requestSave(actor, "stun",
      { dc: shock?.threshold ?? null, messageMode, token });
    if (!stun.success) await actor.toggleStatusEffect("cpStunned", { active: true });
  }

  // The mortality check reads a state rather than a delta, so it stays under the wound: an
  // electroshock hit that changed nothing must not ask a Mortal character to die again.
  if (wound > 0 && actor.woundState() >= MORTAL_WOUND_STATE) {
    const death = await requestSave(actor, "death", { messageMode, token });
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
    hits: attack.hits ?? [], ap: attack.ap, mono: attack.mono, melee: attack.melee,
    ammo: attack.ammo, targetName: target.name, token: tokenDoc,
    // The card's own scene. `speaker.scene` is empty on an attack card — `Multiroll.execute` posts
    // it with no speaker at all — so the target token the payload names is what carries it there;
    // both are the card's own record, and neither is the applying client's canvas (D144).
    sceneId: message.speaker?.scene || tokenDoc?.parent?.id || "",
    messageMode: hiddenMessageMode(tokenDoc?.hidden)
  });
}
