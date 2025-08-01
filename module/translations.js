export function getMartialKeyByName(name){
    for(const k in game.i18n.translations.CYBERPUNK.martials){
        if (game.i18n.translations.CYBERPUNK.martials[k] === name){
            return k
        }
    }
}

export function localize(key, data = {}) {
  return game.i18n.format("CYBERPUNK." + key, data);
}
