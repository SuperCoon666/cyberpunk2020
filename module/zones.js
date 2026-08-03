import { ranges, rangedAttackTypes } from "./lookups.js";

/**
 * Ch. 07's Grenade Table (`dev/rulebooks/corebook/07-friday-night-firefight.md:187-197`) as it is
 * printed: a 3x3 ring around the target with 1 sitting below 3 and 10 above 8, so 1 and 3 both
 * point south and 8 and 10 both north. Screen y grows downward, which is what makes "north"
 * negative — the orientation is a convention the book does not set (plan assumption 3).
 */
const SCATTER_DIRECTIONS = {
  1: [0, 1], 2: [-1, 1], 3: [0, 1], 4: [1, 1],
  5: [-1, 0], 6: [1, 0],
  7: [-1, -1], 8: [0, -1], 9: [1, -1], 10: [0, -1]
};

/**
 * Ch. 07's Shotgun Table (`:845-853`) is three bands wide — Close/PB, Medium, Long — while the
 * system carries five. The two ends fold inwards.
 */
const SPREAD_BANDS = {
  [ranges.pointBlank]: "Short",
  [ranges.close]: "Short",
  [ranges.medium]: "Medium",
  [ranges.long]: "Long",
  [ranges.extreme]: "Long"
};

/** The attack types that throw or launch an area-effect charge (ch. 07 "Area Effect Weapons"). */
const BLAST_ATTACK_TYPES = new Set([rangedAttackTypes.grenade, rangedAttackTypes.rpg]);

/**
 * Scene units to pixels. `distancePixels` is `grid.size / grid.distance`, so this converts the
 * **scene's** own unit — which this system takes to be metres, the assumption `T48` records.
 *
 * @param {number} metres
 * @returns {number}
 */
export function metresToPixels(metres) {
  return (Number(metres) || 0) * canvas.dimensions.distancePixels;
}

/**
 * The unit vector a Grenade Table result points along. Normalised, so a diagonal lands the rolled
 * number of metres away rather than 1.41 times it.
 *
 * @param {number} direction A 1d10 result
 * @returns {{dx: number, dy: number}}
 */
export function scatterVector(direction) {
  const [dx, dy] = SCATTER_DIRECTIONS[direction];
  const length = Math.hypot(dx, dy);
  return { dx: dx / length, dy: dy / length };
}

/**
 * Where a missed area attack actually landed.
 *
 * @param {{x: number, y: number}} origin The point that was aimed at, in pixels
 * @param {number} direction A 1d10 result on the Grenade Table
 * @param {number} metres A second 1d10, in scene units
 * @returns {{x: number, y: number}}
 */
export function scatterCentre(origin, direction, metres) {
  const { dx, dy } = scatterVector(direction);
  const distance = metresToPixels(metres);
  return { x: origin.x + (dx * distance), y: origin.y + (dy * distance) };
}

/**
 * The blast geometry an ammunition item describes, normalised. Ammunition is user-authored data,
 * so every number is taken as read rather than trusted.
 *
 * @param {object|null} ammo A snapshot from snapshotAmmo
 * @returns {{radius: number, fullDamageWithin: number, multipliers: number[]}}
 */
export function blastProfile(ammo) {
  const radius = Math.max(0, Number(ammo?.blastRadius) || 0);
  const fullDamageWithin = Math.min(radius, Math.max(0, Number(ammo?.blastFullDamageWithin) || 0));
  const multipliers = (Array.isArray(ammo?.blastMultipliers) ? ammo.blastMultipliers : [])
    .map(m => Math.max(0, Number(m) || 0));

  return { radius, fullDamageWithin, multipliers };
}

/**
 * What fraction of the blast's damage reaches a target this far from the centre.
 *
 * @param {number} distance In scene units
 * @param {{radius: number, fullDamageWithin: number, multipliers: number[]}} profile
 * @returns {number} 0 outside the radius
 */
export function blastMultiplierFor(distance, { radius = 0, fullDamageWithin = 0, multipliers = [] } = {}) {
  if (!(distance <= radius)) return 0;
  if (distance <= fullDamageWithin) return 1;
  // RAW is full damage across the whole radius (ch. 07:839); the falloff rings are an ammunition
  // option, so an ammunition that configures none keeps the book's own answer.
  if (!multipliers.length) return 1;

  const ringWidth = (radius - fullDamageWithin) / multipliers.length;
  if (!(ringWidth > 0)) return 1;

  const index = Math.min(multipliers.length - 1,
    Math.floor((distance - fullDamageWithin) / ringWidth));
  return multipliers[index];
}

/**
 * The falloff rings as bands, for a card a GM has to apply by hand.
 *
 * @param {{radius: number, fullDamageWithin: number, multipliers: number[]}} profile
 * @returns {Array<{from: number, to: number, multiplier: number}>} empty when there is no falloff
 */
export function blastRings({ radius = 0, fullDamageWithin = 0, multipliers = [] } = {}) {
  if (!multipliers.length || !(radius > fullDamageWithin)) return [];

  const ringWidth = (radius - fullDamageWithin) / multipliers.length;
  return multipliers.map((multiplier, i) => ({
    from: (fullDamageWithin + (i * ringWidth)).toNearest(0.01),
    to: (fullDamageWithin + ((i + 1) * ringWidth)).toNearest(0.01),
    multiplier
  }));
}

/**
 * The damage one target takes off a blast, floored the way every other damage total in the system
 * is: a hit that connects at all is worth at least a point.
 *
 * @param {number} damage The blast's rolled damage
 * @param {number} multiplier
 * @returns {number}
 */
export function blastDamageFor(damage, multiplier) {
  const scaled = (Number(damage) || 0) * (Number(multiplier) || 0);
  return scaled > 0 ? Math.max(1, Math.floor(scaled)) : 0;
}

/**
 * Whether this weapon and its loaded ammunition throw an area-effect charge.
 *
 * @param {object} system The weapon system data from _getWeaponSystem
 * @param {object|null} ammo A snapshot from snapshotAmmo
 * @returns {boolean}
 */
export function isBlastAttack(system, ammo) {
  return BLAST_ATTACK_TYPES.has(system?.attackType) && Number(ammo?.blastRadius) > 0;
}

/**
 * The shotgun pattern at this range. Ch. 07's table gives both the width and the damage per band;
 * an ammunition that leaves the damage blank keeps the weapon's own formula.
 *
 * @param {string} range One of the `ranges` bands
 * @param {object|null} ammo A snapshot from snapshotAmmo
 * @returns {{band: string|undefined, width: number, damage: string}}
 */
export function spreadProfileFor(range, ammo) {
  const band = SPREAD_BANDS[range];
  return {
    band,
    width: Math.max(0, Number(ammo?.[`spreadWidth${band}`]) || 0),
    damage: String(ammo?.[`spreadDamage${band}`] ?? "")
  };
}

/**
 * Whether this shot spreads into a pattern rather than landing on one target.
 *
 * @param {object|null} ammo A snapshot from snapshotAmmo
 * @param {string} range
 * @returns {boolean}
 */
export function isSpreadAttack(ammo, range) {
  return ammo?.spreadMode === "spread" && spreadProfileFor(range, ammo).width > 0;
}

/**
 * Let the acting client put the blast where they mean it, without writing anything.
 *
 * `create: false` returns the preview document itself and never touches the database, which is why
 * this works for a player and is not blocked by a paused world — only creation is gated
 * (`client/canvas/layers/regions.mjs:738`, 14.365.0).
 *
 * @param {number} radius In scene units
 * @param {string} name The region's label while it is being placed
 * @returns {Promise<{x: number, y: number}|null>} null when the placement was dismissed
 */
export async function pickBlastCentre(radius, name) {
  const region = await canvas.regions.placeRegion({
    name,
    shapes: [{ type: "circle", x: 0, y: 0, radius: metresToPixels(radius) }],
    levels: [canvas.level.id],
    visibility: CONST.REGION_VISIBILITY.ALWAYS
  }, { create: false });
  if (!region) return null;

  const { x, y } = region.shapes[0];
  return { x, y };
}

/**
 * Every token the blast caught, with how much of it reached them.
 *
 * Membership and falloff are the same measurement — `canvas.grid.measurePath`, the same call the
 * range band is picked with — so a token cannot be inside the zone and in no ring.
 *
 * @param {object} blast The card's blast payload
 * @returns {Array<{name: string, tokenUuid: string, actorUuid: string, distance: number, multiplier: number}>}
 */
export function tokensInBlast(blast) {
  const centre = { x: blast.x, y: blast.y };
  const caught = [];

  for (const token of canvas.tokens.placeables) {
    const distance = canvas.grid.measurePath([centre, token.center]).distance;
    const multiplier = blastMultiplierFor(distance, blast);
    if (multiplier <= 0) continue;

    caught.push({
      name: token.document.name,
      tokenUuid: token.document.uuid,
      actorUuid: token.actor?.uuid ?? "",
      distance,
      multiplier
    });
  }

  return caught;
}
