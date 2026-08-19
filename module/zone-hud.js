import { localize, localizeParamEscaped } from "./utils.js";
import { deleteZone, toggleZoneVisibility, ZONE_FLAG } from "./zones.js";

/**
 * D219 — the zone's own controls, where a GM looking at one on the map can reach them.
 *
 * The hide toggle used to be a button on the chat card, which put it out of reach of anyone
 * scrolled past the shot, and deletion had no affordance at all. Core gives Regions no HUD on
 * purpose — `_canHUD` returns false with the comment *"Regions don't have a HUD"*
 * (`client/canvas/placeables/region.mjs:624`, 14.365.0) — so the surface is opened for the Regions
 * this system laid and for nobody else's: another module's regions and the GM's own keep core's
 * behaviour exactly.
 */
export class CyberpunkZoneHUD extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.hud.BasePlaceableHUD) {

  /** @override */
  static DEFAULT_OPTIONS = {
    id: "cyberpunk-zone-hud",
    actions: {
      visibility: CyberpunkZoneHUD.#onToggleVisibility,
      deleteZone: CyberpunkZoneHUD.#onDeleteZone
    }
  };

  /** @override */
  static PARTS = {
    hud: {
      root: true,
      template: "systems/cyberpunk2020/templates/hud/zone-hud.hbs"
    }
  };

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    // The label is the state the button moves the zone *to*, which is the opposite of the icon.
    context.visibilityKey = context.hidden ? "ShowZone" : "HideZone";
    return context;
  }

  /**
   * Core's own handler writes `layer.controlled`; a zone hides as the unit it was laid as, which is
   * D122's semantics and what the card's button did before D219 moved it here.
   */
  static async #onToggleVisibility() {
    await toggleZoneVisibility(this.document);
    await this.render();
  }

  static async #onDeleteZone() {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: localize("DeleteZoneConfirmTitle") },
      content: `<p>${localizeParamEscaped("DeleteZoneConfirmText", { name: this.document.name })}</p>`,
      modal: true,
      rejectClose: false
    });
    if (!confirmed) return;

    await deleteZone(this.document);
    await this.close();
  }
}

/**
 * A Region that carries this system's zone flag answers a right-click with the zone HUD. Everything
 * else about a Region is core's, including every other module's regions and the GM's own.
 */
export class CyberpunkZoneRegion extends foundry.canvas.placeables.Region {

  /** @override */
  _canHUD(user) {
    return user.isGM && !!this.document.getFlag("cyberpunk2020", ZONE_FLAG);
  }
}

/**
 * The Region layer with a HUD on it. Core routes a right-click through `layer.hud`
 * (`client/canvas/placeables/placeable-object.mjs:1281`, 14.365.0) and closes that same reference
 * when the layer deactivates, when the selection is released and when an object is destroyed — five
 * sites — so providing the getter is what keeps the HUD's lifecycle core's problem rather than ours.
 */
export class CyberpunkRegionLayer extends foundry.canvas.layers.RegionLayer {

  #hud = new CyberpunkZoneHUD();

  /** @override */
  get hud() {
    return this.#hud;
  }
}
