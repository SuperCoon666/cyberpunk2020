import { weaponTypes, rangedAttackTypes, meleeAttackTypes, fireModes, ranges, rangeDCs, rangeResolve, attackSkills, martialActions, strengthDamageBonus } from "../lookups.js"
import { Multiroll, makeD10Roll }  from "../dice.js"
import { clamp, deepLookup, localize, localizeParam, rollLocation } from "../utils.js"
import { CyberpunkActor } from "../actor/actor.js";

/**
 * Extend the basic Item with some very simple modifications.
 * @extends {Item}
 */
export class CyberpunkItem extends Item {
  // This also has preparedata, but we don't have to worry about that so far

  prepareData() {
    super.prepareData();

    switch(this.type) {
      case "weapon":
        this._prepareWeaponData(this.system);
        break;
      case "armor":
        this._prepareArmorData(this.system);
        break;
    }
  }

  isRanged() {
    let system = this.system;
    return !(system.weaponType === "Melee" || system.weaponType === "Exotic" && Object.keys(meleeAttackTypes).includes(system.attackType));
  }
  
  _prepareWeaponData(data) {
    
  }

  _prepareArmorData(system) {
    // If new owner and armor covers this many areas or more, delete armor coverage areas the owner does not have
    const COVERAGE_CLEANSE_THRESHOLD = 20;

    let skipReform = false;
    // Sometimes this just BREAKS
    try {
      let idCheck = this.actor.id;
    }
    catch {
      skipReform = true;
    }

    let nowOwned = !system.lastOwnerId && this.actor;
    let changedHands = system.lastOwnerId !== undefined && system.lastOwnerId != this.actor.id;
    if(!skipReform && (nowOwned || changedHands)) {
      system.lastOwnerId = this.actor.id;
      let ownerLocs = this.actor.system.hitLocations;
      
      // Time to morph the armor to its new owner!
      // I just want this here so people can armor up giant robotic snakes if they want, y'know? or mechs.
      // ...I am fully aware this is overkill effort for most games.
      let areasCovered = Object.keys(system.coverage).length;
      let cleanseAreas = areasCovered > COVERAGE_CLEANSE_THRESHOLD;
      if(cleanseAreas) {
        // Remove any extra areas
        // This is so that armors can't be made bigger indefinitely. No idea why players might do that, but hey.
        for(let armorArea in system.coverage) {
          if(!ownerLocs[armorArea]) {
            console.warn(`ARMOR MORPH: The new owner of this armor (${this.actor.name}) does not have a ${armorArea}. Removing the area from the armor.`)
            delete system.coverage.armorArea;
          }
        }
      }
      
      // TODO: Strict bodytypes option?
      // Add any areas the owner has but the armor doesn't.
      for(let ownerLoc in ownerLocs) {
        if(!system.coverage[ownerLoc]) {
          system.coverage[ownerLoc] = {
            stoppingPower: 0,
            ablation: 0
          }
        }
      }
    }
  }

  /**
   * Handle clickable rolls.
   * @param {Event} event   The originating click event
   * @private
   */
  async roll() {
    // This is where the item would make a roll in the chat or something like that.
    switch (this.type) {
      case "weapon":
        this.__weaponRoll();
        break;

      default:
        break;
    }
  }

  // TODO: For 0.8.1, we want to also add flavor text to the different modifiers
  // Get the roll modifiers to add when given a certain set of modifiers
  __shootModTerms({
    aimRounds,
    ambush,
    blinded,
    dualWield,
    fastDraw,
    hipfire,
    ricochet,
    running,
    targetArea,
    turningToFace,
    range,
    fireMode,
    extraMod
  }) {
    let terms = []
    if(!!targetArea) {
      terms.push(-4);
    }
    // Man I want language macros here...
    if(aimRounds && aimRounds > 0) {
      terms.push(aimRounds);
    }
    if(ambush) {
      terms.push(5);
    }
    if(blinded) {
      terms.push(-3);
    }
    if(dualWield) {
      terms.push(-3);
    }
    if(fastDraw) {
      terms.push(-3);
    }
    if(hipfire) {
      terms.push(-2);
    }
    if(ricochet) {
      terms.push(-5);
    }
    if(running) {
      terms.push(-3);
    }
    if(turningToFace) {
      terms.push(-2);
    }

    // Range on its own doesn't actually apply a modifier - it only affects to-hit rolls. But it does affect certain fire modes.
    // For now assume full auto = all bullets; spray and pray
    // +1/-1 per 10 bullets fired. + if close, - if medium onwards.
    // Friend's copy of the rulebook states penalties/bonus for all except point blank
    if(fireMode === fireModes.fullAuto) {
      let bullets = Math.min(this.system.shotsLeft, this.system.rof);
      // If close range, add, else subtract
      let multiplier = 
          (range === ranges.close) ? 1 
        : (range === ranges.pointBlank) ? 0 
        : -1;
      terms.push(multiplier * Math.floor(bullets/10))
    }

    // +3 mod for 3-round-burst at close or medium range
    if(fireMode === fireModes.threeRoundBurst
      && (range === ranges.close || range === ranges.medium)) {
        terms.push(+3);
    }

    // We always want to push extraMod, making it explicit it's ALWAYS there even with 0
    terms.push(extraMod || 0);

    return terms;
  }

  // Melee mods are a lot...simpler? I could maybe add swept or something, or opponent dodging. That'll be best once choosing targets is done
  __meleeModTerms({extraMod}) {
    return [extraMod];
  }

  // Now, this is gonna have to ask the player for different things depending on the weapon
  // Apply modifiers first? p99 in book
  // Crit fail jam roll

  // p106
  // Automatic weapon? choose between 3-round burst, full-auto and suppressive fire
  // 3-round = 1 target
  // full-auto = as many targets as you wish cos screw you
  // Suppressive fire? choose an area. save is rof/width area, minimum 2m

  // Laser? How much of the charge are you using?
  // Microwaver? regular attack, though includes path, but also roll on microwaver table

  // Area effect. Miss? Roll direction, roll meters away
  // Shotgun? Width depends on distance from character
  // Grenades have fixed width. Throw up to 10xBOD
  // Gas? Wind effect. Dear lord.

  // Let's just pretend the unusual ranged doesn't exist for now
  // Look into `modifiers.js` for the modifier obect
  __weaponRoll(attackMods, targetTokens) {
    let owner = this.actor;
    let system = this.system;
    if (owner === null) {
      throw new Error("This item isn't owned by anyone.");
    }
    let isRanged = this.isRanged();
    if(!isRanged) {
      if(system.attackType === meleeAttackTypes.martial) {
        return this.__martialBonk(attackMods);
      }
      else {
        return this.__meleeBonk(attackMods);
      }
    }

    // ---- Firemode-specific rolling. I may roll together some common aspects later ----
    // Full auto
    if(attackMods.fireMode === fireModes.fullAuto) {
      return this.__fullAuto(attackMods, targetTokens);
    }
    // Three-round burst. Shares... a lot in common with full auto actually
    else if(attackMods.fireMode === fireModes.threeRoundBurst) {
      return this.__threeRoundBurst(attackMods);
    }
    else if(attackMods.fireMode === fireModes.semiAuto) {
      return this.__semiAuto(attackMods);
    }
  }

  __getFireModes() {
    if(this.type !== "weapon") {
      console.error(`${this.name} is not a weapon, and therefore has no fire modes`)
      return [];
    }
    if(this.system.attackType === rangedAttackTypes.auto
      || this.system.attackType === rangedAttackTypes.autoshotgun) {
      return [fireModes.fullAuto, fireModes.suppressive, fireModes.threeRoundBurst, fireModes.semiAuto];
    }
    return [fireModes.semiAuto];
  }

  // Roll just the attack roll of a weapon, return it
  async attackRoll(attackMods) {
    let system = this.system;
    let isRanged = this.isRanged();

    let attackTerms = ["@stats.ref.total"];
    if(system.attackSkill) {
      attackTerms.push(`@attackSkill`);
    }
    if(isRanged) {
      attackTerms.push(...(this.__shootModTerms(attackMods)));
    }
    else {
      attackTerms.push(...(this.__meleeModTerms(attackMods)));
    }
    if(system.accuracy) {
      attackTerms.push(system.accuracy);
    }

    return await makeD10Roll(attackTerms, {
      stats: this.actor.system.stats,
      attackSkill: this.actor.getSkillVal(this.system.attackSkill)
    }).evaluate();
  }

  /**
   * Fire an automatic weapon at full auto
   * @param {*} attackMods The modifiers for an attack. fireMode, ambush, etc - look in lookups.js for the specification of these
   * @returns 
   */
  async __fullAuto(attackMods, targetTokens) {
    let system = this.system;
    // The kind of distance we're attacking at, so we can display Close: <50m or something like that
    let actualRangeBracket = rangeResolve[attackMods.range](system.range);
    let DC = rangeDCs[attackMods.range];
    let targetCount = targetTokens.length || attackMods.targetsCount || 1;
    
    // This is a somewhat flawed multi-target thing - given target tokens, we could calculate distance (& therefore penalty) for each, and apply damage to them
    let rolls = [];
    for (let i = 0; i < targetCount; i++) {
      let attackRoll = await this.attackRoll(attackMods);
      let roundsFired = Math.min(system.shotsLeft, system.rof / targetCount);
      await this.update({"system.shotsLeft": system.shotsLeft - roundsFired})
      let roundsHit = Math.min(roundsFired, attackRoll.total - DC);
      if(roundsHit < 0) {
        roundsHit = 0;
      }
      let areaDamages = {};
      // Roll damage for each of the bullets that hit
      for(let i = 0; i < roundsHit; i++) {
        let damageRoll = await new Roll(system.damage).evaluate();
        let location = (await rollLocation(attackMods.targetActor, attackMods.targetArea)).areaHit;
        if(!areaDamages[location]) {
          areaDamages[location] = [];
        }
        areaDamages[location].push(damageRoll);
      }
      let templateData = {
        target: targetTokens[i] || undefined,
        range: attackMods.range,
        toHit: DC,
        attackRoll: attackRoll,
        fired: roundsFired,
        hits: roundsHit,
        hit: roundsHit > 0,
        areaDamages: areaDamages,
        locals: {
          range: { range: actualRangeBracket }
        }
      }
      let roll = new Multiroll(`${localize("Autofire")}`, `${localize("Range")}: ${localizeParam(attackMods.range, {range: actualRangeBracket})}`);
      roll.execute(undefined, "systems/cyberpunk2020/templates/chat/multi-hit.hbs", templateData);
      rolls.push(roll);
    }
    return rolls;
  }

  async __threeRoundBurst(attackMods) {
    let system = this.system;
    // The kind of distance we're attacking at, so we can display Close: <50m or something like that
    let actualRangeBracket = rangeResolve[attackMods.range](system.range);
    let DC = rangeDCs[attackMods.range];
    let attackRoll = await this.attackRoll(attackMods);

    let roundsFired = Math.min(system.shotsLeft, system.rof, 3);
    let attackHits = attackRoll.total >= DC;
    let areaDamages = {};
    let roundsHit;
    if(attackHits) {
      // In RAW this is 1d6/2, but this is functionally the same
      roundsHit = await new Roll("1d3").evaluate();
      for(let i = 0; i < roundsHit.total; i++) {
        let damageRoll = await new Roll(system.damage).evaluate();
        let location = (await rollLocation(attackMods.targetActor, attackMods.targetArea)).areaHit;
        if(!areaDamages[location]) {
          areaDamages[location] = [];
        }
        areaDamages[location].push(damageRoll);
      }
    }
    let templateData = {
      range: attackMods.range,
      toHit: DC,
      attackRoll: attackRoll,
      fired: roundsFired,
      hits: attackHits ? roundsHit.total : 0,
      hit: attackHits,
      areaDamages: areaDamages,
      locals: {
        range: { range: actualRangeBracket }
      }
    }
    let roll = new Multiroll(localize("ThreeRoundBurst"));
    roll.execute(undefined, "systems/cyberpunk2020/templates/chat/multi-hit.hbs", templateData);
    this.update({"system.shotsLeft": system.shotsLeft - roundsFired})
    return roll;
  }

  async __semiAuto(attackMods) {
    let system = this.system;
    // The range we're shooting at
    let DC = rangeDCs[attackMods.range];
    let attackRoll = await this.attackRoll(attackMods);
    let damageRoll = new Roll(this.system.damage);
    let locationRoll = await rollLocation(attackMods.targetActor, attackMods.targetArea);

    let bigRoll = new Multiroll(this.name, this.system.flavor)
      .addRoll(new Roll(`${DC}`), {name: localize("ToHit")})
      .addRoll(attackRoll, {name: localize("Attack")})
      .addRoll(damageRoll, {name: localize("Damage")})
      .addRoll(locationRoll.roll, {name: localize("Location"), flavor: locationRoll.areaHit });
    bigRoll.defaultExecute({img:this.img});
    this.update({"system.shotsLeft": system.shotsLeft - 1})
    return bigRoll;
  }
  async __meleeBonk(attackMods) {
    // Just doesn't have a DC - is contested instead
    let attackRoll = await this.attackRoll(attackMods);
    let damageRoll = new Roll(`${this.system.damage}+@strengthBonus`, {
      strengthBonus: strengthDamageBonus(this.actor.system.stats.bt.total)
    });
    let locationRoll = await rollLocation(attackMods.targetActor, attackMods.targetArea);

    let bigRoll = new Multiroll(this.name, this.system.flavor)
      .addRoll(attackRoll, {name: localize("Attack")})
      .addRoll(damageRoll, {name: localize("Damage")})
      .addRoll(locationRoll.roll, {name: localize("Location"), flavor: locationRoll.areaHit });
    bigRoll.defaultExecute({img:this.img});
    return bigRoll;
  }
  async __martialBonk(attackMods) {
    let actor = this.actor;
    let system = actor.system;
    // Action being done, eg strike, block etc
    let action = attackMods.action;
    let martialArt = attackMods.martialArt;

    // Will be something this line once I add the martial arts bonuses. None for brawling, remember
    // let martialBonus = this.actor?.skills.MartialArts[martialArt].bonuses[action];
    let isMartial = martialArt != "Brawling";
    let keyTechniqueBonus = 0;
    let martialSkillLevel = actor.getSkillVal(martialArt);
    let flavor = game.i18n.has(`CYBERPUNK.${action + "Text"}`) ? localize(action + "Text") : "";

    let results = new Multiroll(localizeParam("MartialTitle", {action: localize(action), martialArt: localize("Skill" + martialArt)}), flavor);

    // All martial arts are contested
    let attackRoll = new Roll(`1d10x10+@stats.ref.total+@attackBonus+@keyTechniqueBonus`, {
      stats: system.stats,
      attackBonus: martialSkillLevel,
      keyTechniqueBonus: keyTechniqueBonus,
    });
    results.addRoll(attackRoll, {name: "Attack"});
    let damageFormula = "";

    // Directly damaging things
    if(action == martialActions.strike) {
      damageFormula = "1d3+@strengthBonus+@martialDamageBonus";
    }
    else if([martialActions.kick, martialActions.throw, martialActions.choke].includes(action)) {
      damageFormula = "1d6+@strengthBonus+@martialDamageBonus"; // Seriously, WHY is kicking objectively better?!
    }

    if(damageFormula !== "") {
      let loc = await rollLocation(attackMods.targetArea);
      results.addRoll(loc.roll, {name: localize("Location"), flavor: loc.areaHit});
      results.addRoll(new Roll(damageFormula, {
        strengthBonus: strengthDamageBonus(system.stats.bt.total),
        // Martial arts get a damage bonus.
        martialDamageBonus: isMartial ? martialSkillLevel : 0
      }), {name: localize("Damage")});
    }
    results.defaultExecute({img: this.img});
    return results;
  }

  /**
   * Accelerate a vehicle
   * @param {boolean} decelerate: Are we decelerating instead of accelerating?
   * @returns 
   */
  accel(decelerate = false) {
    if(this.type !== "vehicle")
      return;
    
    let speed = this.system.speed;
    let accelAdd = speed.acceleration * (decelerate ? -1 : 1);
    let newSpeed = clamp(speed.value + accelAdd, 0, speed.max);
    return this.update({
      "system.speed.value": newSpeed
    });
  }
}
