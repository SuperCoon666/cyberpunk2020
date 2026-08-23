import { localize, localizeParam } from "./utils.js";
import { isCombatAutomationEnabled } from "./lookups.js";
import { createCyberpunkRollCard, renderCyberpunkTemplate } from "./compat.js";

/**
 * The hover chain for one applied hit (D254): only the steps that happened, no words.
 *
 * `line` is one of `applyHitsToActor`'s line records: `resolveHit`'s return with the hit's own
 * `damage` merged in (`damage.js`, `lines.push`). The value is walked the way `resolveHit` walks
 * it, armour then the round's divisor then the head, so the two cannot disagree; the BTM floor
 * prints as an arrow because the floor, not the subtraction, decided the number.
 *
 * @param {object} line
 * @returns {string} "" when nothing happened to the number
 */
export function damageChain({ damage, effSp, divisor = 1, headDoubled = false, btm = 0, final = 0, toSdp = 0 }) {
  const parts = [String(damage)];
  let value = damage;
  if (effSp > 0) {
    value = Math.max(0, value - effSp);
    parts.push(localizeParam("ChainSp", { sp: effSp, value }));
  }
  if (value === 0) return parts.join(" ");
  if (divisor !== 1) {
    value = Math.max(0, Math.floor(value / divisor));
    parts.push(localizeParam("ChainDivide", { divisor, value }));
  }
  if (value === 0) return parts.join(" ");
  if (headDoubled) {
    value *= 2;
    parts.push(localizeParam("ChainHead", { value }));
  }
  if (toSdp > 0) {
    parts.push(localize("ChainSdp"));
    return parts.join(" ");
  }
  if (btm !== 0) {
    parts.push(localizeParam(value - btm < 1 ? "ChainBtmFloor" : "ChainBtm", { btm, final }));
  }
  return parts.length === 1 ? "" : parts.join(" ");
}

const ATTACK_TEMPLATE = "systems/cyberpunk2020/templates/chat/attack.hbs";
const ZONE_TEMPLATE = "systems/cyberpunk2020/templates/chat/zone.hbs";
const CROSSING_TEMPLATE = "systems/cyberpunk2020/templates/chat/crossing.hbs";

/** A roll as the card stores it: its JSON, with the displayed total in place of the die's own. */
export function rollRecord(roll, total = roll.total) {
  return { ...roll.toJSON(), total };
}

function encodeRoll(record) {
  return encodeURIComponent(JSON.stringify(record));
}

function diceBar(record, label, { dc = 0, soft = false, noRollText = "" } = {}) {
  return { label, dc, soft, noRollText, roll: record ? Roll.fromJSON(JSON.stringify(record)) : null };
}

/**
 * One row per hit location, the hits under it as chips (§4.1). Before the apply a chip is the
 * rolled number; after it the final, or the SDP share, or a muted zero.
 *
 * The applied row is keyed by the zone the damage was **resolved** at rather than the one that was
 * rolled: D146 re-derives a hit into a spent or severed limb onto the Torso and D52 resolves an
 * overall-body hit at `OverallBody`, so the rolled zone would credit a wound to a limb that is
 * gone. The fired state has no line yet and keeps the roll.
 *
 * `zoneLabel` names the row: a zone card writes which patterns caught the location beside it
 * (§3.4), and everything else prints the location alone.
 */
export function hitRows(target, zoneLabel = localize) {
  const rows = new Map();
  target.hits.forEach((hit, index) => {
    const line = target.applied ? target.result?.lines?.[index] : null;
    const chip = line
      ? { value: line.toSdp > 0 ? line.toSdp : line.final,
          state: line.toSdp > 0 ? "sdp" : line.final > 0 ? "on" : "z",
          roll: encodeRoll(hit.roll), chain: line.chain }
      : { value: hit.damage, state: "rolled", roll: encodeRoll(hit.roll), chain: "" };
    const zone = line?.zone ?? hit.zone;
    if (!rows.has(zone)) rows.set(zone, { zone: zoneLabel(zone), chips: [] });
    rows.get(zone).chips.push(chip);
  });
  return [...rows.values()];
}

const EVENT_KEYS = {
  limbUseless: { key: "EventLimbUseless", bad: false },
  limbDestroyed: { key: "EventLimbDestroyed", bad: true },
  severed: { key: "SeveranceLimb", bad: true },
  death: { key: "SeveranceDeath", bad: true },
  shock: { key: "EventShock", bad: false }
};

export function eventRows(target) {
  return (target.result?.events ?? []).map(event => {
    const spec = EVENT_KEYS[event.key];
    const zone = event.zone ? localize(event.zone) : "";
    return { bad: spec.bad, text: localizeParam(spec.key, { ...event, zone }) };
  });
}

function targetContext(target) {
  return {
    name: target.name,
    applied: target.applied,
    attackBar: target.attack ? diceBar(target.attack.roll, localize("Attack"), { dc: target.attack.dc }) : null,
    tally: target.tally ? localizeParam("AutofireTally", target.tally) : "",
    rows: hitRows(target),
    events: eventRows(target),
    pendingSave: target.pending === "save" ? localizeParam("WaitingSave", { name: target.name }) : "",
    fumble: target.fumble ?? null
  };
}

/**
 * D140/`T308` - the Grenade Table's second die is a landing distance for a thrown charge
 * (`07:839`) and a bearing for a stream that pivots about the muzzle, so the sentence is the
 * kind's own rather than the grenade's for all three.
 */
const SCATTER_KEYS = { spread: "SpreadScattered", sweep: "SweepScattered", blast: "BlastScattered" };

/** A shotgun pattern and a flamethrower stream have a width and a line of fire; a blast has neither. */
const CORRIDOR_KINDS = new Set(["spread", "sweep"]);

/** Which patterns caught one location (§3.4): the row says so, in the row. */
function patternRefs(patterns) {
  return localizeParam(patterns.length > 1 ? "PatternRefs" : "PatternRef",
    { list: patterns.join(", ") });
}

/**
 * A zone target's rows: before the apply from the shares the card froze at fire time, after it
 * from the hits the apply resolved. A share carries a number only when a ring reduced it (§3.5) -
 * otherwise the pattern's own roll already stands beside its bar.
 */
function zoneRows(target, patterns) {
  const source = target.applied ? target.hits : target.shares;
  // The rows are keyed by the resolved zone once applied (`hitRows`), so the attribution has to
  // read the same one: a pattern whose hit was re-derived belongs on the row it ended on.
  const zoneOf = (entry, index) =>
    (target.applied ? target.result?.lines?.[index]?.zone : null) ?? entry.zone;
  // A card with one shape has nothing to attribute: naming the only pattern there is says nothing
  // the row does not already say, so the location stands alone (§3.5).
  const label = patterns.length === 1 ? localize
    : zone => `${localize(zone)} · ${patternRefs(
      [...new Set(source.filter((entry, index) => zoneOf(entry, index) === zone)
        .map(entry => entry.pattern))])}`;
  if (target.applied) return hitRows(target, label);

  const rows = new Map();
  for (const share of target.shares) {
    if (!rows.has(share.zone)) rows.set(share.zone, { zone: label(share.zone), chips: [] });
    if (!share.printed) continue;
    rows.get(share.zone).chips.push({ value: share.damage, state: "rolled", chain: "",
      roll: encodeRoll(patterns.find(pattern => pattern.index === share.pattern).damageRoll) });
  }
  return [...rows.values()];
}

/**
 * The zone family's card (§3.4/§3.5): one bar and one row per pattern in placement order, then one
 * caught list for the whole chain. The pattern's number is information, not decoration - "1 m from
 * the previous pattern" only reads in sequence.
 */
async function renderZoneCard(attack) {
  const card = attack.card;
  const corridor = CORRIDOR_KINDS.has(attack.kind);
  const metres = localize("UnitMetres");
  // The shape's own rows describe one pattern. A chain's width and band differ per pattern and are
  // printed on each row instead, so the card keeps no number that would be true of only one.
  const one = attack.patterns.length === 1 ? attack.patterns[0] : null;
  const radiusLine = pattern => pattern.fullDamageWithin === pattern.radius
    ? `${pattern.radius} ${metres}`
    : `${pattern.radius} ${metres} · ${localize("BlastFullDamage")} ${pattern.fullDamageWithin} ${metres}`;

  const radius = !corridor && one ? radiusLine(one) : "";

  const buttons = [];
  // Who is caught is decided when the button is clicked, so it is offered while the zone stands
  // whether or not anybody was under it at fire time.
  if (attack.placed && !attack.applied) {
    buttons.push({ cls: "cp-apply-zone", action: "applyZone", label: localize("ApplyDamage") });
  }
  if (attack.placed) {
    buttons.push({ cls: "cp-draw-zone", action: "drawZone",
      label: localize(attack.kind === "spread" ? "DrawPatterns" : "DrawZoneGeneric") });
  }

  return renderCyberpunkTemplate(ZONE_TEMPLATE, {
    title: localize(card.title),
    weaponName: card.weaponName,
    patternsLine: card.patternsLine,
    // The blast's geometry is the round's, not the placement's, so it prints whether or not the
    // shape reached the map. The band and the width are the pattern rows' below.
    radiusLine: radius,
    // A one-shape corridor prints neither row, and an empty `<dl>` still carries its own margin.
    hasKv: !!(card.patternsLine || radius),
    rings: (attack.rings ?? []).map(ring => localizeParam("BlastRingBand", ring)),
    patterns: attack.patterns.map(pattern => ({
      attackBar: pattern.attackRoll
        ? diceBar(pattern.attackRoll,
          attack.patterns.length > 1 ? `${pattern.index} · ${localize("Attack")}` : localize("Attack"),
          { dc: pattern.dc })
        : null,
      // A blast's radius already stands in the key/value row above, so the row names the band it
      // was thrown at instead; a charge blown off the deployed list was thrown at no band at all.
      bandLine: corridor
        ? `${localizeParam(pattern.rangeKey, { range: pattern.rangeValue })} · ${pattern.width} ${metres}`
        : pattern.rangeKey ? localizeParam(pattern.rangeKey, { range: pattern.rangeValue }) : "",
      roll: encodeRoll(pattern.damageRoll),
      damage: pattern.damage,
      scatterText: pattern.scatter ? localizeParam(SCATTER_KEYS[attack.kind], pattern.scatter) : "",
      walkedText: pattern.walked ? localize("SpreadPatternWalked") : "",
      fellShortText: pattern.fellShort ? localizeParam("SpreadFellShort", { reach: pattern.reach }) : "",
      fumble: pattern.fumble ?? null
    })),
    targets: attack.targets.map(target => ({
      name: target.name,
      rows: zoneRows(target, attack.patterns),
      events: eventRows(target),
      pendingSave: target.pending === "save" ? localizeParam("WaitingSave", { name: target.name }) : ""
    })),
    applied: !!attack.applied,
    // With automation off nothing will ever apply this card, so there is no zone the GM is being
    // asked about: the card is the announcement and the mark would be telling him about a state
    // the world does not have (D10.1).
    noCanvas: !attack.placed && isCombatAutomationEnabled(),
    buttons
  });
}

/**
 * A fire zone's crossing (§3.6). The notice the crossing posts **is** the card: a failed save grows
 * it in place, a passed one leaves it a notice. The 1d6 hits are not an attack roll and there is no
 * bar to hang them on, so the tally is a bare number (D10.3).
 */
async function renderCrossingCard(attack) {
  const card = attack.card;
  return renderCyberpunkTemplate(CROSSING_TEMPLATE, {
    // Already escaped by `localizeParamEscaped` where it was built, hence the triple braces.
    notice: card.notice,
    tally: card.tally ? localizeParam("CrossingHits", card.tally) : "",
    targets: attack.targets.map(targetContext)
  });
}

/** The whole card from its payload: every state is one render of this. */
export async function renderAttackCard(attack) {
  if (attack.kind === "crossing") return renderCrossingCard(attack);
  // Only the direct family renders from targets alone; every other kind is a zone card (§3.4).
  if (attack.kind !== "attack") return renderZoneCard(attack);

  const card = attack.card;
  const multi = attack.targets.length > 1 || attack.targets.some(t => t.attack);
  const hasHits = attack.targets.some(t => t.hits.length);
  const allApplied = hasHits && attack.targets.filter(t => t.hits.length).every(t => t.applied);
  const buttons = [];
  if (hasHits && !allApplied && attack.pending !== "defense") {
    buttons.push({ cls: "cp-apply-damage", action: "applyDamage", label: localize("ApplyDamage") });
  }
  const defense = card.defense;
  return renderCyberpunkTemplate(ATTACK_TEMPLATE, {
    // A parametrised title has nothing to look up: the martial card names its own action and art.
    title: card.titleText ?? localize(card.title),
    weaponName: card.weaponName,
    targetName: multi ? "" : (attack.targets[0]?.name ?? ""),
    rangeLabel: card.rangeKey ? localizeParam(card.rangeKey, { range: card.rangeValue }) : "",
    // The label travels with the payload: a burst of shotgun patterns counts patterns, not
    // rounds, and the row is the same row (3.1.3).
    roundsLabel: localize(card.roundsLabel ?? "RoundsLabel"),
    roundsLine: card.roundsLine ?? "",
    attackBar: card.attackRoll ? diceBar(card.attackRoll, localize("Attack"), { dc: card.dc }) : null,
    defenseBar: defense
      ? diceBar(defense.roll, defense.label ? `${localize("Defense")} · ${defense.label}` : localize("Defense"),
          { soft: true, noRollText: defense.skipped ? localize("DefenseSkippedRow") : localize("DefenseAllOutParryEffect") })
      : null,
    pendingDefense: attack.pending === "defense"
      ? localizeParam("WaitingDefense", { name: attack.targets[0]?.name ?? "" }) : "",
    tally: card.tally ? localizeParam("AutofireTally", card.tally) : "",
    uncovered: card.uncovered ? localizeParam("SpreadUncovered", { uncoveredTargets: card.uncovered }) : "",
    multi,
    targets: attack.targets.map(targetContext),
    buttons,
    fumble: card.fumble ?? null
  });
}

/**
 * Post an attack as its own card. `store` is false for a card nothing will ever apply, which is
 * what an automation-off world posts: the same card, rendered from the same payload, with no flag
 * for the apply path to find.
 */
export async function postAttackCard({ attack, store = true, rolls = [], speaker = undefined,
  messageMode = undefined }) {
  return createCyberpunkRollCard({
    rolls, speaker, content: await renderAttackCard(attack),
    flags: store ? { cyberpunk2020: { attack } } : undefined, messageMode
  });
}

/**
 * One transition of the card: the content is re-rendered from the payload and both are written in
 * one update, which core re-renders in place on every client
 * (`client/documents/chat-message.mjs:559`, `chat.mjs:1383-1386`, 14.365.0).
 */
export async function updateAttackCard(message, attack, { rolls = null } = {}) {
  const data = { content: await renderAttackCard(attack), "flags.cyberpunk2020.attack": attack };
  if (rolls?.length) data.rolls = [...message.rolls, ...rolls.filter(roll => roll?.dice?.length)];
  return message.update(data);
}

/** The waits this client is holding, by message id: what the card's stop button resolves (D259). */
const waits = new Map();

/**
 * Ask an owner and wait without a clock. The wait ends on the answer, on the owner's disconnect
 * (`userConnected`, `client/documents/collections/users.mjs:137`, 14.365.0) or on `stopWaiting`.
 *
 * The disconnect is watched here because the server settles a query only on the **sender's**
 * disconnect or on a timeout (`dist/components/activity.mjs`, the `userQuery` handler), so a
 * recipient who drops off the network would otherwise leave this promise pending for ever.
 *
 * @param {string} messageId The card the wait belongs to; "" when there is no card to press
 * @param {User} owner
 * @param {string} queryName
 * @param {object} payload
 * @returns {Promise<any|null>} the answer, or null when the wait was ended from outside
 */
export function waitForAnswer(messageId, owner, queryName, payload) {
  return new Promise(resolve => {
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      waits.delete(messageId);
      Hooks.off("userConnected", hook);
      resolve(value);
    };
    const hook = Hooks.on("userConnected", (user, connected) => {
      if (user.id === owner.id && !connected) done(null);
    });
    waits.set(messageId, () => {
      // Best effort: the owner may already be gone, and the answer is dropped either way.
      owner.query("cyberpunk2020.promptCancel", { messageId }).catch(() => {});
      done(null);
    });
    owner.query(queryName, { ...payload, messageId }).then(done, () => done(null));
  });
}

/**
 * End the wait this client holds for a card, as if the owner had not answered.
 *
 * @param {string} messageId
 * @returns {boolean} whether there was a wait to end
 */
export function stopWaiting(messageId) {
  const cancel = waits.get(messageId);
  if (!cancel) return false;
  cancel();
  return true;
}

/** Whether this client is the one waiting on that card: only it may offer the stop button. */
export function isWaiting(messageId) {
  return waits.has(messageId);
}
