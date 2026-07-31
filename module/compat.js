/**
 * Shared helpers for editor, drop-data and chat-message handling.
 * Keep API shims here instead of spreading them across sheets, dialogs and
 * roll/chat code.
 */

export async function renderCyberpunkTemplate(path, data = {}, options = {}) {
  return foundry.applications.handlebars.renderTemplate(path, data, options);
}

export function getHtmlElement(html) {
  if (!html) return null;
  if (html instanceof HTMLElement) return html;

  // One live producer of a non-element, outside this system's control: item.apps can
  // hold another module's V1 sheet, whose .element is jQuery. It goes away with the V1
  // application layer.
  return html[0] instanceof HTMLElement ? html[0] : null;
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
      // native control in a broken inactive state.
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
  return Item.implementation.fromDropData(data);
}

function normalizeModeName(mode) {
  if (mode == null || mode === "") return undefined;
  return String(mode).trim().toLowerCase();
}

/**
 * Normalize a chat message visibility mode.
 *
 * ChatMessage.applyMode and Roll#toMessage expect public/gm/blind/self/ic.
 * Legacy roll-mode spellings are still accepted so stored fire options and
 * flags written by older versions keep working.
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

export function getDefaultMessageMode() {
  return getMessageMode(game.settings.get("core", "messageMode") || "public");
}

export function getPublicMessageMode() {
  return getMessageMode("public");
}

export function getGMUserIds() {
  return ChatMessage.getWhisperRecipients("GM").map((u) => u.id).filter(Boolean);
}

function applyMessageModeToChatData(chatData, mode) {
  const messageMode = getMessageMode(mode);
  if (!messageMode) return chatData;

  // ChatMessage.applyMode dereferences chatData.speaker for the "ic" mode, and
  // createCyberpunkRollCard deletes the key when no speaker was supplied.
  if (chatData.speaker == null) chatData.speaker = {};

  return ChatMessage.applyMode(chatData, messageMode) ?? chatData;
}

function resolveVisibilityMode({ rollMode, messageMode, useDefault = false } = {}) {
  if (messageMode != null && messageMode !== "") return getMessageMode(messageMode);
  if (rollMode != null && rollMode !== "") return getMessageMode(rollMode);
  if (useDefault) return getDefaultMessageMode();
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
 * Create a ChatMessage with explicit visibility handling.
 *
 * Options accepted by this wrapper:
 * - messageMode: visibility mode (public/gm/blind/self/ic)
 * - rollMode: legacy spelling of the same thing, still accepted
 * - useDefaultRollMode: apply the user's current chat message mode explicitly
 */
export async function createCyberpunkChatMessage(data = {}, options = {}) {
  const { rollMode, messageMode, useDefaultRollMode = false, ...createOptions } = options ?? {};
  let chatData = { ...data };

  if (chatData.type == null) delete chatData.type;

  if (Array.isArray(chatData.rolls)) chatData.rolls = normalizeChatRolls(chatData.rolls);

  const mode = resolveVisibilityMode({ rollMode, messageMode, useDefault: useDefaultRollMode });
  if (mode != null) chatData = applyMessageModeToChatData(chatData, mode);

  return ChatMessage.create(chatData, createOptions);
}

/**
 * Send a single Roll to chat with an explicit visibility mode.
 */
export async function rollToCyberpunkChatMessage(roll, messageData = {}, options = {}) {
  const { rollMode, messageMode, useDefaultRollMode = true, ...rollOptions } = options ?? {};
  await evaluateCyberpunkRoll(roll);

  const mode = resolveVisibilityMode({ rollMode, messageMode, useDefault: useDefaultRollMode });
  const finalOptions = { ...rollOptions };

  if (mode != null) finalOptions.messageMode = getMessageMode(mode);

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
