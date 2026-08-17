const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * D159 — an NPC sheet stands for a whole mob, so its initiative button asks which of the actor's
 * placed tokens join the encounter: one combatant and one initiative roll per pick. A token already
 * fighting is listed and cannot be picked again, so a second click never duplicates it.
 * @extends {foundry.applications.api.ApplicationV2}
 */
export class InitiativeTokensDialog extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    // {id} is what ApplicationV2 substitutes per instance; a literal id makes every dialog share one
    // DOM node, so a second render replaces the first instead of opening beside it.
    id: "initiative-tokens-{id}",
    classes: ["cyberpunk2020", "initiative-tokens"],
    tag: "form",
    position: {
      width: 420,
      height: "auto"
    },
    window: {
      title: "CYBERPUNK.InitiativeTokensTitle"
    },
    form: {
      handler: InitiativeTokensDialog.#onSubmit,
      closeOnSubmit: true
    },
    // [{id, name, inCombat}] — every placed token, in the scene's own order.
    rows: [],
    onConfirm: () => {}
  };

  /** @override */
  static PARTS = {
    form: {
      template: "systems/cyberpunk2020/templates/dialog/initiative-tokens.hbs"
    }
  };

  /** @override */
  async _prepareContext(options) {
    return { rows: this.options.rows };
  }

  /**
   * Render the picker and answer with the token ids the GM chose — an empty list when he closes it
   * without submitting, because declining to send anyone in is an answer and the caller must not be
   * left waiting on a window that is gone.
   *
   * @param {Array<{id: string, name: string, inCombat: boolean}>} rows
   * @returns {Promise<string[]>}
   */
  static async pick(rows) {
    return new Promise(resolve => {
      let answered = false;
      const dialog = new InitiativeTokensDialog({
        rows,
        onConfirm: ids => {
          answered = true;
          resolve(ids);
        }
      });
      dialog.addEventListener("close", () => {
        if (!answered) resolve([]);
      });
      dialog.render({ force: true });
    });
  }

  /**
   * @this {InitiativeTokensDialog}
   * @param {SubmitEvent} event
   * @param {HTMLFormElement} form
   */
  static async #onSubmit(event, form) {
    // Read off the form rather than the submitted data: every row's checkbox carries the same
    // meaning and its token id is an attribute, so there is no field name to expand.
    const picked = [...form.querySelectorAll("input.cp-initiative-token:checked")]
      .map(input => input.dataset.tokenId);
    await this.options.onConfirm(picked);
  }
}
