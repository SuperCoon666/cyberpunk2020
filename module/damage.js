import { createCyberpunkChatMessage, renderCyberpunkTemplate } from "./compat.js";
import { localize } from "./utils.js";

/**
 * The shape of flags.cyberpunk2020.attack. A card written by an older version is ignored rather
 * than guessed at, so the number changes whenever a field the apply path reads is added or moved.
 */
export const ATTACK_FLAG_VERSION = 1;

/** Only a cyberlimb absorbs a hit into its own SDP; Head and Torso implants do not. */
const LIMB_ZONES = new Set(["lArm", "rArm", "lLeg", "rLeg"]);

/** Ch. 06: a cyberlimb is useless at 20 points of damage and destroyed at 30. */
const LIMB_USELESS_AT = 20;
const LIMB_DESTROYED_AT = 30;

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
    penDamageMult: numberOr(a.penDamageMult, 1)
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
 * @returns {{sp: number, effSp: number, penetrating: number, headDoubled: boolean, btm: number,
 *            final: number, toSdp: number}}
 */
export function resolveHit({ damage = 0, zone = "Torso", ap = false, ammo = null }, targetActor) {
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

  return {
    sp,
    effSp,
    penetrating,
    headDoubled,
    btm,
    final: toCyberlimb || penetrating <= 0 ? 0 : Math.max(1, penetrating - btm),
    toSdp: toCyberlimb ? penetrating : 0
  };
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

  const lines = [];
  const sdp = {};
  let wound = 0;

  for (const hit of attack.hits ?? []) {
    const resolved = resolveHit(
      { damage: hit.damage, zone: hit.zone, ap: attack.ap, ammo: attack.ammo },
      actor
    );
    wound += resolved.final;
    if (resolved.toSdp > 0) sdp[hit.zone] = (sdp[hit.zone] ?? 0) + resolved.toSdp;
    lines.push({ ...resolved, zone: hit.zone, damage: hit.damage });
  }

  await actor.applyDamage({ wound, sdp });

  const limbs = Object.keys(sdp).map(zone => {
    const taken = numberOr(actor.system.sdp?.sum?.[zone], 0) - numberOr(actor.system.sdp?.current?.[zone], 0);
    return {
      zone,
      current: numberOr(actor.system.sdp?.current?.[zone], 0),
      destroyed: taken >= LIMB_DESTROYED_AT,
      useless: taken >= LIMB_USELESS_AT && taken < LIMB_DESTROYED_AT
    };
  });

  // Keyed by token id rather than uuid: a uuid carries dots, and a dotted key in an update is
  // expanded into nested objects instead of being stored whole.
  await message.update({ [`flags.cyberpunk2020.attack.applied.${tokenId}`]: true });

  const content = await renderCyberpunkTemplate(
    "systems/cyberpunk2020/templates/chat/damage-applied.hbs",
    { targetName: target.name, lines, wound, limbs, totalDamage: actor.system.damage }
  );

  return createCyberpunkChatMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    content
  }, { useDefaultRollMode: true });
}
