import { makeD10Roll, Multiroll } from "../dice.js";
import { isFumbleRoll, buildSkillFumbleData } from "../utils.js";
import { SortOrders, sortSkills } from "./skill-sort.js";
import { btmFromBT, MARTIAL_ART_KEY_BY_ID, MARTIAL_ART_ID_BY_KEY, FNFF2_ONLY_MARTIAL_ART_IDS, isFnff2Enabled, AWARENESS_NOTICE_SKILL_ID, MELEE_DEFENSE_SKILL_IDS } from "../lookups.js";
import { properCase, localize, getDefaultSkills, cwHasType, cwIsEnabled, withCompendiumSource } from "../utils.js"

export function combineSP(curr, add) {
  const a = Number(curr) || 0;
  const b = Number(add) || 0;
  if (!a) return b;
  if (!b) return a;

  const diff = Math.abs(a - b);
  let mod;
  if (diff >= 27) mod = 0;
  else if (diff >= 21) mod = 1;
  else if (diff >= 15) mod = 2;
  else if (diff >= 9)  mod = 3;
  else if (diff >= 5)  mod = 4;
  else                 mod = 5;

  return Math.max(a, b) + mod;
}

// Maximum possible SP for a set of layers
// exact O(N * 2^N) up to N=16
export function maxLayeredSP(layers) {
  if (!layers || !layers.length) return 0;

  const sp = layers
    .map(v => Number(v) || 0)
    .filter(v => v > 0);

  const n = sp.length;
  if (!n) return 0;
  if (n === 1) return sp[0];

  // I think this number of layers will be more than enough for common sense
  const MAX_EXACT_LAYERS = 16;

  if (n <= MAX_EXACT_LAYERS) {
    const size = 1 << n;
    const dp = new Array(size);
    dp[0] = 0;

    for (let mask = 1; mask < size; mask++) {
      let best = 0;

      for (let i = 0; i < n; i++) {
        const bit = 1 << i;
        if (!(mask & bit)) continue;

        const prevMask = mask ^ bit;
        const val = combineSP(dp[prevMask], sp[i]);
        if (val > best) best = val;
      }
      dp[mask] = best;
    }

    return dp[size - 1];
  }

  // Fallback for completely crazy cases (too many layers):
  // each time, we choose the layer that maximizes the current SP
  let current = 0;
  const remaining = sp.slice();

  while (remaining.length) {
    let bestIdx = 0;
    let bestVal = combineSP(current, remaining[0]);

    for (let i = 1; i < remaining.length; i++) {
      const val = combineSP(current, remaining[i]);
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }

    current = bestVal;
    remaining.splice(bestIdx, 1);
  }

  return current;
}

/**
 * Extend the base Actor document by defining a custom roll data structure which is ideal for the Simple system.
 * @extends {Actor}
 */
export class CyberpunkActor extends Actor {


  /** @override */
  async _preCreate(data, options = {}, user) {
    const allowed = await super._preCreate(data, options, user);
    if (allowed === false) return false;

    const actorType = data?.type ?? this.type;
    const updates = {};

    if (actorType === "character") {
      // Seeded only where the creation data left the image unset: these are defaults, and a
      // default that overwrites a supplied value silently discards it on import.
      if (!data?.img) updates["img"] = "systems/cyberpunk2020/img/edgerunner.svg";
      if (!data?.prototypeToken?.texture?.src) {
        updates["prototypeToken.texture.src"] = "systems/cyberpunk2020/img/edgerunner.svg";
      }
      updates["prototypeToken.actorLink"] = true;
      updates["prototypeToken.sight.enabled"] = true;
      if (!data?.system?.icon) updates["system.icon"] = "systems/cyberpunk2020/img/edgerunner.svg";
    }

    const items = this._getInitialItemsSource(data);

    // Default skills
    const firstSkill = items.find((item) => item.type === "skill");
    if (!firstSkill) {
      // Using toObject is important - Foundry does not like creating new documents from documents themselves.
      const skillsData = sortSkills(await getDefaultSkills(), SortOrders.Name)
        .map((item) => withCompendiumSource(item));
      items.push(...skillsData);
      updates["system.skillsSortedBy"] = "Name";
    }

    // Default unarmed melee weapons: Kick + Strike
    if (actorType === "character" || actorType === "npc") {
      const UNARMED_WEAPON_IDS = [
        "TF0nBrjofPX2RiuG", // Kick
        "TZoiQuE8fUzJ8Jta"  // Strike
      ];

      const meleePack = game.packs.get("cyberpunk2020.melee");

      if (meleePack) {
        for (const wid of UNARMED_WEAPON_IDS) {
          if (CyberpunkActor._hasItemWithBaseId(items, wid)) continue;

          const doc = await meleePack.getDocument(wid);
          if (!doc) continue;

          const obj = withCompendiumSource(doc);
          obj.system = obj.system ?? {};
          obj.system.equipped = true;

          items.push(obj);
        }
      }
    }

    updates.items = items;
    this.updateSource(updates);
  }

  /**
   * Return a mutable initial embedded-items source array for _preCreate.
   * Keeping this as plain source data avoids a post-create Actor.update call.
   *
   * @param {object} data
   * @returns {object[]}
   * @private
   */
  _getInitialItemsSource(data) {
    const sourceItems = this._source?.items ?? data?.items ?? [];
    return Array.isArray(sourceItems) ? foundry.utils.deepClone(sourceItems) : [];
  }

  /**
   * @param {object[]} items
   * @param {string} baseId
   * @returns {boolean}
   * @private
   */
  static _hasItemWithBaseId(items, baseId) {
    // Among the candidates, not equal to the first: during creation an item's own `_id` is
    // freshly assigned and sorts first, so a copy that carries the compendium original only in
    // its source id was never recognised and got a duplicate injected (T-18).
    return items.some((item) => CyberpunkActor._getItemIdCandidates(item).includes(baseId));
  }

  /**
   * Augment the basic actor data with additional dynamic data - the stuff that's calculated from other data
   *
   * Derived, not `prepareData`: core applies the ActiveEffect `"final"` phase after
   * `super.prepareData()` returns (`client/documents/actor.mjs:423-424`, 14.365.0), so an engine
   * that ran there recomputed every derived value an effect had just set, silently (`T-28`).
   */
  prepareDerivedData() {
    super.prepareDerivedData();
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

    const armorLayersByArea = {};
    const hardArmorAreas = new Set();

    // Sort through this now so we don't have to later
    let equippedItems = this.items.contents.filter(item => {
      return item.system.equipped;
    });

    // SDP per zone (implants + modules)
    system.sdp = system.sdp || {};
    system.sdp.sum = { Head:0, Torso:0, lArm:0, rArm:0, lLeg:0, rLeg:0 };
    system.sdp.current = system.sdp.current || { Head:0, Torso:0, lArm:0, rArm:0, lLeg:0, rLeg:0 };

    const ZONES = ["Head","Torso","lArm","rArm","lLeg","rLeg"];
    const addSdp = (zoneKey, amount) => {
      const n = Number(amount) || 0;
      if (!n) return;
      if (!ZONES.includes(zoneKey)) return;
      system.sdp.sum[zoneKey] += n;
    };

    const allItems = this.items.contents || [];
    const byId = new Map(allItems.map(i => [i.id, i]));
    const eqCyber = (equippedItems || []).filter(i => i.type === "cyberware");
    const eqCyberEnabled = eqCyber.filter(cwIsEnabled);

    for (const it of eqCyberEnabled) {
      if (!cwHasType(it, "Implant")) continue;
      const sdp = Number(it.system?.CyberWorkType?.SDP) || 0;
      if (sdp <= 0) continue;

      const mz = it.system?.MountZone || "";
      if (mz === "Head") addSdp("Head", sdp);
      else if (mz === "Torso") addSdp("Torso", sdp);
      else if (mz === "Arm" || mz === "Leg") {
        // Define the side: for the implant — from it; for the module — from the parent
        let side = it.system?.CyberBodyType?.Location || "";
        if ((!side || side === "") && it.system?.Module?.IsModule) {
          const pid = it.system?.Module?.ParentId;
          const parent = pid ? byId.get(pid) : null;
          side = parent?.system?.CyberBodyType?.Location || "";
        }
        if (side === "Left")  addSdp(mz === "Arm" ? "lArm" : "lLeg", sdp);
        if (side === "Right") addSdp(mz === "Arm" ? "rArm" : "rLeg", sdp);
      }
      // MountZone “Nervous” is not taken into account in armored zones
    }

    // By default, “current” = “sum” if current is not yet specified
    for (const z of ZONES) {
      if (system.sdp.current[z] == null) {
        system.sdp.current[z] = system.sdp.sum[z];
      }
    }

    // Cyberware (Characteristic): apply stat bonuses
    Object.values(stats).forEach(s => { s.cyberMod = 0; });

    const charCw = (eqCyberEnabled || []).filter(i => cwHasType(i, "Characteristic"));

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

    // Equipped cyber-armor implants (only enabled)
    const cwArmorItems = (eqCyberEnabled || []).filter(i => cwHasType(i, "Armor"));

    // Staged Penetration is optional, so ablation is recorded on the armor either way and only
    // subtracted here while the rule is on — switching it off restores the armor's printed SP.
    const ablationEnabled = game.settings.get("cyberpunk2020", "armorAblation");

    // Inventory armor: accumulate EV and layer SP
    equippedItems.filter(i => i.type === "armor").forEach(armor => {
      const armorData = armor.system;
      totalEncumbrance += Number(armorData.encumbrance || 0);

      for (const armorArea in armorData.coverage) {
        const location = system.hitLocations[armorArea];
        if (!location) continue;

        const ablated = ablationEnabled ? Number(armorData.coverage[armorArea].ablation) || 0 : 0;
        const addSP = (Number(armorData.coverage[armorArea].stoppingPower) || 0) - ablated;
        if (addSP <= 0) continue;

        if (!armorLayersByArea[armorArea]) armorLayersByArea[armorArea] = [];
        armorLayersByArea[armorArea].push(addSP);
        if (armorData.hard) hardArmorAreas.add(armorArea);
      }
    });

    // Cyber-armor: collecting SP layers (then we'll calculate them all together)
    for (const cw of cwArmorItems) {
      const locs = cw.system?.CyberWorkType?.Locations || {};
      for (const [areaKey, sp] of Object.entries(locs)) {
        const loc = system.hitLocations[areaKey];
        const addSP = Number(sp) || 0;
        if (!loc || addSP <= 0) continue;

        if (!armorLayersByArea[areaKey]) armorLayersByArea[areaKey] = [];
        armorLayersByArea[areaKey].push(addSP);
        // Cyber-armour is hard armour.
        hardArmorAreas.add(areaKey);
      }
    }

    // After collecting all layers, we calculate the maximum SP by zone
    for (const [areaKey, area] of Object.entries(system.hitLocations)) {
      const layers = armorLayersByArea[areaKey] || [];
      area.stoppingPower = maxLayeredSP(layers);
      // A zone counts as hard if any layer covering it is; the ammunition's hard/soft multipliers
      // are the only consumer.
      area.hard = hardArmorAreas.has(areaKey);
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

    // SDP: current follows sum only when sum itself has changed
    {
      const ZONES = ["Head","Torso","lArm","rArm","lLeg","rLeg"];
      system.sdp = system.sdp || {};
      system.sdp.sum = system.sdp.sum || { Head:0, Torso:0, lArm:0, rArm:0, lLeg:0, rLeg:0 };
      system.sdp.current = system.sdp.current || { Head:0, Torso:0, lArm:0, rArm:0, lLeg:0, rLeg:0 };
      system.sdp._lastSum = system.sdp._lastSum || {};

      for (const z of ZONES) {
        const sumNow = Number(system.sdp.sum?.[z] || 0);
        const lastSum = system.sdp._lastSum[z];

        if (lastSum === undefined) {
          // First calculation pass for zone z
          // Rules:
          // If current is empty OR equal to 0 (default start sheet), set current = sumNow
          // If the player has already entered a non-zero value (e.g., 18), do not overwrite it
          const curRaw = system.sdp.current?.[z];
          const curNum = Number(curRaw);
          // A zone the player has written to keeps its number, 0 included: that is the value they
          // record once the implant has taken all its damage, and without the marker it is
          // indistinguishable from the untouched default and gets reseeded from the sum.
          const touched = system.sdp.touched?.[z] === true;

          if (curRaw == null || Number.isNaN(curNum) || (curNum === 0 && !touched)) {
            system.sdp.current[z] = sumNow;
          }
          system.sdp._lastSum[z] = sumNow;
        }
        else if (lastSum !== sumNow) {
          // Amount changed (implant/module installed/removed) — resynchronize current
          system.sdp.current[z] = sumNow;
          system.sdp._lastSum[z] = sumNow;
        }
        else {
          // The amount has not changed — leave current alone (keep the player's manual entry)
          if (system.sdp.current[z] == null) system.sdp.current[z] = sumNow;
        }
      }
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
    // The cyber-armor penalty is re-applied here rather than left to the stage that adds it to
    // every other stat's total: this assignment replaces that total, so applying it earlier is
    // the same as discarding it (T-14).
    emp.total = preLossEmp - Math.floor(hl / 10) + Number(emp.armorImplantMod || 0);

    const cwCheckMods = this._getCharacteristicChecksMods();
    system.initiativeImplantMod = Number(cwCheckMods.initiative || 0);
    system._cwChecks = { saveStun: Number(cwCheckMods.saveStun || 0) };

    // CHIPS: only active ones, auto-switching skills to chip level
    const activeChipware = (eqCyber || []).filter(i =>
      cwHasType(i, "Chip") && cwIsEnabled(i) && !!i.system?.CyberWorkType?.ChipActive
    );
    // { “Skill Name”: maximum level among active chips }
    const chipMap = {};
    for (const cw of activeChipware) {
      const skills = cw.system?.CyberWorkType?.ChipSkills || {};
      for (const [skKey, lvl] of Object.entries(skills)) {
        const n = Number(lvl) || 0;
        if (!n) continue;
        chipMap[skKey] = Math.max(chipMap[skKey] ?? 0, n);
      }
    }
    const skillItems = this.items.contents.filter(i => i.type === "skill");
    for (const si of skillItems) si.system.autoChipped = false;

    for (const si of skillItems) {
      const chipLvl = chipMap[si.id] ?? chipMap[si.name];
      if (!chipLvl) continue;
      si.system.chipLevel = chipLvl;
      si.system.isChipped = true;
      si.system.autoChipped = true;
    }
  }

  /**
   * 
   * @param {string} sortOrder The order to sort skills by. Options are in skill-sort.js's SortOrders. "Name" or "Stat". Default "Name".
   */
  sortSkills(sortOrder = "Name") {
    let allSkills = this.itemTypes.skill;
    sortOrder = sortOrder || Object.keys(SortOrders)[0];
    let sortedView = sortSkills(allSkills, SortOrders[sortOrder]).map(skill => skill.id);

    this.update({
      "system.sortedSkillIDs": sortedView,
      "system.skillsSortedBy": sortOrder
    });
  }

  /**
   * The single writer of applied combat damage. Everything else in the pipeline resolves; only
   * this method persists.
   *
   * @param {object} damage
   * @param {number} damage.wound Points to add to the wound track
   * @param {Object<string, number>} damage.sdp Points to take off a cyberlimb, keyed by zone
   */
  async applyDamage({ wound = 0, sdp = {} } = {}) {
    const update = {};

    if (wound > 0) {
      update["system.damage"] = Math.min(40, Math.max(0, Number(this.system.damage) + wound));
    }

    for (const [zone, amount] of Object.entries(sdp)) {
      if (!amount) continue;
      update[`system.sdp.current.${zone}`] = Math.max(0, Number(this.system.sdp.current?.[zone] ?? 0) - amount);
      // A zone damage drove to exactly 0 is indistinguishable from an untouched default, and the
      // reconciliation in _prepareCharacterData reseeds it from the sum without this marker.
      update[`system.sdp.touched.${zone}`] = true;
    }

    if (foundry.utils.isEmpty(update)) return null;
    return this.update(update);
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
    const fnff2 = isFnff2Enabled();
    const trained = [];
    const usedSkillIds = new Set();

    for (const [martialKey, martialId] of Object.entries(MARTIAL_ART_ID_BY_KEY)) {
      if (!fnff2 && FNFF2_ONLY_MARTIAL_ART_IDS.has(martialId)) continue;

      const skill = this._getSkillByStableId(martialId);
      if (!skill) continue;
      if (!CyberpunkActor._hasAnyPositiveSkillValue(skill)) continue;

      trained.push(martialKey);
      usedSkillIds.add(skill.id);
    }

    const customMartials = (this.itemTypes?.skill ?? [])
      .filter(skill => !usedSkillIds.has(skill.id))
      .filter(skill => !CyberpunkActor._getMartialKeyForSkill(skill))
      .filter(skill => CyberpunkActor._looksLikeCustomMartialSkill(skill))
      .filter(skill => CyberpunkActor._hasAnyPositiveSkillValue(skill))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map(skill => CyberpunkActor._customMartialKeyForSkill(skill));

    trained.push(...customMartials);
    return trained;
  }

  /**
   * Find an owned skill by the stable id used in system lookup tables.
   *
   * Do not resolve built-in martial arts by localized names. Localized packs must
   * keep the same _id/source id, so the id table remains the primary source of
   * truth. Name fallback below is used only for legacy/custom martial data.
   *
   * @param {string} stableId
   * @returns {Item|null}
   * @private
   */
  _getSkillByStableId(stableId) {
    if (!stableId) return null;

    const direct = this.items.get(stableId);
    if (direct?.type === "skill") return direct;

    return this.items.find(item => {
      if (item.type !== "skill") return false;
      return CyberpunkActor._getItemIdCandidates(item).includes(stableId);
    }) ?? null;
  }

  /**
   * The defensive skills this actor can counter a melee attack with, best first. Empty when the
   * actor has none of them, which leaves the defense at REF alone.
   *
   * @returns {Array<{skillId: string, label: string, total: number}>}
   */
  defenseOptions() {
    const ref = Number(this.system.stats.ref.total) || 0;
    const options = [];

    for (const id of [...MELEE_DEFENSE_SKILL_IDS, ...Object.values(MARTIAL_ART_ID_BY_KEY)]) {
      const skill = this._getSkillByStableId(id);
      if (!skill) continue;

      options.push({
        skillId: id,
        label: this.getSkillDisplayName(skill),
        total: ref + CyberpunkActor.realSkillValue(skill)
      });
    }

    return options.sort((a, b) => b.total - a.total);
  }

  static _customMartialPrefix() {
    return "custom-martial:";
  }

  static _customMartialKeyForSkill(skill) {
    return `${CyberpunkActor._customMartialPrefix()}${skill.id}`;
  }

  static _customMartialItemIdFromKey(value) {
    const key = String(value ?? "");
    const prefix = CyberpunkActor._customMartialPrefix();
    return key.startsWith(prefix) ? key.slice(prefix.length) : null;
  }

  _getCustomMartialSkill(value) {
    const id = CyberpunkActor._customMartialItemIdFromKey(value);
    if (!id) return null;

    const skill = this.items.get(id);
    return skill?.type === "skill" ? skill : null;
  }

  /**
   * Normalize skill names for non-martial fallback lookups and custom martial
   * art detection.
   *
   * @param {string} value
   * @returns {string}
   * @private
   */
  static _normalizeSkillName(value) {
    return String(value ?? "")
      .replace(/\s*~\s*/g, "")
      .replace(/\s*\(\d+\)\s*$/g, "")
      .replace(/\s*:\s*/g, ": ")
      .replace(/\s+/g, " ")
      .trim();
  }

  static _stripMartialDifficultyTag(value) {
    return String(value ?? "")
      .replace(/\s*~\s*/g, "")
      .replace(/\s*\(\d+\)\s*$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  static _martialNamePrefixes() {
    const prefixes = new Set(["Martial Arts"]);
    const localized = localize("SkillMartialArts");

    if (localized && !String(localized).includes("SkillMartialArts")) {
      prefixes.add(localized);
    }

    return [...prefixes]
      .map(prefix => CyberpunkActor._normalizeSkillName(prefix))
      .filter(Boolean);
  }

  static _stripMartialNamePrefix(value) {
    const normalized = CyberpunkActor._normalizeSkillName(value);

    for (const prefix of CyberpunkActor._martialNamePrefixes()) {
      if (normalized.toLowerCase().startsWith(`${prefix.toLowerCase()}: `)) {
        return normalized.slice(prefix.length + 2).trim();
      }
    }

    return normalized;
  }

  static _looksLikeCustomMartialSkill(skill) {
    if (skill?.type !== "skill") return false;
    const name = CyberpunkActor._normalizeSkillName(skill.name);
    if (!name) return false;

    return CyberpunkActor._martialNamePrefixes()
      .some(prefix => name.toLowerCase().startsWith(`${prefix.toLowerCase()}: `));
  }

  /**
   * Return all stable ids that can identify an Item, including embedded item id
   * and compendium source id. Names are intentionally ignored for built-in
   * martial arts identity.
   *
   * @param {Item|object} itemData
   * @returns {string[]}
   * @private
   */
  static _getItemIdCandidates(itemData) {
    const ids = new Set();

    const add = (value) => {
      if (value == null || value === "") return;
      ids.add(String(value));
    };

    const addSourceId = (sourceId) => {
      if (!sourceId || typeof sourceId !== "string") return;
      add(sourceId.split(".").pop());
    };

    add(itemData?.id);
    add(itemData?._id);
    add(itemData?._source?._id);

    // v14 relocated flags.core.sourceId to _stats.compendiumSource; the legacy path is still
    // read because worlds migrated before that carry it and are never cleaned up.
    addSourceId(itemData?._stats?.compendiumSource);
    addSourceId(itemData?._source?._stats?.compendiumSource);
    addSourceId(itemData?.flags?.core?.sourceId);
    addSourceId(itemData?._source?.flags?.core?.sourceId);

    return [...ids];
  }

  /**
   * Resolve a built-in martial-art skill Item to a martial-art lookup key.
   *
   * This deliberately uses only stable ids/source ids. Localized item names are
   * not part of built-in martial-art identity because different languages share
   * the same _id by system convention.
   *
   * @param {Item|object} skill
   * @returns {string|null}
   * @private
   */
  static _getMartialKeyForSkill(skill) {
    for (const id of CyberpunkActor._getItemIdCandidates(skill)) {
      const martialKey = MARTIAL_ART_KEY_BY_ID[id];
      if (martialKey) return martialKey;
    }

    return null;
  }

  _getMartialSkillByDisplayName(value) {
    const target = CyberpunkActor._normalizeSkillName(value);
    if (!target) return null;

    const prefixLoc = localize("SkillMartialArts");
    const prefixCandidates = CyberpunkActor._martialNamePrefixes();

    for (const [martialKey, martialId] of Object.entries(MARTIAL_ART_ID_BY_KEY)) {
      const skill = this._getSkillByStableId(martialId);
      if (!skill) continue;

      const localizedShort = localize("Skill" + martialKey);
      const labelCandidates = new Set([
        martialKey,
        skill.name,
        localizedShort
      ]);

      if (localizedShort && !String(localizedShort).includes("Skill")) {
        for (const prefix of prefixCandidates) {
          labelCandidates.add(`${prefix}: ${localizedShort}`);
        }
      }

      if (prefixLoc && !String(prefixLoc).includes("SkillMartialArts")) {
        labelCandidates.add(`${prefixLoc}: ${localizedShort}`);
      }

      for (const candidate of labelCandidates) {
        const normalized = CyberpunkActor._normalizeSkillName(candidate);
        if (normalized === target) return skill;
        if (CyberpunkActor._stripMartialNamePrefix(normalized) === target) return skill;
      }
    }

    const customSkill = (this.itemTypes?.skill ?? []).find(skill => {
      if (!CyberpunkActor._looksLikeCustomMartialSkill(skill)) return false;
      const fullName = CyberpunkActor._normalizeSkillName(skill.name);
      const shortName = CyberpunkActor._stripMartialNamePrefix(skill.name);
      return fullName === target || shortName === target;
    });

    return customSkill ?? null;
  }

  getMartialDisplayName(martialKey) {
    if (martialKey === "Brawling") return localize("SkillBrawling");

    const customSkill = this._getCustomMartialSkill(martialKey);
    if (customSkill) {
      return CyberpunkActor._stripMartialNamePrefix(customSkill.name);
    }

    const localized = localize("Skill" + martialKey);
    const label = localized && !String(localized).includes("Skill") ? localized : martialKey;
    return CyberpunkActor._stripMartialNamePrefix(
      CyberpunkActor._stripMartialDifficultyTag(label)
    );
  }
  getSkillDisplayName(skill) {
    if (!skill) return "";

    const martialKey = CyberpunkActor._getMartialKeyForSkill(skill);
    if (!martialKey) return skill.name;

    const localizationKey = `martials.${martialKey}`;
    const localized = localize(localizationKey);

    if (localized && localized !== `CYBERPUNK.${localizationKey}`) {
      return localized;
    }

    return skill.name;
  }

  /**
   * Used only to decide whether a martial-art skill should appear in the attack
   * dialog. A manually entered base level should still make the art selectable
   * even if a stale chip toggle currently makes the effective value zero.
   *
   * @param {Item|object} skill
   * @returns {boolean}
   * @private
   */
  static _hasAnyPositiveSkillValue(skill) {
    const data = skill?.system ?? skill ?? {};
    return (Number(data.level) || 0) > 0
      || (Number(data.chipLevel) || 0) > 0
      || CyberpunkActor.realSkillValue(skill) > 0;
  }

  static realSkillValue(skill) {
    if (!skill) return 0;
    const data = skill.system ?? skill;
    let value = Number(data.level) || 0;
    const chipActive = !!(data.isChipped || data.autoChipped);
    if (chipActive) value = Number(data.chipLevel) || 0;
    return value;
  }

  getSkillVal(skillName) {
    const customMartial = this._getCustomMartialSkill(skillName);
    if (customMartial) return CyberpunkActor.realSkillValue(customMartial);

    const martialId = MARTIAL_ART_ID_BY_KEY?.[skillName];
    if (martialId) {
      const byId = this._getSkillByStableId(martialId);
      return byId ? CyberpunkActor.realSkillValue(byId) : 0;
    }

    const martialByDisplayName = this._getMartialSkillByDisplayName(skillName);
    if (martialByDisplayName) return CyberpunkActor.realSkillValue(martialByDisplayName);

    const nameLoc = localize("Skill" + skillName);
    const prefixLoc = localize("SkillMartialArts");

    const shortName = nameLoc.includes("Skill") ? null : nameLoc;
    const candidates = new Set();

    if (shortName) candidates.add(CyberpunkActor._normalizeSkillName(shortName));
    if (shortName && !prefixLoc.includes("Skill")) {
      candidates.add(CyberpunkActor._normalizeSkillName(`${prefixLoc}: ${shortName}`));
    }
    candidates.add(CyberpunkActor._normalizeSkillName(skillName));

    const skillItem = this.itemTypes.skill.find(s => candidates.has(CyberpunkActor._normalizeSkillName(s.name)));
    if (!skillItem) return 0;

    return CyberpunkActor.realSkillValue(skillItem);
  }

  /**
   * Skill check with Advantage / Disadvantage taken into account
   * @param {string}  skillId
   * @param {number}  extraMod
   * @param {boolean} advantage
   * @param {boolean} disadvantage
   */
  async rollSkill(skillId, extraMod = 0, advantage = false, disadvantage = false, hiddenAdvantage = false) {
    const skill = this.items.get(skillId);
    if (!skill) return;

    // generate the list of modifiers
    const parts = [
      CyberpunkActor.realSkillValue(skill),
      skill.system.stat ? `@stats.${skill.system.stat}.total` : null,
      (skill.id ?? skill._id) === AWARENESS_NOTICE_SKILL_ID ? "@CombatSenseMod" : null,
      extraMod || null
    ].filter(Boolean);
    
    // Roll modifier from implants (Characteristic)
    const cMod = this._getCharacteristicSkillMod(skill);
    if (cMod) parts.push(cMod);

    const makeRoll = () => makeD10Roll(parts, this.system); // d10 + parts

    // if both are accidentally marked — ignore
    if (advantage && disadvantage) { advantage = disadvantage = false; }

    // Advantage / Disadvantage
    if (advantage || disadvantage) {
      const r1 = makeRoll();
      const r2 = makeRoll();

      await Promise.all([r1.evaluate(), r2.evaluate()]);

      const chosen = advantage
        ? (r1.total >= r2.total ? r1 : r2)   // best
        : (r1.total <= r2.total ? r1 : r2);  // worst

      const other = (chosen === r1) ? r2 : r1;

      // Fumble Table
      let fumble = null;
      if (game.settings.get("cyberpunk2020", "fumbleTableEnabled") && isFumbleRoll(chosen)) {
        fumble = await buildSkillFumbleData({ skill, roll: chosen });
      }

      // Players must always reveal advantage/disadvantage
      const revealAdvDis = !game.user.isGM || !hiddenAdvantage;

      if (revealAdvDis) {
        const flavor = localize(advantage ? "Roll.AdvantageFlavor" : "Roll.DisadvantageFlavor");
        const keptName = localize(advantage ? "Roll.BestRoll" : "Roll.WorstRoll");
        const otherName = localize("Roll.OtherRoll");

        return new Multiroll(skill.name, flavor)
          .addRoll(chosen, { name: keptName })
          .addRoll(other,  { name: otherName })
          .defaultExecute({ fumble });
      }

      // Hidden (GM): show as a normal roll, without extra info
      return new Multiroll(skill.name)
        .addRoll(chosen)
        .defaultExecute({ fumble });
    }

    // normal roll
    const r = makeRoll();
    await r.evaluate();

    let fumble = null;
    if (game.settings.get("cyberpunk2020", "fumbleTableEnabled") && isFumbleRoll(r)) {
      fumble = await buildSkillFumbleData({ skill, roll: r });
    }

    return new Multiroll(skill.name)
      .addRoll(r)
      .defaultExecute({ fumble });
  }

  /**
   * Sum of skill roll modifiers from equipped implants of type Characteristic.
   * Keys in the implant are the displayed (localized) skill names, same as skill.name.
   * @param {string} skillName
   * @returns {number}
  */
  _getCharacteristicSkillMod(skill) {
    const skillId = skill?.id;
    const skillName = skill?.name;
    let total = 0;

    for (const it of this.items) {
      if (it.type !== "cyberware") continue;

      const sys = it.system;
      if (!sys?.equipped) continue;
      if (!cwIsEnabled(sys)) continue;

      const cwt = sys.CyberWorkType;
      if (!cwt || !cwHasType(cwt, "Characteristic")) continue;

      // Preferred format: keys are Skill Item _id (stable across localizations).
      // Legacy fallback: keys are localized skill names.
      const table = cwt.Skill || {};
      const v = Number(
        (skillId && table[skillId] != null) ? table[skillId] :
        (skillName && table[skillName] != null) ? table[skillName] :
        0
      ) || 0;

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
      if (!cwHasType(sys, "Characteristic")) continue;
      if (!cwIsEnabled(sys)) continue;

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
    return roll.defaultExecute();
  }

  /*
   * Adds this actor to the current encounter - if there isn't one, this just shows an error - and rolls their initiative
   */
  async addToCombatAndRollInitiative(modificator, options = {createCombatants: true}) {
    if(!game.combat) {
      ui.notifications.error(localize("NoCombatError"));
      return;
    }

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
  
    // The system formula already carries @initiativeMod, so the modifier reaches the roll by being
    // persisted - not as an extra term, which would count it twice. The sheet's own change listener
    // is not guaranteed to have finished by the time the row is clicked, hence the write here.
    const mod = Number(modificator);
    if (Number.isFinite(mod) && mod !== this.system.initiativeMod) {
      await this.update({ "system.initiativeMod": mod });
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
      name: localize("SaveStunThreshold")
    });
    rolls.addRoll(new Roll(`${this.deathThreshold()}`), {
      name: localize("SaveDeathThreshold")
    });
    return rolls.defaultExecute();
  }

  /**
   * Roll one Stun or Death save and post its card.
   *
   * The modifier is added to the roll, matching rollStunDeath: both are compared against a
   * threshold the roll must stay at or under, so the two must not disagree on the sign.
   *
   * @param {"stun"|"death"} kind
   * @param {object} [options]
   * @param {number} [options.mod] Situational modifier chosen by whoever rolls
   * @returns {Promise<{total: number, threshold: number, success: boolean}>}
   */
  async rollSave(kind, { mod = 0 } = {}) {
    const death = kind === "death";
    const threshold = death ? this.deathThreshold() : this.stunThreshold();

    const fromImplants = Number(this.system?._cwChecks?.saveStun || 0);
    const totalMod = (Number(mod) || 0) + fromImplants;
    const formula = totalMod ? `1d10 + ${totalMod}` : "1d10";

    const rolls = new Multiroll(
      localize(death ? "SaveDeath" : "SaveStun"),
      localize("UnderThresholdMessage")
    );
    rolls.addRoll(new Roll(formula), { name: localize("Save") });
    rolls.addRoll(new Roll(`${threshold}`), {
      name: localize(death ? "SaveDeathThreshold" : "SaveStunThreshold")
    });
    await rolls.defaultExecute();

    const total = rolls.rolls[0].total;
    return { total, threshold, success: total <= threshold };
  }

  async _preUpdate(changes, options, user) {
    // If the actor's portrait changes and no explicit image change is specified for the prototype token
    // synchronize it, but only if the token currently shows the actor's old portrait
    const newImg = changes?.img;
    if (typeof newImg === "string" && newImg.trim() &&
        !foundry.utils.getProperty(changes, "prototypeToken.texture.src")) {

      const oldImg = this._source?.img ?? this.img;
      const currentTokenSrc = this.prototypeToken?.texture?.src;

      if (!currentTokenSrc || currentTokenSrc === oldImg) {
        foundry.utils.setProperty(changes, "prototypeToken.texture.src", newImg);
      }
    }

    return await super._preUpdate(changes, options, user);
  }
}
