import { deepSet, localize } from "../utils.js"
import { defaultTargetLocations } from "../lookups.js"

/**
 * A specialized form used to select the modifiers for shooting with a weapon
 * This could, I guess, also be done with dialog and FormDataExtended
 * @implements {FormApplication}
 */
 export class ModifiersDialog extends FormApplication {

    /** @override */
      static get defaultOptions() {
        return mergeObject(super.defaultOptions, {
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
        showAdvDis:  false,
        advantage:   false,
        disadvantage:false,

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

      /** 1. Клонируем массив, чтобы не править options.modifierGroups */
      const groups = JSON.parse(JSON.stringify(this.options.modifierGroups || []));

      /** 2. Добавляем Extra Mod только если нужно и ещё нет */
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

      /** 3. Собираем defaultValues и fieldPath */
      const defaultValues = {};
      groups.forEach(group => {
        group.forEach(mod => {
          // path towards modifier's field template
          mod.fieldPath = `fields/${mod.choices ? "select" : typeof mod.defaultValue}`;
          deepSet(defaultValues, mod.dataPath,
            mod.defaultValue !== undefined ? mod.defaultValue : "");
        });
      });

      /** 4. Отдаём данные в шаблон */
      return {
        modifierGroups: groups,
        targetTokens: this.options.targetTokens,
        // You can't refer to indices in FormApplication form entries as far as I know, so let's give them a place to live
        defaultValues,
        isRanged: this.options.weapon?.isRanged?.() ?? false,
        shotsLeft: this.options.weapon?.system.shotsLeft ?? 0,
        showAdvDis:     this.options.showAdvDis,
        advantage:      this.options.advantage,
        disadvantage:   this.options.disadvantage
      };
    }
  
    /* -------------------------------------------- */

    /** @override */
    activateListeners(html) {
      super.activateListeners(html);

      // RELOAD
      html.find(".reload").click(async ev => {
        ev.preventDefault();
        const weapon = this.options.weapon;
        if (!weapon) return;

        // shotsLeft = shots
        await weapon.update({ "system.shotsLeft": weapon.system.shots });
        ui.notifications.info(localize("Reloaded"));

        this.render(false);
      });

      html.find("input.adv-dis").on("change", ev => {
        const el = ev.currentTarget;
        if (el.classList.contains("adv") && el.checked)
          html.find("input.dis").prop("checked", false);
        if (el.classList.contains("dis") && el.checked)
          html.find("input.adv").prop("checked", false);
      });
    }
  
    /** @override */
    _updateObject(event, formData) {
      const updateData = formData;
      // Update the object
      this.object = updateData;
      this.submit().then((form) => {
        // We don't need to use .values
        let result = this.object;
        this.options.onConfirm(result);
      });
    }
 }