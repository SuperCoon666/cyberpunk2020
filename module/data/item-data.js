import {
  arrayField,
  booleanField,
  htmlField,
  mergeDefaults,
  normalizeArray,
  normalizeBoolean,
  normalizeNumber,
  numberField,
  objectField,
  stringField
} from "./schema-helpers.js";

const COMMON_DEFAULTS = {
  flavor: "",
  notes: "",
  cost: 0,
  weight: 0,
  equipped: true,
  source: ""
};

const DEFAULT_RANGE_DAMAGES = {
  pointBlank: "",
  close: "",
  medium: "",
  far: "",
  short: "",
  extreme: ""
};

const DEFAULT_COVERAGE = {
  Head: { stoppingPower: 0, ablation: 0 },
  Torso: { stoppingPower: 0, ablation: 0 },
  lArm: { stoppingPower: 0, ablation: 0 },
  rArm: { stoppingPower: 0, ablation: 0 },
  lLeg: { stoppingPower: 0, ablation: 0 },
  rLeg: { stoppingPower: 0, ablation: 0 }
};

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function isDeletionOperator(value) {
  if (!value || typeof value !== "object") return false;

  const ForcedDeletion = globalThis.foundry?.data?.operators?.ForcedDeletion;
  if (typeof ForcedDeletion === "function" && value instanceof ForcedDeletion) return true;

  return value.constructor?.name === "ForcedDeletion";
}

function normalizeNumberIfPresent(source, key, fallback = 0) {
  if (hasOwn(source, key)) source[key] = normalizeNumber(source[key], fallback);
}

function normalizeBooleanIfPresent(source, key, fallback = false) {
  if (hasOwn(source, key)) source[key] = normalizeBoolean(source[key], fallback);
}

function normalizeArrayIfPresent(source, key, fallback = []) {
  if (hasOwn(source, key)) source[key] = normalizeArray(source[key], fallback);
}

const DEFAULT_WEAPON = {
  weaponType: "Pistol",
  accuracy: 0,
  concealability: "P",
  availability: "common",
  ammoType: "9mm",
  ammoItemId: "",
  damage: "2d6+1",
  rangeDamages: DEFAULT_RANGE_DAMAGES,
  ap: false,
  shotsLeft: 12,
  shots: 12,
  rof: 2,
  reliability: "ST",
  range: 50,
  attackType: "",
  attackSkill: "ref"
};

const DEFAULT_CYBERWARE = {
  ...COMMON_DEFAULTS,
  surgCode: "N",
  humanityCost: "1d6",
  cyberwareType: "",
  cyberwareSubtype: "",
  abbrev: "",
  humanityLoss: 0,
  MountZone: "",
  EffectMode: "Permanent",
  EffectActive: false,
  Module: {
    IsModule: false,
    AllowedParentCyberwareType: "",
    SlotsTaken: 0,
    ParentId: ""
  },
  CyberBodyType: {
    Type: "",
    Location: ""
  },
  CyberWorkType: {
    Type: "Descriptive",
    Stat: {},
    Skill: {},
    Checks: {},
    Locations: {},
    Encumbrance: 0,
    Penalties: {},
    Link: "",
    ItemId: "",
    OptionsAvailable: 0,
    SDP: 0,
    ChipSkills: {},
    ChipActive: false,
    Types: [],
    Weapon: {
      ...DEFAULT_WEAPON,
      shotsLeft: 0,
      shots: 0,
      rof: 0,
      range: 0
    }
  },
  slots: 0,
  spaces: 0,
  effectTypes: ["None"]
};

function commonSchema() {
  return {
    flavor: stringField(""),
    notes: htmlField(""),
    cost: numberField(0),
    weight: numberField(0),
    equipped: booleanField(true),
    source: stringField(""),
    lastOwnerId: stringField("")
  };
}

class CyberpunkBaseItemData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return commonSchema();
  }

  static migrateData(source) {
    source ??= {};

    if (hasOwn(source, "notes")) source.notes ??= "";
    if (hasOwn(source, "flavor")) source.flavor ??= "";
    if (hasOwn(source, "source")) source.source ??= "";
    normalizeBooleanIfPresent(source, "equipped", true);
    if (source.cost === null) source.cost = 0;
    if (source.weight === null) source.weight = 0;
    if (hasOwn(source, "lastOwnerId")) source.lastOwnerId ??= "";
    return super.migrateData(source);
  }
}

export class CyberpunkSkillData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      flavor: stringField(""),
      notes: htmlField(""),
      level: numberField(0),
      chipLevel: numberField(0),
      ip: numberField(0),
      IP: numberField(0),
      diffMod: numberField(1),
      isChipped: booleanField(false),
      autoChipped: booleanField(false),
      isRoleSkill: booleanField(false),
      trained: booleanField(false),
      stat: stringField("cool"),
      askMods: booleanField(false)
    };
  }

  static migrateData(source) {
    source ??= {};

    if (hasOwn(source, "notes")) source.notes ??= "";
    if (hasOwn(source, "flavor")) source.flavor ??= "";

    if (hasOwn(source, "IP") && !hasOwn(source, "ip")) source.ip = source.IP;
    if (hasOwn(source, "ip") && !hasOwn(source, "IP")) source.IP = source.ip;

    if (hasOwn(source, "level") || hasOwn(source, "value")) {
      source.level = normalizeNumber(source.level ?? source.value, 0);
    }
    normalizeNumberIfPresent(source, "chipLevel", 0);
    normalizeNumberIfPresent(source, "ip", 0);
    normalizeNumberIfPresent(source, "IP", hasOwn(source, "ip") ? source.ip : 0);
    normalizeNumberIfPresent(source, "diffMod", 1);

    if (hasOwn(source, "isChipped")) {
      source.isChipped = normalizeBoolean(source.isChipped, false);
    } else if (hasOwn(source, "chipped") && !isDeletionOperator(source.chipped)) {
      source.isChipped = normalizeBoolean(source.chipped, false);
    }
    if (hasOwn(source, "chipped") && !isDeletionOperator(source.chipped)) delete source.chipped;

    normalizeBooleanIfPresent(source, "isRoleSkill", false);
    normalizeBooleanIfPresent(source, "trained", false);
    normalizeBooleanIfPresent(source, "autoChipped", false);
    normalizeBooleanIfPresent(source, "askMods", false);
    if (hasOwn(source, "stat")) source.stat ||= "cool";
    return super.migrateData(source);
  }
}

export class CyberpunkProgramData extends CyberpunkBaseItemData {
  static defineSchema() {
    return {
      ...commonSchema(),
      power: numberField(0),
      mu: numberField(0),
      programType: stringField(""),
      actionFormula: stringField("")
    };
  }
}

/**
 * D107 — the thirteen `attackType` values that left `rangedAttackTypes`: six named a delivery
 * method the weapon's own class already carries and seven named an effect belonging to the round.
 * They are cleared rather than left in place because the sheet's select no longer offers them, so
 * a weapon that kept one would lose it on the next unrelated edit and never say that it had.
 */
const REMOVED_ATTACK_TYPES = new Set([
  "Throw", "Grenade", "RPG", "Landmine", "Claymore", "Explocharge",
  "Paint", "Drugs", "Acid", "Gas", "Taser", "Dart", "Squirt"
]);

export class CyberpunkWeaponData extends CyberpunkBaseItemData {
  static defineSchema() {
    return {
      ...commonSchema(),
      weaponType: stringField(DEFAULT_WEAPON.weaponType),
      accuracy: numberField(DEFAULT_WEAPON.accuracy),
      concealability: stringField(DEFAULT_WEAPON.concealability),
      availability: stringField(DEFAULT_WEAPON.availability),
      ammoType: stringField(DEFAULT_WEAPON.ammoType),
      ammoItemId: stringField(DEFAULT_WEAPON.ammoItemId),
      damage: stringField(DEFAULT_WEAPON.damage),
      rangeDamages: objectField(DEFAULT_RANGE_DAMAGES),
      ap: booleanField(DEFAULT_WEAPON.ap),
      // Ch. 07:1065 — a mono edge is a property of the blade, not a kind of attack, so a martial
      // weapon can carry one too. Only meaningful with `ap`, which is what the sheet gates it on.
      mono: booleanField(false),
      shotsLeft: numberField(DEFAULT_WEAPON.shotsLeft),
      shots: numberField(DEFAULT_WEAPON.shots),
      rof: numberField(DEFAULT_WEAPON.rof),
      reliability: stringField(DEFAULT_WEAPON.reliability),
      range: numberField(DEFAULT_WEAPON.range),
      attackType: stringField(DEFAULT_WEAPON.attackType),
      attackSkill: stringField(DEFAULT_WEAPON.attackSkill),
      name: stringField("")
    };
  }

  static migrateData(source) {
    source ??= {};
    if (hasOwn(source, "rangeDamage") && !hasOwn(source, "rangeDamages")) {
      source.rangeDamages = source.rangeDamage;
      delete source.rangeDamage;
    }
    if (hasOwn(source, "rangeDamages")) source.rangeDamages = normalizeRangeDamages(source.rangeDamages);
    normalizeBooleanIfPresent(source, "ap", false);
    normalizeBooleanIfPresent(source, "mono", false);
    // `Mono` was an attack type before it was a property, which made a mono weapon unable to be a
    // martial one. A blade the book calls mono-edge is also an edged weapon, so `ap` comes with it.
    if (source.attackType === "Mono") {
      source.attackType = "Melee";
      source.mono = true;
      source.ap = true;
    }
    if (REMOVED_ATTACK_TYPES.has(source.attackType)) source.attackType = "";
    return super.migrateData(source);
  }
}

/**
 * D52 renamed the ammunition effect list from the mechanisms it configures to the stock rounds a
 * GM actually builds. The fields behind each block are unchanged, so a world's ammunition keeps
 * every value it had and only the label it was filed under moves.
 */
const LEGACY_AMMO_EFFECTS = {
  None: "Standard",
  CoreMods: "AP",
  Stun: "Electroshock",
  // `Poison` named the flavour and never the rule: what the effect implements is ch. 07:910's
  // fire, declining damage and the flamethrower's own armour paragraph included. The book's poison
  // is a save plus a one-off effect (`07:761`) and is out of v1.2.0 (owner, 2026-08-11, `T-44`).
  // `DoT` maps straight through rather than through `Poison`, because one `.map()` does not chain.
  DoT: "Incendiary",
  Poison: "Incendiary",
  Spread: "Buckshot"
};

export class CyberpunkAmmoData extends CyberpunkBaseItemData {
  static defineSchema() {
    return {
      ...commonSchema(),
      // The reload category the sheet has always written and the summary has always read. It was
      // in no schema, so every write of it was pruned and no world holds one.
      weaponType: stringField(""),
      // Rounds a full box holds; 0 means not configured, which is what disables the box counter.
      perBox: numberField(0),
      quantity: numberField(0),
      armorMultSoft: numberField(1),
      armorMultHard: numberField(1),
      rawDamageMult: numberField(1),
      penDamageMult: numberField(1),
      // Ch. 07:865-873 — a finned slug has "normal AP ability vs. all armors" but the damage that
      // penetrates hard armour is not halved. Both default true, which is the flat AP rule every
      // existing world already behaves by, so no document changes meaning (`T95`, D53 У3).
      penHalvesSoft: booleanField(true),
      penHalvesHard: booleanField(true),
      bonusDamageFormula: stringField(""),
      accuracyMod: numberField(0),
      stunSaveOnHit: booleanField(false),
      // D108 — a positive number is entered and the logic subtracts it, so the field reads as the
      // penalty it is. The book prints the same idea with the opposite sign (`07:782`, "reduced by
      // -2"), which is what the old `stunSaveMod` took and what nothing on screen ever said.
      stunSavePenalty: numberField(0),
      // Ch. 07:780-782 conditions the save on being hit, but only a taser charge reaches its victim
      // through armour at all. Default off, so an electroshock bullet keeps asking only where it
      // got in (D62).
      stunIgnoresArmor: booleanField(false),
      dotEnabled: booleanField(false),
      dotTurns: numberField(0),
      // D85 — one damage formula per turn, because the book's own fires decline: the flamethrower
      // is 2D10, then 1D10, then 1D6 (`07:910`) and the cyberlimb flamer 2D6 then 1D6/2 twice
      // (`06:804`). A tick with no formula of its own deals nothing (D87), which is what lets a
      // fire burn, smoulder, then flare.
      dotDamageFormulas: arrayField(null, []),
      blastRadius: numberField(0),
      // Ch. 07:960 / 07:966 — an explosive's and a molotov's damage is applied *"to the overall
      // body, rather than to a location"*. Opt-in per round because 07:839 leaves a grenade
      // location-silent, so the located pipeline stays defensible there (`T96`, D52).
      overallBody: booleanField(false),
      blastFullDamageWithin: numberField(1),
      // D75 — one switch per round rather than one per effect: a later effect that needs its own
      // answer to walls arrives with its own block and its own field.
      blastThroughWalls: booleanField(false),
      blastZones: numberField(4),
      blastShrapnel: booleanField(false),
      // Empty is ch. 07:839's own answer — full damage across the whole radius — and it is what a
      // round is born with now that the rings are neither offered nor read (owner, 2026-08-11).
      blastMultipliers: arrayField(null, []),
      spreadMode: stringField("single"),
      spreadDistance: numberField(0),
      spreadDamageShort: stringField(""),
      spreadDamageMedium: stringField(""),
      spreadDamageLong: stringField(""),
      spreadWidthShort: numberField(1),
      spreadWidthMedium: numberField(2),
      spreadWidthLong: numberField(3),
      effectTypes: arrayField(null, ["Standard"])
    };
  }

  static migrateData(source) {
    source ??= {};
    normalizeArrayIfPresent(source, "effectTypes", ["Standard"]);
    if (hasOwn(source, "effectTypes")) {
      source.effectTypes = source.effectTypes.map(t => LEGACY_AMMO_EFFECTS[t] ?? t);
    }
    normalizeArrayIfPresent(source, "blastMultipliers", []);
    // The single pre-D85 string becomes one entry per turn rather than a one-element list: an
    // empty tick deals no damage (D87), so a one-element list would silently cut a three-turn
    // fire to one. Skipped once the list exists, which is what keeps a re-read from rebuilding
    // it over the per-tick formulas a GM has since typed.
    if (hasOwn(source, "dotDamageFormula") && !hasOwn(source, "dotDamageFormulas")) {
      const turns = hasOwn(source, "dotTurns") ? Math.floor(Number(source.dotTurns) || 0) : 1;
      source.dotDamageFormulas = Array.from({ length: Math.max(1, turns) },
        () => String(source.dotDamageFormula ?? ""));
    }
    normalizeArrayIfPresent(source, "dotDamageFormulas", []);
    // D108 — the sign flips with the field's meaning. Renamed rather than negated under the old
    // key: `migrateData` runs on every read, so a bare negation would flip again on each one and a
    // round would oscillate. Keyed on the new name being absent, it cannot run twice.
    if (hasOwn(source, "stunSaveMod") && !hasOwn(source, "stunSavePenalty")) {
      source.stunSavePenalty = -(Number(source.stunSaveMod) || 0);
    }
    normalizeNumberIfPresent(source, "stunSavePenalty", 0);
    normalizeBooleanIfPresent(source, "stunSaveOnHit", false);
    normalizeBooleanIfPresent(source, "stunIgnoresArmor", false);
    normalizeBooleanIfPresent(source, "dotEnabled", false);
    normalizeBooleanIfPresent(source, "overallBody", false);
    normalizeBooleanIfPresent(source, "blastShrapnel", false);
    normalizeBooleanIfPresent(source, "blastThroughWalls", false);
    normalizeBooleanIfPresent(source, "penHalvesSoft", true);
    normalizeBooleanIfPresent(source, "penHalvesHard", true);
    return super.migrateData(source);
  }
}

export class CyberpunkArmorData extends CyberpunkBaseItemData {
  static defineSchema() {
    return {
      ...commonSchema(),
      coverage: objectField(DEFAULT_COVERAGE),
      encumbrance: numberField(0),
      hard: booleanField(false),
      // Ch. 07:281 — *"√=Edged weapons treat SP as half"*. A separate axis from hardness, not the
      // other end of it: the Flak vest and pants are both √ **and** Hard (`07:273-274`, `:369`).
      // Default false, and unrecognized armour stays soft and un-√ (D54).
      bladeVulnerable: booleanField(false)
    };
  }

  static migrateData(source) {
    source ??= {};
    normalizeBooleanIfPresent(source, "hard", false);
    normalizeBooleanIfPresent(source, "bladeVulnerable", false);
    // Pre-object worlds stored coverage as a covers/doesn't boolean, which carried no SP.
    // Only zones the diff already names are rewritten, so this stays safe on a partial update.
    if (hasOwn(source, "coverage") && source.coverage && typeof source.coverage === "object") {
      for (const [zone, value] of Object.entries(source.coverage)) {
        if (typeof value === "boolean") source.coverage[zone] = { stoppingPower: 0, ablation: 0 };
      }
    }
    return super.migrateData(source);
  }

  prepareBaseData() {
    super.prepareBaseData();
    // Legacy documents can carry a partial branch. migrateData must not repair them: v14 also
    // calls it on update diffs, where filling a sibling zone writes a default over a real value.
    this.coverage = mergeDefaults(this.coverage, DEFAULT_COVERAGE);
  }
}

export class CyberpunkCyberwareData extends CyberpunkBaseItemData {
  static defineSchema() {
    return {
      ...commonSchema(),
      surgCode: stringField(DEFAULT_CYBERWARE.surgCode),
      humanityCost: stringField(DEFAULT_CYBERWARE.humanityCost),
      cyberwareType: stringField(""),
      cyberwareSubtype: stringField(""),
      abbrev: stringField(""),
      humanityLoss: numberField(0),
      MountZone: stringField(""),
      EffectMode: stringField("Permanent"),
      EffectActive: booleanField(false),
      Module: objectField(DEFAULT_CYBERWARE.Module),
      CyberBodyType: objectField(DEFAULT_CYBERWARE.CyberBodyType),
      CyberWorkType: objectField(DEFAULT_CYBERWARE.CyberWorkType),
      slots: numberField(0),
      spaces: numberField(0),
      cwTypeLabel: stringField(""),
      cwSubtypeLabel: stringField(""),
      effectTypes: arrayField(null, ["None"])
    };
  }

  static migrateData(source) {
    source ??= {};
    normalizeNumberIfPresent(source, "humanityLoss", 0);
    normalizeBooleanIfPresent(source, "EffectActive", false);
    normalizeArrayIfPresent(source, "effectTypes", ["None"]);

    if (hasOwn(source, "Module")) {
      normalizeBooleanIfPresent(source.Module, "IsModule", false);
      normalizeNumberIfPresent(source.Module, "SlotsTaken", 0);
    }

    if (hasOwn(source, "CyberWorkType")) {
      const cwt = source.CyberWorkType ?? {};
      if (hasOwn(cwt, "Types") || hasOwn(cwt, "Type")) {
        cwt.Types = normalizeArray(cwt.Types?.length ? cwt.Types : cwt.Type, []);
      }
      normalizeBooleanIfPresent(cwt, "ChipActive", false);
      normalizeNumberIfPresent(cwt, "Encumbrance", 0);
      normalizeNumberIfPresent(cwt, "OptionsAvailable", 0);
      normalizeNumberIfPresent(cwt, "SDP", 0);

      if (hasOwn(cwt, "Weapon")) {
        const weapon = cwt.Weapon ?? {};
        if (hasOwn(weapon, "rangeDamage") && !hasOwn(weapon, "rangeDamages")) {
          weapon.rangeDamages = weapon.rangeDamage;
          delete weapon.rangeDamage;
        }
        if (hasOwn(weapon, "rangeDamages")) weapon.rangeDamages = normalizeRangeDamages(weapon.rangeDamages);
        normalizeBooleanIfPresent(weapon, "ap", false);
        if (REMOVED_ATTACK_TYPES.has(weapon.attackType)) weapon.attackType = "";
        cwt.Weapon = weapon;
      }

      source.CyberWorkType = cwt;
    }

    return super.migrateData(source);
  }
}

export class CyberpunkVehicleData extends CyberpunkBaseItemData {
  static defineSchema() {
    return {
      ...commonSchema(),
      sdp: objectField({ value: 0, max: 0 }),
      sp: numberField(10),
      passengers: numberField(4),
      speed: objectField({ value: 0, max: 0, maneuver: 0, acceleration: 0 }),
      maneuverability: objectField({ value: 0, condition: "" }),
      fuel: objectField({ type: "", efficiency: 0, max: 0, value: 0 })
    };
  }
}

export class CyberpunkMiscData extends CyberpunkBaseItemData {}

function normalizeRangeDamages(value) {
  if (Array.isArray(value)) {
    return mergeDefaults({ pointBlank: value[0] ?? "" }, DEFAULT_RANGE_DAMAGES);
  }
  if (typeof value === "string" || typeof value === "number") {
    return mergeDefaults({ pointBlank: String(value) }, DEFAULT_RANGE_DAMAGES);
  }
  return mergeDefaults(value, DEFAULT_RANGE_DAMAGES);
}
