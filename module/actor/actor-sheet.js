import { martialOptions, meleeAttackTypes, meleeBonkOptions, rangedModifiers, weaponTypes, FNFF2_ONLY_MARTIAL_ART_IDS, isFnff2Enabled, COMBAT_SENSE_SKILL_IDS } from "../lookups.js"
import { deleteFieldUpdate, localize, localizeParam, cwHasType, cwIsEnabled } from "../utils.js"
import { ModifiersDialog } from "../dialog/modifiers.js"
import { SortOrders, sortSkills } from "./skill-sort.js";
import { getHtmlElement, getRichEditorHTML, itemFromDropData, saveRichEditorHTML } from "../compat.js";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;
const { Tabs } = foundry.applications.ux;

/** @extends {foundry.applications.sheets.ActorSheetV2} */
export class CyberpunkActorSheet extends HandlebarsApplicationMixin(ActorSheetV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["cyberpunk", "sheet", "actor", "flexcol"],
    tag: "form",
    position: {
      width: 590,
      height: 600
    },
    window: {
      resizable: true
    },
    form: {
      submitOnChange: true,
      closeOnSubmit: false
    }
  };

  /** @override */
  static PARTS = {
    form: {
      template: "systems/cyberpunk2020/templates/actor/actor-sheet.hbs"
    }
  };

  /**
   * Kept empty while the actor sheet still uses the legacy monolithic template
   * Tabs are temporarily bound in _cpActivateTabs()
   */
  static TABS = {};

  /** @override */
  async _prepareContext(options) {
    const sheetData = await super._prepareContext(options);

    const actor = this.actor;
    const system = actor.system;

    sheetData.actor = actor;
    sheetData.itemTypes = actor.itemTypes;
    sheetData.system = system;
    sheetData.owner = this.actor.isOwner;
    sheetData.editable = this.isEditable ?? this.options?.editable ?? false;
    sheetData.cssClass = ["cyberpunk", "sheet", "actor"].join(" ");

    if (actor.type === 'character' || actor.type === 'npc') {
      // Sheet-only UI state; do not store search text in actor.system.
      sheetData.skillFilter = this._cpSkillFilter ?? "";

      this._prepareCharacterItems(sheetData);
      this._addWoundTrack(sheetData);
      this._prepareSkills(sheetData);

      sheetData.weaponTypes = weaponTypes;

      const initiativeMod = foundry.utils.getProperty(system, "initiativeMod") || 0;
      sheetData.initiativeMod = initiativeMod;

      const StunDeathMod = foundry.utils.getProperty(system, "StunDeathMod") || 0;
      sheetData.StunDeathMod = StunDeathMod;
    }

    sheetData.cyberwareSegmentsRight = [
      { area: "nervous" },
      { area: "body" },
      { area: "r-arm" },
      { area: "r-leg" }
    ];

    sheetData.cyberwareSegmentsLeft = [
      { area: "head" },
      { area: "l-arm" },
      { area: "l-leg" }
    ];

    const ZONE_I18N = {
      "head": "Head", "body": "Torso", "nervous": "Nervous",
      "l-arm": "lArm", "r-arm": "rArm", "l-leg": "lLeg", "r-leg": "rLeg"
    };
    for (const seg of sheetData.cyberwareSegmentsRight) {
      const k = ZONE_I18N[seg.area] ?? seg.area;
      seg.areaLabel = game.i18n.localize(`CYBERPUNK.${k}`);
    }
    for (const seg of sheetData.cyberwareSegmentsLeft) {
      const k = ZONE_I18N[seg.area] ?? seg.area;
      seg.areaLabel = game.i18n.localize(`CYBERPUNK.${k}`);
    }


    // Collect all programs that belong to this actor.
    const allPrograms = this.actor.items.filter(i => i.type === "program");
    allPrograms.sort((a, b) => a.name.localeCompare(b.name));
    sheetData.netrunPrograms = allPrograms;

    sheetData.programsTotalCost = allPrograms
    .reduce((sum, p) => sum + Number(p.system.cost || 0), 0);

    const activeProgIds = this.actor.system.activePrograms || [];
    const activePrograms = allPrograms.filter(p => activeProgIds.includes(p.id));
    sheetData.netrunActivePrograms = activePrograms;

    const allSkills = this.actor.items.filter(i => i.type === "skill");

    const interfaceName = game.i18n.localize("CYBERPUNK.SkillInterface");
    let interfaceItem = allSkills.find(i => i.name === interfaceName);

    let interfaceValue = 0;
    let interfaceItemId = null;
    if (interfaceItem) {
      interfaceValue = Number(interfaceItem.system?.level || 0);
      interfaceItemId = interfaceItem.id;
    }

    sheetData.interfaceSkill = {
      value: interfaceValue,
      itemId: interfaceItemId
    };

    return sheetData;
  }

  _prepareSkills(sheetData) {
    sheetData.skillsSort = this.actor.system.skillsSortedBy || "Name";
    sheetData.skillsSortChoices = Object.keys(SortOrders);

    sheetData.filteredSkillIDs = this._filterSkills(sheetData);

    sheetData.skillDisplayList = sheetData.filteredSkillIDs
      .map(id => this.actor.items.get(id))
      .filter(Boolean)
      .map(skill => ({
        id: skill.id,
        name: skill.name,
        displayName: this.actor.getSkillDisplayName?.(skill) ?? skill.name,
        system: skill.system
      }));
  }
  _getSortedSkillIDs(sheetData) {
    const system = sheetData?.system ?? this.actor.system;
    const sortOrder = system.skillsSortedBy || "Name";

    let currentSkills =
      this.actor.itemTypes?.skill ?? this.actor.items.filter(i => i.type === "skill");

    if (!isFnff2Enabled()) {
      currentSkills = currentSkills.filter(s => !FNFF2_ONLY_MARTIAL_ART_IDS.has(s._id));
    }

    const currentIds = currentSkills.map(s => s.id);

    const cached = system.sortedSkillIDs;
    const cachedOk = Array.isArray(cached)
      && cached.length === currentIds.length
      && cached.every(id => currentIds.includes(id));

    if (cachedOk) return cached;

    return sortSkills(currentSkills, SortOrders[sortOrder]).map(s => s.id);
  }

  // Handle searching skills. The filter is intentionally sheet-local:
  // it must not be written into actor.system or submitted with the form.
  _filterSkills(sheetData) {
    const upperSearch = String(this._cpSkillFilter ?? "").toUpperCase();
    const listToFilter = this._getSortedSkillIDs(sheetData);

    if (upperSearch === "") return listToFilter;

    return listToFilter.filter(id => {
      const skill = this.actor.items.get(id);
      if (!skill) return false;
      const displayName = this.actor.getSkillDisplayName?.(skill) ?? skill.name;
      return String(skill.name).toUpperCase().includes(upperSearch)
        || String(displayName).toUpperCase().includes(upperSearch);
    });
  }

  _addWoundTrack(sheetData) {
    // Add localized wound states, excluding uninjured. All non-mortal, plus mortal
    const nonMortals = ["Light", "Serious", "Critical"].map(e => game.i18n.localize("CYBERPUNK."+e));
    const mortals = Array(7).fill().map((_,index) => game.i18n.format("CYBERPUNK.Mortal", {mortality: index}));
    sheetData.woundStates = nonMortals.concat(mortals);
  }

  /**
   * Items that aren't actually cyberware or skills - everything that should be shown in the gear tab. 
   */
  _gearTabItems(allItems) {
    // As per https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Collator
    // Compares locale-compatibly, and pretty fast too apparently.
    let hideThese = new Set(["cyberware", "skill", "program"]);
    let nameSorter = new Intl.Collator();
    let showItems = allItems
      .filter((item) => !hideThese.has(item.type))
      .sort((a, b) => nameSorter.compare(a.name, b.name));
    return showItems;
  }

  /**
   * Organize and classify Items for Character sheets.
   *
   * @param {Object} actorData The actor to prepare.
   *
   * @return {undefined}
   */
  _prepareCharacterItems(sheetData) {
    let sortedItems = sheetData.actor.itemTypes;

    sheetData.gearTabItems = this._gearTabItems(sheetData.actor.items);

    sheetData.gear = {
      weapons: sortedItems.weapon,
      armor: sortedItems.armor,
      cyberware: sortedItems.cyberware,
      misc: sortedItems.misc,
      cyberCost: sortedItems.cyberware.reduce((a,b) => a + b.system.cost, 0)
    };

    // Cyberware inventory & zones
    const allCyber = (sortedItems.cyberware || []).slice();

    sheetData.gear.cyberware = allCyber;
    sheetData.gear.cyberwareInventory = allCyber;

    for (const it of allCyber) {
      const t  = it.system?.cyberwareType;
      const st = it.system?.cyberwareSubtype;
      it.system.cwTypeLabel    = t  ? game.i18n.localize(`CYBERPUNK.CWT_ImplantType_${t}`)    : "";
      it.system.cwSubtypeLabel = st ? game.i18n.localize(`CYBERPUNK.CWT_ImplantSubtype_${st}`) : "";
    }

    const isEnabled = (it) => !!it.system?.equipped && cwIsEnabled(it);
    const activeCyber = allCyber.filter(isEnabled);

    const zoneOf = (it) => String(it.system?.MountZone || it.system?.CyberBodyType?.Type || "");
    const sideOf = (it) => String(it.system?.CyberBodyType?.Location || "");

    sheetData.cyberZones = {
      head: activeCyber.filter(it => zoneOf(it) === "Head"),
      body: activeCyber.filter(it => zoneOf(it) === "Torso"),
      nervous: activeCyber.filter(it => zoneOf(it) === "Nervous"),
      "l-arm": activeCyber.filter(it => zoneOf(it) === "Arm" && sideOf(it) === "Left"),
      "r-arm": activeCyber.filter(it => zoneOf(it) === "Arm" && sideOf(it) === "Right"),
      "l-leg": activeCyber.filter(it => zoneOf(it) === "Leg" && sideOf(it) === "Left"),
      "r-leg": activeCyber.filter(it => zoneOf(it) === "Leg" && sideOf(it) === "Right"),
    };
    const isChip = (it) => {
      const cwt = it.system?.CyberWorkType ?? {};
      return Array.isArray(cwt?.Types) ? cwt.Types.includes("Chip") : cwt?.Type === "Chip";
    };

    sheetData.chipsActive = allCyber.filter(it =>
      isChip(it) &&
      cwIsEnabled(it) &&
      it.system?.CyberWorkType?.ChipActive === true
    );

    sheetData.gear.cyberwareActive = activeCyber;
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);

    const root = getHtmlElement(this.element);
    if (!root) return;

    this._cpActivateTabs(root);
    this._cpActivateBasicActorActions(root);
    this._cpActivateActorFormControls(root);
    this._cpActivateCyberwareControls(root);

    const html = globalThis.jQuery ? globalThis.jQuery(root) : $(root);
    this._activateListeners(root, html);
  }

    _cpActivateTabs(root) {
    const nav = root.querySelector(".sheet-tabs");
    const body = root.querySelector(".sheet-body");
    if (!nav || !body) return;

    const activeTab =
      this._cpActiveTab
      ?? nav.querySelector("[data-tab].active")?.dataset.tab
      ?? body.querySelector(".tab.active")?.dataset.tab
      ?? "skills";

    const tabs = new Tabs({
      navSelector: ".sheet-tabs",
      contentSelector: ".sheet-body",
      initial: activeTab
    });

    tabs.bind(root);
    tabs.activate(activeTab, false);

    nav.addEventListener("click", (event) => {
      const target = event.target?.closest?.("[data-tab]");
      if (!target) return;
      this._cpActiveTab = target.dataset.tab || "skills";
    });

    this._cpTabs = tabs;
  }

    _cpActivateBasicActorActions(root) {
    if (!root?.addEventListener) return;
    if (root.dataset.cpBasicActorActionsBound === "1") return;

    root.dataset.cpBasicActorActionsBound = "1";

    const isEditable = this.isEditable ?? this.options?.editable ?? false;
    if (!isEditable) return;

    root.addEventListener("click", async (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const deleteButton = target.closest(".item-delete");
      if (deleteButton) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        const item = this._cpGetItemFromTarget(deleteButton);
        if (item) await this._cpConfirmDeleteItem(item);
        return;
      }

      const statRoll = target.closest(".stat-roll");
      if (statRoll) {
        event.preventDefault();
        event.stopPropagation();

        const statName = statRoll.dataset.statName;
        if (statName) this.actor.rollStat(statName);
        return;
      }

      const itemEdit = target.closest(".item-edit");
      if (itemEdit) {
        if (target.closest(".fire-weapon, .item-roll, .item-delete, .item-unequip")) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        const item = this._cpGetItemFromTarget(itemEdit);
        if (item) item.sheet.render(true);
        return;
      }

      const skillRoll = target.closest(".skill-roll");
      if (skillRoll) {
        event.preventDefault();
        event.stopPropagation();

        await this._cpRollSkillFromElement(skillRoll);
        return;
      }

      const initiativeRoll = target.closest(".roll-initiative");
      if (initiativeRoll) {
        event.preventDefault();
        event.stopPropagation();

        const input = root.querySelector(".roll-initiative-modificator");
        this.actor.addToCombatAndRollInitiative(input?.value ?? 0);
        return;
      }

      const stunDeathSave = target.closest(".stun-death-save");
      if (stunDeathSave) {
        event.preventDefault();
        event.stopPropagation();

        const input = root.querySelector(".roll-stun-death-modificator");
        this.actor.rollStunDeath(input?.value ?? 0);
        return;
      }

      const damageBox = target.closest(".damage");
      if (damageBox) {
        event.preventDefault();
        event.stopPropagation();

        const damage = Number(damageBox.dataset.damage);
        if (Number.isFinite(damage)) {
          await this.actor.update({ "system.damage": damage });
        }
        return;
      }

      const itemRoll = target.closest(".item-roll");
      if (itemRoll) {
        event.preventDefault();
        event.stopPropagation();

        const item = this._cpGetItemFromTarget(itemRoll);
        if (item) await item.roll();
        return;
      }

      const chip = target.closest(".chipware-container .chipware[data-item-id]");
      if (chip) {
        if (target.closest(".item-unequip, .item-delete")) return;

        event.preventDefault();
        event.stopPropagation();

        const item = this._cpGetItemFromTarget(chip);
        if (item) item.sheet.render(true);
        return;
      }
    });

    root.addEventListener("contextmenu", async (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const rowDelete = target.closest(".rc-item-delete");
      if (!rowDelete) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      const item = this._cpGetItemFromTarget(rowDelete);
      if (item) await this._cpConfirmDeleteItem(item);
    });
  }

  _cpGetItemFromTarget(target) {
    const itemId = target?.dataset?.itemId
      ?? target?.dataset?.skillId
      ?? target?.closest?.("[data-item-id]")?.dataset?.itemId
      ?? target?.closest?.("[data-skill-id]")?.dataset?.skillId;

    if (!itemId) return null;
    return this.actor.items.get(itemId) ?? null;
  }

  async _cpConfirmDeleteItem(item) {
    if (!item) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: {
        title: localize("ItemDeleteConfirmTitle")
      },
      content: `<p>${localizeParam("ItemDeleteConfirmText", { itemName: item.name })}</p>`,
      modal: true,
      rejectClose: false
    });

    if (confirmed) await item.delete();
  }

  async _cpRollSkillFromElement(element) {
    const id = element?.dataset?.skillId;
    if (!id) return;

    const skill = this.actor.items.get(id);
    if (!skill) return;

    if (skill.system?.askMods) {
      const dlg = new ModifiersDialog(this.actor, {
        title: localize("ModifiersSkillTitle"),
        showAdvDis: true,
        modifierGroups: [[
          { localKey: "ExtraModifiers", dataPath: "extraMod", defaultValue: 0 }
        ]],
        onConfirm: ({ extraMod = 0, advantage = false, disadvantage = false, hiddenAdvantage = false }) =>
          this.actor.rollSkill(
            id,
            Number(extraMod) || 0,
            !!advantage,
            !!disadvantage,
            !!hiddenAdvantage
          )
      });

      return dlg.render(true);
    }

    return this.actor.rollSkill(id);
  }

    _cpActivateActorFormControls(root) {
    if (!root?.addEventListener) return;
    if (root.dataset.cpActorFormControlsBound === "1") return;

    root.dataset.cpActorFormControlsBound = "1";

    const isEditable = this.isEditable ?? this.options?.editable ?? false;
    if (!isEditable) return;

    const skillSearch = root.querySelector("input.skill-search");
    const skillClear = root.querySelector(".skill-search-clear");

    const toggleSkillClear = () => {
      if (!skillClear || !skillSearch) return;
      skillClear.classList.toggle("is-visible", !!skillSearch.value);
    };

    if (skillSearch && this._cpSkillFilter != null) {
      skillSearch.value = this._cpSkillFilter;
    }

    if (this._restoreSkillCaret != null && skillSearch) {
      skillSearch.focus();
      const pos = Math.min(this._restoreSkillCaret, skillSearch.value.length);
      try {
        skillSearch.setSelectionRange(pos, pos);
      } catch (_) {}
      this._restoreSkillCaret = null;
    }

    toggleSkillClear();
    this._cpApplySkillFilterToDOM(root, this._cpSkillFilter ?? "");

    root.addEventListener("click", async (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const skillLevel = target.closest(".skill-level");
      if (skillLevel) {
        skillLevel.select?.();
        return;
      }

      const askMods = target.closest(".skill-ask-mod");
      if (askMods) {
        event.stopPropagation();
        return;
      }

      const clearSkillSearch = target.closest('[data-action="clear-skill-search"]');
      if (clearSkillSearch) {
        event.preventDefault();
        event.stopPropagation();

        const input = root.querySelector("input.skill-search");
        if (input) {
          input.value = "";
          input.focus({ preventScroll: true });
        }

        this._restoreSkillCaret = null;
        this._cpSkillFilter = "";
        toggleSkillClear();
        this._cpApplySkillFilterToDOM(root, "");
      }
    });

    root.addEventListener("pointerdown", (event) => {
      const target = event.target;
      if (!target?.closest?.('[data-action="clear-skill-search"]')) return;

      event.preventDefault();
      event.stopPropagation();
    });

    root.addEventListener("mousedown", (event) => {
      const target = event.target;
      if (!target?.closest?.('[data-action="clear-skill-search"]')) return;

      event.preventDefault();
      event.stopPropagation();
    });

    root.addEventListener("keydown", (event) => {
      const target = event.target;
      if (!target?.matches?.(".skill-level")) return;

      if (event.key === "Enter") {
        event.preventDefault();
        target.blur();
      }
    });

    root.addEventListener("input", (event) => {
      const target = event.target;
      if (!target?.matches?.("input.skill-search")) return;

      const value = target.value || "";

      if (skillClear) skillClear.classList.toggle("is-visible", !!value);

      this._restoreSkillCaret = target.selectionStart ?? value.length;
      this._cpSkillFilter = value;
      this._cpApplySkillFilterToDOM(root, value);
    });

    root.addEventListener("change", async (event) => {
      const target = event.target;
      if (!target?.matches) return;

      if (target.matches('input[name^="system.sdp.current."]')) {
        const path = target.getAttribute("name");
        const zone = path?.split(".").pop();
        if (!zone) return;

        await this.actor.update({
          [`system.sdp.current.${zone}`]: Number(target.value || 0)
        });
        return;
      }

      if (target.matches(".skill-level")) {
        await this._cpSaveSkillLevelFromInput(target);
        return;
      }

      if (target.matches(".skill-sort > select, .skill-sort select")) {
        await this.actor.sortSkills(target.value);
        return;
      }

      if (target.matches(".skill-ask-mod")) {
        await this._cpUpdateAskModsFromInput(target);
        return;
      }

      if (target.matches(".roll-initiative-modificator")) {
        await this.actor.update({ "system.initiativeMod": Number(target.value) });
        return;
      }

      if (target.matches(".roll-stun-death-modificator")) {
        await this.actor.update({ "system.StunDeathMod": Number(target.value) });
      }
    });
  }

  async _cpUpdateAskModsFromInput(input) {
    const skillId = input.dataset.skillId;
    const skill = this.actor.items.get(skillId);
    if (!skill) return ui.notifications.warn(localize("SkillNotFound"));

    try {
      await skill.update({ "system.askMods": !!input.checked });
    } catch (err) {
      console.error(err);
      ui.notifications.error(localize("UpdateAskModsError"));
      input.checked = !input.checked;
    }
  }
  _cpApplySkillFilterToDOM(root, filter) {
    const normalized = String(filter ?? "").trim().toUpperCase();
    const rows = root.querySelectorAll(".field.skill[data-item-id]");

    for (const row of rows) {
      const skillId = row.dataset.itemId;
      const skill = this.actor.items.get(skillId);

      const displayName = skill
        ? (this.actor.getSkillDisplayName?.(skill) ?? skill.name)
        : "";

      const haystack = `${skill?.name ?? ""} ${displayName}`.toUpperCase();
      const visible = !normalized || haystack.includes(normalized);

      row.style.display = visible ? "" : "none";
    }
  }

    _cpActivateCyberwareControls(root) {
    if (!root?.addEventListener) return;

    this._cpActivateChipTooltips(root);

    if (root.dataset.cpCyberwareControlsBound === "1") return;
    root.dataset.cpCyberwareControlsBound = "1";

    const isEditable = this.isEditable ?? this.options?.editable ?? false;
    if (!isEditable) return;

    root.addEventListener("mousedown", (event) => {
      const target = event.target;
      if (!target?.closest?.(".item-unequip")) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    });

    root.addEventListener("click", async (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const unequipButton = target.closest(".item-unequip");
      if (unequipButton) {
        await this._onActiveUnequip(event);
        return;
      }
    });

    root.addEventListener("change", async (event) => {
      const target = event.target;
      if (!target?.matches?.(".chip-toggle input[data-skill-id]")) return;

      event.preventDefault();
      event.stopPropagation();

      await this._cpSetSkillChipActiveFromInput(target);
    });
  }

  async _cpSetSkillChipActiveFromInput(input) {
    const checked = !!input.checked;
    const skillId = input.dataset.skillId;
    const skill = this.actor.items.get(skillId);

    if (!skill || skill.type !== "skill") return;

    const chips = this._cpFindChipItemsForSkill(skill);

    if (chips.length) {
      const updates = chips.map(chip => ({
        _id: chip.id,
        "system.CyberWorkType.ChipActive": checked
      }));

      await this.actor.updateEmbeddedDocuments("Item", updates, { render: false });

      await this._cp_syncChipLevelsToSkills();
      await this._cp_syncActiveFlagsToSkills();
    } else {
      await skill.update({
        "system.isChipped": checked,
        ...deleteFieldUpdate("system.chipped")
      }, { render: false });
    }

    if (this.rendered) await this.render({ force: true });

    for (const chip of chips) {
      if (chip.sheet?.rendered) chip.sheet.render(true);
    }

    if (skill.sheet?.rendered) skill.sheet.render(true);
  }

  _cpFindChipItemsForSkill(skill) {
    const skillId = skill.id ?? skill._id;
    const legacySkillName = skill.name;

    return this.actor.items.filter(item => {
      if (item.type !== "cyberware") return false;
      if (!cwHasType(item, "Chip")) return false;
      if (item.system?.equipped === false) return false;

      const map = item.system?.CyberWorkType?.ChipSkills;
      if (!map) return false;

      if (skillId && Object.prototype.hasOwnProperty.call(map, skillId)) return true;

      // Legacy fallback for old chip data that was stored by localized skill name.
      return Object.prototype.hasOwnProperty.call(map, legacySkillName);
    });
  }

  _cpActivateChipTooltips(root) {
      // Chipware tooltips are handled by _cpActivateCyberwareControls
  }

  async _cpSaveSkillLevelFromInput(input) {
    const skill = this.actor.items.get(input.dataset.skillId);
    if (!skill) return;

    const isChipped = !!skill.system.isChipped;
    const value = Number.parseInt(input.value, 10);
    const safeValue = Number.isFinite(value) ? value : 0;

    const targetKey = isChipped ? "system.chipLevel" : "system.level";
    await skill.update({ [targetKey]: safeValue }, { render: false });

    if (isChipped) {
      const skillId = skill.id;
      const skillName = skill.name;

      const chips = this.actor.items.filter((item) => {
        if (item.type !== "cyberware") return false;
        if (!cwHasType(item, "Chip")) return false;
        if (item.system?.equipped === false) return false;

        const map = item.system?.CyberWorkType?.ChipSkills;
        if (!map) return false;

        if (skillId && Object.prototype.hasOwnProperty.call(map, skillId)) return true;
        return Object.prototype.hasOwnProperty.call(map, skillName);
      });

      if (chips.length) {
        const updates = [];

        for (const chip of chips) {
          const map = chip.system?.CyberWorkType?.ChipSkills || {};
          const key =
            skillId && Object.prototype.hasOwnProperty.call(map, skillId)
              ? skillId
              : skillName;

          updates.push({
            _id: chip.id,
            [`system.CyberWorkType.ChipSkills.${key}`]: safeValue
          });
        }

        await this.actor.updateEmbeddedDocuments("Item", updates, { render: false });

        for (const chip of chips) {
          if (chip.sheet?.rendered) chip.sheet.render(true);
        }
      }
    }

    const combatSenseSkill = this.actor.items.find(item =>
      item.type === "skill"
      && COMBAT_SENSE_SKILL_IDS.has(item.id ?? item._id)
    );

    await this.actor.update(
      { "system.CombatSenseMod": Number(combatSenseSkill?.system?.level ?? 0) },
      { render: false }
    );

    await this.render({ force: true });

    if (skill.sheet?.rendered) skill.sheet.render(true);
  }

  _activateListeners(rootElement, html) {
    const root = getHtmlElement(rootElement) ?? getHtmlElement(html);
    if (!root) return;

    if (this._cpAvatarCaptureRoot && this._cpAvatarCapture) {
      try {
        this._cpAvatarCaptureRoot.removeEventListener("click", this._cpAvatarCapture, { capture: true });
      } catch (_) {}
    }

    const cpAvatarCapture = (ev) => {
      const editable = ev.target?.closest?.("[data-edit]");
      if (!editable) return;
      if ((editable.dataset?.edit || "") !== "img") return;

      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation?.();

      const fp = new FilePicker({
        type: "image",
        activeSource: "data",
        current: this.actor.img || "",
        callback: (path) => this.actor.update({ img: path }),
        top: (this.position?.top ?? 0) + 40,
        left: (this.position?.left ?? 0) + 10
      });

      fp.render(true);
    };

    root.addEventListener("click", cpAvatarCapture, { capture: true });
    this._cpAvatarCapture = cpAvatarCapture;
    this._cpAvatarCaptureRoot = root;

    // Life tab (system.notes) autosave
    this._cpSetupNotesAutosave(root);
    html.find('[data-drop-target]').on('dragover', (ev) => ev.preventDefault());

    /**
     * Get an owned item from a click event, for any event trigger with a data-item-id property
     * @param {*} ev 
    */
    function getEventItem(sheet, ev) {
      let itemId = ev.currentTarget.dataset.itemId;
      return sheet.actor.items.get(itemId);
    }

    // If not editable, do nothing further
    if (!(this.isEditable ?? this.options?.editable ?? false)) return;

    // SDP manual edit is handled by _cpActivateActorFormControls

    // Stat roll is handled by _cpActivateBasicActorActions

    // Skill level changes are handled by _cpActivateActorFormControls

    // Skill sorting is handled by _cpActivateActorFormControls

    // Skill search is handled by _cpActivateActorFormControls

    // Ask-modifiers checkbox is handled by _cpActivateActorFormControls

    // Skill roll is handled by _cpActivateBasicActorActions

    // Initiative roll is handled by _cpActivateBasicActorActions

    // Initiative modifier changes are handled by _cpActivateActorFormControls

    // Stun/Death modifier changes are handled by _cpActivateActorFormControls

    // Stun/Death roll is handled by _cpActivateBasicActorActions

    // Damage tracker clicks are handled by _cpActivateBasicActorActions

    // Generic item roll is handled by _cpActivateBasicActorActions

    // Item sheet opening is handled by _cpActivateBasicActorActions

    // Active chip sheet opening is handled by _cpActivateBasicActorActions

    // Item deletion is handled by _cpActivateBasicActorActions

    // "Fire" button for weapons
    html.find('.fire-weapon').click(ev => {
      ev.stopPropagation();

      const item = getEventItem(this, ev);
      const isRanged = item.isRanged();
      const system = item._getWeaponSystem?.() ?? item.system ?? {};
      const savedAttackOptions = isRanged
        ? this._cpGetSavedRangedAttackOptions(item)
        : this._cpGetSavedMeleeAttackOptions(item);

      let modifierGroups = undefined;
      const targetTokens = Array.from(game.users.current.targets.values()).map(target => {
        return {
          name: target.document.name,
          id: target.id
        };
      });

      if (isRanged) {
        modifierGroups = rangedModifiers(item, targetTokens, savedAttackOptions);
      }
      else if (system.attackType === meleeAttackTypes.martial) {
        modifierGroups = martialOptions(this.actor, savedAttackOptions);
      }
      else {
        modifierGroups = meleeBonkOptions(savedAttackOptions);
      }

      const dialog = new ModifiersDialog(this.actor, {
        weapon: item,
        targetTokens: targetTokens,
        modifierGroups: modifierGroups,
        onConfirm: async (fireOptions) => {
          if (isRanged) {
            await this._cpSaveRangedAttackOptions(item, fireOptions);
          } else {
            await this._cpSaveMeleeAttackOptions(item, fireOptions);
          }

          return item.__weaponRoll(fireOptions, targetTokens);
        }
      });

      dialog.render(true);
    });

    function getNetrunProgramItem(sheet, ev) {
      ev.stopPropagation();
      const itemId = ev.currentTarget.closest(".netrun-program").dataset.itemId;
      return sheet.actor.items.get(itemId);
    }
    html.find('.netrun-program .fa-edit').click(ev => {
      const item = getNetrunProgramItem(this, ev);
      if (!item) return;
      item.sheet.render(true);
    });
    html.find('.netrun-program .fa-trash').click(ev => {
      const item = getNetrunProgramItem(this, ev);
      if (!item) return;
      let confirmDialog = new Dialog({
        title: localize("ItemDeleteConfirmTitle"),
        content: `<p>${localizeParam("ItemDeleteConfirmText", {itemName: item.name})}</p>`,
        buttons: {
          yes: {
            label: localize("Yes"),
            callback: () => item.delete()
          },
          no: { label: localize("No") },
        },
        default:"no"
      });
      confirmDialog.render(true);
    });

    html.find('.netrun-program').each((_, programElem) => {
      programElem.setAttribute("draggable", true);

      programElem.addEventListener("dragstart", ev => {
        const itemId = programElem.dataset.itemId;
        const item = this.actor.items.get(itemId);
        if ( !item ) return;

        this._cpWriteOwnedItemDragData(ev, item);

        programElem.classList.add("is-dragging");
      });

      programElem.addEventListener("dragend", ev => {
        programElem.classList.remove("is-dragging");
      });
    });

    html.find('input[data-edit], select[data-edit], textarea[data-edit]').on('change', ev => {
      ev.preventDefault();
      const input = ev.currentTarget;
      const path = input.dataset.edit;
      const dtype = input.dataset.dtype;
      let value = input.value;

      if (dtype === "Number") {
        value = Number(value || 0);
        if (input.type === "checkbox") value = input.checked ? 1 : 0;
      }
      else if (dtype === "Boolean") {
        value = input.checked;
      }

      this.actor.update({ [path]: value });
    });

    const interfaceSkillElems = html.find('.interface-skill-roll');

    interfaceSkillElems.on('click', ev => {
      ev.preventDefault();
      const skillId = ev.currentTarget.dataset.skillId;
      if (!skillId) {
        ui.notifications.warn(localize("InterfaceSkillNotFound"));
        return;
      }
      this.actor.rollSkill(skillId);
    });

    html.find('.netrun-active-icon').on('contextmenu', async ev => {
      ev.preventDefault();
      const div = ev.currentTarget;
      const itemId = div.dataset.itemId;
      if (!itemId) return;
      const currentActive = [...(this.actor.system.activePrograms || [])];
      const idx = currentActive.indexOf(itemId);
      if (idx < 0) return;

      currentActive.splice(idx, 1);

      let sumMU = 0;
      for (let progId of currentActive) {
        let progItem = this.actor.items.get(progId);
        if (!progItem) continue;
        sumMU += Number(progItem.system.mu) || 0;
      }

      await this.actor.update({
        "system.activePrograms": currentActive,
        "system.ramUsed": sumMU
      });

      ui.notifications.info(localize("ProgramDeactivated"));
    });

    html.find('.filepicker').on('click', async (ev) => {
      ev.preventDefault();
      const currentPath = this.actor.system.icon || "";
      
      const fp = new FilePicker({
        type: "image",
        current: currentPath,
        callback: (path) => {
          this.actor.update({"system.icon": path});
          html.find(".netrun-icon-frame img").attr("src", path);
          html.find('input[name="system.icon"]').val(path);
        },
        top: this.position.top + 40,
        left: this.position.left + 10
      });

      fp.render(true);
    });

    if (this._cpChipTooltipCleanup) {
      try { this._cpChipTooltipCleanup(); } catch (_) {}
      this._cpChipTooltipCleanup = null;
    }

    const tooltip = document.createElement("div");
    tooltip.className = "chip-tooltip";
    document.body.appendChild(tooltip);

    const documentTooltipListeners = [];

    function hideTooltip() {
      tooltip.style.display = "none";
    }

    function showTooltip(chip) {
      const fullName = chip.dataset.full;
      if (!fullName) return;

      tooltip.textContent = fullName;
      tooltip.style.display = "block";

      const rect = chip.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();

      tooltip.style.top = `${rect.top - tooltipRect.height - 6}px`;
      tooltip.style.left = `${rect.left + rect.width / 2}px`;
      tooltip.style.transform = "translateX(-50%)";
    }

    function attachChipwareTooltips(root) {
      root.querySelectorAll(".chipware").forEach(chip => {
        chip.addEventListener("mouseenter", () => showTooltip(chip));
        chip.addEventListener("mouseleave", hideTooltip);
      });
    }

    attachChipwareTooltips(getHtmlElement(html) ?? document);
    ["drop", "dragend", "click", "mousedown", "mouseup"].forEach(eventName => {
      document.addEventListener(eventName, hideTooltip);
      documentTooltipListeners.push(eventName);
    });

    this._cpChipTooltipCleanup = () => {
      hideTooltip();
      tooltip.remove();
      for (const eventName of documentTooltipListeners) {
        document.removeEventListener(eventName, hideTooltip);
      }
    };
    
    // Chip toggle is handled by _cpActivateCyberwareControls


    // Drag sources for owned Actor Items.
    const makeDraggable = (root) => {
      const el = getHtmlElement(root);
      if (!el?.querySelectorAll) return;

      const selector = [
        '.field[data-item-id]',
        '.item[data-item-id]',
        '.skill[data-item-id]',
        '.gear[data-item-id]',
        '.fire-weapon[data-item-id]',
        '.netrun-program[data-item-id]',
        '.chipware[data-item-id]'
      ].join(',');

      el.querySelectorAll(selector).forEach((node) => {
        if (node.dataset.draggableInit === '1') return;
        if (node.closest?.('.item-delete, .item-unequip, .item-controls')) return;

        node.dataset.draggableInit = '1';
        node.setAttribute('draggable', 'true');
        node.addEventListener('dragstart', (ev) => {
          const id = node.dataset.itemId;
          const it = this.actor.items.get(id);
          if (!it) return;
          this._cpWriteOwnedItemDragData(ev, it);
        });
      });
    };

    // Active cyberware/chipware unequip is handled by _cpActivateCyberwareControls

    makeDraggable(getHtmlElement(html) ?? html);
  }

  /**
   * Build drag payload for an Item already owned by this Actor.
   * @param {Item} item
   * @returns {object}
   * @private
   */
  _cpOwnedItemDragData(item) {
    const dragData = (typeof item?.toDragData === "function")
      ? item.toDragData()
      : { type: "Item", uuid: item?.uuid };

    dragData.type = dragData.type || "Item";
    dragData.uuid = dragData.uuid || item?.uuid;
    dragData.actorId = this.actor.id;
    dragData.actorUuid = this.actor.uuid;
    dragData.itemId = item.id;

    return dragData;
  }

  /**
   * @param {DragEvent} event
   * @param {Item} item
   * @private
   */
  _cpWriteOwnedItemDragData(event, item) {
    const dragData = this._cpOwnedItemDragData(item);
    event.dataTransfer?.setData("text/plain", JSON.stringify(dragData));
  }

  /**
   * Extract possible Item ids from Foundry drag data.
   * @param {object} data
   * @returns {string[]}
   * @private
   */
  _cpDropItemIdCandidates(data) {
    const ids = [];
    const add = (value) => {
      if (value == null || value === "") return;
      const id = String(value);
      if (!ids.includes(id)) ids.push(id);
    };

    add(data?.itemId);
    add(data?.data?._id);
    add(data?._id);

    const uuid = String(data?.uuid ?? data?.documentUuid ?? data?.itemUuid ?? "");
    const marker = ".Item.";
    const idx = uuid.indexOf(marker);
    if (idx >= 0) add(uuid.slice(idx + marker.length).split(".")[0]);

    return ids;
  }

  /**
   * Does the drop payload represent an Item already owned by this Actor?
   * @param {object} data
   * @returns {boolean}
   * @private
   */
  _cpIsSameActorItemDrop(data) {
    if (!data || data.type !== "Item") return false;

    if (data.actorId && String(data.actorId) === String(this.actor.id)) return true;
    if (data.actorUuid && String(data.actorUuid) === String(this.actor.uuid)) return true;

    const uuid = String(data.uuid ?? data.documentUuid ?? data.itemUuid ?? "");
    if (!uuid) return false;

    if (uuid.startsWith(`${this.actor.uuid}.Item.`)) return true;
    if (uuid.includes(`Actor.${this.actor.id}.Item.`)) return true;

    return false;
  }

  /**
   * Resolve a same-actor drop to the existing owned Item.
   * @param {object} data
   * @returns {Item|null}
   * @private
   */
  _cpGetOwnedDropItem(data) {
    for (const id of this._cpDropItemIdCandidates(data)) {
      const item = this.actor.items.get(id);
      if (item) return item;
    }
    return null;
  }

  /**
   * Normalize an Item document or plain Item source object to source data.
   * @param {Item|object} itemOrData
   * @returns {object}
   * @private
   */
  _cpToItemSource(itemOrData) {
    if (typeof itemOrData?.toObject === "function") return itemOrData.toObject();
    return foundry.utils.deepClone(itemOrData ?? {});
  }

  /**
   * Resolve dropped Item data.
   *
   * @param {object} data
   * @returns {Promise<{item: Item|null, itemData: object, sameActor: boolean}>}
   * @private
   */
  async _cpResolveDroppedItem(data) {
    const sameActor = this._cpIsSameActorItemDrop(data);
    const owned = sameActor ? this._cpGetOwnedDropItem(data) : null;
    if (owned) return { item: owned, itemData: owned.toObject(), sameActor: true };

    const resolved = await itemFromDropData(data);
    const resolvedSameActor = !!(resolved?.parent && resolved.parent === this.actor);
    const item = resolvedSameActor ? resolved : null;
    const itemData = this._cpToItemSource(resolved);

    return { item, itemData, sameActor: sameActor || resolvedSameActor };
  }

  /**
   * Return an owned Item for a drop target, creating one only for external drops.
   *
   * @param {object} data
   * @param {{item: Item|null, itemData: object, sameActor: boolean}|null} resolved
   * @returns {Promise<{item: Item|null, itemData: object, sameActor: boolean}>}
   * @private
   */
  async _cpEnsureDroppedItemOwned(data, resolved = null) {
    const drop = resolved ?? await this._cpResolveDroppedItem(data);
    if (drop.item) return drop;

    const existing = drop.itemData?._id ? this.actor.items.get(drop.itemData._id) : null;
    if (existing) {
      return { item: existing, itemData: existing.toObject(), sameActor: drop.sameActor };
    }

    const created = await this.actor.createEmbeddedDocuments("Item", [drop.itemData]);
    const item = created[0] ?? null;
    return { item, itemData: item?.toObject() ?? drop.itemData, sameActor: false };
  }

  async _onActiveUnequip(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    const target = event.target?.closest?.(".item-unequip") ?? event.currentTarget;
    const id = target?.dataset?.itemId
      || target?.closest?.("[data-item-id]")?.dataset?.itemId;

    if (!id) return;

    const item = this.actor.items.get(id);
    if (!item) return;

    const updates = {
      "system.equipped": false,
      "system.CyberWorkType.ChipActive": false
    };

    await item.update(updates, { render: false });
    await this._cp_syncChipLevelsToSkills();
    await this._cp_syncActiveFlagsToSkills();

    if (item.sheet?.rendered) item.sheet.render(true);
    await this.render({ force: true });
  }

  /** @override */
  async _onDropItem(event, data) {
    event.preventDefault();

    const dropTarget = event.target.closest("[data-drop-target]");
    const sameActorDrop = this._cpIsSameActorItemDrop(data);

    if (!dropTarget) {
      if (sameActorDrop) return false;
      return super._onDropItem(event, data);
    }

    const target = dropTarget.dataset.dropTarget;
    const warn = (msg) => ui.notifications?.warn(msg);

    if (target === "program-list") {
      const resolved = await this._cpResolveDroppedItem(data);
      const { itemData, sameActor } = resolved;

      if (itemData.type !== "program") {
        return ui.notifications.warn(localize("NotAProgram", { name: itemData.name }));
      }

      if (sameActor) {
        const existing = resolved.item ?? this._cpGetOwnedDropItem(data) ?? this.actor.items.get(itemData._id);
        if (existing) ui.notifications.warn(localize("ProgramAlreadyExists", { name: existing.name }));
        return false;
      }

      return this.actor.createEmbeddedDocuments("Item", [itemData]);
    }

    if (target === "active-programs") {
      const resolved = await this._cpResolveDroppedItem(data);
      const { itemData } = resolved;

      if (itemData.type !== "program") {
        return ui.notifications.warn(localize("OnlyProgramsCanBeActivated", { name: itemData.name }));
      }

      const { item } = await this._cpEnsureDroppedItemOwned(data, resolved);
      if (!item) return;

      const currentActive = [...(this.actor.system.activePrograms || [])];
      const newMu = Number(item.system.mu) || 0;

      const usedMu = currentActive.reduce((sum, id) => {
        const p = this.actor.items.get(id);
        return sum + (Number(p?.system.mu) || 0);
      }, 0);

      const ramMax = Number(this.actor.system.ramMax) || 0;
      if (ramMax && (usedMu + newMu) > ramMax) {
        return ui.notifications.warn(
          localize("NotEnoughRAM", { name: item.name, used: usedMu, max: ramMax })
        );
      }

      if (!currentActive.includes(item.id)) {
        currentActive.push(item.id);

        await this.actor.update({
          "system.activePrograms": currentActive,
          "system.ramUsed": usedMu + newMu
        });

        this.render(true);
      }

      return;
    }

    if (target === "active-chips") {
      const resolved = await this._cpResolveDroppedItem(data);
      const { itemData } = resolved;

      if (itemData.type !== "cyberware") return warn(localize("ChipwareOnlyHere"));

      const cwt = itemData.system?.CyberWorkType ?? {};
      const types = Array.isArray(cwt.Types) ? cwt.Types : (cwt.Type ? [cwt.Type] : []);
      if (!types.includes("Chip")) return warn(localize("OnlyChipsHere"));

      const { item } = await this._cpEnsureDroppedItemOwned(data, resolved);
      if (!item) return;

      await item.update({
        "system.equipped": true,
        "system.CyberWorkType.ChipActive": true
      }, { render: false });

      await this._cp_syncChipLevelsToSkills();
      await this._cp_syncActiveFlagsToSkills();

      if (item.sheet?.rendered) item.sheet.render(true);
      this.render(true);
      return;
    }

    if (target === "cyber-inventory") {
      const resolved = await this._cpResolveDroppedItem(data);
      const { itemData, sameActor } = resolved;

      if (itemData.type !== "cyberware") return warn(localize("OnlyCyberwareHere"));

      const { item } = await this._cpEnsureDroppedItemOwned(data, resolved);
      if (!item) return;

      if (sameActor) {
        await item.update({
          "system.equipped": false,
          "system.CyberBodyType.Location": "",
          "system.CyberWorkType.ChipActive": false
        }, { render: false });
      }

      await this._cp_syncChipLevelsToSkills();
      await this._cp_syncActiveFlagsToSkills();

      if (item.sheet?.rendered) item.sheet.render(true);
      this.render(true);
      return;
    }

    if (target?.startsWith("zone:")) {
      const zoneKey = target.split(":")[1];
      const resolved = await this._cpResolveDroppedItem(data);
      const { itemData } = resolved;

      if (itemData.type !== "cyberware") return warn(localize("OnlyCyberwareHere"));

      const cwt = itemData.system?.CyberWorkType ?? {};
      const types = Array.isArray(cwt.Types) ? cwt.Types : (cwt.Type ? [cwt.Type] : []);
      const { item } = await this._cpEnsureDroppedItemOwned(data, resolved);
      if (!item) return;

      if (types.includes("Chip")) {
        await item.update({
          "system.equipped": true,
          "system.CyberWorkType.ChipActive": true,
          "system.CyberBodyType.Location": ""
        }, { render: false });

        await this._cp_syncChipLevelsToSkills();
        await this._cp_syncActiveFlagsToSkills();

        if (item.sheet?.rendered) item.sheet.render(true);
        this.render(true);
        return;
      }

      const mount = String(itemData.system?.MountZone || itemData.system?.CyberBodyType?.Type || "");
      const updates = { "system.equipped": true };

      const sideFromDrop = (key) => ({
        "l-arm": "Left", "r-arm": "Right",
        "l-leg": "Left", "r-leg": "Right"
      })[key];

      if (mount === "Arm" || mount === "Leg") {
        const dropSide = sideFromDrop(zoneKey);
        updates["system.CyberBodyType.Location"] =
          dropSide || (itemData.system?.CyberBodyType?.Location || "Left");
      } else {
        updates["system.CyberBodyType.Location"] = "";
      }

      await item.update(updates);
      return this.render(true);
    }

    if (sameActorDrop) return false;
    return super._onDropItem(event, data);
  }
  async _cp_syncChipLevelsToSkills() {
    const actor = this.actor;
    if (!actor) return;

    const activeChips = actor.items.filter(i =>
      i.type === "cyberware" &&
      cwHasType(i, "Chip") &&
      i.system?.equipped !== false &&
      !!i.system?.CyberWorkType?.ChipActive
    );

    const agg = {};
    for (const ch of activeChips) {
      const skills = ch.system?.CyberWorkType?.ChipSkills || {};
      for (const [key, lvl] of Object.entries(skills)) {
        const n = Number(lvl) || 0;
        agg[key] = Math.max(agg[key] || 0, n);
      }
    }

    const skills = actor.items.filter(i => i.type === "skill");
    const updates = [];
    const updatedIds = [];
    const updatedMap = {};

    for (const s of skills) {
      const want = Number(agg[s.id] ?? agg[s.name] ?? 0);
      const cur  = Number(s.system?.chipLevel || 0);
      if (want !== cur) {
        updates.push({ _id: s.id, "system.chipLevel": want });
        updatedIds.push(s.id);
        updatedMap[s.id] = { ...(updatedMap[s.id] || {}), chipLevel: want };
      }
    }

    if (updates.length) {
      await actor.updateEmbeddedDocuments("Item", updates, { render: false });

      this._cp_forceRefreshOpenSkillSheets(updatedMap);

      for (const sid of updatedIds) {
        const sk = actor.items.get(sid);
        if (sk?.sheet?.rendered) sk.sheet.render(true);
      }
    }
  }

  _cp_forceRefreshOpenSkillSheets(updatedMap) {
    // updatedMap: { [skillId]: { isChipped?: boolean, chipLevel?: number } }
    if (!updatedMap) return;

    for (const [sid, patch] of Object.entries(updatedMap)) {
      const skill = this.actor.items.get(sid);
      const sheet = skill?.sheet;
      if (!sheet?.rendered) continue;

      const root = getHtmlElement(sheet.element);
      if (!root?.querySelector) continue;

      if (Object.prototype.hasOwnProperty.call(patch, "isChipped")) {
        const checkbox = root.querySelector('input[name="system.isChipped"]');
        if (checkbox) checkbox.checked = !!patch.isChipped;
      }

      if (Object.prototype.hasOwnProperty.call(patch, "chipLevel")) {
        const input = root.querySelector('input[name="system.chipLevel"], select[name="system.chipLevel"]');
        if (input) input.value = String(patch.chipLevel);
      }
    }
  }

  async _cp_syncActiveFlagsToSkills() {
    const actor = this.actor;
    if (!actor) return;

    const activeChips = actor.items.filter(i =>
      i.type === "cyberware" &&
      cwHasType(i, "Chip") &&
      i.system?.equipped !== false &&
      !!i.system?.CyberWorkType?.ChipActive
    );

    const activeMap = {};
    for (const ch of activeChips) {
      const skills = ch.system?.CyberWorkType?.ChipSkills || {};
      for (const key of Object.keys(skills)) activeMap[key] = true;
    }

    const skills = actor.items.filter(i => i.type === "skill");
    const updates = [];
    const updatedIds = [];
    const updatedMap = {};

    for (const s of skills) {
      const want = !!(activeMap[s.id] ?? activeMap[s.name]);
      const cur  = !!(s.system?.isChipped);
      if (want !== cur) {
        updates.push({ _id: s.id, "system.isChipped": want });
        updatedIds.push(s.id);
        updatedMap[s.id] = { ...(updatedMap[s.id] || {}), isChipped: want };
      }
    }

    if (updates.length) {
      await actor.updateEmbeddedDocuments("Item", updates, { render: false });

      this._cp_forceRefreshOpenSkillSheets(updatedMap);

      for (const sid of updatedIds) {
        const sk = actor.items.get(sid);
        if (sk?.sheet?.rendered) sk.sheet.render(true);
      }
    }
  }

  _cpSetupNotesAutosave(root) {
    if (!root) return;
    const editable = this.isEditable ?? this.options?.editable ?? false;
    if (!editable) return;

    if (!this._cpNotesAutosaveState) {
      this._cpNotesAutosaveState = {
        saving: false,
        pending: false,
        lastSaved: String(this.actor.system?.notes ?? "")
      };
    }

    if (this._cpNotesAutosaveHandler) {
      try { root.removeEventListener("save", this._cpNotesAutosaveHandler, true); } catch (_) {}
    }

    const handler = (ev) => {
      const target = ev?.target;
      if (!target?.closest) return;

      const inLife = target.closest('.tab.life[data-tab="life"]') || target.closest('.tab.life');
      if (!inLife) return;
      if (!target.closest(".cp-notes-editor")) return;

      setTimeout(() => this._cpFlushNotesAutosave(root, { force: true, serialize: false }), 0);
    };

    root.addEventListener("save", handler, true);
    this._cpNotesAutosaveHandler = handler;
  }

  _cpReadNotesHTML(root, { serialize = false } = {}) {
    const selectors = [
      '.tab.life[data-tab="life"] .editor-content',
      '.tab.life .editor-content',
      '.tab.life[data-tab="life"] [contenteditable="true"]',
      '.tab.life [contenteditable="true"]'
    ];

    return serialize
      ? saveRichEditorHTML(this, root, "system.notes", selectors)
      : getRichEditorHTML(this, root, "system.notes", selectors);
  }

  async _cpFlushNotesAutosave(root, { force = false, serialize = false } = {}) {
    const st = this._cpNotesAutosaveState;
    if (!st) return;

    if (st.saving) {
      st.pending = true;
      return;
    }

    const html = this._cpReadNotesHTML(root, { serialize });
    if (html == null) return;
    if (!force && st.lastSaved === html) return;

    st.saving = true;
    try {
      await this.actor.update({ "system.notes": html }, { render: false });
      st.lastSaved = html;
    } catch (err) {
      console.warn("CP2020: notes save failed", err);
    } finally {
      st.saving = false;
      if (st.pending) {
        st.pending = false;
        await this._cpFlushNotesAutosave(root, { force: true, serialize: false });
      }
    }
  }

  _cpGetSavedRangedAttackOptions(item) {
    const saved = item?.getFlag?.("cyberpunk2020", "lastRangedAttackOptions") ?? {};
    return foundry.utils.duplicate(saved);
  }

  async _cpSaveRangedAttackOptions(item, fireOptions = {}) {
    if (!item) return;
    if (fireOptions.fireMode === undefined) return;

    const saved = this._cpGetSavedRangedAttackOptions(item);
    const fireMode = String(fireOptions.fireMode ?? "");

    if (saved.fireMode === fireMode) return;

    try {
      await item.update({
        "flags.cyberpunk2020.lastRangedAttackOptions": {
          ...saved,
          fireMode
        }
      }, { render: false });
    } catch (err) {
      console.warn("CP2020: failed to save ranged attack options", err);
    }
  }

  async _cpSaveMeleeAttackOptions(item, fireOptions = {}) {
    if (!item) return;

    const fieldsToSave = [
      "action",
      "martialArt",
      "cyberTerminus"
    ];

    const saved = this._cpGetSavedMeleeAttackOptions(item);
    let changed = false;

    for (const key of fieldsToSave) {
      if (fireOptions[key] === undefined) continue;

      const value = String(fireOptions[key] ?? "");

      if (saved[key] !== value) {
        saved[key] = value;
        changed = true;
      }
    }

    if (!changed) return;

    try {
      await item.update({
        "flags.cyberpunk2020.lastMeleeAttackOptions": saved
      }, { render: false });
    } catch (err) {
      console.warn("CP2020: failed to save melee attack options", err);
    }
  }

    _cpGetSavedRangedAttackOptions(item) {
    const saved = item?.getFlag?.("cyberpunk2020", "lastRangedAttackOptions") ?? {};
    return foundry.utils.duplicate(saved);
  }

  async _cpSaveRangedAttackOptions(item, fireOptions = {}) {
    if (!item) return;
    if (fireOptions.fireMode === undefined) return;

    const saved = this._cpGetSavedRangedAttackOptions(item);
    const fireMode = String(fireOptions.fireMode ?? "");

    if (saved.fireMode === fireMode) return;

    try {
      await item.update({
        "flags.cyberpunk2020.lastRangedAttackOptions": {
          ...saved,
          fireMode
        }
      }, { render: false });
    } catch (err) {
      console.warn("CP2020: failed to save ranged attack options", err);
    }
  }

  _cpGetSavedMeleeAttackOptions(item) {
    const saved = item?.getFlag?.("cyberpunk2020", "lastMeleeAttackOptions") ?? {};
    return foundry.utils.duplicate(saved);
  }

  async _cpSaveMeleeAttackOptions(item, fireOptions = {}) {
    if (!item) return;

    const fieldsToSave = [
      "action",
      "martialArt",
      "cyberTerminus"
    ];

    const saved = this._cpGetSavedMeleeAttackOptions(item);
    let changed = false;

    for (const key of fieldsToSave) {
      if (fireOptions[key] === undefined) continue;

      const value = String(fireOptions[key] ?? "");

      if (saved[key] !== value) {
        saved[key] = value;
        changed = true;
      }
    }

    if (!changed) return;

    try {
      await item.update({
        "flags.cyberpunk2020.lastMeleeAttackOptions": saved
      }, { render: false });
    } catch (err) {
      console.warn("CP2020: failed to save melee attack options", err);
    }
  }

  /** @override */
  async _preClose(options) {
    try {
      const root = getHtmlElement(this.element);
      await this._cpFlushNotesAutosave(root, { force: true, serialize: true });
    } catch (_) {}

    try {
      this._cpChipTooltipCleanup?.();
      this._cpChipTooltipCleanup = null;
    } catch (_) {}

    try {
      if (this._cpAvatarCaptureRoot && this._cpAvatarCapture) {
        this._cpAvatarCaptureRoot.removeEventListener("click", this._cpAvatarCapture, { capture: true });
      }
      this._cpAvatarCaptureRoot = null;
      this._cpAvatarCapture = null;
    } catch (_) {}

    return super._preClose(options);
  }

}
