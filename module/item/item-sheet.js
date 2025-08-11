import { weaponTypes, sortedAttackTypes, concealability, availability, reliability, attackSkills, meleeAttackTypes, getStatNames } from "../lookups.js";
import { formulaHasDice } from "../dice.js";
import { localize } from "../utils.js";
import { getMartialKeyByName } from '../translations.js'

/**
 * Extend the basic ItemSheet with some very simple modifications
 * @extends {ItemSheet}
 */
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
    const path = "systems/cyberpunk2020/templates/item";
    // Return a single sheet for all item types.
    // return `${path}/item-sheet.hbs`;

    // Alternatively, you could use the following return statement to do a
    // unique item sheet by type, like `weapon-sheet.hbs`.
    return `${path}/item-sheet.hbs`;
  }

  /* -------------------------------------------- */

  /** @override */
  getData() {
    // This means the handlebars data and the form edit data actually mirror each other
    const data = super.getData();
    data.system = this.item.system;

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
        this._prepareCyberware(data); 
        break;

      default:
        break;
    }
    return data;
  }

  _prepareSkill(sheet) {
    sheet.stats = getStatNames();
  }

  _prepareWeapon(sheet) {
    sheet.weaponTypes = Object.values(weaponTypes).sort();
    if(this.item.system.weaponType === weaponTypes.melee) {
      sheet.attackTypes = Object.values(meleeAttackTypes).sort();
    }
    else {
      sheet.attackTypes = sortedAttackTypes;
    }
    sheet.concealabilities = Object.values(concealability);
    sheet.availabilities = Object.values(availability);
    sheet.reliabilities = Object.values(reliability);

    sheet.attackSkills = [
      ...attackSkills[this.item.system.weaponType]
      .map(x => localize("Skill"+x)), 
      ...(this.actor?.trainedMartials().
      map(name => localize('Skill'+getMartialKeyByName(name))) || [])
    ];


    // TODO: Be not so inefficient for this
    if(!sheet.attackSkills.length && this.actor) {
      if(this.actor) {
        sheet.attackSkills = this.actor.itemTypes.skill.map(skill => skill.name).sort();
      }
    }
  }

  _prepareArmor(sheet) {
    
  }

  /**
   * Prepares data for the cyberware item sheet template.
   * Gathers option lists, selected values, and labels.
  */
  _prepareCyberware(sheet) {
    const L = (k) => {
      if (game.i18n.has(`CYBERPUNK.${k}`)) return game.i18n.localize(`CYBERPUNK.${k}`);
      if (game.i18n.has(k)) return game.i18n.localize(k);
      return k;
    };

    const cwt = this.item.system?.CyberWorkType ?? { Type: "Descriptive" };
    sheet.cw = sheet.cw ?? {};

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

    // Skills (from the actor, if present)
    const actorSkills = this.actor?.itemTypes?.skill ?? [];
    sheet.cw.skillOptions = actorSkills.map((s) => s.name).sort((a, b) => a.localeCompare(b));
    sheet.cw.currentSkills = Object.keys(cwt.Skill ?? {}).sort();
    sheet.cw.currentChipSkills = Object.keys(cwt.ChipSkills ?? {}).sort();
    sheet.cw.hasActor = !!this.actor;

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
      { key: "Nervous", label: L("Nervous") }
    ];
    sheet.cw.bodyZones = bodyAll;

    // Allowed parent cyberware type
    const defaults = ["CYBEROPTIC", "CYBEREAR", "CYBERARM", "CYBERHAND", "CYBERLEG", "CYBERFOOT", "IMPLANT"];
    const worldTypes = Array.from(game.items ?? [])
      .filter((i) => i.type === "cyberware")
      .map((i) => i.system?.cyberwareType)
      .filter((t) => !!t);
    const actorTypes = this.actor ? (this.actor.itemTypes.cyberware ?? []).map((i) => i.system?.cyberwareType).filter((t) => !!t) : [];
    const uniq = Array.from(new Set([...defaults, ...worldTypes, ...actorTypes])).sort((a, b) => a.localeCompare(b));
    sheet.cw.parentCwTypeOptions = uniq.map((t) => ({ key: t, label: t }));
  }

  async _cwSet(path, value) {
    const update = {}; foundry.utils.setProperty(update, path, value);
    await this.item.update(update);
    this.render(false);
  }
  async _cwDelete(objPath, key) {
    const update = {};
    update[`${objPath}.-=${key}`] = null;
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

  _resolveSkillName(query) {
    const skills = this.actor?.itemTypes?.skill || [];
    const q = String(query || "").trim();
    if (!q || !skills.length) return null;
    const exact = skills.find(s => s.name === q);
    return exact ? exact.name : null;
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

    // Everything below here is only needed if the sheet is editable
    if (!this.options.editable) return;

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
      const name = this._resolveSkillName(inputEl?.value || "");
      if (!name) return;
      await this._cwSet(`${pathPrefix}.${name}`, 0);
      inputEl.value = "";
      inputEl.blur();
    };

    // Characteristic.Skill
    html.on("input", "input[name='cw-skill-search']", ev => {
      addSkillFromInput(ev.currentTarget, "system.CyberWorkType.Skill");
    });

    // Chip.ChipSkills
    html.on("input", "input[name='cw-chip-skill-search']", ev => {
      addSkillFromInput(ev.currentTarget, "system.CyberWorkType.ChipSkills");
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
    html.on("click", ".cw-remove-chipskill", ev => this._cwDelete("system.CyberWorkType.ChipSkills", ev.currentTarget.dataset.key));
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

    // HumanityCost Roll
    html.find('.humanity-cost-roll').click(async ev => {
      ev.stopPropagation();
      const cyber = this.object;
      const hc = cyber.system.humanityCost;
      let loss = 0;
      // determine if humanity cost is a number or dice
      if (formulaHasDice(hc)) {
        // roll the humanity cost
        let r = await new Roll(hc).evaluate();
        loss = r.total ? r.total : 0;
      } else {
        const num = Number(hc);
        loss = (isNaN(num)) ? 0 : num;
      }
      cyber.system.humanityLoss = loss;
      cyber.sheet.render(true);
    });
  }

  /** @override */
  async _updateObject(event, formData) {
    const data = foundry.utils.expandObject(formData);

    if (this.item.type === "skill") {
      const fixNum = v => {
        const n = parseInt(v ?? 0, 10);
        return isNaN(n) ? 0 : n;
      };
      foundry.utils.setProperty(data, "system.level", fixNum(foundry.utils.getProperty(data,"system.level")));
      foundry.utils.setProperty(data, "system.chipLevel", fixNum(foundry.utils.getProperty(data,"system.chipLevel")));
    }

    const legacy = foundry.utils.getProperty(data, "system.chipped");
    if (legacy !== undefined) {
      foundry.utils.setProperty(data, "system.isChipped", !!legacy);
      if (data.system && "chipped" in data.system) delete data.system.chipped;
    }

    await this.item.update(data);
  }
}
