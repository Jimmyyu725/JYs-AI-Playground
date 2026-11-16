import { AIDecisionError, requestStructuredDecision } from "./platform/decision-gateway.js";

const DECISION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["fold", "check", "call", "bet", "raise", "all_in"] },
    target_total: { anyOf: [{ type: "integer" }, { type: "null" }] },
    explanation: { type: "string", minLength: 1, maxLength: 420 },
  },
  required: ["action", "target_total", "explanation"],
  additionalProperties: false,
};

export { AIDecisionError } from "./platform/decision-gateway.js";

function validateDecision(decision, legal) {
  if (!decision || typeof decision !== "object") throw new AIDecisionError("The model returned no decision object", "invalid_output");
  if (!legal.actions.includes(decision.action)) {
    throw new AIDecisionError(`The model selected illegal action “${decision.action}”`, "illegal_action");
  }
  if (decision.action === "bet" || decision.action === "raise") {
    if (!Number.isInteger(decision.target_total)) {
      throw new AIDecisionError("The model omitted the required bet or raise total", "invalid_sizing");
    }
    if (decision.target_total < legal.minimumTotal || decision.target_total > legal.maximumTotal) {
      throw new AIDecisionError(
        `The model sized outside the legal range ${legal.minimumTotal}–${legal.maximumTotal}`,
        "invalid_sizing",
      );
    }
  }
  return {
    action: decision.action,
    targetTotal: decision.action === "bet" || decision.action === "raise" ? decision.target_total : null,
    explanation: String(decision.explanation ?? "Decision complete.").slice(0, 420),
  };
}

function systemInstructions(snapshot) {
  return `You are ${snapshot.actor.name}, ${snapshot.actor.title}, playing no-limit Texas Hold'em at Salon Riviera.

Character: ${snapshot.actor.personality}

Choose the strongest strategic action consistent with this character, stack depth, position, betting history, and legal constraints. The local server is the sole authority on rules. Select only an action listed in legal.actions. For bet or raise, target_total means your total chips committed on this street and must be within legal.minimumTotal and legal.maximumTotal. For every other action, target_total must be null.

Do not invent cards or hidden information. Do not describe private chain-of-thought. The explanation is a public, high-level decision rationale of at most 45 words. It may mention relevant factors such as hand class, draw potential, price, position, stack pressure, and your character style, but must not claim to expose hidden reasoning tokens. Return only the requested structured decision.

This salon expects some theatre: when you bet, raise, or go all-in, put a short in-character line in tableTalk. Folds, checks, and calls usually stay silent.`;
}

export async function requestHoldemDecision(snapshot, requestedConfig = {}, callbacks = {}) {
  const result = await requestStructuredDecision({
    gameId: "holdem",
    modelConfig: requestedConfig,
    tableTalk: { voice: snapshot.actor?.voice ?? "" },
    instructions: systemInstructions(snapshot),
    input: snapshot,
    schemaName: "holdem_decision",
    schema: DECISION_SCHEMA,
  }, callbacks);

  return {
    ...validateDecision(result.output, snapshot.legal),
    reasoningSummary: result.reasoningSummary,
    reasoningSource: result.reasoningSource,
    responseId: result.responseId,
    tableTalk: result.tableTalk ?? null,
  };
}

export const requestLunaDecision = (snapshot, callbacks = {}) =>
  requestHoldemDecision(snapshot, { model: "gpt-6-luna", reasoningEffort: "low" }, callbacks);
