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
    return mergeObject(super.defaultOptions, {
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
      const initiativeMod = getProperty(system, "initiativeMod") || 0;
      sheetData.initiativeMod = initiativeMod;

      const StunDeathMod = getProperty(system, "StunDeathMod") || 0;
      sheetData.StunDeathMod = StunDeathMod;
    }
    const allPrograms = this.actor.items.filter(i => i.type === "program");
    allPrograms.sort((a, b) => a.name.localeCompare(b.name));
    sheetData.netrunPrograms = allPrograms;

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

    // Everything below here is only needed if the sheet is editable
    if (!this.options.editable) return;
    
    // Find elements with stuff like html.find('.cssClass').click(this.function.bind(this));
    // Bind makes the "this" object in the function this.
    // html.find('.skill-search').click(this._onItemCreate.bind(this));

    html.find('.stat-roll').click(ev => {
      let statName = ev.currentTarget.dataset.statName;
      this.actor.rollStat(statName);
    });
    // TODO: Refactor these skill interactivity stuff into their own methods
    html.find(".skill-level").click((event) => event.target.select()).change((event) => {
      let skill = this.actor.items.get(event.currentTarget.dataset.skillId);
      let target = skill.system.isChipped ? "system.chipLevel" : "system.level";
      let updateData = {_id: skill.id};
      updateData[target] = parseInt(event.target.value, 10);
      this.actor.updateEmbeddedDocuments("Item", [updateData]);
      // Mild hack to make sheet refresh and re-sort: the ability to do that should just be put in 
    });
    html.find(".chip-toggle").click(ev => {
      let skill = this.actor.items.get(ev.currentTarget.dataset.skillId);
      this.actor.updateEmbeddedDocuments("Item", [{
        _id: skill.id,
        "system.isChipped": !skill.system.isChipped
      }]);
    });

    html.find(".skill-sort > select").change(ev => {
      let sort = ev.currentTarget.value;
      this.actor.sortSkills(sort);
    });
    html.find(".skill-roll").click(ev => {
      let id = ev.currentTarget.dataset.skillId;
      this.actor.rollSkill(id);
    });
    html.find(".roll-initiative").click(ev => {
      const rollInitiativeModificatorInput = html.find(".roll-initiative-modificator")[0];
      this.actor.addToCombatAndRollInitiative(rollInitiativeModificatorInput.value);
    });
    html.find(".roll-initiative-modificator").change(ev => {
      const value = ev.target.value;
      this.actor.update({"system.initiativeMod": Number(value)});
    });
    html.find(".roll-stun-death-modificator").change(ev => {
      const value = ev.target.value;
      this.actor.update({"system.StunDeathMod": Number(value)});
    });           
    html.find(".damage").click(ev => {
      let damage = Number(ev.currentTarget.dataset.damage);
      this.actor.update({
        "system.damage": damage
      });
    });
    html.find(".stun-death-save").click(ev => {
      const rollModificatorInput = html.find(".roll-stun-death-modificator")[0]
      this.actor.rollStunDeath(rollModificatorInput.value);
    });

    html.find('.item-roll').click(ev => {
      // Roll is often within child events, don't bubble please
      ev.stopPropagation();
      let item = getEventItem(this, ev);
      item.roll();
    });
    html.find('.item-edit').click(ev => {
      ev.stopPropagation();
      let item = getEventItem(this, ev);
      item.sheet.render(true);
    });
    html.find('.item-delete').click(deleteItemDialog.bind(this));
    html.find('.rc-item-delete').bind("contextmenu", deleteItemDialog.bind(this)); 

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
  }

  async _onDropItem(event, data) {
    event.preventDefault();

    // Search for the parent element with the data-drop-target attribute
    const dropTarget = event.target.closest("[data-drop-target]");
    // If not found, then let the standard Foundry logic work
    if ( !dropTarget ) return super._onDropItem(event, data);

    // Check if we threw in “program-list”
    if ( dropTarget.dataset.dropTarget === "program-list") {
      // Parsing data about the dragged item (ItemData)
      let itemData = await Item.implementation.fromDropData(data);

      if (itemData.type !== "program") {
        return ui.notifications.warn(`Это не программа: ${itemData.name}`);
      }

      // Create a new item (copy) for this actor.
      return this.actor.createEmbeddedDocuments("Item", [ itemData ]);
    }

    // If it's not “program-list”, give control to the parent method,
    // so as not to break the standard behavior of dropping to other parts of the sheet
    return super._onDropItem(event, data);
  }
}
