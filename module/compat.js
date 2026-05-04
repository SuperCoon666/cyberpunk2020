/**
 * Compatibility helpers for Foundry VTT v13/v14.
 * Keep version and API branching here instead of spreading it across sheets,
 * dialogs and roll/chat code.
 */

export function getFoundryMajorVersion() {
  const generation = Number(globalThis.game?.release?.generation);
  if (Number.isFinite(generation) && generation > 0) return generation;

  const version = globalThis.game?.release?.version ?? globalThis.game?.version ?? "";
  const match = String(version).match(/^(\d+)/);
  return match ? Number(match[1]) : 0;
}

export function isFoundryV13() {
  return getFoundryMajorVersion() === 13;
}

export function isFoundryV14Plus() {
  return getFoundryMajorVersion() >= 14;
}

export function getHtmlElement(html) {
  if (!html) return null;
  if (globalThis.HTMLElement && html instanceof HTMLElement) return html;
  if (globalThis.HTMLElement && html[0] instanceof HTMLElement) return html[0];
  if (globalThis.HTMLElement && html.element instanceof HTMLElement) return html.element;
  if (Array.isArray(html) && globalThis.HTMLElement) {
    return html.find((el) => el instanceof HTMLElement) ?? null;
  }
  return html;
}

function readHTMLFromEditorInstance(editor) {
  if (!editor) return null;

  for (const method of ["getHTML", "getData", "getContent"]) {
    if (typeof editor[method] !== "function") continue;
    try {
      const value = editor[method]();
      if (value != null) return String(value);
    } catch (_) {
      // Try the next editor API shape.
    }
  }

  return null;
}

function getEditorScope(root, target) {
  const rootEl = getHtmlElement(root);
  if (!rootEl?.querySelector) return null;

  const targetString = String(target);
  const wrappers = rootEl.querySelectorAll?.("[data-editor-target]") ?? [];
  for (const wrapper of wrappers) {
    if (wrapper.getAttribute("data-editor-target") === targetString) return wrapper;
  }

  return rootEl;
}

function isEditorElementForTarget(element, target) {
  if (!element) return false;
  const targetString = String(target);
  const names = [
    element.name,
    element.getAttribute?.("name"),
    element.getAttribute?.("target"),
    element.dataset?.editorTarget
  ].filter(v => v != null).map(String);

  return names.includes(targetString);
}

export function getRichEditorElement(root, target = "system.notes") {
  const scope = getEditorScope(root, target);
  if (!scope?.querySelectorAll) return null;

  const candidates = [
    ...(scope.matches?.("prose-mirror") ? [scope] : []),
    ...scope.querySelectorAll("prose-mirror")
  ];

  return candidates.find(el => isEditorElementForTarget(el, target)) ?? candidates[0] ?? null;
}

function readHTMLFromProseMirrorElement(element) {
  if (!element) return null;

  for (const prop of ["value", "_value"]) {
    try {
      const value = element[prop];
      if (value != null) return String(value);
    } catch (_) {
      // Try the next value source.
    }
  }

  const input = element.querySelector?.("textarea[name], input[name]");
  if (input?.value != null) return String(input.value);

  return null;
}

/**
 * Read the current stored HTML value from a Foundry rich text editor.
 *
 * In v14 the Handlebars {{editor}} helper creates a <prose-mirror> custom
 * element. Prefer its form-associated value over raw .ProseMirror.innerHTML:
 * the raw DOM may contain ProseMirror bookkeeping nodes and should not be saved
 * back into system data.
 *
 * @param {Application} app
 * @param {HTMLElement|jQuery} root
 * @param {string} target
 * @param {string[]} selectors
 * @returns {string|null}
 */
export function getRichEditorHTML(app, root, target = "system.notes", selectors = []) {
  const proseMirror = getRichEditorElement(root, target);
  const fromElement = readHTMLFromProseMirrorElement(proseMirror);
  if (fromElement != null) return fromElement;

  const editorData = app?.editors?.[target];

  const fromPrimary = readHTMLFromEditorInstance(editorData?.editor);
  if (fromPrimary != null) return fromPrimary;

  const fromMce = readHTMLFromEditorInstance(editorData?.mce);
  if (fromMce != null) return fromMce;

  const scope = getEditorScope(root, target);
  if (!scope?.querySelector) return null;

  // Legacy fallback for older editor markup. Avoid .ProseMirror here because it
  // is the live editor DOM, not serialized document HTML.
  for (const selector of selectors) {
    if (String(selector).includes(".ProseMirror")) continue;
    const el = scope.querySelector(selector);
    if (el?.innerHTML != null) return String(el.innerHTML);
  }

  const fallback = scope.querySelector?.(".editor-content");
  if (fallback?.innerHTML != null) return String(fallback.innerHTML);

  return null;
}

/**
 * Keep the editor DOM, form-associated input, and display content synchronized
 * after a manual ProseMirror save. This prevents toggled editors from reopening
 * from an old hidden value after the document was updated with render=false.
 *
 * @param {Application} app
 * @param {HTMLElement|jQuery} root
 * @param {string} target
 * @param {string} html
 */
export function syncRichEditorHTML(app, root, target = "system.notes", html = "") {
  const rootEl = getHtmlElement(root);
  const scope = getEditorScope(rootEl, target);
  const value = String(html ?? "");

  const proseMirror = getRichEditorElement(rootEl, target);
  if (proseMirror) {
    try { proseMirror.value = value; } catch (_) {}
    try { proseMirror.setAttribute?.("value", value); } catch (_) {}
  }

  const cssEscape = globalThis.CSS?.escape ?? ((v) => String(v).replace(/"/g, '\"'));
  for (const field of scope?.querySelectorAll?.(`textarea[name="${cssEscape(target)}"], input[name="${cssEscape(target)}"]`) ?? []) {
    if (field.value !== value) {
      field.value = value;
      try { field.setAttribute("value", value); } catch (_) {}
    }
  }

  const content = scope?.querySelector?.(".editor-content");
  if (content && !content.closest?.("prose-mirror.active")) content.innerHTML = value;

  const editorData = app?.editors?.[target];
  if (editorData) {
    for (const key of ["content", "initial", "value"]) {
      try { editorData[key] = value; } catch (_) {}
    }
  }
}

/**
 * Ask a v14 <prose-mirror> element to serialize its active editor state, then
 * read the stored form value. This is safe for explicit save/close flows.
 *
 * @param {Application} app
 * @param {HTMLElement|jQuery} root
 * @param {string} target
 * @param {string[]} selectors
 * @returns {string|null}
 */
export function saveRichEditorHTML(app, root, target = "system.notes", selectors = []) {
  const proseMirror = getRichEditorElement(root, target);

  if (proseMirror) {
    try {
      // For toggled editors, save() is only valid while the editor is open.
      // Calling it against a closed or already-disconnected editor can leave the
      // native control in a broken inactive state in v13/v14.
      if (proseMirror.open && typeof proseMirror.save === "function") proseMirror.save();
    } catch (err) {
      console.warn(`CP2020: failed to serialize rich editor ${target}`, err);
    }

    const value = readHTMLFromProseMirrorElement(proseMirror);
    if (value != null) return value;
  }

  return getRichEditorHTML(app, root, target, selectors);
}

export async function itemFromDropData(data) {
  const implFactory = globalThis.Item?.implementation?.fromDropData;
  if (typeof implFactory === "function") return implFactory.call(globalThis.Item.implementation, data);

  const itemFactory = globalThis.Item?.fromDropData;
  if (typeof itemFactory === "function") return itemFactory.call(globalThis.Item, data);

  return data?.data ?? data;
}

function readCoreSetting(...keys) {
  for (const key of keys) {
    try {
      const value = globalThis.game?.settings?.get?.("core", key);
      if (value != null && value !== "") return value;
    } catch (_) {
      // Setting does not exist in this Foundry generation.
    }
  }
  return undefined;
}

function normalizeModeName(mode) {
  if (mode == null || mode === "") return undefined;
  return String(mode).trim().toLowerCase();
}

/**
 * Normalize a legacy v13 roll mode value.
 *
 * v13 Roll#toMessage expects options.rollMode values like publicroll/gmroll.
 * v14 keeps backwards-compatible roll-mode support, but its native API uses
 * message visibility modes instead.
 */
export function getRollMode(rollMode) {
  const normalized = normalizeModeName(rollMode);
  if (!normalized) return undefined;

  const modes = globalThis.CONST?.DICE_ROLL_MODES ?? {};

  if (["public", "publicroll", "roll"].includes(normalized)) return modes.PUBLIC ?? "publicroll";
  if (["private", "gm", "gmroll"].includes(normalized)) return modes.PRIVATE ?? "gmroll";
  if (["blind", "blindroll"].includes(normalized)) return modes.BLIND ?? "blindroll";
  if (["self", "selfroll"].includes(normalized)) return modes.SELF ?? "selfroll";

  return rollMode;
}

/**
 * Normalize a v14 chat message visibility mode.
 *
 * v14 ChatMessage.applyMode and Roll#toMessage expect values like
 * public/gm/blind/self. The function accepts both old roll modes and new
 * message modes so call sites can stay stable across v13/v14.
 */
export function getMessageMode(messageMode) {
  const normalized = normalizeModeName(messageMode);
  if (!normalized) return undefined;

  if (["public", "publicroll", "roll"].includes(normalized)) return "public";
  if (["private", "gm", "gmroll"].includes(normalized)) return "gm";
  if (["blind", "blindroll"].includes(normalized)) return "blind";
  if (["self", "selfroll"].includes(normalized)) return "self";
  if (["ic", "in-character", "incharacter"].includes(normalized)) return "ic";

  return messageMode;
}

export function getDefaultRollMode() {
  return getRollMode(readCoreSetting("rollMode", "messageMode") ?? "publicroll");
}

export function getDefaultMessageMode() {
  return getMessageMode(readCoreSetting("messageMode", "rollMode") ?? "public");
}

export function getPublicRollMode() {
  return getRollMode("public");
}

export function getPrivateRollMode() {
  return getRollMode("private");
}

export function getBlindRollMode() {
  return getRollMode("blind");
}

export function getSelfRollMode() {
  return getRollMode("self");
}

export function getPublicMessageMode() {
  return getMessageMode("public");
}

export function getPrivateMessageMode() {
  return getMessageMode("gm");
}

export function getBlindMessageMode() {
  return getMessageMode("blind");
}

export function getSelfMessageMode() {
  return getMessageMode("self");
}

export function getGMUserIds() {
  const recipients = globalThis.ChatMessage?.getWhisperRecipients?.("GM") ?? [];
  return recipients.map((u) => u.id).filter(Boolean);
}

function applyMessageModeToChatData(chatData, mode) {
  const messageMode = getMessageMode(mode);
  if (!messageMode) return chatData;

  if (typeof globalThis.ChatMessage?.applyMode === "function") {
    const applied = ChatMessage.applyMode(chatData, messageMode);
    return applied ?? chatData;
  }

  if (typeof globalThis.ChatMessage?.applyRollMode === "function") {
    const rollMode = getRollMode(messageMode);
    const applied = ChatMessage.applyRollMode(chatData, rollMode);
    return applied ?? chatData;
  }

  const gmIds = getGMUserIds();
  switch (messageMode) {
    case "gm":
      chatData.whisper = chatData.whisper?.length ? chatData.whisper : gmIds;
      chatData.blind = false;
      break;
    case "blind":
      chatData.whisper = chatData.whisper?.length ? chatData.whisper : gmIds;
      chatData.blind = true;
      break;
    case "self":
      chatData.whisper = [globalThis.game?.user?.id].filter(Boolean);
      chatData.blind = false;
      break;
    case "public":
      chatData.whisper = [];
      chatData.blind = false;
      break;
  }

  return chatData;
}

function resolveVisibilityMode({ rollMode, messageMode, useDefault = false } = {}) {
  if (messageMode != null && messageMode !== "") return getMessageMode(messageMode);
  if (rollMode != null && rollMode !== "") return isFoundryV14Plus() ? getMessageMode(rollMode) : getRollMode(rollMode);
  if (useDefault) return isFoundryV14Plus() ? getDefaultMessageMode() : getDefaultRollMode();
  return undefined;
}

function normalizeChatRolls(rolls) {
  if (!Array.isArray(rolls)) return rolls;
  return rolls.filter((roll) => roll?.dice?.length > 0);
}

/**
 * Evaluate a Roll only if it has not already been evaluated.
 *
 * @param {Roll} roll
 * @param {object} options
 * @returns {Promise<Roll>}
 */
export async function evaluateCyberpunkRoll(roll, options = {}) {
  if (!roll || roll._evaluated) return roll;
  return roll.evaluate(options);
}

/**
 * Create a ChatMessage with v13/v14-compatible visibility handling.
 *
 * Options accepted by this wrapper:
 * - rollMode: legacy v13-style roll mode (publicroll/gmroll/blindroll/selfroll)
 * - messageMode: v14-style visibility mode (public/gm/blind/self)
 * - useDefaultRollMode: apply the user's current chat roll/message mode explicitly
 */
export async function createCyberpunkChatMessage(data = {}, options = {}) {
  const { rollMode, messageMode, useDefaultRollMode = false, ...createOptions } = options ?? {};
  let chatData = { ...data };

  // In v13/v14 ordinary HTML chat messages do not need the old OTHER type.
  if (chatData.type == null) delete chatData.type;

  if (Array.isArray(chatData.rolls)) chatData.rolls = normalizeChatRolls(chatData.rolls);

  const mode = resolveVisibilityMode({ rollMode, messageMode, useDefault: useDefaultRollMode });
  if (mode != null) chatData = applyMessageModeToChatData(chatData, mode);

  return ChatMessage.create(chatData, createOptions);
}

/**
 * Send a single Roll to chat, using the correct v13/v14 visibility option.
 */
export async function rollToCyberpunkChatMessage(roll, messageData = {}, options = {}) {
  const { rollMode, messageMode, useDefaultRollMode = true, ...rollOptions } = options ?? {};
  await evaluateCyberpunkRoll(roll);

  const mode = resolveVisibilityMode({ rollMode, messageMode, useDefault: useDefaultRollMode });
  const finalOptions = { ...rollOptions };

  if (mode != null) {
    if (isFoundryV14Plus()) finalOptions.messageMode = getMessageMode(mode);
    else finalOptions.rollMode = getRollMode(mode);
  }

  return roll.toMessage(messageData, finalOptions);
}

/**
 * Build and create a system chat card containing one or more rolls.
 * This is preferred for custom system cards because it avoids Roll#toMessage
 * generating core roll HTML while still exposing rolls to dice modules.
 */
export async function createCyberpunkRollCard({
  rolls = [],
  speaker = undefined,
  content = "",
  sound = "sounds/dice.wav",
  flags = undefined,
  rollMode = undefined,
  messageMode = undefined,
  useDefaultRollMode = true,
  ...extraChatData
} = {}, createOptions = {}) {
  const evaluated = [];
  for (const roll of rolls) {
    if (!roll) continue;
    await evaluateCyberpunkRoll(roll);
    if (roll.dice?.length > 0) evaluated.push(roll);
  }

  const chatData = {
    user: globalThis.game?.user?.id,
    speaker,
    sound,
    content,
    rolls: evaluated,
    ...extraChatData
  };

  if (flags) chatData.flags = flags;
  if (!chatData.speaker) delete chatData.speaker;
  if (!chatData.sound) delete chatData.sound;

  return createCyberpunkChatMessage(chatData, { rollMode, messageMode, useDefaultRollMode, ...createOptions });
}
