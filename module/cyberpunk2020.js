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
import { ATTACK_FLAG_VERSION, DOT_FLAG, SAVE_PROMPT_DEADLINE_MS, applyAttackFromMessage, rollSaveOf } from "./damage.js";
import { CyberpunkCombat, announceTurn, applyDeclaredDodge, clearSuppressionZones, clearTurnFlags, DEFENSE_PROMPT_DEADLINE_MS } from "./combat.js";
import { allOutEffectKeys, isCombatAutomationEnabled, isFnff2Enabled } from "./lookups.js";
import { CyberpunkTokenRuler, vetoOverspentMovement } from "./movement.js";
import { applyBlastFromMessage, drawZone, layZoneFromMessage, SuppressiveFireBehavior, zoneRegions } from "./zones.js";
import { CyberpunkRegionLayer, CyberpunkZoneRegion } from "./zone-hud.js";
import { displayName, localize, localizeParam, localizeParamEscaped } from "./utils.js";

/**
 * Wound levels the token shows, indexed by woundState(). Mortal covers every state above it, so
 * this is read with a clamp rather than a lookup.
 */
const WOUND_STATUSES = ["cpWoundLight", "cpWoundSerious", "cpWoundCritical", "cpWoundMortal"];

/**
 * One in-flight wound sync per actor. Two damage updates in quick succession otherwise overlap:
 * both invocations read the same ActiveEffect and both delete it, and the loser throws
 * `ActiveEffect "…" does not exist!` — measured against six consecutive writes.
 */
const woundSyncs = new Map();

/**
 * The statuses this system derives rather than lets anyone toggle: the wound level behind
 * `system.damage`, and the burn behind the `dot` flag `tickDot` maintains (`T413`).
 *
 * Each is written only where it disagrees, because the GM-arrival sweep (`T410`) runs this over
 * every actor in the world and a blanket toggle would be four writes a head.
 */
async function syncDerivedStatuses(actor) {
  const state = actor.woundState();
  const wound = state > 0 ? WOUND_STATUSES[Math.min(state, WOUND_STATUSES.length) - 1] : null;
  for (const id of WOUND_STATUSES) {
    const active = id === wound;
    if (actor.statuses.has(id) !== active) await actor.toggleStatusEffect(id, { active });
  }

  // Death ends the burn (D218), and every death this system writes clears the flag — which is also
  // what triggers this. A `dead` a GM toggled by hand does not, so the corpse is read here too,
  // or the arrival sweep would paint a burning icon onto one.
  const burning = !!actor.getFlag("cyberpunk2020", DOT_FLAG) && !actor.statuses.has("dead");
  if (actor.statuses.has("cpBurning") !== burning) {
    await actor.toggleStatusEffect("cpBurning", { active: burning });
  }
}

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
    // No Combatant subclass: the only thing that would live there is the party-initiative formula,
    // and the shared die has to be awaited, which _getInitiativeFormula cannot do.
    CONFIG.Combat.documentClass = CyberpunkCombat;
    CONFIG.Token.rulerClass = CyberpunkTokenRuler;
    // D219 — the zone's controls belong on the zone. Core gives Regions no HUD, so both halves are
    // needed: the placeable decides a right-click reaches one, the layer is where core looks for it.
    CONFIG.Region.objectClass = CyberpunkZoneRegion;
    CONFIG.Canvas.layers.regions.layerClass = CyberpunkRegionLayer;

    // Walking is MA metres a turn and running three times that, so running has to be a movement
    // action the player can pick — the budget follows the choice. terrainAction: "walk" because
    // difficult ground costs a runner what it costs a walker.
    CONFIG.Token.movement.actions.run = {
      label: "CYBERPUNK.MoveRun",
      icon: "fa-solid fa-person-running",
      img: "icons/svg/wingfoot.svg",
      order: 0.5,
      speedMultiplier: 3,
      terrainAction: "walk"
    };

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

    // The subtype is only usable if `system.json` declares it too: valid subtypes are assembled by
    // the server from the manifest's documentTypes, and registering the model alone is not enough.
    CONFIG.RegionBehavior.dataModels.suppressiveFire = SuppressiveFireBehavior;

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

    // Wound levels and being out of action are token icons. Assigning by id appends to the core
    // list; hud: false on the wound levels because they are derived from system.damage and a hand
    // toggle would be undone by the next hit.
    CONFIG.statusEffects.cpWoundLight = {
      id: "cpWoundLight", name: "CYBERPUNK.StatusWoundLight", img: "icons/svg/blood.svg", hud: false
    };
    CONFIG.statusEffects.cpWoundSerious = {
      id: "cpWoundSerious", name: "CYBERPUNK.StatusWoundSerious", img: "icons/svg/degen.svg", hud: false
    };
    CONFIG.statusEffects.cpWoundCritical = {
      id: "cpWoundCritical", name: "CYBERPUNK.StatusWoundCritical", img: "icons/svg/hazard.svg", hud: false
    };
    CONFIG.statusEffects.cpWoundMortal = {
      id: "cpWoundMortal", name: "CYBERPUNK.StatusWoundMortal", img: "icons/svg/bones.svg", hud: false
    };
    CONFIG.statusEffects.cpStunned = {
      id: "cpStunned", name: "CYBERPUNK.StatusStunned", img: "icons/svg/daze.svg"
    };
    // `T413` — hud: false for the same reason the wound levels carry it: the burn is derived from
    // the `dot` flag, and a hand toggle would be undone by the next tick.
    CONFIG.statusEffects.cpBurning = {
      id: "cpBurning", name: "CYBERPUNK.StatusBurning", img: "icons/svg/fire.svg", hud: false
    };

    // The owner of a player character rolls their own save when the world asks for it. The reply
    // has to beat the sender's timeout, so the dialog is closed here rather than waited on forever.
    CONFIG.queries["cyberpunk2020.savePrompt"] = async ({ actorUuid, tokenUuid, kind, dc, messageMode, cause }) => {
      const actor = await fromUuid(actorUuid);
      if (!actor) throw new Error(`No actor for save prompt: ${actorUuid}`);

      // A token this client cannot resolve leaves the name where it was, on the actor's own
      // fallbacks — a save is never refused over a label (`T296`).
      const token = tokenUuid ? await fromUuid(tokenUuid) : null;

      const titles = { death: "CYBERPUNK.SaveDeath", zone: "CYBERPUNK.SaveZone" };

      // `T411` — the applying client already knew all of this and the prompt said none of it, while
      // the card that arrives *after* the player has rolled prints the threshold and the direction
      // both. Recomputed here rather than sent, because the threshold a Stun or Death save derives
      // is the actor's own and this client holds the actor; `dc` is an override for the rules that
      // name one (the severance save, the electroshock ladder, a zone's own number), which is the
      // same test `rollSaveOf` makes before it rolls.
      const zone = kind === "zone";
      const threshold = zone || Number.isFinite(dc)
        ? dc
        : (kind === "death" ? actor.deathThreshold() : actor.stunThreshold());
      const thresholdLabel = localize(
        zone ? "SaveZoneThreshold" : (kind === "death" ? "SaveDeathThreshold" : "SaveStunThreshold"));
      // A zone save reads **over** its number and a Stun or Death save reads under (`T360`), which
      // is the one fact a player cannot infer — the same two sentences D186 put on the card.
      const direction = localize(zone ? "OverThresholdMessage" : "UnderThresholdMessage");

      let dialog = null;
      let deadlineTimer = null;
      let expired = false;
      const deadline = new Promise(resolve => deadlineTimer = setTimeout(() => {
        expired = true;
        dialog?.close();
        resolve(null);
      }, SAVE_PROMPT_DEADLINE_MS));

      const answer = await Promise.race([
        foundry.applications.api.DialogV2.input({
          window: { title: titles[kind] ?? "CYBERPUNK.SaveStun" },
          // The cause key rides in over the socket and a key core cannot find is echoed back
          // verbatim, so the one string here that is not this client's own is escaped.
          content: `<p>${localizeParamEscaped("SavePrompt", { name: displayName(actor, token) })}</p>
            ${cause ? `<p>${foundry.utils.escapeHTML(localize(cause))}</p>` : ""}
            <p>${localizeParamEscaped("SavePromptThreshold",
              { label: thresholdLabel, threshold, direction })}</p>
            <p>${localizeParamEscaped("SaveDeadline",
              { seconds: Math.round(SAVE_PROMPT_DEADLINE_MS / 1000) })}</p>
            <input type="number" name="mod" value="0" step="1" autofocus>`,
          ok: { label: "CYBERPUNK.SaveRollButton" },
          render: (event, app) => { dialog = app; }
        }),
        deadline
      ]);
      clearTimeout(deadlineTimer);

      // The card is posted under this player's own name whether or not they answered, so the one
      // person who can tell the difference is told (`T411`).
      if (expired) ui.notifications.warn(localize("SaveExpired"));

      const mod = Number(answer?.mod) || 0;
      return rollSaveOf(actor, kind, dc, mod, messageMode, token);
    };

    // A dodge declared against an attack resolved on somebody else's client. The attacker owns
    // nothing on an NPC defender, so the write is handed to the single writer everywhere else here.
    CONFIG.queries["cyberpunk2020.declareDodge"] = payload => applyDeclaredDodge(payload);

    // A stabilization rolled by a medic who does not own the patient — a player treating another
    // player's character owns nothing on it.
    CONFIG.queries["cyberpunk2020.applyStabilized"] = payload => CyberpunkActor.applyStabilized(payload);

    // D222 — the shooter's own turn has come round and the fire zone is asking to be paid for. The
    // ammunition is spent here rather than by the asking GM: it is this client's weapon, and the
    // reload the prompt offers when the magazine is dry writes this client's inventory. No
    // deadline, by the owner's ruling — nothing is spent without a direct answer, and dismissing
    // the window is one of the answers.
    CONFIG.queries["cyberpunk2020.suppressionPrompt"] = async ({ actorUuid, tokenUuid, itemId, zoneName, rounds, width, offerExtraAction }) => {
      const actor = await fromUuid(actorUuid);
      if (!actor) throw new Error(`No actor for suppression prompt: ${actorUuid}`);

      // Named rather than "you", for savePrompt's reason: a player may own more than one character.
      const token = tokenUuid ? await fromUuid(tokenUuid) : null;

      // The weapon that laid the zone has been dropped, sold or deleted since. There is nothing
      // left to keep firing with, so the zone comes down rather than being held for free.
      const item = actor.items.get(itemId);
      if (!item) {
        ui.notifications.warn(localize("SuppressionWeaponGone"));
        return { continue: false };
      }

      const shotsOf = () => Math.max(0, Math.floor(Number(item._getWeaponSystem()?.shotsLeft) || 0));
      const empty = shotsOf() <= 0;
      const spendNow = Math.min(rounds, shotsOf());
      const name = displayName(actor, token);

      const content = empty
        ? `<p>${localizeParamEscaped("SuppressionPromptEmpty", { name, zone: zoneName })}</p>
           ${offerExtraAction
              ? `<label><input type="checkbox" name="extraAction"> ${localize("SuppressionExtraAction")}</label>`
              : ""}`
        : `<p>${localizeParamEscaped("SuppressionPromptAsk", { name, zone: zoneName })}</p>
           <p>${localizeParamEscaped("SuppressionPromptCost",
                { rounds: spendNow, save: Math.floor(spendNow / width), left: shotsOf() })}</p>`;

      // The checkbox lives on the reload prompt only, and the reload is the one that can be a
      // second action: continuing to fire is the turn's action either way.
      const go = empty
        ? { action: "reload", label: "CYBERPUNK.SuppressionReloadButton", default: true,
            callback: (event, button) => ({ extraAction: !!button.form?.elements?.extraAction?.checked }) }
        : { action: "continue", label: "CYBERPUNK.SuppressionContinueButton", default: true,
            callback: () => ({ extraAction: false }) };

      const answer = await foundry.applications.api.DialogV2.wait({
        window: { title: "CYBERPUNK.SuppressionPromptTitle" },
        content,
        buttons: [go, { action: "stop", label: "CYBERPUNK.SuppressionStopButton" }],
        rejectClose: false
      });

      // "stop" carries no callback, so it arrives as its own action string; a dismissed window
      // arrives as null. Both mean the same thing and neither spends a round.
      if (!answer || answer === "stop") return { continue: false };

      // A reload that could not happen — no rounds in the inventory, no magazine to fill — has
      // already told the player why, and leaves the shooter with nothing to fire.
      if (empty && !(await item.reloadFromInventory()).loaded) return { continue: false };

      const spend = Math.min(rounds, shotsOf());
      if (spend <= 0) return { continue: false };

      await item.__setWeaponField("shotsLeft", shotsOf() - spend);
      return { continue: true, spent: spend, extraAction: !!answer.extraAction };
    };

    // The defender picks the skill; the attacker's client rolls it, so this returns a choice and
    // never a result. Null means "decide for me" — the timeout path answers that way too.
    CONFIG.queries["cyberpunk2020.defensePrompt"] = async ({ attackerName, itemName, defenderActorUuid, defenderTokenUuid, attackTotal, choices }) => {
      // Named, not "you": a player may own more than one character, and only the uuid says which
      // of them is being attacked.
      const defender = await fromUuid(defenderActorUuid);
      if (!defender) throw new Error(`No actor for defense prompt: ${defenderActorUuid}`);

      // Which of that actor's tokens is under attack — this client has no other way to know, and a
      // linked actor would otherwise be named off its prototype (`T296`).
      const defenderToken = defenderTokenUuid ? await fromUuid(defenderTokenUuid) : null;

      let dialog = null;
      let deadlineTimer = null;
      const deadline = new Promise(resolve => deadlineTimer = setTimeout(() => {
        dialog?.close();
        resolve(null);
      }, DEFENSE_PROMPT_DEADLINE_MS));

      // Every value here is user-authored data arriving from another client — item and actor names
      // included — so all of it is escaped before it is interpolated into markup.
      const esc = foundry.utils.escapeHTML;
      const options = choices.map(c =>
        `<option value="${esc(c.skillId)}">${esc(c.label)} (${Number(c.total) || 0})</option>`
      ).join("");

      // The second level (`T232`, D58): the maneuvers the chosen skill offers, each with the art's
      // own bonus shown — +0 where the style has no key attack there, because `07:1004` makes key
      // attacks a bonus list and not a permission list. A skill the book gives no maneuvers to
      // (`07:982` — anything but Brawling and the arts) renders no row at all.
      // D163 — the All-Out pair carries no bonus in either table and never will (its effect is not a
      // number added to this roll), so the row states what it does instead of printing a `+0` that
      // reads as "strictly worse than the Dodge above it".
      const maneuverOptions = skillId => {
        const rows = choices.find(c => c.skillId === skillId)?.actions ?? [];
        return rows.map(row => {
          const bonus = Number(row.bonus) || 0;
          const effect = allOutEffectKeys[row.action];
          const label = effect
            ? `${localize(row.action)} (${localize(effect)})`
            : `${localize(row.action)} (${bonus >= 0 ? "+" : ""}${bonus})`;
          return `<option value="${esc(row.action)}">${esc(label)}</option>`;
        }).join("");
      };

      // An empty attacker name is the ambusher case, not missing data: `resolveDefense` blanks it
      // and the item name together, and the reduced line keeps the total (D29.5).
      const asked = attackerName
        ? localizeParam("DefensePrompt", {
            attacker: esc(attackerName), defender: esc(displayName(defender, defenderToken)),
            item: esc(itemName), total: Number(attackTotal) || 0
          })
        : localizeParam("DefensePromptHidden", {
            defender: esc(displayName(defender, defenderToken)), total: Number(attackTotal) || 0
          });

      // D148 — the All-Out pair the maneuver list offers under FNFF2 trades the defender's own next
      // attack for the defence, and nothing in the contest models that: the prompt says so and
      // enforces nothing, which is the table's call to make.
      const trade = isFnff2Enabled()
        ? `<p class="notes cp-defense-trade">${localize("DefenseAllOutTrade")}</p>`
        : "";

      const answer = await Promise.race([
        foundry.applications.api.DialogV2.input({
          window: { title: "CYBERPUNK.Defense" },
          content: `<p>${asked}</p>
            <label>${localize("DefenseSkill")} <select name="skillId">${options}</select></label>
            <label class="cp-defense-action">${localize("DefenseAction")} <select name="action">${maneuverOptions(choices[0]?.skillId)}</select></label>
            ${trade}
            <label>${localize("DefenseMod")} <input type="number" name="extraMod" value="0" step="1"></label>`,
          ok: { label: "CYBERPUNK.DefenseRollButton" },
          render: (event, app) => {
            dialog = app;
            // The maneuvers belong to the chosen skill, so the second level is rebuilt on every
            // change of the first — and the row hides itself for a skill that has none.
            const root = app.element;
            const skill = root.querySelector('select[name="skillId"]');
            const action = root.querySelector('select[name="action"]');
            const row = root.querySelector(".cp-defense-action");
            // The trade sentence names the two maneuvers, so it lives and dies with the row that
            // offers them: the four skills `07:982` gives no maneuver list to left it on screen
            // describing a choice that was no longer there (`T336`). Absent entirely with FNFF2
            // off, which is the only reason for the guard.
            const tradeLine = root.querySelector(".cp-defense-trade");
            const sync = () => {
              action.innerHTML = maneuverOptions(skill.value);
              const offered = action.options.length > 0;
              row.style.display = offered ? "" : "none";
              if (tradeLine) tradeLine.style.display = offered ? "" : "none";
            };
            sync();
            skill.addEventListener("change", sync);
          }
        }),
        deadline
      ]);
      clearTimeout(deadlineTimer);

      // `action` is absent for a skill with no maneuvers, and `resolveDefense` falls back to the
      // option's own total there — the same answer the timeout path gives.
      return answer
        ? { skillId: answer.skillId, action: answer.action ?? null, extraMod: Number(answer.extraMod) || 0 }
        : null;
    };

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
            document.removeEventListener("mouseover", onPointerElsewhere, true);
            tip.remove();
            tip = null;
          }
        };

        // A chat re-render replaces the anchor under a stationary cursor with no `mouseleave` to
        // follow, which leaves an open tooltip with no owner to remove it. A pointer landing
        // outside the anchor is the signal core's own TooltipManager reads for this
        // (`client/helpers/interaction/tooltip-manager.mjs:142`, 14.365.0).
        const onPointerElsewhere = (ev) => {
          if (!el.contains(ev.target)) hideTip();
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
          document.addEventListener("mouseover", onPointerElsewhere, true);

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
      if (!game.user.isGM || !isCombatAutomationEnabled() || attack?.version !== ATTACK_FLAG_VERSION) {
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

    // The zone's own button. Separate from the one above because it has no target to name: who is
    // caught is decided when it is clicked, not when the card was written.
    Hooks.on("renderChatMessageHTML", (message, html) => {
      const root = getHtmlElement(html);
      const button = root?.querySelector?.('button[data-action="applyZone"]');
      if (!button || button.dataset.cpApplyBound === "1") return;
      button.dataset.cpApplyBound = "1";

      const attack = message.flags?.cyberpunk2020?.attack;
      if (!game.user.isGM || !isCombatAutomationEnabled() || attack?.version !== ATTACK_FLAG_VERSION) {
        button.remove();
        return;
      }

      if (attack.applied?.zone) {
        button.disabled = true;
        button.textContent = game.i18n.localize("CYBERPUNK.ZoneApplied");
        return;
      }

      button.addEventListener("click", () => applyBlastFromMessage(message));
    });

    // `T125` — the fire zone is laid by the active GM's hook above, and with none connected the
    // rounds were spent for a zone that never existed and never could. The offer stays on the card:
    // the first GM to see it lays what the burst described. Whether it is laid already is read off
    // the Region **and** off the card's own record: the Region is what catches a create still in
    // flight on another client, and the record is what tells *not yet* from *no longer* once the
    // encounter's sweep has taken it (`T307`).
    Hooks.on("renderChatMessageHTML", (message, html) => {
      const root = getHtmlElement(html);
      const button = root?.querySelector?.('button[data-action="layZone"]');
      if (!button || button.dataset.cpLayBound === "1") return;
      button.dataset.cpLayBound = "1";

      const attack = message.flags?.cyberpunk2020?.attack;
      const known = attack?.version === ATTACK_FLAG_VERSION;
      // `T421` — the template prints its sentence off `placed`, which is the geometry the shooter
      // previewed and not the Region the active GM's hook creates. With no GM connected nothing was
      // laid, and the player who fired is the one client the offer below is removed for: they read
      // that the zone is on the map, saw no button, and were right about neither. Decided here
      // because it is a per-client answer, off the same two records the button reads, and ahead of
      // the GM gate because the player is who it is wrong for.
      const laidAlready = known && (attack.applied?.laid || zoneRegions(message).length > 0);
      const state = root.querySelector(".cp-zone-state");
      if (state && known && !laidAlready) state.textContent = localize("ZoneWaitingForGM");

      if (!game.user.isGM || !isCombatAutomationEnabled() || !known) {
        button.remove();
        return;
      }

      const laid = () => {
        button.disabled = true;
        button.textContent = localize("ZoneLaid");
      };
      if (laidAlready) return laid();

      button.addEventListener("click", async () => {
        await layZoneFromMessage(message);
        laid();
      });
    });

    // `T305` — the same offer `T125` gave the fire zone, one line apart in the same hook branch:
    // a splash resolved with no GM connected (or with automation off at the moment of firing) posts
    // a card describing a crater nobody painted. The drawn state is read off the Region rather than
    // recorded on the card, which is also what makes the click idempotent against the active GM's
    // own hook finishing between this render and it.
    Hooks.on("renderChatMessageHTML", (message, html) => {
      const root = getHtmlElement(html);
      const button = root?.querySelector?.('button[data-action="drawZone"]');
      if (!button || button.dataset.cpDrawBound === "1") return;
      button.dataset.cpDrawBound = "1";

      const attack = message.flags?.cyberpunk2020?.attack;
      if (!game.user.isGM || !isCombatAutomationEnabled()
        || attack?.version !== ATTACK_FLAG_VERSION || !attack.blast) {
        button.remove();
        return;
      }

      const drawn = () => {
        button.disabled = true;
        button.textContent = localize("ZoneDrawn");
      };
      if (zoneRegions(message).length) return drawn();

      button.addEventListener("click", async () => {
        if (!zoneRegions(message).length) await drawZone(attack.blast, attack.kind, message.id);
        drawn();
      });
    });

    // Wound icons follow system.damage wherever it comes from, which is what makes a hand click on
    // the wound tracker behave like an applied attack. One writer, as everywhere else here.
    // The burn rides the same path off its own flag (`T413`): `setFlag`/`unsetFlag` are actor
    // updates, so arming and exhausting a fire both arrive here. An unset reaches the diff as the
    // `-=` removal key rather than as the field itself.
    Hooks.on("updateActor", (actor, changes) => {
      if (!game.user.isActiveGM) return;
      const flags = changes.flags?.cyberpunk2020 ?? {};
      if (!("damage" in (changes.system ?? {}))
        && !(DOT_FLAG in flags) && !(`-=${DOT_FLAG}` in flags)) return;

      const queued = (woundSyncs.get(actor.id) ?? Promise.resolve())
        .then(() => syncDerivedStatuses(actor))
        .finally(() => { if (woundSyncs.get(actor.id) === queued) woundSyncs.delete(actor.id); });
      woundSyncs.set(actor.id, queued);
    });

    Hooks.on("combatTurnChange", announceTurn);
    Hooks.on("preMoveToken", vetoOverspentMovement);
    Hooks.on("deleteCombat", clearSuppressionZones);

    // The action counter and a declared dodge are cleared by their owner's own turn start and by
    // nothing else, so an encounter that ends mid-round carries them into the next one.
    Hooks.on("deleteCombat", combat => clearTurnFlags(combat.combatants));
    Hooks.on("deleteCombatant", combatant => clearTurnFlags([combatant]));

    // Auto mode: the active GM's client is the single writer, the way core drives Combat turn
    // events. With no GM connected nothing applies and the button above is still the way in.
    Hooks.on("createChatMessage", async (message) => {
      if (!game.user.isActiveGM) return;
      // Covers auto-apply and zone creation at one site.
      if (!isCombatAutomationEnabled()) return;

      const attack = message.flags?.cyberpunk2020?.attack;
      if (attack?.version !== ATTACK_FLAG_VERSION) return;

      // A fire zone is a scene document, not damage: the apply mode decides who applies damage and
      // not whether the zone the shooter just placed exists, so this runs ahead of the setting.
      if (attack.kind === "suppression") {
        await layZoneFromMessage(message);
        return;
      }

      // Same argument for the splash the card describes, and the same place: drawing it is what
      // lets the table see what will be hit before it is (D74), so it happens whoever applies.
      if (attack.blast) await drawZone(attack.blast, attack.kind, message.id);

      if (game.settings.get("cyberpunk2020", "damageApplyMode") !== "auto") return;

      // The payload and not the kind, exactly as the drawing branch above already asks: a kind list
      // went stale the moment `T252` added a third zone kind, and a flamethrower sweep then fell
      // through to the loop below, which `__zoneFlags` leaves empty for every zone card — so under
      // the mode this family exists for the stream was placed, carded and drawn and nobody in it
      // took a point (`T302`). `applyBlastFromMessage` gates on the same field.
      if (attack.blast) {
        await applyBlastFromMessage(message);
        return;
      }

      for (const target of attack.targets ?? []) {
        await applyAttackFromMessage(message, { tokenId: target.tokenId });
      }
    });
});

/**
 * Check whether this world needs a system data migration.
 */
/**
 * `T410` — the derived statuses are written by the active GM's `updateActor` hook, so a wound track
 * a player edits with no GM connected is never seen: the icon keeps the old level until the next
 * damage write a GM is present for, and the GM's own arrival does not repair it.
 *
 * The arrival is the repair. Only actors whose statuses disagree are written, so a world where
 * nothing drifted costs nothing. Scene tokens carrying an unlinked actor are outside this sweep —
 * a no-GM edit is a player editing a character they own, which is a world actor.
 */
Hooks.once("ready", async function () {
  if (!game.user.isActiveGM) return;
  for (const actor of game.actors) await syncDerivedStatuses(actor);
});

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
