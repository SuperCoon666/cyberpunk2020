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
    updates["prototypeToken.actorLink"] = true;
    updates["prototypeToken.sight.enabled"] = true;
  }
  
  // Check if we have skills already, don't wipe skill items if we do
  let firstSkill = data.items.find(item => item.type === 'skill');
  if (!firstSkill) {
    // Using toObject is important - foundry REALLY doesn't like creating new documents from documents themselves
    const skillsData = 
      sortSkills(await getDefaultSkills(), SortOrders.Name)
      .map(item => item); 
      // Убираем дополнительное присвоение localizationKey, так как оно уже есть
      // Remove the additional assignment of localizationKey, as it already exists
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

    // Reflex is affected by encumbrance values too
    stats.ref.armorMod = 0;
    equippedItems.filter(i => i.type === "armor").forEach(armor => {
      let armorData = armor.system;
      if(armorData.encumbrance != null) {
        stats.ref.armorMod -= armorData.encumbrance;
      }

      // While we're looping through armor, might as well modify hit locations' armor
      // I. Version of the direct addition of armor. In the future, can add it as an additional option in the settings
      // for(let armorArea in armorData.coverage) {
      //   let location = system.hitLocations[armorArea];
      //   if(location !== undefined) {
      //     armorArea = armorData.coverage[armorArea];
      //     // Преобразование обоих значений в числа перед сложением
      //     location.stoppingPower = Number(location.stoppingPower) + Number(armorArea.stoppingPower);
      //   }
      // }
      
      // II. The version of the addition of armor according to the rule book
      for(let armorArea in armorData.coverage) {
        let location = system.hitLocations[armorArea];
        if(location !== undefined) {
          let armorValue = armorData.coverage[armorArea].stoppingPower;
            let locationStoppingPower = Number(location.stoppingPower);
            let armorStoppingPower = Number(armorValue);

            // If there is no armor on one of the zones, just add armor
            if(locationStoppingPower === 0 || armorStoppingPower === 0) {
                location.stoppingPower = locationStoppingPower + armorStoppingPower;
            } else {
                // If the armor is already on, we count it according to the modification table
                let difference = Math.abs(locationStoppingPower - armorStoppingPower);
                let maxValue = Math.max(locationStoppingPower, armorStoppingPower);
                let modifier = 0;

                if (difference >= 27) modifier = 0;
                else if (difference >= 21) modifier = 2;
                else if (difference >= 15) modifier = 3;
                else if (difference >= 9) modifier = 3;
                else if (difference >= 5) modifier = 4;
                else modifier = 5;

                // Adding the modifier to the highest value
                location.stoppingPower = maxValue + modifier;
            }
        }
      }

    });
    stats.ref.total = stats.ref.base + stats.ref.tempMod + stats.ref.armorMod;

    const move = stats.ma;
    move.run = move.total * 3;
    move.leap = Math.floor(move.run / 4); 

    const body = stats.bt;
    body.carry = body.total * 10;
    body.lift = body.total * 40;
    body.modifier = btmFromBT(body.total);
    system.carryWeight = 0;
    equippedItems.forEach(item => {
      let weight = item.system.weight || 0;
      system.carryWeight += parseFloat(weight);
    });

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
    // calculate and configure the humanity
    const emp = stats.emp;
    emp.humanity = {base: emp.base * 10};
    // calculate total HL from cyberware
    let hl = 0;
    equippedItems.filter(i => i.type === "cyberware").forEach(cyberware => {
      const cyber = cyberware.system;
      hl += (cyber.humanityLoss) ? cyber.humanityLoss : 0;
    });

    emp.humanity.loss = hl;
    // calculate current Humanity and current EMP
    emp.humanity.total = emp.humanity.base - emp.humanity.loss;
    emp.total = emp.base + emp.tempMod - Math.floor(emp.humanity.loss/10);
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

  // TODO: Again, will not work if skill names localized
  // UPD: It should work now
  trainedMartials() {
    return this.itemTypes.skill
      .filter(skill => skill.system.localizationKey && skill.system.localizationKey.startsWith("CYBERPUNK.SkillMartialArts"))
      .filter(skill => skill.system.level > 0)
      .map(skill => skill.system.localizationKey);
  }  

  // TODO: Make this doable with just skill name
  static realSkillValue(skill) {
    // Sometimes we use this to sort raw item data before it becomes a full-fledged item. So we use either system or data, as needed
    let data = skill.system || skill;
    let value = data.level;
    if(data.isChipped) {
      value = data.chipLevel || 0;
    }
    return value;
  }

  getSkillVal(skillLocalizationKey) {
    if (!skillLocalizationKey) {
      console.warn(`Ключ локализации навыка не определён`);
      return 0;
    }

    console.log(`Получен навык "${skillLocalizationKey}" у персонажа "${this.name}"`);
  
    // Удаляем логику добавления префикса
    // if (!skillLocalizationKey.startsWith("CYBERPUNK.Skill")) {
    //   skillLocalizationKey = `CYBERPUNK.Skill${skillLocalizationKey}`;
    // }
  
    // Удаляем возможные пробелы в начале и конце строки
    skillLocalizationKey = skillLocalizationKey.trim();

    console.log(`Поиск навыка с ключом "${skillLocalizationKey}" у персонажа "${this.name}"`);

    const skill = this.itemTypes.skill.find(skill => skill.system.localizationKey === skillLocalizationKey);

    if (!skill) {
      console.warn(`Навык с ключом "${skillLocalizationKey}" не найден у персонажа "${this.name}"`);
      return 0;
    }

    return CyberpunkActor.realSkillValue(skill);
  }  
  

  rollSkill(skillId) {
    let skill = this.items.get(skillId);
    let skillData = skill.system;
    let value = CyberpunkActor.realSkillValue(skill);

    let rollParts = [];
    rollParts.push(value);

    if(skillData.stat) {
      rollParts.push(`@stats.${skillData.stat}.total`);
    }
    // TODO: When using localized names for skills, this will not work
    // UPD: It should work now
    const awarenessNoticeName = game.i18n.localize("CYBERPUNK.SkillAwarenessNotice");
    if (skill.name === awarenessNoticeName) {
      rollParts.push("@skills.CombatSense.value");
    }    

    let roll = new Multiroll(skill.name)
      .addRoll(makeD10Roll(rollParts, this.system));

    roll.defaultExecute();
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
  async addToCombatAndRollInitiative(options = {createCombatants: true}) {
    if(!game.combat) {
      ui.notifications.error(localize("NoCombatError"));
      return;
    }

    // This... doesn't seem to actually roll the iniative, and the docs aren't telling in how to make this function do so
    // So for now, we're going to have to add them to the combat, then ask the combat very nicely to roll this actor please
    return this.rollInitiative(options = options).then( (combat) => {
      combat.rollInitiative([combat.getCombatantByActor(this).id]);
    });
  }

  rollStunDeath() {
    let rolls = new Multiroll(localize("StunDeathSave"), localize("UnderThresholdMessage"));
    rolls.addRoll(new Roll("1d10"), {
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
