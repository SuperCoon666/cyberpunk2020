export { SortOrders, sortSkills }

// For now, these are arranged as they are in the book and on other sheets. But it seems a slightly arbitrary order, may change to match topstats, and have those in a sane order too.
// Order to consider stats in for skills. Lower values come first.
const statOrder = {
    // Don't have one of these be 0, that's falsy
    "special": 1,
    "int": 2,
    "ref": 3,
    "tech": 4,
    "cool": 5,
    "attr": 6,
    "luck": 7,
    "ma": 8,
    "bt": 9,
    "emp": 10,
}

const SortOrders = {
    Name: byName,
    Stat: byStat
}

function byName([a_name, a_val], [b_name, b_val]) {
    if(a_name > b_name) {
        return 1;
    }
    else if(a_name === b_name) {
        return 0;
    }
    return -1;
}

function byStat([a_name, a_val], [b_name, b_val]) {
    let order_a = statOrder[a_val.isSpecial ? "special" : a_val.stat] || -1;
    let order_b = statOrder[b_val.isSpecial ? "special" : b_val.stat] || -1;
    if(order_a > order_b) {
        return 1;
    }
    else if(order_a === order_b) {
        return 0;
    }
    return -1;
}

/* This would usually be in actor-sheet.js; sorting stats is mostly for UX purposes. But that'd mean creating a sorted version of stats EVERY time the sheet opens. And CP2020 has 89 stats by default; enough for me to not want to do that. So we sort in the actor itself */
// Really just a fancy "sort object", but I've set this module up specifically for actor skills
function sortSkills(skills, sortOrder) {
    if(!sortOrder) {
        console.warn("No sort order given. Returning original skill list");
        return skills;
    }
    let unsorted = Object.entries(skills);
    let sorted = unsorted.sort(sortOrder);
    return sorted.map(([key, value]) => key);
}