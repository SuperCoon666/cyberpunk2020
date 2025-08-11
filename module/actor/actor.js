import { makeD10Roll, Multiroll } from "../dice.js";
import { SortOrders, sortSkills } from "./skill-sort.js";
import { btmFromBT } from "../lookups.js";
import { properCase, localize, getDefaultSkills } from "../utils.js"

/**
 * Extend the base Actor document by defining a custom roll data structure which is ideal for the Simple system.
 * @extends {Actor}
 */
export class CyberpunkActor extends Actor {


  /** @override */
  async _onCreate(data, options={}) {
    const updates = {_id: data._id};
    if (data.type === "character" ) {
      updates["img"] = "systems/cyberpunk2020/img/edgerunner.svg";
      updates["prototypeToken.texture.src"] = "systems/cyberpunk2020/img/edgerunner.svg";
      updates["prototypeToken.actorLink"] = true;
      updates["prototypeToken.sight.enabled"] = true;
      updates["system.icon"] = "systems/cyberpunk2020/img/edgerunner.svg";
    }
    
    // Check if we have skills already, don't wipe skill items if we do
    let firstSkill = data.items.find(item => item.type === 'skill');
    if (!firstSkill) {
      // Using toObject is important - foundry REALLY doesn't like creating new documents from documents themselves
      const skillsData = 
        sortSkills(await getDefaultSkills(), SortOrders.Name)
        .map(item => item.toObject());
      updates.items = [];
      updates.items = data.items.concat(skillsData);
      updates["system.skillsSortedBy"] = "Name";
      this.update(updates);
    }
  }

  /**
   * Augment the basic actor data with additional dynamic data - the stuff that's calculated from other data
   */
  prepareData() {
    super.prepareData();
    // Make separate methods for each Actor type (character, npc, etc.) to keep
    // things organized.
    switch ( this.type ) {
      // NPCs are exactly the same as characters at the moment, but don't get vision or default actorlink
      case "npc":
      case "character":
        this._prepareCharacterData(this.system);
        break;
    }
  }

  /**
   * Prepare Character type specific data
   */
  _prepareCharacterData(system) {
    const stats = system.stats;
    // Calculate stat totals using base+temp
    for(const stat of Object.values(stats)) {
      stat.total = stat.base + stat.tempMod;
    }
    // A lookup for translating hit rolls to names of hit locations
    // I know that for ranges there are better data structures to lookup, but we're using d10s for hit locations, so it's no issue
    system.hitLocLookup = {};
    for(const hitLoc in system.hitLocations) {
      let area = system.hitLocations[hitLoc]
      area.stoppingPower = 0;
      let [start, end] = area.location;
      // Just one die number that'll hit the location
      if(!end) {
        system.hitLocLookup[start] = hitLoc;
      }
      // A range of die numbers that'll hit the location
      else {
        for(let i = start; i <= end; i++) {
          system.hitLocLookup[i] = hitLoc;
        }
      }
    }
    
    // Sort through this now so we don't have to later
    let equippedItems = this.items.contents.filter(item => {
      return item.system.equipped;
    });

    // Cyberware (Characteristic): apply stat bonuses
    Object.values(stats).forEach(s => { s.cyberMod = 0; });

    const charCw = equippedItems
      .filter(i => i.type === "cyberware" && i.system?.CyberWorkType?.Type === "Characteristic");

    for (const cw of charCw) {
      const add = cw.system?.CyberWorkType?.Stat || {};
      for (const [key, val] of Object.entries(add)) {
        const n = Number(val) || 0;
        if (!n) continue;
        if (!stats[key]) continue;

        stats[key].cyberMod += n;

        if (key !== "emp") {
          stats[key].total += n;
        }
      }
    }

    // Reflex is affected by encumbrance values too
    stats.ref.armorMod = 0;
    let totalEncumbrance = 0;

    const combineSP = (curr, add) => {
      const a = Number(curr) || 0;
      const b = Number(add) || 0;
      if (!a || !b) return a + b;
      const diff = Math.abs(a - b);
      const max = Math.max(a, b);
      let mod = 0;
      if (diff >= 27) mod = 0;
      else if (diff >= 21) mod = 2;
      else if (diff >= 15) mod = 3;
      else if (diff >= 9) mod = 3;
      else if (diff >= 5) mod = 4;
      else mod = 5;
      return max + mod;
    };

    // Equipped cyber-armor implants (once)
    const cwArmorItems = (equippedItems || [])
      .filter(i => i.type === "cyberware" && i.system?.CyberWorkType?.Type === "Armor");

    // Inventory armor: accumulate EV and layer SP
    equippedItems.filter(i => i.type === "armor").forEach(armor => {
      const armorData = armor.system;
      totalEncumbrance += Number(armorData.encumbrance || 0);

      for (const armorArea in armorData.coverage) {
        const location = system.hitLocations[armorArea];
        if (!location) continue;
        const addSP = Number(armorData.coverage[armorArea].stoppingPower) || 0;
        location.stoppingPower = combineSP(location.stoppingPower, addSP);
      }
    });

    // Cyber-armor: layer SP once after inventory armor
    for (const cw of cwArmorItems) {
      const locs = cw.system?.CyberWorkType?.Locations || {};
      for (const [areaKey, sp] of Object.entries(locs)) {
        const loc = system.hitLocations[areaKey];
        const addSP = Number(sp) || 0;
        if (!loc || addSP <= 0) continue;
        loc.stoppingPower = combineSP(loc.stoppingPower, addSP);
      }
    }

    // Cyber-armor EV: add to total encumbrance
    for (const cw of cwArmorItems) {
      const evImpl = Number(cw.system?.CyberWorkType?.Encumbrance ?? cw.system?.encumbrance ?? 0);
      totalEncumbrance += evImpl;
    }

    // Final REF penalty: subtract full total EV
    stats.ref.armorMod -= totalEncumbrance;
    stats.ref.total += stats.ref.armorMod;

    // Penalties from cyber-armor to stats
    for (const s of Object.values(system.stats)) s.armorImplantMod = 0;
    for (const cw of cwArmorItems) {
      const pens = cw.system?.CyberWorkType?.Penalties || {};
      for (const [statKey, val] of Object.entries(pens)) {
        const n = Number(val) || 0;
        if (!n || !system.stats[statKey]) continue;
        system.stats[statKey].armorImplantMod -= n;
      }
    }
    for (const s of Object.values(system.stats)) {
      s.total += Number(s.armorImplantMod || 0);
    }

    // Apply wound effects
    // Change stat total, but leave a record of the difference in stats.[statName].woundMod
    // Modifies the very-end-total, idk if this'll need to change in the future
    let woundState = this.woundState();
    let woundStat = function(stat, totalChange) {
        let newTotal = totalChange(stat.total)
        stat.woundMod = -(stat.total - newTotal);
        stat.total = newTotal;
    }
    if(woundState >= 4) {
      [stats.ref, stats.int, stats.cool].forEach(stat => woundStat(stat, total => Math.ceil(total/3)));
    } 
    else if(woundState == 3) {
      [stats.ref, stats.int, stats.cool].forEach(stat => woundStat(stat, total => Math.ceil(total/2)));
    }
    else if(woundState == 2) {
      woundStat(stats.ref, total => total - 2);
    }
    // calculate humanity & EMP (include cyberware and temp mods before loss)
    const emp = stats.emp;

    const preLossEmp =
      (emp.base || 0) +
      (emp.tempMod || 0) +
      (emp.cyberMod || 0);

    emp.humanity = { base: preLossEmp * 10 };

    let hl = 0;
    equippedItems
      .filter(i => i.type === "cyberware")
      .forEach(cyberware => {
        hl += Number(cyberware.system?.humanityLoss || 0);
      });

    emp.humanity.loss = hl;

    emp.humanity.total = Math.max(0, emp.humanity.base - emp.humanity.loss);
    emp.total = preLossEmp - Math.floor(hl / 10);

    const cwCheckMods = this._getCharacteristicChecksMods();
    system.initiativeImplantMod = Number(cwCheckMods.initiative || 0);
    system._cwChecks = { saveStun: Number(cwCheckMods.saveStun || 0) };
  }

  /**
   * 
   * @param {string} sortOrder The order to sort skills by. Options are in skill-sort.js's SortOrders. "Name" or "Stat". Default "Name".
   */
  sortSkills(sortOrder = "Name") {
    let allSkills = this.itemTypes.skill;
    sortOrder = sortOrder || Object.keys(SortOrders)[0];
    console.log(`Sorting skills by ${sortOrder}`);
    let sortedView = sortSkills(allSkills, SortOrders[sortOrder]).map(skill => skill.id);

    // Technically UI info, but we don't wanna calc every time we open a sheet so store it in the actor.
    this.update({
      // Why is it that when storing Item: {data: {data: {innerdata}}}, it comes out as {data: {innerdata}}
      "system.sortedSkillIDs": sortedView,
      "system.skillsSortedBy": sortOrder
    });
  }

  /**
   * Get a body type modifier from the body type stat (body)
   * I couldn't figure out a single formula that'd work for it (cos of the weird widths of BT values)
   */
  static btm(body) {
    
  }

  // Current wound state. 0 for uninjured, going up by 1 for each new one. 1 for Light, 2 Serious, 3 Critical etc.
  woundState() {
    const damage = this.system.damage;
    if(damage == 0) return 0;
    // Wound slots are 4 wide, so divide by 4, ceil the result
    return Math.ceil(damage/4);
  }


  stunThreshold() {
    const body = this.system.stats.bt.total;
    // +1 as Light has no penalty, but is 1 from woundState()
    return body - this.woundState() + 1; 
  }

  deathThreshold() {
    // The first wound state to penalise is Mortal 1 instead of Serious.
    return this.stunThreshold() + 3;
  }

  trainedMartials() {
    return this.itemTypes.skill
      .filter(skill => skill.name.startsWith(localize("Martial")))
      .filter(martial => martial.system.level > 0)
      .map(martial => martial.name);
  }

  // TODO: Make this doable with just skill name
  static realSkillValue(skill) {
    // Sometimes we use this to sort raw item data before it becomes a full-fledged item. So we use either system or data, as needed
    if (!skill) return 0;
    const data = skill.system ?? skill;
    let value = Number(data.level) || 0;
    if (data.isChipped) value = Number(data.chipLevel) || 0;
    return value;
  }

  getSkillVal(skillName) {
    console.log("SkillName:", skillName);
    console.log("SkillName_localize:", localize("Skill"+skillName));
    console.log("lang:", game.i18n);

    const nameLoc = localize("Skill" + skillName);
    // Localization may return the original key, so we check both options
    const targetName = nameLoc.includes("Skill") ? skillName : nameLoc;

    const skillItem = this.itemTypes.skill.find(s => s.name === targetName);
    if (!skillItem) return 0; // ← no skill — return 0 instead of undefined
    return CyberpunkActor.realSkillValue(skillItem);
  }

  /**
   * Skill check with Advantage / Disadvantage taken into account
   * @param {string}  skillId
   * @param {number}  extraMod
   * @param {boolean} advantage
   * @param {boolean} disadvantage
   */
  rollSkill(skillId, extraMod = 0, advantage = false, disadvantage = false) {
    const skill = this.items.get(skillId);
    if (!skill) return;

    // generate the list of modifiers
    const parts = [
      CyberpunkActor.realSkillValue(skill),
      skill.system.stat ? `@stats.${skill.system.stat}.total` : null,
      skill.name === localize("SkillAwarenessNotice") ? "@CombatSenseMod" : null,
      extraMod || null
    ].filter(Boolean);

    // Roll modifier from implants (Characteristic)
    const cMod = this._getCharacteristicSkillMod(skill.name);
    if (cMod) parts.push(cMod);

    const makeRoll = () => makeD10Roll(parts, this.system);   // d10 + parts

    // if both are accidentally marked — ignore
    if (advantage && disadvantage) { advantage = disadvantage = false; }

    // Advantage / Disadvantage
    if (advantage || disadvantage) {
      const r1 = makeRoll();
      const r2 = makeRoll();

      Promise.all([
        r1.evaluate(),
        r2.evaluate()
      ]).then(() => {
        const chosen = advantage
          ? (r1.total >= r2.total ? r1 : r2)   // best
          : (r1.total <= r2.total ? r1 : r2);  // worst

        new Multiroll(skill.name)
          .addRoll(chosen)
          .defaultExecute();
      });
      return;
    }

    // normal roll
    new Multiroll(skill.name)
      .addRoll(makeRoll())
      .defaultExecute();
  }

  /**
   * Sum of skill roll modifiers from equipped implants of type Characteristic.
   * Keys in the implant are the displayed (localized) skill names, same as skill.name.
   * @param {string} skillName
   * @returns {number}
  */
  _getCharacteristicSkillMod(skillName) {
    let total = 0;

    for (const it of this.items) {
      if (it.type !== "cyberware") continue;

      const sys = it.system;
      if (!sys?.equipped) continue;

      const cwt = sys.CyberWorkType;
      if (!cwt || cwt.Type !== "Characteristic") continue;

      const table = cwt.Skill || {};
      const v = Number(table[skillName]) || 0;
      if (!Number.isNaN(v)) total += v;
    }

    return total;
  }

  /**
   * Sum check modifiers from equipped implants of type "Characteristic".
   * Returns { initiative, saves, stun }.
  */
  _getCharacteristicChecksMods() {
    const mods = { initiative: 0, saveStun: 0 };

    for (const it of this.items) {
      if (it.type !== "cyberware") continue;
      const sys = it.system || {};
      if (!sys.equipped) continue;
      if (sys?.CyberWorkType?.Type !== "Characteristic") continue;

      const checks = sys.CyberWorkType?.Checks || {};
      mods.initiative += Number(checks.Initiative || 0) || 0;
      mods.saveStun += Number(checks.SaveStun || 0) || 0;
    }

    return mods;
  }

  rollStat(statName) {
    let fullStatName = localize(properCase(statName) + "Full");
    let roll = new Multiroll(fullStatName);
    roll.addRoll(makeD10Roll(
      [`@stats.${statName}.total`],
      this.system
    ));
    roll.defaultExecute();
  }

  /*
   * Adds this actor to the current encounter - if there isn't one, this just shows an error - and rolls their initiative
   */
  async addToCombatAndRollInitiative(modificator, options = {createCombatants: true}) {
    if(!game.combat) {
      ui.notifications.error(localize("NoCombatError"));
      return;
    }
  
    console.log(modificator);
  
    const combat = game.combat;
    let combatant = combat.combatants.find(c => c.actorId === this.id);
  
    // If no combatant found and creation is allowed, add the actor to the combat
    if (!combatant && options.createCombatants) {
      await combat.createEmbeddedDocuments("Combatant", [{ actorId: this.id }]);
      combatant = combat.combatants.find(c => c.actorId === this.id);
    }    
  
    if (!combatant) {
      ui.notifications.error(localize("NoCombatantForActor"));
      return;
    }
  
    // Roll initiative for the combatant
    return combat.rollInitiative([combatant.id]);
  }  

  rollStunDeath(modificator) {
    let rolls = new Multiroll(localize("StunDeathSave"), localize("UnderThresholdMessage"));
    
    const integerRegex = /^-?\d+$/;
    if(modificator && !integerRegex.test(modificator)){
      return
    }

    const fromImplants = Number(this.system?._cwChecks?.saveStun || 0);

    const userMod = modificator ? parseInt(modificator, 10) : 0;
    const totalMod = userMod + fromImplants;

    const rollType = "1d10";
    const formula = totalMod ? `${rollType} + ${totalMod}` : rollType;

    rolls.addRoll(new Roll(formula), {
      name: localize("Save")
    });
    rolls.addRoll(new Roll(`${this.stunThreshold()}`), {
      name: "Stun Threshold"
    });
    rolls.addRoll(new Roll(`${this.deathThreshold()}`), {
      name: "Death Threshold"
    });
    rolls.defaultExecute();
  }
}
