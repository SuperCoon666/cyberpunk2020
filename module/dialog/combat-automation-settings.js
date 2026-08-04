import { getHtmlElement } from "../compat.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * The optional rules that only function while the master switch is on, in the order the form shows
 * them. Each is also ANDed with the master where it is read, so a stored `true` does nothing on its
 * own — this list is the subsection's contents, not the gate.
 */
const AUTOMATION_SUB_SETTINGS = [
  "damageApplyMode", "pcSaveMode", "armorAblation", "severanceThreshold",
  "actionEconomy", "dodgeVsRanged"
];

/**
 * The combat-automation subsection: the master switch and the optional rules that only function
 * while it is on.
 *
 * A registered menu is the only subsection Foundry v14 offers — `SettingsConfig` builds its
 * categories from the namespace alone (`_categorizeEntry`,
 * `client/applications/settings/config.mjs:145`, 14.365.0), so every `cyberpunk2020` setting lands
 * in one flat block whatever it is called.
 *
 * @extends {foundry.applications.api.ApplicationV2}
 */
export class CombatAutomationSettings extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    // {id} is what ApplicationV2 substitutes per instance; a literal id makes every
    // dialog share one DOM node, so a second render replaces the first.
    id: "combat-automation-{id}",
    classes: ["cyberpunk2020", "combat-automation"],
    tag: "form",
    position: {
      width: 560,
      height: "auto"
    },
    window: {
      title: "SETTINGS.CombatAutomationMenu",
      contentClasses: ["standard-form"]
    },
    form: {
      handler: CombatAutomationSettings.#onSubmit,
      closeOnSubmit: true
    }
  };

  /** @override */
  static PARTS = {
    form: {
      template: "systems/cyberpunk2020/templates/dialog/combat-automation.hbs"
    }
  };

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const describe = key => {
      const setting = game.settings.settings.get(`cyberpunk2020.${key}`);
      return {
        key,
        name: setting.name,
        hint: setting.hint,
        choices: setting.choices ?? null,
        isNumber: setting.type === Number,
        value: game.settings.get("cyberpunk2020", key)
      };
    };

    return {
      master: describe("combatAutomation"),
      rules: AUTOMATION_SUB_SETTINGS.map(describe),
      locked: !game.settings.get("cyberpunk2020", "combatAutomation")
    };
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);

    const root = getHtmlElement(this.element);
    const master = root.querySelector('input[name="combatAutomation"]');
    const rules = root.querySelectorAll(".automation-rules :is(input, select)");

    // D25's "only activatable while the master is on", enforced live rather than at the next
    // render: a GM turning automation on expects to configure it in the same visit. A disabled
    // control is also left out of the submitted data entirely
    // (`client/applications/ux/form-data-extended.mjs:23`), which is what keeps a flip to "off"
    // from rewriting the rules underneath it.
    master.addEventListener("change", () => {
      for (const control of rules) control.disabled = !master.checked;
    });
  }

  /* -------------------------------------------- */

  static async #onSubmit(event, form, formData) {
    const submitted = formData.object;

    for (const key of ["combatAutomation", ...AUTOMATION_SUB_SETTINGS]) {
      if (!(key in submitted)) continue;
      if (game.settings.get("cyberpunk2020", key) === submitted[key]) continue;
      await game.settings.set("cyberpunk2020", key, submitted[key]);
    }
  }
}
