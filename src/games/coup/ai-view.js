// Model-facing view of a Coup game for one seat.
//
// buildCoupAiView    -> snapshot with only what that seat may know + a numbered legal-action list
// coupDecisionSchema -> strict JSON schema for the model's answer ({ actionId, tableTalk })
// coupDecisionPrompt -> instructions text (rules, situation, retry note)
// parseCoupDecision  -> maps the answer back to a legal engine action, or returns a precise error

import {
  ACTION_RULES,
  ASSASSINATE_COST,
  COUP_COST,
  FORCED_COUP_COINS,
  awaitingSeats,
  describeAction,
  getLegalActions,
  liveCards,
  publicView,
  revealedCards,
} from "./engine.js";

export const TABLE_TALK_MAX = 140;
const RECENT_EVENT_LIMIT = 24;
export const RETRYABLE_DECISION_CODES = Object.freeze(new Set(["invalid_json", "invalid_shape", "invalid_action_id", "invalid_table_talk"]));

export const COUP_RULES_TEXT = [
  "Coup is a bluffing game. The court deck has 15 cards: 3 each of Duke, Assassin, Captain, Ambassador, Contessa.",
  "Each player starts with 2 face-down influence cards and 2 coins. Losing an influence turns one card face up for good; a player with no face-down cards is out. The last player with influence wins.",
  "On your turn take one action. Income: +1 coin. Foreign Aid: +2 coins (any player may block by claiming Duke). " +
    `Coup: pay ${COUP_COST}, target loses an influence, cannot be blocked or challenged. ` +
    `With ${FORCED_COUP_COINS}+ coins you must Coup.`,
  "Character actions (you may claim a card you do not hold): Tax (Duke): +3 coins. " +
    `Assassinate (Assassin): pay ${ASSASSINATE_COST}, target loses an influence; the target may block by claiming Contessa. ` +
    "Steal (Captain): take up to 2 coins from a player; the target may block by claiming Captain or Ambassador. " +
    "Exchange (Ambassador): draw 2 court cards, then return 2 cards of your choice to the deck.",
  "Any other living player may challenge a character claim (an action or a block). If the claimant holds the card, they show it, shuffle it into the deck and draw a new one, and the challenger loses an influence. " +
    "Otherwise the claimant loses an influence and the claimed action or block fails (Assassin coins are refunded when the Assassin claim is caught).",
  "A blocked action fails; Assassin coins spent on a blocked assassination are not refunded. Blocks can be challenged by anyone except the blocker.",
].join("\n");

function situationText(state, seat) {
  const pending = state.pendingAction;
  const name = (target) => state.players[target]?.name ?? `seat ${target}`;
  const actionText = () => {
    if (!pending) return "";
    const target = pending.target === null ? "" : ` against ${pending.target === seat ? "YOU" : name(pending.target)}`;
    const claim = pending.claim ? ` claiming ${pending.claim}` : "";
    const paid = pending.paid ? ` (the ${pending.paid}-coin cost is already paid and shown in the coin counts)` : "";
    return `${pending.actor === seat ? "You" : name(pending.actor)} declared ${pending.type.replace("_", " ")}${target}${claim}${paid}`;
  };
  switch (state.phase) {
    case "action":
      return state.players[seat].coins >= FORCED_COUP_COINS
        ? `It is your turn. You hold ${state.players[seat].coins} coins, so you must launch a Coup.`
        : "It is your turn: choose one action.";
    case "challenge_action":
      return `${actionText()}. You may challenge that claim or pass.`;
    case "block": {
      const blockers = ACTION_RULES[pending.type].blockedBy.join(" or ");
      return `${actionText()}. Nobody challenged. You may block by claiming ${blockers}, or pass and let it happen.`;
    }
    case "challenge_block":
      return `${actionText()}. ${state.block.seat === seat ? "You" : name(state.block.seat)} blocked it claiming ${state.block.card}. You may challenge the block or pass (if everyone passes, the block stands).`;
    case "lose_influence":
      return `You must lose one influence (reason: ${state.lossPending.reason.replace("_", " ")}). Choose which face-down card to turn face up.`;
    case "exchange":
      return `Your exchange drew two cards. Keep ${state.exchange.keepCount} of the options and return the rest to the deck.`;
    default:
      return "The game is over.";
  }
}

/**
 * Snapshot for the model controlling `seat`. Contains only information that seat
 * may legally know: its own face-down cards, public coins and revealed cards,
 * deck size, and the public event log. Never the deck order or other hands.
 */
export function buildCoupAiView(state, seat, { persona = null } = {}) {
  const me = state.players[seat];
  if (!me) throw new Error(`Seat ${seat} does not exist`);
  const view = publicView(state, seat);
  const legal = getLegalActions(state, seat);
  return {
    game: "Coup",
    step: state.step,
    turn: state.turn,
    phase: state.phase,
    yourTurnToDecide: awaitingSeats(state).includes(seat),
    you: {
      seat,
      name: me.name,
      persona,
      coins: me.coins,
      faceDownCards: liveCards(me),
      lostCards: revealedCards(me),
    },
    situation: situationText(state, seat),
    activeSeat: state.activeSeat,
    pendingAction: view.pendingAction
      ? {
          type: view.pendingAction.type,
          actor: view.pendingAction.actor,
          target: view.pendingAction.target,
          claim: view.pendingAction.claim,
        }
      : null,
    block: view.block,
    exchangeOptions: view.exchange?.options ?? null,
    opponents: view.players
      .filter((player) => player.seat !== seat)
      .map((player) => ({
        seat: player.seat,
        name: player.name,
        coins: player.coins,
        alive: player.alive,
        faceDownCount: player.influenceCount,
        lostCards: player.revealed,
      })),
    deckCount: view.deckCount,
    recentEvents: view.log.slice(-RECENT_EVENT_LIMIT).map((entry) => entry.text),
    legalActions: legal.map((action, index) => ({
      id: index + 1,
      label: describeAction(state, seat, action),
      action,
    })),
  };
}

/** Strict structured-output schema: pick one numbered legal action, optional table talk. */
export function coupDecisionSchema(view) {
  const ids = view.legalActions.map((entry) => entry.id);
  return {
    type: "object",
    properties: {
      actionId: { type: "integer", enum: ids.length ? ids : [1] },
      tableTalk: {
        anyOf: [{ type: "string", maxLength: TABLE_TALK_MAX }, { type: "null" }],
      },
    },
    required: ["actionId", "tableTalk"],
    additionalProperties: false,
  };
}

/** Instructions text for the model; pass the previous error to build a retry prompt. */
export function coupDecisionPrompt(view, retry = null) {
  const persona = view.you.persona ? `\nCharacter: ${view.you.persona}` : "";
  const options = view.legalActions.map((entry) => `${entry.id}. ${entry.label}`).join("\n");
  const retryText = retry
    ? `\n\nAUTOMATIC RETRY ${retry.retryNumber}/${retry.maxRetries}: your previous answer was rejected: ${retry.error}. Answer again with a valid actionId from the list.`
    : "";
  return `You are ${view.you.name}, playing Coup at seat ${view.you.seat}.${persona}

RULES
${COUP_RULES_TEXT}

YOUR POSITION
Face-down cards (secret): ${view.you.faceDownCards.join(", ") || "none"}. Lost cards: ${view.you.lostCards.join(", ") || "none"}. Coins: ${view.you.coins}.
Opponents: ${view.opponents.map((player) => `${player.name} (seat ${player.seat}): ${player.alive ? `${player.faceDownCount} face-down` : "out"}, ${player.coins} coins${player.lostCards.length ? `, lost ${player.lostCards.join("/")}` : ""}`).join("; ")}.
Court deck: ${view.deckCount} cards.${view.exchangeOptions ? `\nExchange options: ${view.exchangeOptions.join(", ")}.` : ""}

RECENT EVENTS
${view.recentEvents.join("\n") || "none"}

DECISION
${view.situation}
${options}

Answer with the actionId of exactly one option above. tableTalk is an optional in-character line said aloud to the table (at most ${TABLE_TALK_MAX} characters, or null). Never reveal your face-down cards unless you intend to bluff.${retryText}`;
}

function fail(code, error) {
  return { ok: false, code, retryable: RETRYABLE_DECISION_CODES.has(code), error };
}

/**
 * Validate a model answer against the CURRENT state for `seat`.
 * `raw` may be a JSON string or an already-parsed object.
 * Options: { viewStep } rejects answers produced for an older snapshot.
 * Returns { ok: true, action, actionId, label, tableTalk } or { ok: false, code, retryable, error }.
 */
export function parseCoupDecision(state, seat, raw, { viewStep = null } = {}) {
  if (state.phase === "game_over") return fail("game_over", "The game is already over");
  if (!awaitingSeats(state).includes(seat)) {
    return fail("not_awaited", `Seat ${seat} is not expected to decide now (phase ${state.phase}, waiting on ${awaitingSeats(state).join(", ")})`);
  }
  if (viewStep !== null && viewStep !== state.step) {
    return fail("stale_view", `The decision was made for step ${viewStep} but the game is now at step ${state.step}`);
  }

  let decision = raw;
  if (typeof raw === "string") {
    try {
      decision = JSON.parse(raw);
    } catch (error) {
      return fail("invalid_json", `The answer is not valid JSON (${error.message})`);
    }
  }
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return fail("invalid_shape", "The answer must be a JSON object with actionId and tableTalk");
  }

  const legal = getLegalActions(state, seat);
  const { actionId } = decision;
  const range = legal.length === 1 ? "1" : `1-${legal.length}`;
  if (actionId === undefined || actionId === null) return fail("invalid_action_id", `actionId is missing; choose an integer in ${range}`);
  if (typeof actionId !== "number" || !Number.isInteger(actionId)) {
    return fail("invalid_action_id", `actionId must be an integer in ${range}, got ${JSON.stringify(actionId)}`);
  }
  if (actionId < 1 || actionId > legal.length) {
    return fail("invalid_action_id", `actionId ${actionId} is not one of the legal options ${range}`);
  }

  let tableTalk = decision.tableTalk ?? null;
  if (tableTalk !== null && typeof tableTalk !== "string") {
    return fail("invalid_table_talk", `tableTalk must be a string of at most ${TABLE_TALK_MAX} characters or null`);
  }
  if (tableTalk !== null) {
    // Over-long talk is trimmed instead of rejected: it is flavour, not a rule.
    tableTalk = tableTalk.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, TABLE_TALK_MAX) || null;
  }

  const action = legal[actionId - 1];
  return { ok: true, actionId, action, label: describeAction(state, seat, action), tableTalk };
}
