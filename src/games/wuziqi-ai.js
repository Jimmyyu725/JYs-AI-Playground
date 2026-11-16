import { AIDecisionError, requestStructuredDecision } from "../platform/decision-gateway.js";

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

const WUZIQI_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", minLength: 1, maxLength: 400 },
    keyMoments: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          moveNumber: { type: "integer" },
          comment: { type: "string", minLength: 1, maxLength: 260 },
        },
        required: ["moveNumber", "comment"],
        additionalProperties: false,
      },
    },
    lesson: { type: "string", minLength: 1, maxLength: 260 },
  },
  required: ["verdict", "keyMoments", "lesson"],
  additionalProperties: false,
};

/** One decision plus two automatic retries for malformed or illegal moves, then the room pauses. */
export const WUZIQI_DECISION_MAX_ATTEMPTS = 3;
const RETRYABLE_CODES = new Set(["illegal_move", "invalid_move"]);

function retryInstruction(snapshot) {
  const context = snapshot.retryContext;
  if (!context) return "";
  return `\n\nAUTOMATIC RETRY ${context.retryNumber}/${context.maxRetries}: your previous decision ${JSON.stringify(context.rejectedDecision)} was rejected: ${context.previousError}. Do not repeat it. Pick one exact [row, column] pair from legalPlacements, or resign with both coordinates null.`;
}

function instructions(snapshot) {
  return `You are ${snapshot.actor.name}, ${snapshot.actor.title}, playing ${snapshot.actor.color} in freestyle Wuziqi (Gomoku).

Character: ${snapshot.actor.personality}

Five or more contiguous stones horizontally, vertically, or diagonally win. Overlines win and there are no Renju forbidden moves. Board rows are top to bottom; columns are left to right; B is black, W is white, and . is empty. Coordinates such as H8 use Go-style column letters that skip I, so column H is followed directly by J. For place, choose a zero-based row and column from legalPlacements. For resign, row and column must both be null.

Prioritize immediate wins, mandatory blocks, open fours, double threats, and strong intersecting lines. Play consistently with the character without sacrificing tactical correctness. Never invent board state. Do not expose private chain-of-thought. The explanation is a public high-level rationale of at most 45 words. Return only the requested structured decision.${retryInstruction(snapshot)}`;
}

function rejected(decision, message, code) {
  const error = new AIDecisionError(message, code);
  error.rejectedDecision = { action: decision?.action ?? null, row: decision?.row ?? null, column: decision?.column ?? null };
  return error;
}

/** Throws a retryable AIDecisionError when the structured output is not a legal move in `snapshot`. */
export function validateWuziqiDecision(snapshot, decision) {
  if (decision?.action === "place") {
    if (!Number.isInteger(decision.row) || !Number.isInteger(decision.column)) throw rejected(decision, "The model omitted a Wuziqi intersection", "invalid_move");
    const legal = snapshot.legalPlacements.some(([row, column]) => row === decision.row && column === decision.column);
    if (!legal) throw rejected(decision, `The model chose row ${decision.row}, column ${decision.column}, which is occupied or off the board`, "illegal_move");
  } else if (decision?.action === "resign") {
    if (decision.row !== null || decision.column !== null) throw rejected(decision, "Resign must not include a Wuziqi intersection", "invalid_move");
  } else {
    throw rejected(decision, "The model returned no valid Wuziqi action", "invalid_move");
  }
}

export async function requestWuziqiDecision(snapshot, modelConfig, callbacks = {}, request = requestStructuredDecision) {
  const response = await request({
    gameId: "wuziqi",
    modelConfig,
    tableTalk: { voice: snapshot.actor?.voice ?? "" },
    instructions: instructions(snapshot),
    input: snapshot,
    schemaName: "wuziqi_decision",
    schema: WUZIQI_DECISION_SCHEMA,
  }, callbacks);
  const decision = response.output;
  validateWuziqiDecision(snapshot, decision);
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

/**
 * Asks for a decision and, when the model returns a malformed or illegal move, asks again with the
 * rejection fed back (two automatic retries). Any other failure, or a third rejection, is thrown so
 * the room can pause for an explicit retry.
 */
export async function requestWuziqiDecisionWithRetry({
  snapshotFactory,
  modelConfig,
  callbacks = {},
  onRetry,
  shouldContinue = () => true,
  maxAttempts = WUZIQI_DECISION_MAX_ATTEMPTS,
  requestDecision = requestWuziqiDecision,
}) {
  let previousError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const base = snapshotFactory();
    const snapshot = previousError
      ? { ...base, retryContext: { retryNumber: attempt - 1, maxRetries: maxAttempts - 1, previousError: previousError.message, rejectedDecision: previousError.rejectedDecision ?? null } }
      : base;
    try {
      return { decision: await requestDecision(snapshot, modelConfig, callbacks), attempts: attempt };
    } catch (error) {
      const retryable = error instanceof AIDecisionError && RETRYABLE_CODES.has(error.code);
      if (!retryable || attempt >= maxAttempts || !shouldContinue()) throw error;
      previousError = error;
      await onRetry?.({ error, retryNumber: attempt, maxRetries: maxAttempts - 1 });
    }
  }
  throw previousError;
}

/** Post-game review in the reviewer's own voice. `snapshot` comes from WuziqiGame.reviewSnapshot(). */
export async function requestWuziqiReview(snapshot, modelConfig, request = requestStructuredDecision) {
  const response = await request({
    gameId: "wuziqi",
    modelConfig,
    instructions: `You are ${snapshot.reviewer.name}, ${snapshot.reviewer.title}. Character: ${snapshot.reviewer.personality} Voice: ${snapshot.reviewer.voice}

You just ${snapshot.reviewer.role === "player" ? `played ${snapshot.reviewer.color} in` : "watched"} a game of freestyle Wuziqi (Gomoku: five or more in a row wins, overlines win, no forbidden moves). Review it for the players in your own voice. The verdict is two or three sentences on how the game was decided. keyMoments picks two to four turning points by moveNumber (from the moves list) with a concrete comment on the threat that was made or missed; refer to points by their coordinate. Column letters follow the Go convention and skip I, so H and J are adjacent columns (H8 and J9 are diagonal neighbours); finalBoardRows lists the final position row by row from the top, columns A to the last letter. The lesson is one practical takeaway. Use only the moves given; never invent positions, and trust the recorded result.`,
    input: snapshot,
    schemaName: "wuziqi_review",
    schema: WUZIQI_REVIEW_SCHEMA,
  });
  const output = response.output ?? {};
  const maxMove = snapshot.moves.length;
  return {
    verdict: String(output.verdict ?? "").slice(0, 400),
    keyMoments: (Array.isArray(output.keyMoments) ? output.keyMoments : [])
      .filter((moment) => Number.isInteger(moment?.moveNumber) && moment.moveNumber >= 1 && moment.moveNumber <= maxMove)
      .slice(0, 4)
      .map((moment) => ({ moveNumber: moment.moveNumber, comment: String(moment.comment ?? "").slice(0, 260) })),
    lesson: String(output.lesson ?? "").slice(0, 260),
  };
}
