import { AIDecisionError, requestStructuredDecision } from "../platform/decision-gateway.js";

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

export const GO_DECISION_MAX_ATTEMPTS = 3;
const RETRYABLE_GO_DECISION_CODES = new Set(["illegal_move", "invalid_move"]);

function rejectedDecision(error) {
  return error?.rejectedDecision
    ? {
        action: error.rejectedDecision.action,
        row: error.rejectedDecision.row,
        column: error.rejectedDecision.column,
      }
    : null;
}

function instructions(snapshot) {
  const retryInstruction = snapshot.retryContext
    ? `\n\nAUTOMATIC RETRY ${snapshot.retryContext.retryNumber}/${snapshot.retryContext.maxRetries}: The previous decision ${JSON.stringify(snapshot.retryContext.rejectedDecision)} was rejected as illegal or malformed. Do not repeat it. Select one exact row and column pair from legalPlacements, or return pass/resign with both coordinates null.`
    : "";
  return `You are ${snapshot.actor.name}, ${snapshot.actor.title}, playing ${snapshot.actor.color} in Go.

Character: ${snapshot.actor.personality}

The server uses Chinese area scoring, ${snapshot.rules.komi} komi, positional superko, and forbids suicide. Board rows are top to bottom; columns are left to right; B is black, W is white, and . is empty. For place, select a zero-based row and column from legalPlacements. For pass or resign, row and column must both be null. Passing is strategic and two consecutive passes end the game.${retryInstruction}

Choose a strong move consistent with the character while considering liberties, captures, connection, cutting points, influence, territory, ko, sente, and the phase of the game. Never invent board state. Do not expose private chain-of-thought. The explanation is a public high-level rationale of at most 45 words. Return only the requested structured decision.`;
}

export async function requestGoDecision(snapshot, modelConfig, callbacks = {}) {
  const response = await requestStructuredDecision({
    gameId: "go",
    modelConfig,
    tableTalk: { voice: snapshot.actor?.voice ?? "" },
    instructions: instructions(snapshot),
    input: snapshot,
    schemaName: "go_decision",
    schema: GO_DECISION_SCHEMA,
  }, callbacks);
  const decision = response.output;
  if (decision.action === "place") {
    if (!Number.isInteger(decision.row) || !Number.isInteger(decision.column)) {
      const error = new AIDecisionError("The model omitted a Go intersection", "invalid_move");
      error.rejectedDecision = decision;
      throw error;
    }
    const legal = snapshot.legalPlacements.some(([row, column]) => row === decision.row && column === decision.column);
    if (!legal) {
      const error = new AIDecisionError("The model selected an illegal Go intersection", "illegal_move");
      error.rejectedDecision = decision;
      throw error;
    }
  } else if (decision.row !== null || decision.column !== null) {
    const error = new AIDecisionError("Pass and resign must not include a Go intersection", "invalid_move");
    error.rejectedDecision = decision;
    throw error;
  }
  return {
    action: decision.action,
    row: decision.row,
    column: decision.column,
    explanation: String(decision.explanation).slice(0, 420),
    reasoningSummary: response.reasoningSummary,
    reasoningSource: response.reasoningSource,
    responseId: response.responseId,
    tableTalk: response.tableTalk ?? null,
  };
}

export async function requestGoDecisionWithRetry({
  snapshotFactory,
  modelConfig,
  callbacks = {},
  onRetry,
  shouldContinue = () => true,
  maxAttempts = GO_DECISION_MAX_ATTEMPTS,
  requestDecision = requestGoDecision,
}) {
  const attemptLimit = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : GO_DECISION_MAX_ATTEMPTS;
  let previousError = null;

  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    const baseSnapshot = snapshotFactory();
    const snapshot = previousError
      ? {
          ...baseSnapshot,
          retryContext: {
            retryNumber: attempt - 1,
            maxRetries: attemptLimit - 1,
            previousError: previousError.message,
            rejectedDecision: rejectedDecision(previousError),
          },
        }
      : baseSnapshot;

    try {
      const decision = await requestDecision(snapshot, modelConfig, callbacks);
      return { decision, attempts: attempt };
    } catch (error) {
      const retryable = error instanceof AIDecisionError && RETRYABLE_GO_DECISION_CODES.has(error.code);
      if (!retryable || attempt >= attemptLimit || !shouldContinue()) throw error;
      previousError = error;
      await onRetry?.({
        error,
        retryNumber: attempt,
        maxRetries: attemptLimit - 1,
      });
    }
  }

  throw previousError;
}

const GO_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    review: { type: "string", minLength: 1, maxLength: 1200 },
    keyMoments: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          coordinate: { type: "string", maxLength: 4 },
          note: { type: "string", minLength: 1, maxLength: 220 },
        },
        required: ["coordinate", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["review", "keyMoments"],
  additionalProperties: false,
};

/** A finished-game review in the reviewer's own voice. The snapshot comes from GoGame.reviewSnapshot(). */
export async function requestGoReview(snapshot, modelConfig, callbacks = {}) {
  const response = await requestStructuredDecision({
    gameId: "go",
    modelConfig,
    instructions: `You are ${snapshot.reviewer.name}, ${snapshot.reviewer.title}. You just played ${snapshot.reviewer.color} in this finished Go game and now review it for the table, in character.

Character: ${snapshot.reviewer.personality}
Voice: ${snapshot.reviewer.voice}

Columns are letters A-T without I, left to right; rows are numbers counted from the bottom. Write the review in at most 150 words: what decided the game, what each side did well or badly, and one concrete lesson. Then list up to four key moments, each with the exact coordinate of a move from the record and a one-sentence note. Never invent moves that are not in the record.`,
    input: snapshot,
    schemaName: "go_review",
    schema: GO_REVIEW_SCHEMA,
  }, callbacks);
  const output = response.output;
  return {
    text: String(output.review).trim().slice(0, 1200),
    keyMoments: (Array.isArray(output.keyMoments) ? output.keyMoments : [])
      .slice(0, 4)
      .map((moment) => ({ coordinate: String(moment.coordinate).trim().toUpperCase().slice(0, 4), note: String(moment.note).trim().slice(0, 220) })),
  };
}
