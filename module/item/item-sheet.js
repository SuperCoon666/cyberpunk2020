import { weaponTypes, meleeAttackTypes, rangedAttackTypes, attackSkills, concealability, availability, reliability, getStatNames } from "../lookups.js";
import { formulaHasDice } from "../dice.js";
import { deleteFieldUpdate, localize, cwHasType, getSkillIndex } from "../utils.js";
import { createCyberpunkChatMessage, getHtmlElement, getPublicMessageMode, getRichEditorHTML, saveRichEditorHTML, rollToCyberpunkChatMessage } from "../compat.js";

/** @extends {ItemSheet} */
export class CyberpunkItemSheet extends ItemSheet {

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["cyberpunk", "sheet", "item"],
      width: 520,
      height: 480,
      tabs: [{ navSelector: ".sheet-tabs", contentSelector: ".sheet-body", initial: "description" }]
    });
  }

  /** @override */
  get template() {
    return "systems/cyberpunk2020/templates/item/item-sheet.hbs";
  }

  /* -------------------------------------------- */

  /** @override */
  async getData() {
    const data = await super.getData();
    data.system = this.item.system;
    data.owner = this.item.isOwner;
    data.editable = this.isEditable ?? this.options?.editable ?? false;
    data.isGM = game.user.isGM;

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
    setIfMissing("penDamageMult", 1);
    setIfMissing("bonusDamageFormula", "");
    setIfMissing("accuracyMod", 0);

    setIfMissing("stunSaveOnHit", false);
    setIfMissing("stunSaveMod", 0);

    setIfMissing("dotEnabled", false);
    setIfMissing("dotTurns", 0);
    setIfMissing("dotDamageFormula", "");

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

      "AmmoReloadGrenades",
      "AmmoReloadRockets",
      "AmmoReloadOther"
    ];

    // Blast zones selector options
    sheet.blastZonesOptions = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => {
        const n = i + 1;
        return [n, n];
      })
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
      : (sys.effectTypes ? [sys.effectTypes] : ["None"]);

    const effectKeyMap = {
      None: "AmmoEffect_None",
      CoreMods: "AmmoEffect_CoreMods",
      Stun: "AmmoEffect_Stun",
      DoT: "AmmoEffect_DoT",
      Blast: "AmmoEffect_Blast",
      Spread: "AmmoEffect_Spread"
    };

    sheet.ammoFx = {
      typeLabels: (effectTypes.length ? effectTypes : ["None"])
        .map(t => localize(effectKeyMap[t] ?? "AmmoEffect_None"))
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
          const ammoType = String(a.system?.ammoType ?? "");
          const typeLabel = ammoType ? ammoType : "";
          const label = typeLabel ? `${a.name} (${typeLabel})` : a.name;
          return { value: a.id, localKey: label };
        });
    }

    const actor = this.item?.parent;
    const wType = this.item.system.weaponType || weaponTypes.pistol;
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
        const ammoType = String(a.system?.ammoType ?? "");
        const label = ammoType ? `${a.name} (${ammoType})` : a.name;
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

  async _cwSet(path, value) {
    const update = {}; foundry.utils.setProperty(update, path, value);
    await this.item.update(update);
    this.render(false);
  }
  async _ammoSet(path, value) {
    const update = {};
    foundry.utils.setProperty(update, path, value);
    await this.item.update(update);
    this.render(false);
  }
  async _cwDelete(objPath, key) {
    const update = deleteFieldUpdate(`${objPath}.${key}`);
    await this.item.update(update);
    this.render(false);
  }

  async _cwAddKey(objPath, key, value) {
    const current = foundry.utils.duplicate(
      foundry.utils.getProperty(this.item.system, objPath) || {}
    );
    if (current[key] === value) return;

    current[key] = value;

    const update = {};
    foundry.utils.setProperty(update, `system.${objPath}`, current);
    await this.item.update(update);
    this.render(false);
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
  setPosition(options = {}) {
    const position = super.setPosition(options);
    const sheetBody = this.element.find(".sheet-body");
    const bodyHeight = position.height - 192;
    sheetBody.css("height", bodyHeight);
    return position;
  }

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    const root = getHtmlElement(html);

    const editable = this.isEditable ?? this.options?.editable ?? false;

    // Notes editor autosave must be registered while the sheet is editable,
    // but it is independent from the item controls below.
    if (editable) this._cpSetupNotesAutosave(root);

    // Everything below here is only needed if the sheet is editable
    if (!editable) return;

    // Roll handlers, click handlers, etc. would go here, same as actor sheet.
    html.find(".item-roll").click(this.item.roll.bind(this));
    html.find(".accel").click(() => this.item.accel());
    html.find(".decel").click(() => this.item.accel(true));

    ["select.cw-add-stat",
    "select.cw-add-check",
    "select.cw-add-location",
    "select.cw-add-penalty",
    "select.cw-add-mountpolicy"
    ].forEach(sel => {
      html.on("mousedown", sel, ev => { ev.currentTarget.value = ""; });
    });

    // Stat
    html.on("change", "select.cw-add-stat", async ev => {
      const key = ev.currentTarget.value;
      if (!key) return;
      await this._cwSet(`system.CyberWorkType.Stat.${key}`, 0);
      ev.currentTarget.value = "";
    });

    // Checks
    html.on("change", "select.cw-add-check", async ev => {
      const key = ev.currentTarget.value;
      if (!key) return;

      const checks = foundry.utils.duplicate(this.item.system?.CyberWorkType?.Checks || {});
      if (checks[key] == null) checks[key] = 0;

      await this.item.update({ "system.CyberWorkType.Checks": checks });
    });

    // Locations
    html.on("change", "select.cw-add-location", async ev => {
      const key = ev.currentTarget.value;
      if (!key) return;
      await this._cwSet(`system.CyberWorkType.Locations.${key}`, 0);
      ev.currentTarget.value = "";
    });

    // Penalties
    html.on("change", "select.cw-add-penalty", async ev => {
      const key = ev.currentTarget.value;
      if (!key) return;
      await this._cwSet(`system.CyberWorkType.Penalties.${key}`, 0);
      ev.currentTarget.value = "";
    });

    // MountPolicy
    html.on("change", "select.cw-add-mountpolicy", async ev => {
      const key = ev.currentTarget.value;
      if (!key) return;
      const mp = this.item.system?.CyberWorkType?.MountPolicy;
      const list = Array.isArray(mp) ? [...mp] : (mp ? [mp] : []);
      if (!list.includes(key)) list.push(key);
      await this._cwSet("system.CyberWorkType.MountPolicy", list);
      ev.currentTarget.value = "";
    });

    // Skill search
    const addSkillFromInput = async (inputEl, pathPrefix) => {
    const key = this._resolveSkillKey(inputEl?.value || "");
    if (!key) return;
    await this._cwSet(`${pathPrefix}.${key}`, 0);
      inputEl.value = "";
      inputEl.blur();
    };

    // Characteristic.Skill
    html.on("input", "input[name='cw-skill-search']", ev => {
      addSkillFromInput(ev.currentTarget, "system.CyberWorkType.Skill");
    });

    // Chip.ChipSkills
    html.on("input", "input[name='cw-chip-skill-search']", async ev => {
      await addSkillFromInput(ev.currentTarget, "system.CyberWorkType.ChipSkills");
      await this._cp_syncChipLevelsToSkills();
      if (typeof this._cp_syncActiveFlagsToSkills === "function") {
        await this._cp_syncActiveFlagsToSkills();
      }
    });

    html.on("change", "select[name='system.ammoItemId']", async (ev) => {
      if (this.item.type !== "weapon") return;

      const value = String(ev.currentTarget.value ?? "");
      await this.item.update({ "system.ammoItemId": value }, { render: false });
    });
    html.on("change", "select[name='system.CyberWorkType.Weapon.ammoItemId']", async (ev) => {
      if (this.item.type !== "cyberware") return;

      const value = String(ev.currentTarget.value ?? "");
      await this.item.update({ "system.CyberWorkType.Weapon.ammoItemId": value }, { render: false });
    });

    // Allow comma decimal separator in numeric inputs (convert to dot)
    html.on("change", 'input[type="number"]', (ev) => {
      const el = ev.currentTarget;
      if (typeof el.value === "string" && el.value.includes(",")) {
        el.value = el.value.replace(",", ".");
      }
    });

    // Ammo Blast Multipliers
    html.on("change", "input.ammo-blast-mult", async (ev) => {
      if (this.item.type !== "ammo") return;

      ev.preventDefault();
      ev.stopPropagation();

      const el = ev.currentTarget;
      const idx = Number(el.dataset.index);
      if (!Number.isFinite(idx)) return;

      const raw = String(el.value ?? "").replace(",", ".");
      const val = Number(raw);

      const zones = Math.max(1, Math.min(10, Number(this.item.system?.blastZones ?? 4)));

      const defaultMult = (i) => 1 / (2 ** (i + 1));

      let cur = this.item.system?.blastMultipliers;
      if (!Array.isArray(cur)) {
        cur = Array.from({ length: zones }, (_, i) => defaultMult(i));
      } else {
        cur = cur.slice(0, zones);
        while (cur.length < zones) cur.push(defaultMult(cur.length));
      }

      cur[idx] = Number.isFinite(val) ? val : cur[idx];

      await this.item.update({ "system.blastMultipliers": cur }, { render: false });
      this.render(false);
    });

    html.on("mousedown", "input[name='cw-skill-search'], input[name='cw-chip-skill-search']", ev => {
      const el = ev.currentTarget;
      if (document.activeElement === el) {
        ev.preventDefault();
        const listId = el.getAttribute("list");
        el.removeAttribute("list");
        el.blur();
        setTimeout(() => {
          el.setAttribute("list", listId);
        }, 150);
      }
    });

    // Remove
    html.on("click", ".cw-remove-stat", ev => this._cwDelete("system.CyberWorkType.Stat", ev.currentTarget.dataset.key));
    html.on("click", ".cw-remove-check", ev => this._cwDelete("system.CyberWorkType.Checks", ev.currentTarget.dataset.key));
    html.on("click", ".cw-remove-skill", ev => this._cwDelete("system.CyberWorkType.Skill", ev.currentTarget.dataset.key));
    html.on("click", ".cw-remove-location", ev => this._cwDelete("system.CyberWorkType.Locations", ev.currentTarget.dataset.key));
    html.on("click", ".cw-remove-penalty", ev => this._cwDelete("system.CyberWorkType.Penalties", ev.currentTarget.dataset.key));
    html.on("click", ".cw-remove-chipskill", async ev => {
      const skillKey = ev.currentTarget.dataset.key;

      await this._cwDelete("system.CyberWorkType.ChipSkills", skillKey);

      await this._cp_syncChipLevelsToSkills();
      if (typeof this._cp_syncActiveFlagsToSkills === "function") {
        await this._cp_syncActiveFlagsToSkills();
      }

      const actor = this.item.actor;
      if (actor) {
        // New format: key is a Skill Item _id
        const byId = actor.items.get(skillKey);
        if (byId?.sheet?.rendered) byId.sheet.render(true);

        // Legacy format fallback: key is a localized skill name
        const byName = actor.items.filter((i) => i.type === "skill" && i.name === skillKey);
        for (const s of byName) if (s.sheet?.rendered) s.sheet.render(true);
      }

      if (actor?.sheet?.rendered) actor.sheet.render(true);
    });
    html.on("click", ".cw-remove-mount", async ev => {
      const key = ev.currentTarget.dataset.key;
      const mp = this.item.system?.CyberWorkType?.MountPolicy || [];
      const list = mp.filter(x => x !== key);
      await this._cwSet("system.CyberWorkType.MountPolicy", list);
    });

    // Change body zone: if not Arm/Leg — clear the side
    html.on("change", "select[name='system.CyberBodyType.Type']", async ev => {
      const t = ev.currentTarget.value;
      if (t !== "Arm" && t !== "Leg") {
        await this._cwSet("system.CyberBodyType.Location", "");
      }
    });

    // Weapon selection: always store the id in system.CyberWorkType.ItemId
    html.on("change", "select.cw-select-weapon", async ev => {
      const selectedId = ev.currentTarget.value || "";
      await this._cwSet("system.CyberWorkType.ItemId", selectedId);
    });

    // Rerender when module toggle changes
    html.find('input[name="system.Module.IsModule"]').on('change', (ev) => {
      this._onSubmit(ev);
    });

    // HumanityCost Roll
    html.find('.humanity-cost-roll').click(async ev => {
      ev.stopPropagation();

      const cyber = this.object;
      const hc = cyber.system.humanityCost;
      let loss = 0;
      let roll = null;

      // determine if humanity cost is a number or dice
      if (formulaHasDice(hc)) {
        roll = await new Roll(hc).evaluate();
        loss = roll?.total ? roll.total : 0;
      } else {
        const num = Number(hc);
        loss = (isNaN(num)) ? 0 : num;
      }

      // Persist loss on the item
      await cyber.update({ "system.humanityLoss": loss });

      // Public chat message so players can't reroll silently
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
      } else {
        await createCyberpunkChatMessage({
          speaker,
          content: game.i18n.format("CYBERPUNK.Chat.HumanityLossSet", {
            actor: actor?.name ?? game.user.name,
            item: cyber.name,
            loss
          })
        }, { messageMode });
      }
    });

    // Recalculate available slots when changing “Slots provided”
    html.find('input[name="system.CyberWorkType.OptionsAvailable"]').on('change', (ev) => {
      this._onSubmit(ev);
    });

    html.on("change", "select[name='system.Module.ParentId']", async ev => {
      await this._cwSet("system.Module.ParentId", String(ev.currentTarget.value || ""));
    });

    // MODULE: implant replacement
    html.on("change", "select[name='system.Module.ParentId']", async ev => {
      const prevId = this.item.system?.Module?.ParentId || "";
      const newId = String(ev.currentTarget.value || "");

      await this._cwSet("system.Module.ParentId", newId);

      const refresh = (id) => {
        const it = this.actor?.items?.get(id);
        if (it?.sheet?.rendered) it.sheet.render(true);
      };
      if (prevId && prevId !== newId) refresh(prevId);
      if (newId) refresh(newId);
    });

    // MODULE: change “occupies options”
    html.on("change", "input[name='system.Module.SlotsTaken']", async ev => {
      const n = Number(ev.currentTarget.value);
      await this._cwSet("system.Module.SlotsTaken", Number.isFinite(n) ? n : 0);

      const parentId = this.item.system?.Module?.ParentId || "";
      const parent = parentId ? this.actor?.items?.get(parentId) : null;
      if (parent?.sheet?.rendered) parent.sheet.render(true);
    });

    // MODULE: turning off “Module” — freeing up options from the parent
    html.on("change", "input[name='system.Module.IsModule']", async ev => {
      const enabled = ev.currentTarget.checked;
      const prevId = this.item.system?.Module?.ParentId || "";
      await this._cwSet("system.Module.IsModule", enabled);
      if (!enabled && prevId) {
        await this._cwSet("system.Module.ParentId", "");
        const parent = this.actor?.items?.get(prevId);
        if (parent?.sheet?.rendered) parent.sheet.render(true);
      }
    });

    html.on("change", "select[name='system.cyberwareType']", async ev => {
      const v = ev.currentTarget.value;
      let bodyType = "";
      if (v === "CyberArm") bodyType = "Arm";
      else if (v === "CyberLeg") bodyType = "Leg";
      else if (v === "CyberTorso") bodyType = "Torso";
      else if (v === "CyberAudio" || v === "CyberOptic") bodyType = "Head";

      await this._cwSet("system.CyberBodyType.Type", bodyType);
      if (bodyType !== "Arm" && bodyType !== "Leg") {
        await this._cwSet("system.CyberBodyType.Location", "");
      }
    });

    // Changing the ChipSkills level
    html.on("change", "input[name^='system.CyberWorkType.ChipSkills.']", async ev => {
      const el = ev.currentTarget;
      const skillName = el.name.split(".").pop();
      const n = Number(el.value);
      await this._cwSet(el.name, Number.isFinite(n) ? n : 0);

      await this._cp_syncChipLevelsToSkills();
      if (typeof this._cp_syncActiveFlagsToSkills === "function") {
        await this._cp_syncActiveFlagsToSkills();
      }

      const actor = this.item.actor;
      if (actor?.sheet?.rendered) actor.sheet.render(true);

      if (actor) {
        for (const it of actor.items) {
          if (it.type !== "skill") continue;
          if (it.name !== skillName) continue;
          if (it.sheet?.rendered) it.sheet.render(true);
        }
      }

      this.render(true);
    });

    html.on("change", "input[name='system.CyberWorkType.ChipActive']", async ev => {
      const checked = !!ev.currentTarget.checked;
      const prev = !!this.item.system?.CyberWorkType?.ChipActive;
      if (prev === checked) return;

      await this.item.update({ "system.CyberWorkType.ChipActive": checked }, { render: false });

      if (typeof this._cp_syncChipLevelsToSkills === "function") {
        await this._cp_syncChipLevelsToSkills();
      }

      if (typeof this._cp_syncActiveFlagsToSkills === "function") {
        await this._cp_syncActiveFlagsToSkills();
      }

      const actor = this.item.actor;
      if (actor?.sheet?.rendered) actor.sheet.render(true);
      const affectedKeys = Object.keys(this.item.system?.CyberWorkType?.ChipSkills || {});
      for (const it of (actor?.items ?? [])) {
        if (it.type !== "skill") continue;
        if (!(affectedKeys.includes(it.id) || affectedKeys.includes(it.name))) continue;
        if (it.sheet?.rendered) it.sheet.render(true);
      }
      this.render(true);
    });

    // SKILL SHEET: persist skill levels and chip mode immediately.
    if (this.item.type === "skill") {
      const parseSkillNumber = (value) => {
        const n = Number.parseInt(value ?? 0, 10);
        return Number.isFinite(n) ? n : 0;
      };

      const updateThisSkill = async (patch) => {
        const actor = this.item.actor;
        if (actor) {
          await actor.updateEmbeddedDocuments("Item", [
            { _id: this.item.id, ...patch }
          ], { render: false });
        } else {
          await this.item.update(patch, { render: false });
        }
      };

      const findChipsForThisSkill = () => {
        const actor = this.item.actor;
        if (!actor) return [];

        const skillId = this.item.id;
        const skillName = this.item.name;

        return actor.items.filter(i => {
          if (i.type !== "cyberware") return false;
          if (!cwHasType(i, "Chip")) return false;
          if (i.system?.equipped === false) return false;
          const map = i.system?.CyberWorkType?.ChipSkills;
          if (!map) return false;

          return (skillId && Object.prototype.hasOwnProperty.call(map, skillId)) ||
                Object.prototype.hasOwnProperty.call(map, skillName);
        });
      };

      html.on("change", "input[name='system.level']", async (ev) => {
        const value = parseSkillNumber(ev.currentTarget.value);
        const prev = Number(this.item.system?.level || 0);
        if (prev === value) return;

        await updateThisSkill({ "system.level": value });

        const actor = this.item.actor;
        if (actor?.sheet?.rendered) actor.sheet.render(true);
        this.render(true);
      });

      html.on("change", "input[name='system.isChipped']", async (ev) => {
        const checked = !!ev.currentTarget.checked;

        const prev = !!this.item.system?.isChipped;
        if (prev === checked) return;

        const actor = this.item.actor;
        const skillId = this.item.id;
        const chips = findChipsForThisSkill();

        if (actor && chips.length) {
          // Switch real chips, then let synchronization derive the skill flag.
          const chipUpdates = chips.map(ch => ({
            _id: ch.id,
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
          // No real chip implant: allow manual chip mode on the skill item itself.
          await updateThisSkill({
            "system.isChipped": checked,
            ...deleteFieldUpdate("system.chipped")
          });
        }

        if (actor?.sheet?.rendered) actor.sheet.render(true);
        for (const ch of chips) if (ch.sheet?.rendered) ch.sheet.render(true);
        this.render(true);
      });

      // Changing “Level (with chip)” always persists the skill's own chipLevel.
      // If a real chip implant exists for this skill, mirror the value into that chip as well.
      html.on("change", "input[name='system.chipLevel']", async (ev) => {
        const actor = this.item.actor;
        const skillId = this.item.id;
        const skillName = this.item.name;

        const value = parseSkillNumber(ev.currentTarget.value);
        const prev = Number(this.item.system?.chipLevel || 0);
        if (prev !== value) {
          await updateThisSkill({ "system.chipLevel": value });
        }

        const chips = findChipsForThisSkill();
        if (actor && chips.length) {
          const updates = chips.map(ch => {
            const map = ch.system?.CyberWorkType?.ChipSkills || {};
            const patch = { _id: ch.id };

            if (skillId && Object.prototype.hasOwnProperty.call(map, skillId)) {
              patch[`system.CyberWorkType.ChipSkills.${skillId}`] = value;
            }
            if (Object.prototype.hasOwnProperty.call(map, skillName)) {
              patch[`system.CyberWorkType.ChipSkills.${skillName}`] = value;
            }

            return patch;
          }).filter(p => Object.keys(p).length > 1);

          if (updates.length) {
            await actor.updateEmbeddedDocuments("Item", updates, { render: false });
          }

          if (typeof this._cp_syncChipLevelsToSkills === "function") {
            await this._cp_syncChipLevelsToSkills();
          }
        }

        if (actor?.sheet?.rendered) actor.sheet.render(true);
        for (const ch of chips) if (ch.sheet?.rendered) ch.sheet.render(true);
        this.render(true);
      });
    }

    // Open/close menu
    html.on("click", ".cw-ms-trigger", ev => {
      ev.preventDefault();
      const root = ev.currentTarget.closest(".cw-ms");
      if (!root) return;
      root.classList.toggle("open");
    });

    // Close on click outside the block
    html.on("click", ev => {
      if ($(ev.target).closest(".cw-ms").length) return;
      html.find(".cw-ms.open").removeClass("open");
    });

    // Selecting checkboxes within the menu
    html.on("change", ".cw-ms-menu input[type=checkbox]", async ev => {
      const root = ev.currentTarget.closest(".cw-ms");
      if (!root) return;

      const menu = root.querySelector(".cw-ms-menu");
      let next = Array.from(menu.querySelectorAll("input[type=checkbox]:checked")).map(i => i.value);

      const changed = ev.currentTarget.value;
      const turnedOn = ev.currentTarget.checked;

      if (changed === "Descriptive" && turnedOn) {
        next = ["Descriptive"];
        menu.querySelectorAll("input[type=checkbox]").forEach(i => {
          i.checked = (i.value === "Descriptive");
        });
      } else if (turnedOn) {
        const desc = menu.querySelector('input[value="Descriptive"]');
        if (desc) desc.checked = false;
        next = next.filter(v => v !== "Descriptive");
      }

      if (!next.length) {
        next = ["Descriptive"];
        const desc = menu.querySelector('input[value="Descriptive"]');
        if (desc) desc.checked = true;
      }

      await this._cwSet("system.CyberWorkType.Types", next);
    });

    html.on("click", ".ammo-ms-trigger", ev => {
      if (this.item.type !== "ammo") return;
      ev.preventDefault();
      const root = ev.currentTarget.closest(".ammo-ms");
      if (!root) return;
      root.classList.toggle("open");
    });

    html.on("click", ev => {
      if (this.item.type !== "ammo") return;
      if ($(ev.target).closest(".ammo-ms").length) return;
      html.find(".ammo-ms.open").removeClass("open");
    });

    html.on("change", ".ammo-ms-menu input[type=checkbox]", async ev => {
      if (this.item.type !== "ammo") return;
      const root = ev.currentTarget.closest(".ammo-ms");
      if (!root) return;

      const menu = root.querySelector(".ammo-ms-menu");
      let next = Array.from(menu.querySelectorAll("input[type=checkbox]:checked")).map(i => i.value);

      const changed = ev.currentTarget.value;
      const turnedOn = ev.currentTarget.checked;

      if (changed === "None" && turnedOn) {
        next = ["None"];
        menu.querySelectorAll("input[type=checkbox]").forEach(i => {
          i.checked = (i.value === "None");
        });
      } else if (turnedOn) {
        const none = menu.querySelector('input[value="None"]');
        if (none) none.checked = false;
        next = next.filter(v => v !== "None");
      }

      if (!next.length) {
        next = ["None"];
        const none = menu.querySelector('input[value="None"]');
        if (none) none.checked = true;
      }

      await this._ammoSet("system.effectTypes", next);
    });

    // Auto-refresh on related Item updates (keeps module/implant sheets in sync)
    if (this.actor) {
      const actorId = this.actor.id;

      this._cp_boundOnItemUpdate = (item, changes) => {
        if (item?.parent?.id !== actorId) return;
        if (item.type !== "cyberware") return;

        const sys = changes?.system || {};
        const touched =
          ("equipped" in sys) ||
          ("MountZone" in sys) ||
          ("cyberwareType" in sys) ||
          ("CyberBodyType" in sys) ||
          ("Module" in sys) ||
          (sys.CyberWorkType && ("OptionsAvailable" in sys.CyberWorkType));

        if (!touched) return;

        const isThisModule = !!this.item.system?.Module?.IsModule;
        const isThisImplant = cwHasType(this.item, "Implant");

        // Module sheet: re-render when any cyberware on this actor changes in a way that affects the parent list/slots
        if (isThisModule) {
          this.render(false);
          return;
        }

        // Implant sheet: re-render only if a module touching this implant changed
        if (isThisImplant) {
          const mod = item.system?.Module;
          if (mod?.IsModule && mod?.ParentId === this.item.id) {
            this.render(false);
          }
        }
      };

      Hooks.on("updateItem", this._cp_boundOnItemUpdate);

      const closeHook = `close${this.constructor.name}`;
      this._cp_unbindOnClose = (app) => {
        if (app !== this) return;
        Hooks.off("updateItem", this._cp_boundOnItemUpdate);
        Hooks.off(closeHook, this._cp_unbindOnClose);
      };
      Hooks.on(closeHook, this._cp_unbindOnClose);
    }

    // MODULE: toggling equipped should refresh parent implant sheet (slots left)
    html.on("change", "input[name='system.equipped']", async ev => {
      const checked = !!ev.currentTarget.checked;

      const patch = { "system.equipped": checked };

      // Chip cyberware: if it becomes unequipped, it cannot remain active
      const isChip = this.item.type === "cyberware" && cwHasType(this.item, "Chip");
      if (!checked && isChip) {
        patch["system.CyberWorkType.ChipActive"] = false;
      }

      await this.item.update(patch, { render: false });

      // If we disabled a chip – resync skills (chip levels + active flags)
      if (!checked && isChip) {
        if (typeof this._cp_syncChipLevelsToSkills === "function") {
          await this._cp_syncChipLevelsToSkills();
        }
        if (typeof this._cp_syncActiveFlagsToSkills === "function") {
          await this._cp_syncActiveFlagsToSkills();
        }

        const actor = this.item.actor;
        if (actor?.sheet?.rendered) actor.sheet.render(true);
      }

      const parentId = this.item.system?.Module?.ParentId || "";
      const parent = parentId ? this.actor?.items?.get(parentId) : null;
      if (parent?.sheet?.rendered) parent.sheet.render(true);

      this.render(false);
    });
  }

  _cpSetupNotesAutosave(root) {
    if (!root) return;
    const editable = this.isEditable ?? this.options?.editable ?? false;
    if (!editable) return;

    if (!this._cpNotesAutosaveState) {
      this._cpNotesAutosaveState = {
        saving: false,
        pending: false,
        lastSaved: String(this.item.system?.notes ?? "")
      };
    }

    if (this._cpNotesAutosaveHandler) {
      try { root.removeEventListener("save", this._cpNotesAutosaveHandler, true); } catch (_) {}
    }

    const handler = (ev) => {
      const target = ev?.target;
      if (!target?.closest) return;
      if (!target.closest('.tab[data-tab="notes"]')) return;
      if (!target.closest(".cp-notes-editor")) return;

      setTimeout(() => this._cpFlushNotesAutosave(root, { force: true, serialize: false }), 0);
    };

    root.addEventListener("save", handler, true);
    this._cpNotesAutosaveHandler = handler;
  }

  _cpReadNotesHTML(root, { serialize = false } = {}) {
    const selectors = [
      '.tab[data-tab="notes"] .editor-content',
      '.tab[data-tab="notes"] [contenteditable="true"]'
    ];

    return serialize
      ? saveRichEditorHTML(this, root, "system.notes", selectors)
      : getRichEditorHTML(this, root, "system.notes", selectors);
  }

  async _cpFlushNotesAutosave(root, { force = false, serialize = false } = {}) {
    const st = this._cpNotesAutosaveState;
    if (!st) return;

    if (st.saving) {
      st.pending = true;
      return;
    }

    const html = this._cpReadNotesHTML(root, { serialize });
    if (html == null) return;
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
        st.pending = false;
        await this._cpFlushNotesAutosave(root, { force: true, serialize: false });
      }
    }
  }

  /** @override */
  async close(options = {}) {
    try {
      const root = getHtmlElement(this.element);
      await this._cpFlushNotesAutosave(root, { force: true, serialize: true });
    } catch (_) {}

    return super.close(options);
  }

  /** @override */
  async _updateObject(event, formData) {
    const data = foundry.utils.expandObject(formData);

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

    if (this.item.type === "skill") {
      const fixNum = v => {
        const n = parseInt(v ?? 0, 10);
        return isNaN(n) ? 0 : n;
      };

      // In Foundry v14 an ItemSheet change submit may contain only the changed
      // input, not the complete form. Do not create missing skill fields here,
      // or changing level will overwrite chipLevel with 0 and vice versa.
      if (foundry.utils.hasProperty(data, "system.level")) {
        foundry.utils.setProperty(data, "system.level", fixNum(foundry.utils.getProperty(data, "system.level")));
      }
      if (foundry.utils.hasProperty(data, "system.chipLevel")) {
        foundry.utils.setProperty(data, "system.chipLevel", fixNum(foundry.utils.getProperty(data, "system.chipLevel")));
      }
    }

    const legacy = foundry.utils.getProperty(data, "system.chipped");
    if (legacy !== undefined) {
      foundry.utils.setProperty(data, "system.isChipped", !!legacy);
      if (data.system && "chipped" in data.system) delete data.system.chipped;
    }

    if (this.item.type === "cyberware") {
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

    await this.item.update(data);
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
