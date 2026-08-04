import { ranges, rangedAttackTypes } from "./lookups.js";
import { applyHitsToActor, hiddenMessageMode, requestSave, ATTACK_FLAG_VERSION } from "./damage.js";
import { localize, rollLocation } from "./utils.js";

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

/** The attack types that throw or launch an area-effect charge (ch. 07 "Area Effect Weapons"). */
const BLAST_ATTACK_TYPES = new Set([rangedAttackTypes.grenade, rangedAttackTypes.rpg]);

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
  const fullDamageWithin = Math.min(radius, Math.max(0, Number(ammo?.blastFullDamageWithin) || 0));
  const multipliers = (Array.isArray(ammo?.blastMultipliers) ? ammo.blastMultipliers : [])
    .map(m => Math.max(0, Number(m) || 0));

  return { radius, fullDamageWithin, multipliers };
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
 * Whether this weapon and its loaded ammunition throw an area-effect charge.
 *
 * @param {object} system The weapon system data from _getWeaponSystem
 * @param {object|null} ammo A snapshot from snapshotAmmo
 * @returns {boolean}
 */
export function isBlastAttack(system, ammo) {
  return BLAST_ATTACK_TYPES.has(system?.attackType) && Number(ammo?.blastRadius) > 0;
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
      ammo: new ObjectField({ nullable: true, initial: null }),
      attackerUuid: new StringField({ required: true, initial: "" })
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
  const combat = game.combat;
  const crossing = combat?.started ? `${combat.id}.${combat.round}.${combat.turn}` : "once";
  const saved = zone.behavior.getFlag("cyberpunk2020", CROSSED_FLAG) ?? {};
  if (saved[token.id] === crossing) return;
  await zone.behavior.setFlag("cyberpunk2020", CROSSED_FLAG, { ...saved, [token.id]: crossing });

  const save = await requestSave(actor, "zone", {
    dc: zone.saveDC, messageMode: hiddenMessageMode(token.hidden)
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
 * Lay the fire zone the card describes on its own scene. A Region is a scene document, so only a
 * GM can write it: the shooter previews, the active GM creates, and with no GM connected the
 * card's own numbers are what the table plays off.
 *
 * @param {object} zone The card's zone payload
 * @param {object} behaviour What a crossing needs: name, saveDC, damageFormula, ap, ammo, attackerUuid
 * @returns {Promise<RegionDocument|null>} null when the scene is gone
 */
export async function createSuppressionZone(zone, behaviour) {
  const scene = game.scenes.get(String(zone?.sceneId ?? ""));
  if (!scene) return null;

  const { name, ...system } = behaviour;
  const [region] = await scene.createEmbeddedDocuments("Region", [{
    name,
    shapes: zone.shapes,
    levels: zone.levels,
    visibility: CONST.REGION_VISIBILITY.ALWAYS,
    flags: { cyberpunk2020: { [SUPPRESSION_FLAG]: true } },
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

/**
 * Every token the blast caught, with how much of it reached them.
 *
 * Membership and falloff are the same measurement — `Scene#grid.measurePath`, the grid-aware call
 * the range band is picked with — so a token cannot be inside the zone and in no ring. Everything
 * is read off the payload's own scene rather than the canvas, so the applying client does not have
 * to be looking at it, and a GM running with the canvas disabled gets the same answer.
 *
 * @param {object} blast The card's blast payload
 * @returns {Array<{name: string, tokenUuid: string, actorUuid: string, distance: number, multiplier: number}>}
 */
export function tokensInBlast(blast) {
  const scene = zoneScene(blast);
  if (!scene) return [];

  const centre = { x: blast.x, y: blast.y };
  const caught = [];

  for (const token of scene.tokens) {
    const point = token.getCenterPoint();
    let distance = scene.grid.measurePath([centre, point]).distance;
    let multiplier = blastMultiplierFor(distance, blast);

    if (multiplier <= 0 && blast.corridor) {
      const along = scene.grid.measurePath([corridorPoint(blast.corridor, point), point]).distance;
      // Ch. 07:843 — a target in the straight path between attacker and intended target is in the
      // area of effect too, at the pattern's own width. Full damage: the book gives the corridor
      // no falloff of its own, and the ring table belongs to the circle.
      if (along <= blast.radius) {
        distance = along;
        multiplier = 1;
      }
    }

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
 * The point on the fire corridor nearest a target.
 *
 * @param {{from: {x: number, y: number}, to: {x: number, y: number}}} corridor
 * @param {{x: number, y: number}} point
 * @returns {{x: number, y: number}}
 */
function corridorPoint({ from, to }, point) {
  // closestPointToSegment throws on a zero-length segment, which is a shooter standing on top of
  // their own target — reachable, and then the corridor is just the one point.
  if (from.x === to.x && from.y === to.y) return from;
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

  return { from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } };
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
    const zone = entry.tokenUuid === attack.blast.aimedTokenUuid && attack.blast.aimedZone
      ? attack.blast.aimedZone
      : (await rollLocation(actor)).areaHit;

    cards.push(await applyHitsToActor(actor, {
      hits: [{ zone, damage }], ap: attack.ap, ammo: attack.ammo, targetName: entry.name,
      messageMode: hiddenMessageMode(tokenDoc?.hidden),
      // A blast damages the overall body (`07:960`/`:966`), so a burn it starts catches at the
      // Torso; a shotgun pattern is located pellets and keeps the zone it rolled (D26.2).
      overallBody: attack.kind === "blast"
    }));
  }

  return cards;
}
