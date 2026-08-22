import { localize, localizeParam } from "./utils.js";

/** Ch. 04: a character covers MA metres walking, and three times that running. */
const RUN_ACTION = "run";

/**
 * The three bands the grid highlight is painted in: within a walk, within a run, past both.
 *
 * Green and red are the system's own pass/fail pair — the colours a chat card already resolves a
 * turn in (`.part-total.crit` / `.cp-save-outcome.is-success` and their failure twins,
 * `css/cyberpunk2020.css:761-784`). The middle stop is the midpoint of that same axis taken in
 * OKLCh with its lightness raised to 0.70; taken in sRGB instead, chroma collapses from 0.15 to
 * 0.08 and the band lands on khaki.
 *
 * Alpha splits where the **rule** splits rather than evenly: a walk and a run are both legal and
 * share one weight, and only the band that may not be spent is louder. At one flat alpha the red
 * band measured as the faintest of the three over a dark map, grass, asphalt and night — the
 * warning disappearing exactly where maps usually are. All three stay under core's own 0.5.
 *
 * Numeric because the highlight is drawn into PIXI and never reaches a stylesheet — `.cp-overspent`
 * on the waypoint label is the CSS half of the same rule, and carries the same vermilion.
 */
const BANDS = {
  walk: { color: 0x77b968, alpha: 0.30 },
  run: { color: 0xc69700, alpha: 0.30 },
  over: { color: 0xd1502f, alpha: 0.45 }
};

/**
 * Which band a cumulative spend falls in.
 *
 * Read off the token's own MA rather than off the waypoint's movement action, because the bands are
 * what the distance **is**: a player who chose to walk and dragged into running distance is shown
 * that, and `blockOverspentMovement` is still the only thing that stops him. Null wherever
 * `movementBudget` has no rule to apply, which leaves core's own colour — the mover's — in place.
 *
 * @param {TokenDocument} tokenDocument
 * @param {number} cost The spend at this waypoint, cumulative from the start of the turn
 * @returns {{color: number, alpha: number}|null} The band, or null when no budget applies
 */
function movementBand(tokenDocument, cost) {
  const walk = movementBudget(tokenDocument);
  if (walk === null) return null;
  if (cost <= walk) return BANDS.walk;
  return cost <= movementBudget(tokenDocument, RUN_ACTION) ? BANDS.run : BANDS.over;
}

/**
 * What this token may cover this turn.
 *
 * Null whenever the budget does not apply, which is also exactly when core records nothing:
 * `_shouldRecordMovementHistory` needs a combatant whose combat has **started**
 * (`client/documents/token.mjs:3177`, 14.365.0). Outside a fight the history is empty and stays
 * empty, so there is nothing to measure against and nothing is shown.
 *
 * An allowance of **0 is a budget, not an absence** (D23): encumbrance and cyber-armour penalties
 * reach `ma` like every other stat, and a character too loaded to move covers 0 m rather than
 * being exempted from the rule. Only missing MA data leaves no rule at all — hence `null` for a
 * non-number and a floor of 0 for a negative one.
 *
 * @param {TokenDocument} tokenDocument
 * @param {string} [action] The movement action of the waypoint being measured
 * @returns {number|null} The allowance in scene units, or null when the rule does not apply
 */
export function movementBudget(tokenDocument, action) {
  if (!tokenDocument?.combatant?.parent?.started) return null;

  const ma = tokenDocument.actor?.system?.stats?.ma;
  const budget = Number(action === RUN_ACTION ? ma?.run : ma?.total);
  if (!Number.isFinite(budget)) return null;

  return Math.max(0, budget);
}

export class CyberpunkTokenRuler extends foundry.canvas.placeables.tokens.TokenRuler {

  /**
   * @override
   * Core's own context is kept and only the cost line is rewritten, rather than replacing
   * `WAYPOINT_LABEL_TEMPLATE`: the template renders `{{cost.total}} {{cost.units}}` inside one span
   * (`templates/hud/waypoint-label.hbs`, 14.365.0), so the budget fits where the distance already
   * went and the label survives core changing the rest of it.
   *
   * `super` returns nothing for most waypoints — it suppresses the labels it does not want drawn.
   */
  _getWaypointLabelContext(waypoint, state) {
    const context = super._getWaypointLabelContext(waypoint, state);
    if (!context?.cost) return context;

    // Not `!budget`: 0 is an allowance (D23), and the label is exactly what shows the overspend.
    const budget = movementBudget(this.token.document, waypoint.action);
    if (budget === null) return context;

    // The turn's spend is already in here. Every path the ruler measures has the token's own
    // movement history prepended — the drag preview's (`client/canvas/placeables/token.mjs:5773`)
    // and the executing operation's (`:2002-2006`, 14.365.0) alike — and `measurement.cost` is
    // cumulative from path[0], which is why core renders it as `cost.total`. Summing the history a
    // second time here counted it twice from the second move of a turn on.
    const total = Number.isFinite(waypoint.measurement.cost) ? waypoint.measurement.cost : 0;

    context.cost.total = localizeParam("MoveSpentOfBudget", {
      spent: total.toNearest(0.01).toLocaleString(game.i18n.lang),
      budget: budget.toNearest(0.01).toLocaleString(game.i18n.lang)
    });
    if (total > budget) context.cssClass = `${context.cssClass} cp-overspent`;

    return context;
  }

  /**
   * @override
   * Only the colour is taken over. Core decides *whether* a space is painted — an unreachable
   * waypoint and the seam between a passed and a planned one are both suppressed there
   * (`client/canvas/placeables/tokens/ruler.mjs:767-772`, 14.365.0) — and that decision is kept.
   * The segment and the waypoint markers stay the mover's own colour, which is what tells a table
   * whose drag it is looking at.
   */
  _getGridHighlightStyle(waypoint, offset) {
    const style = super._getGridHighlightStyle(waypoint, offset);
    if (!(style.alpha > 0)) return style;

    const cost = Number.isFinite(waypoint.measurement.cost) ? waypoint.measurement.cost : 0;
    const band = movementBand(this.token.document, cost);
    return band === null ? style : { ...style, ...band };
  }
}

/**
 * Refuse a move that would take the token past its allowance for the turn.
 *
 * `preMoveToken` fires only on the client that initiated the move (`client/hooks.mjs:721`,
 * 14.365.0), so this is the mover's own client refusing — a GM moving anything is never stopped,
 * and returning false is the only way to reject (`client/documents/token.mjs:1990`).
 *
 * @param {TokenDocument} tokenDocument
 * @param {object} movement The pending movement operation
 * @returns {boolean|void} false to reject the move
 */
export function vetoOverspentMovement(tokenDocument, movement) {
  if (game.user.isGM) return;
  if (!game.settings.get("cyberpunk2020", "blockOverspentMovement")) return;

  const action = movement.passed.waypoints.at(-1)?.action ?? movement.pending.waypoints.at(-1)?.action;
  const budget = movementBudget(tokenDocument, action);
  if (budget === null) return;

  // The operation carries its own totals, and its three parts are disjoint
  // (`client/documents/token.mjs:1936-1965`, 14.365.0), so summing them counts nothing twice.
  const total = movement.history.cost + movement.passed.cost + movement.pending.cost;
  if (total <= budget) return;

  ui.notifications.warn(localizeParam("MoveBlocked", {
    total: total.toNearest(0.01).toLocaleString(game.i18n.lang),
    budget: budget.toNearest(0.01).toLocaleString(game.i18n.lang),
    units: canvas.grid.units || localize("UnitMetres")
  }));
  return false;
}
