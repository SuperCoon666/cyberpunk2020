export function registerSystemSettings() {
   /**
   * Track the system version upon which point a migration was last applied
   */
  game.settings.register("cyberpunk2020", "systemMigrationVersion", {
    name: "SETTINGS.SysMigration",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  game.settings.register("cyberpunk2020", "trainedSkillsFirst", {
    name: "SETTINGS.TrainedSkillsFirst",
    hint: "SETTINGS.TrainedSkillsFirstHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

    // --- Optional rules: Fumble Table ---
  game.settings.register("cyberpunk2020", "fumbleTableEnabled", {
    name: "SETTINGS.FumbleTableEnabled",
    hint: "SETTINGS.FumbleTableEnabledHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register("cyberpunk2020", "autoFumbleOnlyJam", {
    name: "SETTINGS.AutoFumbleOnlyJam",
    hint: "SETTINGS.AutoFumbleOnlyJamHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  // --- Optional rules: Reload ---
  game.settings.register("cyberpunk2020", "reloadByMagazines", {
    name: "SETTINGS.ReloadByMagazines",
    hint: "SETTINGS.ReloadByMagazinesHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  // --- Permissions: Cyberware Humanity editing ---
  game.settings.register("cyberpunk2020", "playersCanEditCyberwareHumanity", {
    name: "SETTINGS.PlayersCanEditCyberwareHumanity",
    hint: "SETTINGS.PlayersCanEditCyberwareHumanityHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    // ApplicationV2 sheets register here rather than in ui.windows.
    onChange: () => {
      for (const app of foundry.applications.instances.values()) {
        if (app.document?.type === "cyberware") app.render({ force: true });
      }
    }
  });

  // --- Client UI: inline damage roll tooltip ---
  game.settings.register("cyberpunk2020", "showInlineRollFormula", {
    name: "SETTINGS.ShowInlineRollFormula",
    hint: "SETTINGS.ShowInlineRollFormulaHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  // --- Combat: how applied damage reaches the target ---
  game.settings.register("cyberpunk2020", "damageApplyMode", {
    name: "SETTINGS.DamageApplyMode",
    hint: "SETTINGS.DamageApplyModeHint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      gmButton: "SETTINGS.DamageApplyModeGmButton",
      auto: "SETTINGS.DamageApplyModeAuto"
    },
    default: "gmButton"
  });

  // --- Combat: who rolls a player character's Stun/Death save ---
  game.settings.register("cyberpunk2020", "pcSaveMode", {
    name: "SETTINGS.PcSaveMode",
    hint: "SETTINGS.PcSaveModeHint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      auto: "SETTINGS.PcSaveModeAuto",
      manual: "SETTINGS.PcSaveModeManual"
    },
    default: "auto"
  });

  // --- Optional rules: Staged Penetration (armor ablation) ---
  game.settings.register("cyberpunk2020", "armorAblation", {
    name: "SETTINGS.ArmorAblation",
    hint: "SETTINGS.ArmorAblationHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  // --- Optional rules: limb severance ---
  game.settings.register("cyberpunk2020", "severanceThreshold", {
    name: "SETTINGS.SeveranceThreshold",
    hint: "SETTINGS.SeveranceThresholdHint",
    scope: "world",
    config: true,
    type: Number,
    default: 8
  });

  // --- Optional rules: more than one action per turn ---
  game.settings.register("cyberpunk2020", "actionEconomy", {
    name: "SETTINGS.ActionEconomy",
    hint: "SETTINGS.ActionEconomyHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  // --- Optional rules: one initiative die per side ---
  game.settings.register("cyberpunk2020", "partyInitiative", {
    name: "SETTINGS.PartyInitiative",
    hint: "SETTINGS.PartyInitiativeHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  // --- House rule: a declared dodge also hinders gunfire ---
  game.settings.register("cyberpunk2020", "dodgeVsRanged", {
    name: "SETTINGS.DodgeVsRanged",
    hint: "SETTINGS.DodgeVsRangedHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  // --- Client UI: turn notification ---
  game.settings.register("cyberpunk2020", "turnSound", {
    name: "SETTINGS.TurnSound",
    hint: "SETTINGS.TurnSoundHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  // --- Optional rules: Friday Night Fistfight 2 ---
  game.settings.register("cyberpunk2020", "fnff2Enabled", {
    name: "SETTINGS.FNFF2Enabled",
    hint: "SETTINGS.FNFF2EnabledHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
}