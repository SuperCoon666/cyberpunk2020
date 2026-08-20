import { DEFAULT_HIT_LOCATIONS, DEFAULT_SDP, DEFAULT_STATS } from "../constants.js";

import {
  arrayField,
  booleanField,
  htmlField,
  mergeDefaults,
  numberField,
  objectField,
  stringField
} from "./schema-helpers.js";

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

class CyberpunkBaseActorData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      // Character identity / lifepath
      points: numberField(75),
      role: objectField({
        value: "rocker",
        choices: ["solo", "rocker", "netrunner", "media", "nomad", "fixer", "cop", "corp", "techie", "medtechie"]
      }),
      age: numberField(35),
      humanity: numberField(50),
      events: stringField(""),
      family: stringField(""),
      style: stringField(""),
      motivations: stringField(""),
      notes: htmlField(""),

      // Core actor data. Kept as ObjectField because the system mutates these
      // structures during prepareData and older worlds may contain legacy shapes.
      stats: objectField(DEFAULT_STATS),
      ip: numberField(0),
      skills: objectField({}),
      hitLocations: objectField(DEFAULT_HIT_LOCATIONS),
      hitLocLookup: objectField({}),
      sdp: objectField(DEFAULT_SDP),
      damage: numberField(0),
      stabilized: booleanField(false),

      // Inventory / UI state
      eurobucks: numberField(0),
      carryWeight: numberField(0),
      skillsSortedBy: stringField("Name"),
      sortedSkillIDs: arrayField(),
      transient: objectField({ skillFilter: "" }),

      // Roll modifiers stored by the current sheet implementation
      // Charges this actor has set down and not yet blown (D83). Kept as loose records for the
      // same reason `activePrograms` is: the entry is a snapshot of a weapon that may be deleted.
      deployedCharges: arrayField(),

      initiativeMod: numberField(0),
      initiativeImplantMod: numberField(0),
      CombatSenseMod: numberField(0),
      stunDeathSaveBonus: numberField(0),
      _cwChecks: objectField({ saveStun: 0 }),

      // Netrunning fields are top-level in the current templates and sheet code.
      // Not a FilePathField: its extension check throws out of DataModel.validate, which fails the
      // whole actor over a decorative deck image and makes the document unavailable.
      icon: stringField(""),
      deckModel: stringField(""),
      interface: numberField(0),
      cpu: numberField(0),
      speed: numberField(0),
      strength: numberField(0),
      dataWall: numberField(0),
      ramMax: numberField(0),
      ramUsed: numberField(0),
      deckType: stringField(""),
      hasElectrodes: booleanField(false),
      hasKeyboard: booleanField(false),
      hasScreen: booleanField(false),
      hasPrinter: booleanField(false),
      hasChipReader: booleanField(false),
      hasVoxBox: booleanField(false),
      hasScanner: booleanField(false),
      hasExtraChip: booleanField(false),
      activePrograms: arrayField()
    };
  }

  static migrateData(source) {
    source ??= {};

    // Foundry v14 also calls TypeDataModel.migrateData for partial update diffs.
    // Therefore this method must only rewrite keys that are present in the
    // source diff. Required full-document defaults come from defineSchema().

    // Some legacy template applications stored nested template wrapper keys.
    if (source.stats?.stats) source.stats = source.stats.stats;
    if (source.hitLocations?.hitLocations) {
      if (!hasOwn(source, "sdp") && source.hitLocations.sdp) source.sdp = source.hitLocations.sdp;
      source.hitLocations = source.hitLocations.hitLocations;
    }
    if (source.gear?.eurobucks !== undefined && !hasOwn(source, "eurobucks")) {
      source.eurobucks = source.gear.eurobucks;
    }
    if (source.netrun) {
      for (const [key, value] of Object.entries(source.netrun)) {
        if (!hasOwn(source, key)) source[key] = value;
      }
    }
    if (source.icon && typeof source.icon === "object") {
      source.icon = source.icon.default ?? "";
    }

    // D224 — the sign flips with the field's meaning: a positive number is now a bonus on a save
    // read under its threshold. Renamed rather than negated under the old key, for the reason D108
    // records on the ammunition's: `migrateData` runs on every read, so a bare negation would flip
    // again on each one and a character would oscillate. Keyed on the new name being absent, it
    // cannot run twice, and an upgrading world keeps the save it was rolling.
    if (hasOwn(source, "StunDeathMod") && !hasOwn(source, "stunDeathSaveBonus")) {
      source.stunDeathSaveBonus = -(Number(source.StunDeathMod) || 0);
    }

    if (hasOwn(source, "skills")) source.skills ??= {};
    if (hasOwn(source, "hitLocLookup")) source.hitLocLookup ??= {};
    if (hasOwn(source, "sortedSkillIDs")) source.sortedSkillIDs = Array.isArray(source.sortedSkillIDs) ? source.sortedSkillIDs : [];
    if (hasOwn(source, "activePrograms")) source.activePrograms = Array.isArray(source.activePrograms) ? source.activePrograms : [];
    if (hasOwn(source, "deployedCharges")) source.deployedCharges = Array.isArray(source.deployedCharges) ? source.deployedCharges : [];
    if (hasOwn(source, "transient")) source.transient = mergeDefaults(source.transient, { skillFilter: "" });
    if (hasOwn(source, "_cwChecks")) source._cwChecks = mergeDefaults(source._cwChecks, { saveStun: 0 });
    if (hasOwn(source, "skillsSortedBy")) source.skillsSortedBy ||= "Name";
    if (hasOwn(source, "icon")) source.icon ??= "";
    if (hasOwn(source, "notes")) source.notes ??= "";

    return super.migrateData(source);
  }

  prepareBaseData() {
    super.prepareBaseData();
    // Legacy documents can carry a partial branch. migrateData must not repair them: v14 also
    // calls it on update diffs, where filling a sibling writes a default over a real value.
    this.stats = mergeDefaults(this.stats, DEFAULT_STATS);
    this.hitLocations = mergeDefaults(this.hitLocations, DEFAULT_HIT_LOCATIONS);
    this.sdp = mergeDefaults(this.sdp, DEFAULT_SDP);
  }
}

export class CyberpunkCharacterData extends CyberpunkBaseActorData {}
export class CyberpunkNpcData extends CyberpunkBaseActorData {}
