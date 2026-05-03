import { deleteFieldUpdate, getDefaultSkills, localize, tryLocalize, cwHasType } from "./utils.js";

/**
 * Migration entrypoint.
 */
export const migrateWorld = async function (targetVersion = game.system.version) {
  ui.notifications.info(
    localize("CP.Migration.Begin", { version: game.system.version }),
    { permanent: true }
  );

  // Actors (world)
  for (const actor of game.actors.contents) {
    try {
      const actorUpdate = await migrateActor(actor);
      await defaultDataUse(actor, actorUpdate);

      // Migrate embedded items (critical for cyberware replacement)
      for (const item of actor.items.contents) {
        const itemUpdate = await migrateItem(item);
        await defaultDataUse(item, itemUpdate, { diff: false, recursive: false });
      }
    } catch (err) {
      console.error(err);
    }
  }

  // Items Directory (world items)
  for (const item of game.items.contents) {
    try {
      const itemUpdate = await migrateItem(item);
      await defaultDataUse(item, itemUpdate, { diff: false, recursive: false });
    } catch (err) {
      console.error(err);
    }
  }

  // Scene tokens (unlinked tokens)
  // NOTE: token.actor for unlinked tokens is synthetic; we keep original approach
  // but still migrate actorData and embedded items where possible
  for (const scene of game.scenes) {
    for (const token of scene.tokens) {
      if (!token.actor) continue;
      if (!token.actor.isOwner) continue;

      try {
        const tokenData = {};
        const actorUpdate = await migrateActor(token.actor);
        if (!isEmptyObject(actorUpdate)) tokenData.actorData = actorUpdate;
        if (!isEmptyObject(tokenData)) await defaultDataUse(token, tokenData);

        // Best-effort: migrate embedded items on synthetic actor
        for (const item of token.actor.items.contents) {
          const itemUpdate = await migrateItem(item);
          await defaultDataUse(item, itemUpdate, { diff: false, recursive: false });
        }
      } catch (err) {
        console.error(err);
      }
    }
  }

  // Compendiums (only unlocked)
  for (const pack of game.packs) {
    try {
      await migrateCompendium(pack);
    } catch (err) {
      console.error(err);
    }
  }

  ui.notifications.info(localize("CP.Migration.Complete"), { permanent: true });

  // Mark world as migrated so we don't run again on every restart
  await game.settings.set("cyberpunk2020", "systemMigrationVersion", targetVersion);
  console.log(`CYBERPUNK: Migration flag set to ${targetVersion}`);
};

/* -------------------------------------------- */
/*  Actor Migration                              */
/* -------------------------------------------- */

export async function migrateActor(actor) {
  const actorUpdates = {};

  // Legacy skills migration (from old actor.system.data.skills into skill items)
  const legacySkills = foundry.utils.getProperty(actor, "system.data.skills");
  const hasSkillItems = actor.items.find((i) => i.type === "skill") !== undefined;

  if (legacySkills && !hasSkillItems) {
    const defaultSkills = await getDefaultSkills();
    const trainedSkills = Object.entries(legacySkills).reduce((obj, [key, value]) => {
      if (value?.trained) obj[key] = value;
      return obj;
    }, {});

    const skillsToAdd = [];

    for (const skill of defaultSkills) {
      const skillData = skill.toObject();
      const trained = trainedSkills[skill.name];

      if (trained) {
        // Transfer only "trained-level" info into the new skill item instance
        foundry.utils.setProperty(skillData, "system.level", trained.value);
        foundry.utils.setProperty(skillData, "system.IP", trained.IP ?? 0);

        // Optional: keep "trained" marker if your skill schema uses it
        if (foundry.utils.getProperty(skillData, "system.trained") !== undefined) {
          foundry.utils.setProperty(skillData, "system.trained", true);
        }

        // Remove from trainedSkills pool to detect non-standard skills after
        delete trainedSkills[skill.name];
      }

      skillsToAdd.push(skillData);
    }

    // Convert any remaining legacy skills (custom skills not in default compendium)
    for (const [skillName, legacy] of Object.entries(trainedSkills)) {
      skillsToAdd.push(convertOldSkill(skillName, legacy));
    }

    // IMPORTANT: do NOT rewrite actor.items array (it can duplicate/reshape embedded docs)
    // Create skill items safely
    if (skillsToAdd.length > 0) {
      await actor.createEmbeddedDocuments("Item", skillsToAdd);
    }

    // Clear legacy container and set default sorting key (system field, not flags)
    actorUpdates["system.skillsSortedBy"] = "Name";
    actorUpdates["system.data.skills"] = null;
  }

  // Ensure sorted-by setting exists (new worlds / actors without it)
  if (!actor.system?.skillsSortedBy) {
    actorUpdates["system.skillsSortedBy"] = "Name";
  }

  return actorUpdates;
}

/* -------------------------------------------- */
/*  Item Migration                               */
/* -------------------------------------------- */

const CYBERWARE_PACK_NAMES = [
  "fashonware",
  "bioware",
  "cyberweapons",
  "implants",
  "neuralware",
  "cyberaudio",
  "cyberlimbs",
  "cyberoptic",
  "other-cyberware"
];

function normalizeName(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function getCyberwarePacks() {
  const sysId = game.system?.id || "cyberpunk2020";
  const packs = [];
  for (const n of CYBERWARE_PACK_NAMES) {
    const collection = `${sysId}.${n}`;
    const pack = game.packs.get(collection);
    if (pack) packs.push(pack);
  }
  return packs;
}

let _cyberwareIndexPromise = null;
let _cyberwareIdToRef = new Map();
let _cyberwareNameToRef = new Map();
let _cyberwareDocCache = new Map();

async function ensureCyberwareIndex() {
  if (_cyberwareIndexPromise) return _cyberwareIndexPromise;

  _cyberwareIndexPromise = (async () => {
    _cyberwareIdToRef = new Map();
    _cyberwareNameToRef = new Map();

    for (const pack of getCyberwarePacks()) {
      const index = await pack.getIndex({ fields: ["name", "type"] });

      for (const entry of index) {
        if (entry.type && entry.type !== "cyberware") continue;

        const id = entry._id ?? entry.id;
        if (!id) continue;

        if (!_cyberwareIdToRef.has(id)) _cyberwareIdToRef.set(id, { collection: pack.collection, id });

        const nm = normalizeName(entry.name);
        if (nm && !_cyberwareNameToRef.has(nm)) _cyberwareNameToRef.set(nm, { collection: pack.collection, id });
      }
    }
  })();

  return _cyberwareIndexPromise;
}

function getIdFromSourceId(sourceId) {
  if (!sourceId) return null;
  const s = String(sourceId);
  const parts = s.split(".");
  return parts[parts.length - 1] || null;
}

async function getCyberwareTemplateByRef(ref) {
  if (!ref?.collection || !ref?.id) return null;

  const cacheKey = `${ref.collection}:${ref.id}`;
  if (_cyberwareDocCache.has(cacheKey)) return _cyberwareDocCache.get(cacheKey);

  const pack = game.packs.get(ref.collection);
  if (!pack) return null;

  const doc = await pack.getDocument(ref.id);
  if (doc) _cyberwareDocCache.set(cacheKey, doc);
  return doc ?? null;
}

async function getCyberwareTemplateById(docId) {
  if (!docId) return null;
  await ensureCyberwareIndex();

  const ref = _cyberwareIdToRef.get(docId);
  if (!ref) return null;

  return getCyberwareTemplateByRef(ref);
}

async function getCyberwareTemplateByName(itemName) {
  if (!itemName) return null;
  await ensureCyberwareIndex();

  const ref = _cyberwareNameToRef.get(normalizeName(itemName));
  if (!ref) return null;

  return getCyberwareTemplateByRef(ref);
}

function transferCyberwareUserValues({ oldSystem, newSystem }) {
  if (oldSystem?.humanityLoss !== undefined) newSystem.humanityLoss = oldSystem.humanityLoss;
  if (oldSystem?.cost !== undefined) newSystem.cost = oldSystem.cost;
  if (oldSystem?.weight !== undefined) newSystem.weight = oldSystem.weight;
}

function preserveCyberwareRuntimeState({ oldSystem, newSystem }) {
  // equipped / EffectActive
  if (typeof oldSystem?.equipped === "boolean") newSystem.equipped = oldSystem.equipped;
  if (typeof oldSystem?.EffectActive === "boolean") newSystem.EffectActive = oldSystem.EffectActive;

  // module linkage (options)
  if (oldSystem?.Module) {
    newSystem.Module = newSystem.Module ?? {};
    if (oldSystem.Module.ParentId) newSystem.Module.ParentId = oldSystem.Module.ParentId;
    if (typeof oldSystem.Module.IsModule === "boolean") newSystem.Module.IsModule = oldSystem.Module.IsModule;
    if (oldSystem.Module.SlotsTaken !== undefined) newSystem.Module.SlotsTaken = oldSystem.Module.SlotsTaken;
  }

  // IMPORTANT: Take MountZone from the new version
  // If the old version had a non-empty value, leave it as is
  const oldMountZone = String(oldSystem?.MountZone ?? "").trim();
  if (oldMountZone) newSystem.MountZone = oldMountZone;

  // ChipActive
  if (oldSystem?.CyberWorkType && typeof oldSystem.CyberWorkType.ChipActive === "boolean") {
    newSystem.CyberWorkType = newSystem.CyberWorkType ?? {};
    newSystem.CyberWorkType.ChipActive = oldSystem.CyberWorkType.ChipActive;
  }
}

export async function migrateItem(item) {
  const itemData = item.toObject();
  const updateData = {};

  // Always store sourceId on world items
  if (itemData._stats?.compendiumSource) {
    updateData["flags.core.sourceId"] = itemData._stats.compendiumSource;
  }

  // Convert "rangeDamage" to "rangeDamages" for melee weapons
  if (itemData.type === "weapon") {
    const rangeDamage = foundry.utils.getProperty(itemData, "system.rangeDamage");
    if (rangeDamage !== undefined) {
      updateData["system.rangeDamages"] = [rangeDamage];
      Object.assign(updateData, deleteFieldUpdate("system.rangeDamage"));
    }
  }

  // CYBERWARE: replace content from compendium template, then transfer user values
  if (item.type === "cyberware") {
    // Try find template by id first (sourceId / compendiumSource / _id), then by name
    const src = itemData.flags?.core?.sourceId || itemData._stats?.compendiumSource;
    const srcId = getIdFromSourceId(src);

    let template = null;

    if (srcId) template = await getCyberwareTemplateById(srcId);

    if (!template && itemData._id) template = await getCyberwareTemplateById(itemData._id);

    if (!template) template = await getCyberwareTemplateByName(item.name);

    if (template) {
      const tpl = template.toObject();

      const oldSystem = itemData.system ?? {};

      const newSystem = foundry.utils.duplicate(tpl.system ?? {});

      transferCyberwareUserValues({ oldSystem, newSystem });

      preserveCyberwareRuntimeState({ oldSystem, newSystem });

      updateData.name = tpl.name;
      updateData.img = tpl.img;
      updateData.type = tpl.type;
      updateData.system = newSystem;
      updateData.effects = foundry.utils.duplicate(tpl.effects ?? []);

      // Flags: keep existing ones, add template
      const oldFlags = itemData.flags ?? {};
      const tplFlags = tpl.flags ?? {};
      updateData.flags = foundry.utils.mergeObject(oldFlags, tplFlags, {
        inplace: false,
        overwrite: true,
        recursive: true
      });

      // Preserve folder/sort/ownership for world items
      if (!item.parent) {
        if (itemData.folder) updateData.folder = itemData.folder;
        if (itemData.sort !== undefined) updateData.sort = itemData.sort;
        if (itemData.ownership) updateData.ownership = itemData.ownership;
      }

      return updateData;
    } else {
      // Not found in compendium: force descriptive type to avoid misclassification
      const types = foundry.utils.getProperty(itemData, "system.CyberWorkType.Types");
      if (!cwHasType(itemData.system, "Descriptive")) {
        updateData["system.CyberWorkType.Type"] = "Descriptive";
        updateData["system.CyberWorkType.Types"] = Array.isArray(types)
          ? Array.from(new Set([...types, "Descriptive"]))
          : ["Descriptive"];
      }
      return updateData;
    }
  }

  return updateData;
}

/* -------------------------------------------- */
/*  Compendium Migration                         */
/* -------------------------------------------- */

export async function migrateCompendium(compendium) {
  if (compendium.locked) {
    console.warn(`Not migrating compendium ${compendium.collection} as it is locked`);
    return;
  }

  // v12/v13 safe: updateDocuments on the pack itself
  const docs = await compendium.getDocuments();
  const updates = [];

  for (const document of docs) {
    try {
      let updateData = null;

      if (document instanceof Actor) updateData = await migrateActor(document);
      else if (document instanceof Item) updateData = await migrateItem(document);
      else continue;

      if (!isEmptyObject(updateData)) {
        updateData._id = document.id;
        updates.push(updateData);
      }
    } catch (err) {
      console.error(err);
    }
  }

  if (updates.length > 0) {
    await compendium.updateDocuments(updates, { diff: false, recursive: false });
  }
}

/* -------------------------------------------- */
/*  Legacy Skill Converter                       */
/* -------------------------------------------- */

export function convertOldSkill(skillName, oldSkillData = {}) {
  return {
    name: skillName,
    type: "skill",
    system: {
      description: "",
      category: oldSkillData.category || "",
      rank: oldSkillData.value ?? 0,
      stat: oldSkillData.stat || "",
      ipmod: 1,
      ip: oldSkillData.IP ?? 0,
      martialArts: {},
      hasMartialArts: false,
      isRanged: false,
      isLanguage: false
    }
  };
}

/* -------------------------------------------- */
/*  Helpers                                      */
/* -------------------------------------------- */

function isEmptyObject(obj) {
  return !obj || (typeof obj === "object" && Object.keys(obj).length === 0);
}

async function defaultDataUse(document, updateData, options = {}) {
  if (isEmptyObject(updateData)) return;
  await document.update(updateData, { enforceTypes: true, ...options });
}
