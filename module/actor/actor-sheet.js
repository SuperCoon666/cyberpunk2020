import { martialOptions, meleeAttackTypes, meleeBonkOptions, rangedModifiers, stabilizationOptions, weaponTypes, FNFF2_ONLY_MARTIAL_ART_IDS, isCombatAutomationEnabled, isFnff2Enabled, COMBAT_SENSE_SKILL_IDS, INTERFACE_SKILL_IDS, UNARMED_STRIKE_ID, programTypes } from "../lookups.js";
import { CyberpunkItem } from "../item/item.js";
import { CyberpunkActor } from "./actor.js";
import { deleteFieldUpdate, localize, localizeParam, cwHasType, cwIsEnabled, refusedWhilePaused, withCompendiumSource } from "../utils.js"
import { ModifiersDialog } from "../dialog/modifiers.js"
import { SortOrders, sortSkills } from "./skill-sort.js";
import { getHtmlElement, getRichEditorHTML, itemFromDropData, saveRichEditorHTML } from "../compat.js";
import { actionPenaltyFor, chargeAction, currentTurnKey } from "../combat.js";
import { MORTAL_WOUND_STATE } from "../damage.js";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;
const { Tabs } = foundry.applications.ux;

/**
 * The `cyberpunk2020.melee` Strike document, which the combat tab's fixed unarmed button borrows
 * for its icon and its weapon data. `T222` deleted the embedded copies, so this is fetched rather
 * than owned — and cached, because `_prepareContext` runs on every render and a pack read there is
 * a database hit per render. Null when the pack is not loaded, which is what the button refuses on.
 */
let unarmedSource;
async function getUnarmedSource() {
  if (unarmedSource !== undefined) return unarmedSource;
  const doc = await game.packs.get("cyberpunk2020.melee")?.getDocument(UNARMED_STRIKE_ID);
  unarmedSource = doc ? doc.toObject() : null;
  return unarmedSource;
}

/** @extends {foundry.applications.sheets.ActorSheetV2} */
export class CyberpunkActorSheet extends HandlebarsApplicationMixin(ActorSheetV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["cyberpunk", "sheet", "actor", "flexcol"],
    tag: "form",
    position: {
      // 660 clears the combat tab's two-column threshold (637px, zone K.8.12); sized to the
      // owner's own layout (his 661×795 screenshot, D105) rather than derived.
      width: 660,
      height: 800
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

  /**
   * Item ids whose attack is still resolving. A contested melee attack blocks on the defender's
   * own client for up to 30 s, and nothing else on the path is inert while it does.
   */
  #attacksInFlight = new Set();

  /** @override */
  async _prepareContext(options) {
    const sheetData = await super._prepareContext(options);

    const actor = this.actor;
    const system = actor.system;

    sheetData.actor = actor;
    sheetData.itemTypes = actor.itemTypes;
    sheetData.system = system;
    sheetData.owner = this.actor.isOwner;
    sheetData.editable = this.isEditable;
    sheetData.cssClass = ["cyberpunk", "sheet", "actor"].join(" ");
    sheetData.notesEditing = !!this._cpNotesEditing;

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

    sheetData.netrunPrograms = allPrograms.map(p => {
      const typeKey = programTypes.find(t => t.value === p.system.programType)?.localKey;
      return {
        id: p.id,
        name: p.name,
        img: p.img,
        mu: p.system.mu,
        typeLabel: typeKey ? localize(typeKey) : ""
      };
    });

    sheetData.programsTotalCost = allPrograms
    .reduce((sum, p) => sum + Number(p.system.cost || 0), 0);

    const activeProgIds = this.actor.system.activePrograms || [];
    const activePrograms = allPrograms.filter(p => activeProgIds.includes(p.id));
    sheetData.netrunActivePrograms = activePrograms;

    const allSkills = this.actor.items.filter(i => i.type === "skill");

    const interfaceName = game.i18n.localize("CYBERPUNK.SkillInterface");
    const interfaceItem = allSkills.find(i => INTERFACE_SKILL_IDS.has(i.id ?? i._id))
      ?? allSkills.find(i => i.name === interfaceName); // Legacy fallback for old/manual data

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

    const unarmed = await getUnarmedSource();
    sheetData.unarmed = unarmed ? { name: unarmed.name, img: unarmed.img } : null;

    return sheetData;
  }

  _prepareSkills(sheetData) {
    sheetData.skillsSort = this.actor.system.skillsSortedBy || "Name";
    sheetData.skillsSortChoices = Object.keys(SortOrders);

    // Every skill is rendered whatever the search box holds: the filter only hides rows, and it
    // cannot bring back a row the template never emitted. Filtering here too meant a re-render
    // while a filter was live left the sheet with just the matches in the DOM, and clearing the
    // box then restored nothing.
    sheetData.skillDisplayList = this._getSortedSkillIDs(sheetData)
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

    // D61: while the optional rule is off a trained FNFF2-only art is hidden from the sheet
    // entirely — the document is untouched underneath and comes back with its level on re-enable.
    // Through the id **candidates**, not `_id` alone: a copy dragged from the pack carries the
    // original in `_stats.compendiumSource` and would otherwise stay visible here while
    // `trainedMartials` — which resolves the same way — had already dropped it.
    if (!isFnff2Enabled()) {
      currentSkills = currentSkills.filter(skill => !CyberpunkActor._getItemIdCandidates(skill)
        .some(candidate => FNFF2_ONLY_MARTIAL_ART_IDS.has(candidate)));
    }

    const currentIds = currentSkills.map(s => s.id);

    const cached = system.sortedSkillIDs;
    const cachedOk = Array.isArray(cached)
      && cached.length === currentIds.length
      && cached.every(id => currentIds.includes(id));

    if (cachedOk) return cached;

    return sortSkills(currentSkills, SortOrders[sortOrder]).map(s => s.id);
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

    // "Active cyberware" is the installed set, so an Activatable implant belongs on the body map
    // whether or not its effect is switched on — the row carries the toggle. `cwIsEnabled` still
    // gates the rules engine in actor.js, which is where being switched off has to matter.
    const activeCyber = allCyber.filter(it => !!it.system?.equipped);

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
  }

  /** @override */
  _processFormData(event, form, formData) {
    const data = super._processFormData(event, form, formData);

    // `sdp.current` is the player's note of what is left in a zone, and 0 is a value they can
    // legitimately write there. Marking the zone on the same write is what lets the rules engine
    // tell that 0 apart from the untouched default, which it reseeds from the sum.
    const current = data?.system?.sdp?.current;
    if (current) {
      data.system.sdp.touched = Object.assign(data.system.sdp.touched ?? {},
        Object.fromEntries(Object.keys(current).map(zone => [zone, true])));
    }

    return data;
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);

    const root = getHtmlElement(this.element);
    if (!root) return;

    this._cpActivateTabs(root);
    this._cpActivateActorFilePickers(root);
    this._cpActivateBasicActorActions(root);
    this._cpActivateActorFormControls(root);
    this._cpActivateWoundTracker(root);
    this._cpActivateNotesEditor(root);
    this._cpActivateCyberwareControls(root);
    this._cpActivateNetrunningControls(root);
    this._cpActivateActorDragDrop(root);
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

    nav.addEventListener("click", async (event) => {
      const target = event.target?.closest?.("[data-tab]");
      if (!target) return;

      const nextTab = target.dataset.tab || "skills";

      if (this._cpNotesEditing && nextTab !== "life") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        await this._cpExitNotesEditing(root, { render: false });
        this._cpActiveTab = nextTab;

        await this.render({ force: true });
        return;
      }

      this._cpActiveTab = nextTab;
    }, true);

    const tabs = new Tabs({
      navSelector: ".sheet-tabs",
      contentSelector: ".sheet-body",
      initial: activeTab
    });

    tabs.bind(root);
    tabs.activate(activeTab);

    this._cpTabs = tabs;
  }

  _cpCreateFilePicker(options) {
    return new foundry.applications.apps.FilePicker.implementation(options);
  }

  // position.top/left are undefined until the sheet has been positioned once.
  _cpFilePickerPosition() {
    return { top: (this.position.top ?? 0) + 40, left: (this.position.left ?? 0) + 10 };
  }

  _cpActivateActorFilePickers(root) {
    if (!root?.addEventListener) return;

    if (this._cpAvatarCaptureRoot && this._cpAvatarCapture) {
      try {
        this._cpAvatarCaptureRoot.removeEventListener("click", this._cpAvatarCapture, { capture: true });
      } catch (_) {}
    }

    const onFilePickerClick = (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const avatar = target.closest('[data-edit="img"]');
      if (avatar) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        this._cpCreateFilePicker({
          type: "image",
          current: this.actor.img || "",
          callback: (path) => this.actor.update({ img: path }),
          position: this._cpFilePickerPosition()
        }).render(true);
        return;
      }

      const netrunIconPicker = target.closest(".netrun-icon-frame.filepicker");
      if (netrunIconPicker) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        const currentPath = this.actor.system.icon || "";

        this._cpCreateFilePicker({
          type: "image",
          current: currentPath,
          callback: async (path) => {
            await this.actor.update({ "system.icon": path });

            const icon = root.querySelector(".netrun-icon-frame img");
            if (icon) icon.src = path;

            const input = root.querySelector('input[name="system.icon"]');
            if (input) input.value = path;
          },
          position: this._cpFilePickerPosition()
        }).render(true);
      }
    };

    root.addEventListener("click", onFilePickerClick, { capture: true });
    this._cpAvatarCapture = onFilePickerClick;
    this._cpAvatarCaptureRoot = root;
  }

  _cpActivateBasicActorActions(root) {
    if (!root?.addEventListener) return;
    if (root.dataset.cpBasicActorActionsBound === "1") return;

    const isEditable = this.isEditable;
    if (!isEditable) return;

    // The flag must not be set before this point: root survives a re-render, so a first render
    // without edit rights would latch the sheet inert for the rest of its lifetime.
    root.dataset.cpBasicActorActionsBound = "1";

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

      // D106 — the combat tab nests the item's icon inside the row that fires, and the gear tab
      // nests the firing icon inside the row that opens. Whichever of the two is inner is what the
      // click meant, so an icon inside the row falls through to the `.item-edit` branch below.
      const fireWeapon = target.closest(".fire-weapon");
      if (fireWeapon && !fireWeapon.contains(target.closest(".item-edit"))) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        if (refusedWhilePaused()) return;

        const item = this._cpGetItemFromTarget(fireWeapon);
        if (item) this._cpOpenWeaponAttackDialog(item);
        return;
      }

      // Before the row's own handler, the way `.item-delete` is: the icon sits inside the row that
      // detonates, so a click that reached it must not go off.
      const takeBack = target.closest(".charge-remove");
      if (takeBack) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        await this.actor.takeBackCharge(takeBack.dataset.chargeId);
        return;
      }

      const detonate = target.closest(".detonate-charge");
      if (detonate) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        if (refusedWhilePaused()) return;

        await CyberpunkItem.detonateCharge(this.actor, detonate.dataset.chargeId);
        return;
      }

      const unarmed = target.closest(".unarmed-attack");
      if (unarmed) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        if (refusedWhilePaused()) return;

        await this._cpOpenUnarmedAttackDialog();
        return;
      }

      const stabilize = target.closest(".stabilize-roll");
      if (stabilize) {
        event.preventDefault();
        event.stopPropagation();

        if (refusedWhilePaused()) return;

        this._cpOpenStabilizationDialog();
        return;
      }

      const statRoll = target.closest(".stat-roll");
      if (statRoll) {
        event.preventDefault();
        event.stopPropagation();

        if (refusedWhilePaused()) return;

        const statName = statRoll.dataset.statName;
        if (statName) this.actor.rollStat(statName);
        return;
      }

      const itemEdit = target.closest(".item-edit");
      if (itemEdit) {
        if (target.closest(".item-delete, .item-unequip, .cyber-effect-toggle")) return;

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

        // Before the dialog opens, not at its submit: a skill with `askMods` opened one and was
        // refused on confirm while a skill without it rolled straight through, so the pause behaved
        // differently per skill (`T33`). The dialog keeps its own gate for the case this cannot
        // see — a world paused while the dialog is already open.
        if (refusedWhilePaused()) return;

        await this._cpRollSkillFromElement(skillRoll);
        return;
      }

      // Both rows roll on a click anywhere in the field, so their own modifier input has to opt
      // out: selecting its value to retype it lands a click on the row and fired a roll.
      const modifierInput = target.matches("input");

      const initiativeRoll = target.closest(".roll-initiative");
      if (initiativeRoll && !modifierInput) {
        event.preventDefault();
        event.stopPropagation();

        if (refusedWhilePaused()) return;

        const input = root.querySelector(".roll-initiative-modificator");
        await this.actor.addToCombatAndRollInitiative(input?.value ?? 0);
        return;
      }

      const stunDeathSave = target.closest(".stun-death-save");
      if (stunDeathSave && !modifierInput) {
        event.preventDefault();
        event.stopPropagation();

        if (refusedWhilePaused()) return;

        const input = root.querySelector(".roll-stun-death-modificator");
        await this._cpRollStunDeath(Number(input?.value) || 0);
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

    _cpGetOpenItemApplications(item) {
    if (!item?.apps) return [];

    if (item.apps instanceof Map) {
      return Array.from(item.apps.values());
    }

    if (Array.isArray(item.apps)) {
      return item.apps;
    }

    return Object.values(item.apps);
  }

  _cpRenderOpenItemApplications(items) {
    const list = Array.isArray(items) ? items : [items];

    for (const item of list) {
      // `item.apps` is the mixed V1/V2 registry — another module's V1 sheet can be in here, and
      // V1's `render(force)` takes a truthy object exactly as V2's does.
      for (const app of this._cpGetOpenItemApplications(item)) {
        if (!app?.rendered || typeof app.render !== "function") continue;
        app.render({ force: true });
      }
    }
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
      const dlg = new ModifiersDialog({
        window: { title: "CYBERPUNK.ModifiersSkillTitle" },
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

  /**
   * The sheet's own Stun/Death save, applying what it rolls.
   *
   * The identical save reached through an applied attack sets `cpStunned`, so a save rolled from
   * the sheet has to leave the world in the same state (`T29`); the Death Save follows only for a
   * Mortally wounded character, which is the rule `applyHitsToActor` already implements. Rolled on
   * this client rather than through `requestSave`: the button *is* the manual roll, and querying
   * the owner would ask the player who just clicked it.
   *
   * @param {number} mod Situational modifier typed beside the button
   */
  async _cpRollStunDeath(mod) {
    // D34 — the roll and its card are what the user asked for and stay in either state; the two
    // statuses are a resolution outcome, so with the master off they are the table's to set. This
    // is D22's turn-start split applied to the button (`T140`), and it was the one ungated writer
    // of `cpStunned`/`dead` left.
    const automated = isCombatAutomationEnabled();

    const stun = await this.actor.rollSave("stun", { mod });
    if (!stun.success && automated) await this.actor.toggleStatusEffect("cpStunned", { active: true });

    if (this.actor.woundState() < MORTAL_WOUND_STATE) return;

    const death = await this.actor.rollSave("death", { mod });
    if (!death.success && automated) {
      await this.actor.toggleStatusEffect("dead", { active: true, overlay: true });
    }
  }

  /**
   * The combat tab's fixed unarmed attack (`T222`, D53). `_preCreate` no longer injects Strike and
   * Kick, so the weapon is built here as a **temporary** owned document: `__weaponRoll` needs
   * `item.actor`, and `new CyberpunkItem(source, {parent})` supplies it without a create. Nothing
   * is persisted, which is why the last-used options are remembered on the actor instead.
   */
  async _cpOpenUnarmedAttackDialog() {
    const source = await getUnarmedSource();
    if (!source) {
      ui.notifications.warn(localize("UnarmedWeaponMissing"));
      return;
    }

    this._cpOpenWeaponAttackDialog(new CyberpunkItem(source, { parent: this.actor }),
      { flagHolder: this.actor });
  }

  /**
   * The stabilization roll's own modifier dialog (D52): the book's three advantages as checkboxes
   * plus the dialog's own free input. The patient is whoever this user has targeted — the roll is
   * made against *their* damage — and both refusals belong to `rollStabilization`, which is the
   * shape `__weaponRoll` already refuses `NoAmmo` in.
   */
  _cpOpenStabilizationDialog() {
    const token = Array.from(game.users.current.targets.values())[0];
    const patient = token?.actor ?? null;

    const dialog = new ModifiersDialog({
      window: { title: "CYBERPUNK.StabilizeModifiers" },
      modifierGroups: stabilizationOptions(),
      targetTokens: token ? [{ name: token.document.name }] : [],
      onConfirm: (options) => this.actor.rollStabilization(patient, options)
    });

    dialog.render(true);
  }

  /**
   * Distance from this actor's token to the target, in the scene's own units. Null whenever either
   * token is off the canvas, which is what leaves the range band hand-picked as before.
   */
  _cpTargetDistance(target) {
    if (!target) return null;

    const from = this.actor.getActiveTokens()[0];
    const to = canvas.tokens?.get(target.id);
    if (!from || !to) return null;

    return canvas.grid.measurePath([from.center, to.center]).distance;
  }

  /**
   * @param {CyberpunkItem} item
   * @param {object} [options]
   * @param {Document} [options.flagHolder] Where the last-used options are remembered. Defaults to
   *   the weapon; the unarmed attack passes the **actor**, because its weapon is a temporary
   *   document that is in no collection and whose `update` therefore reaches no database.
   */
  _cpOpenWeaponAttackDialog(item, { flagHolder = item } = {}) {
    if (!item) return;

    if (this.#attacksInFlight.has(item.id)) {
      ui.notifications.warn(localize("AttackInFlight"));
      return;
    }

    const isRanged = item.isRanged();
    const system = item._getWeaponSystem?.() ?? item.system ?? {};
    const savedAttackOptions = isRanged
      ? this._cpGetSavedRangedAttackOptions(flagHolder)
      : this._cpGetSavedMeleeAttackOptions(flagHolder);

    let modifierGroups;
    const targetTokens = Array.from(game.users.current.targets.values()).map(target => ({
      name: target.document.name,
      id: target.id,
      tokenUuid: target.document.uuid,
      actorUuid: target.actor?.uuid ?? ""
    }));

    // Setting a charge is a Demolitions check and nothing else — no range band, no fire mode, no
    // aim, because RAW rolls nothing to place one (`07:914`). The dialog adds its own free
    // modifier, so an empty group list is the whole prompt.
    if (item.isPlanted?.() && isCombatAutomationEnabled()) {
      modifierGroups = [];
    }
    else if (isRanged) {
      modifierGroups = rangedModifiers(item, targetTokens, savedAttackOptions, this._cpTargetDistance(targetTokens[0]));
    }
    else if (system.attackType === meleeAttackTypes.martial) {
      modifierGroups = martialOptions(this.actor, savedAttackOptions);
    }
    else {
      modifierGroups = meleeBonkOptions(savedAttackOptions);
    }

    // Read-only, so the player sees what the economy is charging and the value still submits with
    // the rest of the form.
    const actionPenalty = actionPenaltyFor(this.actor);
    if (actionPenalty !== null) {
      modifierGroups = [...modifierGroups, [{
        localKey: "ActionPenalty",
        dataPath: "actionPenalty",
        defaultValue: actionPenalty,
        readOnly: true
      }]];
    }

    const dialog = new ModifiersDialog({
      weapon: item,
      targetTokens,
      modifierGroups,
      onConfirm: async (fireOptions) => {
        if (isRanged) {
          await this._cpSaveRangedAttackOptions(flagHolder, fireOptions);
        } else {
          await this._cpSaveMeleeAttackOptions(flagHolder, fireOptions);
        }

        // Charged after the attack resolves, not before it: a contested melee blocks on the
        // defender for up to 30 s, and a second dialog opened in that window used to charge a
        // second action. The guard is what stops the second dialog. The charge carries the turn it
        // was declared in, because that wait can outlive the attacker's own next turn start, which
        // is where the counter is cleared (`T67`).
        this.#attacksInFlight.add(item.id);
        const declaredIn = currentTurnKey();
        let attack;
        try {
          attack = await item.__weaponRoll(fireOptions, targetTokens);
        } finally {
          this.#attacksInFlight.delete(item.id);
        }

        // Every branch returns what it produced, and the three that produce nothing say so: a
        // refusal returns `false` (no ammunition, a disabled cyberweapon) and a dismissed area
        // placement returns `null` with no round spent and no card posted. Neither is an action,
        // and charging for one costs the shooter -3 on an attack that never happened (`T80`).
        if (attack) await chargeAction(this.actor, declaredIn);
        return attack;
      }
    });

    dialog.render(true);
  }

  _cpActivateNetrunningControls(root) {
    if (!root?.addEventListener) return;
    if (root.dataset.cpNetrunningControlsBound === "1") return;

    const isEditable = this.isEditable;
    if (!isEditable) return;

    root.dataset.cpNetrunningControlsBound = "1";

    root.addEventListener("click", async (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const interfaceSkill = target.closest(".interface-skill-roll");
      if (interfaceSkill) {
        event.preventDefault();
        event.stopPropagation();

        if (refusedWhilePaused()) return;

        const skillId = interfaceSkill.dataset.skillId;
        if (!skillId) {
          ui.notifications.warn(localize("InterfaceSkillNotFound"));
          return;
        }

        this.actor.rollSkill(skillId);
        return;
      }

      const programEdit = target.closest(".netrun-program .fa-edit");
      if (programEdit) {
        event.preventDefault();
        event.stopPropagation();

        const program = programEdit.closest(".netrun-program");
        const item = this._cpGetItemFromTarget(program);
        if (item) item.sheet.render(true);
        return;
      }

      const programDelete = target.closest(".netrun-program .fa-trash");
      if (programDelete) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        const program = programDelete.closest(".netrun-program");
        const item = this._cpGetItemFromTarget(program);
        if (item) await this._cpConfirmDeleteItem(item);
      }
    });

    root.addEventListener("contextmenu", async (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const activeIcon = target.closest(".netrun-active-icon");
      if (!activeIcon) return;

      event.preventDefault();
      event.stopPropagation();

      const itemId = activeIcon.dataset.itemId;
      if (!itemId) return;

      const currentActive = [...(this.actor.system.activePrograms || [])];
      const idx = currentActive.indexOf(itemId);
      if (idx < 0) return;

      currentActive.splice(idx, 1);

      let sumMU = 0;
      for (const progId of currentActive) {
        const progItem = this.actor.items.get(progId);
        if (!progItem) continue;
        sumMU += Number(progItem.system.mu) || 0;
      }

      await this.actor.update({
        "system.activePrograms": currentActive,
        "system.ramUsed": sumMU
      });

      ui.notifications.info(localize("ProgramDeactivated"));
    });
  }

  /**
   * Preview the whole span a click would change, not just the box under the pointer. Delegated on
   * root rather than bound to the tracker, because a render replaces every box.
   */
  _cpActivateWoundTracker(root) {
    if (!root?.addEventListener) return;
    if (!this.isEditable) return;

    if (root.dataset.cpWoundTrackerBound === "1") return;
    root.dataset.cpWoundTrackerBound = "1";

    const paint = (hovered) => {
      const tracker = root.querySelector(".wound-tracker");
      if (!tracker) return;

      const boxes = [...tracker.querySelectorAll(".damage")];
      // data-damage is the value the click would store, so the span it bounds is the span that
      // would change — including the off-by-one on the last filled box, which deselects itself.
      const to = hovered ? Number(hovered.dataset.damage) : 0;
      const from = Number(this.actor.system.damage) || 0;
      const low = Math.min(from, to);
      const high = Math.max(from, to);

      boxes.forEach((box, index) => {
        const woundNo = index + 1;
        box.classList.toggle("wound-hover", !!hovered && woundNo > low && woundNo <= high);
      });
    };

    root.addEventListener("mouseover", (event) => {
      const target = event.target;
      if (!target?.closest?.(".wound-tracker")) return paint(null);

      paint(target.closest(".damage"));
    });

    root.addEventListener("mouseleave", () => paint(null));
  }

  _cpActivateActorFormControls(root) {
    if (!root?.addEventListener) return;

    const isEditable = this.isEditable;
    if (!isEditable) return;

    // A render replaces the part's contents while root survives, so every skill row is a new
    // element and the filter has to be re-applied here, above the guard. The block below it must
    // not be: nothing that re-renders the sheet originates in the search box, so restoring focus
    // there would take it from the control the user is actually editing. A close and reopen is the
    // other way to reach a fresh bind, and there the sheet instance survives — which is what makes
    // the block below reachable at all (F.3.6).
    this._cpApplySkillFilterToDOM(root, this._cpSkillFilter ?? "");

    if (root.dataset.cpActorFormControlsBound === "1") return;
    root.dataset.cpActorFormControlsBound = "1";

    const skillSearch = root.querySelector("input.skill-search");

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

      this._restoreSkillCaret = target.selectionStart ?? value.length;
      this._cpSkillFilter = value;

      this._cpApplySkillFilterToDOM(root, value);
    });

    root.addEventListener("change", async (event) => {
      const target = event.target;
      if (!target?.matches) return;

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

    if (root.dataset.cpCyberwareControlsBound === "1") return;

    const isEditable = this.isEditable;
    if (!isEditable) return;

    root.dataset.cpCyberwareControlsBound = "1";

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

      if (target?.matches?.(".cyber-effect-active")) {
        event.stopPropagation();

        const item = this.actor.items.get(target.dataset.itemId);
        if (item) await item.update({ "system.EffectActive": !!target.checked });
        return;
      }

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

    this._cpRenderOpenItemApplications(chips);
    this._cpRenderOpenItemApplications(skill);
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

        this._cpRenderOpenItemApplications(chips);
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

    this._cpRenderOpenItemApplications(skill);
  }

  _cpActivateActorDragDrop(root) {
    if (!root?.addEventListener) return;

    this._cpPrepareActorDragSources(root);

    if (root.dataset.cpActorDragDropBound === "1") return;
    root.dataset.cpActorDragDropBound = "1";

    root.addEventListener("dragstart", (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const dragSource = target.closest("[data-item-id][draggable='true']");
      if (!dragSource) return;

      if (target.closest(".item-delete, .item-unequip, .item-controls, button, input, select, textarea")) {
        event.preventDefault();
        return;
      }

      const item = this._cpGetItemFromTarget(dragSource);
      if (!item) return;

      dragSource.classList.add("is-dragging");
      this._cpWriteOwnedItemDragData(event, item);
    });

    root.addEventListener("dragend", (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const dragSource = target.closest(".is-dragging");
      if (dragSource) dragSource.classList.remove("is-dragging");
    });

    root.addEventListener("dragover", (event) => {
      const target = event.target;
      if (!target?.closest?.("[data-drop-target]")) return;

      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });

    root.addEventListener("drop", async (event) => {
      const target = event.target;
      const dropTarget = target?.closest?.("[data-drop-target]");
      if (!dropTarget) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      if (this._cpDropHandling) return;

      const data = this._cpGetDragDropData(event);
      if (!data) return;

      this._cpDropHandling = true;
      try {
        await this._onDropItem(event, data);
      } finally {
        this._cpDropHandling = false;
      }
    }, true);
  }

  _cpPrepareActorDragSources(root) {
    const selector = [
      ".field[data-item-id]",
      ".item[data-item-id]",
      ".skill[data-item-id]",
      ".gear[data-item-id]",
      ".fire-weapon[data-item-id]",
      ".netrun-program[data-item-id]",
      ".chipware[data-item-id]",
      ".netrun-active-icon[data-item-id]"
    ].join(",");

    root.querySelectorAll(selector).forEach((node) => {
      if (node.closest?.(".item-delete, .item-unequip, .item-controls")) return;

      node.setAttribute("draggable", "true");
      node.dataset.cpDragSource = "1";
    });
  }

  _cpGetDragDropData(event) {
    const transfer = event.dataTransfer;
    if (!transfer) return null;

    const raw =
      transfer.getData("text/plain")
      || transfer.getData("application/json");

    if (!raw) return null;

    try {
      return JSON.parse(raw);
    } catch (err) {
      console.warn("Cyberpunk2020 | Failed to parse drag/drop data.", err, raw);
      return null;
    }
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
    if (typeof itemOrData?.toObject === "function") return withCompendiumSource(itemOrData);
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

    this._cpRenderOpenItemApplications(item);
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

        await this.render({ force: true });
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

      this._cpRenderOpenItemApplications(item);
      await this.render({ force: true });
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

      this._cpRenderOpenItemApplications(item);
      await this.render({ force: true });
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

        this._cpRenderOpenItemApplications(item);
        await this.render({ force: true });
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
      return this.render({ force: true });
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

      this._cpRenderOpenItemApplications(
        updatedIds.map(sid => actor.items.get(sid)).filter(Boolean)
      );
    }
  }

  _cp_forceRefreshOpenSkillSheets(updatedMap) {
    // updatedMap: { [skillId]: { isChipped?: boolean, chipLevel?: number } }
    if (!updatedMap) return;

    for (const [sid, patch] of Object.entries(updatedMap)) {
      const skill = this.actor.items.get(sid);
      if (!skill) continue;

      for (const sheet of this._cpGetOpenItemApplications(skill)) {
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

      this._cpRenderOpenItemApplications(
        updatedIds.map(sid => actor.items.get(sid)).filter(Boolean)
      );
    }
  }

  _cpActivateNotesEditor(root) {
    this._cpSetupNotesActions(root);
    this._cpSetupNotesAutosave(root);
  }

  async _cpExitNotesEditing(root, { render = false } = {}) {
    if (!this._cpNotesEditing) return;

    await this._cpFlushNotesAutosave(root, { force: true, serialize: false });
    this._cpNotesEditing = false;

    if (render && this.rendered) {
      await this.render({ force: true });
    }
  }

  _cpSetupNotesActions(root) {
    if (!root?.addEventListener) return;

    if (this._cpNotesActionsRoot && this._cpNotesActionsHandler) {
      try {
        this._cpNotesActionsRoot.removeEventListener("click", this._cpNotesActionsHandler, true);
      } catch (_) {}
    }

    const handler = async (event) => {
      const target = event.target;
      if (!target?.closest) return;

      const editButton = target.closest('[data-action="notes-edit"]');
      if (!editButton) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      this._cpNotesEditing = true;
      await this.render({ force: true });
    };

    root.addEventListener("click", handler, true);

    this._cpNotesActionsRoot = root;
    this._cpNotesActionsHandler = handler;
  }
  
  _cpSetupNotesAutosave(root) {
    if (!root?.addEventListener) return;

    const editable = this.isEditable;
    if (!editable) return;

    if (!this._cpNotesAutosaveState) {
      this._cpNotesAutosaveState = {
        saving: false,
        pending: false,
        pendingForce: false,
        pendingSerialize: false,
        timer: null,
        lastSaved: String(this.actor.system?.notes ?? "")
      };
    }

    if (this._cpNotesAutosaveRoot && this._cpNotesAutosaveHandler) {
      for (const eventName of ["save", "input", "change", "close"]) {
        try {
          this._cpNotesAutosaveRoot.removeEventListener(eventName, this._cpNotesAutosaveHandler, true);
        } catch (_) {}
      }
    }

    const isNotesEvent = (event) => {
      const target = event?.target;
      if (!target?.closest) return false;

      const editor = target.closest(".cp-notes-editor");
      if (!editor) return false;

      const lifeTab = target.closest('.tab.life[data-tab="life"]') ?? target.closest(".tab.life");
      return !!lifeTab;
    };

    const scheduleFlush = ({ force = false, serialize = false, delay = 250 } = {}) => {
      const state = this._cpNotesAutosaveState;
      if (!state) return;

      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }

      state.timer = setTimeout(() => {
        state.timer = null;
        this._cpFlushNotesAutosave(root, { force, serialize });
      }, delay);
    };

    const handler = (event) => {
      if (!isNotesEvent(event)) return;

      if (event.type === "save" || event.type === "close") {
        window.setTimeout(async () => {
          await this._cpFlushNotesAutosave(root, { force: true, serialize: false });

          if (this._cpNotesEditing) {
            this._cpNotesEditing = false;
            await this.render({ force: true });
          }
        }, 0);

        return;
      }

      scheduleFlush({ force: false, serialize: false, delay: 350 });
    };

    for (const eventName of ["save", "input", "change", "close"]) {
      root.addEventListener(eventName, handler, true);
    }

    this._cpNotesAutosaveRoot = root;
    this._cpNotesAutosaveHandler = handler;
  }

  _cpReadNotesHTML(root, { serialize = false } = {}) {
    if (!root) return null;

    const reader = serialize ? saveRichEditorHTML : getRichEditorHTML;
    const html = reader(this, root, "system.notes", [".cp-notes-view"]);

    if (html != null) return html;

    return String(this.actor.system?.notes ?? "");
  }

  async _cpFlushNotesAutosave(root, { force = false, serialize = false } = {}) {
    const st = this._cpNotesAutosaveState;
    if (!st) return;

    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }

    if (st.saving) {
      st.pending = true;
      st.pendingForce = st.pendingForce || force;
      st.pendingSerialize = st.pendingSerialize || serialize;
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
        const pendingForce = st.pendingForce;
        const pendingSerialize = st.pendingSerialize;

        st.pending = false;
        st.pendingForce = false;
        st.pendingSerialize = false;

        await this._cpFlushNotesAutosave(root, {
          force: pendingForce,
          serialize: pendingSerialize
        });
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

      if (this._cpNotesAutosaveState?.timer) {
        clearTimeout(this._cpNotesAutosaveState.timer);
        this._cpNotesAutosaveState.timer = null;
      }

      await this._cpFlushNotesAutosave(root, { force: true, serialize: false });
      this._cpNotesEditing = false;
    } catch (_) {}

    try {
      if (this._cpNotesAutosaveRoot && this._cpNotesAutosaveHandler) {
        for (const eventName of ["save", "input", "change", "close"]) {
          this._cpNotesAutosaveRoot.removeEventListener(eventName, this._cpNotesAutosaveHandler, true);
        }
      }

      this._cpNotesAutosaveRoot = null;
      this._cpNotesAutosaveHandler = null;
    } catch (_) {}

    try {
      if (this._cpNotesActionsRoot && this._cpNotesActionsHandler) {
        this._cpNotesActionsRoot.removeEventListener("click", this._cpNotesActionsHandler, true);
      }

      this._cpNotesActionsRoot = null;
      this._cpNotesActionsHandler = null;
    } catch (_) {}

    return super._preClose(options);
  }

}
