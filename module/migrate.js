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
        await defaultDataUse(item, itemUpdate, itemUpdateOptions(itemUpdate));
      }
    } catch (err) {
      console.error(err);
    }
  }

  // Items Directory (world items)
  for (const item of game.items.contents) {
    try {
      const itemUpdate = await migrateItem(item);
      await defaultDataUse(item, itemUpdate, itemUpdateOptions(itemUpdate));
    } catch (err) {
      console.error(err);
    }
  }

  // Scene tokens (unlinked tokens)
  // Write through token.actor, the synthetic Actor over the token's ActorDelta.
  // TokenDocument#actorData was removed in v11, so updating the token itself with
  // actor data silently does nothing.
  for (const scene of game.scenes) {
    for (const token of scene.tokens) {
      if (!token.actor) continue;
      if (!token.actor.isOwner) continue;

      try {
        const actorUpdate = await migrateActor(token.actor);
        await defaultDataUse(token.actor, actorUpdate);

        // Best-effort: migrate embedded items on synthetic actor
        for (const item of token.actor.items.contents) {
          const itemUpdate = await migrateItem(item);
          await defaultDataUse(item, itemUpdate, itemUpdateOptions(itemUpdate));
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
};

/* -------------------------------------------- */
/*  Actor Migration                              */
/* -------------------------------------------- */

export async function migrateActor(actor) {
  const actorUpdates = {};

  migrateLegacyActorSystemShape(actor, actorUpdates);

  // Legacy skills migration (from the old actor.system.skills block into skill items).
  // `system.skills` is a declared ObjectField nothing else reads, which is what lets the block
  // survive construction and reach this function at all.
  const legacySkills = actor.system?.skills;
  const hasSkillItems = actor.items.find((i) => i.type === "skill") !== undefined;

  if (!isEmptyObject(legacySkills)) {
    if (!hasSkillItems) {
      const defaultSkills = await getDefaultSkills();
      const trainedSkills = collectLegacySkills(legacySkills);

      const skillsToAdd = [];

      for (const skill of defaultSkills) {
        const skillData = skill.toObject();
        const trained = trainedSkills[skill.name];

        if (trained) {
          // Transfer only trained-level info into the new skill item instance.
          foundry.utils.setProperty(skillData, "system.level", trained.value ?? 0);
          foundry.utils.setProperty(skillData, "system.ip", trained.IP ?? trained.ip ?? 0);
          foundry.utils.setProperty(skillData, "system.IP", trained.IP ?? trained.ip ?? 0);
          foundry.utils.setProperty(skillData, "system.trained", true);

          // Remove from trainedSkills pool to detect non-standard skills after.
          delete trainedSkills[skill.name];
        }

        skillsToAdd.push(skillData);
      }

      // Convert any remaining legacy skills (custom skills not in default compendium).
      for (const [skillName, legacy] of Object.entries(trainedSkills)) {
        skillsToAdd.push(convertOldSkill(skillName, legacy));
      }

      // IMPORTANT: do NOT rewrite actor.items array (it can duplicate/reshape embedded docs).
      // Create skill items safely.
      if (skillsToAdd.length > 0) {
        await actor.createEmbeddedDocuments("Item", skillsToAdd);
      }

      actorUpdates["system.skillsSortedBy"] = "Name";
    }

    // Outside the conversion on purpose: an actor converted by an earlier release still carries
    // the block, because the delete of the day wrote `= undefined`, which an update ignores.
    //
    // Replacement, not deletion, and neither is interchangeable here. `system.skills` is a
    // required ObjectField: DataField#validate unwraps a ForcedDeletion to `undefined`
    // (common/data/fields.mjs:410, 14.365), `_validateSpecial` rejects that on a required field
    // (:477) and `_updateDiff` then silently prevents the assignment (:578) — measured, the block
    // survived intact. A plain `{}` is no better, because ObjectField merges the requested value
    // over the stored one (:1952) and an empty diff is dropped.
    actorUpdates["system.skills"] = new foundry.data.operators.ForcedReplacement({});
  }

  // Ensure sorted-by setting exists (new worlds / actors without it).
  if (!actor.system?.skillsSortedBy) {
    actorUpdates["system.skillsSortedBy"] = "Name";
  }

  return actorUpdates;
}

/**
 * Flatten the legacy skills block into a {displayName: legacyEntry} map keyed the way the
 * language-matched default pack is keyed.
 *
 * Two properties of the stored shape make this more than a rename. Its keys are localization-key
 * suffixes ("AVTech"), not display names, so matching them against the pack directly finds 43 of
 * 100 skills under `en` and 0 of 100 under `ru` — measured on a real v12 world. And a group entry
 * holds its sub-skills as sibling keys beside `group: true`; groups have no equivalent today, so
 * each sub-skill becomes a skill of its own.
 */
function collectLegacySkills(legacySkills) {
  // This era's entry is {value, ip, chipped, stat} and has no `trained` key at all, so a filter
  // on one keeps nothing and re-seeds the character's whole skill list at level 0.
  const hasPoints = (s) => Number(s?.value ?? 0) > 0 || Number(s?.IP ?? s?.ip ?? 0) > 0;
  const displayName = (key) =>
    tryLocalize(`martials.Martial Arts: ${key}`, tryLocalize(`Skill${key}`, key));

  const out = {};
  for (const [key, entry] of Object.entries(legacySkills)) {
    if (entry?.group) {
      for (const [subKey, sub] of Object.entries(entry)) {
        if (subKey !== "group" && hasPoints(sub)) out[displayName(subKey)] = sub;
      }
    } else if (hasPoints(entry)) {
      out[displayName(key)] = entry;
    }
  }
  return out;
}

function migrateLegacyActorSystemShape(actor, actorUpdates) {
  const sourceSystem = actor.toObject()?.system ?? {};

  // Old template nesting: system.stats.stats -> system.stats.
  const nestedStats = foundry.utils.getProperty(sourceSystem, "stats.stats");
  if (nestedStats && typeof nestedStats === "object") {
    actorUpdates["system.stats"] = nestedStats;
  }

  // Old template nesting: system.hitLocations.hitLocations -> system.hitLocations,
  // and system.hitLocations.sdp -> system.sdp.
  const nestedHitLocations = foundry.utils.getProperty(sourceSystem, "hitLocations.hitLocations");
  if (nestedHitLocations && typeof nestedHitLocations === "object") {
    actorUpdates["system.hitLocations"] = nestedHitLocations;
  }

  const nestedSdp = foundry.utils.getProperty(sourceSystem, "hitLocations.sdp");
  if (nestedSdp && typeof nestedSdp === "object" && !sourceSystem.sdp) {
    actorUpdates["system.sdp"] = nestedSdp;
  }

  // Old template nesting: system.gear.eurobucks -> system.eurobucks.
  const eurobucks = foundry.utils.getProperty(sourceSystem, "gear.eurobucks");
  if (eurobucks !== undefined && sourceSystem.eurobucks === undefined) {
    actorUpdates["system.eurobucks"] = eurobucks;
  }

  // Old template nesting: system.netrun.* -> top-level fields.
  const netrun = sourceSystem.netrun;
  if (netrun && typeof netrun === "object") {
    const netrunFields = [
      "icon",
      "handle",
      "currentRunSpeed",
      "runSpeed",
      "stunDamage",
      "activePrograms"
    ];

    for (const field of netrunFields) {
      if (netrun[field] !== undefined && sourceSystem[field] === undefined) {
        actorUpdates[`system.${field}`] = netrun[field];
      }
    }
  }

  // Very old template default could leave an object instead of a concrete path string.
  if (sourceSystem.icon && typeof sourceSystem.icon === "object") {
    actorUpdates["system.icon"] = sourceSystem.icon.default ?? "";
  }

  if (sourceSystem.notes === null) actorUpdates["system.notes"] = "";
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
  "chipware",
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
      const index = await pack.getIndex({ fields: ["name", "type", "flags.core.sourceId", "_stats.compendiumSource"] });

      for (const entry of index) {
        if (entry.type && entry.type !== "cyberware") continue;

        const id = entry._id ?? entry.id;
        if (!id) continue;

        addCyberwareIdRef(id, { collection: pack.collection, id });
        addCyberwareIdRef(getIdFromSourceId(entry.flags?.core?.sourceId), { collection: pack.collection, id });
        addCyberwareIdRef(getIdFromSourceId(entry._stats?.compendiumSource), { collection: pack.collection, id });

        // Exceptional legacy fallback only for cyberware migration: old worlds may
        // contain pre-refactor implants with no stable source id. Keep this as the
        // final lookup option; all normal localized logic must stay id-based.
        const nm = normalizeName(entry.name);
        if (nm && !_cyberwareNameToRef.has(nm)) _cyberwareNameToRef.set(nm, { collection: pack.collection, id });
      }
    }
  })();

  return _cyberwareIndexPromise;
}

function addCyberwareIdRef(id, ref) {
  if (!id) return;
  if (!_cyberwareIdToRef.has(id)) _cyberwareIdToRef.set(id, ref);
}

function getIdFromSourceId(sourceId) {
  if (!sourceId) return null;
  const s = String(sourceId);
  const parts = s.split(".");
  return parts[parts.length - 1] || null;
}

function getItemStableIdCandidates(itemData, itemDoc = null) {
  const candidates = [
    getIdFromSourceId(itemData.flags?.core?.sourceId),
    getIdFromSourceId(itemData._source?.flags?.core?.sourceId),
    getIdFromSourceId(itemData._stats?.compendiumSource),
    getIdFromSourceId(itemData._source?._stats?.compendiumSource),
    itemData._id,
    itemData.id,
    itemData._source?._id,
    itemDoc?.id,
    itemDoc?._id
  ];

  return Array.from(new Set(candidates.filter(Boolean).map(String)));
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

  const ref = _cyberwareIdToRef.get(String(docId));
  if (!ref) return null;

  return getCyberwareTemplateByRef(ref);
}

async function getCyberwareTemplateByIds(ids) {
  for (const id of ids) {
    const template = await getCyberwareTemplateById(id);
    if (template) return template;
  }
  return null;
}

async function getCyberwareTemplateByName(itemName) {
  if (!itemName) return null;
  await ensureCyberwareIndex();

  const ref = _cyberwareNameToRef.get(normalizeName(itemName));
  if (!ref) return null;

  return getCyberwareTemplateByRef(ref);
}

// A blank is not a value: a pre-refactor implant often carries the key with "" or null, and the
// template is the only thing that can fill it — a blank MountZone left as-is is an uninstalled
// implant.
function fillFromCyberwareTemplate(target, source) {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (foundry.utils.isPlainObject(value) && foundry.utils.isPlainObject(current)) {
      fillFromCyberwareTemplate(current, value);
      continue;
    }
    if (current === undefined || current === null || current === "") {
      target[key] = foundry.utils.duplicate(value);
    }
  }
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

  // Preserve installed body zone from the old owned item.
  const oldMountZone = String(oldSystem?.MountZone ?? "").trim();
  if (oldMountZone) newSystem.MountZone = oldMountZone;

  // The side is what MountZone "Arm"/"Leg" is resolved against, both for SDP and for parent
  // matching. The compendium template carries its own, so an unpreserved side is not lost but
  // replaced — a right limb silently becomes a left one.
  const oldSide = String(oldSystem?.CyberBodyType?.Location ?? "").trim();
  if (oldSide) {
    newSystem.CyberBodyType = newSystem.CyberBodyType ?? {};
    newSystem.CyberBodyType.Location = oldSide;
  }

  if (oldSystem?.CyberWorkType) {
    newSystem.CyberWorkType = newSystem.CyberWorkType ?? {};

    // Chipware runtime state.
    if (typeof oldSystem.CyberWorkType.ChipActive === "boolean") {
      newSystem.CyberWorkType.ChipActive = oldSystem.CyberWorkType.ChipActive;
    }
    if (oldSystem.CyberWorkType.ChipSkills && typeof oldSystem.CyberWorkType.ChipSkills === "object") {
      newSystem.CyberWorkType.ChipSkills = foundry.utils.duplicate(oldSystem.CyberWorkType.ChipSkills);
    }

    // Linked item/cyberware state.
    if (oldSystem.CyberWorkType.ItemId) newSystem.CyberWorkType.ItemId = oldSystem.CyberWorkType.ItemId;
  }
}

function chipSkillKeysToIds(actor, chipSkills) {
  if (!chipSkills || typeof chipSkills !== "object") return null;

  const out = {};
  let changed = false;

  for (const [key, value] of Object.entries(chipSkills)) {
    if (actor.items.get(key)?.type === "skill") {
      out[key] = value;
      continue;
    }

    // Legacy maps are keyed by the skill's displayed name. The map and the skills were authored
    // in the same world, so matching on the actor's own skills needs no language assumption.
    const byName = actor.items.find(i => i.type === "skill" && i.name === key);
    if (byName) {
      out[byName.id] = value;
      changed = true;
    } else {
      out[key] = value;
      console.warn(`Cyberpunk2020 | chip skill key "${key}" on ${actor.name} matched no skill; left as-is`);
    }
  }

  return changed ? out : null;
}

function normalizeRangeDamagesForUpdate(value) {
  const defaults = {
    pointBlank: "",
    close: "",
    medium: "",
    far: "",
    short: "",
    extreme: ""
  };

  if (Array.isArray(value)) {
    return foundry.utils.mergeObject(defaults, { pointBlank: value[0] ?? "" }, { inplace: false });
  }

  if (typeof value === "string" || typeof value === "number") {
    return foundry.utils.mergeObject(defaults, { pointBlank: String(value) }, { inplace: false });
  }

  if (value && typeof value === "object") {
    return foundry.utils.mergeObject(defaults, value, { inplace: false });
  }

  return foundry.utils.duplicate(defaults);
}

function normalizeCyberwareTypesForUpdate(itemData, updateData) {
  const types = foundry.utils.getProperty(itemData, "system.CyberWorkType.Types");
  const type = foundry.utils.getProperty(itemData, "system.CyberWorkType.Type");

  let nextTypes = [];
  if (Array.isArray(types)) nextTypes = types.filter(Boolean);
  else if (typeof types === "string" && types) nextTypes = [types];
  else if (Array.isArray(type)) nextTypes = type.filter(Boolean);
  else if (typeof type === "string" && type) nextTypes = [type];

  if (!nextTypes.length) nextTypes = ["Descriptive"];

  if (!nextTypes.includes("Descriptive") && !cwHasType(itemData.system, "Descriptive")) {
    nextTypes.push("Descriptive");
  }

  updateData["system.CyberWorkType.Type"] = nextTypes[0] ?? "Descriptive";
  updateData["system.CyberWorkType.Types"] = Array.from(new Set(nextTypes));
}

export async function migrateItem(item) {
  const itemData = item.toObject();
  const updateData = {};

  // Always store sourceId on world items. The compendium-template arm runs with recursive:false
  // so that system data is replaced wholesale, which also replaces flags — carry the existing
  // ones across explicitly instead of writing a dotted key that would drop every other module's.
  if (itemData._stats?.compendiumSource
    && itemData.flags?.core?.sourceId !== itemData._stats.compendiumSource) {
    updateData.flags = foundry.utils.mergeObject(
      itemData.flags ?? {},
      { core: { sourceId: itemData._stats.compendiumSource } },
      { inplace: false }
    );
  }

  // Convert legacy rangeDamage to object-shaped rangeDamages for weapons.
  if (itemData.type === "weapon") {
    const rangeDamage = foundry.utils.getProperty(itemData, "system.rangeDamage");
    if (rangeDamage !== undefined) {
      updateData["system.rangeDamages"] = normalizeRangeDamagesForUpdate(rangeDamage);
      Object.assign(updateData, deleteFieldUpdate("system.rangeDamage"));
    }
  }

  // CYBERWARE: fill the modern schema block from the compendium template, keeping world values.
  if (item.type === "cyberware") {
    const chipSkills = item.parent
      ? chipSkillKeysToIds(item.parent, itemData.system?.CyberWorkType?.ChipSkills)
      : null;
    if (chipSkills) itemData.system.CyberWorkType.ChipSkills = chipSkills;

    const stableIds = getItemStableIdCandidates(itemData, item);

    // Primary path: stable id/source id. This is the normal multilingual architecture.
    let template = await getCyberwareTemplateByIds(stableIds);

    // Exceptional final fallback: old pre-refactor cyberware in existing worlds may
    // have neither matching _id nor sourceId. Name matching is kept only here to
    // maximize seamless migration from the old implant structure.
    if (!template) template = await getCyberwareTemplateByName(item.name);

    if (template) {
      const tpl = template.toObject();
      const oldSystem = itemData.system ?? {};

      // The template exists to supply the schema block a pre-refactor implant has no key for.
      // Every value the world item already carries is user content: implants get renamed,
      // translated and re-costed, so letting the template win reverts the player's own item to
      // stock. Measured on a real v12 world: 278 of 283 implants differ from their template.
      const newSystem = foundry.utils.duplicate(oldSystem);
      fillFromCyberwareTemplate(newSystem, tpl.system ?? {});

      transferCyberwareUserValues({ oldSystem, newSystem });
      preserveCyberwareRuntimeState({ oldSystem, newSystem });

      updateData.type = tpl.type;
      updateData.system = newSystem;

      // Flags: keep existing ones (including the sourceId set above), add template flags.
      const oldFlags = updateData.flags ?? itemData.flags ?? {};
      const tplFlags = tpl.flags ?? {};
      updateData.flags = foundry.utils.mergeObject(oldFlags, tplFlags, {
        inplace: false,
        overwrite: true,
        recursive: true
      });

      // Preserve folder/sort/ownership for world items.
      if (!item.parent) {
        if (itemData.folder) updateData.folder = itemData.folder;
        if (itemData.sort !== undefined) updateData.sort = itemData.sort;
        if (itemData.ownership) updateData.ownership = itemData.ownership;
      }

      return updateData;
    }

    // Not found in compendium: keep the item usable and normalize type shape.
    normalizeCyberwareTypesForUpdate(itemData, updateData);
    if (chipSkills) updateData["system.CyberWorkType.ChipSkills"] = chipSkills;
    return updateData;
  }

  return updateData;
}

/* -------------------------------------------- */
/*  Compendium Migration                         */
/* -------------------------------------------- */

export async function migrateCompendium(compendium) {
  if (compendium.locked) {
    // Packs shipped by a system or module are locked by default and are already current;
    // only an unexpectedly locked pack is worth a warning.
    const shipped = compendium.metadata.packageType !== "world";
    const log = shipped ? console.debug : console.warn;
    log(`Not migrating compendium ${compendium.collection} as it is locked`);
    return;
  }

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

  // A batch carries one set of options, so the two update shapes go in two batches.
  for (const batch of [updates.filter(u => "system" in u), updates.filter(u => !("system" in u))]) {
    if (!batch.length) continue;
    // CompendiumCollection has no updateDocuments; the write goes through the document class.
    await compendium.documentClass.updateDocuments(batch, {
      pack: compendium.collection,
      ...itemUpdateOptions(batch[0])
    });
  }
}

/* -------------------------------------------- */
/*  Legacy Skill Converter                       */
/* -------------------------------------------- */

export function convertOldSkill(skillName, oldSkillData = {}) {
  const level = Number(oldSkillData.value ?? oldSkillData.level ?? oldSkillData.rank ?? 0) || 0;
  const ip = Number(oldSkillData.IP ?? oldSkillData.ip ?? 0) || 0;

  return {
    name: skillName,
    type: "skill",
    system: {
      flavor: "",
      notes: "",
      level,
      chipLevel: Number(oldSkillData.chipLevel ?? 0) || 0,
      ip,
      IP: ip,
      diffMod: Number(oldSkillData.diffMod ?? oldSkillData.ipmod ?? 1) || 1,
      isChipped: Boolean(oldSkillData.isChipped ?? oldSkillData.chipped ?? false),
      autoChipped: false,
      isRoleSkill: Boolean(oldSkillData.isRoleSkill ?? false),
      trained: Boolean(oldSkillData.trained ?? level > 0),
      stat: oldSkillData.stat || "cool",
      askMods: Boolean(oldSkillData.askMods ?? false)
    }
  };
}

/* -------------------------------------------- */
/*  Helpers                                      */
/* -------------------------------------------- */

function isEmptyObject(obj) {
  return !obj || (typeof obj === "object" && Object.keys(obj).length === 0);
}

/**
 * The two migrateItem branches return different update *shapes* and need different merge
 * behaviour, so the options are chosen from the shape rather than fixed at the call site.
 *
 * The compendium-template path returns a whole `system` object, where `recursive: false` is
 * load-bearing: it is what makes the template's empty maps replace the old ones, so a rebuilt
 * implant drops stat bonuses and checks its template does not grant.
 *
 * The no-template path returns dotted keys. Those expand into nested objects, and under
 * `recursive: false` the expansion replaces `system` wholesale — every field the update does not
 * name reverts to its schema default. Measured: a user-authored implant lost MountZone,
 * humanityLoss, cost, weight, the installed side, ChipActive, ChipSkills, SDP and
 * OptionsAvailable in one migration.
 */
function itemUpdateOptions(updateData) {
  return "system" in updateData ? { diff: false, recursive: false } : { diff: false };
}

async function defaultDataUse(document, updateData, options = {}) {
  if (isEmptyObject(updateData)) return;
  await document.update(updateData, { enforceTypes: true, ...options });
}
