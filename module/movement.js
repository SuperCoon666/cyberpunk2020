import { localize, localizeParam } from "./utils.js";

/** Ch. 04: a character covers MA metres walking, and three times that running. */
const RUN_ACTION = "run";

/**
 * What this token may cover this turn, and what it has already spent.
 *
 * Null whenever the budget does not apply, which is also exactly when core records nothing:
 * `_shouldRecordMovementHistory` needs a combatant whose combat has **started**
 * (`client/documents/token.mjs:3177`, 14.365.0). Outside a fight the history is empty and stays
 * empty, so there is nothing to measure against and nothing is shown.
 *
 * @param {TokenDocument} tokenDocument
 * @param {string} [action] The movement action of the waypoint being measured
 * @returns {{spent: number, budget: number}|null}
 */
export function movementBudget(tokenDocument, action) {
  if (!tokenDocument?.combatant?.parent?.started) return null;

  const ma = tokenDocument.actor?.system?.stats?.ma;
  const budget = Number(action === RUN_ACTION ? ma?.run : ma?.total);
  if (!Number.isFinite(budget) || budget <= 0) return null;

  const spent = tokenDocument.movementHistory.reduce(
    (sum, waypoint) => sum + (Number.isFinite(waypoint.cost) ? waypoint.cost : 0), 0);

  return { spent, budget };
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

    const budget = movementBudget(this.token.document, waypoint.action);
    if (!budget) return context;

    const planned = Number.isFinite(waypoint.measurement.cost) ? waypoint.measurement.cost : 0;
    const total = budget.spent + planned;

    context.cost.total = localizeParam("MoveSpentOfBudget", {
      spent: total.toNearest(0.01).toLocaleString(game.i18n.lang),
      budget: budget.budget.toNearest(0.01).toLocaleString(game.i18n.lang)
    });
    if (total > budget.budget) context.cssClass = `${context.cssClass} cp-overspent`;

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
  if (!budget) return;

  // The operation carries its own totals; `history.cost` is what `movementBudget` reads off the
  // document, and the two halves of the move are what is being asked for.
  const total = movement.history.cost + movement.passed.cost + movement.pending.cost;
  if (total <= budget.budget) return;

  ui.notifications.warn(localizeParam("MoveBlocked", {
    total: total.toNearest(0.01).toLocaleString(game.i18n.lang),
    budget: budget.budget.toNearest(0.01).toLocaleString(game.i18n.lang),
    units: canvas.grid.units || localize("UnitMetres")
  }));
  return false;
}
