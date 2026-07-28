import { apiKeyForGame, modelMetadata, normalizeModelConfig } from "./platform/model-registry.js";

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

export class AIDecisionError extends Error {
  constructor(message, code = "ai_decision_error") {
    super(message);
    this.name = "AIDecisionError";
    this.code = code;
  }
}

function extractCompletedSummary(response) {
  const parts = [];
  for (const item of response?.output ?? []) {
    if (item.type !== "reasoning") continue;
    for (const summary of item.summary ?? []) {
      if (summary.type === "summary_text" && summary.text) parts.push(summary.text);
    }
  }
  return parts.join("\n\n").trim();
}

function safeAPIError(status, payload, requestId) {
  const message = payload?.error?.message || payload?.message || `OpenAI returned HTTP ${status}`;
  const code = payload?.error?.code || payload?.error?.type || `http_${status}`;
  const suffix = requestId ? ` (request ${requestId})` : "";
  return new AIDecisionError(`${message}${suffix}`, code);
}

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
  return `You are ${snapshot.actor.name}, ${snapshot.actor.title}, playing no-limit Texas Hold'em in the Luna Room.

Character: ${snapshot.actor.personality}

Choose the strongest strategic action consistent with this character, stack depth, position, betting history, and legal constraints. The local server is the sole authority on rules. Select only an action listed in legal.actions. For bet or raise, target_total means your total chips committed on this street and must be within legal.minimumTotal and legal.maximumTotal. For every other action, target_total must be null.

Do not invent cards or hidden information. Do not describe private chain-of-thought. The explanation is a public, high-level decision rationale of at most 45 words. It may mention relevant factors such as hand class, draw potential, price, position, stack pressure, and your character style, but must not claim to expose hidden reasoning tokens. Return only the requested structured decision.`;
}

async function readResponseStream(response, callbacks) {
  if (!response.body) throw new AIDecisionError("OpenAI returned an empty response stream", "empty_stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outputText = "";
  let summaryText = "";
  let completedResponse = null;

  const handleEvent = (event) => {
    if (!event || typeof event !== "object") return;
    if (event.type === "response.reasoning_summary_text.delta" && event.delta) {
      summaryText += event.delta;
      callbacks.onSummaryDelta?.(event.delta);
    } else if (event.type === "response.output_text.delta" && event.delta) {
      outputText += event.delta;
      callbacks.onOutputDelta?.(event.delta);
    } else if (event.type === "response.completed") {
      completedResponse = event.response;
    } else if (event.type === "response.failed") {
      throw new AIDecisionError(event.response?.error?.message || "OpenAI response failed", "response_failed");
    } else if (event.type === "error") {
      throw new AIDecisionError(event.message || event.error?.message || "OpenAI stream error", "stream_error");
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        handleEvent(JSON.parse(data));
      } catch (error) {
        if (error instanceof AIDecisionError) throw error;
      }
    }
    if (done) break;
  }

  if (!summaryText) summaryText = extractCompletedSummary(completedResponse);
  return { outputText: outputText.trim(), summaryText: summaryText.trim(), response: completedResponse };
}

export async function requestHoldemDecision(snapshot, requestedConfig = {}, callbacks = {}) {
  const aiConfig = normalizeModelConfig("holdem", requestedConfig);
  const { envName, value: apiKey } = apiKeyForGame("holdem");
  if (!apiKey) throw new AIDecisionError(`${envName} is not configured`, "missing_api_key");
  const label = modelMetadata(aiConfig.model)?.label ?? aiConfig.model;

  callbacks.onStatus?.(`Connecting to ${label}…`);
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: aiConfig.model,
        reasoning: { effort: aiConfig.reasoningEffort, summary: "auto" },
        instructions: systemInstructions(snapshot),
        input: JSON.stringify(snapshot),
        text: {
          format: {
            type: "json_schema",
            name: "holdem_decision",
            strict: true,
            schema: DECISION_SCHEMA,
          },
        },
        max_output_tokens: 4096,
        store: false,
        stream: true,
      }),
    });
  } catch (error) {
    throw new AIDecisionError(`Could not reach OpenAI: ${error.message}`, "connection_error");
  }

  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // Keep the generic HTTP error when the body is not JSON.
    }
    throw safeAPIError(response.status, payload, response.headers.get("x-request-id"));
  }

  callbacks.onStatus?.(`${label} is reasoning…`);
  const streamed = await readResponseStream(response, callbacks);
  if (!streamed.outputText) {
    throw new AIDecisionError("The model completed without a decision", "empty_output");
  }

  let parsed;
  try {
    parsed = JSON.parse(streamed.outputText);
  } catch {
    throw new AIDecisionError("The model's structured decision could not be parsed", "invalid_json");
  }

  return {
    ...validateDecision(parsed, snapshot.legal),
    reasoningSummary: streamed.summaryText,
    responseId: streamed.response?.id ?? null,
  };
}

export const requestLunaDecision = (snapshot, callbacks = {}) =>
  requestHoldemDecision(snapshot, { model: "gpt-5.6-luna", reasoningEffort: "medium" }, callbacks);
