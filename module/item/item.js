import { weaponTypes, rangedAttackTypes, meleeAttackTypes, fireModes, ranges, rangeBandFor, rangeDCs, rangeResolve, effectiveRange, strengthDamageBonus, getMartialActionBonus, martialActions, isCombatAutomationEnabled, isFnff2Enabled, getFnff2DamageBonusSymbol, unarmedManeuverFormula, JUMP_KICK_TO_HIT, UNARMED_STRIKE_ID } from "../lookups.js"
import { Multiroll, makeD10Roll } from "../dice.js"
import { displayName, localize, localizeParam, rollLocation, cwHasType, cwIsEnabled, isFumbleRoll, buildRangedCombatFumbleData, buildSkillFumbleData, clamp, isRollableFormula } from "../utils.js";
import { createCyberpunkChatMessage, createCyberpunkRollCard, renderCyberpunkTemplate } from "../compat.js";
import { ATTACK_FLAG_VERSION, attackerIsHidden, hiddenMessageMode, snapshotAmmo } from "../damage.js";
import { declareDodge, dodgeRangedPenalty, resolveDefense } from "../combat.js";
import { blastProfile, blastRings, fireCorridor, isBlastAttack, isSpreadAttack, metresToPixels, PATTERN_TINT_ADJACENT, PATTERN_TINT_WALKED, pickBlastCentre, placeSuppressionZone, scatterCentre, snapPatternCentre, spreadCorridorBands, spreadProfileFor } from "../zones.js";
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

  /** D99/D100 — a device that is put down rather than aimed. Delivery is the weapon's, not the round's. */
  isPlanted() {
    return this._getWeaponSystem()?.weaponType === weaponTypes.planted;
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
      // **The same gate `__weaponRoll` dispatches on.** The ladder prices the pattern attack, so it
      // applies exactly where that attack runs: an autoshotgun loaded with slugs, one with nothing
      // loaded, and any autoshotgun in a world with automation off all resolve through
      // `__fullAuto`'s bullet hose, where `roundsHit = total - DC` would spend the penalty a second
      // time — three states each strictly worse than before the ladder existed (`T377`).
      if (sys.attackType === rangedAttackTypes.autoshotgun
        && isCombatAutomationEnabled() && isSpreadAttack(snapshotAmmo(this), range)) {
        // Ch. 07:861-863 — an autoshotgun's full auto is N *patterns* on one trigger pull, not a
        // hose of bullets, and it climbs a flat -2 per shot past the first: the book's own CAWS
        // example is five shots at -8. The ±1-per-10-rounds rule below is the bullet weapon's and
        // has nothing to say here, so the two are alternatives rather than a stack (`T100`, D179).
        const past = Math.max(0, bullets - 1);
        // Not `-2 * past`: at zero that is `-0`, which renders on the card as "-0" — the same trap
        // `actionPenaltyFor` guards in `combat.js`.
        terms.push(past ? -2 * past : 0);
      } else {
        // If close range, add, else subtract
        let multiplier =
            (range === ranges.close) ? 1
          : (range === ranges.pointBlank) ? 0
          : -1;
        terms.push(multiplier * Math.floor(bullets/10))
      }
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
  __weaponRoll(attackMods, targetTokens, attackerToken = null) {
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

    // D196 — «Автоопределение дистанции» is an instruction, not a band, so it is spent here:
    // everything downstream reads `rangeDCs` and `rangeResolve` and must never see the option
    // itself. A target is the measure where there is one; an attack that puts its own centre on
    // the map measures from that centre instead and resolves further down.
    if (mods.range === ranges.auto) {
      // D205 — the missing **source** is tested first, and the order is by cause rather than by
      // attack kind: `__distanceTo` answers null for either missing end, so asking about the target
      // first told a shooter with no token on the scene that their selected target was not selected
      // (`T401`). The canvas test keeps a mapless table on D199's notice below, the one that names
      // what a player can actually do there (D212). Refused rather than coalesced to 0: `?? 0` read
      // as point blank, the most generous band in the table, for a state D199 refuses on the other
      // side. Ahead of the placement, so nothing is spent and no card is posted (`T394`).
      if (canvas?.ready && !this.__attackerToken(attackerToken)) {
        ui.notifications.warn(localize("AutoRangeNoAttackerToken"));
        return false;
      }
      const measured = this.__distanceTo(targets[0], attackerToken);
      if (measured !== null) mods.range = this.__bandAt(measured);
      else if (!this.__placesOwnCentre(system, mods)) {
        // D199, an approved hard restriction of the empty-weapon shape: nothing to measure and
        // nothing to measure it to, so the shot does not happen — the player selects a target or
        // deliberately picks a constant band. Nothing is spent and no card is posted.
        ui.notifications.warn(localize("AutoRangeNoTarget"));
        return false;
      }
    }

    if (!isRanged) {
      // The attacker's own token rides through to the contest: only the acting client knows which
      // token it is firing as, and the notice and the prompt name it (`T296`, D133).
      if (system.attackType === meleeAttackTypes.martial) {
        return this.__martialBonk(mods, targets, attackerToken);
      } else {
        return this.__meleeBonk(mods, targets, attackerToken);
      }
    }

    // D100 — the weapon says how the device arrives, whatever round it carries, so this is ahead of
    // the blast gate: a planted charge is set down and never thrown or fired.
    if (isCombatAutomationEnabled() && this.isPlanted()) {
      return this.__plantCharge(mods);
    }

    // An area-effect charge is aimed and rolled like any other ranged weapon (ch. 07:837), but it
    // lands on a point rather than a body, so it never reaches the fire modes below. With
    // automation off it falls through to its fire mode, which is the plain shot v1.1.x rolled.
    if (isCombatAutomationEnabled() && isBlastAttack(snapshotAmmo(this))) {
      return this.__blastAttack(mods, targets, attackerToken);
    }

    // Ch. 07:910 — a flamethrower is swept between two chosen points rather than fired at one, so
    // it never reaches a fire mode either; D91 schedules it in v1.2.0. With automation off it falls
    // through to the plain shot v1.1.x rolled, the same fallback blast and suppression already use.
    if (isCombatAutomationEnabled() && system.attackType === rangedAttackTypes.flamethrow) {
      return this.__flamethrowerSweep(mods, attackerToken);
    }

    // ---- Firemode-specific rolling. I may roll together some common aspects later ----
    // Full auto
    if(mods.fireMode === fireModes.fullAuto) {
      // Ch. 07:861-863 — an autoshotgun's burst is patterns rather than bullets, and it needs the
      // canvas to put them on and a round that throws a pattern at this range. Failing either it
      // falls through to the bullet burst below, which is the same fallback the blast, the sweep and
      // the suppression zone all take (`T100`, D179).
      if (isCombatAutomationEnabled()
        && system.attackType === rangedAttackTypes.autoshotgun
        && isSpreadAttack(snapshotAmmo(this), mods.range)) {
        return this.__autoshotgunFullAuto(mods, targets, attackerToken);
      }
      return this.__fullAuto(mods, targets);
    }
    // Three-round burst. Shares... a lot in common with full auto actually
    else if(mods.fireMode === fireModes.threeRoundBurst) {
      return this.__threeRoundBurst(mods, targets);
    }
    else if(mods.fireMode === fireModes.semiAuto) {
      return this.__semiAuto(mods, targets, attackerToken);
    }
    else if(mods.fireMode === fireModes.suppressive) {
      return this.__suppressiveFire(mods);
    }
  }

  /**
   * How far this attack actually travels, in scene units, or null when there is nothing to measure.
   *
   * The attacker's own token where the caller knows it — a linked actor carries no `token`, and
   * `getActiveTokens` is scoped to the *viewed* scene (`client/documents/actor.mjs:284`, 14.365.0),
   * which answers nothing for a GM running two of them. This is the same resolution the melee
   * notice takes (`T296`, D133).
   *
   * @param {object} [target] One entry of the sheet's target snapshot
   * @param {TokenDocument} [attackerToken]
   * @returns {number|null}
   */
  __distanceTo(target, attackerToken = null) {
    if (!target?.tokenUuid || !canvas?.ready) return null;

    const from = attackerToken?.object ?? this.actor?.getActiveTokens?.()[0];
    const to = fromUuidSync(target.tokenUuid)?.object;
    if (!from || !to) return null;

    return canvas.grid.measurePath([from.center, to.center]).distance;
  }

  /**
   * How far a point on the map is from the shooter, in scene units — the measure D199 leaves for a
   * splash attack, whose centre is chosen rather than targeted.
   *
   * @param {{x: number, y: number}} point In pixels
   * @param {Token} [shooterToken] The attacker's placed token
   * @returns {number|null}
   */
  __distanceToPoint(point, shooterToken = null) {
    const from = shooterToken ?? this.__attackerToken();
    if (!from || !point || !canvas?.ready) return null;
    return canvas.grid.measurePath([from.center, point]).distance;
  }

  /**
   * The attacker's own placed token, or null when they have none on the viewed scene. The one
   * answer D205's refusal and every placed-centre measurement both read, so the two cannot
   * disagree about whether there is anything to measure from.
   *
   * @param {TokenDocument} [attackerToken] The acting client's own token, where the caller knows it
   * @returns {Token|null}
   */
  __attackerToken(attackerToken = null) {
    return attackerToken?.object ?? this.actor?.getActiveTokens?.()[0] ?? null;
  }

  /**
   * The band a measured distance falls in.
   *
   * A weapon with no usable range of its own reads the band the dialog itself would have opened on
   * — `rangedModifiers` takes the same fallback, so auto and manual agree about that weapon.
   *
   * @param {number} distance In scene units
   * @returns {string} One of the five `ranges` bands
   */
  __bandAt(distance) {
    return rangeBandFor(distance, effectiveRange(this)) ?? ranges.close;
  }

  /**
   * Whether this attack will put its own centre on the map, which is then what auto range measures
   * to (D199 — *"the placed centre is the measure"*).
   *
   * The canvas is part of the test: every one of these falls back to a mapless path when there is
   * no canvas, and a mapless path has no centre to measure from either — so auto has nothing at
   * all and the attack is refused rather than guessed at.
   *
   * @param {object} system From `_getWeaponSystem`
   * @param {object} mods
   * @returns {boolean}
   */
  __placesOwnCentre(system, mods) {
    if (!isCombatAutomationEnabled() || !canvas?.ready) return false;
    if (this.isPlanted() || system.attackType === rangedAttackTypes.flamethrow) return true;

    const ammo = snapshotAmmo(this);
    if (isBlastAttack(ammo)) return true;
    // Suppressive fire is deliberately absent (D204): it places a corridor rather than a centre and
    // is off the auto option altogether, so an auto that somehow reached it has nothing to measure
    // and must take the D199 refusal rather than resolve to a corridor of length zero.
    // The autoshotgun's chained patterns — the same test its own dispatch takes.
    return system.attackType === rangedAttackTypes.autoshotgun
      && mods.fireMode === fireModes.fullAuto
      && isSpreadAttack(ammo, mods.range);
  }

  /** An unlinked token owns its own delta actor, so the token document is what gets resolved. */
  static __targetActor(target) {
    if (!target?.tokenUuid) return undefined;
    return fromUuidSync(target.tokenUuid)?.actor;
  }

  /** The placed token behind a target entry — the name the defender is called by (D133, `T296`). */
  static __targetToken(target) {
    if (!target?.tokenUuid) return null;
    return fromUuidSync(target.tokenUuid) ?? null;
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
   * The weapon name a card may print.
   *
   * D182 — the fourth surface D31 never counted. A melee card's visibility follows the **target's**
   * token, not the attacker's, so an ambusher swinging at a visible defender posted a public card
   * titled with the blade's own name while the two defence notices beside it said only "an unseen
   * attacker" (`T352`). The blast card's *Weapon:* line leaks the same way for a thrown charge.
   *
   * @param {string} name
   * @param {CyberpunkActor} [actor] The attacker
   * @returns {string}
   */
  static __weaponLabel(name, actor) {
    return CyberpunkItem.__attackerIsHidden(actor) ? localize("HiddenWeapon") : name;
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
    onTarget, scatter, target, fumble, adjacency = "" }) {
    const system = this._getWeaponSystem();
    const roll = new Multiroll(title).addRoll(attackRoll, { name: localize("Attack") });

    await roll.execute(
      undefined,
      "systems/cyberpunk2020/templates/chat/blast.hbs",
      {
        weaponName: CyberpunkItem.__weaponLabel(this.name, this.actor),
        target,
        range: attackMods.range,
        toHit: rangeDCs[attackMods.range],
        attackRoll,
        onTarget,
        // "The charge lands where it was aimed" is wrong for a stream and wrong for a shotgun
        // pattern — resolved per kind rather than hard-coding the grenade's own wording.
        onTargetCaption: localize(kind === "sweep" ? "SweepOnTarget"
          : kind === "spread" ? "SpreadOnTarget" : "BlastOnTarget"),
        scatter,
        // The miss needs the same split since D140: the Grenade Table's second die is a landing
        // distance for a thrown charge (`07:839`, *"how many meters away it hit"*) and the blast
        // still honours it, but a stream **pivots** about the muzzle, so the die supplies a bearing
        // and nothing travelled that far (`T308`). A pattern slides like the charge (D201).
        scatterCaption: scatter
          ? localizeParam(kind === "sweep" ? "SweepScattered"
              : kind === "spread" ? "SpreadScattered" : "BlastScattered", scatter)
          : "",
        placed: !!blast,
        // A shotgun pattern (and now a flamethrower sweep) shares this template with a grenade but
        // is not one: it has a width rather than a radius, and the corridor `tokensInBlast` collects
        // went unmentioned entirely, so *Apply over zone* damaged victims the card never described
        // (`T162`). `T252` widened the shape to a second kind, so the caption and the width's own
        // label are resolved here rather than hard-coded to the shotgun's wording.
        // `T100`'s eighth clause, D192's ring stated rather than enforced: a chained pattern says
        // on its own card whether it landed inside the previous one's 1 m ring or the burst walked
        // (`T379`). Empty for everything that is not a chained pattern, the first one included —
        // it has nothing to be adjacent to.
        adjacency,
        isCorridor: kind === "spread" || kind === "sweep",
        corridorWidthLabel: localize(kind === "sweep" ? "SweepWidth" : "SpreadWidth"),
        corridorCaption: localize(kind === "sweep" ? "SweepCorridor" : "SpreadCorridor"),
        spreadWidth: profile.radius * 2,
        radius: profile.radius,
        fullDamageWithin: profile.fullDamageWithin,
        rings: blastRings(profile),
        damage,
        damageHtml: CyberpunkItem._inlineRollHtml(damage, damageRoll, "damage"),
        fumble: fumble ?? null,
        locals: { range: { range: rangeResolve[attackMods.range](effectiveRange(this)) } }
      },
      this.__zoneFlags({ kind, ammo, fireMode: attackMods.fireMode, range: attackMods.range, blast })
    );

    return roll;
  }

  /**
   * Set a charge down where it is wanted (D99/D102). RAW rolls nothing to place one — `07:914`
   * *"You step on it and it blows up"*, `07:920` tripwire, timer or remote — so there is no to-hit
   * and no scatter; the check is Demolitions when the charge is set, on TECH (`04:745`, `02:284`),
   * and the explosion waits on the Detonate button of the actor's deployed list (D83).
   *
   * @param {object} attackMods
   * @returns {Promise<Multiroll|null>} null when the placement was dismissed
   */
  async __plantCharge(attackMods) {
    const system = this._getWeaponSystem();
    const ammo = snapshotAmmo(this);
    const profile = blastProfile(ammo);

    let centre = null;
    if (canvas.ready) {
      centre = await pickBlastCentre(profile.radius, localizeParam("BlastZoneName", { weapon: this.name }));
      // Dismissing the placement takes the whole action back: nothing rolled, nothing spent.
      if (!centre) return null;
    }

    const skillKey = system.attackSkill || "Demolitions";
    const skillVal = Number(this.actor.getSkillVal(skillKey)) || 0;
    const actionPenalty = Number(attackMods?.actionPenalty) || 0;
    const extraMod = Number(attackMods?.extraMod) || 0;
    const roll = await makeD10Roll(
      ["@stats.tech.total", skillVal, actionPenalty, extraMod].filter(term => term !== 0),
      this.actor.system
    ).evaluate();

    await this.__setWeaponField("shotsLeft", Math.max(0, Number(system.shotsLeft) - 1));

    // The record is the whole charge: the weapon it came from is spent, may be deleted, and a
    // charge laid one session is detonated in another.
    await this.actor.deployCharge({
      name: this.name,
      img: this.img,
      itemId: this.id,
      sceneId: centre ? canvas.scene.id : "",
      levelId: centre ? canvas.level.id : "",
      x: centre?.x ?? 0,
      y: centre?.y ?? 0,
      ...profile,
      damageFormula: this.__ammoDamageFormula(system.damage, ammo),
      ammo,
      ap: !!system.ap
    });

    // Where the charge may be put down is the table's to play out (`AL-Q2`): the placement is
    // neither limited nor measured, so the card says the charge is set and nothing about reach.
    const card = new Multiroll(
      localize("PlantTitle"),
      localizeParam("ChargeSet", { weapon: this.name })
    ).addRoll(roll, { name: localize("Skill" + skillKey) });

    await card.defaultExecute({ img: this.img });
    return card;
  }

  /**
   * Blow a charge off the deployed list (D83): one card, the same zone payload a thrown blast
   * posts, so *Apply over zone* collects the crater the same way. A static because the charge
   * outlives its weapon — the record carries everything, and the item may be long deleted.
   *
   * @param {CyberpunkActor} actor The actor the charge was laid by
   * @param {string} chargeId The entry's own id in `system.deployedCharges`
   * @returns {Promise<ChatMessage|null>} null when the charge is gone or its formula is not rollable
   */
  static async detonateCharge(actor, chargeId) {
    const charge = (actor.system.deployedCharges ?? []).find(entry => entry.id === chargeId);
    if (!charge) return null;

    // The formula was typed on an item sheet and outlives the item, so it is checked here rather
    // than trusted (`T120`, D33). The charge stays on the list: it is still lying there.
    if (!isRollableFormula(charge.damageFormula)) {
      ui.notifications.warn(localize("ChargeFormulaBroken"));
      return null;
    }

    await actor.removeDeployedCharge(chargeId);

    const damageRoll = await new Roll(charge.damageFormula, actor.getRollData()).evaluate();
    const damage = CyberpunkItem._floorDamageTotal(damageRoll.total);
    // Through `blastProfile` rather than straight out of the record: a charge laid before the
    // falloff was withdrawn still carries rings in its own snapshot, and it outlives sessions —
    // reading them here would have gone on quartering damage with no control left to see it.
    const profile = blastProfile({
      blastRadius: charge.radius,
      blastFullDamageWithin: charge.fullDamageWithin,
      blastMultipliers: charge.multipliers
    });
    // With automation off the card is the v1.1.x one: the damage and the geometry, applied by hand.
    const blast = (charge.sceneId && isCombatAutomationEnabled())
      ? {
        x: charge.x, y: charge.y, ...profile, damage,
        sceneId: charge.sceneId,
        // A charge laid before the walls landed says nothing about its level, and a blast that
        // cannot name one meets no walls — the disc it was laid as is what it stays.
        levelId: charge.levelId ?? "",
        throughWalls: !!charge.ammo?.blastThroughWalls
      }
      : null;

    return createCyberpunkRollCard({
      rolls: [damageRoll],
      speaker: ChatMessage.getSpeaker({ actor }),
      content: await renderCyberpunkTemplate("systems/cyberpunk2020/templates/chat/blast.hbs", {
        title: localize("DetonateTitle"),
        weaponName: CyberpunkItem.__weaponLabel(charge.name, actor),
        placed: !!blast,
        radius: profile.radius,
        fullDamageWithin: profile.fullDamageWithin,
        rings: blastRings(profile),
        damage,
        damageHtml: CyberpunkItem._inlineRollHtml(damage, damageRoll, "damage")
      }),
      flags: blast
        ? {
          cyberpunk2020: {
            attack: {
              version: ATTACK_FLAG_VERSION,
              kind: "blast",
              itemId: charge.itemId,
              attackerActorUuid: actor.uuid,
              fireMode: "",
              range: "",
              ap: !!charge.ap,
              melee: false,
              mono: false,
              ammo: charge.ammo,
              blast,
              targets: [],
              hits: [],
              applied: {}
            }
          }
        }
        : undefined
    });
  }

  /**
   * Throw or launch an area-effect charge. The acting client places the blast, the attack roll says
   * whether it landed there, and a miss scatters it off the Grenade Table.
   *
   * @param {object} attackMods
   * @param {Array} targetTokens
   * @param {TokenDocument} [attackerToken] The acting client's own token
   * @returns {Promise<Multiroll|null>} null when the placement was dismissed
   */
  async __blastAttack(attackMods, targetTokens = [], attackerToken = null) {
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

    // D199 — a splash placement always knows its distance, so auto range is answered by the centre
    // the shooter chose rather than by a target they never selected. Resolved before the roll,
    // because `__shootModTerms` and the DC both read the band.
    if (attackMods.range === ranges.auto) {
      attackMods = { ...attackMods,
        range: this.__bandAt(this.__distanceToPoint(centre, this.__attackerToken(attackerToken))) };
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
      blast: centre
        ? {
          ...centre, ...profile, damage,
          sceneId: canvas.scene.id,
          // Which level's walls the blast meets, taken where it was placed: edges are stored per
          // level, and the GM applying the card may be looking at another scene entirely.
          levelId: canvas.level.id,
          throughWalls: !!ammo?.blastThroughWalls
        }
        : null,
      damage,
      damageRoll,
      onTarget,
      scatter,
      target: targetTokens[0],
      fumble: rangedFumble?.fumble
    });
  }

  /**
   * Sweep a flamethrower between two chosen points (`T252`, D91). Ch. 07:910: the shooter places a
   * starting point and an ending point, an attack roll says whether the stream landed there, and a
   * miss refers to the Grenade Table — geometrically the same corridor a shotgun pattern lays, so
   * `zones.js` needs nothing new: the band is D115's own gate, binary and never wrapped by a wall,
   * and whatever the stream catches ignites on its own the way any dot-enabled round already does
   * (`applyHitsToActor`'s `ignitionZone`) — the turn-by-turn burn is the loaded round's, authored on
   * the ammo sheet, not this method's to compute.
   *
   * @param {object} attackMods
   * @param {TokenDocument} [attackerToken] The acting client's own token
   * @returns {Promise<Multiroll|null>} null when either placement was dismissed
   */
  async __flamethrowerSweep(attackMods, attackerToken = null) {
    const system = this._getWeaponSystem();
    const shooterToken = this.__attackerToken(attackerToken);
    const ammo = snapshotAmmo(this);
    const width = Math.max(2, Math.floor(Number(attackMods.zoneWidth ?? 2)));
    const profile = { radius: width / 2, fullDamageWithin: width / 2, multipliers: [] };

    let start = null, end = null;
    if (canvas.ready) {
      start = await pickBlastCentre(profile.radius, localizeParam("SweepStartPoint", { weapon: this.name }));
      // Dismissing either placement takes the whole action back: nothing has been rolled or spent.
      if (!start) return null;
      end = await pickBlastCentre(profile.radius, localizeParam("SweepEndPoint", { weapon: this.name }));
      if (!end) return null;
    }

    // D199 again: the stream's own far point is what auto range measures to.
    if (attackMods.range === ranges.auto) {
      attackMods = { ...attackMods,
        range: this.__bandAt(this.__distanceToPoint(end, shooterToken)) };
    }

    const attackRoll = await this.attackRoll(attackMods);
    const rangedFumble = await this._maybeApplyRangedFumble(attackRoll);
    const onTarget = attackRoll.total >= rangeDCs[attackMods.range] && !rangedFumble?.forceMiss;

    let scatter = null;
    if (!onTarget && start && end) {
      // Ch. 07:839's Grenade Table again, exactly as a thrown miss uses it — but a stream pivots
      // rather than sliding (D140): the muzzle is where the shooter is standing and a miss does not
      // move him, so `start` is fixed and only the bearing of `end` wanders. `start` is the muzzle
      // everywhere else too (`blast.corridor.from`, read by `corridorPoint` and
      // `patternWallBetween`), so moving it would put the stream's origin off the shooter.
      const direction = await new Roll("1d10").evaluate();
      const distance = await new Roll("1d10").evaluate();
      scatter = { direction: direction.total, distance: distance.total };
      // The same roll and the same helper as before: scatter the far end as if it were a thrown
      // centre, then keep only its **bearing** from the muzzle and re-place `end` at the stream's
      // own original length along it.
      const decoy = scatterCentre(end, scatter.direction, scatter.distance);
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      const reach = Math.hypot(decoy.x - start.x, decoy.y - start.y);
      // A decoy landing exactly on the muzzle has no bearing to take; the stream then keeps the one
      // it was aimed along, which is the only answer that is not a division by zero.
      if (reach > 0) {
        end = {
          x: start.x + ((decoy.x - start.x) / reach) * length,
          y: start.y + ((decoy.y - start.y) / reach) * length
        };
      }
    }

    const rollData = this.actor?.getRollData?.() ?? {};
    const damageRoll = await new Roll(this.__ammoDamageFormula(system.damage, ammo), rollData).evaluate();
    const damage = CyberpunkItem._floorDamageTotal(damageRoll.total);

    // The charge is spent whether or not the card renders, as in every other fire mode.
    await this.__setWeaponField("shotsLeft",
      rangedFumble?.outcome?.discharge ? 0 : Math.max(0, Number(system.shotsLeft) - 1));

    return this.__zoneCard({
      title: localize("SweepTitle"),
      kind: "sweep",
      attackMods,
      attackRoll,
      ammo,
      profile,
      blast: (start && end)
        ? {
          x: end.x, y: end.y, ...profile, damage,
          sceneId: canvas.scene.id,
          // Which level's walls the sweep meets, taken where it was placed (D69: a splash mechanic
          // reads walls the same way a blast does; T284's binary gate is what actually applies).
          levelId: canvas.level.id,
          corridor: {
            from: { x: start.x, y: start.y },
            to: { x: end.x, y: end.y },
            shooterTokenUuid: shooterToken?.document?.uuid ?? ""
          }
        }
        : null,
      damage,
      damageRoll,
      onTarget,
      scatter,
      target: null,
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

    // D147 — a round carrying its own damage replaces the weapon's rather than adding to it, which
    // is what the book's per-gauge shotgun damage is (`07:867-873`). Empty is every other round, and
    // the weapon's own formula.
    const base = ammo.damageFormula || baseFormula;

    let formula = ammo.bonusDamageFormula
      ? `(${base}) + (${ammo.bonusDamageFormula})`
      : base;

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
  /**
   * Ch. 07:861-863 — an autoshotgun's full auto: up to ROF **patterns** on one trigger pull, each
   * its own spread over its own ground, all of them within 1 m of each other, at a cumulative -2 per
   * shot past the first. The book's own worked example is a CAWS firing five at -8.
   *
   * This is a different attack from `__fullAuto`, which is the bullet weapon's: there the burst is a
   * hose and the roll decides how many rounds of one stream connect, here every pattern is an attack
   * of its own with its own card and its own caught set. D54 gives the shooter the ground as well as
   * the number — the patterns are placed on the canvas rather than allocated to targets — and D179
   * ships it.
   *
   * The order is load-bearing. **Every** placement happens before anything is spent or rolled, so a
   * shooter who changes their mind half-way through the chain has spent nothing and posted nothing
   * (D54, «cancel spends nothing»). The magazine is then written before the cards, which is where
   * every other fire mode writes it — the rounds are gone whether or not chat renders (`D.10.9`).
   *
   * @param {object} attackMods
   * @param {object[]} targetTokens
   * @param {TokenDocument} [attackerToken] The acting client's own token
   * @returns {Promise<null|false|object>} null when the chain was dismissed, false on a refusal
   */
  async __autoshotgunFullAuto(attackMods, targetTokens = [], attackerToken = null) {
    const system = this._getWeaponSystem();
    const ammo = snapshotAmmo(this);
    const autoRange = attackMods.range === ranges.auto;
    // D194/D196 — under automatic range each pattern is played at the band its **own** placed
    // centre falls in, so the width, the damage and the DC are all decided by where the shooter
    // put it. Before the first drag there is nothing to measure, so the preview opens at the band
    // the shooter is standing in and resizes as the cursor crosses each boundary (`T371`).
    const shooterToken = this.__attackerToken(attackerToken);
    const bandAtPoint = point => this.__bandAt(this.__distanceToPoint(point, shooterToken));
    const spread = spreadProfileFor(autoRange ? this.__bandAt(0) : attackMods.range, ammo);
    const patterns = CyberpunkItem._resolveFullAutoRounds(attackMods, system);

    // The dialog already clamps the shooter's number to 1..min(ROF, magazine); this is the same
    // floor `__fullAuto` refuses on, reached when the weapon has neither ROF nor rounds.
    if (patterns < 1) {
      ui.notifications.warn(localize("NoAmmo"));
      return false;
    }

    // D54's own fallback: with no canvas there is no ground to put a pattern on, so the burst is
    // allocated to the targets instead — and unlike `07:712`'s bullet burst the surplus is **not**
    // left unfired, it goes to the last target. A pattern is a pattern whether or not anything draws
    // it, so the same number of rounds leaves the magazine either way.
    if (!canvas?.ready) return this.__autoshotgunPerTarget(attackMods, targetTokens, patterns, spread, ammo);

    // D183 from birth — each step names which pattern the map is waiting for, so a chain of five is
    // five legible prompts rather than five identical silences.
    const centres = [];
    let previous = null;
    for (let i = 0; i < patterns; i++) {
      const placed = await pickBlastCentre(spread.width / 2, localizeParam("SpreadPatternName", {
        weapon: this.name, index: i + 1, count: patterns
      }), {
        onPlacementChange: this.__patternPlacementFeedback(previous,
          autoRange ? point => spreadProfileFor(bandAtPoint(point), ammo).width / 2 : null),
        // D215 — core snaps a placement to half a grid square, 2.5 m on this system's own 5 m
        // scene, so without Shift the nearest distinct centre is already outside the ring and
        // every spread burst reads as walked (`T407`). Told, never enforced (D54).
        hint: patterns > 1 ? localize("SpreadPatternHint") : null
      });
      // Dismissed: nothing is spent, nothing is rolled, no card is posted.
      if (!placed) return null;

      const snapped = snapPatternCentre(placed, previous);
      // The band this pattern was actually laid at, frozen now: the apply path must not re-measure
      // against a token that has moved since.
      snapped.range = autoRange ? bandAtPoint(snapped) : attackMods.range;
      centres.push(snapped);
      previous = snapped;
    }

    // Every pattern is rolled **before** the magazine is written, which is what lets a fumbled
    // discharge empty it — the order `__semiAuto` and `__threeRoundBurst` both take. The cards
    // still come after the write, so the rounds are gone whether or not chat renders (`D.10.9`).
    const shots = [];
    for (let i = 0; i < patterns; i++) {
      // Every pattern of the burst carries the same penalty — `-2 x (N-1)`, not a ladder that
      // climbs within the trigger pull: `07:863` prices the whole burst by how many shots are in
      // it. `__shootModTerms` reads it off the same `fullAutoRoundsFired` the dialog wrote.
      const attackRoll = await this.attackRoll(attackMods);
      shots.push({ attackRoll, fumble: await this._maybeApplyRangedFumble(attackRoll) });
    }

    const discharged = shots.some(shot => shot.fumble?.outcome?.discharge);
    await this.__setWeaponField("shotsLeft",
      discharged ? 0 : Math.max(0, Number(system.shotsLeft) - patterns));

    const rollData = this.actor?.getRollData?.() ?? {};

    let last = null;
    for (const [index, centre] of centres.entries()) {
      const { attackRoll, fumble } = shots[index];
      // Per pattern, because under auto range each one was laid at its own distance: the width it
      // covers, the damage the table gives that band and the DC on its card all follow the same
      // measurement (D196). With a band picked by hand every pattern reads the declared one.
      const mods = { ...attackMods, range: centre.range };
      const patternSpread = spreadProfileFor(mods.range, ammo);
      const profile = {
        radius: patternSpread.width / 2,
        fullDamageWithin: patternSpread.width / 2,
        multipliers: []
      };
      // Per pattern, off the band this one was laid at — the same measurement its width, damage
      // and DC already follow. Read once off `attackMods` it saw `ranges.auto`, so auto and a
      // hand-declared point blank disagreed at 1 m on the same shot (`T395`).
      const damageRoll = await new Roll(
        this.__ammoDamageFormula(patternSpread.damage || system.damage, ammo), rollData)
        .evaluate({ maximize: this._shouldMaximizePointBlankDamage(mods) });
      const damage = CyberpunkItem._floorDamageTotal(damageRoll.total);

      // D201 — what the pattern's roll decides is *where the carpet goes down*, not whether it goes
      // down at all: a shotgun is an area weapon (`07:837`) and a missed area attack is re-centred
      // off the Grenade Table (`07:839`). Until this the roll was printed and read by nothing, so
      // the `-2 x (N-1)` ladder the same burst adds was inert in both directions (`T376`).
      //
      // The band is **not** re-measured at the scattered point: `mods.range` decided this pattern's
      // DC before it was rolled, so re-reading it afterwards would settle the to-hit against a
      // distance that did not exist when the shot was taken.
      const onTarget = attackRoll.total >= rangeDCs[mods.range] && !fumble?.forceMiss;
      let landed = centre;
      let scatter = null;
      if (!onTarget) {
        const direction = await new Roll("1d10").evaluate();
        const distance = await new Roll("1d10").evaluate();
        scatter = { direction: direction.total, distance: distance.total };
        landed = scatterCentre(centre, scatter.direction, scatter.distance);
      }

      last = await this.__zoneCard({
        title: localizeParam("SpreadPatternTitle", { index: index + 1, count: patterns }),
        kind: "spread",
        attackMods: mods,
        attackRoll,
        ammo,
        profile,
        blast: {
          x: landed.x,
          y: landed.y,
          ...profile,
          damage,
          sceneId: canvas.scene.id,
          levelId: canvas.level.id,
          corridor: fireCorridor(shooterToken, landed, spreadCorridorBands(effectiveRange(this), ammo)),
          // **No aimed token.** D17's wall exemption is for *"the shot's designated target"*, and on
          // this path the shooter designated a point rather than a body — pairing pattern *i* with
          // the *i*-th targeted token exempted whoever happened to sit at that index from the wall
          // gate, wherever they were standing (`T380`).
          aimedTokenUuid: "",
          aimedZone: ""
        },
        damage,
        damageRoll,
        onTarget,
        scatter,
        // D192's ring, stated and never enforced (D54). The first pattern has nothing to be
        // adjacent to, so it carries no caption at all (`T379`). Read off the centres the shooter
        // *chained*, not off where they landed: the ring is a statement about how the burst was
        // walked, and a scatter is the dice answering afterwards (`CA-Q1`).
        adjacency: index === 0
          ? ""
          : localize(centre.adjacent ? "SpreadPatternAdjacent" : "SpreadPatternWalked"),
        fumble: fumble?.fumble ?? null
      });
    }

    return last;
  }

  /**
   * The live feedback a chained pattern gives while it follows the cursor (D195).
   *
   * Green inside the previous pattern's 1 m ring, red beyond it — **display only**, never a veto:
   * a red pattern places exactly as a green one does, and the card then says the burst walked
   * (`T372`). The first pattern of a burst has no previous centre and is never tinted at all.
   *
   * Measured off the **settled** shape rather than the raw cursor, because that is the point
   * `snapPatternCentre` will judge — the tint and the caption cannot disagree that way.
   *
   * @param {{x: number, y: number}|null} previous The previous pattern's snapped centre
   * @returns {((args: object) => void)|null} null for the first pattern
   */
  __patternPlacementFeedback(previous, radiusAt = null) {
    if (!previous && !radiusAt) return null;

    let lit = null;
    return ({ document, preview, shape }) => {
      const changes = {};
      let resized = false;

      // D194 — the disc widens and narrows live as the cursor crosses the weapon's own band
      // boundaries, so what the shooter is about to place is what they are looking at (`T371`).
      //
      // Written **on the shape**, not only onto the document: `shape` is the placement context's
      // own object, core mutates it through `shape.move()` and re-applies it to the document on
      // every pointer move (`client/canvas/layers/regions.mjs:1043-1044`, 14.365.0), so a radius
      // written to the document alone would be undone by the next move — a flicker rather than a
      // resize.
      if (radiusAt) {
        const radius = metresToPixels(radiusAt(shape));
        if (radius !== shape.radius) {
          shape.updateSource({ radius });
          changes.shapes = [...document.shapes.slice(0, -1), shape];
          resized = true;
        }
      }

      if (previous) {
        const near = snapPatternCentre(shape, previous).adjacent;
        if (near !== lit) {
          lit = near;
          changes.color = near ? PATTERN_TINT_ADJACENT : PATTERN_TINT_WALKED;
        }
      }

      if (foundry.utils.isEmpty(changes)) return;
      document.updateSource(changes);
      if (resized) document.updateShapeConstraints();
      // `_refreshState` reads `document.color` onto the highlight and `refreshShapes` redraws the
      // geometry (`client/canvas/placeables/region.mjs:386-409`, 14.365.0).
      preview.renderFlags.set({ refreshState: !!changes.color, refreshShapes: resized });
    };
  }

  /**
   * The autoshotgun burst with no canvas to place it on: `N` patterns shared out over the targets,
   * the surplus on the last of them (D54). Every pattern is still its own attack and its own card;
   * what it loses is the ground, so it resolves against the target it was allocated to.
   *
   * @param {object} attackMods
   * @param {object[]} targetTokens
   * @param {number} patterns Total patterns fired
   * @param {{width: number, damage: string}} spread
   * @param {object|null} ammo
   * @returns {Promise<object|null>} the last card
   */
  async __autoshotgunPerTarget(attackMods, targetTokens, patterns, spread, ammo) {
    const system = this._getWeaponSystem();
    const targetCount = Math.max(1, targetTokens.length || Number(attackMods.targetsCount) || 1);
    const share = Math.floor(patterns / targetCount);
    const surplus = patterns - (share * targetCount);

    const rollData = this.actor?.getRollData?.() ?? {};
    const DC = rangeDCs[attackMods.range];
    const actualRangeBracket = rangeResolve[attackMods.range](effectiveRange(this));
    const damageFormula = this.__ammoDamageFormula(spread.damage || system.damage, ammo);
    const maximizeDamage = this._shouldMaximizePointBlankDamage(attackMods);

    // D202 — with fewer patterns than targets the share rounds to zero, and D54's
    // surplus-on-the-last then fired the whole burst at the *last* target while every other one got
    // an inner loop that ran zero times: no roll, no card, no notice. Each pattern is its own
    // complete attack (`07:861-863`), so they go one per target in target order until they run out;
    // `__fullAuto`'s D59 refusal is not borrowed, because there the burst is one ROF being divided
    // and here it is not (`T382`). Whoever the patterns never reach is named on the card.
    const uncovered = share < 1 ? targetTokens.slice(surplus, targetCount) : [];
    const uncoveredNames = uncovered.map(token => token?.name).filter(Boolean).join(", ");

    // Rolled before the magazine is written so a fumbled discharge can empty it, the order the
    // canvas arm and `__semiAuto` both take.
    const shots = [];
    for (let t = 0; t < targetCount; t++) {
      // The surplus rides on the last target rather than going unfired, which is where this parts
      // company with `07:712`'s bullet burst (`T147`) — but only once every target has one.
      const mine = share >= 1
        ? share + (t === targetCount - 1 ? surplus : 0)
        : (t < surplus ? 1 : 0);
      const mods = {
        ...attackMods,
        targetActor: CyberpunkItem.__targetActor(targetTokens[t]) ?? attackMods.targetActor
      };

      for (let i = 0; i < mine; i++) {
        const attackRoll = await this.attackRoll(mods);
        shots.push({ t, mods, attackRoll, fumble: await this._maybeApplyRangedFumble(attackRoll) });
      }
    }

    const discharged = shots.some(shot => shot.fumble?.outcome?.discharge);
    await this.__setWeaponField("shotsLeft",
      discharged ? 0 : Math.max(0, Number(system.shotsLeft) - patterns));

    let last = null;
    // Numbered off the flat list rather than off `(t * share) + i`, which repeats and skips as soon
    // as the shares are uneven — the surplus is on the last target by construction.
    for (const [index, { t, mods, attackRoll, fumble }] of shots.entries()) {
      const damageRoll = await new Roll(damageFormula, rollData).evaluate({ maximize: maximizeDamage });
      const damage = CyberpunkItem._floorDamageTotal(damageRoll.total);
      const hit = attackRoll.total >= DC && !fumble?.forceMiss;
      const location = (await rollLocation(mods.targetActor, attackMods.targetArea)).areaHit;

      const areaDamages = {};
      if (hit) {
        areaDamages[location] = [{
          damage,
          damageHtml: CyberpunkItem._inlineRollHtml(damage, damageRoll, "damage")
        }];
      }

      last = await new Multiroll(localizeParam("SpreadPatternTitle",
        { index: index + 1, count: patterns }))
        .addRoll(attackRoll, { name: localize("Attack") })
        .execute(undefined, "systems/cyberpunk2020/templates/chat/multi-hit.hbs", {
          target: targetTokens[t],
          range: attackMods.range,
          toHit: DC,
          attackRoll,
          fired: 1,
          hits: hit ? 1 : 0,
          hit,
          areaDamages,
          fumble: fumble?.fumble ?? null,
          // On the burst's last card only: the allocation is one event, and repeating the list on
          // every pattern reads as several separate misses.
          uncoveredTargets: index === shots.length - 1 ? uncoveredNames : "",
          locals: { range: { range: actualRangeBracket } }
        },
        // Without these the card carries no `flags.cyberpunk2020.attack` at all, so the version
        // gate rejects it, no *apply damage* button is rendered and the auto-apply hook never
        // fires — the one arm written for a table with no map was the one whose damage a GM had to
        // enter by hand (`T378`). The three fire modes beside it pass exactly this.
        this.__attackFlags({
          target: targetTokens[t],
          areaDamages,
          ammo,
          fireMode: attackMods.fireMode,
          range: attackMods.range
        }));
    }

    return last;
  }

  async __fullAuto(attackMods, targetTokens) {
      const system = this._getWeaponSystem();
      // The kind of distance we're attacking at, so we can display Close: <50m or something like that
      let actualRangeBracket = rangeResolve[attackMods.range](effectiveRange(this));
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
      let actualRangeBracket = rangeResolve[attackMods.range](effectiveRange(this));
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
      //
      // D204 — a suppression zone is laid **before** anything is measured and is a corridor rather
      // than a centre, so D199's *"the placed centre is the measure"* has nothing to bite on. The
      // mode is off the auto option entirely and the shooter declares the corridor's reach with a
      // constant band, which is the book's own shape: `07:726-749` prices the width and says
      // nothing about measuring a distance.
      const reach = Math.round(rangeResolve[mods.range]?.(effectiveRange(this)) || 0);
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
      { weaponName: CyberpunkItem.__weaponLabel(this.name, this.actor), rounds, width, saveDC, dmgFormula, results, placed: !!zone,
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
          ammo: snapshotAmmo(this)
          // No `attackerUuid`: this object is spread onto a Region every client can read, and
          // `attackerActorUuid` above already carries the shooter on the card (`T115`).
        }
      }
    };
  }

  async __semiAuto(attackMods, targetTokens = [], attackerToken = null) {
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
      let actualRangeBracket = rangeResolve[attackMods.range](effectiveRange(this));
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
      const targetToken = spread && canvas.ready
        ? canvas.tokens.get(targetTokens[0]?.id)
        : null;
      if (targetToken) {
        const profile = { radius: spread.width / 2, fullDamageWithin: spread.width / 2, multipliers: [] };
        let patternCentre = targetToken.center;
        let scatter = null;
        if (!attackHits) {
          // D201 — a shotgun is one of the book's own area weapons (`07:837`), so a missed pattern
          // is re-centred off the Grenade Table (`07:839`) rather than disappearing: the pellets
          // went somewhere. Gating the zone card on `attackHits` was the divergence from the
          // autoshotgun and from every other splash path, not the baseline (`T376`).
          const direction = await new Roll("1d10").evaluate();
          const distance = await new Roll("1d10").evaluate();
          scatter = { direction: direction.total, distance: distance.total };
          patternCentre = scatterCentre(patternCentre, scatter.direction, scatter.distance);
        }
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
            // Which level's walls the pattern meets, taken where it was fired from — D115's gate
            // reads it the same way a blast's does (`T284`).
            levelId: canvas.level.id,
            corridor: fireCorridor(this.__attackerToken(attackerToken), patternCentre,
              spreadCorridorBands(effectiveRange(this), ammo)),
            // D17's wall exemption is for *"the shot's designated target"*, and a scattered pattern
            // is no longer aimed at anybody — exempting the token it missed would carry the
            // exemption to ground they are not standing on, which is `T380`'s reasoning on the
            // autoshotgun's own patterns.
            aimedTokenUuid: attackHits ? (targetTokens[0]?.tokenUuid ?? "") : "",
            aimedZone: attackHits ? location : ""
          },
          damage: dmg,
          damageRoll,
          onTarget: attackHits,
          scatter,
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

  async __meleeBonk(attackMods, targetTokens = [], attackerToken = null) {
      // Melee attacks do not have a fixed DC; they are contested instead
      let attackRoll = await this.attackRoll(attackMods);

      const defense = attackMods.targetActor
        ? await resolveDefense(attackMods.targetActor, attackRoll.total,
            { attackerName: displayName(this.actor, attackerToken), itemName: this.name,
              defenderToken: CyberpunkItem.__targetToken(targetTokens[0]),
              messageMode: CyberpunkItem.__targetMessageMode(targetTokens[0]),
              hideAttacker: CyberpunkItem.__attackerIsHidden(this.actor) })
        : null;

      let fumble = null;
      if (game.settings.get("cyberpunk2020", "fumbleTableEnabled") && isFumbleRoll(attackRoll)) {
        fumble = await buildSkillFumbleData({
          skill: { system: { stat: "ref" } },
          roll: attackRoll
        });
      }

      // D152 — a fumbled swing misses however the contest went, the `forceMiss` the four ranged
      // sites already take: the corebook has one REFLEX/Combat fumble table and none of its six
      // outcomes lands the hit it was aimed at (`04:121-133`). The defender still rolls what he
      // would have rolled, and the fumble block below still posts.
      const hit = (defense ? defense.hit : true) && !fumble;

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

      let bigRoll = new Multiroll(CyberpunkItem.__weaponLabel(this.name, this.actor), this.system.flavor)
        .addRoll(attackRoll, { name: localize("Attack") });

      // One opposed check is one message with two rolls: the card draws the defense die from the
      // template data either way, but only a message roll is animated and stored (`T40`). D163's
      // All-Out Parry is the one defence with no die to add.
      if (defense?.roll) bigRoll.addRoll(defense.roll, { name: localize("Defense") });

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
  async __martialBonk(attackMods, targetTokens = [], attackerToken = null) {
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

    // D200 — Pacific Rim p.144 makes the Jump Kick's -5 automatic, and it ships with the
    // maneuver's own `1D6+5` rather than after it (`T368`). Only under FNFF2, which is the only
    // rule set that offers the maneuver at all.
    const jumpKickMod = (fnff2 && action === martialActions.jumpKick) ? JUMP_KICK_TO_HIT : 0;

    let attackRoll = new Roll(
            `1d10x10 + @stats.ref.total + @attackBonus + @keyTechniqueBonus + @actionBonus + @extraMod + @targetAreaMod${weaponAccuracy !== 0 ? " + @weaponAccuracy" : ""}${actionPenalty !== 0 ? " + @actionPenalty" : ""}${jumpKickMod !== 0 ? " + @jumpKickMod" : ""}`,
      {
        stats: system.stats,
        attackBonus: martialSkillLevel,
        keyTechniqueBonus: keyTechniqueBonus,
        actionBonus: actionBonus,
        extraMod: extraMod,
        targetAreaMod,
        weaponAccuracy,
        actionPenalty,
        jumpKickMod
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

    // D90 — the combat tab's one unarmed button stands in for every maneuver, so its damage comes
    // from the maneuver rather than from the Strike document it borrows its data from: a Kick did
    // half what `07:985` prints. Identified by `_id` because the melee packs carry this weapon under
    // a translated name. A real melee weapon is untouched and rolls its own DAM.
    //
    // D200 adds FNFF2's four, Ram's off a chart on the attacker's own BODY (`T368`).
    const maneuverDamage = this.id === UNARMED_STRIKE_ID
      ? unarmedManeuverFormula(action, system.stats.bt.total)
      : null;
    const damageDie = maneuverDamage ?? baseWeaponDamage;

    // `T392` — Ram's p.143 chart is the **only** maneuver damage that already has the attacker's
    // BODY built into it: its additive column is `strengthDamageBonus(BODY)` at every printed row,
    // so appending `@strengthBonus` here counted BODY twice. Every other maneuver, FNFF2's three
    // included, is a flat die that RAW does add HH(BODY) to.
    //
    // Truthiness, not `!== null`: `unarmedManeuverFormula` answers **`undefined`** for a Ram off the
    // FNFF2 gate, and that state rolls the stand-in's own die, which never carried BODY — testing
    // against `null` alone dropped `@strengthBonus` from it (`T404`).
    const carriesBodyAlready = maneuverDamage && action === martialActions.ram;

    if (canDealDamage && damageDie) {
      damageFormula = carriesBodyAlready
        ? `${damageDie}+@martialDamageBonus`
        : `${damageDie}+@strengthBonus+@martialDamageBonus`;
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
          { attackerName: displayName(actor, attackerToken), itemName: this.name,
            defenderToken: CyberpunkItem.__targetToken(targetTokens[0]),
            messageMode: CyberpunkItem.__targetMessageMode(targetTokens[0]),
            hideAttacker: CyberpunkItem.__attackerIsHidden(actor) })
      : null;
    // D152 — the same forced miss the plain swing and the four ranged sites take: the fumble block
    // built above still posts, and the contest cannot land the hit (`T276`).
    const hit = (defense ? defense.hit : true) && !fumble;

    // One opposed check is one message with two rolls (`T40`) — D163's All-Out Parry is the one
    // defence with no die to add.
    if (defense?.roll) results.addRoll(defense.roll, { name: localize("Defense") });

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
