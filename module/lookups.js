// This is where all the magic values go, because cyberpunk has SO many of those
// Any given string value is the same as its key in the localization file, and will be used for translation
import { cloneSystemDefault, DEFAULT_HIT_LOCATIONS, STAT_KEYS } from "./constants.js";

export const COMBAT_SENSE_SKILL_IDS = new Set([
  "BjBZ8zc7wh52MSwK", // Combat Sense
  "L2hC8GzV0mRqE7xS"  // Чувство Боя
]);

export const AWARENESS_NOTICE_SKILL_ID = "jBfPdSDGwvIEq66p";

// Ch. 04: the non-martial skills a defender may counter a melee attack with. One id each, because
// the two default-skill packs share every id (103 of 103) — unlike the role-skill packs, where the
// same skill has a different id per language, which is why COMBAT_SENSE_SKILL_IDS needs two.
// The martial arts join these at the call site, from MARTIAL_ART_ID_BY_KEY.
export const MELEE_DEFENSE_SKILL_IDS = new Set([
  "2s2SKbYKsvtki3TO", // Melee
  "Ft49pPt6Fu3rpQJq", // Fencing
  "IWAr3E5vpS8qFzZS", // Dodge & Escape
  "gULme1P5CR8rXXIh", // Athletics
  "i8qoUwZ5jI9KAZeK"  // Brawling
]);

/** Choosing this one as a defense is what declares a dodge for the house rule. */
export const DODGE_SKILL_ID = "IWAr3E5vpS8qFzZS";

/** Ch. 07:731 — the skill a suppressive-fire save is rolled on. */
export const ATHLETICS_SKILL_ID = "gULme1P5CR8rXXIh";

export const INTERFACE_SKILL_IDS = new Set([
  "sqHlfxm32pNENNFZ", // Interface
  "Nc1zY8vB6qWt4pXj"  // Интерфейс
]);

// Stored value paired with its localization key: the item sheet's dropdown and the netrunning
// tab's program list both need the same mapping.
export const programTypes = [
    { value: "Intrusion", localKey: "ProgramIntrusion" },
    { value: "Decryption", localKey: "ProgramDecryption" },
    { value: "Detection", localKey: "ProgramDetection" },
    { value: "Anti-System", localKey: "ProgramAntiSystem" },
    { value: "Stealth", localKey: "ProgramStealth" },
    { value: "Protection", localKey: "ProgramProtection" },
    { value: "Anti-ICE", localKey: "ProgramAntiICE" },
    { value: "Anti-Personnel", localKey: "ProgramAntiPersonnel" },
    { value: "Controller", localKey: "ProgramController" },
    { value: "Utility", localKey: "ProgramUtility" }
];

// Rounds a box of each reload type holds — the RELOADS & OPTIONS table. Keyed by the ammo item's
// weaponType, whose values are the localization keys listed in the item sheet's ammoReloadTypes.
// The four the table has no row for are sold by the piece, hence one per box.
export const AMMO_ROUNDS_PER_BOX = {
    AmmoReloadLightPistolSMG: 100,
    AmmoReloadMediumPistolSMG: 50,
    AmmoReloadHeavyPistolSMG: 50,
    AmmoReloadVeryHeavyPistol: 50,
    AmmoReloadAssaultRifle: 100,
    AmmoReloadShotgun: 12,
    AmmoReload20mmCannonRound: 1,
    AmmoWeaponArrows: 12,
    AmmoWeaponCrossbowQuarrels: 12,
    AmmoWeaponAirguns: 100,
    AmmoReloadNeedlegunRounds: 50,
    AmmoReloadFlamethrower: 1,
    AmmoReloadRockets: 4,
    AmmoWeaponPaintloads: 1,
    AmmoWeaponGauss: 1,
    AmmoReloadGrenades: 1,
    AmmoReloadOther: 1
};

export let weaponTypes = {
    pistol: "Pistol",
    submachinegun: "SMG",
    shotgun: "Shotgun",
    rifle: "Rifle",
    heavy: "Heavy",
    melee: "Melee",
    exotic: "Exotic"
}
export let attackSkills = {
    "Pistol": ["Handgun"],
    "SMG": ["Submachinegun"],
    "Shotgun": ["Rifle"],
    // "Rifle": [localize("Rifle")],
    "Rifle": ["Rifle"],
    "Heavy": ["HeavyWeapons"],
    // Trained martial arts get added in item-sheet for now
    "Melee": ["Fencing", "Melee", "Brawling"],
    // No limitations for exotic, go nuts
    "Exotic": []
}

export function getStatNames() {
  return [...STAT_KEYS];
}

// How a weapon attacks. Something like pistol or an SMG have rigid rules on how they can attack, but shotguns can be regular or auto shotgun, exotic can be laser, etc. So this is for weird and special stuff that isn't necessarily covered by the weapon's type or other information
// If we change attack type to be an array, we could say, have ["BEAM" "LASER"]
export let rangedAttackTypes = {
    semiAuto: "SemiAuto",
    auto: "Auto",
    // Strange ranged weapons
    paint: "Paint",
    drugs: "Drugs",
    acid: "Acid",
    taser: "Taser",
    dart: "Dart",
    squirt: "Squirt",
    throwable: "Throw",
    archer: "Archer",
    // Beam weapons
    laser: "Laser",
    microwave: "Microwave",
    // Area effect weapons
    shotgun: "Shotgun",
    autoshotgun: "Autoshotgun",
    grenade: "Grenade", // Separate entry from throwable because grenades have different throw distance
    gas: "Gas",
    flamethrow: "Flamethrow",
    landmine: "Landmine",
    claymore: "Claymore",
    rpg: "RPG", // Fired same as with other grenade launchers or shoulder mounts, so not sure if should be here,
    missile: "Missile",
    explosiveCharge: "Explocharge"
}

export let meleeAttackTypes = {
    melee: "Melee", // Regular melee bonk
    mono: "Mono", // Monokatanas, etc
    martial: "Martial", // Martial arts! Here, the chosen attack skill does not matter
    cyberbeast: "Beast"
}

// There's a lot of these, so here's a sorted one for convenience 
export let sortedAttackTypes = Object.values(rangedAttackTypes).concat(Object.values(meleeAttackTypes)).sort();

// These are preceded by Conceal, as for example, conceal Jacket is in fact supposed to show "Jacket/Coat/Shoulder Rig", so just "Jacket" doesn't make sense
export let concealability = {
    pocket: "ConcealPocket",
    jacket: "ConcealJacket",
    longcoat: "ConcealLongcoat",
    noHide: "ConcealNoHide"
}

export let availability = {
    excellent: "Excellent",
    common: "Common",
    poor: "Poor",
    rare: "Rare"
}

export let reliability = {
    very: "VeryReliable",
    standard: "Standard",
    unreliable: "Unreliable"
}

export let fireModes = {
    fullAuto: "FullAuto",
    threeRoundBurst: "ThreeRoundBurst",
    suppressive: "Suppressive",
    // Really semi auto is any none auto with RoF with more than 1
    semiAuto: "SemiAuto"
}

export let martialActions = {
  dodge: "Dodge",
  blockParry: "BlockParry",

  // FNFF2 defensive variants
  allOutParry: "AllOutParry",
  allOutDodge: "AllOutDodge",

  // Attacks
  strike: "Strike",
  punch: "Punch",
  kick: "Kick",
  disarm: "Disarm",
  sweepTrip: "SweepTrip",
  ram: "Ram",
  jumpKick: "JumpKick",
  cast: "Cast",

  // Grapple chain
  grapple: "Grapple",
  hold: "Hold",
  choke: "Choke",
  throw: "Throw",
  escape: "Escape"
};

export const MARTIAL_ART_ID_BY_KEY = {
  "Martial Arts: Aikido": "oeXfrhKtdtuxn5dx",
  "Martial Arts: AnimalKungFu": "x5mxWMFyRWHg5lEV",
  "Martial Arts: ArasakaTe": "nBVSZDIj1QOmd3nL",
  "Martial Arts: Boxing": "g75H0sMFUSaRIXfe",
  "Martial Arts: Capoeira": "hJsbE1MGbFpY4lyi",
  "Martial Arts: ChoiLiFut": "4DcaO3UAAv2wJE50",
  "Martial Arts: GunFu": "tdIiYYtLLF3HjO8Y",
  "Martial Arts: JeetKunDo": "abOBXqkPPrGfG3vs",
  "Martial Arts: Judo": "U7lhKboDQnnytPIe",
  "Martial Arts: Jujitsu": "i5D9nmQQf7bLTjgv",
  "Martial Arts: Karate": "JtA82aiEfaiKgkt4",
  "Martial Arts: Koppo": "fEBnTz80vz4hwuhd",
  "Martial Arts: Ninjutsu": "dDLyPjr39EQY6UwZ",
  "Martial Arts: PanzerFaust": "ONsXdXJVyBYGYgjH",
  "Martial Arts: Sambo": "sj9crrcjhlkhWIk9",
  "Martial Arts: Savate": "ZCnRa590mHEV6UBX",
  "Martial Arts: Sumo": "ZrVsKBYGxY56jnMb",
  "Martial Arts: TaeKwonDo": "E8XJt0vAzvlOspLU",
  "Martial Arts: TaiChiChuan": "3MsLf8ixMyBGG7je",
  "Martial Arts: Te": "v0W0oqDBHY2yqqt3",
  "Martial Arts: ThaiKickBoxing": "jgvFY5BWVsanP0md",
  "Martial Arts: Thamoc": "ZyMZ6C7r9V2TXmV9",
  "Martial Arts: ThrashBoxing": "Iw1fJPfME3uXQ48D",
  "Martial Arts: WingChung": "WsPa5ZiNIjLhCIxH",
  "Martial Arts: Wrestling": "GZtVOGgtxv8CCuuz"
};

export const MARTIAL_ART_KEY_BY_ID = Object.fromEntries(
  Object.entries(MARTIAL_ART_ID_BY_KEY).map(([k, id]) => [id, k])
);

export const FNFF2_ONLY_MARTIAL_ART_KEYS = new Set([
  "Martial Arts: ArasakaTe",
  "Martial Arts: GunFu",
  "Martial Arts: JeetKunDo",
  "Martial Arts: Jujitsu",
  "Martial Arts: Koppo",
  "Martial Arts: Ninjutsu",
  "Martial Arts: PanzerFaust",
  "Martial Arts: Sambo",
  "Martial Arts: Sumo",
  "Martial Arts: TaiChiChuan",
  "Martial Arts: Te",
  "Martial Arts: Thamoc",
  "Martial Arts: ThrashBoxing",
  "Martial Arts: WingChung"
]);

export const FNFF2_ONLY_MARTIAL_ART_IDS = new Set(
  [...FNFF2_ONLY_MARTIAL_ART_KEYS]
    .map(k => MARTIAL_ART_ID_BY_KEY[k])
    .filter(Boolean)
);

export function isFnff2OnlyMartialArtKey(key) {
  return FNFF2_ONLY_MARTIAL_ART_KEYS.has(key);
}

export function isFnff2OnlyMartialArtId(id) {
  return FNFF2_ONLY_MARTIAL_ART_IDS.has(id);
}

export function isFnff2Enabled() {
  return Boolean(game?.settings?.get("cyberpunk2020", "fnff2Enabled"));
}

/**
 * The master switch over combat *resolution*. Off leaves the system rolling dice and posting cards
 * while the table applies everything by hand; combat *management* — initiative, the movement
 * allowance, the pause gate, turn notices — runs either way.
 *
 * It lives here rather than in `combat.js` because `actor.js`, `item.js`, `damage.js` and `zones.js`
 * all read it and all already import this module, which imports only `constants.js`.
 */
export function isCombatAutomationEnabled() {
  return Boolean(game?.settings?.get("cyberpunk2020", "combatAutomation"));
}

// CORE set rules martial action bonuses. The authority is the corebook's *Martial Arts Forms &
// Specialization Bonuses* table (`07-friday-night-firefight.md:313-325`), transcribed at
// `dev/docs/RULES-MARTIAL-TABLES.md` — code against that file, not memory (`T145`, D42).
export const martialActionBonusesCore = {
  "Martial Arts: Karate": { Strike: 2, Kick: 2, BlockParry: 2 },
  "Martial Arts: Judo": { Dodge: 1, Throw: 3, Hold: 2, Escape: 2, SweepTrip: 2, Grapple: 2 },
  "Martial Arts: Boxing": { Strike: 3, BlockParry: 3, Dodge: 1 },
  "Martial Arts: ThaiKickBoxing": { Strike: 3, Kick: 3, BlockParry: 2, Grapple: 1 },
  "Martial Arts: ChoiLiFut": { Strike: 2, Kick: 2, BlockParry: 2, Dodge: 1, Throw: 1, SweepTrip: 2 },
  "Martial Arts: Aikido": { BlockParry: 4, Dodge: 3, Throw: 3, Hold: 3, Escape: 3, Choke: 1, SweepTrip: 3, Grapple: 2 },
  "Martial Arts: AnimalKungFu": { Strike: 2, Kick: 2, BlockParry: 2, SweepTrip: 1 },
  "Martial Arts: TaeKwonDo": { Strike: 3, Kick: 3, BlockParry: 2, Dodge: 1, SweepTrip: 2 },
  "Martial Arts: Savate": { Kick: 4, BlockParry: 1, Dodge: 1 },
  "Martial Arts: Wrestling": { Throw: 3, Hold: 4, Escape: 4, Choke: 2, SweepTrip: 2, Grapple: 4 },
  "Martial Arts: Capoeira": { Strike: 1, Kick: 2, BlockParry: 2, Dodge: 2, SweepTrip: 3 },
  "Brawling": {}
};

// FNFF2 set rules martial action bonuses. Its authority is the owner's FNFF2 screen, transcribed
// in the same file — FNFF2 is optional material with no corebook table behind it (D28/D42).
export const martialActionBonusesFNFF2 = {
  "Martial Arts: Aikido": {
    Disarm: 3, SweepTrip: 3, BlockParry: 4, Dodge: 3, Grapple: 2, Throw: 3, Hold: 2, Choke: 1, Escape: 2
  },
  "Martial Arts: AnimalKungFu": {
    Strike: 2, Punch: 2, Kick: 2, Disarm: 1, SweepTrip: 1, BlockParry: 2
  },
  "Martial Arts: ArasakaTe": {
    Strike: 1, Punch: 1, Kick: 1, BlockParry: 1, Dodge: 1, Grapple: 1, Throw: 1, Hold: 1, Choke: 2, Escape: 1
  },
  "Martial Arts: Boxing": {
    Punch: 3, SweepTrip: 3, BlockParry: 1
  },
  "Martial Arts: Capoeira": {
    Punch: 1, Kick: 2, SweepTrip: 3, BlockParry: 2, Dodge: 2
  },
  "Martial Arts: ChoiLiFut": {
    Strike: 2, Punch: 2, Kick: 2, Disarm: 1, SweepTrip: 2, BlockParry: 2, Dodge: 1, Grapple: 1, Throw: 1
  },
  "Martial Arts: GunFu": {
    SweepTrip: 3, BlockParry: 2, Dodge: 4, Grapple: 4, Escape: 2
  },
  "Martial Arts: JeetKunDo": {
    Strike: 3, Punch: 3, Kick: 2, Disarm: 1, SweepTrip: 1, BlockParry: 2
  },
  "Martial Arts: Judo": {
    SweepTrip: 2, Dodge: 1, Grapple: 2, Throw: 3, Hold: 2, Choke: 1, Escape: 2
  },
  "Martial Arts: Jujitsu": {
    SweepTrip: 2, BlockParry: 3, Dodge: 2, Throw: 2, Hold: 4, Choke: 3
  },
  "Martial Arts: Karate": {
    Punch: 2, Kick: 2, Disarm: 1, BlockParry: 2
  },
  "Martial Arts: Koppo": {
    Punch: 4, Kick: 2, SweepTrip: 3, BlockParry: 3, Grapple: 2, Hold: 2, Choke: 1, Escape: 2
  },
  "Martial Arts: Ninjutsu": {
    Strike: 3, Punch: 3, Kick: 1, Disarm: 2, SweepTrip: 2, BlockParry: 1, Dodge: 2, Grapple: 1, Throw: 1, Hold: 1, Choke: 1, Escape: 1
  },
  "Martial Arts: PanzerFaust": {
    Punch: 3, Kick: 3, SweepTrip: 1, Dodge: 3, Grapple: 3, Throw: 1, Escape: 4, Ram: 3
  },
  "Martial Arts: Sambo": {
    Strike: 2, Punch: 2, Kick: 2, Disarm: 2, SweepTrip: 2, Grapple: 2, Throw: 3, Hold: 2, Escape: 2
  },
  "Martial Arts: Savate": {
    Kick: 4, BlockParry: 1, Dodge: 1
  },
  "Martial Arts: Sumo": {
    Punch: 2, SweepTrip: 2, Dodge: 2, Grapple: 2, Throw: 3, Hold: 1, Escape: 1, Ram: 4
  },
  "Martial Arts: TaeKwonDo": {
    Punch: 3, Kick: 3, SweepTrip: 2, BlockParry: 2, Dodge: 1
  },
  "Martial Arts: TaiChiChuan": {
    Strike: 2, Punch: 2, Kick: 1, Disarm: 1, BlockParry: 2, Dodge: 1, Grapple: 1
  },
  "Martial Arts: Te": {
    Strike: 2, Punch: 2, Kick: 1, Disarm: 1, SweepTrip: 2, Dodge: 1
  },
  "Martial Arts: ThaiKickBoxing": {
    Punch: 3, Kick: 4, BlockParry: 2, Grapple: 1
  },
  "Martial Arts: Thamoc": {
    Strike: 1, Disarm: 4, SweepTrip: 1, BlockParry: 1, Dodge: 2, Grapple: 1, Escape: 2
  },
  "Martial Arts: ThrashBoxing": {
    Strike: 1, Punch: 2, Kick: 3, SweepTrip: 3, Dodge: 1, Throw: 1, Escape: 2
  },
  "Martial Arts: WingChung": {
    Punch: 4, Kick: 2, SweepTrip: 1, BlockParry: 3, Dodge: 1, Hold: 2
  },
  "Martial Arts: Wrestling": {
    SweepTrip: 2, Grapple: 4, Throw: 3, Hold: 4, Choke: 2, Escape: 4
  },

  "Brawling": {}
};

export const fnff2DamageBonusSymbols = {
  Strike: "*",
  Punch: "*",
  Kick: "*",
  Disarm: "%",
  SweepTrip: "$",
  BlockParry: "@",
  Dodge: "@",
  Grapple: "%",
  Throw: "*",
  Hold: "$",
  Choke: "*",
  Escape: "@",
  Ram: "*"
};

export function getFnff2DamageBonusSymbol(actionKey) {
  return fnff2DamageBonusSymbols[actionKey] ?? "*";
}

/**
 * The maneuvers that answer an attack rather than make one, in `martialActionBonuses*` keys. The
 * same two are `martialOptions`' own "Defensive" group under both rule sets; FNFF2's All-Out pair
 * is deliberately absent, because trading one side of the exchange for the other is a choice the
 * defender makes and not a bonus the style always carries.
 */
export const DEFENSIVE_MARTIAL_ACTIONS = ["Dodge", "BlockParry"];

export function getMartialActionBonus(martialKey, actionKey) {
  const fnff2 = isFnff2Enabled();

  if (!fnff2 && FNFF2_ONLY_MARTIAL_ART_KEYS.has(martialKey)) {
    return 0;
  }

  const table = fnff2 ? martialActionBonusesFNFF2 : martialActionBonusesCore;
  const style = table[martialKey] || {};
  return Number(style[actionKey] || 0);
}

// Be warned that the localisations of these take a range parameter
export let ranges = {
    pointBlank: "RangePointBlank",
    close: "RangeClose",
    medium: "RangeMedium",
    long: "RangeLong",
    extreme: "RangeExtreme"
}
let rangeDCs = {}
rangeDCs[ranges.pointBlank] = 10;
rangeDCs[ranges.close] = 15;
rangeDCs[ranges.medium] = 20;
rangeDCs[ranges.long] = 25;
rangeDCs[ranges.extreme] = 30;
let rangeResolve = {};
rangeResolve[ranges.pointBlank] = range => 1;
rangeResolve[ranges.close] = range => range/4;
rangeResolve[ranges.medium] = range => range/2;
rangeResolve[ranges.long] = range => range;
rangeResolve[ranges.extreme] = range => range*2;
export { rangeDCs, rangeResolve }

export let defaultTargetLocations = ["Head", "Torso", "lArm", "rArm", "lLeg", "rLeg"]
export let defaultAreaLookup = {
    1: "Head",
    2: "Torso",
    3: "Torso",
    4: "Torso",
    5: "rArm",
    6: "lArm",
    7: "rLeg",
    8: "rLeg",
    9: "lLeg",
    10: "lLeg"
}

export function defaultHitLocations() {
  return cloneSystemDefault(DEFAULT_HIT_LOCATIONS);
}

/**
 * The range band a measured distance falls into, or null when there is nothing to measure — the
 * dialog then opens on its old default and the player picks by hand.
 */
export function rangeBandFor(distance, weaponRange) {
    if (!Number.isFinite(distance) || !Number.isFinite(weaponRange) || weaponRange <= 0) return null;
    if (distance <= 1) return "RangePointBlank";
    if (distance <= weaponRange / 4) return "RangeClose";
    if (distance <= weaponRange / 2) return "RangeMedium";
    if (distance <= weaponRange) return "RangeLong";
    return "RangeExtreme";
}

export function rangedModifiers(weapon, targetTokens = [], savedOptions = {}, measuredDistance = null) {
    const sys = weapon._getWeaponSystem?.() ?? weapon.system ?? {};
    let range = sys.range || 50;
    let fireModes = weapon.__getFireModes() || [];
    const rof = Math.max(0, Math.floor(Number(sys.rof) || 0));
    const shotsLeft = Math.max(0, Math.floor(Number(sys.shotsLeft) || 0));
    const suppressiveRoundsMax = Math.min(rof, shotsLeft);

    const savedFireMode = savedOptions?.fireMode;
    const fireModeDefault = fireModes.includes(savedFireMode)
      ? savedFireMode
      : fireModes[0];

    // The abstract per-target tally is what reads the target count, and `__suppressiveFire` takes
    // that branch on exactly this condition (`T69`). With a zone on the map every crossing rolls
    // its own hits and the number would be a control that changes nothing.
    const abstractSuppression = !(canvas?.ready && isCombatAutomationEnabled());
    return [
        [{
            localKey: "FireMode",
            dataPath: "fireMode",
            choices: fireModes,
            defaultValue: fireModeDefault
        },
        {
            localKey: "Range",
            dataPath: "range",
            defaultValue: rangeBandFor(measuredDistance, range) ?? "RangeClose",
            choices: [
                {value:"RangePointBlank", localData: {range: 1}},
                {value:"RangeClose", localData: {range: range/4}},
                {value:"RangeMedium", localData: {range: range/2}},
                {value:"RangeLong", localData: {range: range}},
                {value:"RangeExtreme", localData: {range: range*2}}
            ]
        }],
        [{
            localKey: "Aiming",
            dataPath: "aimRounds",
            defaultValue: 0,
            choices: [0,1,2,3].map(x => {
                return { value: x, localKey: "Rounds", localData: {rounds: x}}
            }),
        },
        {
            localKey: "TargetArea",
            dataPath: "targetArea",
            defaultValue: "",
            choices: defaultTargetLocations,
            allowBlank: true
        },
        {localKey:"Ambush", dataPath:"ambush",defaultValue: false},
        {localKey:"Blinded", dataPath:"blinded",defaultValue: false},
        {localKey:"DualWield", dataPath:"dualWield",defaultValue: false},
        {localKey:"FastDraw", dataPath:"fastDraw",defaultValue: false},
        {localKey:"Hipfire", dataPath:"hipfire",defaultValue: false},
        {localKey:"Ricochet", dataPath:"ricochet",defaultValue: false},
        {localKey:"Running", dataPath:"running",defaultValue: false},
        {localKey:"TurnFace", dataPath:"turningToFace",defaultValue: false},
        {
            localKey: "FireZoneWidth",
            dataPath: "zoneWidth",
            dtype: "Number",
            defaultValue: 2,
            min: 2,
            step: 1,
            extraClasses: "suppressive-field suppressive-zone-width"
        },
        {
            localKey: "RoundsFiredLbl",
            dataPath: "roundsFired",
            dtype: "Number",
            defaultValue: suppressiveRoundsMax,
            // A weapon with nothing to fire — a cyberweapon left at the schema's default ROF 0 is
            // the shipped route there — rendered `min: 1, max: 0`, a range no value satisfies
            // (`T113`). The row still shows, because the mode is still offered.
            min: suppressiveRoundsMax > 0 ? 1 : 0,
            max: suppressiveRoundsMax,
            step: 1,
            extraClasses: "suppressive-field suppressive-rounds-fired"
        },
        ...(abstractSuppression ? [{
            localKey: "TargetsCount",
            dataPath: "targetsCount",
            dtype: "Number",
            defaultValue: Math.max(1, targetTokens.length),
            min: 1,
            step: 1,
            extraClasses: "suppressive-field suppressive-targets-count"
        }] : []),
        ]
    ];
}

export function martialOptions(actor, savedOptions = {}) {
    const actionChoices = (() => {
      const base = [
        { groupName: "Defensive", choices: [
          "Dodge",
          "BlockParry"
        ]},
        { groupName: "Attacks", choices: [
          "Strike",
          "Kick",
          "Disarm",
          "SweepTrip"
        ]},
        { groupName: "Grapple", choices: [
          "Grapple",
          "Hold",
          "Choke",
          "Throw",
          "Escape"
        ]}
      ];

      if (isFnff2Enabled()) {
        base[0].choices.unshift("AllOutParry", "AllOutDodge");
        base[1].choices.splice(1, 0, "Punch");
        base[1].choices.push("Ram", "JumpKick", "Cast");
      }

      return base;
    })();

    const flattenChoiceValues = (choices) => {
      return choices.flatMap(choice => {
        if (choice?.groupName) return choice.choices ?? [];
        return [choice?.value ?? choice];
      });
    };

    const savedAction = savedOptions?.action;
    const actionDefault = flattenChoiceValues(actionChoices).includes(savedAction)
      ? savedAction
      : "Strike";

    const martialChoices = [
      { value: "Brawling", localKey: "SkillBrawling" },
      ...((actor?.trainedMartials?.() ?? []).map(key => {
        return {
          value: key,
          label: actor?.getMartialDisplayName?.(key) ?? key
        };
      }))
    ];

    const savedMartialArt = savedOptions?.martialArt;
    const martialArtDefault = martialChoices
      .map(choice => choice.value ?? choice)
      .includes(savedMartialArt)
        ? savedMartialArt
        : "Brawling";

    const cyberTerminusChoices = [
        { value: "NoCyberlimb", localKey: "NoCyberlimb" },
        { value: "CyberTerminusX2", localKey: "CyberTerminusX2" },
        { value: "CyberTerminusX3", localKey: "CyberTerminusX3" }
    ];

    const savedCyberTerminus = savedOptions?.cyberTerminus;
    const cyberTerminusDefault = cyberTerminusChoices
      .map(choice => choice.value)
      .includes(savedCyberTerminus)
        ? savedCyberTerminus
        : "NoCyberlimb";

    return [
        [{
            localKey: "Action",
            dataPath: "action",
            defaultValue: actionDefault,
            choices: actionChoices,
        },
        {
            localKey: "MartialArt",
            dataPath: "martialArt",
            defaultValue: martialArtDefault,
            choices: martialChoices
        },
        {
            localKey: "TargetArea",
            dataPath: "targetArea",
            defaultValue: "",
            choices: defaultTargetLocations,
            allowBlank: true
        },
        {
            localKey: "CyberTerminus",
            dataPath: "cyberTerminus",
            defaultValue: cyberTerminusDefault,
            choices: cyberTerminusChoices
        }
    ]]
}

// Needs to be a function, or every time the modifiers dialog is launched, it'll add "extra mods" on
export function meleeBonkOptions(savedOptions = {}) {
    const cyberTerminusChoices = [
        { value: "NoCyberlimb", localKey: "NoCyberlimb" },
        { value: "CyberTerminusX2", localKey: "CyberTerminusX2" },
        { value: "CyberTerminusX3", localKey: "CyberTerminusX3" }
    ];

    const savedCyberTerminus = savedOptions?.cyberTerminus;
    const cyberTerminusDefault = cyberTerminusChoices
      .map(choice => choice.value)
      .includes(savedCyberTerminus)
        ? savedCyberTerminus
        : "NoCyberlimb";

    return [[
        {
            localKey: "TargetArea",
            dataPath: "targetArea",
            defaultValue: "",
            choices: defaultTargetLocations,
            allowBlank: true
        },
        {
            localKey: "CyberTerminus",
            dataPath: "cyberTerminus",
            defaultValue: cyberTerminusDefault,
            choices: cyberTerminusChoices
        }
    ]]
}
/**
 * Get a body type modifier from the body type stat (body)
 * I couldn't figure out a single formula that'd work for it (cos of the weird widths of BT values)
 */
export function btmFromBT(body) {
    if(body <= 2) {
        return 0;
      }
      switch(body) {
        // Weak
        case 3: 
        case 4: return 1
        // Average
        case 5:
        case 6:
        case 7: return 2;
        // Strong
        case 8:
        case 9: return 3;
        // Very strong
        case 10: return 4;
        default: return 5;
      }
}

export function strengthDamageBonus(bt) {
    let btm = btmFromBT(bt);
    if(btm < 5)
        return btm - 2;

    switch(bt) {
        case 11:
        case 12: return 4 
        case 13:
        case 14: return 6
        default: return 8
    }
}