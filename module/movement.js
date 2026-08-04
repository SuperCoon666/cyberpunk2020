import { localize, localizeParam } from "./utils.js";

/** Ch. 04: a character covers MA metres walking, and three times that running. */
const RUN_ACTION = "run";

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
