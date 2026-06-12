function _normalizeMartialName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\(\d+\)/g, "")
    .replace(/~/g, "")
    .replace(/\s*:\s*/g, ": ")
    .replace(/\s+/g, " ")
    .trim();
}

export function getMartialKeyByName(name) {
  const martials = game.i18n?.translations?.CYBERPUNK?.martials;
  if (!martials) return undefined;

  const target = _normalizeMartialName(name);
  for (const k in martials) {
    if (_normalizeMartialName(martials[k]) === target) {
      return k;
    }
  }

  return undefined;
}

export function localize(key, data = {}) {
  return game.i18n.format("CYBERPUNK." + key, data);
}
