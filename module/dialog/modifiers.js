import { deepSet, localize } from "../utils.js"
import { defaultTargetLocations, fireModes } from "../lookups.js"

/**
 * A specialized form used to select the modifiers for shooting with a weapon
 * This could, I guess, also be done with dialog and FormDataExtended
 * @implements {FormApplication}
 */
 export class ModifiersDialog extends FormApplication {

    /** @override */
      static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
        id: "weapon-modifier",
        classes: ["cyberpunk2020"],
        title: localize("AttackModifiers"),
        template: "systems/cyberpunk2020/templates/dialog/modifiers.hbs",
        width: 500,
        height: "auto",
        weapon: null,
        // Use like [[mod1, mod2], [mod3, mod4, mod5]] etc to add groupings,
        modifierGroups: [],
        targetTokens: [], // id and name for each target token
        // Extra mod field for miscellaneous mod
        extraMod: true,
        showAdvDis: false,
        advantage: false,
        disadvantage: false,
        closeOnSubmit: false,

        onConfirm: (results) => console.log(results)
      });
    }
  
    /* -------------------------------------------- */
  
    /**
     * Return a reference to the target attribute
     * @type {String}
     */
    get attribute() {
        return this.options.name;
    }
  
    /* -------------------------------------------- */
  
    /** @override */
    getData() {
      // Woo! This should be much more flexible than the previous implementation
      // My gods did it require thinking about the shape of things, because loosely-typed can be a headache

      const groups = JSON.parse(JSON.stringify(this.options.modifierGroups || []));

      if (this.options.extraMod) {
        const already = groups.some(g =>
          g.some(m => m.dataPath === "extraMod"));
        if (!already) {
          groups.push([{
            localKey: "ExtraModifiers",
            dataPath: "extraMod",
            defaultValue: 0
          }]);
        }
      }

      const defaultValues = {};
      groups.forEach(group => {
        group.forEach(mod => {
          // path towards modifier's field template
          mod.fieldPath = `fields/${mod.choices ? "select" : typeof mod.defaultValue}`;
          deepSet(defaultValues, mod.dataPath,
            mod.defaultValue !== undefined ? mod.defaultValue : "");
        });
      });

      return {
        modifierGroups: groups,
        targetTokens: this.options.targetTokens,
        // You can't refer to indices in FormApplication form entries as far as I know, so let's give them a place to live
        defaultValues,
        isRanged: this.options.weapon?.isRanged?.() ?? false,
        shotsLeft: this.options.weapon?.system.shotsLeft ?? 0,
        showAdvDis: this.options.showAdvDis,
        advantage: this.options.advantage,
        disadvantage: this.options.disadvantage
      };
    }

    /** @override */
    activateListeners(html) {
      super.activateListeners(html);

      // RELOAD
      html.find(".reload").on("click", async (ev) => {
        ev.preventDefault();
        const weapon = this.options.weapon;
        if (!weapon) return;

        await weapon.update({ "system.shotsLeft": weapon.system.shots });
        ui.notifications.info(localize("Reloaded"));

        const shots = weapon.system.shots;
        this.options.weapon.system.shotsLeft = shots;

        html.find('input.number[readonly]').val(shots);
      });

      // Advantage/Disadvantage
      html.find('input.adv, input.dis').on("change", ev => {
        const $el = $(ev.currentTarget);
        if ($el.hasClass("adv") && $el.prop("checked")) html.find("input.dis").prop("checked", false);
        if ($el.hasClass("dis") && $el.prop("checked")) html.find("input.adv").prop("checked", false);
      });

      // Suppressive Fire fields
      // fire mode select
      const $fireMode = html.find(
        'select[name="fields.fireMode"], select[name="fireMode"], .field[data-path="fireMode"] select'
      );

      // collect strings used exclusively for suppression
      const $supRows = $([
        '.field[data-path="zoneWidth"]',
        '.field[data-path="roundsFired"]',
        '.field[data-path="targetsCount"]',
        'input[name="fields.zoneWidth"], input[name="zoneWidth"]',
        'input[name="fields.roundsFired"], input[name="roundsFired"]',
        'input[name="fields.targetsCount"], input[name="targetsCount"]'
      ].join(','), html)
        .map((i, el) => $(el).closest('.field, .form-group')[0])
        .get()
        .reduce((jq, el) => jq.add(el), $());

      const updateVisibility = () => {
        const isSup = $fireMode.val() === fireModes.suppressive;
        $supRows.toggle(isSup);
      };

      updateVisibility();
      $fireMode.on('change', updateVisibility);
    }
  
    /** @override */
    async _updateObject(event, formData) {
      this.object = formData;
      const fired = await this.options.onConfirm(this.object);
      if (fired !== false) this.close();
    }
 }