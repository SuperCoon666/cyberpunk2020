export function getMartialKeyByName(name){
    for(const k in game.i18n.translations.CYBERPUNK.martials){
        if (game.i18n.translations.CYBERPUNK.martials[k] === name){
            return k
        }
    }
}