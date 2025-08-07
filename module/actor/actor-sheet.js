import { martialOptions, meleeAttackTypes, meleeBonkOptions, rangedModifiers, weaponTypes } from "../lookups.js"
import { localize, localizeParam } from "../utils.js"
import { ModifiersDialog } from "../dialog/modifiers.js"
import { SortOrders } from "./skill-sort.js";

/**
 * Extend the basic ActorSheet with some very simple modifications
 * @extends {ActorSheet}
 */
export class CyberpunkActorSheet extends ActorSheet {

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      // Css classes
      classes: ["cyberpunk", "sheet", "actor"],
      template: "systems/cyberpunk2020/templates/actor/actor-sheet.hbs",
      // Default window dimensions
      width: 590,
      height: 600,
      tabs: [{ navSelector: ".sheet-tabs", contentSelector: ".sheet-body", initial: "skills" }]
    });
  }

  /* -------------------------------------------- */

  /** @override */
  getData(options) {
    // Call the parent getData method, which provides the base sheetData
    const sheetData = super.getData(options);

    // Extract the actor and system references for convenience
    const actor = this.actor;
    const system = actor.system;

    // Store a reference to the system data for easier access in templates and other methods
    sheetData.system = system;

    // Only proceed with character or NPC types
    if (actor.type === 'character' || actor.type === 'npc') {
      // If transient data doesn't exist, initialize it.
      // Transient data is used for temporary things like skill search filters.
      if (system.transient == null) {
        system.transient = { skillFilter: "" };
      }

      // Prepare character-related items and data
      this._prepareCharacterItems(sheetData);
      this._addWoundTrack(sheetData);
      this._prepareSkills(sheetData);

      // Reference to weapon types for the template
      // This is needed because we can't directly store a list of entities in the system data
      sheetData.weaponTypes = weaponTypes;

      // Retrieve the initiative modifier from system data
      // Ensure that you have defined `initiativeMod` in your system data schema
      const initiativeMod = foundry.utils.getProperty(system, "initiativeMod") || 0;
      sheetData.initiativeMod = initiativeMod;

      const StunDeathMod = foundry.utils.getProperty(system, "StunDeathMod") || 0;
      sheetData.StunDeathMod = StunDeathMod;
    }

    // Collect all programs that belong to this actor.
    const allPrograms = this.actor.items.filter(i => i.type === "program");
    allPrograms.sort((a, b) => a.name.localeCompare(b.name));
    sheetData.netrunPrograms = allPrograms;

    sheetData.programsTotalCost = allPrograms
    .reduce((sum, p) => sum + Number(p.system.cost || 0), 0);

    /**
     * Collect the list of active programs based on the ID array
     *   actor.system.activePrograms: string[]
     */
    const activeProgIds = this.actor.system.activePrograms || [];
    // Filter out the ones the actor actually has.
    const activePrograms = allPrograms.filter(p => activeProgIds.includes(p.id));
    // Put them in sheetData so netrun-tab.hbs can output them
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
    sheetData.skillDisplayList = sheetData.filteredSkillIDs.map(id => this.actor.items.get(id));
  }

  // Handle searching skills
  _filterSkills(sheetData) {
    let id = sheetData.actor._id;

    if(sheetData.system.transient.skillFilter == null) {
      sheetData.system.transient.skillFilter = "";
    }
    let upperSearch = sheetData.system.transient.skillFilter.toUpperCase();
    let listToFilter = sheetData.system.sortedSkillIDs || game.actors.get(id).itemTypes.skill.map(skill => skill.id);

    // Only filter if we need to
    if(upperSearch === "") {
      return listToFilter;
    }
    else {
      // If we searched previously and the old search had results, we can filter those instead of the whole lot
      if(sheetData.system.transient.oldSearch != null 
        && sheetData.filteredSkillIDs != null
        && upperSearch.startsWith(oldSearch)) {
        listToFilter = sheetData.filteredSkillIDs; 
      }
      return listToFilter.filter(id => {
        let skillName = this.actor.items.get(id).name;
        return skillName.toUpperCase().includes(upperSearch);
      });
    }
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

    // Convenience copy of itemTypes tab, makes things a little less long-winded in the templates
    // TODO: Does this copy need to be done with itemTypes being a thing?
    sheetData.gear = {
      weapons: sortedItems.weapon,
      armor: sortedItems.armor,
      cyberware: sortedItems.cyberware,
      misc: sortedItems.misc,
      cyberCost: sortedItems.cyberware.reduce((a,b) => a + b.system.cost, 0)
    };

  }

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    /**
     * Get an owned item from a click event, for any event trigger with a data-item-id property
     * @param {*} ev 
    */
    function getEventItem(sheet, ev) {
      let itemId = ev.currentTarget.dataset.itemId;
      return sheet.actor.items.get(itemId);
    }
    // TODO: Check if shift is held to skip dialog?
    function deleteItemDialog(ev) {
      ev.stopPropagation();
      let item = getEventItem(this, ev);
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
    }

    // If not editable, do nothing further
    if (!this.options.editable) return;

    // Stat roll
    html.find('.stat-roll').click(ev => {
      let statName = ev.currentTarget.dataset.statName;
      this.actor.rollStat(statName);
    });
    // TODO: Refactor these skill interactivity stuff into their own methods
    // Skill level changes
    html.find(".skill-level").click((event) => event.target.select()).change(async (event) => {
      let skill = this.actor.items.get(event.currentTarget.dataset.skillId);
      let target = skill.system.isChipped ? "system.chipLevel" : "system.level";
      let updateData = { _id: skill.id };
      updateData[target] = parseInt(event.target.value, 10);
      // Mild hack to make sheet refresh and re-sort: the ability to do that should just be put in 
      await this.actor.updateEmbeddedDocuments("Item", [updateData]);
      // let combatSenseItemFind = this.actor.items.find(item => item.type === 'skill' && item.name.includes('Combat'))?.system.level || 0;
      let combatSenseItemFind = 
        this.actor.items.find(item => item.type === 'skill' && item.name.includes('Combat'))?.system.level
        ?? this.actor.items.find(item => item.type === 'skill' && item.name.includes('Боя'))?.system.level
        ?? 0;
      await this.actor.update({ "system.CombatSenseMod": Number(combatSenseItemFind) });
    });
    // Toggle skill chipped
    html.find(".chip-toggle").click(async ev => {
      const skill = this.actor.items.get(ev.currentTarget.dataset.skillId);
      const toggled = !skill.system.isChipped;

      await this.actor.updateEmbeddedDocuments("Item", [{
        _id: skill.id,
        "system.isChipped": toggled,
        "system.-=chipped": null
      }]);
    });
    
    // Skill sorting
    html.find(".skill-sort > select").change(ev => {
      let sort = ev.currentTarget.value;
      this.actor.sortSkills(sort);
    });

    // Skill search: auto-filter + clear button
    const $skillSearch = html.find('input.skill-search[name="system.transient.skillFilter"]');
    const $skillClear  = html.find('.skill-search-clear');

    const toggleClear = () => $skillClear.toggleClass('is-visible', !!$skillSearch.val());

    // Restore caret position after re-render (so typing continues without jumping)
    if (this._restoreSkillCaret != null) {
      const el = $skillSearch[0];
      if (el) {
        el.focus();
        const pos = Math.min(this._restoreSkillCaret, el.value.length);
        try { el.setSelectionRange(pos, pos); } catch(_) {}
      }
      this._restoreSkillCaret = null;
    }

    toggleClear();

    // Auto-search while typing
    let searchTypingTimer;
    $skillSearch.on('input', (ev) => {
      const val = ev.currentTarget.value || "";
      toggleClear();

      // Remember cursor position before re-render
      this._restoreSkillCaret = ev.currentTarget.selectionStart ?? val.length;

      // Update the "transient" filter in memory (without actor.update)
      foundry.utils.setProperty(this.actor.system, "transient.skillFilter", val);

      // Soft re-render of the sheet
      clearTimeout(searchTypingTimer);
      searchTypingTimer = setTimeout(() => this.render(false), 120);
    });

    html.on('pointerdown mousedown', '[data-action="clear-skill-search"]', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });

    // Clear the field and instantly reset the filter
    html.on('click', '[data-action="clear-skill-search"]', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      $skillSearch.val('');
      this._restoreSkillCaret = 0;
      foundry.utils.setProperty(this.actor.system, "transient.skillFilter", "");
      this.render(false);
    });

    // Prompt for modifiers
    html.find(".skill-ask-mod")
      .on("click",  ev => ev.stopPropagation())
      .on("change", async ev => {
        ev.stopPropagation();

        const cb = ev.currentTarget;
        const skillId = cb.dataset.skillId;
        const skill = this.actor.items.get(skillId);
        if (!skill) return ui.notifications.warn(localize("SkillNotFound"));

        try {
          await skill.update({ "system.askMods": cb.checked });
        } catch (err) {
          console.error(err);
          ui.notifications.error(localize("UpdateAskModsError"));
          cb.checked = !cb.checked;
        }
      });

    // Skill roll
    html.find(".skill-roll").click(ev => {
      const id = ev.currentTarget.dataset.skillId;
      const skill = this.actor.items.get(id);
      if (!skill) return;

      if (skill.system?.askMods) {
        const dlg = new ModifiersDialog(this.actor, {
          title: localize("ModifiersSkillTitle"),
          showAdvDis: true,
          modifierGroups: [[
            { localKey: "ExtraModifiers", dataPath: "extraMod", defaultValue: 0 }
          ]],
          onConfirm: ({ extraMod=0, advantage=false, disadvantage=false }) =>
            this.actor.rollSkill(
              id,
              Number(extraMod) || 0,
              advantage,
              disadvantage
            )
        });
        return dlg.render(true);
      }
      this.actor.rollSkill(id);
    });

    // Initiative
    html.find(".roll-initiative").click(ev => {
      const rollInitiativeModificatorInput = html.find(".roll-initiative-modificator")[0];
      this.actor.addToCombatAndRollInitiative(rollInitiativeModificatorInput.value);
    });
    html.find(".roll-initiative-modificator").change(ev => {
      const value = ev.target.value;
      this.actor.update({"system.initiativeMod": Number(value)});
    });

    // Stun/Death save
    html.find(".roll-stun-death-modificator").change(ev => {
      const value = ev.target.value;
      this.actor.update({"system.StunDeathMod": Number(value)});
    });
    html.find(".stun-death-save").click(ev => {
      const rollModificatorInput = html.find(".roll-stun-death-modificator")[0]
      this.actor.rollStunDeath(rollModificatorInput.value);
    });

    // Damage
    html.find(".damage").click(ev => {
      let damage = Number(ev.currentTarget.dataset.damage);
      this.actor.update({
        "system.damage": damage
      });
    });

    // Generic item roll (calls item.roll())
    html.find('.item-roll').click(ev => {
      // Roll is often within child events, don't bubble please
      ev.stopPropagation();
      let item = getEventItem(this, ev);
      item.roll();
    });

    // Edit item
    html.find('.item-edit').click(ev => {
      ev.stopPropagation();
      let item = getEventItem(this, ev);
      item.sheet.render(true);
    });

    // Delete item
    html.find('.item-delete').click(deleteItemDialog.bind(this));
    html.find('.rc-item-delete').bind("contextmenu", deleteItemDialog.bind(this)); 

    // "Fire" button for weapons
    html.find('.fire-weapon').click(ev => {
      ev.stopPropagation();
      let item = getEventItem(this, ev);
      let isRanged = item.isRanged();

      let modifierGroups = undefined;
      let targetTokens = Array.from(game.users.current.targets.values()).map(target => {
        return {
          name: target.document.name, 
          id: target.id};
      });
      if(isRanged) {
        // For now just look at the names.
        // We have to get the values as an iterator; else if multiple targets share names, it'd turn a set with size 2 to one with size 1
        modifierGroups = rangedModifiers(item, targetTokens);
      }
      else if (item.system.attackType === meleeAttackTypes.martial){
        modifierGroups = martialOptions(this.actor);
      }
      else {
        modifierGroups = meleeBonkOptions();
      }

      let dialog = new ModifiersDialog(this.actor, {
        weapon: item,
        targetTokens: targetTokens,
        modifierGroups: modifierGroups,
        onConfirm: (fireOptions) => item.__weaponRoll(fireOptions, targetTokens)
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

    // Make each .netrun-program the “source” of the drag and drop operation
    html.find('.netrun-program').each((_, programElem) => {
      // An attribute telling the browser and Foundry that this element can be “dragged”
      programElem.setAttribute("draggable", true);

      // Process dragstart
      programElem.addEventListener("dragstart", ev => {
        // Find the corresponding Item
        const itemId = programElem.dataset.itemId;
        const item = this.actor.items.get(itemId);
        if ( !item ) return;

        // Form dragData - object to be read in _onDropItem(event, data)
        const dragData = {
          type: "Item",
          actorId: this.actor.id,
          data: item.toObject()
        };

        // Write dragData to the event
        ev.dataTransfer.setData("text/plain", JSON.stringify(dragData));

        // You can add an “is-dragging” class or any visual highlighting class
        programElem.classList.add("is-dragging");
      });

      // When the dragging is finished, remove the class
      programElem.addEventListener("dragend", ev => {
        programElem.classList.remove("is-dragging");
      });
    });

    // Auto-save changes for all fields that have data-edit=”...”
    // This will allow writing new values to this.actor at once.
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

    // Click on .interface-skill-roll to make a roll (if itemId is not null)
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

    // When clicking (contextmenu) on the icon of the active program - remove it from the list
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
  }

  /**
   * Overridden method of Drag&Drop processing
   * When dropping, we check where exactly we dropped to (data-drop-target).
   * If on “program-list” - add program to inventory.
   * If on “active-programs” - activate the program.
   */
  async _onDropItem(event, data) {
    event.preventDefault();

    // Search for the parent element with the data-drop-target attribute
    const dropTarget = event.target.closest("[data-drop-target]");
    // If not found, then let the standard Foundry logic work
    if (!dropTarget) return super._onDropItem(event, data);

    // 1. Drop to “program-list”.
    if (dropTarget.dataset.dropTarget === "program-list") {
      let itemData = await Item.implementation.fromDropData(data);

      // If it is not a program, skip it
      if (itemData.type !== "program") {
        return ui.notifications.warn(localize("NotAProgram", { name: itemData.name }));
      }

      // If a person pulls a program that the same actor already has,
      // and drops it in the program-list, - do nothing (to avoid duplicating)
      const sameActor = (data.actorId === this.actor.id);
      const existingItem = sameActor ? this.actor.items.get(itemData._id) : null;
      if (existingItem) {
        ui.notifications.warn(localize("ProgramAlreadyExists", { name: existingItem.name }));
        return;
      }

      // Otherwise (pulling from another actor, or from compendium, or it's another program) - create a copy
      return this.actor.createEmbeddedDocuments("Item", [ itemData ]);
    }

    // 2. Drop in “active-programs”
    if (dropTarget.dataset.dropTarget === "active-programs") {
      // Get Item from drag data
      let itemData = await Item.implementation.fromDropData(data);

      if (itemData.type !== "program") {
        return ui.notifications.warn(localize("OnlyProgramsCanBeActivated", { name: itemData.name }));
      }

      // Check if the item is already in your inventory; if not, copy it
      let item = this.actor.items.get(itemData._id);
      if (!item) {
        const [created] = await this.actor.createEmbeddedDocuments("Item", [itemData]);
        item = created;
      }

      // Current list of active programs (ID)
      const currentActive = this.actor.system.activePrograms || [];
      const newMu = Number(item.system.mu) || 0;

      // Count the already occupied MU
      const usedMu = currentActive.reduce((sum, id) => {
        const p = this.actor.items.get(id);
        return sum + (Number(p?.system.mu) || 0);
      }, 0);

      const ramMax = Number(this.actor.system.ramMax) || 0;

      // If we exceed the limit after adding, we reject it
      if (ramMax && (usedMu + newMu) > ramMax) {
        return ui.notifications.warn(
          localize("NotEnoughRAM", { name: item.name, used: usedMu, max: ramMax })
        );
      }

      // Add to active, if not already there
      if (!currentActive.includes(item.id)) {
        currentActive.push(item.id);

        const totalMu = usedMu + newMu;
        await this.actor.update({
          "system.activePrograms": currentActive,
          "system.ramUsed": totalMu
        });

        this.render(true);
      }
      return;
    }

    // If not “program-list” and not “active-programs”, then execute the standard Foundry mechanism
    return super._onDropItem(event, data);
  }
}
