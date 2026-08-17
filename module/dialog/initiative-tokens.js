const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * D159 — an NPC sheet stands for a whole mob, so its initiative button asks which of the actor's
 * placed tokens roll initiative: one combatant and one roll per pick.
 *
 * D166 — every placed token is listed and every row is pickable, because a token already fighting
 * has an answer of its own: it **re-rolls**. What the window opens with is the clicked token's
 * cohort — the ones not fighting when the GM is sending a gang in, the ones fighting when he is
 * re-rolling — and D160's all-ticked is that rule's nobody-fighting case. D162 — twins can be
 * visually identical, so the ticked tokens are highlighted on the canvas while the window is open.
 * @extends {foundry.applications.api.ApplicationV2}
 */
export class InitiativeTokensDialog extends HandlebarsApplicationMixin(ApplicationV2) {

  /**
   * Ids of the tokens this window has lit. Recorded rather than re-read at teardown: `_onClose` runs
   * **after** the element is removed (`client/applications/api/application.mjs:1032` against
   * `:1046`, 14.365.0), so the checkboxes are gone by the time the glow has to be put out.
   * @type {Set<string>}
   */
  #lit = new Set();

  /**
   * The `hoverToken` registration that keeps `#lit` lit. Held so the teardown can drop it **before**
   * putting the glows out — the hook fires from inside `_onHoverOut` itself, so a still-registered
   * handler would light every token straight back up.
   * @type {number|null}
   */
  #hoverHook = null;

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
    // [{id, name, inCombat, checked}] — every placed token, in the scene's own order.
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

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);

    // `Token#hover` is one boolean with no refcount, and the real pointer drives it through the
    // same two methods this dialog does: `_onHoverIn` opens `if ( this.hover ) return` and
    // `_onHoverOut` opens `if ( !this.hover ) return`
    // (`client/canvas/placeables/placeable-object.mjs:1161` and `:1190`, 14.365.0). So a pointer
    // crossing a token this window has lit is a no-op on the way in and puts the glow out on the
    // way back off, leaving the box ticked and the map dark (`T332`). The window is not modal and
    // looking at the map is the GM's next move, so the light is re-asserted rather than owned: core
    // calls this hook at the end of both methods, which is also what makes a second picker over the
    // same token re-light it when the first one closes.
    this.#hoverHook = Hooks.on("hoverToken", (token, hovered) => {
      if (hovered || !this.#lit.has(token.id)) return;
      this.#highlight(token.id, true);
    });
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);

    for (const input of this.element.querySelectorAll("input.cp-initiative-token")) {
      input.addEventListener("change", () => this.#highlight(input.dataset.tokenId, input.checked));
      if (input.checked) this.#highlight(input.dataset.tokenId, true);
    }
  }

  /** @override */
  _onClose(options) {
    // Dropped first: the re-assert above runs from inside `_onHoverOut`, so a live registration
    // would re-light every token this loop is putting out.
    if (this.#hoverHook !== null) Hooks.off("hoverToken", this.#hoverHook);
    this.#hoverHook = null;

    for (const id of [...this.#lit]) this.#highlight(id, false);
  }

  /**
   * D162 — light one token on the canvas, or put it out. The placeable exists only while the
   * encounter's scene is the viewed one, and a highlight nobody can see is nothing to report.
   *
   * @param {string} tokenId
   * @param {boolean} on
   */
  #highlight(tokenId, on) {
    const token = canvas.tokens?.get(tokenId);
    if (!token) return;

    if (on) {
      // `hoverOutOthers` is the whole point of naming it: the tracker passes `true` because it hovers
      // one row at a time (`combat-tracker.mjs:561`, 14.365.0), and a picker's whole gang must glow
      // together. A synthetic event is core's own way of driving this (`canvas/layers/notes.mjs:131`).
      this.#lit.add(tokenId);
      token._onHoverIn(new Event("pointerover"), { hoverOutOthers: false });
    }
    else {
      // The set is updated **before** the call, never after: `_onHoverOut` fires `hoverToken`
      // synchronously (`placeable-object.mjs:1198`, 14.365.0) and the re-assert would read an id
      // that is still lit as far as this window is concerned.
      this.#lit.delete(tokenId);
      token._onHoverOut(new Event("pointerout"));
    }
  }

  /**
   * Render the picker and answer with the token ids the GM chose — an empty list when he closes it
   * without submitting, because declining to send anyone in is an answer and the caller must not be
   * left waiting on a window that is gone.
   *
   * @param {Array<{id: string, name: string, inCombat: boolean, checked: boolean}>} rows
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
