import { CyberpunkActor } from "./actor/actor.js";
import { CyberpunkActorSheet } from "./actor/actor-sheet.js";
import { CyberpunkItem } from "./item/item.js";
import { CyberpunkItemSheet } from "./item/item-sheet.js";
import { CyberpunkCharacterData, CyberpunkNpcData } from "./data/actor-data.js";
import {
    CyberpunkAmmoData,
    CyberpunkArmorData,
    CyberpunkCyberwareData,
    CyberpunkMiscData,
    CyberpunkProgramData,
    CyberpunkSkillData,
    CyberpunkVehicleData,
    CyberpunkWeaponData
} from "./data/item-data.js";

import { preloadHandlebarsTemplates } from "./templates.js";
import { registerHandlebarsHelpers } from "./handlebars-helpers.js"
import * as migrations from "./migrate.js";
import { registerSystemSettings } from "./settings.js"
import { getHtmlElement } from "./compat.js";
import { ATTACK_FLAG_VERSION, applyAttackFromMessage } from "./damage.js";

const { Actors, Items } = foundry.documents.collections;

Hooks.once('init', async function () {

    // Place classes in system namespace for later reference.
    game.cyberpunk = {
        entities: {
            CyberpunkActor,
            CyberpunkItem,
        },
        // A manual migrateworld.
        migrateWorld: migrations.migrateWorld
    };

    // Define custom Document classes
    CONFIG.Actor.documentClass = CyberpunkActor;
    CONFIG.Item.documentClass = CyberpunkItem;

    // Register v13/v14 System DataModels.
    // These replace legacy system-template initialization for Actor/Item system data.
    CONFIG.Actor.dataModels.character = CyberpunkCharacterData;
    CONFIG.Actor.dataModels.npc = CyberpunkNpcData;

    CONFIG.Item.dataModels.skill = CyberpunkSkillData;
    CONFIG.Item.dataModels.program = CyberpunkProgramData;
    CONFIG.Item.dataModels.weapon = CyberpunkWeaponData;
    CONFIG.Item.dataModels.ammo = CyberpunkAmmoData;
    CONFIG.Item.dataModels.armor = CyberpunkArmorData;
    CONFIG.Item.dataModels.cyberware = CyberpunkCyberwareData;
    CONFIG.Item.dataModels.vehicle = CyberpunkVehicleData;
    CONFIG.Item.dataModels.misc = CyberpunkMiscData;

    // v14 registers no core sheet for Actor or Item, so there is nothing to unregister.
    // themes: null — the sheets are a fixed dark palette; core substitutes {dark, light}
    // and enables the picker when the option is omitted.
    Actors.registerSheet("cyberpunk2020", CyberpunkActorSheet, {
      label: "CYBERPUNK.SheetLabels.Actor",
      themes: null,
      makeDefault: true
    });
    Items.registerSheet("cyberpunk2020", CyberpunkItemSheet, {
      label: "CYBERPUNK.SheetLabels.Item",
      themes: null,
      makeDefault: true
    });

    // Register System Settings
    registerSystemSettings();

    registerHandlebarsHelpers();

    // Register and preload templates with Foundry. See templates.js for usage
    preloadHandlebarsTemplates();

    // A cyberware sheet shows slot counts and parent lists derived from its sibling
    // items, so it goes stale when one of them changes. The sheets can only refresh
    // themselves and each other on the client that made the edit, which leaves out
    // changes coming from the actor sheet, a macro, or another client.
    //
    // The changed item's own sheet is skipped on purpose: Foundry re-renders it, and
    // handlers that pass render:false are suppressing that deliberately.
    Hooks.on("updateItem", (item, changes) => {
      if (item.type !== "cyberware" || !item.actor) return;

      const system = changes.system;
      if (!system) return;

      const affectsSlots = ["equipped", "MountZone", "cyberwareType", "CyberBodyType", "Module"]
        .some(key => key in system) || ("OptionsAvailable" in (system.CyberWorkType ?? {}));
      if (!affectsSlots) return;

      for (const sibling of item.actor.items) {
        if (sibling.type !== "cyberware" || sibling.id === item.id) continue;
        if (sibling.sheet?.rendered) sibling.sheet.render({ force: true });
      }
    });

    // Fumble inline results
    Hooks.on("renderChatMessageHTML", (message, html) => {
      const root = getHtmlElement(html);
      if (!root?.querySelectorAll) return;

      for (const el of root.querySelectorAll("a.cp-inline-roll")) {
        // avoid double-binding on re-renders
        if (el.dataset.cpInlineBound === "1") continue;
        el.dataset.cpInlineBound = "1";

        // Disable click (no reroll)
        el.addEventListener(
          "click",
          (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            ev.stopImmediatePropagation();
          },
          { capture: true }
        );

        let tip = null;

        const hideTip = () => {
          if (tip) {
            tip.remove();
            tip = null;
          }
        };

        const positionTip = () => {
          if (!tip) return;

          const r = el.getBoundingClientRect();
          const tr = tip.getBoundingClientRect();

          // default: above the number
          let top = r.top - tr.height - 8;
          // if not enough space above: place below
          if (top < 4) top = r.bottom + 8;

          let left = r.left + (r.width / 2) - (tr.width / 2);
          left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));

          tip.style.top = `${top}px`;
          tip.style.left = `${left}px`;
        };

        const showTip = async () => {
          hideTip();

          const raw = el.dataset.roll;
          if (!raw) return;

          let roll;
          try {
            roll = Roll.fromJSON(decodeURIComponent(raw));
          } catch (e) {
            return;
          }

          let tooltipHTML = "";
          try {
            tooltipHTML = await roll.getTooltip();
          } catch (e) {
            return;
          }

          if (!tooltipHTML) return;

          tip = document.createElement("div");
          tip.className = "cp-dice-tooltip";
          tip.innerHTML = tooltipHTML;

          const showInlineRollFormula = game.settings.get(
            "cyberpunk2020",
            "showInlineRollFormula"
          );

          if (showInlineRollFormula) {
            const summary = document.createElement("div");
            summary.className = "cp-inline-roll-summary";

            const formula = String(roll.formula ?? "").trim();
            const result = String(roll.result ?? "").trim();
            const totalValue = Number(roll.total);
            const total = Number.isFinite(totalValue) ? String(roll.total) : "";

            const formulaLine = document.createElement("div");
            formulaLine.className = "cp-inline-roll-formula";
            formulaLine.textContent = formula;

            const resultLine = document.createElement("div");
            resultLine.className = "cp-inline-roll-result";
            resultLine.textContent = result && total
              ? `${result} = ${total}`
              : result || total;

            if (formulaLine.textContent) summary.appendChild(formulaLine);
            if (resultLine.textContent && resultLine.textContent !== formulaLine.textContent) {
              summary.appendChild(resultLine);
            }

            if (summary.childElementCount > 0) {
              tip.prepend(summary);
            }
          }

          document.body.appendChild(tip);

          requestAnimationFrame(() => {
            positionTip();
          });
        };

        el.addEventListener("mouseenter", () => { void showTip(); });
        el.addEventListener("mouseleave", hideTip);
        el.addEventListener("mousemove", positionTip);
      }
    });

    // The apply button is decided per client rather than baked into the card: only a GM sees it,
    // and a card whose damage has already landed keeps it disabled instead of applying twice.
    Hooks.on("renderChatMessageHTML", (message, html) => {
      const root = getHtmlElement(html);
      const button = root?.querySelector?.('button[data-action="applyDamage"]');
      if (!button || button.dataset.cpApplyBound === "1") return;
      button.dataset.cpApplyBound = "1";

      const attack = message.flags?.cyberpunk2020?.attack;
      if (!game.user.isGM || attack?.version !== ATTACK_FLAG_VERSION) {
        button.remove();
        return;
      }

      const tokenId = button.dataset.tokenId;
      if (attack.applied?.[tokenId]) {
        button.disabled = true;
        button.textContent = game.i18n.localize("CYBERPUNK.DamageApplied");
        return;
      }

      button.addEventListener("click", () => applyAttackFromMessage(message, { tokenId }));
    });

    // Auto mode: the active GM's client is the single writer, the way core drives Combat turn
    // events. With no GM connected nothing applies and the button above is still the way in.
    Hooks.on("createChatMessage", async (message) => {
      if (!game.user.isActiveGM) return;
      if (game.settings.get("cyberpunk2020", "damageApplyMode") !== "auto") return;

      const attack = message.flags?.cyberpunk2020?.attack;
      if (attack?.version !== ATTACK_FLAG_VERSION) return;

      for (const target of attack.targets ?? []) {
        await applyAttackFromMessage(message, { tokenId: target.tokenId });
      }
    });
});

/**
 * Check whether this world needs a system data migration.
 */
Hooks.once("ready", async function () {
  if (!game.user.isGM) return;

  const TARGET_VERSION = game.system.version;

  const stored = game.settings.get("cyberpunk2020", "systemMigrationVersion") || "";

  const worldSystemVersion = game.world?.systemVersion || "";

  // Use worldSystemVersion as a baseline for worlds that predate the explicit migration marker.
  const baseline = stored || worldSystemVersion || "0";

  const needsMigration = foundry.utils.isNewerVersion(TARGET_VERSION, baseline);

  if (!needsMigration) {
    if (!stored) {
      await game.settings.set("cyberpunk2020", "systemMigrationVersion", TARGET_VERSION);
    }
    return;
  }

  await migrations.migrateWorld(TARGET_VERSION);
});
