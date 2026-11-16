// One AI turn at a Liar's Dice table: prompt the seat's model through the shared decision
// gateway, map the answer to an engine action, and retry a malformed or illegal answer up to
// twice with the error fed back. Anything else (network, API, key) is thrown so the room can
// pause for an explicit retry. There is no heuristic fallback player.

import { AIDecisionError, requestStructuredDecision } from "../../platform/decision-gateway.js";
import { buildAIView, buildInstructions, DECISION_SCHEMA, parseDecision } from "./ai-view.js";

export const LIARS_DICE_MAX_ATTEMPTS = 3;

// The gateway adds its own required tableTalk string (with the character's voice), so the
// engine schema's nullable tableTalk is removed here to avoid declaring the field twice.
const { tableTalk: _omitTalk, ...gatewayProperties } = DECISION_SCHEMA.properties;
export const GATEWAY_SCHEMA = Object.freeze({
  ...DECISION_SCHEMA,
  properties: gatewayProperties,
  required: DECISION_SCHEMA.required.filter((key) => key !== "tableTalk"),
});

export function describeAction(action) {
  if (action.type === "dudo") return "calls Liar!";
  if (action.type === "calza") return "calls Calza (spot on)";
  return `bids ${action.quantity} × ${action.face}${action.quantity === 1 ? "" : "s"}`;
}

/**
 * @param {object} options
 * @param {object} options.state engine state (not mutated)
 * @param {number} options.seat acting seat
 * @param {string[]} options.seatNames
 * @param {object} options.character roster entry ({ name, title, personality, voice })
 * @param {{model, reasoningEffort}} options.modelConfig
 * @returns {Promise<{ action, explanation, tableTalk, reasoningSummary, attempts }>}
 */
export async function requestLiarsDiceMove({
  state,
  seat,
  seatNames,
  character,
  modelConfig,
  callbacks = {},
  onRetry,
  shouldContinue = () => true,
  maxAttempts = LIARS_DICE_MAX_ATTEMPTS,
  requestDecision = requestStructuredDecision,
}) {
  let retry = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const view = buildAIView(state, seat, { seatNames, character });
    const response = await requestDecision({
      gameId: "liars-dice",
      modelConfig,
      tableTalk: { voice: character?.voice ?? "" },
      instructions: buildInstructions(view, retry),
      input: view,
      schemaName: "liars_dice_decision",
      schema: GATEWAY_SCHEMA,
    }, callbacks);
    const output = response?.output ?? {};
    const parsed = parseDecision(state, seat, { ...output, tableTalk: null });
    if (parsed.ok) {
      return {
        action: parsed.action,
        explanation: parsed.explanation || "Decision made.",
        tableTalk: response.tableTalk ?? null,
        reasoningSummary: response.reasoningSummary ?? "",
        attempts: attempt,
      };
    }
    if (parsed.error.code === "not_your_turn") throw new AIDecisionError(parsed.error.message, "not_your_turn");
    if (attempt >= maxAttempts || !shouldContinue()) {
      throw new AIDecisionError(`The model's move was rejected ${attempt} times; last error: ${parsed.error.message}`, "illegal_move");
    }
    retry = { retryNumber: attempt, maxRetries: maxAttempts - 1, rejected: output, error: parsed.error.message };
    await onRetry?.({ error: parsed.error, retryNumber: attempt, maxRetries: maxAttempts - 1 });
  }
  throw new AIDecisionError("No decision was made", "illegal_move");
}

/** Post-game review: one character looks back over the finished game in its own voice. */
export const REVIEW_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    headline: { type: "string", minLength: 1, maxLength: 90 },
    review: { type: "string", minLength: 1, maxLength: 900 },
    keyMoment: { type: "string", minLength: 1, maxLength: 280 },
  },
  required: ["headline", "review", "keyMoment"],
  additionalProperties: false,
});

export function reviewInput(table) {
  const names = table.seatNames;
  const name = (seat) => names[seat] ?? `Seat ${seat}`;
  const events = table.state.events
    .filter((event) => ["round_start", "bid", "dudo", "calza", "die_lost", "die_gained", "eliminated", "game_over"].includes(event.type))
    .map((event) => {
      switch (event.type) {
        case "round_start": return `Round ${event.round}${event.palifico ? " (palifico)" : ""}: ${name(event.starterSeat)} opens, ${event.totalDice} dice on the table.`;
        case "bid": return `${name(event.seat)} bids ${event.quantity} × ${event.face}s.`;
        case "dudo": return `${name(event.seat)} calls Liar on ${event.bid.quantity} × ${event.bid.face}s: there were ${event.count}; ${event.outcome === "bid_holds" ? "the bid held" : "the bid failed"}.`;
        case "calza": return `${name(event.seat)} calls Calza on ${event.bid.quantity} × ${event.bid.face}s: there were ${event.count} (${event.outcome === "exact" ? "exact" : "not exact"}).`;
        case "die_lost": return `${name(event.seat)} loses a die (${event.diceLeft} left).`;
        case "die_gained": return `${name(event.seat)} wins a die back (${event.diceLeft}).`;
        case "eliminated": return `${name(event.seat)} is out.`;
        case "game_over": return `${name(event.winnerSeat)} wins the game.`;
        default: return "";
      }
    });
  return {
    players: table.players.map((player) => ({ seat: player.seat, name: player.name, kind: player.isHuman ? "human" : "ai" })),
    placements: table.state.result?.placements.map((entry) => ({ place: entry.place, name: name(entry.seat) })) ?? [],
    log: events.slice(-160),
  };
}

export async function requestLiarsDiceReview({ table, reviewer, modelConfig, requestDecision = requestStructuredDecision }) {
  const response = await requestDecision({
    gameId: "liars-dice",
    modelConfig,
    instructions: `You are ${reviewer.name}, ${reviewer.title}. Character: ${reviewer.personality}\nVoice: ${reviewer.voice}\n\nThe Liar's Dice game below (Perudo rules, ones wild except in palifico rounds) has just finished. Review it in your own voice for the table: who read the table well, which bluffs or calls decided it, and one concrete lesson for the human player if there was one. Be specific about rounds and bids from the log. "headline" is a short title, "review" at most 120 words, "keyMoment" names the single turning point.`,
    input: reviewInput(table),
    schemaName: "liars_dice_review",
    schema: REVIEW_SCHEMA,
  });
  return { ...response.output, reviewer: reviewer.id, reasoningSummary: response.reasoningSummary ?? "" };
}
