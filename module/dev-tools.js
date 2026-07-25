// Tools useful for using from Foundry's F12 console that don't particularly have a place elsewhere.
// To use the below functions in console, run `const DevTools = await import("./systems/cyberpunk2020/module/dev-tools.js")`
// You can then run them with DevTools.functionName
// It's entirely possible this file may be removed at some point, as it's kinda useful for development but not for the system itself.
import { attackSkills } from "./lookups.js";

/**
* Async generator that iterates over the actual items under the hood of a compendium. Used as follows:
* ```
* for await(let doc of compendiumItems) {
*   console.log(doc.id);
* }
* ```
* @param {*} packID The pack's ID - eg "cyberpunk2020.name"
*/
export async function* compendiumItems(packID) {
    let pack = game.packs.get(packID);
    for(let {_id} of pack.index.values()) {
        yield await pack.getDocument(_id);
    }
}

/**
 * Return the first item in a compendium with the given ID. Useful for quickly seeing the "shape" of items in the compendium that you'll be changing
 * @param {string} packID ID of the compendium, eg cyberpunk2020.rifles 
 * @returns First item in the given compendium.
 */
export async function exampleCompendiumItem(packID) {
    return await compendiumItems(packID).next();
}

/**
 * Function written specifically to fix `attackSkill` being "undefined" in a compendium. Uses `attackSkills` from `lookups.js` to ensure there's only one option for skills and then update to that. If there are multiple choices (such as a weapon with Melee weaponType), this function skips that item and provides a warning. If needed, interactivity and more flexibility (ie not just for attackSkill) might be added at a later stage to allow choosing-as-you-go, but that's if you KNOW what the given item needs.
 * This likely doesn't need to stay around for long, but it's here just in case
 * Note: Back up your compendium before using this! Then turn edit lock to false on the compendium.
 * @param {*} packID ID of the compendium to fix these in. 
 * @returns An array of changed documents.
 */
export async function fixAttackSkillUndefineds(packID) {
    let skillsPerWeaponType = attackSkills;
    return game.packs.get(packID).updateAll((document) => {
        let system = document.system;
        let choices = skillsPerWeaponType[system.weaponType];
        if(choices == undefined || choices.length == 0) {
            // No changes if we haven't got options
            return {};
        }
        else if(choices.length == 1) {
            let update = {"system.attackSkill": choices[0]};
            console.log(update);
            return update;
        }
        else {
            console.warn(`Can't choose attack skill for item with ID ${document.id}; weapons of type ${system.weaponType} have multiple possible attack skills.`);
            return {};
        }
    // Gotta have an undefined attackSkill to qualify
    },
    (document) => {
        let attackSkill = document.system.attackSkill;
        return attackSkill == undefined || attackSkill == "undefined"
    });
}