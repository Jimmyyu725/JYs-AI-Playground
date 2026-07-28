import { AIDecisionError, requestStructuredDecision } from "../platform/openai-gateway.js";

const WUZIQI_DECISION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["place", "resign"] },
    row: { anyOf: [{ type: "integer" }, { type: "null" }] },
    column: { anyOf: [{ type: "integer" }, { type: "null" }] },
    explanation: { type: "string", minLength: 1, maxLength: 420 },
  },
  required: ["action", "row", "column", "explanation"],
  additionalProperties: false,
};

function instructions(snapshot) {
  return `You are ${snapshot.actor.name}, ${snapshot.actor.title}, playing ${snapshot.actor.color} in freestyle Wuziqi (Gomoku).

Character: ${snapshot.actor.personality}

Five or more contiguous stones horizontally, vertically, or diagonally win. Overlines win and there are no Renju forbidden moves. Board rows are top to bottom; columns are left to right; B is black, W is white, and . is empty. For place, choose a zero-based row and column from legalPlacements. For resign, row and column must both be null.

Prioritize immediate wins, mandatory blocks, open fours, double threats, and strong intersecting lines. Play consistently with the character without sacrificing tactical correctness. Never invent board state. Do not expose private chain-of-thought. The explanation is a public high-level rationale of at most 45 words. Return only the requested structured decision.`;
}

export async function requestWuziqiDecision(snapshot, modelConfig, callbacks = {}) {
  const response = await requestStructuredDecision({
    gameId: "wuziqi",
    modelConfig,
    instructions: instructions(snapshot),
    input: snapshot,
    schemaName: "wuziqi_decision",
    schema: WUZIQI_DECISION_SCHEMA,
  }, callbacks);
  const decision = response.output;
  if (decision.action === "place") {
    if (!Number.isInteger(decision.row) || !Number.isInteger(decision.column)) throw new AIDecisionError("The model omitted a Wuziqi intersection", "invalid_move");
    const legal = snapshot.legalPlacements.some(([row, column]) => row === decision.row && column === decision.column);
    if (!legal) throw new AIDecisionError("The model selected an occupied or invalid Wuziqi intersection", "illegal_move");
  } else if (decision.row !== null || decision.column !== null) {
    throw new AIDecisionError("Resign must not include a Wuziqi intersection", "invalid_move");
  }
  return {
    action: decision.action,
    row: decision.row,
    column: decision.column,
    explanation: String(decision.explanation).slice(0, 420),
    reasoningSummary: response.reasoningSummary,
    responseId: response.responseId,
  };
}
