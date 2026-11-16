// Xiangqi AI turns through the shared decision gateway. A malformed or illegal answer is
// retried automatically (twice by default) with the exact rejection fed back to the model;
// anything else (network, quota, a third bad answer) is thrown so the room pauses for an
// explicit retry. There is no heuristic fallback player.

import { AIDecisionError, requestStructuredDecision } from "../../platform/decision-gateway.js";
import { XIANGQI_DECISION_SCHEMA, XIANGQI_MAX_ATTEMPTS, buildXiangqiInstructions, parseXiangqiDecision } from "./ai-view.js";

// The gateway adds its own required `tableTalk` string (empty = silent) when a voice is given,
// so the schema sent through it must not already carry one.
const { tableTalk: _engineTableTalk, ...gatewayProperties } = XIANGQI_DECISION_SCHEMA.properties;
export const XIANGQI_GATEWAY_SCHEMA = Object.freeze({
  ...XIANGQI_DECISION_SCHEMA,
  properties: gatewayProperties,
  required: XIANGQI_DECISION_SCHEMA.required.filter((key) => key !== "tableTalk"),
});

const ENGINE_TALK_SENTENCE = /\s*"tableTalk" is an optional in-character remark of at most \d+ characters, or null\./;

export function xiangqiPrompt(view, retryContext = null) {
  const instructions = buildXiangqiInstructions(view, retryContext).replace(ENGINE_TALK_SENTENCE, "");
  const input = {
    you: view.you.side,
    moveNumber: view.moveNumber,
    youAreInCheck: view.youAreInCheck,
    fen: view.fen,
    material: view.material,
    recentMoves: view.recentMoves,
    pliesSinceCapture: view.pliesSinceCapture,
    limits: view.limits,
    tableTalk: view.tableTalk,
  };
  return { instructions, input };
}

export class XiangqiDecisionRejected extends AIDecisionError {
  constructor(message, code, rejected) {
    super(message, code);
    this.rejected = rejected;
  }
}

// One request. Returns { move, choice, explanation, tableTalk, reasoningSummary, reasoningSource }
// or throws XiangqiDecisionRejected (retryable) / any gateway error (not retryable).
export async function requestXiangqiDecision({ state, side, view, modelConfig, voice, retryContext, callbacks = {}, gateway = requestStructuredDecision }) {
  const { instructions, input } = xiangqiPrompt(view, retryContext);
  const response = await gateway({
    gameId: "xiangqi",
    modelConfig,
    tableTalk: { voice: voice ?? "" },
    instructions,
    input,
    schemaName: "xiangqi_decision",
    schema: XIANGQI_GATEWAY_SCHEMA,
  }, callbacks);
  const parsed = parseXiangqiDecision({ ...response.output, tableTalk: response.tableTalk ?? null }, state, side);
  if (!parsed.ok) throw new XiangqiDecisionRejected(parsed.error, parsed.code, response.output);
  return {
    move: parsed.action.move,
    choice: parsed.choice,
    explanation: parsed.explanation,
    tableTalk: parsed.tableTalk,
    reasoningSummary: response.reasoningSummary ?? "",
    reasoningSource: response.reasoningSource ?? "",
  };
}

// viewFactory() must return { state, view } for the side to move, fresh on every attempt.
export async function requestXiangqiDecisionWithRetry({
  viewFactory,
  side,
  modelConfig,
  voice,
  callbacks = {},
  onRetry,
  shouldContinue = () => true,
  maxAttempts = XIANGQI_MAX_ATTEMPTS,
  gateway,
}) {
  let retryContext = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { state, view } = viewFactory();
    try {
      const decision = await requestXiangqiDecision({ state, side, view, modelConfig, voice, retryContext, callbacks, gateway });
      return { decision, attempts: attempt };
    } catch (error) {
      const retryable = error instanceof XiangqiDecisionRejected;
      if (!retryable || attempt >= maxAttempts || !shouldContinue()) {
        if (retryable) error.message = `${error.message} (gave up after ${attempt} attempts)`;
        throw error;
      }
      retryContext = { retryNumber: attempt, maxRetries: maxAttempts - 1, error: error.message };
      await onRetry?.({ error, retryNumber: attempt, maxRetries: maxAttempts - 1 });
    }
  }
  throw new Error("unreachable");
}
