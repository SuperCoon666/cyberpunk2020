import { DEFAULT_HIT_LOCATIONS, DEFAULT_SDP, DEFAULT_STATS } from "../constants.js";

import {
  arrayField,
  booleanField,
  clone,
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

      // Inventory / UI state
      eurobucks: numberField(0),
      carryWeight: numberField(0),
      skillsSortedBy: stringField("Name"),
      sortedSkillIDs: arrayField(),
      transient: objectField({ skillFilter: "" }),

      // Roll modifiers stored by the current sheet implementation
      initiativeMod: numberField(0),
      initiativeImplantMod: numberField(0),
      CombatSenseMod: numberField(0),
      StunDeathMod: numberField(0),
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

    if (hasOwn(source, "stats")) source.stats = mergeDefaults(source.stats, DEFAULT_STATS);
    if (hasOwn(source, "hitLocations")) source.hitLocations = mergeDefaults(source.hitLocations, DEFAULT_HIT_LOCATIONS);
    if (hasOwn(source, "sdp")) source.sdp = mergeDefaults(source.sdp, DEFAULT_SDP);
    if (hasOwn(source, "skills")) source.skills ??= {};
    if (hasOwn(source, "hitLocLookup")) source.hitLocLookup ??= {};
    if (hasOwn(source, "sortedSkillIDs")) source.sortedSkillIDs = Array.isArray(source.sortedSkillIDs) ? source.sortedSkillIDs : [];
    if (hasOwn(source, "activePrograms")) source.activePrograms = Array.isArray(source.activePrograms) ? source.activePrograms : [];
    if (hasOwn(source, "transient")) source.transient = mergeDefaults(source.transient, { skillFilter: "" });
    if (hasOwn(source, "_cwChecks")) source._cwChecks = mergeDefaults(source._cwChecks, { saveStun: 0 });
    if (hasOwn(source, "skillsSortedBy")) source.skillsSortedBy ||= "Name";
    if (hasOwn(source, "icon")) source.icon ??= "";
    if (hasOwn(source, "notes")) source.notes ??= "";

    return super.migrateData(source);
  }

  prepareBaseData() {
    super.prepareBaseData();
    this.stats ??= clone(DEFAULT_STATS);
    this.hitLocations ??= clone(DEFAULT_HIT_LOCATIONS);
    this.sdp ??= clone(DEFAULT_SDP);
  }
}

export class CyberpunkCharacterData extends CyberpunkBaseActorData {}
export class CyberpunkNpcData extends CyberpunkBaseActorData {}
