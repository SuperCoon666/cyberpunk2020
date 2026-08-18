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

/** Ch. `07:982` gives the maneuver list to Brawling and the martial arts, and to nothing else. */
export const BRAWLING_SKILL_ID = "i8qoUwZ5jI9KAZeK";

/** Ch. 07:731 — the skill a suppressive-fire save is rolled on, and ch. 04:654 a throw (D52). */
export const ATHLETICS_SKILL_ID = "gULme1P5CR8rXXIh";

// Ch. 04:745 — "how to set timers and detonators, and how much explosive to use", the check a
// planted charge is set with (D102). A TECH skill (`02:284`), which is why the plant roll does not
// go through `attackRoll`'s REF.
export const DEMOLITIONS_SKILL_ID = "aMpWKwdKl1m4k9Py";

export const INTERFACE_SKILL_IDS = new Set([
  "sqHlfxm32pNENNFZ", // Interface
  "Nc1zY8vB6qWt4pXj"  // Интерфейс
]);

// Ch. 07:614 — "any Medical Skill" added to a stabilization roll. Medical Tech is a *role* skill and
// the two role packs share no ids at all, so it needs one per language; First Aid is a default skill
// and the two default packs share every id, so one covers both.
export const MEDICAL_TECH_SKILL_IDS = new Set([
  "f1OKKB0bc1RaGdrM", // Medical Tech
  "Mk0pH2nR8cVt5yJq"  // Медицинский техник
]);

export const FIRST_AID_SKILL_ID = "IU0oTzMUQdKFEhBS";

// The `cyberpunk2020.melee` documents `_preCreate` used to inject into every new character (D53,
// `T222`). Strike is what the combat tab's fixed unarmed button borrows — icon and weapon data —
// and both are what the migration removes from existing actors, matched by **id**: the packs carry
// the same weapon under a translated name.
export const UNARMED_STRIKE_ID = "TZoiQuE8fUzJ8Jta";
export const UNARMED_KICK_ID = "TF0nBrjofPX2RiuG";
export const UNARMED_WEAPON_IDS = [UNARMED_STRIKE_ID, UNARMED_KICK_ID];

/** Ch. 07:620-624 — the three advantages the book adds to the stabilization die roll. */
export const STABILIZATION_ADVANTAGES = [
  { localKey: "StabilizeFullHospital", dataPath: "fullHospital", bonus: 5 },
  { localKey: "StabilizeTraumaTeam", dataPath: "traumaTeam", bonus: 3 },
  { localKey: "StabilizeSuspensionTank", dataPath: "suspensionTank", bonus: 3 }
];

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
    AmmoReloadThrown: 1,
    AmmoReloadOther: 1
};

export let weaponTypes = {
    pistol: "Pistol",
    submachinegun: "SMG",
    shotgun: "Shotgun",
    rifle: "Rifle",
    heavy: "Heavy",
    melee: "Melee",
    thrown: "Thrown",
    // D99/D100 — the fourth classification: a device put down where it is wanted rather than
    // aimed. Delivery lives on the weapon; what happens when it goes off lives on the round.
    planted: "Planted",
    exotic: "Exotic"
}

/** Ch. 07:123 / 07:887 — a throw reaches `10m × BOD` of the thrower (D37; D46 declined the kg term). */
export const THROWN_RANGE_PER_BODY = 10;
export let attackSkills = {
    "Pistol": ["Handgun"],
    "SMG": ["Submachinegun"],
    "Shotgun": ["Rifle"],
    // "Rifle": [localize("Rifle")],
    "Rifle": ["Rifle"],
    "Heavy": ["HeavyWeapons"],
    // Trained martial arts get added in item-sheet for now
    "Melee": ["Fencing", "Melee", "Brawling"],
    // Ch. 07:804's "Throwing Skill" is in no skill list of its own; 04:654 gives the job to
    // Athletics, which is also what a suppressive-fire save is rolled on (D52).
    "Thrown": ["Athletics"],
    // D102 — setting a charge is Demolitions, resolved by `_id` like Athletics above.
    "Planted": ["Demolitions"],
    // No limitations for exotic, go nuts
    "Exotic": []
}

export function getStatNames() {
  return [...STAT_KEYS];
}

// How a weapon attacks. Something like pistol or an SMG have rigid rules on how they can attack, but shotguns can be regular or auto shotgun, exotic can be laser, etc. So this is for weird and special stuff that isn't necessarily covered by the weapon's type or other information
// If we change attack type to be an array, we could say, have ["BEAM" "LASER"]
// D107 — thirteen values left this list, and the two reasons they left are why they should not
// come back. How a weapon is delivered (thrown, grenade, mine, charge) is the weapon's own class,
// and what it does on arrival (gas, acid, taser, dart) belongs to the round it loads.
// `CyberpunkWeaponData.migrateData` renames each of them to `""`.
export let rangedAttackTypes = {
    semiAuto: "SemiAuto",
    auto: "Auto",
    archer: "Archer",
    // Beam weapons
    laser: "Laser",
    microwave: "Microwave",
    // Area effect weapons
    shotgun: "Shotgun",
    autoshotgun: "Autoshotgun",
    flamethrow: "Flamethrow",
    missile: "Missile"
}

// `Mono` was here until the feature wave: a mono edge is a property of the blade, so it became
// `system.mono` and a martial weapon can carry one. `migrateData` converts the old value.
export let meleeAttackTypes = {
    melee: "Melee", // Regular melee bonk
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

/**
 * The two maneuvers whose effect is not a number added to the roll (D163), keyed to the string that
 * says what they do instead.
 *
 * Both lists that show a maneuver read this one map: the defence prompt and the attack dialog's own
 * Defensive group. A bare `(+0)` beside a bonused row reads as "strictly worse than the Dodge above
 * it", which is the opposite of what All-Out does — and the pair sits *above* the bonused rows, so
 * it is the first thing a player compares (`T354`).
 */
export const allOutEffectKeys = {
  [martialActions.allOutParry]: "DefenseAllOutParryEffect",
  [martialActions.allOutDodge]: "DefenseAllOutDodgeEffect"
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

/**
 * Ch. 07:984-992 — unarmed damage is stated per **maneuver**, not per weapon: Strike `1D6/2`, Kick
 * and Throw `1D6`, Choke `1D6` per turn. The *Damage Modifier* the book adds to each is the
 * strength bonus the damage formula already appends, so only the die belongs here.
 *
 * D90 — read for the combat tab's unarmed stand-in alone. A real melee weapon rolls its own DAM
 * whatever maneuver is chosen; the book gives a maneuver a formula only where the fist is the
 * weapon. A maneuver absent from this table (the FNFF2 additions, which no corebook line covers)
 * keeps the stand-in's own formula, as before.
 */
export const unarmedManeuverDamage = {
  Strike: "1D6/2",
  Kick: "1D6",
  Throw: "1D6",
  Choke: "1D6"
};

/**
 * FNFF2's four extra unarmed maneuvers (D200). The authority is the Pacific Rim sourcebook,
 * transcribed and primary-verified at `dev/docs/cp2020_pacific_rim_FNFF2_verified_v2.md` — code
 * against that file and not its superseded v1 sibling. No corebook line covers any of them, so
 * they sit behind the same gate `martialActionBonusesFNFF2` does.
 *
 * Ram is absent because its damage is a chart on the attacker's own BODY — `ramDamageFormula`.
 * Cast is the Throw analogue: RAW Cast is weapon-based and has no bare-hand form, so the weapon
 * path defers with the rest of FNFF2 (TODO `T-41`), as do HH(BODY), MA-on-Key, Dash and the
 * cyberleg Jump Kick columns.
 */
export const unarmedManeuverDamageFNFF2 = {
  Punch: "1D6/2",
  JumpKick: "1D6+5",
  Cast: "1D6"
};

/**
 * Pacific Rim p.144 — *"You get a -5 penalty to Hit automatically"* on a Jump Kick. D200 ships it
 * with the maneuver's `1D6+5` rather than after it: the damage alone would strictly dominate a
 * plain Kick, and the book prices the two together.
 */
export const JUMP_KICK_TO_HIT = -5;

/**
 * Ram's damage, read off the Pacific Rim chart on p.143 by the attacker's own BODY.
 *
 * The one stat-dependent entry in the unarmed table, and deliberately so: the chart has BODY
 * built into it, so the separate HH(BODY) modifier is **not** added on top (D200). The chart's
 * last printed row is *"each + : each +1D6"*, which is why a BODY past its top band keeps
 * gaining dice rather than flattening.
 *
 * @param {number} body The attacker's BODY total
 * @returns {string} A rollable formula
 */
export function ramDamageFormula(body) {
  const bod = Math.max(2, Math.floor(Number(body) || 0));
  if (bod <= 2) return "1D6-2";
  if (bod <= 4) return "1D6-1";
  if (bod <= 5) return "1D6";
  if (bod <= 7) return "2D6";
  if (bod <= 9) return "2D6+1";
  if (bod <= 10) return "2D6+2";
  if (bod <= 12) return "3D6+4";
  if (bod <= 14) return "3D6+6";
  if (bod <= 15) return "3D6+8";
  return `${4 + Math.max(0, bod - 20)}D6+8`;
}

/**
 * What the combat tab's unarmed stand-in rolls for one maneuver, or undefined where neither table
 * gives it a formula — which leaves the stand-in's own damage, exactly as before D90.
 *
 * @param {string} action A `martialActions` value
 * @param {number} body The attacker's BODY total, for the one entry that reads it
 * @returns {string|undefined}
 */
export function unarmedManeuverFormula(action, body) {
  if (unarmedManeuverDamage[action]) return unarmedManeuverDamage[action];
  if (!isFnff2Enabled()) return undefined;
  if (action === martialActions.ram) return ramDamageFormula(body);
  return unarmedManeuverDamageFNFF2[action];
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
 * The maneuvers that answer an attack rather than make one, in `martialActionBonuses*` keys — the
 * same set `martialOptions` offers in its own "Defensive" group under each rule set.
 *
 * D148 — FNFF2's All-Out pair is **offered**: it was left out while the code picked the defence
 * itself, because trading one side of the exchange for the other is the defender's choice and not a
 * bonus the style always carries — and since `T232`/D58 the defender does the picking, which turns
 * that reason into the reason to offer them. The trade is stated on the prompt and enforced nowhere
 * (the no-hard-limits shape); the table decides what it costs the defender's own attack.
 *
 * **Dodge stays first and that is load-bearing**: `defenseOptions`' `bestOf` and `resolveDefense`'s
 * `find` both take the first of equal totals, which is how D57's Dodge-on-tie is implemented.
 *
 * **D163's pair must stay out of both bonus tables**, and for the same two lines: All-Out Parry
 * wins the contest outright and nothing enforces the attack it costs (D148), so an auto-defence
 * allowed to reach it would take it every time. With no entry in either table both rows total the
 * plain base, and `bestOf`/`find` land on the Dodge sitting above them — a silent defender and an
 * NPC can never be given an All-Out maneuver.
 *
 * @returns {string[]}
 */
export function defensiveMartialActions() {
  return isFnff2Enabled()
    ? ["Dodge", "BlockParry", "AllOutParry", "AllOutDodge"]
    : ["Dodge", "BlockParry"];
}

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
    // D196 — not a band but the instruction to measure one. Nothing downstream ever sees it:
    // `__weaponRoll` resolves it to one of the five below, or refuses the attack (D199).
    auto: "RangeAuto",
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

/**
 * How far this weapon reaches, in metres. A thrown weapon's range is the thrower's rather than the
 * item's — `10m × BOD` (`07:123`, `07:887`) — and the number stored on the item is **ignored** for
 * it, because every shipped grenade carries a flat 50 that would otherwise win (D37/D52, `AB-Q26`).
 * Every read site calls this rather than `system.range`.
 *
 * @param {CyberpunkItem} weapon The weapon or cyberweapon; its `actor` is the thrower
 * @returns {number} 0 when there is no range to read — an unowned thrown weapon has no thrower
 */
export function effectiveRange(weapon) {
    const sys = weapon?._getWeaponSystem?.() ?? weapon?.system ?? {};
    if (sys.weaponType !== weaponTypes.thrown) return Number(sys.range) || 0;
    // BODY total, not base: cyberware that raises it is part of the arm doing the throwing. Wound
    // penalties never reach `bt`, so a hurt thrower still throws as far.
    return THROWN_RANGE_PER_BODY * (Number(weapon?.actor?.system?.stats?.bt?.total) || 0);
}

export function rangedModifiers(weapon, targetTokens = [], savedOptions = {}, measuredDistance = null) {
    const sys = weapon._getWeaponSystem?.() ?? weapon.system ?? {};
    let range = effectiveRange(weapon) || 50;
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
    const autoRange = isCombatAutomationEnabled();
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
            // D196 — automatic measurement is the default for every ranged weapon, and it is
            // offered only while the automation master is on: with it off the selector is exactly
            // what it was, and a deliberately picked band is played entirely as declared.
            defaultValue: autoRange ? ranges.auto : (rangeBandFor(measuredDistance, range) ?? "RangeClose"),
            // D204 — suppressive fire is off the auto option: it lays its corridor before anything
            // is measured, so its selector keeps the constant bands. The dialog swaps to this the
            // moment that fire mode is picked, and it is the same band the field opens on with the
            // automation master off, so auto and manual still agree about this weapon.
            constantDefault: rangeBandFor(measuredDistance, range) ?? "RangeClose",
            choices: [
                ...(autoRange ? [{value: ranges.auto}] : []),
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
            // The row is shared with the flamethrower sweep (`T252`, D91), and a flamethrower cannot
            // suppress: `FireZoneWidth` reads «Ширина подавления (м)» in `ru`, naming a mechanic this
            // weapon has no access to, while the card the same shot posts already says «Ширина
            // струи». Resolved per weapon here so the dialog and the card agree (`T304`).
            localKey: sys.attackType === rangedAttackTypes.flamethrow ? "SweepWidth" : "FireZoneWidth",
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

/** The stabilization dialog's own fields: the book's three advantages, plus the dialog's own extra mod. */
export function stabilizationOptions() {
    return [STABILIZATION_ADVANTAGES.map(({ localKey, dataPath }) => ({
        localKey,
        dataPath,
        defaultValue: false
    }))];
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