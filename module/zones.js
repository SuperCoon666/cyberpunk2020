import { isCombatAutomationEnabled, ranges } from "./lookups.js";
import { applyHitsToActor, attackerIsHidden, hiddenMessageMode, requestSave, ATTACK_FLAG_VERSION } from "./damage.js";
import { createCyberpunkChatMessage } from "./compat.js";
import { displayName, localize, localizeParam, localizeParamEscaped, rollLocation, isRollableFormula } from "./utils.js";

/**
 * Ch. 07's Grenade Table (`dev/rulebooks/corebook/07-friday-night-firefight.md:187-197`) as it is
 * printed: a 3x3 ring around the target with 1 sitting below 3 and 10 above 8, so 1 and 3 both
 * point south and 8 and 10 both north. Screen y grows downward, which is what makes "north"
 * negative — the orientation is a convention the book does not set (plan assumption 3).
 */
const SCATTER_DIRECTIONS = {
  1: [0, 1], 2: [-1, 1], 3: [0, 1], 4: [1, 1],
  5: [-1, 0], 6: [1, 0],
  7: [-1, -1], 8: [0, -1], 9: [1, -1], 10: [0, -1]
};

/**
 * Ch. 07's Shotgun Table (`:845-853`) is three bands wide — Close/PB, Medium, Long — while the
 * system carries five. The two ends fold inwards.
 */
const SPREAD_BANDS = {
  [ranges.pointBlank]: "Short",
  [ranges.close]: "Short",
  [ranges.medium]: "Medium",
  [ranges.long]: "Long",
  [ranges.extreme]: "Long"
};

/**
 * Scene units to pixels. `distancePixels` is `grid.size / grid.distance`, so this converts the
 * **scene's** own unit — which this system takes to be metres, the assumption `T48` records.
 *
 * @param {number} metres
 * @returns {number}
 */
export function metresToPixels(metres) {
  return (Number(metres) || 0) * canvas.dimensions.distancePixels;
}

/**
 * The unit vector a Grenade Table result points along. Normalised, so a diagonal lands the rolled
 * number of metres away rather than 1.41 times it.
 *
 * @param {number} direction A 1d10 result
 * @returns {{dx: number, dy: number}}
 */
export function scatterVector(direction) {
  const [dx, dy] = SCATTER_DIRECTIONS[direction];
  const length = Math.hypot(dx, dy);
  return { dx: dx / length, dy: dy / length };
}

/**
 * Where a missed area attack actually landed.
 *
 * @param {{x: number, y: number}} origin The point that was aimed at, in pixels
 * @param {number} direction A 1d10 result on the Grenade Table
 * @param {number} metres A second 1d10, in scene units
 * @returns {{x: number, y: number}}
 */
export function scatterCentre(origin, direction, metres) {
  const { dx, dy } = scatterVector(direction);
  const distance = metresToPixels(metres);
  return { x: origin.x + (dx * distance), y: origin.y + (dy * distance) };
}

/**
 * The blast geometry an ammunition item describes, normalised. Ammunition is user-authored data,
 * so every number is taken as read rather than trusted.
 *
 * @param {object|null} ammo A snapshot from snapshotAmmo
 * @returns {{radius: number, fullDamageWithin: number, multipliers: number[]}}
 */
export function blastProfile(ammo) {
  const radius = Math.max(0, Number(ammo?.blastRadius) || 0);

  // Ch. 07:839 is full damage across the whole radius, so a round built from the book has no
  // falloff — and the rings are not offered on the sheet (owner, 2026-08-11). Dropping them here
  // rather than only in the template is what stops a round authored before that ruling from going
  // on quartering its damage with no control left to see it. The ring arithmetic below and the
  // stored multipliers both stay: the DLC that gives them a rule restores this line and the
  // controls together.
  return { radius, fullDamageWithin: radius, multipliers: [] };
}

/**
 * What fraction of the blast's damage reaches a target this far from the centre.
 *
 * @param {number} distance In scene units
 * @param {{radius: number, fullDamageWithin: number, multipliers: number[]}} profile
 * @returns {number} 0 outside the radius
 */
export function blastMultiplierFor(distance, { radius = 0, fullDamageWithin = 0, multipliers = [] } = {}) {
  if (!(distance <= radius)) return 0;
  if (distance <= fullDamageWithin) return 1;
  // RAW is full damage across the whole radius (ch. 07:839); the falloff rings are an ammunition
  // option, so an ammunition that configures none keeps the book's own answer.
  if (!multipliers.length) return 1;

  const ringWidth = (radius - fullDamageWithin) / multipliers.length;
  const index = Math.min(multipliers.length - 1,
    Math.floor((distance - fullDamageWithin) / ringWidth));
  return multipliers[index];
}

/**
 * The falloff rings as bands, for a card a GM has to apply by hand.
 *
 * @param {{radius: number, fullDamageWithin: number, multipliers: number[]}} profile
 * @returns {Array<{from: number, to: number, multiplier: number}>} empty when there is no falloff
 */
export function blastRings({ radius = 0, fullDamageWithin = 0, multipliers = [] } = {}) {
  if (!multipliers.length || !(radius > fullDamageWithin)) return [];

  const ringWidth = (radius - fullDamageWithin) / multipliers.length;
  return multipliers.map((multiplier, i) => ({
    from: (fullDamageWithin + (i * ringWidth)).toNearest(0.01),
    to: (fullDamageWithin + ((i + 1) * ringWidth)).toNearest(0.01),
    multiplier
  }));
}

/**
 * The damage one target takes off a blast, floored the way every other damage total in the system
 * is: a hit that connects at all is worth at least a point.
 *
 * @param {number} damage The blast's rolled damage
 * @param {number} multiplier
 * @returns {number}
 */
export function blastDamageFor(damage, multiplier) {
  const scaled = (Number(damage) || 0) * (Number(multiplier) || 0);
  return scaled > 0 ? Math.max(1, Math.floor(scaled)) : 0;
}

/**
 * Whether the loaded ammunition throws an area-effect charge. The round decides, not the weapon
 * (D77): a splash happens because the round carries a blast, which is what lets any weapon fire a
 * charge the way `isSpreadAttack` already lets any weapon fire shot.
 *
 * @param {object|null} ammo A snapshot from snapshotAmmo
 * @returns {boolean}
 */
export function isBlastAttack(ammo) {
  return Number(ammo?.blastRadius) > 0;
}

/**
 * The shotgun pattern at this range. Ch. 07's table gives both the width and the damage per band;
 * an ammunition that leaves the damage blank keeps the weapon's own formula.
 *
 * @param {string} range One of the `ranges` bands
 * @param {object|null} ammo A snapshot from snapshotAmmo
 * @returns {{band: string|undefined, width: number, damage: string}}
 */
export function spreadProfileFor(range, ammo) {
  const band = SPREAD_BANDS[range];
  return {
    band,
    width: Math.max(0, Number(ammo?.[`spreadWidth${band}`]) || 0),
    damage: String(ammo?.[`spreadDamage${band}`] ?? "")
  };
}

/**
 * Whether this shot spreads into a pattern rather than landing on one target.
 *
 * @param {object|null} ammo A snapshot from snapshotAmmo
 * @param {string} range
 * @returns {boolean}
 */
export function isSpreadAttack(ammo, range) {
  return ammo?.spreadMode === "spread" && spreadProfileFor(range, ammo).width > 0;
}

/**
 * Let the acting client put the blast where they mean it, without writing anything.
 *
 * `create: false` returns the preview document itself and never touches the database, which is why
 * this works for a player and is not blocked by a paused world — only creation is gated
 * (`client/canvas/layers/regions.mjs:738`, 14.365.0).
 *
 * @param {number} radius In scene units
 * @param {string} name The region's label while it is being placed
 * @returns {Promise<{x: number, y: number}|null>} null when the placement was dismissed
 */
export async function pickBlastCentre(radius, name) {
  const region = await canvas.regions.placeRegion({
    name,
    shapes: [{ type: "circle", x: 0, y: 0, radius: metresToPixels(radius) }],
    levels: [canvas.level.id],
    visibility: CONST.REGION_VISIBILITY.ALWAYS
  }, { create: false });
  if (!region) return null;

  const { x, y } = region.shapes[0];
  return { x, y };
}

/**
 * A fire zone left on the scene by suppressive fire. Everything a crossing needs travels in the
 * behaviour rather than in the card, because the zone outlives the message that made it.
 *
 * `static events` rather than a configurable `events` field: the zone always does the one thing.
 * Core reads the same registration to decide where to split a movement path — a behaviour that
 * subscribes to `TOKEN_MOVE_IN` gets a checkpoint inserted at the region boundary
 * (`client/documents/token.mjs:2560-2593`, 14.365.0), which is what makes a token that crosses the
 * zone and stops beyond it trigger at all.
 */
export class SuppressiveFireBehavior extends foundry.data.regionBehaviors.RegionBehaviorType {

  /** @override */
  static defineSchema() {
    const { NumberField, StringField, BooleanField, ObjectField } = foundry.data.fields;
    return {
      saveDC: new NumberField({ required: true, integer: true, initial: 0, min: 0 }),
      damageFormula: new StringField({ required: true, initial: "1d6" }),
      ap: new BooleanField(),
      ammo: new ObjectField({ nullable: true, initial: null })
    };
  }

  /**
   * One token crossing the fire zone. Region events arrive on **every** client, so the behaviour
   * gates itself rather than trusting the caller — the same single-writer rule the apply path and
   * core's own behaviours use (`pause-game.mjs:38`, `toggle-behavior.mjs:55`).
   *
   * @param {object} event A tokenMoveIn or tokenMoveWithin region event
   * @this {SuppressiveFireBehavior}
   */
  static async #onCrossing(event) {
    if (!game.user.isActiveGM) return;
    // A zone laid while automation was on goes inert rather than being deleted: the region stays
    // visible for the GM to remove, and the end-of-combat sweep still takes it.
    if (!isCombatAutomationEnabled()) return;
    await resolveZoneCrossing(this, event.data.token);
  }

  /** @override */
  static events = {
    [CONST.REGION_EVENTS.TOKEN_MOVE_IN]: this.#onCrossing,
    [CONST.REGION_EVENTS.TOKEN_MOVE_WITHIN]: this.#onCrossing
  };
}

/** Which tokens have already saved against a zone, and when. */
const CROSSED_FLAG = "suppressed";

/** Marks the Regions this system laid, so combat cleanup leaves the GM's own alone. */
export const SUPPRESSION_FLAG = "suppression";

/** The card a drawn zone belongs to, by message id: what the GM's hide toggle and the sweep find. */
export const ZONE_FLAG = "zone";

/** The encounter a zone was laid in, by combat id — what keeps one fight's sweep out of another. */
export const COMBAT_FLAG = "combat";

/**
 * The encounter a zone laid on this scene belongs to (D141).
 *
 * Never `game.combat`: that getter is the laying client's own tracker selection
 * (`client/game.mjs:1692-1696`, 14.365.0), which is the coupling `T114`/`T290` were fixed to
 * remove. A scene-less encounter applies everywhere, a bound one only to its own scene.
 *
 * **`active` is a tie-break, not the filter**, and that is measured rather than preferred: the
 * server keeps exactly one active Combat in the whole world — activating one clears the flag on
 * every other, with no scene filter (`dist/database/documents/combat.mjs`
 * `_preUpdateOperation`) — so a split party's second fight, which is the case this stamp exists
 * for, is never the active one.
 *
 * @param {Scene} scene
 * @returns {Combat|null}
 */
function zoneCombat(scene) {
  const running = game.combats.filter(c => c.started && (!c.scene || c.scene === scene));
  return running.find(c => c.active) ?? running[0] ?? null;
}

/**
 * D121 — a colour per kind, so a crater, a pattern and a fire zone on one map read apart. Firebrick
 * is the system's own red (`css/cyberpunk2020.css:604`); the rest are picked to stay apart from it
 * and from each other where two zones overlap. `sweep` (`T252`) joins the same way.
 */
const ZONE_COLOURS = {
  blast: "#b22222",
  spread: "#c25e00",
  sweep: "#8e44ad",
  suppression: "#3f6fa8",
  caught: "#e8c547"
};

/**
 * Resolve one token's crossing of a fire zone: one save, and on a failure 1D6 randomly located
 * rounds through the damage pipeline (ch. 07:731-733).
 *
 * @param {SuppressiveFireBehavior} zone
 * @param {TokenDocument} token
 * @returns {Promise<void>}
 */
async function resolveZoneCrossing(zone, token) {
  const actor = token.actor;
  if (!actor) return;

  // RAW asks for one save per target "during this attack" and this zone outlives the attack, so a
  // combat turn is what stands in for it. Outside an encounter there is no turn to reset on and
  // the book's own answer — one save per target per zone — is what is left.
  //
  // The encounter is the zone's own scene's, never `game.combat`: that getter is the reading
  // client's tracker selection (`client/game.mjs:1692-1696`, 14.365.0) and `isActive` is
  // `active && scene.isView` (`client/documents/combat.mjs:118-121`), so the active GM viewing
  // another scene got `"once"` and re-asked the save on every re-entry (`T114`, the `T87` family).
  // This is core's own resolution (`client/documents/collections/combat-encounters.mjs:44-55`)
  // with the viewport dropped and the zone's scene put in its place: `active` is the world flag,
  // `isView` was the client half. A scene-less encounter applies everywhere, a bound one only to
  // its own scene.
  const combat = game.combats.find(c =>
    c.active && c.started && (!c.scene || c.scene === zone.scene));
  const crossing = combat ? `${combat.id}.${combat.round}.${combat.turn}` : "once";
  const saved = zone.behavior.getFlag("cyberpunk2020", CROSSED_FLAG) ?? {};
  if (saved[token.id] === crossing) return;

  // The zone's damage formula is user-authored and outlives the weapon it was laid from, so it is
  // checked here rather than only at the sheet (`T120`, D33) — and before the flag below, so a
  // zone nobody can roll costs the token nothing.
  if (!isRollableFormula(zone.damageFormula)) return;

  await zone.behavior.setFlag("cyberpunk2020", CROSSED_FLAG, { ...saved, [token.id]: crossing });

  // The save card that follows says nothing about why it is being rolled, so this is what makes the
  // crossing legible. The shooter is read off the **card** the zone was laid from, never off the
  // Region: a Region is world data at `visibility: ALWAYS`, so a persisted uuid there named the
  // ambusher to any player who opened a console — defeating the very suppression D31 pays for
  // (`T115`). The Region keeps only the link, and a Region that outlives its card resolves nothing.
  const card = game.messages.get(
    String(zone.behavior.region?.getFlag("cyberpunk2020", ZONE_FLAG) ?? ""));
  const attackerUuid = card?.flags?.cyberpunk2020?.attack?.attackerActorUuid;
  const attacker = attackerUuid ? await fromUuid(attackerUuid) : null;
  // The shooter's own token, off the card's speaker — D133 wants the token's name, and the
  // speaker is where the shooter's client recorded which token fired. Without it a linked actor
  // would fall back to its prototype and show the sheet name the players are not meant to see.
  const attackerToken = card?.speaker?.token
    ? game.scenes.get(card.speaker.scene)?.tokens.get(card.speaker.token)
    : null;
  // D131 — an ambusher is *labelled* rather than passed over in silence, «чтоб было понятно что
  // вообще происходит»: the crossing was the one surface that dropped the clause entirely, where
  // the two defence notices already say "an unseen attacker". A shooter who cannot be resolved at
  // all is a different sentence again — that one really is unknown, not withheld.
  const content = !attacker
    ? localizeParamEscaped("ZoneCrossingUnknown", { target: token.name })
    : attackerIsHidden(attacker)
      ? localizeParamEscaped("ZoneCrossingHidden", { target: token.name })
      : localizeParamEscaped("ZoneCrossing",
        { target: token.name, attacker: displayName(attacker, attackerToken) });
  await createCyberpunkChatMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    content
  }, { messageMode: hiddenMessageMode(token.hidden) });

  const save = await requestSave(actor, "zone", {
    dc: zone.saveDC, messageMode: hiddenMessageMode(token.hidden), token
  });
  if (save.success) return;

  const hitsRoll = await new Roll("1d6").evaluate();
  const hits = [];
  for (let i = 0; i < hitsRoll.total; i++) {
    const damageRoll = await new Roll(String(zone.damageFormula)).evaluate();
    hits.push({
      zone: (await rollLocation(actor)).areaHit,
      damage: Math.max(0, Math.floor(damageRoll.total))
    });
  }

  await applyHitsToActor(actor, {
    hits, ap: zone.ap, ammo: zone.ammo, targetName: token.name,
    token, sceneId: zone.scene?.id ?? "",
    messageMode: hiddenMessageMode(token.hidden)
  });
}

/**
 * Let the shooter lay the fire corridor where they mean it, without writing anything.
 *
 * The rectangle's origin is the middle of its near edge (`anchorX: 0, anchorY: 0.5`), which is both
 * where the cursor holds it and what the mouse wheel rotates it around — so the corridor swings
 * from the muzzle end onto the line of fire instead of pivoting on a corner.
 *
 * @param {number} width The fire zone's width in scene units — the number the save divides by
 * @param {number} length How far down the corridor the fire reaches, in scene units
 * @param {string} name The region's label while it is being placed
 * @returns {Promise<object|null>} the placed geometry, or null when the placement was dismissed
 */
export async function placeSuppressionZone(width, length, name) {
  const region = await canvas.regions.placeRegion({
    name,
    shapes: [{
      type: "rectangle",
      x: 0,
      y: 0,
      width: metresToPixels(length),
      height: metresToPixels(width),
      anchorX: 0,
      anchorY: 0.5
    }],
    levels: [canvas.level.id],
    visibility: CONST.REGION_VISIBILITY.ALWAYS
  }, { create: false });
  if (!region) return null;

  const { shapes, levels } = region.toObject();
  return { sceneId: canvas.scene.id, shapes, levels };
}

/**
 * Lay a suppression card's zone, from either of the two ways in — the active GM's `createChatMessage`
 * hook, or the card's own button when no GM was connected to run it.
 *
 * Idempotent by the Region rather than by ordering: the two paths can overlap, because
 * `renderChatMessageHTML` runs while the hook's own create is still in flight, and a burst that
 * laid two zones would ask every crossing token to save twice (`T125`).
 *
 * @param {ChatMessage} message
 * @returns {Promise<RegionDocument|null>} null when there is nothing to lay, or it is laid already
 */
export async function layZoneFromMessage(message) {
  const attack = message?.flags?.cyberpunk2020?.attack;
  if (attack?.kind !== "suppression" || !attack.zone) return null;
  if (zoneRegions(message).length) return null;

  return createSuppressionZone(attack.zone, attack.behaviour, message.id);
}

/**
 * Lay the fire zone the card describes on its own scene. A Region is a scene document, so only a
 * GM can write it: the shooter previews, the active GM creates, and with no GM connected the card
 * carries the button that lays it when one arrives (`T125`).
 *
 * @param {object} zone The card's zone payload
 * @param {object} behaviour What a crossing needs: name, saveDC, damageFormula, ap, ammo
 * @param {string} messageId The card that laid it, so the GM's hide toggle finds it (D122)
 * @returns {Promise<RegionDocument|null>} null when the scene is gone
 */
export async function createSuppressionZone(zone, behaviour, messageId = "") {
  const scene = game.scenes.get(String(zone?.sceneId ?? ""));
  if (!scene) return null;

  const { name, ...system } = behaviour;
  const [region] = await scene.createEmbeddedDocuments("Region", [{
    name,
    color: ZONE_COLOURS.suppression,
    shapes: zone.shapes,
    levels: zone.levels,
    visibility: CONST.REGION_VISIBILITY.ALWAYS,
    // D141 — the zone names the fight it belongs to, so ending one encounter does not sweep a
    // second one's zones off a second scene. Stamped at creation, because that is the only moment
    // the answer is knowable: the sweep runs after the encounter is already gone.
    flags: {
      cyberpunk2020: {
        [SUPPRESSION_FLAG]: true,
        [ZONE_FLAG]: messageId,
        [COMBAT_FLAG]: zoneCombat(scene)?.id ?? ""
      }
    },
    behaviors: [{ type: "suppressiveFire", name, system }]
  }]);

  return region ?? null;
}

/**
 * The scene a zone payload was measured on.
 *
 * The payload carries pixel coordinates, so the scene is the only thing that makes them mean
 * anything: reading them off `canvas` applied the zone to whichever scene the GM happened to be
 * looking at (`T59`). A scene that has since been deleted is the one case the apply path cannot
 * resolve and must refuse.
 *
 * @param {object} blast The card's blast payload
 * @returns {Scene|null}
 */
export function zoneScene(blast) {
  return game.scenes.get(String(blast?.sceneId ?? "")) ?? null;
}

/** The eight steps the region search may take from a lattice point. */
const BLAST_STEPS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

/**
 * The movement-blocking walls a blast this size can meet, off the payload's own level.
 *
 * D72 — movement only, the channel the shotgun corridor already truncates on: what stops an
 * explosion is a physical obstruction, and a window is exactly the wall that blocks one and not a
 * look. D76's four cases then cost nothing. An open door's edge has every channel zeroed
 * (`client/documents/wall.mjs:151-154`, 14.365.0), so open passes while closed and locked block; a
 * secret door is a wall until it is opened, so it blocks exactly like the wall it hides in; and a
 * plain segment test reads no `dir`, so a one-way wall blocks from both sides.
 *
 * @param {Level} level The level the blast was placed on
 * @param {{x: number, y: number}} centre
 * @param {number} radiusPixels
 * @returns {Edge[]}
 */
function blastEdges(level, centre, radiusPixels) {
  const reach = new PIXI.Rectangle(centre.x - radiusPixels, centre.y - radiusPixels,
    radiusPixels * 2, radiusPixels * 2);

  // `getEdges` initializes the level's edges on entry, which is what makes all of this work on a
  // scene nobody is looking at (`client/canvas/geometry/edges/edges.mjs:138`, 14.365.0).
  //
  // `includeOuterBounds` defaults to **true** and the canvas border is added whatever `reach` says —
  // `collisionTest` is not applied to bounds unless `collisionTestBounds` is set (`edges.mjs:147-151`,
  // 14.365.0). Left at the default the edge set is never empty, so the "nothing to go around" exit
  // below could not fire and every blast on every scene ran the lattice search. It caught nothing
  // and lost nothing — a token outside the canvas is not on the scene — but the drawing branches on
  // that exit, so it has to mean what it says.
  return [...level.edges.getEdges(reach, {
    includeOuterBounds: false,
    collisionTest: edge => (edge.move === CONST.WALL_MOVEMENT_TYPES.NORMAL)
      // D76 — a charge laid against a wall sits *on* that line rather than behind it, so it is
      // stopped by it in neither direction. Core's own sweep drops a collinear edge the same way
      // (`clockwise-sweep.mjs:269-270`).
      && (foundry.utils.orient2dFast(edge.a, edge.b, centre) !== 0)
  })];
}

/**
 * Whether a wall stands between two points.
 *
 * @param {Edge[]} edges
 * @param {{x: number, y: number}} from
 * @param {{x: number, y: number}} to
 * @returns {boolean}
 */
function wallBetween(edges, from, to) {
  return edges.some(edge => foundry.utils.lineSegmentIntersects(from, to, edge.a, edge.b));
}

/**
 * The ground a blast can actually reach, as the lattice of points its pressure travels over.
 *
 * D73 — a blast wraps: a target around a corner is caught when the shortest way round is inside the
 * radius, not when it stands in a line-of-sight shadow. Core's own pathfinding is bound to the
 * canvas (`Token#findMovementPath`) and the applying GM may be looking at another scene, so this is
 * a search of its own over a lattice one **scene unit** wide — a metre, the unit `T48` records —
 * tested against the level's movement-blocking edges. A grid square is not the step: the scene sets
 * how many units one is worth, and the ruling was measured in metres with diagonals at √2. The
 * distances are the way round, in scene units, which is what makes the falloff rings answer the
 * wall too.
 *
 * Returned rather than consumed, because the same region is what a splash has to be *drawn* as
 * (D74, `T247`).
 *
 * @param {object} blast The card's blast payload
 * @returns {{centre: object, step: number, points: Map<string, object>, edges: Edge[]}|null}
 *   null wherever walls do not apply, each case leaving the straight-line rule exactly as it was
 */
export function blastRegion(blast) {
  const scene = zoneScene(blast);
  // A corridor payload (a shotgun pattern, and now a flamethrower sweep, `T252`) carries `levelId`
  // too since `T284`, but meets walls through `patternWallBetween`'s own binary gate — D115 rules
  // it never wraps, so it must never reach this search. A round that goes through them (D75) is
  // asking for the plain disc as well.
  if (!scene || !blast.levelId || blast.throughWalls || blast.corridor) return null;

  const radius = Math.max(0, Number(blast.radius) || 0);
  if (!radius) return null;

  const level = scene.levels.get(blast.levelId) ?? scene.initialLevel;
  const centre = { x: blast.x, y: blast.y };
  // Pixels per scene unit, off the payload's own scene: `canvas.dimensions` is the applying GM's
  // scene, which is the one thing this path may never read (`T59`).
  const step = scene.grid.size / scene.grid.distance;
  const edges = blastEdges(level, centre, radius * step);
  // Nothing in reach to go around, so the straight line is already the shortest way to everything.
  if (!edges.length) return null;

  const origin = { i: 0, j: 0, x: centre.x, y: centre.y, distance: 0 };
  const points = new Map([["0,0", origin]]);

  // Nearest-first rather than a flood fill: a diagonal step costs more than a straight one, so the
  // first way to a point is not always the shortest one.
  const queue = [origin];
  while (queue.length) {
    let nearest = 0;
    for (let k = 1; k < queue.length; k++) {
      if (queue[k].distance < queue[nearest].distance) nearest = k;
    }
    const from = queue.splice(nearest, 1)[0];

    for (const [di, dj] of BLAST_STEPS) {
      const distance = from.distance + Math.hypot(di, dj);
      if (distance > radius) continue;

      const i = from.i + di;
      const j = from.j + dj;
      if (points.get(`${i},${j}`)?.distance <= distance) continue;

      const to = { i, j, x: centre.x + (j * step), y: centre.y + (i * step), distance };
      if (wallBetween(edges, from, to)) continue;

      points.set(`${i},${j}`, to);
      queue.push(to);
    }
  }

  return { centre, step, points, edges };
}

/**
 * How far the blast has to travel to reach a point, going around whatever stands in the way.
 *
 * @param {object} region From blastRegion
 * @param {{x: number, y: number}} point
 * @returns {number} Infinity when nothing in the region reaches it — the point is behind the wall
 */
function pathDistance({ centre, step, points, edges }, point) {
  const j = Math.floor((point.x - centre.x) / step);
  const i = Math.floor((point.y - centre.y) / step);

  let shortest = Infinity;
  // A target stands where it stands rather than on the lattice, so the last leg runs off it — and
  // the four points it stands between are the ones that can carry the blast the rest of the way.
  for (const [di, dj] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
    const from = points.get(`${i + di},${j + dj}`);
    if (!from) continue;

    const distance = from.distance + (Math.hypot(point.x - from.x, point.y - from.y) / step);
    if (distance >= shortest || wallBetween(edges, from, point)) continue;
    shortest = distance;
  }

  return shortest;
}

/**
 * Whether a movement-blocking wall stands anywhere between the muzzle and a point, off the
 * payload's own level — D115's gate for a shotgun pattern. It reuses D72's edge-collision channel
 * (`blastEdges`'s open-door, secret-door and one-way exemptions all apply) without its wrap-around
 * search: a bounding box around the two points is enough for a straight test, and a pattern does
 * not go round corners the way a blast does.
 *
 * @param {Level} level
 * @param {{x: number, y: number}} muzzle
 * @param {{x: number, y: number}} point
 * @returns {boolean}
 */
function patternWallBetween(level, muzzle, point) {
  const centre = { x: (muzzle.x + point.x) / 2, y: (muzzle.y + point.y) / 2 };
  const reach = Math.max(1, Math.hypot(point.x - muzzle.x, point.y - muzzle.y) / 2);
  return wallBetween(blastEdges(level, centre, reach), muzzle, point);
}

/**
 * How far the blast travels to reach one point, and what fraction of it arrives there.
 *
 * Membership and falloff are the same measurement — `Scene#grid.measurePath`, the grid-aware call
 * the range band is picked with, or the way round when a wall is in the way — so a target cannot be
 * inside the zone and in no ring. Exported because the drawing has to consult the rule the
 * resolution uses rather than reimplement it: two implementations drifting apart is the defect
 * `T247` exists to close.
 *
 * @param {Scene} scene The payload's own scene
 * @param {object|null} region From blastRegion, or null wherever walls do not apply
 * @param {object} blast The card's blast payload
 * @param {{x: number, y: number}} point
 * @param {boolean} isShooter Whether this point is the shooter's own token
 * @param {boolean} isAimed Whether this point is the pattern's own designated target (`T284`) — D69
 *   means the shot that was aimed never meets a wall, so this exempts it from the gate below
 * @returns {{distance: number, multiplier: number}} multiplier 0 when the blast does not reach it
 */
export function blastCoverage(scene, region, blast, point, isShooter = false, isAimed = false) {
  const centre = { x: blast.x, y: blast.y };

  // D115 — a shotgun pattern's own wall gate: binary and never wrapped, unlike the blast's below.
  // `T284` — a target the muzzle cannot reach in a straight line is out, disc and corridor alike.
  if (blast.corridor && blast.levelId && !isAimed) {
    const level = scene.levels.get(blast.levelId) ?? scene.initialLevel;
    if (patternWallBetween(level, blast.corridor.from, point)) return { distance: Infinity, multiplier: 0 };
  }

  let distance = scene.grid.measurePath([centre, point]).distance;
  // D72/D73 — a wall does not merely stop a blast, it makes it go round: a target the straight
  // line cannot reach is caught only if the way round is still inside the radius, and it takes
  // the ring that longer way falls in.
  if (region && wallBetween(region.edges, centre, point)) distance = pathDistance(region, point);
  let multiplier = blastMultiplierFor(distance, blast);

  if (multiplier <= 0 && blast.corridor && !isShooter) {
    // `T287` — a projection behind the muzzle is rejected rather than clamped to it, so a
    // bystander standing behind the shooter is outside the corridor rather than on top of it.
    const nearest = corridorPoint(blast.corridor, point);
    if (nearest) {
      const along = scene.grid.measurePath([nearest, point]).distance;
      // Ch. 07:843 — a target in the straight path between attacker and intended target is in the
      // area of effect too, at the pattern's own width. Full damage: the book gives the corridor
      // no falloff of its own, and the ring table belongs to the circle.
      if (along <= blast.radius) {
        distance = along;
        multiplier = 1;
      }
    }
  }

  return { distance, multiplier };
}

/**
 * Every token the blast caught, with how much of it reached them. Everything is read off the
 * payload's own scene rather than the canvas, so the applying client does not have to be looking at
 * it, and a GM running with the canvas disabled gets the same answer.
 *
 * @param {object} blast The card's blast payload
 * @returns {Array<{name: string, tokenUuid: string, actorUuid: string, distance: number, multiplier: number}>}
 */
export function tokensInBlast(blast) {
  const scene = zoneScene(blast);
  if (!scene) return [];

  const region = blastRegion(blast);
  const caught = [];

  for (const token of scene.tokens) {
    // Ch. 07:843 is *"in the straight path **between** attacker and intended target"*, and the
    // attacker is an endpoint of that path rather than a point between its ends — so the shooter is
    // out of their own corridor, and out of it alone: a bystander standing on the muzzle is still
    // caught, and the disc still reaches whoever is in it (`T110`).
    const isShooter = !!blast.corridor?.shooterTokenUuid
      && token.uuid === blast.corridor.shooterTokenUuid;
    // D69 — ordinary fire meets no wall at all, and the pattern's own designated target was
    // resolved exactly that way; `T284`'s gate is the splash rule and stops here.
    const isAimed = !!blast.aimedTokenUuid && token.uuid === blast.aimedTokenUuid;

    const { distance, multiplier } = blastCoverage(scene, region, blast, token.getCenterPoint(),
      isShooter, isAimed);
    if (multiplier <= 0) continue;

    caught.push({
      name: token.name,
      tokenUuid: token.uuid,
      actorUuid: token.actor?.uuid ?? "",
      distance,
      multiplier
    });
  }

  return caught;
}

/**
 * The point on the fire corridor nearest a target — or null when the target is behind the muzzle.
 *
 * `closestPointToSegment` clamps to both ends, and clamping to `from` is wrong there: ch. 07:843
 * puts the corridor *between* attacker and target, and a point behind the muzzle is outside that
 * band rather than standing on it (`T287`). The target end keeps the clamp — a point beyond `to`
 * is already reached by the pattern's own disc, so there is nothing to correct at that end.
 *
 * @param {{from: {x: number, y: number}, to: {x: number, y: number}}} corridor
 * @param {{x: number, y: number}} point
 * @returns {{x: number, y: number}|null} null when the point projects behind the muzzle
 */
function corridorPoint({ from, to }, point) {
  // closestPointToSegment throws on a zero-length segment, which is a shooter standing on top of
  // their own target — reachable, and then the corridor is just the one point.
  if (from.x === to.x && from.y === to.y) return from;

  const dx = to.x - from.x, dy = to.y - from.y;
  const t = (((point.x - from.x) * dx) + ((point.y - from.y) * dy)) / ((dx * dx) + (dy * dy));
  if (t < 0) return null;

  return foundry.utils.closestPointToSegment(point, from, to);
}

/**
 * The fire corridor a shotgun pattern lays between the shooter and the target it was aimed at,
 * cut short at the first obstacle.
 *
 * Ch. 07:843 gives the corridor and its exemption in one breath: *"Any target in a straight path
 * between attacker and intended target is also considered to be in the area of effect. Note: if
 * something is between the path of the shotgun and its intended target, the intervening spaces
 * behind that object are considered to be exempt from the effects of fire."* Truncating here, on
 * the shooter's own canvas, is what lets the apply path stay pure geometry on any scene.
 *
 * @param {Token|undefined} shooter The attacker's token on the current scene
 * @param {{x: number, y: number}} target The pattern's centre, in pixels
 * @returns {{from: {x: number, y: number}, to: {x: number, y: number}}|null} null with no shooter
 */
export function fireCorridor(shooter, target) {
  if (!shooter) return null;

  const from = shooter.center;
  // "move" rather than "sight": what stops a cloud of pellets is a physical obstruction, and a
  // window is exactly the wall that blocks one and not the other.
  const blocked = shooter.checkCollision(target, { type: "move", mode: "closest" });
  const to = blocked ? { x: blocked.x, y: blocked.y } : target;

  // The shooter travels with the corridor so the apply path can leave them out of it: they stand
  // at distance 0 from their own line of fire and were caught by every shot (`T110`). Carried
  // here rather than matched by position, because the corridor is the only part of the payload
  // that knows whose it is.
  return {
    from: { x: from.x, y: from.y },
    to: { x: to.x, y: to.y },
    shooterTokenUuid: shooter.document?.uuid ?? ""
  };
}

/**
 * How finely the drawn contour follows the wall model: half a grid space. Measured at 99.8 %
 * agreement with the membership rule against 97.1 % at a whole space, where a cell whose centre
 * lands on a wall line is classified blocked and takes a metre-wide strip of the drawing with it
 * (`DESIGN-zone-drawing.md` §4).
 */
const ZONE_CELL_SUBDIVISION = 2;

/**
 * How far the drawing takes the blast to a point, in scene units.
 *
 * D117 — the drawn shape stays a circle, so the straight line is measured Euclidean here where
 * `blastCoverage` measures it on the scene's own grid; the divergence is the diagonal corner the
 * grid metric adds, and the caught-token highlight is what carries it. The wall model is the same
 * one in both.
 *
 * @param {object} region From blastRegion
 * @param {{x: number, y: number}} centre
 * @param {{x: number, y: number}} point
 * @param {number} step Pixels per scene unit
 * @returns {number}
 */
function drawnReach(region, centre, point, step) {
  if (wallBetween(region.edges, centre, point)) return pathDistance(region, point);
  return Math.hypot(point.x - centre.x, point.y - centre.y) / step;
}

/**
 * The blast's own disc as walls leave it: the half-cells it reaches, unioned into contours.
 *
 * `ClipperLib` is a client global and the library core's own polygon intersection runs on
 * (`client/canvas/extensions/polygon-extension.mjs:208`, 14.365.0). Executing into a `PolyTree`
 * rather than `Paths` is what keeps the holes — a pillar inside the blast is a contour of its own.
 *
 * @param {object} region From blastRegion
 * @param {{x: number, y: number}} centre
 * @param {number} radius In scene units
 * @param {number} step Pixels per scene unit
 * @returns {Array<{type: string, points: number[], hole: boolean}>}
 */
function unionOfCells(region, centre, radius, step) {
  const cell = step / ZONE_CELL_SUBDIVISION;
  const reach = Math.ceil((radius * step) / cell);
  const paths = [];

  for (let i = -reach; i < reach; i++) {
    for (let j = -reach; j < reach; j++) {
      const x = centre.x + (j * cell);
      const y = centre.y + (i * cell);
      const middle = { x: x + (cell / 2), y: y + (cell / 2) };
      if (drawnReach(region, centre, middle, step) > radius) continue;

      paths.push([
        { X: Math.round(x), Y: Math.round(y) },
        { X: Math.round(x + cell), Y: Math.round(y) },
        { X: Math.round(x + cell), Y: Math.round(y + cell) },
        { X: Math.round(x), Y: Math.round(y + cell) }
      ]);
    }
  }

  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  clipper.Execute(ClipperLib.ClipType.ctUnion, tree,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);

  const shapes = [];
  const walk = node => {
    for (const child of node.Childs()) {
      shapes.push({
        type: "polygon",
        points: child.Contour().flatMap(corner => [corner.X, corner.Y]),
        hole: child.IsHole()
      });
      walk(child);
    }
  };
  walk(tree);

  return shapes;
}

/**
 * The band a shotgun's line of fire lays, half the pattern's width to either side of it.
 *
 * @param {{from: {x: number, y: number}, to: {x: number, y: number}}} corridor
 * @param {number} halfWidth In pixels
 * @returns {object|null} null for a shooter standing on their own target, whose corridor is a point
 */
function corridorBand({ from, to }, halfWidth) {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (!length) return null;

  const nx = ((from.y - to.y) / length) * halfWidth;
  const ny = ((to.x - from.x) / length) * halfWidth;
  return {
    type: "polygon",
    points: [
      from.x + nx, from.y + ny, to.x + nx, to.y + ny,
      to.x - nx, to.y - ny, from.x - nx, from.y - ny
    ]
  };
}

/**
 * The shapes one splash is drawn as, on the payload's own scene.
 *
 * With nothing in reach to go around `blastRegion` returns null and the disc is exactly a circle,
 * which is both cheaper and exact — the cell union is only what walls make necessary.
 *
 * @param {object} blast The card's blast payload
 * @returns {object[]} region shape data; empty when there is no scene or no radius
 */
export function zoneShapes(blast) {
  const scene = zoneScene(blast);
  const radius = Math.max(0, Number(blast?.radius) || 0);
  if (!scene || !radius) return [];

  // Pixels per scene unit off the payload's own scene, never `canvas` (`T59`).
  const step = scene.grid.size / scene.grid.distance;
  const centre = { x: blast.x, y: blast.y };
  const region = blastRegion(blast);

  const shapes = region
    ? unionOfCells(region, centre, radius, step)
    : [{ type: "circle", x: centre.x, y: centre.y, radius: radius * step }];

  // Ch. 07:843's corridor is part of what the pattern catches, so it is part of what it draws.
  if (blast.corridor) {
    const band = corridorBand(blast.corridor, radius * step);
    if (band) shapes.push(band);
  }

  return shapes;
}

/**
 * The footprint one caught token is highlighted by.
 *
 * @param {TokenDocument} token
 * @returns {object} token shape data
 */
function tokenFootprint(token) {
  return {
    type: "token",
    x: token.x, y: token.y,
    width: token.width, height: token.height,
    shape: token.shape
  };
}

/**
 * Draw the splash a card describes, with the tokens it caught highlighted (D74).
 *
 * Separate regions rather than one: the zone and the highlight carry a colour each (D121), and D120
 * puts a caught token the players cannot see in a third at `GAMEMASTER` — a player-visible
 * highlight over a hidden NPC's footprint would announce exactly where it is standing, which is the
 * disclosure `T103`/D31 already refuses on the cards.
 *
 * @param {object} blast The card's blast payload
 * @param {string} kind The card's own kind, which decides the colour and the name
 * @param {string} messageId The card that laid it, so the toggle and the sweep find it again
 * @returns {Promise<RegionDocument[]>} empty when there is no scene or nothing to draw
 */
export async function drawZone(blast, kind, messageId) {
  const scene = zoneScene(blast);
  if (!scene) return [];

  const shapes = zoneShapes(blast);
  if (!shapes.length) return [];

  // A payload that names no level meets no walls on any of them, so it is drawn on all of them —
  // an empty set is core's own "everywhere" (`common/data/fields.mjs`, SceneLevelsSetField).
  const levels = blast.levelId ? [blast.levelId] : [];
  // D141 — every Region this system lays names its own encounter, the highlights included: they are
  // swept by the same filter as the zone they belong to.
  const flags = {
    cyberpunk2020: { [ZONE_FLAG]: messageId, [COMBAT_FLAG]: zoneCombat(scene)?.id ?? "" }
  };
  const ZONE_NAMES = { spread: "ZoneRegionSpread", sweep: "ZoneRegionSweep" };
  const drawing = [{
    name: localize(ZONE_NAMES[kind] ?? "ZoneRegionBlast"),
    color: ZONE_COLOURS[kind] ?? ZONE_COLOURS.blast,
    shapes, levels, flags,
    visibility: CONST.REGION_VISIBILITY.ALWAYS
  }];

  const caught = new Set(tokensInBlast(blast).map(entry => entry.tokenUuid));
  const footprints = hidden => scene.tokens
    .filter(token => caught.has(token.uuid) && (!!token.hidden === hidden))
    .map(tokenFootprint);

  const seen = footprints(false);
  if (seen.length) {
    drawing.push({
      name: localize("ZoneRegionCaught"), color: ZONE_COLOURS.caught,
      shapes: seen, levels, flags,
      visibility: CONST.REGION_VISIBILITY.ALWAYS
    });
  }

  const unseen = footprints(true);
  if (unseen.length) {
    drawing.push({
      name: localize("ZoneRegionCaughtHidden"), color: ZONE_COLOURS.caught,
      shapes: unseen, levels, flags,
      visibility: CONST.REGION_VISIBILITY.GAMEMASTER
    });
  }

  return scene.createEmbeddedDocuments("Region", drawing);
}

/**
 * The regions one card drew.
 *
 * @param {ChatMessage} message
 * @returns {RegionDocument[]}
 */
export function zoneRegions(message) {
  const attack = message?.flags?.cyberpunk2020?.attack;
  const scene = zoneScene(attack?.blast ?? attack?.zone);
  if (!scene) return [];

  return scene.regions.filter(region =>
    region.getFlag("cyberpunk2020", ZONE_FLAG) === message.id);
}

/**
 * D122 — the GM's per-zone control over whether the players see this effect at all.
 *
 * `hidden` rather than `visibility`: it takes the region off the players' canvas and leaves it on
 * the GM's, drawn dashed (`client/canvas/placeables/region.mjs:427`, 14.365.0) — so the GM-only
 * highlight of a hidden token stays GM-only however this is flipped.
 *
 * @param {ChatMessage} message
 * @returns {Promise<boolean|null>} the state it is now in, or null when this card drew nothing
 */
export async function toggleZoneVisibility(message) {
  const regions = zoneRegions(message);
  if (!regions.length) {
    ui.notifications.warn(localize("ZoneNotDrawn"));
    return null;
  }

  const hidden = !regions.some(region => region.hidden);
  await regions[0].parent.updateEmbeddedDocuments("Region",
    regions.map(region => ({ _id: region.id, hidden })));
  return hidden;
}

/**
 * Apply a blast or a shotgun pattern over everyone standing in it.
 *
 * Occupancy is read **now**, not at roll time: a token that walked into the crater between the roll
 * and the click is in it. Each target takes the zone's own rolled damage scaled by the ring it is
 * standing in, on a location of its own.
 *
 * @param {ChatMessage} message
 * @returns {Promise<ChatMessage[]|null>} the breakdown cards, or null when nothing was applied
 */
export async function applyBlastFromMessage(message) {
  // Same reason as `applyAttackFromMessage`: a card written before the flip keeps a valid payload.
  if (!isCombatAutomationEnabled()) return null;

  const attack = message?.flags?.cyberpunk2020?.attack;
  if (attack?.version !== ATTACK_FLAG_VERSION) return null;
  if (!attack.blast || attack.applied?.zone) return null;

  // The payload's coordinates are pixels on one scene and mean nothing without it.
  if (!zoneScene(attack.blast)) {
    ui.notifications.warn(localize("ZoneSceneGone"));
    return null;
  }

  const caught = tokensInBlast(attack.blast);
  if (!caught.length) {
    ui.notifications.warn(localize("BlastNoTargets"));
    return null;
  }

  await message.update({ "flags.cyberpunk2020.attack.applied.zone": true });

  // `T96`/D52 — the round decides, not the card's kind: a shotgun pattern is located pellets, and a
  // grenade is location-silent in the book (`07:839`), so only a charge authored as an explosive
  // resolves against the body as a whole.
  const overallBody = !!attack.ammo?.overallBody;

  const cards = [];
  for (const entry of caught) {
    const tokenDoc = await fromUuid(entry.tokenUuid);
    // An unlinked token owns its own delta actor; writing to the base actor would wound every copy.
    const actor = tokenDoc?.actor ?? await fromUuid(entry.actorUuid);
    if (!actor) continue;

    const damage = blastDamageFor(attack.blast.damage, entry.multiplier);
    if (damage <= 0) continue;

    // D17: the shot's designated target takes the location it was aimed at — the -4 was paid at
    // the roll. Everyone else the pattern caught rolls their own, and a blast has no aim at all.
    // An overall-body hit rolls nothing: `applyHitsToActor` resolves it at the Torso either way,
    // and a die thrown for a location nobody reads is one a dice module would still animate.
    const zone = overallBody ? "Torso"
      : entry.tokenUuid === attack.blast.aimedTokenUuid && attack.blast.aimedZone
        ? attack.blast.aimedZone
        : (await rollLocation(actor)).areaHit;

    cards.push(await applyHitsToActor(actor, {
      hits: [{ zone, damage }], ap: attack.ap, ammo: attack.ammo, targetName: entry.name,
      token: tokenDoc, sceneId: String(attack.blast.sceneId ?? ""),
      messageMode: hiddenMessageMode(tokenDoc?.hidden),
      overallBody
    }));
  }

  return cards;
}
