import { deepSet, localize, localizeParam } from "../utils.js"
import { fireModes } from "../lookups.js"
import { createCyberpunkChatMessage, getGMUserIds } from "../compat.js";

/**
 * Dialog used to select attack, range, fire-mode and miscellaneous modifiers.
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
        hiddenAdvantage: false,
        closeOnSubmit: false,

        onConfirm: () => {}
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

      if (this.options.weapon) {
        const sys = this.options.weapon._getWeaponSystem ? this.options.weapon._getWeaponSystem() : this.options.weapon.system;
        const rof = Number(sys?.rof) || 0;
        const shotsLeft = Number(sys?.shotsLeft) || 0;
        groups.forEach(group => {
          group.forEach(mod => {
            if (mod.dataPath === "roundsFired" && (mod.defaultValue === undefined || mod.defaultValue === null || mod.defaultValue === "")) {
              mod.defaultValue = rof;
              if (mod.min === undefined) mod.min = 1;
              if (mod.max === undefined) mod.max = shotsLeft;
            }
          });
        });
      }

      if (this.options.extraMod) {
        const already = groups.some(g =>
          g.some(m => m.dataPath === "extraMod"));
        if (!already) {
          const extraGroup = [{
            localKey: "ExtraModifiers",
            dataPath: "extraMod",
            defaultValue: 0
          }];

          const weapon = this.options.weapon;
          const fireModesAvailable = weapon?.__getFireModes?.() ?? [];

          if (fireModesAvailable.includes(fireModes.fullAuto)) {
            const sys = weapon?._getWeaponSystem ? weapon._getWeaponSystem() : weapon?.system;
            const rof = Math.max(0, Math.floor(Number(sys?.rof) || 0));
            const shotsLeft = Math.max(0, Math.floor(Number(sys?.shotsLeft) || 0));
            const maxRounds = Math.min(rof, shotsLeft);

            if (rof > 0) {
              extraGroup.push({
                localKey: "FullAutoRoundsFired",
                dataPath: "fullAutoRoundsFired",
                defaultValue: maxRounds,
                min: 1,
                max: maxRounds,
                step: 1,
                extraClasses: "full-auto-rounds"
              });
            }
          }

          groups.push(extraGroup);
        }
      }

      const defaultValues = {};
      groups.forEach(group => {
        group.forEach(mod => {
          const t = mod.choices ? "select" : (["string","number","boolean"].includes(typeof mod.defaultValue) ? typeof mod.defaultValue : "string");
          mod.fieldPath = `fields/${t}`;
          deepSet(defaultValues, mod.dataPath, mod.defaultValue !== undefined ? mod.defaultValue : "");
        });
      });

      return {
        modifierGroups: groups,
        targetTokens: this.options.targetTokens,
        // You can't refer to indices in FormApplication form entries as far as I know, so let's give them a place to live
        defaultValues,
        isRanged: this.options.weapon?.isRanged?.() ?? false,
        shotsLeft: (this.options.weapon?._getWeaponSystem?.().shotsLeft) ?? (this.options.weapon?.system.shotsLeft) ?? 0,
        showAdvDis: this.options.showAdvDis,
        advantage: this.options.advantage,
        disadvantage: this.options.disadvantage,
        isGM: game.user.isGM
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

      const sys = weapon._getWeaponSystem?.() ?? weapon.system ?? {};
      const capacity = Number(sys.shots ?? 0);
      const currentLeft = Number(sys.shotsLeft ?? 0);

      const updateWeaponShotsLeft = async (value) => {
        if (weapon.__setWeaponField) {
          await weapon.__setWeaponField("shotsLeft", value);
          return;
        }

        if (weapon.type === "cyberware") {
          await weapon.update({ "system.CyberWorkType.Weapon.shotsLeft": value });
        } else {
          await weapon.update({ "system.shotsLeft": value });
        }
      };

      // GM audit: show reload in chat for player-controlled characters (not NPCs)
      const gmReloadAudit = async (shotsLeftAfter) => {
        try {
          const actor = weapon.actor;

          // Only players (non-GM) and only Characters (not NPC)
          if (actor && actor.type !== "npc" && !game.user.isGM) {
            const gmRecipients = getGMUserIds();
            if (!gmRecipients.length) return;

            const shotsText = `${shotsLeftAfter}/${capacity}`;

            await createCyberpunkChatMessage({
              speaker: ChatMessage.getSpeaker({ actor }),
              whisper: gmRecipients,
              content: localizeParam("Chat.Reload", {
                actor: actor.name,
                weapon: weapon.name,
                shots: shotsText
              })
            });
          }
        } catch (err) {
          console.warn("Cyberpunk2020 | reload audit message failed", err);
        }
      };

      const applyLocalState = (shotsLeftAfter) => {
        if (weapon.type === "weapon") {
          this.options.weapon.system.shotsLeft = shotsLeftAfter;
        } else if (weapon.type === "cyberware" && weapon.system?.CyberWorkType?.Weapon) {
          this.options.weapon.system.CyberWorkType.Weapon.shotsLeft = shotsLeftAfter;
        }

        html.find('input.number[readonly]').val(shotsLeftAfter);

        const sysAfter = weapon._getWeaponSystem?.() ?? weapon.system ?? {};
        const rof = Math.max(0, Math.floor(Number(sysAfter?.rof) || 0));
        const maxRounds = Math.min(rof, Math.max(0, Math.floor(Number(shotsLeftAfter) || 0)));

        const fullAutoInput = html.find('input[name="fullAutoRoundsFired"]').get(0);
        if (fullAutoInput) {
          fullAutoInput.dataset.max = String(maxRounds);
          fullAutoInput.value = String(maxRounds);
          fullAutoInput.setCustomValidity("");
        }

        const suppressiveRoundsInput = html.find('input[name="roundsFired"]').get(0);
        if (suppressiveRoundsInput) {
          suppressiveRoundsInput.dataset.max = String(maxRounds);
          suppressiveRoundsInput.value = String(maxRounds);
          suppressiveRoundsInput.setCustomValidity("");
        }
      };

      // If the player has not selected ammunition for the weapon -> reload as before (infinite)
      const ammoItemId = String(sys.ammoItemId ?? "");
      if (!ammoItemId) {
        await updateWeaponShotsLeft(capacity);
        ui.notifications.info(localize("Reloaded"));
        await gmReloadAudit(capacity);
        applyLocalState(capacity);
        return;
      }

      // If cartridges are selected -> we write off the quantity from Ammo
      const actor = weapon.actor;
      const ammoItem = actor?.items?.get(ammoItemId);

      if (!ammoItem || ammoItem.type !== "ammo") {
        ui.notifications.warn(localize("AmmoItemNotFoundReloadedLegacy"));
        await updateWeaponShotsLeft(capacity);
        ui.notifications.info(localize("Reloaded"));
        await gmReloadAudit(capacity);
        applyLocalState(capacity);
        return;
      }

      const ammoQty = Number(ammoItem.system?.quantity ?? 0);

      if (!Number.isFinite(ammoQty) || ammoQty <= 0) {
        ui.notifications.warn(localize("NotEnoughAmmoToReload"));
        return;
      }

      if (!Number.isFinite(capacity) || capacity <= 0) {
        ui.notifications.warn("This weapon cannot be reloaded.");
        return;
      }

      const reloadByMagazines = !!game.settings.get("cyberpunk2020", "reloadByMagazines");

      let ammoToLoad = 0;
      let shotsLeftAfter = currentLeft;

      if (reloadByMagazines) {
        ammoToLoad = Math.min(capacity, ammoQty);
        shotsLeftAfter = Math.min(capacity, ammoToLoad);
      } else {
        const missing = Math.max(0, capacity - currentLeft);
        ammoToLoad = Math.min(missing, ammoQty);
        shotsLeftAfter = Math.min(capacity, currentLeft + ammoToLoad);
      }

      if (ammoToLoad <= 0) {
        ui.notifications.warn(localize("NotEnoughAmmoToReload"));
        return;
      }

      // Rendered on purpose: an open ammo sheet shows this number and the box count derived from
      // it, and {render: false} suppresses the item's own re-render, so the card sat stale until
      // it was closed and reopened.
      await ammoItem.update({ "system.quantity": Math.max(0, ammoQty - ammoToLoad) });

      await updateWeaponShotsLeft(shotsLeftAfter);

      ui.notifications.info(localize("Reloaded"));
      await gmReloadAudit(shotsLeftAfter);
      applyLocalState(shotsLeftAfter);
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
        '.field.suppressive-field',
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

      const $fullAutoRows = $([
        '.field.full-auto-rounds',
        '.field[data-path="fullAutoRoundsFired"]',
        'input[name="fields.fullAutoRoundsFired"]',
        'input[name="fullAutoRoundsFired"]'
      ].join(','), html)
        .map((i, el) => $(el).closest('.field, .form-group')[0])
        .get()
        .reduce((jq, el) => jq.add(el), $());

      const getFullAutoRoundsInput = () => html.find('input[name="fullAutoRoundsFired"]').get(0);

            const getNumberInput = (name) => {
        return html.find(`input[name="${name}"], input[name="fields.${name}"]`).get(0);
      };

      const showFieldValidation = (input, message, { report = false } = {}) => {
        if (!input) return false;

        input.setCustomValidity(message);

        if (report) {
          input.focus();
          input.reportValidity();
        }

        return false;
      };

      const clearFieldValidation = (...inputs) => {
        for (const input of inputs) {
          if (input) input.setCustomValidity("");
        }
      };

      const validateIntegerRangeInput = (input, { min = 1, max = 1, messageKey = "IntegerRangeInvalid", report = false } = {}) => {
        if (!input) return true;

        input.setCustomValidity("");

        const rawValue = String(input.value ?? "").trim();
        const value = Number(rawValue);

        const invalid = rawValue === ""
          || !Number.isFinite(value)
          || !Number.isInteger(value)
          || value < min
          || value > max;

        if (!invalid) return true;

        return showFieldValidation(
          input,
          localizeParam(messageKey, { min, max }),
          { report }
        );
      };

      const validateNumberMinInput = (input, { min = 1, messageKey = "NumberMinInvalid", report = false } = {}) => {
        if (!input) return true;

        input.setCustomValidity("");

        const rawValue = String(input.value ?? "").trim();
        const value = Number(rawValue);

        const invalid = rawValue === ""
          || !Number.isFinite(value)
          || value < min;

        if (!invalid) return true;

        return showFieldValidation(
          input,
          localizeParam(messageKey, { min }),
          { report }
        );
      };

      const validateIntegerMinInput = (input, { min = 1, messageKey = "IntegerMinInvalid", report = false } = {}) => {
        if (!input) return true;

        input.setCustomValidity("");

        const rawValue = String(input.value ?? "").trim();
        const value = Number(rawValue);

        const invalid = rawValue === ""
          || !Number.isFinite(value)
          || !Number.isInteger(value)
          || value < min;

        if (!invalid) return true;

        return showFieldValidation(
          input,
          localizeParam(messageKey, { min }),
          { report }
        );
      };

      const validateSuppressiveInputs = ({ report = false } = {}) => {
        const roundsInput = getNumberInput("roundsFired");
        const zoneWidthInput = getNumberInput("zoneWidth");
        const targetsInput = getNumberInput("targetsCount");

        clearFieldValidation(roundsInput, zoneWidthInput, targetsInput);

        if ($fireMode.val() !== fireModes.suppressive) return true;

        const maxRounds = Math.max(0, Math.floor(Number(roundsInput?.dataset?.max) || 0));

        // No ammunition available. Let the existing weapon roll guard show NoAmmo
        if (maxRounds > 0) {
          const roundsValid = validateIntegerRangeInput(roundsInput, {
            min: 1,
            max: maxRounds,
            messageKey: "IntegerRangeInvalid",
            report
          });

          if (!roundsValid) return false;
        }

        const zoneMin = Math.max(1, Math.floor(Number(zoneWidthInput?.dataset?.min) || 2));

        const zoneValid = validateNumberMinInput(zoneWidthInput, {
          min: zoneMin,
          messageKey: "NumberMinInvalid",
          report
        });

        if (!zoneValid) return false;

        const targetsValid = validateIntegerMinInput(targetsInput, {
          min: 1,
          messageKey: "IntegerMinInvalid",
          report
        });

        if (!targetsValid) return false;

        return true;
      };
      
      const validateFullAutoRoundsInput = ({ report = false } = {}) => {
        const input = getFullAutoRoundsInput();
        if (!input) return true;

        input.setCustomValidity("");

        if ($fireMode.val() !== fireModes.fullAuto) return true;

        const rawValue = String(input.value ?? "").trim();
        const value = Number(rawValue);
        const min = Math.max(1, Math.floor(Number(input.dataset.min) || 1));
        const max = Math.max(0, Math.floor(Number(input.dataset.max) || 0));

        // No ammunition available. Let the existing weapon roll guard show NoAmmo
        if (max <= 0) return true;

        const invalid = rawValue === ""
          || !Number.isFinite(value)
          || !Number.isInteger(value)
          || value < min
          || value > max;

        if (!invalid) return true;

        input.setCustomValidity(localizeParam("FullAutoRoundsInvalid", { min, max }));

        if (report) {
          input.focus();
          input.reportValidity();
        }

        return false;
      };

      const updateVisibility = () => {
        const fireMode = $fireMode.val();
        const isSup = fireMode === fireModes.suppressive;
        const isFullAuto = fireMode === fireModes.fullAuto;

        $supRows.toggle(isSup);
        $fullAutoRows.toggle(isFullAuto);

        const fullAutoInput = getFullAutoRoundsInput();
        if (fullAutoInput && !isFullAuto) fullAutoInput.setCustomValidity("");

        if (!isSup) {
          clearFieldValidation(
            getNumberInput("roundsFired"),
            getNumberInput("zoneWidth"),
            getNumberInput("targetsCount")
          );
        }
      };

      updateVisibility();
      $fireMode.on('change', () => {
        updateVisibility();
        validateFullAutoRoundsInput();
        validateSuppressiveInputs();
      });

      html.find('input[name="fullAutoRoundsFired"]').on('input change', () => {
        validateFullAutoRoundsInput();
      });

      html.find('input[name="roundsFired"], input[name="zoneWidth"], input[name="targetsCount"]').on('input change', () => {
        validateSuppressiveInputs();
      });
    }
  
    /** @override */
    async _updateObject(event, formData) {
      if (this.options.weapon && formData.fireMode === fireModes.fullAuto) {
        const sys = this.options.weapon._getWeaponSystem
          ? this.options.weapon._getWeaponSystem()
          : this.options.weapon.system;

        const rof = Math.max(0, Math.floor(Number(sys?.rof) || 0));
        const shotsLeft = Math.max(0, Math.floor(Number(sys?.shotsLeft) || 0));
        const maxRounds = Math.min(rof, shotsLeft);

        const input = this.element.find('input[name="fullAutoRoundsFired"]').get(0);
        const rawValue = String(input?.value ?? formData.fullAutoRoundsFired ?? "").trim();
        const requestedRounds = Number(rawValue);

        const invalid = maxRounds > 0 && (
          rawValue === ""
          || !Number.isFinite(requestedRounds)
          || !Number.isInteger(requestedRounds)
          || requestedRounds < 1
          || requestedRounds > maxRounds
        );

        if (invalid) {
          if (input) {
            input.setCustomValidity(localizeParam("FullAutoRoundsInvalid", {
              min: 1,
              max: maxRounds
            }));
            input.focus();
            input.reportValidity();
          }

          return false;
        }

        if (input) input.setCustomValidity("");

        if (maxRounds > 0) {
          formData.fullAutoRoundsFired = requestedRounds;
        }
      }

      if (this.options.weapon && formData.fireMode === fireModes.suppressive) {
        const sys = this.options.weapon._getWeaponSystem
          ? this.options.weapon._getWeaponSystem()
          : this.options.weapon.system;

        const rof = Math.max(0, Math.floor(Number(sys?.rof) || 0));
        const shotsLeft = Math.max(0, Math.floor(Number(sys?.shotsLeft) || 0));
        const maxRounds = Math.min(rof, shotsLeft);

        const roundsInput = this.element.find('input[name="roundsFired"], input[name="fields.roundsFired"]').get(0);
        const zoneWidthInput = this.element.find('input[name="zoneWidth"], input[name="fields.zoneWidth"]').get(0);
        const targetsInput = this.element.find('input[name="targetsCount"], input[name="fields.targetsCount"]').get(0);

        const invalidate = (input, message) => {
          if (!input) return false;
          input.setCustomValidity(message);
          input.focus();
          input.reportValidity();
          return false;
        };

        const clear = (input) => {
          if (input) input.setCustomValidity("");
        };

        const roundsRaw = String(roundsInput?.value ?? formData.roundsFired ?? "").trim();
        const rounds = Number(roundsRaw);

        if (maxRounds > 0) {
          const roundsInvalid = roundsRaw === ""
            || !Number.isFinite(rounds)
            || !Number.isInteger(rounds)
            || rounds < 1
            || rounds > maxRounds;

          if (roundsInvalid) {
            return invalidate(
              roundsInput,
              localizeParam("IntegerRangeInvalid", { min: 1, max: maxRounds })
            );
          }

          clear(roundsInput);
          formData.roundsFired = rounds;
        }

        const zoneRaw = String(zoneWidthInput?.value ?? formData.zoneWidth ?? "").trim();
        const zoneWidth = Number(zoneRaw);
        const zoneMin = Math.max(1, Math.floor(Number(zoneWidthInput?.dataset?.min) || 2));

        const zoneInvalid = zoneRaw === ""
          || !Number.isFinite(zoneWidth)
          || zoneWidth < zoneMin;

        if (zoneInvalid) {
          return invalidate(
            zoneWidthInput,
            localizeParam("NumberMinInvalid", { min: zoneMin })
          );
        }

        clear(zoneWidthInput);
        formData.zoneWidth = zoneWidth;

        const targetsRaw = String(targetsInput?.value ?? formData.targetsCount ?? "").trim();
        const targetsCount = Number(targetsRaw);

        const targetsInvalid = targetsRaw === ""
          || !Number.isFinite(targetsCount)
          || !Number.isInteger(targetsCount)
          || targetsCount < 1;

        if (targetsInvalid) {
          return invalidate(
            targetsInput,
            localizeParam("IntegerMinInvalid", { min: 1 })
          );
        }

        clear(targetsInput);
        formData.targetsCount = targetsCount;
      }

      this.object = formData;

      const fired = await this.options.onConfirm(this.object);
      if (fired !== false) this.close();
    }
 }