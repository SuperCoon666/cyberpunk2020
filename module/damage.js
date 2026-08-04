import { createCyberpunkChatMessage, renderCyberpunkTemplate } from "./compat.js";
import { localize, localizeParam, rollLocation } from "./utils.js";
import { blastDamageFor, tokensInBlast } from "./zones.js";

/**
 * The shape of flags.cyberpunk2020.attack. A card written by an older version is ignored rather
 * than guessed at, so the number changes whenever a field the apply path reads is added or moved.
 * 2: `kind` decides which apply path a card takes.
 */
export const ATTACK_FLAG_VERSION = 2;

/** The flag a damage-over-time effect burns down from, one tick per turn. */
const DOT_FLAG = "dot";

/** Ch. 07:910 — soft armour at or under this stops nothing at all against a burn. */
const BURN_SOFT_SP_MINIMUM = 15;

/** Ch. 07:910 — a burn costs the soft armour it went through two points per tick. */
const BURN_ARMOR_WEAR = 2;

/** Only a cyberlimb absorbs a hit into its own SDP; Head and Torso implants do not. */
const LIMB_ZONES = new Set(["lArm", "rArm", "lLeg", "rLeg"]);

/** Ch. 06: a cyberlimb is useless at 20 points of damage and destroyed at 30. */
const LIMB_USELESS_AT = 20;
const LIMB_DESTROYED_AT = 30;

/** Ch. 07: a limb over the threshold in one hit is severed, the head kills outright. */
const SEVERABLE_ZONES = new Set(["Head", "lArm", "rArm", "lLeg", "rLeg"]);

/** woundState() counts wound slots four wide, so Mortal is the fourth. */
export const MORTAL_WOUND_STATE = 4;

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
 * @returns {{sp: number, effSp: number, penetrating: number, headDoubled: boolean, btm: number,
 *            final: number, toSdp: number, severed: boolean}}
 */
export function resolveHit({ damage = 0, zone = "Torso", ap = false, ammo = null }, targetActor,
  { severanceThreshold = 0 } = {}) {
  const location = targetActor?.system?.hitLocations?.[zone] ?? {};
  const sp = numberOr(location.stoppingPower, 0);

  const armorMult = location.hard
    ? numberOr(ammo?.armorMultHard, 1)
    : numberOr(ammo?.armorMultSoft, 1);

  let effSp = Math.floor(sp * armorMult);
  // RAW armour-piercing halves the armour and then halves what gets through it, whatever the
  // armour is made of. Hardness is consumed by the ammunition multipliers above and nowhere else.
  if (ap) effSp = Math.floor(effSp / 2);

  let penetrating = Math.max(0, Math.floor(damage) - effSp);
  if (ap) penetrating = Math.floor(penetrating / 2);
  penetrating = Math.floor(penetrating * numberOr(ammo?.penDamageMult, 1));

  const headDoubled = zone === "Head" && penetrating > 0;
  if (headDoubled) penetrating *= 2;

  const btm = numberOr(targetActor?.system?.stats?.bt?.modifier, 0);

  // A cyberlimb takes the whole penetrating hit into its own SDP: no BTM, no wound track and, per
  // ch. 06, "no saving roll against shock and stun".
  const toCyberlimb = LIMB_ZONES.has(zone) && numberOr(targetActor?.system?.sdp?.sum?.[zone], 0) > 0;
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
 * Roll one save for the target. The GM's own client rolls unless the world asks a player
 * character's owner to roll their own, in which case the owner is queried.
 *
 * @param {CyberpunkActor} actor
 * @param {"stun"|"death"} kind
 * @returns {Promise<{total: number, threshold: number, success: boolean}>}
 */
export async function requestSave(actor, kind) {
  const manual = game.settings.get("cyberpunk2020", "pcSaveMode") === "manual" && actor.type !== "npc";
  const owner = manual
    ? game.users.players.find(u => u.active && actor.testUserPermission(u, "OWNER"))
    : null;
  if (!owner) return actor.rollSave(kind);

  try {
    return await owner.query(
      "cyberpunk2020.savePrompt",
      { actorUuid: actor.uuid, kind },
      { timeout: SAVE_QUERY_TIMEOUT_MS }
    );
  } catch (err) {
    // The owner disconnected or the query outlived its deadline; the save still has to happen.
    return actor.rollSave(kind);
  }
}

/**
 * Arm the damage-over-time burn an incendiary round leaves behind. Nothing to do while the
 * ammunition carries no burn, which is every round in the shipped packs.
 *
 * @param {CyberpunkActor} actor
 * @param {object|null} ammo Snapshot from snapshotAmmo
 * @param {string} zone The location the burn caught on — every tick is resolved against it
 */
async function startDot(actor, ammo, zone) {
  if (!ammo?.dotEnabled || !(ammo.dotTurns > 0) || !ammo.dotDamageFormula) return;
  await actor.setFlag("cyberpunk2020", DOT_FLAG,
    { turns: Math.floor(ammo.dotTurns), formula: ammo.dotDamageFormula, zone });
}

/**
 * Burn one turn off a damage-over-time effect at the start of its victim's turn.
 *
 * Ch. 07:910, the burning round's own armour rule: *"Hard armors protect normally. Soft armors must
 * be >15SP to protect the target, and are damaged 2pts/hit."* It is expressed as an ammunition
 * snapshot so the rest of the tick is the arithmetic every other hit takes — BTM, the floor of 1, a
 * cyberlimb's own SDP. A pure SDP hit takes no save and this takes none either: it is not an attack.
 *
 * @param {CyberpunkActor} actor
 * @returns {Promise<void>}
 */
export async function tickDot(actor) {
  const dot = actor.getFlag("cyberpunk2020", DOT_FLAG);
  // User-authored flag data: a hand-edited or half-written one must not throw inside a turn change.
  if (!dot?.formula || !(dot.turns > 0)) return;

  const roll = await new Roll(String(dot.formula)).evaluate();
  const zone = String(dot.zone || "Torso");
  const location = actor.system.hitLocations?.[zone] ?? {};
  const softStops = numberOr(location.stoppingPower, 0) > BURN_SOFT_SP_MINIMUM;

  const resolved = resolveHit({
    damage: Math.max(0, Math.floor(roll.total)),
    zone,
    ammo: { armorMultHard: 1, armorMultSoft: softStops ? 1 : 0 }
  }, actor);

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
  }, { useDefaultRollMode: true });

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
 * @returns {Promise<ChatMessage>} the breakdown card
 */
async function applyHitsToActor(actor, { hits = [], ap = false, ammo = null, targetName = "" }) {
  const severanceThreshold = game.settings.get("cyberpunk2020", "severanceThreshold");

  const lines = [];
  const sdp = {};
  const penetratedZones = {};
  const severedLimbs = [];
  let wound = 0;
  let killed = false;

  for (const hit of hits) {
    const resolved = resolveHit(
      { damage: hit.damage, zone: hit.zone, ap, ammo },
      actor,
      { severanceThreshold }
    );
    wound += resolved.final;
    if (resolved.toSdp > 0) sdp[hit.zone] = (sdp[hit.zone] ?? 0) + resolved.toSdp;
    if (resolved.penetrating > 0) penetratedZones[hit.zone] = (penetratedZones[hit.zone] ?? 0) + 1;
    if (resolved.severed) {
      if (hit.zone === "Head") killed = true;
      else severedLimbs.push({ zone: localize(hit.zone) });
    }
    lines.push({ ...resolved, zone: hit.zone, damage: hit.damage });
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

  const content = await renderCyberpunkTemplate(
    "systems/cyberpunk2020/templates/chat/damage-applied.hbs",
    { targetName, lines, wound, limbs, severedLimbs, killed,
      totalDamage: actor.system.damage }
  );

  const card = await createCyberpunkChatMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    content
  }, { useDefaultRollMode: true });

  if (killed) {
    await actor.toggleStatusEffect("dead", { active: true, overlay: true });
  } else if (wound > 0) {
    await startDot(actor, ammo, hits[0]?.zone ?? "Torso");

    // One save for the whole attack, and none at all when every hit went into a cyberlimb:
    // ch. 06, "no saving roll against shock and stun".
    const stun = await requestSave(actor, "stun");
    if (!stun.success) await actor.toggleStatusEffect("cpStunned", { active: true });

    if (actor.woundState() >= MORTAL_WOUND_STATE) {
      const death = await requestSave(actor, "death");
      if (!death.success) await actor.toggleStatusEffect("dead", { active: true, overlay: true });
    }
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
    hits: attack.hits ?? [], ap: attack.ap, ammo: attack.ammo, targetName: target.name
  });
}

/**
 * Apply a blast over everyone standing in it.
 *
 * Occupancy is read **now**, not at roll time: a token that walked into the crater between the roll
 * and the click is in it. Each target takes the blast's own rolled damage scaled by the ring it is
 * standing in, on a location of its own.
 *
 * @param {ChatMessage} message
 * @returns {Promise<ChatMessage[]|null>} the breakdown cards, or null when nothing was applied
 */
export async function applyBlastFromMessage(message) {
  const attack = message?.flags?.cyberpunk2020?.attack;
  if (attack?.version !== ATTACK_FLAG_VERSION) return null;
  if (!attack.blast || attack.applied?.zone) return null;

  const caught = tokensInBlast(attack.blast);
  if (!caught.length) {
    ui.notifications.warn(localize("BlastNoTargets"));
    return null;
  }

  await message.update({ "flags.cyberpunk2020.attack.applied.zone": true });

  const cards = [];
  for (const entry of caught) {
    const tokenDoc = await fromUuid(entry.tokenUuid);
    const actor = tokenDoc?.actor ?? await fromUuid(entry.actorUuid);
    if (!actor) continue;

    const damage = blastDamageFor(attack.blast.damage, entry.multiplier);
    if (damage <= 0) continue;

    const zone = (await rollLocation(actor)).areaHit;
    cards.push(await applyHitsToActor(actor, {
      hits: [{ zone, damage }], ap: attack.ap, ammo: attack.ammo, targetName: entry.name
    }));
  }

  return cards;
}
