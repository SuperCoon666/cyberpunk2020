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

    // Register v13/v14 System DataModels
    // These replace legacy system-template initialization for Actor/Item system data
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

    // Register sheets, unregister original core sheets
    Actors.unregisterSheet("core", ActorSheet);
    Actors.registerSheet("cyberpunk2020", CyberpunkActorSheet, { makeDefault: true });
    Items.unregisterSheet("core", ItemSheet);
    Items.registerSheet("cyberpunk2020", CyberpunkItemSheet, { makeDefault: true });

    // Register System Settings
    registerSystemSettings();

    registerHandlebarsHelpers();

    // Register and preload templates with Foundry. See templates.js for usage
    preloadHandlebarsTemplates();

    // Fumble inline results
    Hooks.on("renderChatMessage", (message, html) => {
      const root = html?.[0] ?? html;
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
});

/**
 * Once the entire VTT framework is initialized, check to see if we should perform a data migration (nabbed from Foundry's 5e module and adapted)
 */
Hooks.once("ready", async function () {
  // Determine whether a system migration is required and feasible
  if (!game.user.isGM) return;

  const TARGET_VERSION = game.system.version;

  const stored = game.settings.get("cyberpunk2020", "systemMigrationVersion") || "";

  const worldSystemVersion = game.world?.systemVersion || "";

  // If we never stored migration version, use worldSystemVersion as baseline (prevents migration on fresh worlds)
  const baseline = stored || worldSystemVersion || "0";

  console.log(
    `CYBERPUNK: World systemVersion=${worldSystemVersion || "(none)"}; stored migration=${stored || "(none)"}; baseline=${baseline}`
  );

  const needsMigration = foundry.utils.isNewerVersion(TARGET_VERSION, baseline);

  if (!needsMigration) {
    if (!stored) {
      await game.settings.set("cyberpunk2020", "systemMigrationVersion", TARGET_VERSION);
      console.log(`CYBERPUNK: Migration marker initialized to ${TARGET_VERSION}`);
    }
    return;
  }

  // Run migration once per system version upgrade
  await migrations.migrateWorld(TARGET_VERSION);
});
