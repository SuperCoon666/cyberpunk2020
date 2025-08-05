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

  /* -------------------------------------------- */

  /** @override */
  setPosition(options = {}) {
    const position = super.setPosition(options);
    const sheetBody = this.element.find(".sheet-body");
    const bodyHeight = position.height - 192;
    sheetBody.css("height", bodyHeight);
    return position;
  }

  /* -------------------------------------------- */

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    // Everything below here is only needed if the sheet is editable
    if (!this.options.editable) return;

    // Roll handlers, click handlers, etc. would go here, same as actor sheet.
    html.find(".item-roll").click(this.item.roll.bind(this));

    html.find(".accel").click(() => this.item.accel());
    html.find(".decel").click(() => this.item.accel(true));
    
    // roll for humanity loss on cyberware 
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
      foundry.utils.setProperty(data, "system.level",     fixNum(foundry.utils.getProperty(data,"system.level")));
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
