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

      let data = {
        modifierGroups: this.options.modifierGroups,
        targetTokens: this.options.targetTokens,
        // You can't refer to indices in FormApplication form entries as far as I know, so let's give them a place to live
        defaultValues: {}
      };
      if(this.options.extraMod) {
        data.modifierGroups.push([{
          localKey: "ExtraModifiers",
          dataPath: "extraMod",
          defaultValue: 0
        }]);
      }

      data.modifierGroups.forEach(group => {
        group.forEach(modifier => {
          // path towards modifier's field template
          let fieldPath = `fields/${modifier.choices 
            ? "select" : typeof(modifier.defaultValue)}`;
 
          modifier.fieldPath = fieldPath;
          deepSet(data.defaultValues, modifier.dataPath, (modifier.defaultValue !== undefined ? modifier.defaultValue : ""));
        })
      })

      return data;
    }
  
    /* -------------------------------------------- */
  
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