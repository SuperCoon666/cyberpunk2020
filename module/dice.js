import { createCyberpunkRollCard, evaluateCyberpunkRoll, renderCyberpunkTemplate, rollToCyberpunkChatMessage } from "./compat.js";
export const BaseDie = "1d10x10";
export const DefaultRollTemplate = "systems/cyberpunk2020/templates/chat/default-roll.hbs";

export const formulaHasDice = function (formula) {
    return formula.match(/[0-9)][dD]/) || formula.match(/[dD][0-9(]/);
};

export const makeD10Roll = function(terms, rollData) {
  const extra = Array.isArray(terms)
    ? terms
    : (terms != null ? [terms] : []);

  const cleaned = extra
    .map(x => String(x ?? "").trim())
    .filter(s => s && s !== "+" && s !== "-");

  const parts = [BaseDie, ...cleaned];
  const formula = parts.join(" + ");

  return new Roll(formula, rollData);
}

// This is lifted from foundry.js so that we can apply the same prettiness, just... in a more sensible order in our own template; it'd be nice if rolls themselves contained this info
export function classifyRollDice(roll) {
    const parts = roll.dice.map(d => {
        const cls = d.constructor;
        return {
          formula: d.expression,
          total: d.total,
          faces: d.faces,
          flavor: d.flavor,
          subrolls: d.results.map(r => {
            const hasSuccess = r.success !== undefined;
            const hasFailure = r.failure !== undefined;
            const isMax = r.result === d.faces;
            const isMin = r.result === 1;
            return {
              result: d.getResultLabel(r),
              classes: [
                cls.name.toLowerCase(),
                "d" + d.faces,
                r.success ? "success" : null,
                r.failure ? "failure" : null,
                r.rerolled ? "rerolled" : null,
                r.exploded ? "exploded" : null,
                r.discarded ? "discarded" : null,
                !(hasSuccess || hasFailure) && isMin ? "min" : null,
                !(hasSuccess || hasFailure) && isMax ? "max" : null
              ].filter(c => c).join(" ")
            }
          })
        };
      });
    return parts;
}

/**
 * This class allows for making multiple rolls in a single card. For example, an attack roll and a damage roll.
 * The API is designed to make sure each roll WILL get an equivalent metadata, so users of Multiroll don't have to make sure to balance the number of rolls they add, and the metadata.
 * 
 * Example:
 *    let bigRoll = new Multiroll("Shootin'");
 *    bigRoll.addRoll(new Roll("1d10+3"), name="Attack");
 *    bigRoll.addRoll(new Roll("1d6+2"), name="Damage");
 *    bigRoll.execute();
 * 
 * Methods can be chained, e.g bigRoll.addRoll(...).addRoll(...)
 */
 export class Multiroll {
    /**
     * @param {string} title
     * @param {string} [flavor]
     * @param {object} [options]
     * @param {string} [options.messageMode] Visibility of the card. Undefined leaves the poster's
     *   own chat mode alone, which is what every card did before hidden tokens were whispered.
     */
    constructor(title, flavor="", { messageMode } = {}) {
        this.title = title;
        this.flavor = flavor;
        this.messageMode = messageMode;
        this.rolls = [];
        this.rollMetaData = [];
    }

    /**
     * 
     * @param {Roll} roll A FoundryVTT roll 
     * @param {data} metaData Extra data about the roll (such as name, crit thresholds). Crit threshold applies to a roll's first (dice) term, default its max amount
     */
    addRoll(roll, { name=undefined, flavor=undefined, critThreshold = undefined, fumbleThreshold = undefined } = {}, extra={}) {
        this.rolls.push(roll);
        // This should be fine if there are no dice - they'll end up as undefined, and that's dealt with in Multiroll
        if(critThreshold === undefined) {
            let firstDie = roll.terms?.find(term => term instanceof foundry.dice.terms.Die);
            if(!!firstDie)
                critThreshold = (firstDie.number * firstDie.faces);
        }
        if(fumbleThreshold === undefined) {
            let firstDie = roll.terms?.find(term => term instanceof foundry.dice.terms.Die);
            if(!!firstDie)
                fumbleThreshold = firstDie.number;
        }

        this.rollMetaData.push(foundry.utils.mergeObject({
            name: name,
            flavor: flavor, 
            critThreshold: critThreshold,
            fumbleThreshold: fumbleThreshold
        }, extra));
        return this;
    }

    /**
     * Note: You should provide either unevaluated Rolls, or fulfilledrolls (not promises). As things stand, promises will break a multiroll.
     * @param {*} speaker The speaker on the card for this multiroll
     * @param {string} templatePath Path to the template. eg systems/cyberpunk2020/templates/chat/default-roll.hbs
     * Template provided should be one that loops through rolls.
     * Example data provided to the template:
     * {
     *  user,
     *  title,
     *  flavor,
     *  rolls: [
     *      {roll: Roll, name, flavor, isCrit, isFumble, critThreshold, fumbleThreshold}
     *  ],
     *  ...
     * }
     */
    async execute(speaker, templatePath, extraTemplateData={}, flags=undefined) {
        await Promise.all(this.rolls.map((r) => evaluateCyberpunkRoll(r)));
        
        const fullTemplateData = foundry.utils.mergeObject({
            user: game.user.id,
            title: this.title,
            flavor: this.flavor,
            rolls: this.rolls.map((roll, i) => {
                let metaData = this.rollMetaData[i];
                let firstDiceTerm = roll.terms.find(term => term instanceof foundry.dice.terms.Die) || roll.terms[0];
                // Add name, flavor, critThreshold, fumbleThreshold etc. Also add whether crit or fumble.
                return foundry.utils.mergeObject(metaData, { 
                    roll: roll,
                    diceInfo: classifyRollDice(roll),
                    isCrit: metaData.critThreshold && firstDiceTerm.total >= metaData.critThreshold,
                    isFumble: metaData.fumbleThreshold && firstDiceTerm.total <= metaData.fumbleThreshold
                })
            }),
        }, extraTemplateData || {});


        // Filter chat rolls to only those that actually have dice, for Dice So Nice.
        // Deterministic helper rolls remain displayed in the template but are not attached as ChatMessage rolls.
        await createCyberpunkRollCard({
            rolls: this.rolls,
            speaker,
            content: await renderCyberpunkTemplate(templatePath, fullTemplateData),
            flags,
            messageMode: this.messageMode
        });
        return this;
    }

    async defaultExecute(extraTemplateData={}, flags=undefined) {
        return this.execute(undefined, DefaultRollTemplate, extraTemplateData, flags);
    }
}

