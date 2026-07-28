import { AIDecisionError, requestStructuredDecision } from "../platform/openai-gateway.js";

const GO_DECISION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["place", "pass", "resign"] },
    row: { anyOf: [{ type: "integer" }, { type: "null" }] },
    column: { anyOf: [{ type: "integer" }, { type: "null" }] },
    explanation: { type: "string", minLength: 1, maxLength: 420 },
  },
  required: ["action", "row", "column", "explanation"],
  additionalProperties: false,
};

function instructions(snapshot) {
  return `You are ${snapshot.actor.name}, ${snapshot.actor.title}, playing ${snapshot.actor.color} in Go.

Character: ${snapshot.actor.personality}

The server uses Chinese area scoring, ${snapshot.rules.komi} komi, positional superko, and forbids suicide. Board rows are top to bottom; columns are left to right; B is black, W is white, and . is empty. For place, select a zero-based row and column from legalPlacements. For pass or resign, row and column must both be null. Passing is strategic and two consecutive passes end the game.

Choose a strong move consistent with the character while considering liberties, captures, connection, cutting points, influence, territory, ko, sente, and the phase of the game. Never invent board state. Do not expose private chain-of-thought. The explanation is a public high-level rationale of at most 45 words. Return only the requested structured decision.`;
}

export async function requestGoDecision(snapshot, modelConfig, callbacks = {}) {
  const response = await requestStructuredDecision({
    gameId: "go",
    modelConfig,
    instructions: instructions(snapshot),
    input: snapshot,
    schemaName: "go_decision",
    schema: GO_DECISION_SCHEMA,
  }, callbacks);
  const decision = response.output;
  if (decision.action === "place") {
    if (!Number.isInteger(decision.row) || !Number.isInteger(decision.column)) {
      throw new AIDecisionError("The model omitted a Go intersection", "invalid_move");
    }
    const legal = snapshot.legalPlacements.some(([row, column]) => row === decision.row && column === decision.column);
    if (!legal) throw new AIDecisionError("The model selected an illegal Go intersection", "illegal_move");
  } else if (decision.row !== null || decision.column !== null) {
    throw new AIDecisionError("Pass and resign must not include a Go intersection", "invalid_move");
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
