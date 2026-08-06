import { weaponTypes, rangedAttackTypes, meleeAttackTypes, fireModes, ranges, rangeDCs, rangeResolve, strengthDamageBonus, getMartialActionBonus, martialActions, isCombatAutomationEnabled, isFnff2Enabled, getFnff2DamageBonusSymbol, FNFF2_ONLY_MARTIAL_ART_IDS } from "../lookups.js"
import { Multiroll, makeD10Roll } from "../dice.js"
import { localize, localizeParam, rollLocation, cwHasType, cwIsEnabled, isFumbleRoll, buildRangedCombatFumbleData, buildSkillFumbleData, clamp, isRollableFormula } from "../utils.js";
import { createCyberpunkChatMessage, renderCyberpunkTemplate } from "../compat.js";
import { ATTACK_FLAG_VERSION, attackerIsHidden, hiddenMessageMode, snapshotAmmo } from "../damage.js";
import { declareDodge, dodgeRangedPenalty, resolveDefense } from "../combat.js";
import { blastProfile, blastRings, fireCorridor, isBlastAttack, isSpreadAttack, pickBlastCentre, placeSuppressionZone, scatterCentre, spreadProfileFor } from "../zones.js";
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
      // The tooltip is rebuilt from this copy with Roll.fromJSON, so its total has to be the
      // displayed one or the card and its own tooltip disagree (T-22). The dice terms are left
      // alone — the tooltip still shows what the dice did, CP2020 just rounds the sum down.
      data.total = v;
      const json = encodeURIComponent(JSON.stringify(data));
      const cls = String(extraClasses || "").trim();
      return `<a class="inline-roll inline-result cp-inline-roll roll-result roll ${cls}" data-roll="${json}">${v}</a>`;
    } catch (e) {
      return String(v);
    }
  }

  /** @override */
  async _preCreate(data, options, user) {
    const allowed = await super._preCreate(data, options, user);
    if (allowed === false) return false;

    if (this.type === "skill") {
      const id = data?._id || this._id;
      if (id && FNFF2_ONLY_MARTIAL_ART_IDS.has(id) && !isFnff2Enabled()) {
        ui?.notifications?.warn(game.i18n.localize("CYBERPUNK.FNFF2SkillDisabledWarn"));
        // _preCreate must return false to reject only this document.
        // Throwing here also aborts sibling documents in batch creation.
        return false;
      }
    }

    if (this.type === "armor" && this.actor) {
      const system = foundry.utils.deepClone(this._source.system);
      this._morphArmorToOwner(system, this.actor);
      // The morph deletes coverage areas, and a recursive updateSource only ever merges — the
      // additions would land and the deletions would not. `recursive: false` makes each root key
      // a ForcedReplacement (common/abstract/data.mjs:679, 14.365.0), which is what replaces the
      // whole map; the object handed over is a complete clone of the source, so nothing is lost.
      this.updateSource({ system }, { recursive: false });
    }
  }

  prepareData() {
    super.prepareData();

    switch(this.type) {
      case "weapon":
        this._prepareWeaponData(this.system);
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

  /**
   * Reshape an armor's coverage to its owner's hit locations.
   *
   * Runs from `_preCreate` and nowhere else: an embedded item joins an actor only by being
   * created on it, so that is the ownership change. It used to run from `prepareData`, where the
   * `lastOwnerId` stamp reached memory only — every re-preparation restored `""` from `_source`
   * and morphed again, warning line by line on each pass (T-20).
   *
   * @param {object} system  The item's source `system`, mutated in place
   * @param {Actor} actor
   */
  _morphArmorToOwner(system, actor) {
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
    fullAutoRoundsFired,
    targetActor
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

    const dodgeMod = dodgeRangedPenalty(targetActor);
    if (dodgeMod) {
      terms.push(dodgeMod);
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

    // Damage strings are typed on item sheets, so both of these are user-authored data at a real
    // boundary and only D/d notation is valid (D33). Refused here rather than at the roll: this is
    // ahead of every fire mode, so no round is spent and no card is posted for an attack that
    // would throw halfway through (`T120`). A blank formula is not a typo — several paths fall
    // back to their own default — so only a non-empty one is checked.
    const ammoDamage = snapshotAmmo(this)?.bonusDamageFormula;
    if (system?.damage && !isRollableFormula(system.damage)) return false;
    if (ammoDamage && !isRollableFormula(ammoDamage)) return false;

    const targets = Array.isArray(targetTokens) ? targetTokens : [];
    // Hit locations come from the target's own table, so the first target rides along with the
    // modifiers every branch already receives.
    const mods = { ...attackMods, targetActor: CyberpunkItem.__targetActor(targets[0]) };

    if (!isRanged) {
      if (system.attackType === meleeAttackTypes.martial) {
        return this.__martialBonk(mods, targets);
      } else {
        return this.__meleeBonk(mods, targets);
      }
    }

    // An area-effect charge is aimed and rolled like any other ranged weapon (ch. 07:837), but it
    // lands on a point rather than a body, so it never reaches the fire modes below. With
    // automation off it falls through to its fire mode, which is the plain shot v1.1.x rolled.
    if (isCombatAutomationEnabled() && isBlastAttack(system, snapshotAmmo(this))) {
      return this.__blastAttack(mods, targets);
    }

    // ---- Firemode-specific rolling. I may roll together some common aspects later ----
    // Full auto
    if(mods.fireMode === fireModes.fullAuto) {
      return this.__fullAuto(mods, targets);
    }
    // Three-round burst. Shares... a lot in common with full auto actually
    else if(mods.fireMode === fireModes.threeRoundBurst) {
      return this.__threeRoundBurst(mods, targets);
    }
    else if(mods.fireMode === fireModes.semiAuto) {
      return this.__semiAuto(mods, targets);
    }
    else if(mods.fireMode === fireModes.suppressive) {
      return this.__suppressiveFire(mods);
    }
  }

  /** An unlinked token owns its own delta actor, so the token document is what gets resolved. */
  static __targetActor(target) {
    if (!target?.tokenUuid) return undefined;
    return fromUuidSync(target.tokenUuid)?.actor;
  }

  /** A card about a token the players cannot see is whispered — the target's own state decides. */
  static __targetMessageMode(target) {
    if (!target?.tokenUuid) return undefined;
    return hiddenMessageMode(fromUuidSync(target.tokenUuid)?.hidden);
  }

  /**
   * Whether this attacker is an ambusher. The implementation moved to `damage.js` when `zones.js`
   * needed it too; this stays as the name every call site and check already uses.
   *
   * @param {CyberpunkActor} [actor]
   * @returns {boolean}
   */
  static __attackerIsHidden(actor) {
    return attackerIsHidden(actor);
  }

  /**
   * The card payload the damage-apply path reads. Undefined when there is nothing to apply, which
   * is what leaves an untargeted or missing attack card exactly as it was.
   *
   * @param {object} card
   * @param {object} card.target One entry of the sheet's target snapshot
   * @param {Object<string, Array>} card.areaDamages Zone -> rolled damage entries
   * @param {object|null} card.ammo Snapshot from snapshotAmmo
   */
  __attackFlags({ target, areaDamages, ammo, fireMode, range }) {
    // One site kills the apply payload for every fire mode: with no flag the card carries nothing
    // to apply, and the render handler removes the button it came with.
    if (!isCombatAutomationEnabled()) return undefined;
    if (!target) return undefined;

    const hits = [];
    for (const [zone, entries] of Object.entries(areaDamages ?? {})) {
      for (const entry of entries) hits.push({ zone, damage: Number(entry.damage) || 0 });
    }
    if (!hits.length) return undefined;

    return {
      cyberpunk2020: {
        attack: {
          version: ATTACK_FLAG_VERSION,
          kind: "attack",
          itemId: this.id,
          attackerActorUuid: this.actor?.uuid ?? "",
          fireMode: fireMode ?? "",
          range: range ?? "",
          ap: !!this._getWeaponSystem()?.ap,
          // A blade meets armour by its own rules, and the ammunition channel cannot carry them:
          // melee always snapshots `ammo: null`, so these ride the payload instead (`T94`).
          melee: !this.isRanged(),
          mono: !!this._getWeaponSystem()?.mono,
          ammo,
          targets: [{
            name: target.name,
            tokenId: target.id,
            tokenUuid: target.tokenUuid,
            actorUuid: target.actorUuid
          }],
          hits,
          applied: {}
        }
      }
    };
  }

  /**
   * The card payload the apply-over-zone button reads. Undefined when no zone was placed, which is
   * what leaves a blast with no canvas as a card the GM applies by hand.
   *
   * @param {object} card
   * @param {"blast"|"spread"} card.kind
   * @param {object|null} card.blast Centre, geometry and the rolled damage
   */
  __zoneFlags({ kind, ammo, fireMode, range, blast }) {
    if (!blast) return undefined;

    return {
      cyberpunk2020: {
        attack: {
          version: ATTACK_FLAG_VERSION,
          kind,
          itemId: this.id,
          attackerActorUuid: this.actor?.uuid ?? "",
          fireMode: fireMode ?? "",
          range: range ?? "",
          ap: !!this._getWeaponSystem()?.ap,
          // A blade meets armour by its own rules, and the ammunition channel cannot carry them:
          // melee always snapshots `ammo: null`, so these ride the payload instead (`T94`).
          melee: !this.isRanged(),
          mono: !!this._getWeaponSystem()?.mono,
          ammo,
          blast,
          targets: [],
          hits: [],
          applied: {}
        }
      }
    };
  }

  /**
   * The one card both area-effect paths post. Occupancy is deliberately not part of it: the zone
   * is collected when the GM applies it, so a target that walked into the crater meanwhile is in.
   *
   * @param {object} card
   * @param {object} card.profile The blast geometry, printed so a GM with no tokens can apply it
   * @param {object|null} card.blast The same geometry with a centre, or null when none was placed
   */
  async __zoneCard({ title, kind, attackMods, attackRoll, ammo, profile, blast, damage, damageRoll,
    onTarget, scatter, target, fumble }) {
    const system = this._getWeaponSystem();
    const roll = new Multiroll(title).addRoll(attackRoll, { name: localize("Attack") });

    await roll.execute(
      undefined,
      "systems/cyberpunk2020/templates/chat/blast.hbs",
      {
        weaponName: this.name,
        target,
        range: attackMods.range,
        toHit: rangeDCs[attackMods.range],
        attackRoll,
        onTarget,
        scatter,
        placed: !!blast,
        // A shotgun pattern shares this template with a grenade but is not one: it has a width
        // rather than a radius, and the corridor `tokensInBlast` collects went unmentioned
        // entirely, so *Apply over zone* damaged victims the card never described (`T162`).
        isSpread: kind === "spread",
        spreadWidth: profile.radius * 2,
        radius: profile.radius,
        fullDamageWithin: profile.fullDamageWithin,
        rings: blastRings(profile),
        damage,
        damageHtml: CyberpunkItem._inlineRollHtml(damage, damageRoll, "damage"),
        fumble: fumble ?? null,
        locals: { range: { range: rangeResolve[attackMods.range](system.range) } }
      },
      this.__zoneFlags({ kind, ammo, fireMode: attackMods.fireMode, range: attackMods.range, blast })
    );

    return roll;
  }

  /**
   * Throw or launch an area-effect charge. The acting client places the blast, the attack roll says
   * whether it landed there, and a miss scatters it off the Grenade Table.
   *
   * @param {object} attackMods
   * @param {Array} targetTokens
   * @returns {Promise<Multiroll|null>} null when the placement was dismissed
   */
  async __blastAttack(attackMods, targetTokens = []) {
    const system = this._getWeaponSystem();
    const ammo = snapshotAmmo(this);
    const profile = blastProfile(ammo);

    let centre = null;
    if (canvas.ready) {
      // Ch. 07:839 — the centre of the area effect falls on the designated target, so a targeted
      // throw is already aimed and asking for a click can only move it: a hand-placed centre a
      // metre off changes which ring every other token in the crater falls in. The preview stays
      // for a throw at an empty spot, which is the case it was built for.
      const aimed = canvas.tokens.get(targetTokens[0]?.id)?.center;
      centre = aimed
        ? { x: aimed.x, y: aimed.y }
        : await pickBlastCentre(profile.radius, localizeParam("BlastZoneName", { weapon: this.name }));
      // Dismissing the placement takes the throw back: nothing has been rolled or spent yet.
      if (!centre) return null;
    }

    const attackRoll = await this.attackRoll(attackMods);
    const rangedFumble = await this._maybeApplyRangedFumble(attackRoll);
    const onTarget = attackRoll.total >= rangeDCs[attackMods.range] && !rangedFumble?.forceMiss;

    let scatter = null;
    if (!onTarget) {
      // Ch. 07:839 — 1d10 for the direction on the Grenade Table, a second for the metres.
      const direction = await new Roll("1d10").evaluate();
      const distance = await new Roll("1d10").evaluate();
      scatter = { direction: direction.total, distance: distance.total };
      if (centre) centre = scatterCentre(centre, scatter.direction, scatter.distance);
    }

    const rollData = this.actor?.getRollData?.() ?? {};
    const damageRoll = await new Roll(this.__ammoDamageFormula(system.damage, ammo), rollData).evaluate();
    const damage = CyberpunkItem._floorDamageTotal(damageRoll.total);

    // The charge is spent whether or not the card renders, as in every other fire mode.
    await this.__setWeaponField("shotsLeft",
      rangedFumble?.outcome?.discharge ? 0 : Math.max(0, Number(system.shotsLeft) - 1));

    return this.__zoneCard({
      title: localize("BlastTitle"),
      kind: "blast",
      attackMods,
      attackRoll,
      ammo,
      profile,
      blast: centre ? { ...centre, ...profile, damage, sceneId: canvas.scene.id } : null,
      damage,
      damageRoll,
      onTarget,
      scatter,
      target: targetTokens[0],
      fumble: rangedFumble?.fumble
    });
  }

  /**
   * The damage formula with the loaded ammunition's contribution folded in. The raw multiplier is
   * applied here rather than at damage-application time so the card shows the number that was
   * actually dealt.
   */
  __ammoDamageFormula(baseFormula, ammo) {
    if (!ammo) return baseFormula;

    let formula = ammo.bonusDamageFormula
      ? `(${baseFormula}) + (${ammo.bonusDamageFormula})`
      : baseFormula;

    if (ammo.rawDamageMult !== 1) formula = `(${formula}) * ${ammo.rawDamageMult}`;
    return formula;
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

    // Applied here rather than in either mod-term builder: the action economy charges the same
    // penalty whatever the weapon is.
    const actionPenalty = Number(attackMods?.actionPenalty) || 0;
    if (actionPenalty !== 0) {
      attackTerms.push(actionPenalty);
    }

    const weaponAccuracy = Number(system?.accuracy ?? 0) || 0;
    if (weaponAccuracy !== 0) {
      attackTerms.push("@weaponAccuracy");
    }

    const ammoAccuracy = isRanged ? (snapshotAmmo(this)?.accuracyMod ?? 0) : 0;
    if (ammoAccuracy !== 0) {
      attackTerms.push("@ammoAccuracy");
    }

    const attackSkillKey = (system?.attackSkill ?? this.system?.attackSkill) || "";
    const attackSkillValRaw = this.actor?.getSkillVal?.(attackSkillKey);
    const attackSkillVal = Number.isFinite(Number(attackSkillValRaw)) ? Number(attackSkillValRaw) : 0;

    return await makeD10Roll(attackTerms, {
      stats: this.actor.system.stats,
      attackSkill: attackSkillVal,
      weaponAccuracy,
      ammoAccuracy
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
      const ammo = snapshotAmmo(this);
      const damageFormula = this.__ammoDamageFormula(system.damage, ammo);
      const maximizeDamage = this._shouldMaximizePointBlankDamage(attackMods);
      const maxDamageRoll = maximizeDamage
        ? await new Roll(damageFormula, rollData).evaluate({ maximize: true })
        : null;
      const maxDamage = maximizeDamage
        ? CyberpunkItem._floorDamageTotal(maxDamageRoll.total)
        : null;
      const totalRounds = CyberpunkItem._resolveFullAutoRounds(attackMods, system);
      
      // This is a somewhat flawed multi-target thing - given target tokens, we could calculate distance (& therefore penalty) for each, and apply damage to them
      let rolls = [];
      let shotsLeft = Number(system.shotsLeft) || 0;
      let roundsToAllocate = Math.min(totalRounds, shotsLeft);
      // Ch. 07:712 — *"divide the ROF of the weapon by the total number of targets (round down)"*.
      // The remainder is left unfired, so every target gets the same share and a 20-round burst
      // over three targets spends 18 (`T147`).
      const plannedRoundsForTarget = Math.floor(roundsToAllocate / targetCount);

      // D59: a target whose share rounds to zero is not attacked at all. The share is the same for
      // every target, so a zero share means the whole burst is refused rather than skipped inside
      // the loop — otherwise it posts a card and rewrites the magazine for an attack that spent
      // nothing (`T233`). `false` is the refusal shape the caller reads to charge no action.
      if (plannedRoundsForTarget < 1) {
        ui.notifications.warn(localize("FullAutoShareEmpty", {
          rounds: roundsToAllocate,
          targets: targetCount
        }));
        return false;
      }

      for (let i = 0; i < targetCount && roundsToAllocate > 0; i++) {
          const attackModsForTarget = {
            ...attackMods,
            fullAutoRoundsFired: plannedRoundsForTarget,
            targetActor: CyberpunkItem.__targetActor(targetTokens[i]) ?? attackMods.targetActor
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
              let location = (await rollLocation(attackModsForTarget.targetActor, attackMods.targetArea)).areaHit;
              if (!areaDamages[location]) {
                  areaDamages[location] = [];
              }
              const dmgRoll = maximizeDamage
                ? maxDamageRoll
                : await new Roll(damageFormula, rollData).evaluate();

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

          let roll = new Multiroll(`${localize("Autofire")}`, `${localize("Range")}: ${localizeParam(attackMods.range, {range: actualRangeBracket})}`)
            .addRoll(attackRoll, { name: localize("Attack") });
          await roll.execute(
            undefined,
            "systems/cyberpunk2020/templates/chat/multi-hit.hbs",
            templateData,
            this.__attackFlags({
              target: targetTokens[i],
              areaDamages,
              ammo,
              fireMode: attackMods.fireMode,
              range: attackMods.range
            })
          );
          rolls.push(roll);
      }

      return rolls;
  }

  async __threeRoundBurst(attackMods, targetTokens = []) {
      const system = this._getWeaponSystem();
      // The kind of distance we're attacking at, so we can display Close: <50m or something like that
      let actualRangeBracket = rangeResolve[attackMods.range](system.range);
      let DC = rangeDCs[attackMods.range];
      let attackRoll = await this.attackRoll(attackMods);
      const rangedFumble = await this._maybeApplyRangedFumble(attackRoll);
      const rollData = this.actor?.getRollData?.() ?? {};
      const ammo = snapshotAmmo(this);
      const damageFormula = this.__ammoDamageFormula(system.damage, ammo);
      const maximizeDamage = this._shouldMaximizePointBlankDamage(attackMods);
      const maxDamageRoll = maximizeDamage
        ? await new Roll(damageFormula, rollData).evaluate({ maximize: true })
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
          // Ch. 07:704 is `1D6/2`, which the book never says how to round. `1d3` is that roll
          // rounded **up** — the reading D36 adopted; rounding down would be {0,1,1,2,2,3} and
          // would let a successful burst land no rounds at all (`T150`).
          roundsHit = await new Roll("1d3").evaluate();
          for (let i = 0; i < roundsHit.total; i++) {
              let location = (await rollLocation(attackMods.targetActor, attackMods.targetArea)).areaHit;
              if (!areaDamages[location]) {
                  areaDamages[location] = [];
              }
              const dmgRoll = maximizeDamage
                ? maxDamageRoll
                : await new Roll(damageFormula, rollData).evaluate();

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
          target: targetTokens[0],
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
      let roll = new Multiroll(localize("ThreeRoundBurst"))
        .addRoll(attackRoll, { name: localize("Attack") });
      // The ammo write goes first: rounds are spent whether or not the card renders. Awaiting the
      // card at all is what stops a chat failure being swallowed as an unhandled rejection.
      if (rangedFumble?.outcome?.discharge) {
        await this.__setWeaponField("shotsLeft", 0);
      } else {
        await this.__setWeaponField("shotsLeft", system.shotsLeft - roundsFired);
      }
      await roll.execute(
        undefined,
        "systems/cyberpunk2020/templates/chat/multi-hit.hbs",
        templateData,
        this.__attackFlags({
          target: targetTokens[0],
          areaDamages,
          ammo,
          fireMode: attackMods.fireMode,
          range: attackMods.range
        })
      );
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
    const width = Math.max(2, Math.floor(Number(mods.zoneWidth ?? 2)));
    const targets = Math.max(1, Math.floor(Number(mods.targetsCount ?? 1)));

    // Floor, not ceil: the book's own worked example is 64 rounds over 5 m for a DC of 12.
    const saveDC = Math.floor(rounds / width);
    const dmgFormula = sys.damage || "1d6";

    let zone = null;
    // A burst that can spend no round lays no zone and rolls no hits: it posts a card saying so.
    // Display over veto, per the no-hard-limits rule — the fire mode is still offered, and a
    // cyberweapon left at the schema's default ROF 0 is how a GM reaches this (`T113`).
    // With automation off the burst takes the existing no-canvas branch: the abstract per-target
    // tally and `placed: false`, which is the v1.1.x card.
    if (rounds > 0 && canvas.ready && isCombatAutomationEnabled()) {
      // The corridor covers the band being fired at; the shooter places and rotates it. A weapon
      // with no range falls back to a square, which is the zone the book's own examples describe.
      const reach = Math.round(rangeResolve[mods.range]?.(Number(sys.range) || 0) || 0);
      zone = await placeSuppressionZone(width, Math.max(width, reach),
        localizeParam("ZoneName", { weapon: this.name }));
      // Dismissing the placement takes the burst back: nothing has been rolled or spent yet.
      if (!zone) return null;
    }

    await this.__setWeaponField("shotsLeft", sys.shotsLeft - rounds);

    const rollData = this.actor?.getRollData?.() ?? {};
    const results = [];
    // With a zone on the map every crossing rolls its own hits, so the abstract per-target tally is
    // the no-canvas fallback and not a second answer to the same question.
    for (let t = 0; rounds > 0 && !zone && t < targets; t++) {
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

    const html = await renderCyberpunkTemplate(
      "systems/cyberpunk2020/templates/chat/suppressive.hbs",
      { weaponName: this.name, rounds, width, saveDC, dmgFormula, results, placed: !!zone,
        noRounds: rounds <= 0 }
    );

    // Returned, not merely posted: `null` is how a dismissed placement is told apart from a burst
    // that happened, and the sheet charges the action economy off exactly that (`T80`).
    return createCyberpunkChatMessage({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content: html,
      flags : { cyberpunk2020: { fireMode: "suppressive", ...this.__suppressionFlags(zone, saveDC, dmgFormula) } }
    }, { useDefaultRollMode: true });
  }

  /**
   * The card payload the active GM lays the fire zone from. Undefined with no canvas, which is what
   * leaves the abstract card as the whole answer.
   *
   * @param {object|null} zone The placed geometry from placeSuppressionZone
   * @param {number} saveDC
   * @param {string} damageFormula
   */
  __suppressionFlags(zone, saveDC, damageFormula) {
    if (!zone) return undefined;

    return {
      attack: {
        version: ATTACK_FLAG_VERSION,
        kind: "suppression",
        itemId: this.id,
        attackerActorUuid: this.actor?.uuid ?? "",
        zone,
        behaviour: {
          name: localizeParam("ZoneName", { weapon: this.name }),
          saveDC,
          damageFormula,
          ap: !!this._getWeaponSystem()?.ap,
          ammo: snapshotAmmo(this),
          attackerUuid: this.actor?.uuid ?? ""
        }
      }
    };
  }

  async __semiAuto(attackMods, targetTokens = []) {
      const system = this._getWeaponSystem();

      // The range we're shooting at
      let DC = rangeDCs[attackMods.range];
      let attackRoll = await this.attackRoll(attackMods);
      const rangedFumble = await this._maybeApplyRangedFumble(attackRoll);
      const rollData = this.actor?.getRollData?.() ?? {};
      const ammo = snapshotAmmo(this);
      // Ch. 07's Shotgun Table gives the pattern its own damage per band, so the spread replaces
      // the weapon's formula rather than adding to it. A blank band keeps the weapon's own. With
      // automation off there is no pattern: the weapon's own formula and the ordinary card.
      const spread = isCombatAutomationEnabled() && isSpreadAttack(ammo, attackMods.range)
        ? spreadProfileFor(attackMods.range, ammo)
        : null;
      const maximizeDamage = this._shouldMaximizePointBlankDamage(attackMods);
      const damageRoll = await new Roll(this.__ammoDamageFormula(spread?.damage || system.damage, ammo), rollData)
        .evaluate({ maximize: maximizeDamage });
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
        target: targetTokens[0],
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

      // The ammo write goes first: rounds are spent whether or not the card renders. Awaiting the
      // card at all is what stops a chat failure being swallowed as an unhandled rejection.
      if (rangedFumble?.outcome?.discharge) {
        await this.__setWeaponField("shotsLeft", 0);
      } else {
        await this.__setWeaponField("shotsLeft", system.shotsLeft - roundsFired);
      }

      // Ch. 07:855 — a 2 m pattern caught a booster standing 1 m from the one it was aimed at, so
      // the pattern is half its width around the target; ch. 07:843 adds the straight path from the
      // shooter at the same width, and everything caught takes the same damage.
      const targetToken = spread && attackHits && canvas.ready
        ? canvas.tokens.get(targetTokens[0]?.id)
        : null;
      if (targetToken) {
        const profile = { radius: spread.width / 2, fullDamageWithin: spread.width / 2, multipliers: [] };
        const patternCentre = targetToken.center;
        return this.__zoneCard({
          title: localize("SpreadTitle"),
          kind: "spread",
          attackMods,
          attackRoll,
          ammo,
          profile,
          blast: {
            x: patternCentre.x,
            y: patternCentre.y,
            ...profile,
            damage: dmg,
            sceneId: canvas.scene.id,
            corridor: fireCorridor(this.actor.getActiveTokens()[0], patternCentre),
            aimedTokenUuid: targetTokens[0]?.tokenUuid ?? "",
            aimedZone: location
          },
          damage: dmg,
          damageRoll,
          onTarget: attackHits,
          scatter: null,
          target: targetTokens[0],
          fumble: rangedFumble?.fumble
        });
      }

      let roll = new Multiroll(localize("SemiAuto"))
        .addRoll(attackRoll, { name: localize("Attack") });

      await roll.execute(
        undefined,
        "systems/cyberpunk2020/templates/chat/multi-hit.hbs",
        templateData,
        this.__attackFlags({
          target: targetTokens[0],
          areaDamages,
          ammo,
          fireMode: attackMods.fireMode,
          range: attackMods.range
        })
      );
      return roll;
  }

  async __meleeBonk(attackMods, targetTokens = []) {
      // Melee attacks do not have a fixed DC; they are contested instead
      let attackRoll = await this.attackRoll(attackMods);

      const defense = attackMods.targetActor
        ? await resolveDefense(attackMods.targetActor, attackRoll.total,
            { attackerName: this.actor.name, itemName: this.name,
              messageMode: CyberpunkItem.__targetMessageMode(targetTokens[0]),
              hideAttacker: CyberpunkItem.__attackerIsHidden(this.actor) })
        : null;
      const hit = defense ? defense.hit : true;

      const areaDamages = {};
      if (hit) {
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

        areaDamages[locationRoll.areaHit] = [{
          damage,
          damageHtml: CyberpunkItem._inlineRollHtml(damage, damageRoll, "damage")
        }];
      }

      let fumble = null;
      if (game.settings.get("cyberpunk2020", "fumbleTableEnabled") && isFumbleRoll(attackRoll)) {
        fumble = await buildSkillFumbleData({
          skill: { system: { stat: "ref" } },
          roll: attackRoll
        });
      }

      let bigRoll = new Multiroll(this.name, this.system.flavor)
        .addRoll(attackRoll, { name: localize("Attack") });

      // One opposed check is one message with two rolls: the card draws the defense die from the
      // template data either way, but only a message roll is animated and stored (`T40`).
      if (defense) bigRoll.addRoll(defense.roll, { name: localize("Defense") });

      await bigRoll.execute(
        undefined,
        "systems/cyberpunk2020/templates/chat/multi-hit.hbs",
        {
          target: targetTokens[0],
          attackRoll,
          defense,
          hit,
          hits: 1,
          areaDamages,
          suppressHitTally: true,
          fumble
        },
        this.__attackFlags({ target: targetTokens[0], areaDamages, ammo: null })
      );

      return bigRoll;
  }
  async __martialBonk(attackMods, targetTokens = []) {
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

    // The dialog shows this row for every weapon and `chargeAction` charges after every attack, so
    // the martial path takes the term the ranged and plain-melee paths take in `attackRoll` — this
    // one builds its own Roll and used to skip it (`T146`).
    const actionPenalty = Number(attackMods?.actionPenalty) || 0;

    let attackRoll = new Roll(
            `1d10x10 + @stats.ref.total + @attackBonus + @keyTechniqueBonus + @actionBonus + @extraMod + @targetAreaMod${weaponAccuracy !== 0 ? " + @weaponAccuracy" : ""}${actionPenalty !== 0 ? " + @actionPenalty" : ""}`,
      {
        stats: system.stats,
        attackBonus: martialSkillLevel,
        keyTechniqueBonus: keyTechniqueBonus,
        actionBonus: actionBonus,
        extraMod: extraMod,
        targetAreaMod,
        weaponAccuracy,
        actionPenalty
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
      // Dodging as an action of one's own, rather than as a reaction to a melee attack, is the
      // only way to earn the ranged penalty before being attacked.
      if (action === martialActions.dodge || action === martialActions.allOutDodge) {
        await declareDodge(actor);
      }
      await results.defaultExecute({ img: this.img, fumble });
      return results;
    }

    const defense = attackMods.targetActor
      ? await resolveDefense(attackMods.targetActor, attackRoll.total,
          { attackerName: actor.name, itemName: this.name,
            messageMode: CyberpunkItem.__targetMessageMode(targetTokens[0]),
            hideAttacker: CyberpunkItem.__attackerIsHidden(actor) })
      : null;
    const hit = defense ? defense.hit : true;

    // One opposed check is one message with two rolls (`T40`).
    if (defense) results.addRoll(defense.roll, { name: localize("Defense") });

    const areaDamages = {};
    if (hit) {
      const locationRoll = await rollLocation(attackMods.targetActor, attackMods.targetArea);
      const damageRoll = await new Roll(damageFormula, {
        strengthBonus: strengthDamageBonus(system.stats.bt.total),
        martialDamageBonus: martialDamageBonusValue
      }).evaluate();

      const damage = CyberpunkItem._floorDamageTotal(damageRoll.total);
      damageRoll._total = damage;

      areaDamages[locationRoll.areaHit] = [{
        damage,
        damageHtml: CyberpunkItem._inlineRollHtml(damage, damageRoll, "damage")
      }];
    }

    await results.execute(
      undefined,
      "systems/cyberpunk2020/templates/chat/multi-hit.hbs",
      {
        target: targetTokens[0],
        attackRoll,
        defense,
        hit,
        hits: 1,
        areaDamages,
        suppressHitTally: true,
        fumble
      },
      this.__attackFlags({ target: targetTokens[0], areaDamages, ammo: null })
    );

    return results;
  }
}
