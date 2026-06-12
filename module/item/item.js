import { weaponTypes, rangedAttackTypes, meleeAttackTypes, fireModes, ranges, rangeDCs, rangeResolve, strengthDamageBonus, getMartialActionBonus, martialActions, isFnff2Enabled, getFnff2DamageBonusSymbol, FNFF2_ONLY_MARTIAL_ART_IDS } from "../lookups.js"
import { Multiroll, makeD10Roll } from "../dice.js"
import { localize, localizeParam, rollLocation, cwHasType, cwIsEnabled, isFumbleRoll, buildRangedCombatFumbleData, buildSkillFumbleData, clamp } from "../utils.js";
import { createCyberpunkChatMessage } from "../compat.js";

/** @extends {Item} */
export class CyberpunkItem extends Item {

  /**
   * Cyberpunk 2020: any fractional damage is rounded down
   * Also clamp at 0 to avoid negative damage showing up in chat
   * @param {number} total
   * @returns {number}
   */
  static _floorDamageTotal(total) {
    const n = Number(total);
    if (!Number.isFinite(n)) return 0;

    if (n <= 0) return 0;

    return Math.max(1, Math.floor(n));
  }

  static _resolveFullAutoRounds(attackMods = {}, system = {}) {
    const rof = Math.max(0, Math.floor(Number(system?.rof) || 0));
    const shotsLeft = Math.max(0, Math.floor(Number(system?.shotsLeft) || 0));
    const maxRounds = Math.min(rof, shotsLeft);

    if (maxRounds <= 0) return 0;

    const requested = Math.floor(Number(attackMods?.fullAutoRoundsFired));
    if (!Number.isFinite(requested) || requested <= 0) return maxRounds;

    return clamp(requested, 1, maxRounds);
  }

  /**
   * Build an inline-roll anchor that shows dice results on hover (via cp-inline-roll handler).
   * Click-to-reroll is disabled globally by the system.
   * @param {number} value
   * @param {Roll} roll
   * @param {string} extraClasses
  */
  static _inlineRollHtml(value, roll, extraClasses = "") {
    const v = Number(value);
    if (!Number.isFinite(v)) return String(value ?? "");
    if (!roll || typeof roll !== "object") return String(v);

    try {
      const data = (typeof roll.toJSON === "function") ? roll.toJSON() : roll;
      const json = encodeURIComponent(JSON.stringify(data));
      const cls = String(extraClasses || "").trim();
      return `<a class="inline-roll inline-result cp-inline-roll roll-result roll ${cls}" data-roll="${json}">${v}</a>`;
    } catch (e) {
      return String(v);
    }
  }

  /** @override */
  async _preCreate(data, options, user) {
    await super._preCreate(data, options, user);

    try {
      if (this.type === "skill") {
        const id = data?._id || this._id;
        if (id && FNFF2_ONLY_MARTIAL_ART_IDS.has(id) && !isFnff2Enabled()) {
          ui?.notifications?.warn(game.i18n.localize("CYBERPUNK.FNFF2SkillDisabledWarn"));
          throw new Error("FNFF2-only Martial Arts skill cannot be added while FNFF2 is disabled.");
        }
      }
    } catch (e) {
      throw e;
    }
  }

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
  _getWeaponSystem() {
    if (this.type === "weapon") return this.system;
    const cwt = this.system?.CyberWorkType;
    if (this.type === "cyberware" && cwHasType(cwt, "Weapon")) {
      if (!cwIsEnabled(this)) return {};
      return cwt.Weapon || {};
    }
    return this.system;
  }

  async __setWeaponField(field, value) {
    if (this.type === "weapon") {
      return await this.update({[`system.${field}`]: value});
    }
    const cwt = this.system?.CyberWorkType;
    if (this.type === "cyberware" && cwHasType(this, "Weapon")) {
      return await this.update({[`system.CyberWorkType.Weapon.${field}`]: value});
    }
    return null;
  }

  isRanged() {
    const sys = this._getWeaponSystem();
    const type = String(sys?.weaponType || "").toLowerCase();
    const atk  = sys?.attackType;
    const isMeleeByType = type === "melee";
    const isMeleeByAtk  = atk && Object.values(meleeAttackTypes).includes(atk);
    return !(isMeleeByType || isMeleeByAtk);
  }

  /**
   * Firearms for the “point-blank” rule
   * We are deliberately excluding Exotic weapons here, as they include lasers, microwaves, etc
  */
  _isFirearm() {
    const sys = this._getWeaponSystem();
    const wt = sys?.weaponType;
    return [
      weaponTypes.pistol,
      weaponTypes.submachinegun,
      weaponTypes.shotgun,
      weaponTypes.rifle,
      weaponTypes.heavy
    ].includes(wt);
  }

  _shouldMaximizePointBlankDamage(attackMods) {
    return this.isRanged() && this._isFirearm() && attackMods?.range === ranges.pointBlank;
  }
  
  _prepareWeaponData(data) {
    
  }

  _prepareArmorData(system) {
    // Armor from compendiums/world items has no owning actor.
    // Armor morphing must run only for owned actor items.
    const actor = this.actor;
    if (!actor) return;

    const ownerLocs = actor.system?.hitLocations;
    if (!ownerLocs) return;

    if (!system.coverage || typeof system.coverage !== "object") {
      system.coverage = {};
    }

    // If new owner and armor covers this many areas or more,
    // delete armor coverage areas the owner does not have.
    const COVERAGE_CLEANSE_THRESHOLD = 20;

    const lastOwnerId = system.lastOwnerId ?? "";
    const nowOwned = !lastOwnerId;
    const changedHands = !!lastOwnerId && lastOwnerId !== actor.id;

    if (!(nowOwned || changedHands)) return;

    system.lastOwnerId = actor.id;

    // Time to morph the armor to its new owner.
    const areasCovered = Object.keys(system.coverage).length;
    const cleanseAreas = areasCovered > COVERAGE_CLEANSE_THRESHOLD;

    if (cleanseAreas) {
      // Remove any extra areas.
      for (const armorArea in system.coverage) {
        if (!ownerLocs[armorArea]) {
          console.warn(`ARMOR MORPH: The new owner of this armor (${actor.name}) does not have a ${armorArea}. Removing the area from the armor.`);
          delete system.coverage[armorArea];
        }
      }
    }

    // Add any areas the owner has but the armor doesn't.
    for (const ownerLoc in ownerLocs) {
      if (!system.coverage[ownerLoc]) {
        system.coverage[ownerLoc] = {
          stoppingPower: 0,
          ablation: 0
        };
      }
    }
  }

  /**
   * Handle clickable rolls.
   * @param {Event} event   The originating click event
   * @private
   */
  roll() {
    switch (this.type) {
      case "weapon":
        this.__weaponRoll();
        break;
      case "cyberware":
        if (cwHasType(this, "Weapon")) {
          if (!cwIsEnabled(this)) {
            ui?.notifications?.warn(game.i18n.localize("CYBERPUNK.CWT_WeaponDisabled"));
            break;
          }
          this.__weaponRoll();
        }
        break;
      default:
        break;
    }
  }

    _isAutoWeapon(sys) {
    const atk = sys?.attackType;
    return atk === rangedAttackTypes.auto || atk === rangedAttackTypes.autoshotgun;
  }

  async _maybeApplyRangedFumble(attackRoll) {
    if (!game.settings.get("cyberpunk2020", "fumbleTableEnabled")) return null;
    if (!isFumbleRoll(attackRoll)) return null;

    const sys = this._getWeaponSystem();
    const isAuto = this._isAutoWeapon(sys);
    const autoOnlyJam = !!game.settings.get("cyberpunk2020", "autoFumbleOnlyJam");

    const data = await buildRangedCombatFumbleData({
      item: this,
      attackRoll,
      isAutoWeapon: isAuto,
      autoOnlyJam
    });

    return {
      fumble: { title: data.title, html: data.html },
      forceMiss: true,
      outcome: data.outcome
    };
  }

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
    extraMod,
    fullAutoRoundsFired
  }) {
    const sys = this._getWeaponSystem ? this._getWeaponSystem() : this.system;
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
    // Full auto now uses the number of rounds chosen in the attack dialog, capped by ROF and remaining ammunition.
    // +1/-1 per 10 bullets fired. + if close, - if medium onwards.
    // Friend's copy of the rulebook states penalties/bonus for all except point blank
    if(fireMode === fireModes.fullAuto) {
      const bullets = CyberpunkItem._resolveFullAutoRounds({ fullAutoRoundsFired }, sys);
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
  __meleeModTerms({ extraMod, targetArea }) {
    const terms = [];

    if (!!targetArea) {
      terms.push(-4);
    }

    const n = Number(extraMod);
    if (Number.isFinite(n) && n !== 0) {
      terms.push(n);
    }

    return terms;
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
    if (this.type === "cyberware" && cwHasType(this, "Weapon") && !cwIsEnabled(this)) {
      ui?.notifications?.warn(game.i18n.localize("CYBERPUNK.CWT_WeaponDisabled"));
      return false;
    }

    let owner = this.actor;
    const system = this._getWeaponSystem();

    if (owner === null) {
      throw new Error("This item isn't owned by anyone.");
    }

    const isRanged = this.isRanged();

    if (isRanged && Number(system?.shotsLeft ?? 0) <= 0) {
      ui.notifications.warn(localize("NoAmmo"));
      return false;
    }

    if (!isRanged) {
      if (system.attackType === meleeAttackTypes.martial) {
        return this.__martialBonk(attackMods);
      } else {
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
    else if(attackMods.fireMode === fireModes.suppressive) {
      return this.__suppressiveFire(attackMods);
    }
  }

  __getFireModes() {
    const isWeaponDoc = this.type === "weapon" || (this.type === "cyberware" && cwHasType(this, "Weapon"));
    if (!isWeaponDoc) {
      console.error(`${this.name} is not a weapon, and therefore has no fire modes`);
      return [];
    }
    const sys = this._getWeaponSystem ? this._getWeaponSystem() : this.system;
    if (sys.attackType === rangedAttackTypes.auto || sys.attackType === rangedAttackTypes.autoshotgun) {
      return [fireModes.fullAuto, fireModes.suppressive, fireModes.threeRoundBurst, fireModes.semiAuto];
    }
    return [fireModes.semiAuto];
  }

  // Roll just the attack roll of a weapon, return it
  async attackRoll(attackMods) {
    if (this.type === "cyberware" && cwHasType(this, "Weapon") && !cwIsEnabled(this)) {
      ui?.notifications?.warn(game.i18n.localize("CYBERPUNK.CWT_WeaponDisabled"));
      return await new Roll("0").evaluate();
    }

    const system = this._getWeaponSystem();
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
    const weaponAccuracy = Number(system?.accuracy ?? 0) || 0;
    if (weaponAccuracy !== 0) {
      attackTerms.push("@weaponAccuracy");
    }

    const attackSkillKey = (system?.attackSkill ?? this.system?.attackSkill) || "";
    const attackSkillValRaw = this.actor?.getSkillVal?.(attackSkillKey);
    const attackSkillVal = Number.isFinite(Number(attackSkillValRaw)) ? Number(attackSkillValRaw) : 0;

    return await makeD10Roll(attackTerms, {
      stats: this.actor.system.stats,
      attackSkill: attackSkillVal,
      weaponAccuracy
    }).evaluate();
  }

  /**
   * Fire an automatic weapon at full auto
   * @param {*} attackMods The modifiers for an attack. fireMode, ambush, etc - look in lookups.js for the specification of these
   * @returns 
   */
  async __fullAuto(attackMods, targetTokens) {
      const system = this._getWeaponSystem();
      // The kind of distance we're attacking at, so we can display Close: <50m or something like that
      let actualRangeBracket = rangeResolve[attackMods.range](system.range);
      let DC = rangeDCs[attackMods.range];
      let targetCount = Math.max(1, targetTokens.length || Number(attackMods.targetsCount) || 1);
      const rollData = this.actor?.getRollData?.() ?? {};
      const maximizeDamage = this._shouldMaximizePointBlankDamage(attackMods);
      const maxDamageRoll = maximizeDamage
        ? await new Roll(system.damage, rollData).evaluate({ maximize: true })
        : null;
      const maxDamage = maximizeDamage
        ? CyberpunkItem._floorDamageTotal(maxDamageRoll.total)
        : null;
      const totalRounds = CyberpunkItem._resolveFullAutoRounds(attackMods, system);
      
      // This is a somewhat flawed multi-target thing - given target tokens, we could calculate distance (& therefore penalty) for each, and apply damage to them
      let rolls = [];
      let shotsLeft = Number(system.shotsLeft) || 0;
      let roundsToAllocate = Math.min(totalRounds, shotsLeft);

      for (let i = 0; i < targetCount && roundsToAllocate > 0; i++) {
          const remainingTargets = targetCount - i;
          const plannedRoundsForTarget = Math.ceil(roundsToAllocate / remainingTargets);
          const attackModsForTarget = {
            ...attackMods,
            fullAutoRoundsFired: plannedRoundsForTarget
          };

          let attackRoll = await this.attackRoll(attackModsForTarget);
          const rangedFumble = await this._maybeApplyRangedFumble(attackRoll);

          let roundsFired = Math.min(shotsLeft, plannedRoundsForTarget);

          if (rangedFumble) {
            roundsFired = Math.min(shotsLeft, 1);
          }

          if (rangedFumble?.outcome?.discharge) {
            shotsLeft = 0;
            roundsToAllocate = 0;
          } else {
            shotsLeft = Math.max(0, shotsLeft - roundsFired);
            roundsToAllocate = Math.max(0, roundsToAllocate - roundsFired);
          }

          await this.__setWeaponField("shotsLeft", shotsLeft);

          let roundsHit = Math.min(roundsFired, attackRoll.total - DC);
          
          if (roundsHit < 0) {
              roundsHit = 0;
          }
          if (rangedFumble?.forceMiss) {
            roundsHit = 0;
          }

          let areaDamages = {};
          // Roll damage for each of the bullets that hit
          for (let i = 0; i < roundsHit; i++) {
              let location = (await rollLocation(attackMods.targetActor, attackMods.targetArea)).areaHit;
              if (!areaDamages[location]) {
                  areaDamages[location] = [];
              }
              const dmgRoll = maximizeDamage
                ? maxDamageRoll
                : await new Roll(system.damage, rollData).evaluate();

              const dmg = maximizeDamage
                ? maxDamage
                : CyberpunkItem._floorDamageTotal(dmgRoll.total);

              areaDamages[location].push({
                damage: dmg,
                damageHtml: CyberpunkItem._inlineRollHtml(dmg, dmgRoll, "damage")
              });
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
              },
              fumble: rangedFumble?.fumble ?? null,
          };

          let roll = new Multiroll(`${localize("Autofire")}`, `${localize("Range")}: ${localizeParam(attackMods.range, {range: actualRangeBracket})}`);
          await roll.execute(undefined, "systems/cyberpunk2020/templates/chat/multi-hit.hbs", templateData);
          rolls.push(roll);
      }

      return rolls;
  }

  async __threeRoundBurst(attackMods) {
      const system = this._getWeaponSystem();
      // The kind of distance we're attacking at, so we can display Close: <50m or something like that
      let actualRangeBracket = rangeResolve[attackMods.range](system.range);
      let DC = rangeDCs[attackMods.range];
      let attackRoll = await this.attackRoll(attackMods);
      const rangedFumble = await this._maybeApplyRangedFumble(attackRoll);
      const rollData = this.actor?.getRollData?.() ?? {};
      const maximizeDamage = this._shouldMaximizePointBlankDamage(attackMods);
      const maxDamageRoll = maximizeDamage
        ? await new Roll(system.damage, rollData).evaluate({ maximize: true })
        : null;
      const maxDamage = maximizeDamage
        ? CyberpunkItem._floorDamageTotal(maxDamageRoll.total)
        : null;

      let roundsFired = Math.min(system.shotsLeft, system.rof, 3);
      if (rangedFumble) {
        roundsFired = Math.min(system.shotsLeft, 1);
      }
      let attackHits = attackRoll.total >= DC;
      if (rangedFumble?.forceMiss) {
        attackHits = false;
      }
      let areaDamages = {};
      let roundsHit;
      if (attackHits) {
          // In RAW this is 1d6/2, but this is functionally the same
          roundsHit = await new Roll("1d3").evaluate();
          for (let i = 0; i < roundsHit.total; i++) {
              let location = (await rollLocation(attackMods.targetActor, attackMods.targetArea)).areaHit;
              if (!areaDamages[location]) {
                  areaDamages[location] = [];
              }
              const dmgRoll = maximizeDamage
                ? maxDamageRoll
                : await new Roll(system.damage, rollData).evaluate();

              const dmg = maximizeDamage
                ? maxDamage
                : CyberpunkItem._floorDamageTotal(dmgRoll.total);

              areaDamages[location].push({
                damage: dmg,
                damageHtml: CyberpunkItem._inlineRollHtml(dmg, dmgRoll, "damage")
              });
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
          locals: {range: { range: actualRangeBracket }},
          fumble: rangedFumble?.fumble ?? null,
      };
      let roll = new Multiroll(localize("ThreeRoundBurst"));
      roll.execute(undefined, "systems/cyberpunk2020/templates/chat/multi-hit.hbs", templateData);
      if (rangedFumble?.outcome?.discharge) {
        await this.__setWeaponField("shotsLeft", 0);
      } else {
        await this.__setWeaponField("shotsLeft", system.shotsLeft - roundsFired);
      }
      return roll;
  }

  async __suppressiveFire(mods = {}) {
    const sys = this._getWeaponSystem();
    const rof = Math.max(0, Math.floor(Number(sys.rof) || 0));
    const shotsLeft = Math.max(0, Math.floor(Number(sys.shotsLeft) || 0));
    const maxRounds = Math.min(rof, shotsLeft);
    const requestedRounds = Math.floor(Number(mods.roundsFired) || maxRounds);
    const rounds = maxRounds > 0
      ? clamp(requestedRounds, 1, maxRounds)
      : 0;
    const width = Math.max(2, Number(mods.zoneWidth ?? 2));
    const targets = Math.max(1, Math.floor(Number(mods.targetsCount ?? 1)));

    await this.__setWeaponField("shotsLeft", sys.shotsLeft - rounds);

    const saveDC = Math.ceil(rounds / width);
    const dmgFormula = sys.damage || "1d6";
    const rollData = this.actor?.getRollData?.() ?? {};

    const results = [];
    for (let t = 0; t < targets; t++) {
      const hitsRoll = await new Roll("1d6").evaluate();
      const areaDamages = {};

      for (let i = 0; i < hitsRoll.total; i++) {
        const loc = (await rollLocation(mods.targetActor, mods.targetArea)).areaHit;
        const dmgRoll = await new Roll(dmgFormula, rollData).evaluate();
        const dmg = CyberpunkItem._floorDamageTotal(dmgRoll.total);

        if (!areaDamages[loc]) areaDamages[loc] = [];

        areaDamages[loc].push({
          dmg,
          dmgHtml: CyberpunkItem._inlineRollHtml(dmg, dmgRoll, "damage")
        });
      }

      results.push({ hitsRoll, areaDamages });
    }

    const html = await renderTemplate(
      "systems/cyberpunk2020/templates/chat/suppressive.hbs",
      { weaponName: this.name, rounds, width, saveDC, dmgFormula, results }
    );

    await createCyberpunkChatMessage({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content: html,
      flags : { cyberpunk2020: { fireMode: "suppressive" } }
    }, { useDefaultRollMode: true });
  }

  async __semiAuto(attackMods) {
      const system = this._getWeaponSystem();
      
      // The range we're shooting at
      let DC = rangeDCs[attackMods.range];
      let attackRoll = await this.attackRoll(attackMods);
      const rangedFumble = await this._maybeApplyRangedFumble(attackRoll);
      const rollData = this.actor?.getRollData?.() ?? {};
      const maximizeDamage = this._shouldMaximizePointBlankDamage(attackMods);
      const damageRoll = await new Roll(system.damage, rollData).evaluate({ maximize: maximizeDamage });
      const dmg = CyberpunkItem._floorDamageTotal(damageRoll.total);
      let locationRoll = await rollLocation(attackMods.targetActor, attackMods.targetArea);
      let actualRangeBracket = rangeResolve[attackMods.range](system.range);
      let attackHits = attackRoll.total >= DC;
      if (rangedFumble?.forceMiss) {
        attackHits = false;
      }
      const roundsFired = Math.min(system.shotsLeft, 1);
      let location = locationRoll.areaHit;
      let areaDamages = {};
      
      if (attackHits) {
          if (!areaDamages[location]) {
              areaDamages[location] = [];
          }
          areaDamages[location].push({
            damage: dmg,
            damageHtml: CyberpunkItem._inlineRollHtml(dmg, damageRoll, "damage"),
          });
      }
      
      let templateData = {
        range: attackMods.range,
        toHit: DC,
        attackRoll: attackRoll,
        fired: roundsFired,
        hits: attackHits ? 1 : 0,
        hit: attackHits,
        areaDamages: areaDamages,
        fumble: rangedFumble?.fumble ?? null,
        locals: {
            range: { range: actualRangeBracket }
        }
      };

      let roll = new Multiroll(localize("SemiAuto"));
      roll.execute(undefined, "systems/cyberpunk2020/templates/chat/multi-hit.hbs", templateData);

      if (rangedFumble?.outcome?.discharge) {
        await this.__setWeaponField("shotsLeft", 0);
      } else {
        await this.__setWeaponField("shotsLeft", system.shotsLeft - roundsFired);
      }
      
      return roll;
  }

  async __meleeBonk(attackMods) {
      // Melee attacks do not have a fixed DC; they are contested instead
      let attackRoll = await this.attackRoll(attackMods);

      // Take into account the CyberTerminus modifier for damage
      const system = this._getWeaponSystem ? this._getWeaponSystem() : this.system;
      let damageFormula = `${system.damage}+@strengthBonus`;

      if (attackMods.cyberTerminus) {
          switch (attackMods.cyberTerminus) {
              case "CyberTerminusX2":
                  damageFormula = `(${damageFormula})*2`;
                  break;
              case "CyberTerminusX3":
                  damageFormula = `(${damageFormula})*3`;
                  break;
              case "NoCyberlimb":
              default:
                  break;
          }
      }

      let damageRoll = await new Roll(damageFormula, {
          strengthBonus: strengthDamageBonus(this.actor.system.stats.bt.total)
      }).evaluate();

      // CP2020: any fractional damage is rounded down
      const damage = CyberpunkItem._floorDamageTotal(damageRoll.total);
      damageRoll._total = damage;

      const locationRoll = await rollLocation(attackMods.targetActor, attackMods.targetArea);
      const areaDamages = {};

      areaDamages[locationRoll.areaHit] = [{
        damage,
        damageHtml: CyberpunkItem._inlineRollHtml(damage, damageRoll, "damage")
      }];

      let fumble = null;
      if (game.settings.get("cyberpunk2020", "fumbleTableEnabled") && isFumbleRoll(attackRoll)) {
        fumble = await buildSkillFumbleData({
          skill: { system: { stat: "ref" } },
          roll: attackRoll
        });
      }

      let bigRoll = new Multiroll(this.name, this.system.flavor)
        .addRoll(attackRoll, { name: localize("Attack") });

      await bigRoll.execute(
        undefined,
        "systems/cyberpunk2020/templates/chat/multi-hit.hbs",
        {
          attackRoll,
          hit: true,
          hits: 1,
          areaDamages,
          suppressHitTally: true,
          fumble
        }
      );

      return bigRoll;
  }
  async __martialBonk(attackMods) {
    let actor = this.actor;
    let system = actor.system;

    // Action being done, eg strike, block etc
    let action = attackMods.action;
    let martialArt = attackMods.martialArt;

    let isMartial = martialArt != "Brawling";
    let keyTechniqueBonus = 0;
    let martialSkillLevel = actor.getSkillVal(martialArt);
    let flavor = game.i18n.has(`CYBERPUNK.${action + "Text"}`) ? localize(action + "Text") : "";

    const martialArtLabel = actor.getMartialDisplayName?.(martialArt) ?? localize("Skill" + martialArt);
    let results = new Multiroll(
      localizeParam("MartialTitle", { action: localize(action), martialArt: martialArtLabel }),
      flavor
    );

    // Bonus for a specific action from the selected martial art
    const actionBonus = getMartialActionBonus(martialArt, action);

    // Additional modifier from the dialog
    const extraMod = Number(attackMods.extraMod || 0);

    // Same aimed-location penalty as ranged attacks
    const targetAreaMod = attackMods.targetArea ? -4 : 0;

    // FNFF2: Martial Damage Bonus rules
    const fnff2 = isFnff2Enabled();

    let martialDamageBonusValue = 0;

    if (isMartial) {
      if (!fnff2) {
        martialDamageBonusValue = martialSkillLevel;
      } else {
        const symbol = getFnff2DamageBonusSymbol(action);
        const isKeyVariant = actionBonus > 0;

        const levelForDamage =
          (martialArt === "Martial Arts: PanzerFaust")
            ? Math.floor(martialSkillLevel * 1.5)
            : martialSkillLevel;

        // * — damage bonus works if Key Variant
        // $ — works only if Key Variant
        // % / @ — do not give damage bonus from MA level
        if ((symbol === "*" || symbol === "$") && isKeyVariant) {
          martialDamageBonusValue = levelForDamage;
        } else {
          martialDamageBonusValue = 0;
        }
      }
    }

    // Martial arts attack formula: reflex + skill level + special technique + action bonus + additional mod.
    // If the action is performed through a weapon item, including cyber weapons, use its WA.
    const sysForAcc = this._getWeaponSystem ? this._getWeaponSystem() : this.system;
    const weaponAccuracy = Number(sysForAcc?.accuracy ?? 0) || 0;

    let attackRoll = new Roll(
            `1d10x10 + @stats.ref.total + @attackBonus + @keyTechniqueBonus + @actionBonus + @extraMod + @targetAreaMod${weaponAccuracy !== 0 ? " + @weaponAccuracy" : ""}`,
      {
        stats: system.stats,
        attackBonus: martialSkillLevel,
        keyTechniqueBonus: keyTechniqueBonus,
        actionBonus: actionBonus,
        extraMod: extraMod,
        targetAreaMod,
        weaponAccuracy
      }
    );

    results.addRoll(attackRoll, { name: localize("Attack") });

    // At this stage, martial damage is taken only from the selected weapon item.
    // Non-damaging actions keep the compact roll-only chat card.
    //
    // Damage-capable actions:
    // - Standard CP2020: Strike, Kick, Throw, Choke.
    // - FNFF2 additions: Punch, Jump Kick, Ram, Cast.
    //
    // Roll-only actions:
    // Dodge, Block/Parry, All-Out Parry, All-Out Dodge,
    // Disarm, Sweep/Trip, Grapple, Hold, Escape.
    const sysWeapon = this._getWeaponSystem ? this._getWeaponSystem() : this.system;
    const baseWeaponDamage = (sysWeapon?.damage && String(sysWeapon.damage).trim())
      ? String(sysWeapon.damage).trim()
      : "";

    const damagingMartialActions = new Set([
      martialActions.strike,
      martialActions.punch,
      martialActions.kick,
      martialActions.jumpKick,
      martialActions.ram,
      martialActions.cast,
      martialActions.throw,
      martialActions.choke
    ]);

    const canDealDamage = damagingMartialActions.has(action);
    let damageFormula = "";

    if (canDealDamage && baseWeaponDamage) {
      damageFormula = `${baseWeaponDamage}+@strengthBonus+@martialDamageBonus`;
    }

    // CyberTerminus modifier
    if (attackMods?.cyberTerminus && damageFormula) {
      switch (attackMods.cyberTerminus) {
        case "CyberTerminusX2":
          damageFormula = `(${damageFormula})*2`;
          break;
        case "CyberTerminusX3":
          damageFormula = `(${damageFormula})*3`;
          break;
        case "NoCyberlimb":
        default:
          break;
      }
    }

    if (!attackRoll._evaluated) {
      await attackRoll.evaluate();
    }

    let fumble = null;
    if (game.settings.get("cyberpunk2020", "fumbleTableEnabled") && isFumbleRoll(attackRoll)) {
      fumble = await buildSkillFumbleData({
        skill: { system: { stat: "ref" } },
        roll: attackRoll
      });
    }

    // Defensive/non-damaging martial actions keep the compact default roll card.
    if (!damageFormula) {
      await results.defaultExecute({ img: this.img, fumble });
      return results;
    }

    const locationRoll = await rollLocation(attackMods.targetActor, attackMods.targetArea);
    const damageRoll = await new Roll(damageFormula, {
      strengthBonus: strengthDamageBonus(system.stats.bt.total),
      martialDamageBonus: martialDamageBonusValue
    }).evaluate();

    const damage = CyberpunkItem._floorDamageTotal(damageRoll.total);
    damageRoll._total = damage;

    const areaDamages = {};
    areaDamages[locationRoll.areaHit] = [{
      damage,
      damageHtml: CyberpunkItem._inlineRollHtml(damage, damageRoll, "damage")
    }];

    await results.execute(
      undefined,
      "systems/cyberpunk2020/templates/chat/multi-hit.hbs",
      {
        attackRoll,
        hit: true,
        hits: 1,
        areaDamages,
        suppressHitTally: true,
        fumble
      }
    );

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
