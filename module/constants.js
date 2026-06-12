/**
 * Runtime constants for the Cyberpunk 2020 system.
 *
 * Keep these values independent from Foundry's legacy system-template runtime.
 * DataModels, lookup helpers, sheets, and migrations can import these constants
 * without reading Foundry's legacy Actor template objects at runtime.
 */

export const DEFAULT_STATS = {
  int: { base: 5, tempMod: 0 },
  ref: { base: 5, tempMod: 0 },
  tech: { base: 5, tempMod: 0 },
  cool: { base: 5, tempMod: 0 },
  attr: { base: 5, tempMod: 0 },
  luck: { base: 5, tempMod: 0 },
  ma: { base: 5, tempMod: 0 },
  bt: { base: 5, tempMod: 0 },
  emp: { base: 5, tempMod: 0 }
};

export const STAT_KEYS = Object.freeze(Object.keys(DEFAULT_STATS));

export const DEFAULT_HIT_LOCATIONS = {
  Head: { location: [1] },
  Torso: { location: [2, 4] },
  lArm: { location: [6] },
  rArm: { location: [5] },
  lLeg: { location: [7, 8] },
  rLeg: { location: [9, 10] }
};

export const HIT_LOCATION_KEYS = Object.freeze(Object.keys(DEFAULT_HIT_LOCATIONS));

export const DEFAULT_SDP = {
  sum: { Head: 0, Torso: 0, lArm: 0, rArm: 0, lLeg: 0, rLeg: 0 },
  current: { Head: 0, Torso: 0, lArm: 0, rArm: 0, lLeg: 0, rLeg: 0 },
  touched: { Head: false, Torso: false, lArm: false, rArm: false, lLeg: false, rLeg: false }
};

export function cloneSystemDefault(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return JSON.parse(JSON.stringify(value));
}
