import { deepSet, localize, localizeParam, refusedWhilePaused } from "../utils.js"
import { fireModes, ranges, rangedAttackTypes, getMartialActionBonus, allOutEffectKeys } from "../lookups.js"
import { getHtmlElement } from "../compat.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Dialog used to select attack, range, fire-mode and miscellaneous modifiers.
 * @extends {foundry.applications.api.ApplicationV2}
 */
 export class ModifiersDialog extends HandlebarsApplicationMixin(ApplicationV2) {

    /** @override */
    static DEFAULT_OPTIONS = {
      // {id} is what ApplicationV2 substitutes per instance; a literal id makes every
      // dialog share one DOM node, so a second render replaces the first.
      id: "weapon-modifier-{id}",
      classes: ["cyberpunk2020", "weapon-modifier"],
      tag: "form",
      position: {
        width: 500,
        height: "auto"
      },
      window: {
        title: "CYBERPUNK.AttackModifiers"
      },
      form: {
        handler: ModifiersDialog.#onSubmit,
        // The dialog closes itself only once onConfirm has accepted the roll.
        closeOnSubmit: false
      },
      weapon: null,
      // Use like [[mod1, mod2], [mod3, mod4, mod5]] etc to add groupings,
      modifierGroups: [],
      targetTokens: [], // id and name for each target token
      // Whether the *Targets* section follows the canvas while the window is open. True where the
      // roll reads the targets again when it is confirmed, false where the caller froze them.
      liveTargets: false,
      // Extra mod field for miscellaneous mod
      extraMod: true,
      showAdvDis: false,

      onConfirm: () => {}
    };

    /** @override */
    static PARTS = {
      form: {
        template: "systems/cyberpunk2020/templates/dialog/modifiers.hbs"
      }
    };

    /* -------------------------------------------- */

    /** @override */
    async _prepareContext(options) {
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

          // D223 — the action penalty shares this row instead of taking one of its own: it is the
          // shooter's own arithmetic, the same as the free modifier beside it, and `.field-list` is
          // a two-column grid that would otherwise leave both of them half empty. The sheet appends
          // it as a group of its own because this group does not exist yet when it runs.
          const actionIndex = groups.findIndex(group => group[0]?.dataPath === "actionPenalty");
          if (actionIndex >= 0) extraGroup.push(...groups.splice(actionIndex, 1)[0]);

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
        isGM: game.user.isGM
      };
    }

    /** @override */
    async _onRender(context, options) {
      await super._onRender(context, options);

      const root = getHtmlElement(this.element);
      if (!root) return;

      this._cpActivateReload(root);
      this._cpActivateAdvantageToggles(root);
      this._cpActivateFireModeFields(root);
      this._cpActivateMartialBonuses(root);
      this._cpActivateTargetList(root);
    }

    /** @override */
    _onClose(options) {
      if (this.#targetHook) Hooks.off("targetToken", this.#targetHook);
      this.#targetHook = null;
      return super._onClose(options);
    }

    /** The `targetToken` registration this dialog holds while it is open, or null. */
    #targetHook = null;

    /**
     * Keep the *Targets* section on whoever the shooter has targeted **now** (`T437`). The shot
     * reads the canvas again when the window is confirmed, so a section still naming the token the
     * window opened on — or missing, because there was none — contradicts what is about to be
     * rolled.
     *
     * Rewritten in place rather than re-rendered: ApplicationV2 replaces the frame's contents, so a
     * render here would throw away every modifier the player has set and the field they are typing
     * in. Only the two nodes that carry a name are touched.
     *
     * Only where the caller reads its targets again on confirm — the attack and the stabilization
     * roll. A skill roll has no target of any kind, and a section appearing there because the player
     * happens to have something targeted would describe a thing that is not happening.
     *
     * @param {HTMLElement} root
     */
    _cpActivateTargetList(root) {
      if (!this.options.liveTargets) return;

      const section = root.querySelector(".cp-targets");
      const list = section?.querySelector(".fieldrow");
      if (!list) return;

      const refresh = () => {
        const names = Array.from(game.user.targets.values()).map(token => token.document.name);
        // A class rather than an inline `display`, because the CSS has to distinguish the two
        // states: the section is now always in the markup, and while it is empty the button row
        // below it has to keep the margin `.field-list + *` used to give it.
        section.classList.toggle("empty", names.length === 0);
        list.replaceChildren(...names.map(name => {
          const field = document.createElement("div");
          field.className = "field";
          const label = document.createElement("span");
          label.style.width = "100%";
          label.textContent = name;
          field.append(label);
          return field;
        }));
      };

      // A re-render leaves the previous registration writing into a detached node, so it goes
      // before the new one; `_onClose` takes whichever is current.
      if (this.#targetHook) Hooks.off("targetToken", this.#targetHook);
      // `Hooks.callAll("targetToken", user, token, targeted)` — one call per token, the clearing of
      // a whole selection included (`client/canvas/placeables/tokens/targets.mjs:65`, 14.365.0).
      this.#targetHook = Hooks.on("targetToken", user => {
        if (user === game.user) refresh();
      });
      refresh();
    }

    /**
     * Show the chosen art's bonus against every maneuver, and follow the art when it changes
     * (`T232`, D58). `+0` is printed rather than hidden: `07:1004` makes key attacks a bonus list
     * and not a permission list — *"A Karate Master would be able to do any other type of move,
     * but would be better at these three"* — so an unkeyed action is offered, at no bonus.
     */
    _cpActivateMartialBonuses(root) {
      const martialArt = root.querySelector('select[name="martialArt"]');
      const action = root.querySelector('select[name="action"]');
      if (!martialArt || !action) return;

      const paint = () => {
        for (const option of action.options) {
          // The label the template localized, kept aside on the first pass: repainting from the
          // rendered text would append a second bonus to the first.
          option.dataset.cpLabel ??= option.textContent;
          // D163's pair state their effect rather than a bonus, on this list as on the prompt's.
          const effect = allOutEffectKeys[option.value];
          if (effect) {
            option.textContent = `${option.dataset.cpLabel} (${localize(effect)})`;
            continue;
          }
          const bonus = getMartialActionBonus(martialArt.value, option.value);
          option.textContent = `${option.dataset.cpLabel} (${bonus >= 0 ? "+" : ""}${bonus})`;
        }
      };

      paint();
      martialArt.addEventListener("change", paint);
    }

    _cpActivateReload(root) {
    root.querySelector(".reload")?.addEventListener("click", async (ev) => {
      ev.preventDefault();

      const weapon = this.options.weapon;
      if (!weapon) return;

      const applyLocalState = (shotsLeftAfter) => {
        if (weapon.type === "weapon") {
          this.options.weapon.system.shotsLeft = shotsLeftAfter;
        } else if (weapon.type === "cyberware" && weapon.system?.CyberWorkType?.Weapon) {
          this.options.weapon.system.CyberWorkType.Weapon.shotsLeft = shotsLeftAfter;
        }

        root.querySelectorAll('input.number[readonly]').forEach(i => { i.value = shotsLeftAfter; });

        const sysAfter = weapon._getWeaponSystem?.() ?? weapon.system ?? {};
        const rof = Math.max(0, Math.floor(Number(sysAfter?.rof) || 0));
        const maxRounds = Math.min(rof, Math.max(0, Math.floor(Number(shotsLeftAfter) || 0)));

        const fullAutoInput = root.querySelector('input[name="fullAutoRoundsFired"]');
        if (fullAutoInput) {
          fullAutoInput.dataset.max = String(maxRounds);
          fullAutoInput.value = String(maxRounds);
          fullAutoInput.setCustomValidity("");
        }

        const suppressiveRoundsInput = root.querySelector('input[name="roundsFired"]');
        if (suppressiveRoundsInput) {
          suppressiveRoundsInput.dataset.max = String(maxRounds);
          suppressiveRoundsInput.value = String(maxRounds);
          suppressiveRoundsInput.setCustomValidity("");
        }
      };

      const { loaded, shotsLeft } = await weapon.reloadFromInventory();
      if (loaded) applyLocalState(shotsLeft);
    });
    }

    _cpActivateAdvantageToggles(root) {
      const uncheckAll = (selector) => root.querySelectorAll(selector).forEach(i => { i.checked = false; });
      root.querySelectorAll('input.adv, input.dis').forEach(el => el.addEventListener("change", ev => {
        const target = ev.currentTarget;
        if (target.classList.contains("adv") && target.checked) uncheckAll("input.dis");
        if (target.classList.contains("dis") && target.checked) uncheckAll("input.adv");
      }));
    }

    _cpActivateFireModeFields(root) {
      // Suppressive Fire fields
      // fire mode select
      const fireModeEl = root.querySelector(
        'select[name="fields.fireMode"], select[name="fireMode"], .field[data-path="fireMode"] select'
      );

      // What gets shown or hidden is the whole row, not the control, and several
      // selectors can resolve to the same row — hence closest() plus a Set.
      const rowsFor = (selectors) => {
        const rows = new Set();
        for (const el of root.querySelectorAll(selectors.join(','))) {
          const row = el.closest('.field, .form-group');
          if (row) rows.add(row);
        }
        return Array.from(rows);
      };

      // collect strings used exclusively for suppression
      const supRows = rowsFor([
        '.field.suppressive-field:not(.suppressive-zone-width)',
        '.field[data-path="roundsFired"]',
        '.field[data-path="targetsCount"]',
        'input[name="fields.roundsFired"], input[name="roundsFired"]',
        'input[name="fields.targetsCount"], input[name="targetsCount"]'
      ]);

      // The width field is shared with the flamethrower sweep (`T252`, D91) — it has no fire modes
      // of its own to gate the row on, so this shows whenever the weapon carries the width instead.
      const widthRows = rowsFor([
        '.field.suppressive-zone-width',
        '.field[data-path="zoneWidth"]',
        'input[name="fields.zoneWidth"], input[name="zoneWidth"]'
      ]);
      const weaponSys = this.options.weapon?._getWeaponSystem?.() ?? this.options.weapon?.system ?? {};
      const isFlamethrow = weaponSys.attackType === rangedAttackTypes.flamethrow;

      // D221 — the range row leaves the dialog for suppressive fire altogether. D220 took the band
      // out of the geometry and the save it prices is `rounds / width` alone, so there is no number
      // behind the control any more: offering it says the shooter's choice matters when it does not.
      // Hidden rather than removed, so switching back to another mode restores their own band.
      //
      // The hidden row still submits, and what it submits must not be «auto»: `__weaponRoll` refuses
      // that with nothing to measure from (D204, D199). Hence the swap below — the row goes and a
      // constant band goes with it.
      const rangeSelect = root.querySelector('select[name="fields.range"], select[name="range"]');
      const rangeRows = rangeSelect ? rowsFor(['select[name="fields.range"], select[name="range"]']) : [];
      const constantRange = (this.options.modifierGroups ?? [])
        .flat()
        .find(mod => mod?.dataPath === "range")?.constantDefault;

      const fullAutoRows = rowsFor([
        '.field.full-auto-rounds',
        '.field[data-path="fullAutoRoundsFired"]',
        'input[name="fields.fullAutoRoundsFired"]',
        'input[name="fullAutoRoundsFired"]'
      ]);

      const getFullAutoRoundsInput = () => root.querySelector('input[name="fullAutoRoundsFired"]');

      const getNumberInput = (name) =>
        root.querySelector(`input[name="${name}"], input[name="fields.${name}"]`);

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

        if (fireModeEl?.value !== fireModes.suppressive) return true;

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

        const zoneValid = validateIntegerMinInput(zoneWidthInput, {
          min: zoneMin,
          messageKey: "IntegerMinInvalid",
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

        if (fireModeEl?.value !== fireModes.fullAuto) return true;

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
        const fireMode = fireModeEl?.value;
        const isSup = fireMode === fireModes.suppressive;
        const isFullAuto = fireMode === fireModes.fullAuto;

        for (const row of supRows) row.style.display = isSup ? "" : "none";
        for (const row of widthRows) row.style.display = (isSup || isFlamethrow) ? "" : "none";
        for (const row of fullAutoRows) row.style.display = isFullAuto ? "" : "none";

        for (const row of rangeRows) row.style.display = isSup ? "none" : "";

        // Only the option the shooter never chose is replaced: a band they picked by hand stands,
        // and switching away from suppression does not put «auto» back over it.
        if (isSup && constantRange && rangeSelect?.value === ranges.auto) {
          rangeSelect.value = constantRange;
        }

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
      fireModeEl?.addEventListener('change', () => {
        updateVisibility();
        validateFullAutoRoundsInput();
        validateSuppressiveInputs();
      });

      const onInputAndChange = (selector, handler) => {
        for (const el of root.querySelectorAll(selector)) {
          for (const type of ["input", "change"]) el.addEventListener(type, handler);
        }
      };

      onInputAndChange('input[name="fullAutoRoundsFired"]', () => validateFullAutoRoundsInput());
      onInputAndChange(
        'input[name="roundsFired"], input[name="zoneWidth"], input[name="targetsCount"]',
        () => validateSuppressiveInputs()
      );
    }
  
    /**
     * Validate the chosen modifiers and hand them to the caller-supplied onConfirm.
     * @this {ModifiersDialog}
     * @param {SubmitEvent} event
     * @param {HTMLFormElement} form
     * @param {FormDataExtended} formDataExtended
     */
    static async #onSubmit(event, form, formDataExtended) {
      // Second chokepoint for the pause gate: the dialog outlives the click that opened it, so a
      // world paused in between is a state the entry points cannot see.
      if (refusedWhilePaused()) return false;

      const formData = foundry.utils.expandObject(formDataExtended.object);

      if (this.options.weapon && formData.fireMode === fireModes.fullAuto) {
        const sys = this.options.weapon._getWeaponSystem
          ? this.options.weapon._getWeaponSystem()
          : this.options.weapon.system;

        const rof = Math.max(0, Math.floor(Number(sys?.rof) || 0));
        const shotsLeft = Math.max(0, Math.floor(Number(sys?.shotsLeft) || 0));
        const maxRounds = Math.min(rof, shotsLeft);

        const input = form.querySelector('input[name="fullAutoRoundsFired"]');
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

        const roundsInput = form.querySelector('input[name="roundsFired"], input[name="fields.roundsFired"]');
        const zoneWidthInput = form.querySelector('input[name="zoneWidth"], input[name="fields.zoneWidth"]');
        const targetsInput = form.querySelector('input[name="targetsCount"], input[name="fields.targetsCount"]');

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
          || !Number.isInteger(zoneWidth)
          || zoneWidth < zoneMin;

        if (zoneInvalid) {
          return invalidate(
            zoneWidthInput,
            localizeParam("IntegerMinInvalid", { min: zoneMin })
          );
        }

        clear(zoneWidthInput);
        formData.zoneWidth = zoneWidth;

        // `T69` made this row conditional in `rangedModifiers` — it exists only for the abstract
        // per-target tally. Validating it when it was never rendered rejected every suppressive
        // burst in the shipped default state, silently (`T158`).
        if (targetsInput) {
          const targetsRaw = String(targetsInput.value ?? "").trim();
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
      }

      // D183 — the map is behind this window, and the area fire modes ask the shooter to click it:
      // suppressive fire, the thrown grenade and the planted charge all await an interactive
      // placement inside `onConfirm` while `closeOnSubmit: false` keeps the dialog across the middle
      // of the viewport (`T353`). Minimized rather than closed, because a refusal — no ammunition, a
      // disabled cyberweapon — has to hand the shooter their choices back.
      // Awaited, so the placement preview arms after the window has left the map, not during it.
      //
      // `T435` — the size to come back to is taken **now**, because core's own `maximize` cannot be
      // relied on to restore it. It ends in `setPosition`, which clamps the size it is given by the
      // **computed** max-width/max-height (`_updatePosition`,
      // `client/applications/api/application.mjs:1118-1152`, 14.365.0) — and from the second
      // collapse onwards the expand transition does not fire, so those are still the minimized
      // 200x36 when it reads them. The clamped pair is then written into the application's own
      // position, which pins the window at header height for the rest of its life. Measured across
      // three refusals in one dialog: 500x375 back on the first, 200x36 on the second and the
      // third. Re-applying the size after `maximize` has finished is enough, because by then the
      // `maximizing` class is gone and the ceiling it reads is the real one again.
      const priorSize = { width: this.position.width, height: this.position.height };
      const handBack = async () => {
        await this.maximize();
        this.setPosition(priorSize);
      };

      await this.minimize();
      try {
        const fired = await this.options.onConfirm(formData);
        if (fired !== false) this.close();
        else await handBack();
      } catch (err) {
        // `onConfirm` can throw — a bad formula reaching a `Roll`, or a chat failure now that
        // decision 6(b) propagates one. Without this the window stays collapsed to its header with
        // the shooter's whole modifier set behind it and no way back but a reload (`T384`). The
        // error still propagates; only the window is handed back.
        await handBack();
        throw err;
      }
    }
 }