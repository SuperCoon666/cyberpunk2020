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

export async function itemFromDropData(data) {
  const implFactory = globalThis.Item?.implementation?.fromDropData;
  if (typeof implFactory === "function") return implFactory.call(globalThis.Item.implementation, data);

  const itemFactory = globalThis.Item?.fromDropData;
  if (typeof itemFactory === "function") return itemFactory.call(globalThis.Item, data);

  return data?.data ?? data;
}

export function getRollMode(rollMode) {
  if (rollMode == null || rollMode === "") return undefined;

  const modes = globalThis.CONST?.DICE_ROLL_MODES ?? {};
  const normalized = String(rollMode).toLowerCase();

  if (["public", "publicroll", "roll"].includes(normalized)) return modes.PUBLIC ?? "publicroll";
  if (["private", "gm", "gmroll"].includes(normalized)) return modes.PRIVATE ?? "gmroll";
  if (["blind", "blindroll"].includes(normalized)) return modes.BLIND ?? "blindroll";
  if (["self", "selfroll"].includes(normalized)) return modes.SELF ?? "selfroll";

  return rollMode;
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

function applyRollModeToChatData(chatData, rollMode) {
  const mode = getRollMode(rollMode);
  if (!mode) return chatData;

  if (typeof globalThis.ChatMessage?.applyRollMode === "function") {
    const applied = ChatMessage.applyRollMode(chatData, mode);
    return applied ?? chatData;
  }

  const gmIds = globalThis.ChatMessage?.getWhisperRecipients?.("GM")?.map((u) => u.id) ?? [];
  switch (mode) {
    case "gmroll":
      chatData.whisper = gmIds;
      chatData.blind = false;
      break;
    case "blindroll":
      chatData.whisper = gmIds;
      chatData.blind = true;
      break;
    case "selfroll":
      chatData.whisper = [globalThis.game?.user?.id].filter(Boolean);
      chatData.blind = false;
      break;
    case "publicroll":
    case "roll":
      delete chatData.whisper;
      delete chatData.blind;
      break;
  }

  return chatData;
}

export async function createCyberpunkChatMessage(data = {}, options = {}) {
  const { rollMode, ...createOptions } = options ?? {};
  let chatData = { ...data };

  // In v13/v14 ordinary HTML chat messages do not need the old OTHER type.
  if (chatData.type == null) delete chatData.type;

  if (rollMode != null) chatData = applyRollModeToChatData(chatData, rollMode);

  return ChatMessage.create(chatData, createOptions);
}

export async function rollToCyberpunkChatMessage(roll, messageData = {}, options = {}) {
  const { rollMode, ...rollOptions } = options ?? {};
  const finalOptions = { ...rollOptions };
  if (rollMode != null) finalOptions.rollMode = getRollMode(rollMode);
  return roll.toMessage(messageData, finalOptions);
}
