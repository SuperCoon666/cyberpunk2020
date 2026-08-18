import { makeD10Roll, Multiroll } from "../dice.js";
import { isFumbleRoll, buildSkillFumbleData } from "../utils.js";
import { SortOrders, sortSkills } from "./skill-sort.js";
import { btmFromBT, MARTIAL_ART_KEY_BY_ID, MARTIAL_ART_ID_BY_KEY, defensiveMartialActions, FNFF2_ONLY_MARTIAL_ART_IDS, getMartialActionBonus, isCombatAutomationEnabled, isFnff2Enabled, AWARENESS_NOTICE_SKILL_ID, ATHLETICS_SKILL_ID, DEMOLITIONS_SKILL_ID, MELEE_DEFENSE_SKILL_IDS, BRAWLING_SKILL_ID, DODGE_SKILL_ID, MEDICAL_TECH_SKILL_IDS, FIRST_AID_SKILL_ID, STABILIZATION_ADVANTAGES } from "../lookups.js";
import { properCase, localize, localizeParam, displayName, getDefaultSkills, cwHasType, cwIsEnabled, withCompendiumSource } from "../utils.js"
import { InitiativeTokensDialog } from "../dialog/initiative-tokens.js";
import { evaluateCyberpunkRoll } from "../compat.js";

/** The stabilization hand-off has no human in the loop — it is one flag write on the GM's client. */
const STABILIZE_QUERY_TIMEOUT_MS = 5000;

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
    const edgedLayersByArea = {};
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
    // Derived data runs whatever the master switch says, so this read is one of the few that has to
    // AND with it explicitly: with automation off the recorded wear stops being subtracted.
    const ablationEnabled = isCombatAutomationEnabled()
      && game.settings.get("cyberpunk2020", "armorAblation");

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
        // Ch. 07:462 halves the SP of the marked armour, not of the stack, so each √ layer is
        // halved before the layers are combined (`AB-Q2` (a), D52). Doing it to the total would
        // let a Kevlar T-shirt halve the plate over it.
        if (!edgedLayersByArea[armorArea]) edgedLayersByArea[armorArea] = [];
        edgedLayersByArea[armorArea].push(armorData.bladeVulnerable ? Math.floor(addSP / 2) : addSP);
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
        // Cyber-armour is hard armour, and nothing hard is on the book's √ list, so a blade meets
        // it whole.
        if (!edgedLayersByArea[areaKey]) edgedLayersByArea[areaKey] = [];
        edgedLayersByArea[areaKey].push(addSP);
        hardArmorAreas.add(areaKey);
      }
    }

    // After collecting all layers, we calculate the maximum SP by zone
    for (const [areaKey, area] of Object.entries(system.hitLocations)) {
      const layers = armorLayersByArea[areaKey] || [];
      area.stoppingPower = maxLayeredSP(layers);
      // The same stack combined again with every √ layer already halved. Derived here because the
      // stack is collapsed to one number before `resolveHit` ever sees it, so a per-armour flag
      // cannot be applied at hit time.
      area.edgedSp = maxLayeredSP(edgedLayersByArea[areaKey] || []);
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
    // Light is woundState 1 but has no penalty, so offset woundState by -1
    const woundPenalty = Math.max(0, this.woundState() - 1);
    return body - woundPenalty;
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
   * Martial arts are offered **trained only** (`T44`): `_preCreate` seeds every art at level 0, so
   * a stock character used to open a twenty-nine row dropdown with twenty-four rows at the same
   * total. The plain defensive skills stay whatever their level — a skill can be attempted
   * untrained, which `M.7.2` records as a contract.
   *
   * A trained art's total carries its own maneuver bonus the way the attack side already does
   * (`T93`), and since `T232` the option also carries the **maneuvers themselves**, so the prompt
   * can be two-level: the skill first, then the action (D58). `total` stays the best of them —
   * it is the sort key and what an NPC's auto-defence rolls.
   *
   * **Only Brawling and the martial arts carry `actions`.** Ch. `07:982` gives the maneuver list to
   * exactly those two — *"Brawling and Martial Arts attacks are different from other melee attacks
   * in that an attack can be made in a number of ways"* — so Melee, Fencing, Dodge & Escape and
   * Athletics stay single-level, and their defence is what the skill is.
   *
   * @returns {Array<{skillId: string, label: string, total: number,
   *   actions: Array<{action: string, bonus: number, total: number}>, dodging: boolean}>}
   */
  defenseOptions() {
    const ref = Number(this.system.stats.ref.total) || 0;
    const options = [];

    // A maneuver row per defensive action, with the art's own bonus on it — +0 where the style has
    // no key attack there, which `07:1004` makes a bonus list rather than a permission list.
    const maneuvers = (martialKey, base) => defensiveMartialActions().map(action => {
      const bonus = martialKey ? getMartialActionBonus(martialKey, action) : 0;
      return { action, bonus, total: base + bonus };
    });

    // D57/D58: an NPC's Dodge/Block tie goes to **Dodge** — the same number with a strictly
    // no-worse side effect, the -2 a declared dodge costs later ranged attackers. That supersedes
    // `AA-Q4`'s strictly-greater reading, which was decided before the tie itself was ruled.
    const bestOf = actions => actions.reduce((best, row) =>
      row.total > best.total ? row : best, actions[0]);

    for (const id of MELEE_DEFENSE_SKILL_IDS) {
      const skill = this._getSkillByStableId(id);
      if (!skill) continue;

      const base = ref + CyberpunkActor.realSkillValue(skill);
      // Brawling is the one entry in this set that `07:982` gives the maneuver list to.
      const actions = id === BRAWLING_SKILL_ID ? maneuvers(null, base) : [];

      options.push({
        skillId: id,
        label: this.getSkillDisplayName(skill),
        total: base,
        actions,
        dodging: actions.length ? bestOf(actions).action === "Dodge" : id === DODGE_SKILL_ID
      });
    }

    for (const martialKey of this.trainedMartials()) {
      // A built-in art keeps its stable id as the option's identity; a custom one has none, so its
      // own item id is what the prompt sends back.
      const stableId = MARTIAL_ART_ID_BY_KEY[martialKey];
      const skill = stableId
        ? this._getSkillByStableId(stableId)
        : this._getCustomMartialSkill(martialKey);
      if (!skill) continue;

      const base = ref + CyberpunkActor.realSkillValue(skill);
      const actions = maneuvers(martialKey, base);

      options.push({
        skillId: stableId ?? skill.id,
        label: this.getSkillDisplayName(skill),
        total: bestOf(actions).total,
        actions,
        // Which maneuver an auto-defence would build the total out of, so a defence made of dodging
        // earns the `dodgeVsRanged` -2 the plain Dodge skill earns (`T161`, D39).
        dodging: bestOf(actions).action === "Dodge"
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

    // D52 named Athletics for a throw **by `_id`**, and the id survives what the name lookup below
    // does not: a renamed skill, or one whose language pack the client is not running.
    if (skillName === "Athletics") {
      const byId = this._getSkillByStableId(ATHLETICS_SKILL_ID);
      if (byId) return CyberpunkActor.realSkillValue(byId);
    }

    // D102 named Demolitions for setting a charge, by `_id` for the same reason.
    if (skillName === "Demolitions") {
      const byId = this._getSkillByStableId(DEMOLITIONS_SKILL_ID);
      if (byId) return CyberpunkActor.realSkillValue(byId);
    }

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

    // `Combat#scene` is a `ForeignDocumentField` a GM opts into through the tracker's *Link to
    // Viewed Scene*; **core never sets it on its own** — the tracker's own Create Combat button is
    // `Combat.implementation.create()` with no data and `TokenDocument.createCombatants` is
    // `cls.create({active: true})` (`combat-tracker.mjs`, `token.mjs`, 14.365.0), and combatants
    // carry their own `sceneId` instead. Reading it unguarded made the whole mob path below
    // unreachable in the default flow — no picker, one combatant for the gang (`T356`). The viewed
    // scene is what the GM is looking at and is where the tokens they mean are placed.
    const scene = combat.scene ?? canvas.scene;

    // The system formula already carries @initiativeMod, so the modifier reaches the roll by being
    // persisted - not as an extra term, which would count it twice. The sheet's own change listener
    // is not guaranteed to have finished by the time the row is clicked, hence the write here.
    const persistMod = async () => {
      const mod = Number(modificator);
      if (Number.isFinite(mod) && mod !== this.system.initiativeMod) {
        await this.update({ "system.initiativeMod": mod });
      }
    };

    // D159 — one NPC sheet stands for a whole mob, so the GM is asked which of its placed tokens
    // roll: one combatant and one initiative roll each. An unlinked token's own sheet is exactly one
    // token and takes the path below.
    //
    // D166 — every placed token is listed and pickable, and what a pick means depends on the token:
    // one that is not fighting joins and rolls, one that is re-rolls the initiative it already has.
    // The window opens ticked on the **clicked token's cohort**, which is the controlled token for
    // the same reason the attack dialog reads it (D157/D161) — the click is what says which mook the
    // GM means. With none controlled there is no clicked token, and D167 rules that case for the
    // **fighting** cohort — reaching for initiative mid-fight is more often a re-roll of the gang
    // than an addition to it. A mob with nobody fighting yet has no re-roll to mean, so it ticks the
    // joiners, which is D160's initial case.
    if (this.type === "npc" && options.createCombatants && !this.token) {
      const placed = scene?.tokens.filter(t => t.actorId === this.id) ?? [];
      const combatantOf = token => combat.combatants.find(c => c.tokenId === token.id) ?? null;

      if (placed.length) {
        const clicked = canvas.tokens?.controlled
          .find(t => t.document.actorId === this.id && t.document.parent?.id === scene?.id)
          ?.document ?? null;
        const cohort = clicked
          ? Boolean(combatantOf(clicked))
          : placed.some(token => combatantOf(token));

        const picked = placed.length > 1
          ? await InitiativeTokensDialog.pick(placed.map(token => {
            const fighting = Boolean(combatantOf(token));
            return { id: token.id, name: token.name, inCombat: fighting, checked: fighting === cohort };
          }))
          : placed.map(token => token.id);

        // Nothing picked is an answer, not a failure: the GM closed the picker or sent nobody in.
        if (!picked.length) return;

        // Both halves are read **before** the create, because a created combatant is in the
        // collection the moment it exists and would otherwise be counted as a re-roll as well.
        const joining = picked.filter(id => !combat.combatants.some(c => c.tokenId === id));
        const rerolling = picked
          .map(id => combat.combatants.find(c => c.tokenId === id)?.id)
          .filter(Boolean);
        const created = joining.length
          ? await combat.createEmbeddedDocuments("Combatant",
            joining.map(id => ({ actorId: this.id, tokenId: id, sceneId: scene.id })))
          : [];

        await persistMod();
        return combat.rollInitiative([...created.map(c => c.id), ...rerolling]);
      }
    }

    let combatant = combat.combatants.find(c => c.actorId === this.id);

    // If no combatant found and creation is allowed, add the actor to the combat
    if (!combatant && options.createCombatants) {
      // D133 — the tracker is the surface that ruling names first, and core resolves
      // `Combatant#name` as the combatant's own token then straight to `actor.name`, with no
      // prototype step (`client/documents/combatant.mjs:168`, 14.365.0). A combatant created as
      // `{actorId}` alone therefore printed the sheet name players are never meant to see, while
      // every card and prompt printed the token's (`T306`). The token comes off the encounter's own
      // scene — world data — and never `getActiveTokens()`, which core scopes to the viewed scene
      // (`client/documents/actor.mjs:284`) and which answers `[]` for a GM running two scenes.
      // Naming no token stays the answer when there is none to name, as it was before.
      //
      // D157 — with several of this actor's tokens on that scene, `find` was collection order
      // standing in for an identity nobody chose, and the combatant binds every later card to it
      // (`T327`). The click carries the user's selection, so a controlled token of this actor on the
      // encounter's scene answers first; `canvas.tokens` is only ever the viewed scene, which is
      // what makes the scene test cheap and the fallback still necessary.
      const controlled = canvas.tokens?.controlled
        .find(t => t.document.actorId === this.id && t.document.parent?.id === scene?.id)
        ?.document ?? null;
      const token = this.token ?? controlled
        ?? scene?.tokens.find(t => t.actorId === this.id) ?? null;
      await combat.createEmbeddedDocuments("Combatant", [token
        ? { actorId: this.id, tokenId: token.id, sceneId: token.parent.id }
        : { actorId: this.id }]);
      combatant = combat.combatants.find(c => c.actorId === this.id);
    }

    if (!combatant) {
      ui.notifications.error(localize("NoCombatantForActor"));
      return;
    }

    await persistMod();

    // Roll initiative for the combatant
    return combat.rollInitiative([combatant.id]);
  }

  /**
   * Roll one Stun or Death save and post its card.
   *
   * The roll has to come in at or **under** the threshold, so an implant that helps the save comes
   * off it; the situational modifier keeps its own sign, which is whatever the roller meant.
   *
   * @param {"stun"|"death"} kind
   * @param {object} [options]
   * @param {number} [options.mod] Situational modifier chosen by whoever rolls
   * @param {string} [options.messageMode] Visibility of the card, for a hidden token
   * @param {number} [options.threshold] Save number to use instead of this actor's own
   * @returns {Promise<{total: number, threshold: number, success: boolean}>}
   */
  async rollSave(kind, { mod = 0, messageMode, threshold: override } = {}) {
    const death = kind === "death";
    const threshold = Number.isFinite(override)
      ? override
      : (death ? this.deathThreshold() : this.stunThreshold());

    const fromImplants = Number(this.system?._cwChecks?.saveStun || 0);
    const totalMod = (Number(mod) || 0) - fromImplants;
    const formula = totalMod ? `1d10 + ${totalMod}` : "1d10";

    const rolls = new Multiroll(
      localize(death ? "SaveDeath" : "SaveStun"),
      localize("UnderThresholdMessage"),
      { messageMode }
    );
    const saveRoll = new Roll(formula);
    const thresholdLabel = localize(death ? "SaveDeathThreshold" : "SaveStunThreshold");
    rolls.addRoll(saveRoll, { name: localize("Save") });
    rolls.addRoll(new Roll(`${threshold}`), { name: thresholdLabel });

    // D186 — the card says whether the save was made. Evaluated here rather than left to `execute`
    // because the outcome has to travel *with* the card: the reader was given two numbers, a hint
    // about which direction to read them in, and a status the automation had already applied, and a
    // Stun save reads *under* while a zone save reads *over* (`T360`). Re-evaluation is a no-op.
    await evaluateCyberpunkRoll(saveRoll);
    const total = saveRoll.total;
    const success = total <= threshold;
    await rolls.defaultExecute({ saveOutcome: { success, total, threshold, thresholdLabel } });

    return { total, threshold, success };
  }

  /**
   * The medical skill this actor would stabilize with, or null when they carry neither.
   *
   * Ch. 07:614's "any Medical Skill" is read as Medical Tech when the medic carries the document at
   * all, else First Aid (D53). The *document* decides, not its level: a level 0 still rolls, so the
   * medic gets their TECH and the die.
   *
   * @returns {Item|null}
   * @private
   */
  _getMedicalSkill() {
    for (const id of MEDICAL_TECH_SKILL_IDS) {
      const skill = this._getSkillByStableId(id);
      if (skill) return skill;
    }
    return this._getSkillByStableId(FIRST_AID_SKILL_ID);
  }

  /**
   * Record a charge this actor has set down (D83). The list lives on the actor because that is who
   * can reach it: a player detonates his own charge, and a GM — a nominal owner of every actor —
   * detonates any of them as that actor, which is Foundry's own permission model (D89).
   *
   * @param {object} charge A snapshot of the charge; see `__plantCharge`
   */
  async deployCharge(charge) {
    const charges = [...(this.system.deployedCharges ?? []),
      { ...charge, id: foundry.utils.randomID() }];
    return this.update({ "system.deployedCharges": charges });
  }

  /** @param {string} chargeId */
  async removeDeployedCharge(chargeId) {
    const charges = (this.system.deployedCharges ?? []).filter(charge => charge.id !== chargeId);
    return this.update({ "system.deployedCharges": charges });
  }

  /**
   * Pick a charge back up rather than blowing it (`AL-Q4`): no roll and no check of any kind. The
   * charge it was made from comes back with it when that weapon is still here — taking one back
   * that costs you the charge is a delete, not a take-back — and a charge whose weapon is gone
   * simply leaves the list.
   *
   * @param {string} chargeId
   */
  async takeBackCharge(chargeId) {
    const charge = (this.system.deployedCharges ?? []).find(entry => entry.id === chargeId);
    if (!charge) return null;

    const weapon = this.items.get(charge.itemId);
    if (weapon) {
      const system = weapon._getWeaponSystem();
      const returned = Number(system.shotsLeft ?? 0) + 1;
      // A weapon reloaded between the plant and the take-back is already full, and the charge
      // coming back must not push it past its own magazine (`T281`). A weapon that declares no
      // capacity is not clamped to nothing: 0 is the schema's default and a cyberweapon may
      // legitimately leave it there, so clamping there would swallow the charge instead.
      const capacity = Number(system.shots) || 0;
      await weapon.__setWeaponField("shotsLeft",
        capacity > 0 ? Math.min(returned, capacity) : returned);
    }

    return this.removeDeployedCharge(chargeId);
  }

  /**
   * Ch. 07:614 — TECH + a medical skill + 1d10, at or over the total damage the patient has taken.
   *
   * With neither medical skill the attempt is refused rather than rolled at TECH alone (D54): the
   * one approved hard restriction on this path, reusing the netrunning Interface pattern.
   * Self-treatment is deliberately allowed (D52) even though the book excludes the patient.
   *
   * @param {CyberpunkActor} patient The actor being stabilized
   * @param {object} [options] The stabilization dialog's own fields
   * @param {TokenDocument} [patientToken] The patient's own token, for the card's name (D133)
   * @returns {Promise<{total: number, target: number, success: boolean}|false>} false when refused
   */
  async rollStabilization(patient, options = {}, patientToken = null) {
    if (!patient) {
      ui.notifications.warn(localize("StabilizeNoPatient"));
      return false;
    }

    const skill = this._getMedicalSkill();
    if (!skill) {
      ui.notifications.warn(localize("StabilizeNoMedicalSkill"));
      return false;
    }

    const target = Number(patient.system.damage) || 0;
    const advantages = STABILIZATION_ADVANTAGES
      .reduce((sum, adv) => sum + (options[adv.dataPath] ? adv.bonus : 0), 0);
    const mod = advantages + (Number(options.extraMod) || 0);

    const roll = makeD10Roll([
      "@stats.tech.total",
      CyberpunkActor.realSkillValue(skill) || null,
      mod || null
    ].filter(Boolean), this.system);
    await roll.evaluate();

    const success = roll.total >= target;

    const results = new Multiroll(
      localize("Stabilization"),
      // D133 — a combat card names the token, and the medic's own target is where that token comes
      // from: `patient.token` is set only for an unlinked one (`T306`).
      localizeParam(success ? "StabilizeSuccess" : "StabilizeFailure",
        { patient: displayName(patient, patientToken) })
    );
    results.addRoll(roll, { name: skill.name });
    results.addRoll(new Roll(`${target}`), { name: localize("StabilizeTarget") });
    await results.defaultExecute();

    // D34's split, as the sheet's own Stun/Death button already applies it (`T140`): the roll and
    // its card are what the user asked for and stay in either state, while the flag it sets is a
    // resolution outcome and belongs to the table with the master switch off.
    if (success && isCombatAutomationEnabled()) await CyberpunkActor.setStabilized(patient);

    return { total: roll.total, target, success };
  }

  /**
   * Write `stabilized` onto the patient, through the active GM when this client does not own them.
   *
   * A medic is routinely not the patient's owner — a player treating another player's character owns
   * nothing on it — and a rejected update would have been silent (`T41`'s shape). The hand-off is the
   * one `declareDodge` already uses.
   *
   * @param {CyberpunkActor} patient
   * @returns {Promise<void>}
   */
  static async setStabilized(patient) {
    if (patient.isOwner) {
      await patient.update({ "system.stabilized": true });
      return;
    }

    const gm = game.users.activeGM;
    if (!gm) return;

    try {
      await gm.query("cyberpunk2020.applyStabilized", { actorUuid: patient.uuid },
        { timeout: STABILIZE_QUERY_TIMEOUT_MS });
    } catch (err) {
      // The GM went away mid-roll. The card is posted either way, so the table can tick the box.
    }
  }

  /**
   * Write a stabilization handed over by another client. Runs on the active GM.
   *
   * The sender's own gate is re-applied here rather than trusted: it guards the *state*, not the
   * sender, and a query is reachable from any player's console (`T82`).
   *
   * @param {object} payload
   * @param {string} payload.actorUuid
   * @returns {Promise<boolean>} whether the flag was written
   */
  static async applyStabilized({ actorUuid } = {}) {
    if (!isCombatAutomationEnabled()) return false;

    const actor = await fromUuid(String(actorUuid ?? ""));
    if (actor?.documentName !== "Actor") return false;

    await actor.update({ "system.stabilized": true });
    return true;
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
