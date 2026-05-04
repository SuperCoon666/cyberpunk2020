import { martialOptions, meleeAttackTypes, meleeBonkOptions, rangedModifiers, weaponTypes, FNFF2_ONLY_MARTIAL_ART_IDS, isFnff2Enabled } from "../lookups.js"
import { deleteFieldUpdate, localize, localizeParam, cwHasType, cwIsEnabled } from "../utils.js"
import { ModifiersDialog } from "../dialog/modifiers.js"
import { SortOrders, sortSkills } from "./skill-sort.js";
import { getHtmlElement, getRichEditorHTML, itemFromDropData, saveRichEditorHTML, syncRichEditorHTML } from "../compat.js";

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
    sheetData.owner = this.actor.isOwner;
    sheetData.editable = this.isEditable ?? this.options?.editable ?? false;

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

    /*definitions for active cyberware segments - cyberware anatomy display*/
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

    sheetData.skillDisplayList = sheetData.filteredSkillIDs
      .map(id => this.actor.items.get(id))
      .filter(Boolean);
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

  // Handle searching skills
  _filterSkills(sheetData) {
    const transient = sheetData.system.transient ??= {};

    transient.skillFilter ??= "";
    const upperSearch = String(transient.skillFilter).toUpperCase();

    let listToFilter = this._getSortedSkillIDs(sheetData);

    if (upperSearch === "") return listToFilter;

    const oldSearch = String(transient.oldSearch ?? "").toUpperCase();
    if (oldSearch && Array.isArray(sheetData.filteredSkillIDs) && upperSearch.startsWith(oldSearch)) {
      listToFilter = sheetData.filteredSkillIDs;
    }

    const result = listToFilter.filter(id => {
      const skill = this.actor.items.get(id);
      if (!skill) return false;
      return String(skill.name).toUpperCase().includes(upperSearch);
    });

    transient.oldSearch = upperSearch;
    return result;
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
  activateListeners(html) {
    const root = getHtmlElement(html);

    if (this._cpAvatarCapture) {
      try {
        root.removeEventListener("pointerdown", this._cpAvatarCapture, { capture: true });
        root.removeEventListener("click", this._cpAvatarCapture, { capture: true });
      } catch (_) {}
    }

    const cpAvatarCapture = (ev) => {
      const editable = ev.target?.closest?.("[data-edit]");
      if (!editable) return;
      if ((editable.dataset?.edit || "") !== "img") return;

      ev.preventDefault();
      ev.stopImmediatePropagation?.();

      const fp = new FilePicker({
        type: "image",
        activeSource: "data",
        current: "",
        callback: (path) => this.actor.update({ img: path })
      });
      fp.render(true);
      setTimeout(() => {
        try { fp.browse({ activeSource: "data", current: "" }); }
        catch { try { fp.browse("data", "", {}); } catch (e) { console.warn(e); } }
      }, 0);
    };

    root.addEventListener("pointerdown", cpAvatarCapture, { capture: true });
    root.addEventListener("click", cpAvatarCapture, { capture: true });
    this._cpAvatarCapture = cpAvatarCapture;

    super.activateListeners(html);
    // Life tab (system.notes) autosave

  _cpSetupNotesAutosave(root) {
    if (!root) return;
    if (!this.options?.editable) return;

    if (!this._cpNotesAutosaveState) {
      this._cpNotesAutosaveState = {
        timer: null,
        saving: false,
        pending: false,
        lastSaved: String(this.actor.system?.notes ?? "")
      };
    }

    if (this._cpNotesAutosaveHandler) {
      try {
        root.removeEventListener("save", this._cpNotesAutosaveHandler, true);
      } catch (_) {}
    }

    const handler = (ev) => {
      const editor = ev?.target?.closest?.("prose-mirror") ?? (ev?.target?.matches?.("prose-mirror") ? ev.target : null);
      if (!editor) return;
      if (!editor.closest?.('.tab.life[data-tab="life"], .tab.life')) return;
      if (!editor.closest?.(".cp-notes-editor")) return;

      // Do not save on live editor changes/open toggles. Updating the document
      // while the native ProseMirror element is open can leave the editor in a
      // disabled visual state. Save only after the element has completed its
      // own save cycle.
      if (ev.type !== "save") return;
      setTimeout(() => this._cpFlushNotesAutosave(root, { force: true }), 0);
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
      syncRichEditorHTML(this, root, "system.notes", html);
      st.lastSaved = html;
    } catch (err) {
      console.warn("CP2020: notes autosave failed", err);
    } finally {
      st.saving = false;
      if (st.pending) {
        st.pending = false;
        await this._cpFlushNotesAutosave(root);
      }
    }
  }

  /** @override */
  _getSubmitData(updateData = {}) {
    const data = super._getSubmitData(updateData);

    try {
      const root = getHtmlElement(this.element);
      const html = this._cpReadNotesHTML(root, { serialize: true });
      if (html != null) data["system.notes"] = html;
    } catch (_) {}

    return data;
  }

  /** @override */
  async close(options = {}) {
    try {
      const root = getHtmlElement(this.element);
      if (this._cpNotesAutosaveState?.timer) {
        clearTimeout(this._cpNotesAutosaveState.timer);
        this._cpNotesAutosaveState.timer = null;
      }
      await this._cpFlushNotesAutosave(root, { serialize: true, force: true });
    } catch (_) {}

    return super.close(options);
  }


}
