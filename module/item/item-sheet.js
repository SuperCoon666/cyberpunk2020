import { weaponTypes, meleeAttackTypes, rangedAttackTypes, attackSkills, concealability, availability, reliability, getStatNames, programTypes, effectiveRange, AMMO_ROUNDS_PER_BOX } from "../lookups.js";
import { formulaHasDice } from "../dice.js";
import { deleteFieldUpdate, localize, localizeParam, localizeParamEscaped, cwHasType, getSkillIndex, zeroEmptyNumberFields } from "../utils.js";
import { createCyberpunkChatMessage, getHtmlElement, getPublicMessageMode, getRichEditorHTML, saveRichEditorHTML, rollToCyberpunkChatMessage } from "../compat.js";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ItemSheetV2 } = foundry.applications.sheets;
const { Tabs } = foundry.applications.ux;

/**
 * D87 — the longest burn that can be *typed* on an ammunition sheet. An approved limit on the
 * input, not a refusal of data: a document authored with more ticks is honoured at tick time.
 */
const MAX_DOT_TICKS = 10;

/**
 * D172/D174 — the armour-piercing family. Three ways to write "this round gets through armour", of
 * which a round carries one: the criterion is D71's *"do these two get in each other's way"*, and
 * each of the three replaces the same arithmetic in `resolveHit`.
 */
const AP_FAMILY_EFFECTS = new Set(["AP", "Slug", "Mono"]);

/**
 * Ch. 07's own numbers for the two carriers that have any to author, written when the effect is
 * **selected**: stock is the book's round and the GM edits from there (owner, 2026-08-22).
 *
 * This cannot be a schema default, which is the whole reason it exists: one pair of fields serves
 * both effects, and `07:867` exempts a finned slug's hard-armour penetration from the halving
 * `07:460` applies to both — one differing value, and no default can hold two.
 *
 * Mono is deliberately absent: `07:1065` states its fractions itself, so its block has no fields.
 */
const AP_FAMILY_STOCK = {
  AP: { armorMultSoft: 0.5, armorMultHard: 0.5, penDamageDivisor: 2,
    penHalvesSoft: true, penHalvesHard: true },
  Slug: { armorMultSoft: 0.5, armorMultHard: 0.5, penDamageDivisor: 2,
    penHalvesSoft: true, penHalvesHard: false }
};

/** @extends {foundry.applications.sheets.ItemSheetV2} */
export class CyberpunkItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["cyberpunk", "sheet", "item", "flexcol"],
    tag: "form",
    position: {
      width: 520,
      height: 480
    },
    window: {
      resizable: true
    },
    form: {
      submitOnChange: true,
      closeOnSubmit: false
    }
  };

  /** @override */
  static PARTS = {
    form: {
      template: "systems/cyberpunk2020/templates/item/item-sheet.hbs"
    }
  };

  /**
   * Kept empty while the item sheet still uses the legacy monolithic template.
   * Tabs are bound manually in _cpActivateTabs().
   */
  static TABS = {};

  /** @override */
  async _prepareContext(options) {
    const data = await super._prepareContext(options);

    data.item = this.item;
    data.system = this.item.system;
    data.owner = this.item.isOwner;
    data.editable = this.isEditable;
    data.cssClass = ["cyberpunk", "sheet", "item"].join(" ");
    data.notesEditing = this._cpNotesEditing ?? false;
    data.isGM = game.user.isGM;
    data.canEditCyberwareHumanity = game.user.isGM
      || game.settings.get("cyberpunk2020", "playersCanEditCyberwareHumanity");

    switch (this.item.type) {
      case "weapon":
        this._prepareWeapon(data);
        break;

      case "armor":
        this._prepareArmor(data);
        break;

      case "skill":
        this._prepareSkill(data);
        break;

      case "cyberware":
        await this._prepareCyberware(data);
        break;

      case "ammo":
        this._prepareAmmo(data);
        break;

      case "program":
        data.programTypes = programTypes;
        break;

      default:
        break;
    }

    return data;
  }

  _prepareSkill(sheet) {
    sheet.stats = getStatNames();
  }

  _prepareAmmo(sheet) {
    const sys = this.item?.system ?? {};
    const updates = {};
    const setIfMissing = (key, value) => {
      if (sys[key] === null || sys[key] === undefined) updates[`system.${key}`] = value;
    };
    setIfMissing("quantity", 0);

    setIfMissing("armorMultSoft", 1);
    setIfMissing("armorMultHard", 1);
    setIfMissing("rawDamageMult", 1);
    setIfMissing("penDamageDivisor", 1);
    setIfMissing("bonusDamageFormula", "");
    setIfMissing("accuracyMod", 0);

    setIfMissing("stunSaveOnHit", false);
    setIfMissing("stunSavePenalty", 0);
    setIfMissing("stunIgnoresArmor", false);

    setIfMissing("dotEnabled", false);
    setIfMissing("dotTurns", 0);

    setIfMissing("blastRadius", 0);
    setIfMissing("blastZones", 4);
    setIfMissing("blastShrapnel", false);
    setIfMissing("blastFullDamageWithin", 1);

    const zones = Math.max(1, Math.min(10, Number(sys.blastZones ?? 4)));

    const defaultMult = (i) => 1 / (2 ** (i + 1));
    if (Array.isArray(sys.blastMultipliers) && sys.blastMultipliers.length && Number(sys.blastMultipliers[0]) === 1) {
      const fixed = sys.blastMultipliers.slice(1);

      while (fixed.length < zones) fixed.push(defaultMult(fixed.length));
      fixed.length = zones;

      updates["system.blastMultipliers"] = fixed;
    }

    if (!sys.blastMultipliers) {
      updates["system.blastMultipliers"] = Array.from({ length: zones }, (_, i) => defaultMult(i));
    } else if (!Array.isArray(sys.blastMultipliers)) {
      const obj = sys.blastMultipliers;
      const arr = Array.from({ length: zones }, (_, i) => {
        const raw = obj[i] ?? obj[String(i)];
        const n = Number(String(raw ?? "").replace(",", "."));
        return Number.isFinite(n) ? n : defaultMult(i);
      });
      updates["system.blastMultipliers"] = arr;
    } else {
      let cur = sys.blastMultipliers.slice();

      if (cur.length && Number(cur[0]) === 1) cur.shift();

      cur = cur.slice(0, zones).map((v, i) => {
        const n = Number(String(v ?? "").replace(",", "."));
        return Number.isFinite(n) ? n : defaultMult(i);
      });

      while (cur.length < zones) cur.push(defaultMult(cur.length));

      const prev = sys.blastMultipliers;
      const changed =
        cur.length !== prev.length ||
        cur.some((v, i) => v !== prev[i]);

      if (changed) {
        updates["system.blastMultipliers"] = cur;
      }
    }

    setIfMissing("spreadMode", "single");
    setIfMissing("spreadDistance", 0);
    setIfMissing("spreadDamageShort", "");
    setIfMissing("spreadDamageMedium", "");
    setIfMissing("spreadDamageLong", "");
    setIfMissing("spreadWidthShort", 1);
    setIfMissing("spreadWidthMedium", 2);
    setIfMissing("spreadWidthLong", 3);

    if (Object.keys(updates).length) {
      this.item.updateSource(updates);
      sheet.system = this.item.system;
    }

    // Weapon type (category of weapon for which the ammunition is intended)
    sheet.ammoReloadTypes = [
      // Bullet weapons.
      "AmmoReloadLightPistolSMG",
      "AmmoReloadMediumPistolSMG",
      "AmmoReloadHeavyPistolSMG",
      "AmmoReloadVeryHeavyPistol",
      "AmmoReloadAssaultRifle",
      "AmmoReloadShotgun",

      // Individual categories
      "AmmoWeaponArrows",
      "AmmoWeaponCrossbowQuarrels",
      "AmmoWeaponAirguns",
      "AmmoWeaponPaintloads",
      "AmmoReloadNeedlegunRounds",
      "AmmoReload20mmCannonRound",
      "AmmoWeaponGauss",
      "AmmoReloadFlamethrower",

      // D96 — one reload type for everything thrown; the rounds are told apart by their
      // effects, not by the type, and every thrown weapon still loads its own document.
      "AmmoReloadThrown",
      "AmmoReloadGrenades",
      "AmmoReloadRockets",
      "AmmoReloadOther"
    ];

    // Boxes are display-only: the stored total is what reload spends, so a box count is a division
    // of it and the remainder is the box that has been opened.
    // Clamped so that "a box size exists" is one expression: the template disables the counter on
    // this same value, and a negative size must not leave it live with nothing to divide by.
    const perBox = Math.max(0, Number(sheet.system?.perBox ?? 0));
    const quantity = Number(sheet.system?.quantity ?? 0);
    sheet.ammoPack = {
      perBox,
      boxes: perBox ? Math.floor(quantity / perBox) : 0,
      loose: perBox ? quantity % perBox : 0
    };

    // Blast zones selector options
    sheet.blastZonesOptions = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => {
        const n = i + 1;
        return [n, n];
      })
    );

    // D87 — the burn shows exactly as many damage inputs as the entered turn count, no spares.
    // Nothing is written back for them: the list is padded by the handler that persists a tick, so
    // a document carrying more ticks than can be typed keeps every one of them.
    sheet.dotTickIndices = Array.from(
      { length: Math.min(MAX_DOT_TICKS, Math.max(0, Math.floor(Number(sys.dotTurns) || 0))) },
      (_, i) => i
    );

    // Indices for rendering multiplier inputs dynamically
    sheet.blastMultiplierIndices = Array.from(
      { length: Math.max(1, Math.min(10, Number(this.item.system?.blastZones ?? 4))) },
      (_, i) => i
    );

    // Spread mode selector (Single / Spread)
    sheet.ammoSpreadModes = [
      { value: "single", localKey: "AmmoSpreadModeSingle" },
      { value: "spread", localKey: "AmmoSpreadModeSpread" }
    ];

    const effectTypes = Array.isArray(sys.effectTypes)
      ? sys.effectTypes
      : (sys.effectTypes ? [sys.effectTypes] : ["Standard"]);

    // The stock rounds a GM builds (D52), not the mechanisms behind them. `migrateData` renames a
    // world's existing values into these, so nothing here has to answer for the old spellings.
    const effectKeyMap = {
      Standard: "AmmoEffect_Standard",
      AP: "AmmoEffect_AP",
      Slug: "AmmoEffect_Slug",
      Mono: "AmmoEffect_Mono",
      Electroshock: "AmmoEffect_Electroshock",
      Incendiary: "AmmoEffect_Incendiary",
      Buckshot: "AmmoEffect_Buckshot",
      Blast: "AmmoEffect_Blast",
      DamageReplace: "AmmoEffect_DamageReplace"
    };

    sheet.ammoFx = {
      typeLabels: (effectTypes.length ? effectTypes : ["Standard"])
        .map(t => localize(effectKeyMap[t] ?? "AmmoEffect_Standard"))
    };
  }

  _prepareWeapon(sheet) {
    sheet.weaponTypes = Object.values(weaponTypes).sort();
    const isMelee = this.item.system.weaponType === weaponTypes.melee;
    sheet.isMelee = isMelee;
    sheet.attackTypes = isMelee ? Object.values(meleeAttackTypes).sort() : Object.values(rangedAttackTypes).sort();
    sheet.concealabilities = Object.values(concealability);
    sheet.availabilities = Object.values(availability);
    sheet.reliabilities = Object.values(reliability);

    if (this.item.system?.ammoItemId == null) {
      this.item.updateSource({ "system.ammoItemId": "" });
    }

    sheet.ammoChoices = [];
    const ammoOwner = this.item?.parent;

    if (ammoOwner) {
      const ammoItemsRaw = ammoOwner.itemTypes?.ammo ?? ammoOwner.items.filter(i => i.type === "ammo");
      const ammoItems = ammoItemsRaw.filter(a => a.system?.equipped !== false);
      sheet.ammoChoices = [...ammoItems]
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .map(a => {
          const reloadType = String(a.system?.weaponType ?? "");
          const label = reloadType ? `${a.name} (${localize(reloadType)})` : a.name;
          return { value: a.id, localKey: label };
        });
    }

    const actor = this.item?.parent;
    const wType = this.item.system.weaponType || weaponTypes.pistol;

    // D37/D52 — a thrown weapon's range is the thrower's, so the sheet shows it derived rather
    // than offering the stored number no read site consults (`AB-Q26`).
    sheet.isThrown = wType === weaponTypes.thrown;
    sheet.thrownRange = (sheet.isThrown && actor)
      ? { range: effectiveRange(this.item), body: actor.system.stats.bt.total }
      : null;

    const baseKeys = attackSkills[wType] || [];
    const includeMartials = (wType === weaponTypes.melee) && (this.item.system.attackType === meleeAttackTypes.martial);
    const martialKeys = includeMartials ? (actor?.trainedMartials?.() || []) : [];
    const toAttackSkillChoice = (key) => {
      const martialLabel = actor?.getMartialDisplayName?.(key);
      const localized = localize("Skill" + key);
      return {
        value: key,
        label: martialLabel ?? (localized.includes("Skill") ? key : localized)
      };
    };

    sheet.attackSkills = [...baseKeys, ...martialKeys].map(toAttackSkillChoice);

    if (!sheet.attackSkills.length && actor?.itemTypes?.skill) {
      sheet.attackSkills = actor.itemTypes.skill
        .map(skill => ({ value: skill.name, label: skill.name }))
        .sort((a, b) => String(a.label).localeCompare(String(b.label)));
    }
  }

  _prepareArmor(sheet) {
    
  }

/**
 * Prepares data for the cyberware item sheet template.
 * Gathers option lists, selected values, and labels.
*/
async _prepareCyberware(sheet) {
  const L = (k) => {
    if (game.i18n.has(`CYBERPUNK.${k}`)) return game.i18n.localize(`CYBERPUNK.${k}`);
    if (game.i18n.has(k)) return game.i18n.localize(k);
    return k;
  };

  const sys = this.item?.system ?? {};
  const cwt = sys.CyberWorkType ?? {};
  sheet.cw = sheet.cw ?? {};

  sheet.cw.types = Array.isArray(cwt.Types) && cwt.Types.length
    ? [...cwt.Types]
    : (cwt.Type ? [cwt.Type] : ["Descriptive"]);

  const mapKeyToLoc = (k) => {
    switch (k) {
      case "Descriptive": return game.i18n.localize("CYBERPUNK.CWT_Type_Descriptive");
      case "Characteristic": return game.i18n.localize("CYBERPUNK.CWT_Type_Characteristic");
      case "Armor": return game.i18n.localize("CYBERPUNK.CWT_Type_Armor");
      case "Weapon": return game.i18n.localize("CYBERPUNK.CWT_Type_Weapon");
      case "Implant": return game.i18n.localize("CYBERPUNK.CWT_Type_Implant");
      case "Chip": return game.i18n.localize("CYBERPUNK.CWT_Type_Chip");
      default: return k;
    }
  };
  sheet.cw.typeLabels = sheet.cw.types.map(mapKeyToLoc);

  // Ensure Module exists for bindings
  if (!this.item.system.Module) {
    this.item.updateSource({
      "system.Module": {
        IsModule: false,
        ParentId: "",
        SlotsTaken: 0,
        AllowedParentCyberwareType: ""
      }
    });
  }

  if (this.item.system?.EffectMode == null) {
    this.item.updateSource({ "system.EffectMode": "Permanent" });
  }
  if (this.item.system?.EffectActive == null) {
    this.item.updateSource({ "system.EffectActive": false });
  }

  // Characteristic: stats and checks
  const STAT_KEYS = [
    { key: "int", label: L("IntFull") },
    { key: "ref", label: L("RefFull") },
    { key: "tech", label: L("TechFull") },
    { key: "cool", label: L("CoolFull") },
    { key: "attr", label: L("AttrFull") },
    { key: "luck", label: L("LuckFull") },
    { key: "ma", label: L("MaFull") },
    { key: "bt", label: L("BtFull") },
    { key: "emp", label: L("EmpFull") }
  ];

  const CHECK_KEYS = [
    { key: "Initiative", label: L("CWT_Checks_Initiative") },
    { key: "SaveStun", label: L("CWT_Checks_SaveStun") }
  ];

  const findLabel = (list, key) => list.find((i) => i.key === key)?.label ?? key;

  const statObj = cwt.Stat ?? {};
  sheet.cw.currentStats = Object.keys(statObj).map((k) => ({ key: k, label: findLabel(STAT_KEYS, k) }));
  sheet.cw.statRemain = STAT_KEYS.filter((s) => !(s.key in statObj));

  const checkObj = cwt.Checks ?? {};
  sheet.cw.currentChecks = Object.keys(checkObj).map((k) => ({ key: k, label: findLabel(CHECK_KEYS, k) }));
  sheet.cw.checkRemain = CHECK_KEYS.filter((c) => !(c.key in checkObj));

  // Armor: locations and penalties
  const LOCATION_KEYS = [
    { key: "Head", label: L("Head") },
    { key: "Torso", label: L("Torso") },
    { key: "lArm", label: L("lArm") },
    { key: "rArm", label: L("rArm") },
    { key: "lLeg", label: L("lLeg") },
    { key: "rLeg", label: L("rLeg") }
  ];

  const PENALTY_KEYS = STAT_KEYS;

  const locObj = cwt.Locations ?? {};
  sheet.cw.currentLocations = Object.keys(locObj).map((k) => ({ key: k, label: findLabel(LOCATION_KEYS, k) }));
  sheet.cw.locationRemain = LOCATION_KEYS.filter((l) => !(l.key in locObj));

  const penObj = cwt.Penalties ?? {};
  sheet.cw.currentPenalties = Object.keys(penObj).map((k) => ({ key: k, label: findLabel(PENALTY_KEYS, k) }));
  sheet.cw.penaltyRemain = PENALTY_KEYS.filter((p) => !(p.key in penObj));

  // Skills:
  // - If we have an Actor: use Actor's embedded skill Items (supports custom skills).
  // - If there is no Actor (e.g. compendium/world item): load skills from locale compendiums.
  // IMPORTANT: store selected skills in implants by Skill Item _id (stable across localizations).
  const actorSkills = this.actor?.itemTypes?.skill ?? [];
  const skillsList = actorSkills.length
    ? actorSkills.map((s) => ({ id: s.id, name: s.name }))
    : await getSkillIndex(game.i18n.lang);

  skillsList.sort((a, b) => a.name.localeCompare(b.name));

  sheet.cw.skillOptions = skillsList.map((s) => s.name);
  sheet.cw.hasActor = !!this.actor;

  // Maps used by sheet interaction handlers (name -> id) and for display (id -> name).
  this._cwSkillNameToId = new Map(skillsList.map((s) => [s.name, s.id]));
  this._cwSkillIdToName = new Map(skillsList.map((s) => [s.id, s.name]));

  const resolveSkillLabel = (key) => {
    // Prefer actor's current localized name, if actor has the skill
    const byId = this.actor?.items?.get(key);
    if (byId?.type === "skill") return byId.name;
    // Otherwise resolve via compendium index for current UI language
    return this._cwSkillIdToName.get(key) || key;
  };

  sheet.cw.currentSkills = Object.keys(cwt.Skill ?? {})
    .map((k) => ({ key: k, label: resolveSkillLabel(k) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  sheet.cw.currentChipSkills = Object.keys(cwt.ChipSkills ?? {})
    .map((k) => ({ key: k, label: resolveSkillLabel(k) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  // Weapon options: from the actor's inventory or from Items
  if (this.actor) {
    sheet.cw.weaponOptions = (this.actor.itemTypes.weapon ?? [])
      .map((w) => ({ id: w.id, name: w.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } else {
    const allItems = Array.from(game.items ?? []);
    sheet.cw.weaponOptions = allItems
      .filter((i) => i.type === "weapon")
      .map((w) => ({ id: w.id, name: w.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Implant: allowed installation slot
  const bodyAll = [
    { key: "Head", label: L("Head") },
    { key: "Torso", label: L("Torso") },
    { key: "Arm", label: L("Arm") },
    { key: "Leg", label: L("Leg") },
    { key: "Nervous", label: L("Nervous") },
    { key: "Chip", label: L("Chip") }
  ];
  sheet.cw.bodyZones = bodyAll;

  sheet.weaponTypes = Object.values(weaponTypes).sort();
  const cwW = this.item.system?.CyberWorkType?.Weapon || {};
  const isMelee = cwW.weaponType === weaponTypes.melee;
  sheet.cwWeaponIsMelee = isMelee;
  sheet.attackTypes = isMelee ? Object.values(meleeAttackTypes).sort() : Object.values(rangedAttackTypes).sort();
  sheet.concealabilities = Object.values(concealability);
  sheet.availabilities = Object.values(availability);
  sheet.reliabilities = Object.values(reliability);

  if (this.item.system?.CyberWorkType?.Weapon?.ammoItemId == null) {
    this.item.updateSource({ "system.CyberWorkType.Weapon.ammoItemId": "" });
  }

  sheet.cwAmmoChoices = [];
  const ammoOwner = this.actor;

  if (ammoOwner) {
    const ammoItemsRaw = ammoOwner.itemTypes?.ammo ?? ammoOwner.items.filter(i => i.type === "ammo");
    const ammoItems = ammoItemsRaw.filter(a => a.system?.equipped !== false);

    sheet.cwAmmoChoices = [...ammoItems]
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map(a => {
        const reloadType = String(a.system?.weaponType ?? "");
        const label = reloadType ? `${a.name} (${localize(reloadType)})` : a.name;
        return { value: a.id, localKey: label };
      });
  }

  const actor = this.item?.parent;
  const baseKeys = attackSkills[cwW.weaponType || weaponTypes.pistol] || [];
  const includeMartials = isMelee && (cwW.attackType === meleeAttackTypes.martial);
  const martialKeys = includeMartials ? (actor?.trainedMartials?.() || []) : [];
  const toAttackSkillChoice = (key) => {
    const martialLabel = actor?.getMartialDisplayName?.(key);
    const localized = localize("Skill" + key);
    return {
      value: key,
      label: martialLabel ?? (localized.includes("Skill") ? key : localized)
    };
  };

  sheet.attackSkills = [...baseKeys, ...martialKeys].map(toAttackSkillChoice);
  
  if (!sheet.attackSkills.length && this.actor) {
    sheet.attackSkills = (this.actor.itemTypes.skill || [])
      .map(skill => ({ value: skill.name, label: skill.name }))
      .sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }

  const TYPE_CHOICES_BASE = [
    { value: "CyberArm", localKey: "CWT_ImplantType_CyberArm" },
    { value: "CyberLeg", localKey: "CWT_ImplantType_CyberLeg" },
    { value: "CyberAudio", localKey: "CWT_ImplantType_CyberAudio" },
    { value: "CyberOptic", localKey: "CWT_ImplantType_CyberOptic" },
    { value: "CyberTorso", localKey: "CWT_ImplantType_CyberTorso" }
  ];

  const typeAliases = {
    "CYBERARM": "CyberArm",
    "CYBERHAND": "CyberArm",
    "CYBERLEG": "CyberLeg",
    "CYBERFOOT": "CyberLeg",
    "CYBEREAR": "CyberAudio",
    "CYBEROPTIC":"CyberOptic",
    "IMPLANT": "CyberTorso",
    "Arm": "CyberArm", "Leg": "CyberLeg",
    "Ear": "CyberAudio", "Eye": "CyberOptic", "Torso": "CyberTorso"
  };

  const pickType = (t) => {
    if (!t) return null;
    if (typeof t === "string") {
      const k = t.trim();
      return typeAliases[k] || k;
    }
    if (typeof t === "object") {
      const k = (t.key ?? t.value ?? t.name);
      if (typeof k === "string") {
        const s = k.trim();
        return typeAliases[s] || s;
      }
    }
    return null;
  };

    // Only module-capable implant base types (no dynamic extras)
    sheet.cw.parentCwTypeChoices = TYPE_CHOICES_BASE;

      sheet.cw.cyberwareTypeSelected = pickType(this.item.system?.cyberwareType) || "";
    sheet.cw.allowedParentCwTypeSelected =
      pickType(this.item.system?.Module?.AllowedParentCyberwareType) ||
      String(this.item.system?.Module?.AllowedParentCyberwareType || "");

    // Implant: free/taken options with automatic module accounting (only equipped modules count)
    const provided = Number(this.item.system?.CyberWorkType?.OptionsAvailable) || 0;
    let used = 0;
    if (this.actor) {
      const all = this.actor.items?.contents || [];
      const selfId = this.item.id;
      used = all
        .filter(i =>
          i.type === "cyberware" &&
          i.system?.Module?.IsModule &&
          i.system?.Module?.ParentId === selfId &&
          !!i.system?.equipped
        )
        .reduce((sum, m) => sum + (Number(m.system?.Module?.SlotsTaken) || 0), 0);
    }
    sheet.cw.implantSlotsUsed = used;
    sheet.cw.implantSlotsTotal = provided;
    sheet.cw.implantSlotsLeft = Math.max(0, provided - used);

    // Module: implants available on the actor that match the type (only equipped, same zone/side, exclude self)
    const isModule = !!this.item.system?.Module?.IsModule;
    if (isModule && this.actor) {
      const needType = this.item.system?.Module?.AllowedParentCyberwareType || "";
      const all = this.actor.items?.contents || [];

      const zoneOf = (it) => String(it.system?.MountZone || it.system?.CyberBodyType?.Type || "");
      const sideOf = (it) => String(it.system?.CyberBodyType?.Location || "");
      const needZone = zoneOf(this.item);
      const needSide = sideOf(this.item);

      // Count available slots of a candidate implant (only equipped modules count)
      const leftFor = (p) => {
        const provided = Number(p.system?.CyberWorkType?.OptionsAvailable || 0);
        const used = all
          .filter(i =>
            i.type === "cyberware" &&
            i.system?.Module?.IsModule &&
            i.system?.Module?.ParentId === p.id &&
            !!i.system?.equipped
          )
          .reduce((sum, m) => sum + (Number(m.system?.Module?.SlotsTaken) || 0), 0);
        return Math.max(0, provided - used);
      };

      sheet.cw.parentImplants = all
        .filter(i =>
          i.type === "cyberware" &&
          cwHasType(i, "Implant") &&
          i.id !== this.item.id &&
          !!i.system?.equipped &&
          (!needType || pickType(i.system?.cyberwareType) === pickType(needType)) &&
          (zoneOf(i) === needZone) &&
          (needZone === "Arm" || needZone === "Leg" ? (!needSide || sideOf(i) === needSide) : true)
        )
        .map(i => ({ id: i.id, name: i.name, left: leftFor(i) }));
    } else {
      sheet.cw.parentImplants = [];
    }

    // Implant: free/taken options (ONLY equipped modules count)
    if (cwHasType(this.item, "Implant")) {
      const provided = Number(this.item.system?.CyberWorkType?.OptionsAvailable) || 0;
      let used = 0;

      if (this.actor) {
        const all = this.actor.items?.contents || [];
        const selfId = this.item.id;
        used = all.reduce((sum, it) => {
          const mod = it.system?.Module;
          if (
            it.type === "cyberware" &&
            mod?.IsModule &&
            mod?.ParentId === selfId &&
            !!it.system?.equipped
          ) {
            return sum + (Number(mod.SlotsTaken) || 0);
          }
          return sum;
        }, 0);
      }

      sheet.cw.implantSlotsUsed = used;
      sheet.cw.implantSlotsTotal = provided;
      sheet.cw.implantSlotsLeft = Math.max(0, provided - used);
    }
}

  _resolveSkillKey(query) {
    const q = String(query || "").trim();
    if (!q) return null;

    // Allow pasting a skill _id directly
    const byId = this.actor?.items?.get(q);
    if (byId?.type === "skill") return q;
    if (this._cwSkillIdToName?.has(q)) return q;

    // Exact match by displayed name (from prepared option list)
    const idFromName = this._cwSkillNameToId?.get(q);
    if (idFromName) return idFromName;

    // Fallback: exact name match on actor skills (custom skills)
    const skills = this.actor?.itemTypes?.skill || [];
    const exact = skills.find((s) => s.name === q);
    return exact ? exact.id : null;
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);

    const root = getHtmlElement(this.element);
    if (!root) return;

    this._cpActivateTabs(root);
    this._cpActivateItemFilePicker(root);
    this._cpActivateNotesEditor(root);
    this._cpActivateVehicleSpeedControls(root);
    this._cpActivateBasicItemActions(root);
    this._cpActivateCyberwareBasicControls(root);
    this._cpActivateCyberwareMechanicTypeControls(root);
    this._cpActivateCyberwareSkillSearchControls(root);
    this._cpActivateCyberwareStateControls(root);
    this._cpActivateCyberwareWeaponControls(root);
    this._cpActivateAmmoControls(root);
    this._cpActivateWeaponControls(root);
    this._cpActivateSkillItemControls(root);
    this._cpActivateArmorAblationControls(root);
  }

  /** The ablate/repair buttons carry no `name`, so this handler is their only persistence path. */
  _cpActivateArmorAblationControls(root) {
    if (!root?.addEventListener) return;
    if (this.item.type !== "armor" || !this.isEditable) return;

    if (root.dataset.cpAblationBound === "1") return;
    root.dataset.cpAblationBound = "1";

    root.addEventListener("click", async (event) => {
      const button = event.target?.closest?.(".segment-ablate, .segment-repair");
      if (!button || !root.contains(button)) return;

      event.preventDefault();
      event.stopPropagation();

      const zone = button.dataset.hitLoc;
      const cover = this.item.system.coverage?.[zone];
      if (!cover) return;

      const step = button.classList.contains("segment-ablate") ? 1 : -1;
      const sp = Number(cover.stoppingPower) || 0;
      const next = Math.min(sp, Math.max(0, (Number(cover.ablation) || 0) + step));
      if (next === (Number(cover.ablation) || 0)) return;

      await this.item.update({ [`system.coverage.${zone}.ablation`]: next });
    }, true);
  }

  /**
   * The descriptive ammunition type (`T340`). Its box renders through `CPLocal` and therefore holds
   * translated text, so it must stay out of the framework's own submit — the input carries no
   * `name` and this is its only writer. The AP/Mono pair rides the same listener because it needs
   * the same suppression: the framework's submit would persist the box that was clicked and leave
   * the one this refusal clears, which is the combination being refused.
   */
  _cpActivateWeaponControls(root) {
    if (!root?.addEventListener) return;
    if (this.item.type !== "weapon" || !this.isEditable) return;

    if (root.dataset.cpWeaponBound === "1") return;
    root.dataset.cpWeaponBound = "1";

    root.addEventListener("change", async (event) => {
      const input = event.target?.closest?.("input.weapon-ammo-type");
      if (input && root.contains(input)) {
        event.preventDefault();
        event.stopPropagation();

        await this.item.update({ "system.ammoType": input.value });
        return;
      }

      const edge = event.target?.closest?.('input[name="system.ap"], input[name="system.mono"]');
      if (edge && root.contains(edge)) await this._cpHandleWeaponEdgeChange(edge, event, root);
    }, true);
  }

  /**
   * D174 — a melee weapon carries armour-piercing or a mono edge, never both: the two name one
   * property of one blade and `resolveHit` reads them as alternatives, the mono fractions replacing
   * the √ halving rather than stacking with it. Refused at authoring, the way D71's ammunition pairs
   * are, and warned because the box that clears is not the one clicked.
   *
   * D191 — «кибероружие работает по идентичным правилам с обычным», so the cyberware weapon block is the
   * same refusal on a second pair of boxes (`T367`). The sibling is found by swapping the trailing
   * segment rather than by a fixed name, which is what lets one handler serve both surfaces.
   */
  async _cpHandleWeaponEdgeChange(checkbox, event, root) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    const otherName = checkbox.name.endsWith(".ap")
      ? checkbox.name.replace(/\.ap$/, ".mono")
      : checkbox.name.replace(/\.mono$/, ".ap");
    const other = root.querySelector(`input[name="${otherName}"]`);

    const update = { [checkbox.name]: checkbox.checked };
    if (checkbox.checked && other?.checked) {
      other.checked = false;
      update[otherName] = false;
      ui.notifications.warn(localize("WeaponAPMonoExclusive"));
    }

    // No re-render: both boxes render unconditionally on a melee weapon now, so nothing changes
    // shape and a rebuild would only drop focus out of the control just used.
    if (this.item.type === "cyberware") await this._cpUpdateCyberwareDocument(update, { render: false });
    else await this.item.update(update, { render: false });
  }

  /** The header image carries `data-edit="img"`, which ApplicationV2 does not wire up on its own. */
  _cpActivateItemFilePicker(root) {
    if (!root?.addEventListener) return;
    if (!this.isEditable) return;

    if (root.dataset.cpItemFilePickerBound === "1") return;
    root.dataset.cpItemFilePickerBound = "1";

    root.addEventListener("click", (event) => {
      if (!event.target?.closest?.('[data-edit="img"]')) return;

      event.preventDefault();
      event.stopPropagation();

      // position.top/left are undefined until the sheet has been positioned once.
      new foundry.applications.apps.FilePicker.implementation({
        type: "image",
        current: this.item.img || "",
        callback: (path) => this.item.update({ img: path }),
        position: { top: (this.position.top ?? 0) + 40, left: (this.position.left ?? 0) + 10 }
      }).render(true);
    });
  }

  _cpActivateVehicleSpeedControls(root) {
    if (!root?.ownerDocument) return;

    if (this._cpVehicleSpeedRoot && this._cpVehicleSpeedHandler) {
      try {
        this._cpVehicleSpeedRoot.ownerDocument.removeEventListener("click", this._cpVehicleSpeedHandler, true);
      } catch (_) {}
    }

    const handler = async (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const control = target.closest(".accel, .decel");
      if (!control) return;
      if (!root.contains(control)) return;
      if (this.item.type !== "vehicle") return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      const readNumber = (selector, path, fallback = 0) => {
        const input = root.querySelector(selector);
        const raw = input?.value ?? foundry.utils.getProperty(this.item.system, path) ?? fallback;
        const value = Number(String(raw).replace(",", "."));
        return Number.isFinite(value) ? value : fallback;
      };

      const current = readNumber('input[name="system.speed.value"]', "speed.value", 0);
      const acceleration = readNumber('input[name="system.speed.acceleration"]', "speed.acceleration", 0);
      const max = readNumber('input[name="system.speed.max"]', "speed.max", current);

      const direction = control.classList.contains("decel") ? -1 : 1;
      const rawNext = current + (acceleration * direction);
      const upperLimit = Number.isFinite(max) ? max : rawNext;
      const next = Math.max(0, Math.min(rawNext, upperLimit));

      const valueInput = root.querySelector('input[name="system.speed.value"]');
      if (valueInput) valueInput.value = String(next);

      await this.item.update({ "system.speed.value": next }, { render: false });
      await this.render({ force: true });
    };

    root.ownerDocument.addEventListener("click", handler, true);

    this._cpVehicleSpeedRoot = root;
    this._cpVehicleSpeedHandler = handler;
  }

  _cpActivateTabs(root) {
    const nav = root.querySelector(".sheet-tabs");
    const body = root.querySelector(".sheet-body");
    if (!nav || !body) return;

    const activeTab =
      this._cpActiveTab
      ?? nav.querySelector("[data-tab].active")?.dataset.tab
      ?? body.querySelector(".tab.active")?.dataset.tab
      ?? "settings";

    nav.addEventListener("click", async (event) => {
      const target = event.target?.closest?.("[data-tab]");
      if (!target) return;

      const nextTab = target.dataset.tab || "settings";

      if (this._cpNotesEditing && nextTab !== "notes") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        await this._cpExitNotesEditing(root, { render: false });
        this._cpActiveTab = nextTab;

        await this.render({ force: true });
        return;
      }

      this._cpActiveTab = nextTab;
    }, true);

    const tabs = new Tabs({
      navSelector: ".sheet-tabs",
      contentSelector: ".sheet-body",
      initial: activeTab
    });

    tabs.bind(root);
    tabs.activate(activeTab);

    this._cpTabs = tabs;
  }

  /** @override */
  _onPosition(position) {
    super._onPosition(position);

    const root = getHtmlElement(this.element);
    const sheetBody = root?.querySelector?.(".sheet-body");
    if (!sheetBody) return;

    const height = Number(position?.height);
    if (!Number.isFinite(height)) return;

    sheetBody.style.height = `${Math.max(0, height - 192)}px`;
  }

  _cpActivateBasicItemActions(root) {
    if (!root?.addEventListener) return;
    if (root.dataset.cpBasicItemActionsBound === "1") return;

    root.dataset.cpBasicItemActionsBound = "1";

    root.addEventListener("click", async (event) => {
      // ApplicationV2 reuses the frame element across re-renders, so this must be
      // checked per event: gating the binding instead latches the first render's
      // permissions for the life of the window.
      if (!(this.isEditable)) return;

      const target = event.target;
      if (!target?.closest) return;

      const humanityRoll = target.closest(".humanity-cost-roll");
      if (humanityRoll) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        await this._cpRollHumanityCost();
      }
    }, true);
  }

  async _cpRollHumanityCost() {
    if (this.item.type !== "cyberware") return;

    const cyber = this.item;
    const hc = cyber.system?.humanityCost;
    let loss = 0;
    let roll = null;

    if (formulaHasDice(hc)) {
      roll = await new Roll(hc).evaluate();
      loss = roll?.total ? roll.total : 0;
    } else {
      const num = Number(hc);
      loss = Number.isFinite(num) ? num : 0;
    }

    await cyber.update({ "system.humanityLoss": loss });

    const actor = cyber.actor ?? null;
    const speaker = ChatMessage.getSpeaker(actor ? { actor } : {});
    const messageMode = getPublicMessageMode();

    if (roll) {
      await rollToCyberpunkChatMessage(
        roll,
        {
          speaker,
          flavor: game.i18n.format("CYBERPUNK.Chat.HumanityRollFlavor", {
            actor: actor?.name ?? game.user.name,
            item: cyber.name
          })
        },
        { messageMode }
      );

      return;
    }

    await createCyberpunkChatMessage({
      speaker,
      content: localizeParamEscaped("Chat.HumanityLossSet", {
        actor: actor?.name ?? game.user.name,
        item: cyber.name,
        loss
      })
    }, { messageMode });
  }

  _cpRemoveCyberwareBasicListeners() {
    try {
      if (this._cpCyberwareBasicControlsRoot && this._cpCyberwareBasicAddHandler) {
        this._cpCyberwareBasicControlsRoot.removeEventListener("change", this._cpCyberwareBasicAddHandler, true);
      }

      if (this._cpCyberwareBasicControlsRoot && this._cpCyberwareBasicRemoveHandler) {
        this._cpCyberwareBasicControlsRoot.removeEventListener("click", this._cpCyberwareBasicRemoveHandler, true);
      }
    } catch (_) {}

    this._cpCyberwareBasicControlsRoot = null;
    this._cpCyberwareBasicAddHandler = null;
    this._cpCyberwareBasicRemoveHandler = null;
  }

  async _cpUpdateCyberwareDocument(update, { render = true } = {}) {
    const actor = this.item.actor ?? this.actor ?? null;

    if (actor) {
      await actor.updateEmbeddedDocuments("Item", [
        { _id: this.item.id, ...update }
      ], { render: false });
    } else {
      await this.item.update(update, { render: false });
    }

    if (render) {
      await this._cpRenderCyberwareDependentSheets(actor);
    }
  }

  async _cpRenderCyberwareDependentSheets(actor = null) {
    const owner = actor ?? this.item.actor ?? this.actor ?? null;

    await this._cpRenderOpenSheet(owner);
    await this.render({ force: true });
  }

  async _cpSetCyberwarePath(path, value) {
    const update = {};
    foundry.utils.setProperty(update, path, value);
    await this._cpUpdateCyberwareDocument(update);
  }

  async _cpDeleteCyberwarePath(path) {
    await this._cpUpdateCyberwareDocument(deleteFieldUpdate(path));
  }

  _cpActivateCyberwareBasicControls(root) {
    this._cpRemoveCyberwareBasicListeners();

    if (!root?.addEventListener) return;
    if (this.item.type !== "cyberware") return;

    const editable = this.isEditable;
    if (!editable) return;

    const addSelectSelector = [
      "select.cw-add-stat",
      "select.cw-add-check",
      "select.cw-add-location",
      "select.cw-add-penalty"
    ].join(", ");

    const removeControlSelector = [
      ".cw-remove-stat",
      ".cw-remove-check",
      ".cw-remove-skill",
      ".cw-remove-location",
      ".cw-remove-penalty"
    ].join(", ");

    const addHandler = async (event) => {
      const select = event.target?.closest?.(addSelectSelector);
      if (!select || !root.contains(select)) return;

      const key = String(select.value ?? "");
      if (!key) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      try {
        if (select.matches("select.cw-add-stat")) {
          await this._cpSetCyberwarePath(`system.CyberWorkType.Stat.${key}`, 0);
          return;
        }

        if (select.matches("select.cw-add-check")) {
          const checks = foundry.utils.duplicate(this.item.system?.CyberWorkType?.Checks || {});
          if (checks[key] == null) checks[key] = 0;
          await this._cpSetCyberwarePath("system.CyberWorkType.Checks", checks);
          return;
        }

        if (select.matches("select.cw-add-location")) {
          await this._cpSetCyberwarePath(`system.CyberWorkType.Locations.${key}`, 0);
          return;
        }

        if (select.matches("select.cw-add-penalty")) {
          await this._cpSetCyberwarePath(`system.CyberWorkType.Penalties.${key}`, 0);
        }
      } finally {
        select.value = "";
      }
    };

    const removeHandler = async (event) => {
      const control = event.target?.closest?.(removeControlSelector);
      if (!control || !root.contains(control)) return;

      const key = String(control.dataset.key ?? "");
      if (!key) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      if (control.matches(".cw-remove-stat")) {
        await this._cpDeleteCyberwarePath(`system.CyberWorkType.Stat.${key}`);
        return;
      }

      if (control.matches(".cw-remove-check")) {
        await this._cpDeleteCyberwarePath(`system.CyberWorkType.Checks.${key}`);
        return;
      }

      if (control.matches(".cw-remove-skill")) {
        await this._cpDeleteCyberwarePath(`system.CyberWorkType.Skill.${key}`);
        return;
      }

      if (control.matches(".cw-remove-location")) {
        await this._cpDeleteCyberwarePath(`system.CyberWorkType.Locations.${key}`);
        return;
      }

      if (control.matches(".cw-remove-penalty")) {
        await this._cpDeleteCyberwarePath(`system.CyberWorkType.Penalties.${key}`);
      }
    };

    root.addEventListener("change", addHandler, true);
    root.addEventListener("click", removeHandler, true);

    this._cpCyberwareBasicControlsRoot = root;
    this._cpCyberwareBasicAddHandler = addHandler;
    this._cpCyberwareBasicRemoveHandler = removeHandler;
  }

  _cpRemoveCyberwareMechanicTypeListeners() {
    try {
      if (this._cpCyberwareMechanicTypeRoot && this._cpCyberwareMechanicTypeClickHandler) {
        this._cpCyberwareMechanicTypeRoot.removeEventListener("click", this._cpCyberwareMechanicTypeClickHandler, true);
      }

      if (this._cpCyberwareMechanicTypeRoot && this._cpCyberwareMechanicTypeChangeHandler) {
        this._cpCyberwareMechanicTypeRoot.removeEventListener("change", this._cpCyberwareMechanicTypeChangeHandler, true);
      }

      if (this._cpCyberwareMechanicTypeDocument && this._cpCyberwareMechanicTypeDocumentClickHandler) {
        this._cpCyberwareMechanicTypeDocument.removeEventListener("click", this._cpCyberwareMechanicTypeDocumentClickHandler, true);
      }
    } catch (_) {}

    this._cpCyberwareMechanicTypeRoot = null;
    this._cpCyberwareMechanicTypeClickHandler = null;
    this._cpCyberwareMechanicTypeChangeHandler = null;
    this._cpCyberwareMechanicTypeDocument = null;
    this._cpCyberwareMechanicTypeDocumentClickHandler = null;
  }

  _cpActivateCyberwareMechanicTypeControls(root) {
    this._cpRemoveCyberwareMechanicTypeListeners();

    if (!root?.addEventListener) return;
    if (this.item.type !== "cyberware") return;

    const editable = this.isEditable;
    if (!editable) return;

    root.querySelectorAll(".cw-ms").forEach((menuRoot) => {
      menuRoot.closest(".field")?.classList.add("cw-ms-field");
    });

    const clearMenu = (menuRoot) => {
      if (!menuRoot) return;

      menuRoot.classList.remove("open");
      menuRoot.classList.remove("drop-up");
    };

    const closeOpenMenus = (except = null) => {
      root.querySelectorAll(".cw-ms.open").forEach((menuRoot) => {
        if (menuRoot !== except) clearMenu(menuRoot);
      });
    };

    const closeAllMenus = () => {
      root.querySelectorAll(".cw-ms.open").forEach((menuRoot) => clearMenu(menuRoot));
    };

    const updateMenuPlacement = (trigger, menuRoot, menu) => {
      menuRoot.classList.remove("drop-up");

      const view = root.ownerDocument?.defaultView ?? window;
      const viewportHeight = view.innerHeight ?? document.documentElement.clientHeight;
      const scrollRoot = trigger.closest?.(".window-content");
      const scrollRect = scrollRoot?.getBoundingClientRect?.();
      const triggerRect = trigger.getBoundingClientRect();

      const clipTop = Math.max(0, scrollRect?.top ?? 0);
      const clipBottom = Math.min(viewportHeight, scrollRect?.bottom ?? viewportHeight);

      const spaceAbove = triggerRect.top - clipTop;
      const spaceBelow = clipBottom - triggerRect.bottom;
      const menuHeight = Math.min(menu.scrollHeight || 240, 240);

      const dropUp = spaceBelow < menuHeight + 8 && spaceAbove > spaceBelow;
      menuRoot.classList.toggle("drop-up", dropUp);
    };

    const clickHandler = (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const trigger = target.closest(".cw-ms-trigger");
      if (trigger && root.contains(trigger)) {
        const menuRoot = trigger.closest(".cw-ms");
        const menu = menuRoot?.querySelector(".cw-ms-menu");

        if (!menuRoot || !menu) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        const wasOpen = menuRoot.classList.contains("open");

        closeOpenMenus(menuRoot);

        if (wasOpen) {
          clearMenu(menuRoot);
          return;
        }

        menuRoot.classList.add("open");
        updateMenuPlacement(trigger, menuRoot, menu);
        return;
      }

      if (!target.closest(".cw-ms")) {
        closeAllMenus();
      }
    };

    const documentClickHandler = (event) => {
      const target = event.target;
      if (!target?.closest) {
        closeAllMenus();
        return;
      }

      const menuRoot = target.closest(".cw-ms");
      if (menuRoot && root.contains(menuRoot)) return;

      closeAllMenus();
    };

    const changeHandler = async (event) => {
      const input = event.target?.closest?.(".cw-ms-menu input[type='checkbox']");
      if (!input || !root.contains(input)) return;

      const menuRoot = input.closest(".cw-ms");
      if (!menuRoot) return;

      const path = String(menuRoot.dataset.path ?? "");
      if (path !== "system.CyberWorkType.Types") return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      const menu = menuRoot.querySelector(".cw-ms-menu");
      if (!menu) return;

      let next = Array.from(menu.querySelectorAll("input[type='checkbox']:checked"))
        .map((checkbox) => String(checkbox.value || ""))
        .filter(Boolean);

      const changed = String(input.value || "");
      const turnedOn = !!input.checked;

      if (changed === "Descriptive" && turnedOn) {
        next = ["Descriptive"];

        menu.querySelectorAll("input[type='checkbox']").forEach((checkbox) => {
          checkbox.checked = checkbox.value === "Descriptive";
        });
      } else if (turnedOn) {
        const descriptive = menu.querySelector('input[value="Descriptive"]');
        if (descriptive) descriptive.checked = false;

        next = next.filter((value) => value !== "Descriptive");
      }

      if (!next.length) {
        next = ["Descriptive"];

        const descriptive = menu.querySelector('input[value="Descriptive"]');
        if (descriptive) descriptive.checked = true;
      }

      await this._cpSetCyberwarePath("system.CyberWorkType.Types", next);
    };

    root.addEventListener("click", clickHandler, true);
    root.addEventListener("change", changeHandler, true);
    root.ownerDocument.addEventListener("click", documentClickHandler, true);

    this._cpCyberwareMechanicTypeRoot = root;
    this._cpCyberwareMechanicTypeClickHandler = clickHandler;
    this._cpCyberwareMechanicTypeChangeHandler = changeHandler;
    this._cpCyberwareMechanicTypeDocument = root.ownerDocument;
    this._cpCyberwareMechanicTypeDocumentClickHandler = documentClickHandler;
  }

  _cpRemoveCyberwareSkillSearchListeners() {
    try {
      if (this._cpCyberwareSkillSearchRoot && this._cpCyberwareSkillSearchInputHandler) {
        this._cpCyberwareSkillSearchRoot.removeEventListener("input", this._cpCyberwareSkillSearchInputHandler, true);
      }

      if (this._cpCyberwareSkillSearchRoot && this._cpCyberwareSkillSearchChangeHandler) {
        this._cpCyberwareSkillSearchRoot.removeEventListener("change", this._cpCyberwareSkillSearchChangeHandler, true);
      }

      if (this._cpCyberwareSkillSearchRoot && this._cpCyberwareSkillSearchMouseDownHandler) {
        this._cpCyberwareSkillSearchRoot.removeEventListener("mousedown", this._cpCyberwareSkillSearchMouseDownHandler, true);
      }

      if (this._cpCyberwareSkillSearchRoot && this._cpCyberwareSkillSearchClickHandler) {
        this._cpCyberwareSkillSearchRoot.removeEventListener("click", this._cpCyberwareSkillSearchClickHandler, true);
      }
    } catch (_) {}

    this._cpCyberwareSkillSearchRoot = null;
    this._cpCyberwareSkillSearchInputHandler = null;
    this._cpCyberwareSkillSearchChangeHandler = null;
    this._cpCyberwareSkillSearchMouseDownHandler = null;
    this._cpCyberwareSkillSearchClickHandler = null;
  }

  async _cpSyncCyberwareChipSkills() {
    if (typeof this._cp_syncChipLevelsToSkills === "function") {
      await this._cp_syncChipLevelsToSkills();
    }

    if (typeof this._cp_syncActiveFlagsToSkills === "function") {
      await this._cp_syncActiveFlagsToSkills();
    }
  }

  async _cpRenderCyberwareSkillKeySheets(skillKey) {
    const actor = this.item.actor ?? this.actor ?? null;
    if (!actor || !skillKey) return;

    const byId = actor.items.get(skillKey);
    if (byId?.type === "skill") {
      await this._cpRenderOpenSheet(byId);
    }

    // Legacy fallback: older maps may still store localized skill names as keys.
    const byName = actor.items.filter((item) => item.type === "skill" && item.name === skillKey);
    for (const skill of byName) {
      await this._cpRenderOpenSheet(skill);
    }
  }

  async _cpAddCyberwareSkillFromInput(input, pathPrefix, { syncChipSkills = false } = {}) {
    if (!input) return false;

    const rawValue = String(input.value ?? "").trim();
    if (!rawValue) return false;

    const skillKey = this._resolveSkillKey(rawValue);
    if (!skillKey) return false;

    const current = foundry.utils.getProperty(this.item.system, pathPrefix.replace(/^system\./, "")) || {};
    if (current[skillKey] != null) {
      input.value = "";
      input.blur();
      return true;
    }

    await this._cpSetCyberwarePath(`${pathPrefix}.${skillKey}`, 0);

    if (syncChipSkills) {
      await this._cpSyncCyberwareChipSkills();
      await this._cpRenderCyberwareSkillKeySheets(skillKey);
      await this._cpRenderCyberwareDependentSheets(this.item.actor ?? this.actor ?? null);
    }

    input.value = "";
    input.blur();

    return true;
  }

  _cpActivateCyberwareSkillSearchControls(root) {
    this._cpRemoveCyberwareSkillSearchListeners();

    if (!root?.addEventListener) return;
    if (this.item.type !== "cyberware") return;

    const editable = this.isEditable;
    if (!editable) return;

    const handleSkillSearch = async (event) => {
      const input = event.target?.closest?.("input[name='cw-skill-search'], input[name='cw-chip-skill-search']");
      if (!input || !root.contains(input)) return;

      const isChipSkillSearch = input.name === "cw-chip-skill-search";
      const pathPrefix = isChipSkillSearch
        ? "system.CyberWorkType.ChipSkills"
        : "system.CyberWorkType.Skill";

      const added = await this._cpAddCyberwareSkillFromInput(input, pathPrefix, {
        syncChipSkills: isChipSkillSearch
      });

      if (!added) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    };

    const handleSkillSearchMouseDown = (event) => {
      const input = event.target?.closest?.("input[name='cw-skill-search'], input[name='cw-chip-skill-search']");
      if (!input || !root.contains(input)) return;
      if (root.ownerDocument.activeElement !== input) return;

      const listId = input.getAttribute("list");
      if (!listId) return;

      event.preventDefault();

      input.removeAttribute("list");
      input.blur();

      setTimeout(() => {
        input.setAttribute("list", listId);
        input.focus();
      }, 150);
    };

    const handleSkillRemove = async (event) => {
      const control = event.target?.closest?.(".cw-remove-chipskill");
      if (!control || !root.contains(control)) return;

      const skillKey = String(control.dataset.key ?? "");
      if (!skillKey) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      await this._cpDeleteCyberwarePath(`system.CyberWorkType.ChipSkills.${skillKey}`);
      await this._cpSyncCyberwareChipSkills();
      await this._cpRenderCyberwareSkillKeySheets(skillKey);
      await this._cpRenderCyberwareDependentSheets(this.item.actor ?? this.actor ?? null);
    };

    root.addEventListener("input", handleSkillSearch, true);
    root.addEventListener("change", handleSkillSearch, true);
    root.addEventListener("mousedown", handleSkillSearchMouseDown, true);
    root.addEventListener("click", handleSkillRemove, true);

    this._cpCyberwareSkillSearchRoot = root;
    this._cpCyberwareSkillSearchInputHandler = handleSkillSearch;
    this._cpCyberwareSkillSearchChangeHandler = handleSkillSearch;
    this._cpCyberwareSkillSearchMouseDownHandler = handleSkillSearchMouseDown;
    this._cpCyberwareSkillSearchClickHandler = handleSkillRemove;
  }

  _cpRemoveCyberwareStateListeners() {
    try {
      if (this._cpCyberwareStateRoot && this._cpCyberwareStateChangeHandler) {
        this._cpCyberwareStateRoot.removeEventListener("change", this._cpCyberwareStateChangeHandler, true);
      }
    } catch (_) {}

    this._cpCyberwareStateRoot = null;
    this._cpCyberwareStateChangeHandler = null;
  }

  async _cpRenderCyberwareChipSkillSheets() {
    const chipSkills = this.item.system?.CyberWorkType?.ChipSkills || {};
    const keys = Object.keys(chipSkills);

    for (const skillKey of keys) {
      await this._cpRenderCyberwareSkillKeySheets(skillKey);
    }
  }

  _cpParseCyberwareNumber(value) {
    const normalized = String(value ?? "").replace(",", ".");
    const n = Number(normalized);
    return Number.isFinite(n) ? n : 0;
  }

  async _cpHandleCyberwareTypeChange(select) {
    const cyberwareType = String(select.value || "");

    let bodyType = "";
    if (cyberwareType === "CyberArm") bodyType = "Arm";
    else if (cyberwareType === "CyberLeg") bodyType = "Leg";
    else if (cyberwareType === "CyberTorso") bodyType = "Torso";
    else if (cyberwareType === "CyberAudio" || cyberwareType === "CyberOptic") bodyType = "Head";

    const update = {
      "system.cyberwareType": cyberwareType,
      "system.CyberBodyType.Type": bodyType
    };

    // `system.MountZone` is the primary mount-zone field; `CyberBodyType.Type` is
    // only its legacy fallback, and every read site resolves
    // `MountZone || CyberBodyType.Type`. Writing the derived zone to the legacy
    // field alone therefore has no effect on any item that has MountZone set --
    // which is every item configured through the current UI. Keep both in step,
    // but only when the type actually implies a zone: an unmapped type must not
    // wipe a zone the user picked by hand.
    if (bodyType) {
      update["system.MountZone"] = bodyType;
    }

    const effectiveZone = bodyType || String(this.item.system?.MountZone || "");
    if (effectiveZone !== "Arm" && effectiveZone !== "Leg") {
      update["system.CyberBodyType.Location"] = "";
    }

    await this._cpUpdateCyberwareDocument(update, { render: false });

    await this._cpRenderCyberwareDependentSheets(this.item.actor ?? this.actor ?? null);
  }

  async _cpHandleCyberwareModuleParentChange(select) {
    await this._cpUpdateCyberwareDocument({
      "system.Module.ParentId": String(select.value || "")
    }, { render: false });

    await this._cpRenderCyberwareDependentSheets(this.item.actor ?? this.actor ?? null);
  }

  async _cpHandleCyberwareModuleSlotsTakenChange(input) {
    const slotsTaken = this._cpParseCyberwareNumber(input.value);

    await this._cpUpdateCyberwareDocument({
      "system.Module.SlotsTaken": slotsTaken
    }, { render: false });

    await this._cpRenderCyberwareDependentSheets(this.item.actor ?? this.actor ?? null);
  }

  async _cpHandleCyberwareModuleIsModuleChange(input) {
    const enabled = !!input.checked;

    const update = {
      "system.Module.IsModule": enabled
    };

    if (!enabled && this.item.system?.Module?.ParentId) {
      update["system.Module.ParentId"] = "";
    }

    await this._cpUpdateCyberwareDocument(update, { render: false });

    await this._cpRenderCyberwareDependentSheets(this.item.actor ?? this.actor ?? null);
  }

  async _cpHandleCyberwareOptionsAvailableChange(input) {
    const optionsAvailable = this._cpParseCyberwareNumber(input.value);

    await this._cpUpdateCyberwareDocument({
      "system.CyberWorkType.OptionsAvailable": optionsAvailable
    }, { render: false });

    await this._cpRenderCyberwareDependentSheets(this.item.actor ?? this.actor ?? null);
  }

  async _cpHandleCyberwareEquippedChange(input) {
    const checked = !!input.checked;
    const isChip = this.item.type === "cyberware" && cwHasType(this.item, "Chip");

    const update = {
      "system.equipped": checked
    };

    if (!checked && isChip) {
      update["system.CyberWorkType.ChipActive"] = false;
    }

    // This handler stops propagation, so the change never reaches the form submit
    // and _processFormData does not run. Reproduce its equip-time side autofill
    // here, or a limb implant would stay side-less and be rejected by the
    // module/parent-implant matcher, which compares sides for Arm and Leg.
    if (checked) {
      const zone = String(
        this.item.system?.MountZone ||
        this.item.system?.CyberBodyType?.Type ||
        ""
      );
      const side = String(this.item.system?.CyberBodyType?.Location || "");
      if ((zone === "Arm" || zone === "Leg") && !side) {
        update["system.CyberBodyType.Location"] = "Left";
      }
    }

    await this._cpUpdateCyberwareDocument(update, { render: false });

    if (!checked && isChip) {
      await this._cpSyncCyberwareChipSkills();
      await this._cpRenderCyberwareChipSkillSheets();
    }

    await this._cpRenderCyberwareDependentSheets(this.item.actor ?? this.actor ?? null);
  }

  async _cpHandleCyberwareChipActiveChange(input) {
    const checked = !!input.checked;
    const prev = !!this.item.system?.CyberWorkType?.ChipActive;

    if (prev === checked) {
      await this.render({ force: true });
      return;
    }

    await this._cpUpdateCyberwareDocument({
      "system.CyberWorkType.ChipActive": checked
    }, { render: false });

    await this._cpSyncCyberwareChipSkills();
    await this._cpRenderCyberwareChipSkillSheets();
    await this._cpRenderCyberwareDependentSheets(this.item.actor ?? this.actor ?? null);
  }

  async _cpHandleCyberwareChipSkillLevelChange(input) {
    const prefix = "system.CyberWorkType.ChipSkills.";
    const skillKey = String(input.name || "").slice(prefix.length);
    if (!skillKey) return;

    const value = this._cpParseSkillNumber(input.value);

    await this._cpUpdateCyberwareDocument({
      [`system.CyberWorkType.ChipSkills.${skillKey}`]: value
    }, { render: false });

    await this._cpSyncCyberwareChipSkills();
    await this._cpRenderCyberwareSkillKeySheets(skillKey);
    await this._cpRenderCyberwareDependentSheets(this.item.actor ?? this.actor ?? null);
  }

  _cpActivateCyberwareStateControls(root) {
    this._cpRemoveCyberwareStateListeners();

    if (!root?.addEventListener) return;
    if (this.item.type !== "cyberware") return;

    const editable = this.isEditable;
    if (!editable) return;

    // `select[name='system.CyberBodyType.Type']` is deliberately absent: no
    // template emits it. The live mount-zone control is
    // `select[name='system.MountZone']`, and it is intentionally left to the form
    // submit -- intercepting it here would stopPropagation() and suppress the only
    // path that persists it. Its side reconciliation lives in _processFormData.
    const stateControlSelector = [
      "select[name='system.cyberwareType']",
      "select[name='system.Module.ParentId']",
      "input[name='system.Module.SlotsTaken']",
      "input[name='system.Module.IsModule']",
      "input[name='system.CyberWorkType.OptionsAvailable']",
      "input[name='system.equipped']",
      "input[name='system.CyberWorkType.ChipActive']",
      "input[name^='system.CyberWorkType.ChipSkills.']"
    ].join(", ");

    const changeHandler = async (event) => {
      const control = event.target?.closest?.(stateControlSelector);
      if (!control || !root.contains(control)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      if (control.name === "system.cyberwareType") {
        await this._cpHandleCyberwareTypeChange(control);
        return;
      }

      if (control.name === "system.Module.ParentId") {
        await this._cpHandleCyberwareModuleParentChange(control);
        return;
      }

      if (control.name === "system.Module.SlotsTaken") {
        await this._cpHandleCyberwareModuleSlotsTakenChange(control);
        return;
      }

      if (control.name === "system.Module.IsModule") {
        await this._cpHandleCyberwareModuleIsModuleChange(control);
        return;
      }

      if (control.name === "system.CyberWorkType.OptionsAvailable") {
        await this._cpHandleCyberwareOptionsAvailableChange(control);
        return;
      }

      if (control.name === "system.equipped") {
        await this._cpHandleCyberwareEquippedChange(control);
        return;
      }

      if (control.name === "system.CyberWorkType.ChipActive") {
        await this._cpHandleCyberwareChipActiveChange(control);
        return;
      }

      if (String(control.name || "").startsWith("system.CyberWorkType.ChipSkills.")) {
        await this._cpHandleCyberwareChipSkillLevelChange(control);
      }
    };

    root.addEventListener("change", changeHandler, true);

    this._cpCyberwareStateRoot = root;
    this._cpCyberwareStateChangeHandler = changeHandler;
  }

  _cpRemoveCyberwareWeaponListeners() {
    try {
      if (this._cpCyberwareWeaponRoot && this._cpCyberwareWeaponChangeHandler) {
        this._cpCyberwareWeaponRoot.removeEventListener("change", this._cpCyberwareWeaponChangeHandler, true);
      }
    } catch (_) {}

    this._cpCyberwareWeaponRoot = null;
    this._cpCyberwareWeaponChangeHandler = null;
  }

  _cpActivateCyberwareWeaponControls(root) {
    this._cpRemoveCyberwareWeaponListeners();

    if (!root?.addEventListener) return;
    if (this.item.type !== "cyberware") return;

    const editable = this.isEditable;
    if (!editable) return;

    // `select.cw-select-weapon` is deliberately absent: no template has emitted it
    // for some time, so both the selector and its handler were unreachable. The
    // cyberware weapon is edited inline instead, and system.CyberWorkType.ItemId
    // has no UI. Do not re-add the branch without also adding the control.
    const weaponControlSelector = "select[name='system.CyberWorkType.Weapon.ammoItemId']";

    const changeHandler = async (event) => {
      // D191 — the AP/Mono pair refuses itself here exactly as it does on the weapon sheet, and
      // this capture handler is then the only persistence path for the two boxes (`T367`).
      const edge = event.target?.closest?.(
        "input[name='system.CyberWorkType.Weapon.ap'], input[name='system.CyberWorkType.Weapon.mono']");
      if (edge && root.contains(edge)) return this._cpHandleWeaponEdgeChange(edge, event, root);

      const control = event.target?.closest?.(weaponControlSelector);
      if (!control || !root.contains(control)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      const ammoItemId = String(control.value ?? "");

      // No re-render: the select already shows the chosen value, and nothing else
      // on this sheet or the actor sheet derives from it. Re-rendering here would
      // rebuild the form and drop focus out of the control the user just used --
      // ApplicationV2 keeps the frame element but replaces its contents.
      await this._cpUpdateCyberwareDocument({
        "system.CyberWorkType.Weapon.ammoItemId": ammoItemId
      }, { render: false });
    };

    root.addEventListener("change", changeHandler, true);

    this._cpCyberwareWeaponRoot = root;
    this._cpCyberwareWeaponChangeHandler = changeHandler;
  }

  _cpRemoveAmmoListeners() {
    try {
      if (this._cpAmmoRoot) {
        this._cpAmmoRoot.removeEventListener("click", this._cpAmmoClickHandler, true);
        this._cpAmmoRoot.removeEventListener("change", this._cpAmmoChangeHandler, true);
      }
    } catch (_) {}

    this._cpAmmoRoot = null;
    this._cpAmmoClickHandler = null;
    this._cpAmmoChangeHandler = null;
  }

  // The effect-type checkboxes and blast-multiplier inputs carry no name attribute,
  // so submitOnChange cannot persist them and these handlers are the only path.
  _cpActivateAmmoControls(root) {
    this._cpRemoveAmmoListeners();

    if (!root?.addEventListener) return;
    if (this.item.type !== "ammo") return;

    const editable = this.isEditable;
    if (!editable) return;

    const clickHandler = (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const trigger = target.closest(".ammo-ms-trigger");
      if (trigger && root.contains(trigger)) {
        const menuRoot = trigger.closest(".ammo-ms");
        if (!menuRoot) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        menuRoot.classList.toggle("open");
        return;
      }

      if (!target.closest(".ammo-ms")) {
        root.querySelectorAll(".ammo-ms.open").forEach((menuRoot) => menuRoot.classList.remove("open"));
      }
    };

    const changeHandler = async (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const checkbox = target.closest(".ammo-ms-menu input[type='checkbox']");
      if (checkbox && root.contains(checkbox)) {
        await this._cpHandleAmmoEffectTypeChange(checkbox, event);
        return;
      }

      const multiplier = target.closest("input.ammo-blast-mult");
      if (multiplier && root.contains(multiplier)) {
        await this._cpHandleAmmoBlastMultiplierChange(multiplier, event);
        return;
      }

      const tick = target.closest("input.ammo-dot-tick");
      if (tick && root.contains(tick)) {
        await this._cpHandleAmmoDotTickChange(tick, event);
        return;
      }

      const pack = target.closest("input.ammo-pack");
      if (pack && root.contains(pack)) {
        await this._cpHandleAmmoPackChange(pack, event);
        return;
      }

      const damageFormula = target.closest('input[name="system.damageFormula"]');
      if (damageFormula && root.contains(damageFormula)) {
        this._cpRefuseAmmoDamageFormula(damageFormula, event);
      }
    };

    root.addEventListener("click", clickHandler, true);
    root.addEventListener("change", changeHandler, true);

    this._cpAmmoRoot = root;
    this._cpAmmoClickHandler = clickHandler;
    this._cpAmmoChangeHandler = changeHandler;
  }

  async _cpHandleAmmoEffectTypeChange(checkbox, event) {
    const menu = checkbox.closest(".ammo-ms-menu");
    if (!menu) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    const boxes = Array.from(menu.querySelectorAll("input[type='checkbox']"));

    // A plain round excludes every real effect, in both directions.
    if (checkbox.value === "Standard" && checkbox.checked) {
      for (const box of boxes) box.checked = box.value === "Standard";
    } else if (checkbox.checked) {
      const plain = boxes.find((box) => box.value === "Standard");
      if (plain) plain.checked = false;
    }

    // D71 — a pattern and a crater are two payloads for one round, and one of them would never be
    // reached: the blast gate returns before any fire mode (`item.js` `__weaponRoll`), so a round
    // carrying both spreads nowhere. Ticking either drops the other; only that direction can make
    // the pair.
    if (checkbox.checked && (checkbox.value === "Buckshot" || checkbox.value === "Blast")) {
      const other = checkbox.value === "Buckshot" ? "Blast" : "Buckshot";
      const box = boxes.find((entry) => entry.value === other);
      if (box) box.checked = false;
    }

    // D172/D174 — AP, Slug and Mono are three carriers of one armour-piercing family, so a round
    // takes one. Warned rather than silently swapped, unlike the pair above: the box that clears is
    // not the one clicked.
    if (checkbox.checked && AP_FAMILY_EFFECTS.has(checkbox.value)) {
      const cleared = boxes.filter((entry) => entry.checked && entry !== checkbox
        && AP_FAMILY_EFFECTS.has(entry.value));
      for (const box of cleared) box.checked = false;
      if (cleared.length) ui.notifications.warn(localize("AmmoAPFamilyExclusive"));
    }

    let next = boxes.filter((box) => box.checked).map((box) => box.value);

    // The schema default and every template guard expect at least ["Standard"].
    if (!next.length) {
      next = ["Standard"];
      const plain = boxes.find((box) => box.value === "Standard");
      if (plain) plain.checked = true;
    }

    const update = { "system.effectTypes": next };

    // The stock profile of the effect just **selected**, so ticking Slug is `07:867`'s round and
    // ticking AP is `07:460`'s. Only on the tick that adds it — a `change` arriving with `checked`
    // true means the box was off a moment ago — so an edit made afterwards stands until the effect
    // is chosen again. Narrows D176 by exactly that much: values are still never rewritten *while*
    // an effect is unticked, but re-selecting one is a fresh choice and returns the book's round.
    const stock = checkbox.checked ? AP_FAMILY_STOCK[checkbox.value] : null;
    if (stock) for (const [key, value] of Object.entries(stock)) update[`system.${key}`] = value;

    // Re-renders on purpose: every substantive section of the template is gated on
    // effectTypes, so the form changes shape.
    await this.item.update(update);
  }

  async _cpHandleAmmoBlastMultiplierChange(input, event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    const index = Number(input.dataset.index);
    if (!Number.isFinite(index)) return;

    const zones = Math.max(1, Math.min(10, Number(this.item.system?.blastZones ?? 4)));
    const defaultMultiplier = (i) => 1 / (2 ** (i + 1));

    let multipliers = this.item.system?.blastMultipliers;
    if (!Array.isArray(multipliers)) {
      multipliers = Array.from({ length: zones }, (_, i) => defaultMultiplier(i));
    } else {
      multipliers = multipliers.slice(0, zones);
      while (multipliers.length < zones) multipliers.push(defaultMultiplier(multipliers.length));
    }

    multipliers[index] = this._cpParseCyberwareNumber(input.value);

    // No re-render: the value lives in the input being edited, so rebuilding the form
    // would only drop focus out of it.
    await this.item.update({ "system.blastMultipliers": multipliers }, { render: false });
  }

  async _cpHandleAmmoDotTickChange(input, event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    const index = Number(input.dataset.index);
    if (!Number.isFinite(index)) return;

    const value = String(input.value ?? "").trim();

    // D128 — refused at authoring, the fire-zone-width style: a native hint, and the write never
    // happens. An empty tick is still valid (D87: nothing to roll, nothing dealt); `Roll.validate`
    // rather than `isRollableFormula` because a rejected keystroke needs no toast on top of the hint.
    input.setCustomValidity("");
    if (value && !Roll.validate(value)) {
      input.setCustomValidity(localizeParam("FormulaInvalid", { formula: value }));
      input.reportValidity();
      return;
    }

    const formulas = Array.isArray(this.item.system?.dotDamageFormulas)
      ? this.item.system.dotDamageFormulas.slice()
      : [];
    // Padded rather than rebuilt to the turn count: a fire authored longer than can be typed keeps
    // its tail, and `startDot` reads the list against the count anyway.
    while (formulas.length <= index) formulas.push("");
    formulas[index] = value;

    // No re-render: the value lives in the input being edited, so rebuilding the form
    // would only drop focus out of it.
    await this.item.update({ "system.dotDamageFormulas": formulas }, { render: false });
  }

  /**
   * D165 — the replacing damage formula is refused at authoring exactly as the burn tick beside it
   * is (D128), because it is rolled at **fire** time and in two fire modes the rounds are spent
   * before the card is awaited (`D.10.9`): an unparseable string threw with the magazine already
   * short (`T335`).
   *
   * The write is not this handler's — the field carries a `name` and `submitOnChange` persists it —
   * so refusing means stopping the event in the capture phase before the framework sees it, and
   * letting a valid one through untouched. An empty formula stays valid: it is how a round says the
   * weapon's own damage is rolled.
   */
  _cpRefuseAmmoDamageFormula(input, event) {
    input.setCustomValidity("");

    const value = String(input.value ?? "").trim();
    if (!value || Roll.validate(value)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    input.setCustomValidity(localizeParam("FormulaInvalid", { formula: value }));
    input.reportValidity();
  }

  async _cpHandleAmmoPackChange(input, event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    const form = input.form;
    const perBox = Number(this.item.system?.perBox ?? 0);
    const read = (part) => Math.max(0,
      parseInt(form?.querySelector(`input.ammo-pack[data-part="${part}"]`)?.value, 10) || 0);
    const total = (read("boxes") * perBox) + read("loose");

    // No re-render: `change` also fires from the spinner arrows, where focus stays in the control
    // and a rebuilt form would end the drag. The other two fields are written by hand instead —
    // and for the total that is not cosmetic, because it carries a name, so the next submit of
    // any other field would post the stale figure back over this one.
    await this.item.update({ "system.quantity": total }, { render: false });
    const totalInput = form?.querySelector('input[name="system.quantity"]');
    if (totalInput) totalInput.value = String(total);
    // The two counters show a zero as their placeholder, the way every editable number on this
    // sheet does; the read-only total prints it, the way its shared widget renders it. Writing
    // the digit into all three is what put a hard zero into the counters after each edit.
    for (const [part, value] of [
      ["boxes", Math.floor(total / perBox)],
      ["loose", total % perBox]
    ]) {
      const el = form?.querySelector(`input.ammo-pack[data-part="${part}"]`);
      if (el) el.value = value === 0 ? "" : String(value);
    }
  }

  _cpActivateSkillItemControls(root) {
    if (!root?.addEventListener) return;
    if (this.item.type !== "skill") return;

    if (this._cpSkillItemControlsRoot && this._cpSkillItemControlsHandler) {
      try {
        this._cpSkillItemControlsRoot.removeEventListener("change", this._cpSkillItemControlsHandler, true);
      } catch (_) {}
    }

    const handler = async (event) => {
      const input = event.target;
      if (!input?.matches?.(
        'input[name="system.level"], input[name="system.chipLevel"], input[name="system.isChipped"]'
      )) return;

      if (!root.contains(input)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      if (input.name === "system.level") {
        await this._cpHandleSkillLevelChange(input);
        return;
      }

      if (input.name === "system.chipLevel") {
        await this._cpHandleSkillChipLevelChange(input);
        return;
      }

      if (input.name === "system.isChipped") {
        await this._cpHandleSkillIsChippedChange(input);
      }
    };

    root.addEventListener("change", handler, true);

    this._cpSkillItemControlsRoot = root;
    this._cpSkillItemControlsHandler = handler;
  }

  _cpParseSkillNumber(value) {
    const n = Number.parseInt(value ?? 0, 10);
    return Number.isFinite(n) ? n : 0;
  }

  async _cpUpdateThisSkill(patch) {
    const actor = this.item.actor ?? this.actor ?? null;

    if (actor) {
      await actor.updateEmbeddedDocuments("Item", [
        { _id: this.item.id, ...patch }
      ], { render: false });
      return;
    }

    await this.item.update(patch, { render: false });
  }

  _cpFindChipsForThisSkill() {
    const actor = this.item.actor ?? this.actor ?? null;
    if (!actor) return [];

    const skillId = this.item.id;
    const skillName = this.item.name;

    return actor.items.filter((item) => {
      if (item.type !== "cyberware") return false;
      if (!cwHasType(item, "Chip")) return false;
      if (item.system?.equipped === false) return false;

      const chipSkills = item.system?.CyberWorkType?.ChipSkills;
      if (!chipSkills) return false;

      return (
        (skillId && Object.prototype.hasOwnProperty.call(chipSkills, skillId)) ||
        Object.prototype.hasOwnProperty.call(chipSkills, skillName)
      );
    });
  }

  _cpIsSheetOpen(sheet) {
    return !!(sheet?.rendered || sheet?.element);
  }

  async _cpRenderOpenSheet(document) {
    const sheet = document?.sheet;
    if (!this._cpIsSheetOpen(sheet)) return;

    await sheet.render({ force: true });
  }

  async _cpRenderSkillRelatedSheets({ actor = null, chips = [] } = {}) {
    await this._cpRenderOpenSheet(actor);

    for (const chip of chips) {
      await this._cpRenderOpenSheet(chip);
    }

    await this.render({ force: true });
  }

  async _cpHandleSkillLevelChange(input) {
    const value = this._cpParseSkillNumber(input.value);
    const prev = Number(this.item.system?.level || 0);

    if (prev !== value) {
      await this._cpUpdateThisSkill({ "system.level": value });
    }

    const actor = this.item.actor ?? this.actor ?? null;

    await this._cpRenderSkillRelatedSheets({ actor });
  }

  async _cpHandleSkillIsChippedChange(input) {
    const checked = !!input.checked;
    const prev = !!this.item.system?.isChipped;

    if (prev === checked) {
      await this.render({ force: true });
      return;
    }

    const actor = this.item.actor ?? this.actor ?? null;
    const chips = this._cpFindChipsForThisSkill();

    if (actor && chips.length) {
      const chipUpdates = chips.map((chip) => ({
        _id: chip.id,
        "system.CyberWorkType.ChipActive": checked
      }));

      await actor.updateEmbeddedDocuments("Item", chipUpdates, { render: false });

      if (typeof this._cp_syncChipLevelsToSkills === "function") {
        await this._cp_syncChipLevelsToSkills();
      }

      if (typeof this._cp_syncActiveFlagsToSkills === "function") {
        await this._cp_syncActiveFlagsToSkills();
      }
    } else {
      await this._cpUpdateThisSkill({
        "system.isChipped": checked,
        ...deleteFieldUpdate("system.chipped")
      });
    }

    await this._cpRenderSkillRelatedSheets({ actor, chips });
  }

  async _cpHandleSkillChipLevelChange(input) {
    const value = this._cpParseSkillNumber(input.value);
    const prev = Number(this.item.system?.chipLevel || 0);

    if (prev !== value) {
      await this._cpUpdateThisSkill({ "system.chipLevel": value });
    }

    const actor = this.item.actor ?? this.actor ?? null;
    const chips = this._cpFindChipsForThisSkill();

    if (actor && chips.length) {
      const skillId = this.item.id;
      const skillName = this.item.name;

      const chipUpdates = chips.map((chip) => {
        const chipSkills = chip.system?.CyberWorkType?.ChipSkills || {};
        const patch = { _id: chip.id };

        if (skillId && Object.prototype.hasOwnProperty.call(chipSkills, skillId)) {
          patch[`system.CyberWorkType.ChipSkills.${skillId}`] = value;
        }

        // Legacy fallback: older data may still store chip skill maps by localized name.
        if (Object.prototype.hasOwnProperty.call(chipSkills, skillName)) {
          patch[`system.CyberWorkType.ChipSkills.${skillName}`] = value;
        }

        return patch;
      }).filter((patch) => Object.keys(patch).length > 1);

      if (chipUpdates.length) {
        await actor.updateEmbeddedDocuments("Item", chipUpdates, { render: false });
      }

      if (typeof this._cp_syncChipLevelsToSkills === "function") {
        await this._cp_syncChipLevelsToSkills();
      }
    }

    await this._cpRenderSkillRelatedSheets({ actor, chips });
  }

  _cpActivateNotesEditor(root) {
    this._cpSetupNotesActions(root);
    this._cpSetupNotesAutosave(root);
  }

  async _cpExitNotesEditing(root, { render = false } = {}) {
    if (!this._cpNotesEditing) return;

    await this._cpFlushNotesAutosave(root, { force: true, serialize: false });
    this._cpNotesEditing = false;

    if (render && this.rendered) {
      await this.render({ force: true });
    }
  }

  _cpSetupNotesActions(root) {
    if (!root?.addEventListener) return;

    if (this._cpNotesActionsRoot && this._cpNotesActionsHandler) {
      try {
        this._cpNotesActionsRoot.removeEventListener("click", this._cpNotesActionsHandler, true);
      } catch (_) {}
    }

    const handler = async (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const editButton = target.closest('[data-action="notes-edit"]');
      if (!editButton) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      this._cpNotesEditing = true;
      await this.render({ force: true });
    };

    root.addEventListener("click", handler, true);

    this._cpNotesActionsRoot = root;
    this._cpNotesActionsHandler = handler;
  }

  _cpSetupNotesAutosave(root) {
    if (!root?.addEventListener) return;

    const editable = this.isEditable;
    if (!editable) return;

    if (!this._cpNotesAutosaveState) {
      this._cpNotesAutosaveState = {
        saving: false,
        pending: false,
        pendingForce: false,
        pendingSerialize: false,
        timer: null,
        lastSaved: String(this.item.system?.notes ?? "")
      };
    }

    if (this._cpNotesAutosaveRoot && this._cpNotesAutosaveHandler) {
      for (const eventName of ["save", "input", "change", "close"]) {
        try {
          this._cpNotesAutosaveRoot.removeEventListener(eventName, this._cpNotesAutosaveHandler, true);
        } catch (_) {}
      }
    }

    const isNotesEvent = (event) => {
      const target = event?.target;
      if (!target?.closest) return false;

      const editor = target.closest(".cp-notes-editor");
      if (!editor) return false;

      const notesTab = target.closest('.tab[data-tab="notes"]');
      return !!notesTab;
    };

    const scheduleFlush = ({ force = false, serialize = false, delay = 250 } = {}) => {
      const state = this._cpNotesAutosaveState;
      if (!state) return;

      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }

      state.timer = setTimeout(() => {
        state.timer = null;
        this._cpFlushNotesAutosave(root, { force, serialize });
      }, delay);
    };

    const handler = (event) => {
      if (!isNotesEvent(event)) return;

      if (event.type === "save" || event.type === "close") {
        window.setTimeout(async () => {
          await this._cpFlushNotesAutosave(root, { force: true, serialize: false });

          if (this._cpNotesEditing) {
            this._cpNotesEditing = false;
            await this.render({ force: true });
          }
        }, 0);

        return;
      }

      scheduleFlush({ force: false, serialize: false, delay: 350 });
    };

    for (const eventName of ["save", "input", "change", "close"]) {
      root.addEventListener(eventName, handler, true);
    }

    this._cpNotesAutosaveRoot = root;
    this._cpNotesAutosaveHandler = handler;
  }

  _cpReadNotesHTML(root, { serialize = false } = {}) {
    if (!root) return null;

    const reader = serialize ? saveRichEditorHTML : getRichEditorHTML;
    const html = reader(this, root, "system.notes", [".cp-notes-view"]);

    if (html != null) return html;

    return String(this.item.system?.notes ?? "");
  }

  async _cpFlushNotesAutosave(root, { force = false, serialize = false } = {}) {
    const st = this._cpNotesAutosaveState;
    if (!st) return;

    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }

    if (st.saving) {
      st.pending = true;
      st.pendingForce = st.pendingForce || force;
      st.pendingSerialize = st.pendingSerialize || serialize;
      return;
    }

    const html = this._cpReadNotesHTML(root, { serialize });
    if (html == null) return;
    // force bypasses the debounce, not the "nothing changed" test — _preClose forces on every
    // close, and without this an untouched sheet writes and broadcasts on the way out.
    // Trimmed: the view element carries the template's indentation, which HTMLField strips on
    // write, so the untrimmed strings never compare equal even when nothing changed.
    if (html.trim() === String(this.item.system.notes ?? "").trim()) return;
    if (!force && st.lastSaved === html) return;

    st.saving = true;
    try {
      await this.item.update({ "system.notes": html }, { render: false });
      st.lastSaved = html;
    } catch (err) {
      console.warn("CP2020: item notes save failed", err);
    } finally {
      st.saving = false;

      if (st.pending) {
        const pendingForce = st.pendingForce;
        const pendingSerialize = st.pendingSerialize;

        st.pending = false;
        st.pendingForce = false;
        st.pendingSerialize = false;

        await this._cpFlushNotesAutosave(root, {
          force: pendingForce,
          serialize: pendingSerialize
        });
      }
    }
  }

  /** @override */
  async _preClose(options) {
    try {
      const root = getHtmlElement(this.element);

      if (this._cpNotesAutosaveState?.timer) {
        clearTimeout(this._cpNotesAutosaveState.timer);
        this._cpNotesAutosaveState.timer = null;
      }

      await this._cpFlushNotesAutosave(root, { force: true, serialize: false });
      this._cpNotesEditing = false;
    } catch (_) {}

    try {
      if (this._cpNotesAutosaveRoot && this._cpNotesAutosaveHandler) {
        for (const eventName of ["save", "input", "change", "close"]) {
          this._cpNotesAutosaveRoot.removeEventListener(eventName, this._cpNotesAutosaveHandler, true);
        }
      }

      this._cpNotesAutosaveRoot = null;
      this._cpNotesAutosaveHandler = null;
    } catch (_) {}

    try {
      if (this._cpNotesActionsRoot && this._cpNotesActionsHandler) {
        this._cpNotesActionsRoot.removeEventListener("click", this._cpNotesActionsHandler, true);
      }

      this._cpNotesActionsRoot = null;
      this._cpNotesActionsHandler = null;
    } catch (_) {}

    try {
      if (this._cpVehicleSpeedRoot && this._cpVehicleSpeedHandler) {
        this._cpVehicleSpeedRoot.ownerDocument.removeEventListener("click", this._cpVehicleSpeedHandler, true);
      }

      this._cpVehicleSpeedRoot = null;
      this._cpVehicleSpeedHandler = null;
    } catch (_) {}

    try {
      this._cpRemoveCyberwareBasicListeners();
    } catch (_) {}

    try {
      this._cpRemoveCyberwareMechanicTypeListeners();
    } catch (_) {}

    try {
      this._cpRemoveCyberwareSkillSearchListeners();
    } catch (_) {}

    try {
      this._cpRemoveCyberwareStateListeners();
    } catch (_) {}

    try {
      this._cpRemoveCyberwareWeaponListeners();
    } catch (_) {}

    try {
      this._cpRemoveAmmoListeners();
    } catch (_) {}

    try {
      if (this._cpSkillItemControlsRoot && this._cpSkillItemControlsHandler) {
        this._cpSkillItemControlsRoot.removeEventListener("change", this._cpSkillItemControlsHandler, true);
      }

      this._cpSkillItemControlsRoot = null;
      this._cpSkillItemControlsHandler = null;
    } catch (_) {}

    return super._preClose(options);
  }

  /** @override */
  _processFormData(event, form, formData) {
    const data = zeroEmptyNumberFields(form, super._processFormData(event, form, formData));

    if (this.item.type === "cyberware") {
      const pickLastString = (v) => {
        if (Array.isArray(v)) return v.length ? String(v[v.length - 1] ?? "") : "";
        return v == null ? "" : String(v);
      };
      const t = foundry.utils.getProperty(data, "system.cyberwareType");
      if (t !== undefined) {
        foundry.utils.setProperty(data, "system.cyberwareType", pickLastString(t));
      }

      const ap = foundry.utils.getProperty(data, "system.Module.AllowedParentCyberwareType");
      if (ap !== undefined) {
        foundry.utils.setProperty(data, "system.Module.AllowedParentCyberwareType", pickLastString(ap));
      }

      const slots = foundry.utils.getProperty(data, "system.Module.SlotsTaken");
      if (slots !== undefined) {
        const n = Number(slots);
        foundry.utils.setProperty(data, "system.Module.SlotsTaken", Number.isFinite(n) ? n : 0);
      }
    }

    if (this.item.type === "ammo") {
      // D87 — an approved cap on the entered turn count. It lands here rather than on the input,
      // because the shared number widget emits `data-max`, which only ModifiersDialog reads.
      //
      // D153 — the ceiling is on the field, not the form: `submitOnChange` serializes the whole
      // form, so clamping whatever arrives truncated a round authored past the cap (through the
      // API or a pack — no sheet can type it) on an edit that never touched the turn count
      // (`T286`). A submit that did not change it entered nothing.
      const turns = foundry.utils.getProperty(data, "system.dotTurns");
      if (turns !== undefined) {
        const n = Math.floor(Number(turns) || 0);
        const stored = Math.floor(Number(this.item.system.dotTurns) || 0);
        if (n !== stored) {
          foundry.utils.setProperty(data, "system.dotTurns", Math.min(MAX_DOT_TICKS, Math.max(0, n)));
        }
      }
    }

    if (this.item.type === "skill") {
      const fixNum = v => {
        const n = parseInt(v ?? 0, 10);
        return isNaN(n) ? 0 : n;
      };

      // A submit carries the whole form (`FormDataExtended` over `form`,
      // `client/applications/api/application.mjs:2134-2139`, 14.365.0) — but only what the form
      // actually holds: an input that is unrendered, unnamed or disabled is not in it. So write
      // these two only where they arrived, or a submit from a sheet that does not carry one of them
      // would create it as 0 and overwrite the stored level.
      if (foundry.utils.hasProperty(data, "system.level")) {
        foundry.utils.setProperty(data, "system.level", fixNum(foundry.utils.getProperty(data, "system.level")));
      }
      if (foundry.utils.hasProperty(data, "system.chipLevel")) {
        foundry.utils.setProperty(data, "system.chipLevel", fixNum(foundry.utils.getProperty(data, "system.chipLevel")));
      }
    }

    if (this.item.type === "ammo") {
      // Picking a reload type seeds the box size from the rules table, but only on the change
      // itself and only while there is no size: a number already on screen is the player's, and a
      // submit of some other field must not put a cleared size back.
      const reloadType = foundry.utils.getProperty(data, "system.weaponType");
      const changedType = reloadType && reloadType !== this.item.system.weaponType;
      if (changedType && !this.item.system.perBox && AMMO_ROUNDS_PER_BOX[reloadType]) {
        foundry.utils.setProperty(data, "system.perBox", AMMO_ROUNDS_PER_BOX[reloadType]);
      }
    }

    const legacy = foundry.utils.getProperty(data, "system.chipped");
    if (legacy !== undefined) {
      foundry.utils.setProperty(data, "system.isChipped", !!legacy);
      if (data.system && "chipped" in data.system) delete data.system.chipped;
    }

    if (this.item.type === "cyberware") {
      // Changing the mount zone must reconcile the left/right side. Only Arm and
      // Leg have sides, so any other zone has to clear it -- otherwise a limb
      // implant moved to the head keeps a stale "Left"/"Right", which is still
      // consumed by CyberpunkActor#_prepareCharacterData and, worse, makes the
      // module/parent-implant matcher reject the item because that matcher
      // compares sides for Arm and Leg.
      const submittedZone = foundry.utils.getProperty(data, "system.MountZone");
      if (submittedZone !== undefined) {
        const newZone = String(submittedZone || "");
        if (newZone !== "Arm" && newZone !== "Leg") {
          foundry.utils.setProperty(data, "system.CyberBodyType.Location", "");
        }
      }

      const equip = foundry.utils.getProperty(data, "system.equipped");
      if (equip === true) {
        const zone = String(
          foundry.utils.getProperty(data, "system.MountZone") ||
          foundry.utils.getProperty(data, "system.CyberBodyType.Type") ||
          this.item.system?.MountZone ||
          this.item.system?.CyberBodyType?.Type ||
          ""
        );
        const loc = String(
          foundry.utils.getProperty(data, "system.CyberBodyType.Location") ||
          this.item.system?.CyberBodyType?.Location ||
          ""
        );
        if ((zone === "Arm" || zone === "Leg") && !loc) {
          foundry.utils.setProperty(data, "system.CyberBodyType.Location", "Left");
        }
      }
    }

    return data;
  }

  /**
   * Collect the chip level aggregate for all of the actor's chip implants
   * Take the maximum chip level for each affected skill.
  */
  async _cp_syncChipLevelsToSkills() {
    const actor = this.item.actor;
    if (!actor) return;

    const chipItems = actor.items.filter(i =>
      i.type === "cyberware" &&
      cwHasType(i, "Chip") &&
      i.system?.equipped !== false &&
      !!i.system?.CyberWorkType?.ChipActive
    );

    const agg = {};
    for (const cw of chipItems) {
      const map = cw.system?.CyberWorkType?.ChipSkills || {};
      for (const [key, lvl] of Object.entries(map)) {
        const n = Number(lvl) || 0;
        if (n < 0) continue;
        agg[key] = Math.max(agg[key] ?? 0, n);
      }
    }

    const skillItems = actor.items.filter(i => i.type === "skill");
    const updates = [];
    const updatedSkillIds = [];

    for (const s of skillItems) {
      const want = Number(agg[s.id] ?? agg[s.name] ?? 0);
      const cur  = Number(s.system?.chipLevel || 0);
      if (want !== cur) {
        updates.push({ _id: s.id, "system.chipLevel": want });
        updatedSkillIds.push(s.id);
      }
    }

    if (updates.length) {
      await actor.updateEmbeddedDocuments("Item", updates, { render: false });

      for (const sid of updatedSkillIds) {
        const sk = actor.items.get(sid);
        if (sk?.sheet?.rendered) sk.sheet.render(true);
      }
    }
  }
  /**
   * Set system.isChipped for skills based on all active chips of the actor
   * true — if there is at least one active chip for the skill that grants this skill
   * false — if there are no active chips for the skill
  */
  async _cp_syncActiveFlagsToSkills() {
    const actor = this.item.actor;
    if (!actor) return;

    const activeChips = actor.items.filter(i =>
      i.type === "cyberware" &&
      cwHasType(i, "Chip") &&
      i.system?.equipped !== false &&
      !!i.system?.CyberWorkType?.ChipActive
    );

    const activeMap = {};
    for (const ch of activeChips) {
      const skills = ch.system?.CyberWorkType?.ChipSkills || {};
      for (const key of Object.keys(skills)) activeMap[key] = true;
    }

    const skills = actor.items.filter(i => i.type === "skill");
    const updates = [];
    const updatedIds = [];
    for (const s of skills) {
      const want = !!(activeMap[s.id] ?? activeMap[s.name]);
      const cur  = !!(s.system?.isChipped);
      if (want !== cur) {
        updates.push({ _id: s.id, "system.isChipped": want });
        updatedIds.push(s.id);
      }
    }
    if (updates.length) {
      await actor.updateEmbeddedDocuments("Item", updates, { render: false });
      for (const sid of updatedIds) {
        const sk = actor.items.get(sid);
        if (sk?.sheet?.rendered) sk.sheet.render(true);
      }
    }
  }
}
