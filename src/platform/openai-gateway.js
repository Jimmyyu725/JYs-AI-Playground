import { apiKeyForGame, deepseekApiKeyForGame, modelMetadata, modelProvider, normalizeModelConfig } from "./model-registry.js";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

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

function extractCompletedOutputText(response) {
  const parts = [];
  for (const item of response?.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function safeAPIError(status, payload, requestId) {
  const message = payload?.error?.message || payload?.message || `OpenAI returned HTTP ${status}`;
  const code = payload?.error?.code || payload?.error?.type || `http_${status}`;
  const suffix = requestId ? ` (request ${requestId})` : "";
  return new AIDecisionError(`${message}${suffix}`, code);
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
    } else if (event.type === "response.incomplete") {
      const reason = event.response?.incomplete_details?.reason || "unknown reason";
      throw new AIDecisionError(`The model stopped before completing its decision (${reason})`, "incomplete_response");
    } else if (event.type === "response.failed") {
      throw new AIDecisionError(event.response?.error?.message || "OpenAI response failed", "response_failed");
    } else if (event.type === "error") {
      throw new AIDecisionError(event.message || event.error?.message || "OpenAI stream error", "stream_error");
    }
  };

  const drainBlock = (block) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      handleEvent(JSON.parse(data));
    } catch (error) {
      if (error instanceof AIDecisionError) throw error;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) drainBlock(block);
    if (done) {
      if (buffer.trim()) drainBlock(buffer);
      break;
    }
  }

  if (!outputText) outputText = extractCompletedOutputText(completedResponse);
  if (!summaryText) summaryText = extractCompletedSummary(completedResponse);
  return { outputText: outputText.trim(), summaryText: summaryText.trim(), response: completedResponse };
}

export { readResponseStream };

async function readChatCompletionStream(response, callbacks) {
  if (!response.body) throw new AIDecisionError("DeepSeek returned an empty response stream", "empty_stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outputText = "";

  const handleEvent = (event) => {
    if (!event || typeof event !== "object") return;
    if (event.error) throw new AIDecisionError(event.error.message || "DeepSeek stream error", "stream_error");
    for (const choice of event.choices ?? []) {
      const delta = choice.delta ?? {};
      // Never surface reasoning_content: it is private chain-of-thought.
      if (typeof delta.content === "string") outputText += delta.content;
    }
  };

  const drainBlock = (block) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      handleEvent(JSON.parse(data));
    } catch (error) {
      if (error instanceof AIDecisionError) throw error;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) drainBlock(block);
    if (done) {
      if (buffer.trim()) drainBlock(buffer);
      break;
    }
  }

  callbacks.onOutputDelta?.(outputText);
  return outputText.trim();
}

export { readChatCompletionStream };

async function requestDeepSeekStructuredDecision({
  gameId,
  modelConfig,
  instructions,
  input,
  schema,
  maxOutputTokens,
}, callbacks = {}) {
  const config = normalizeModelConfig(gameId, modelConfig);
  const { envName, value: apiKey } = deepseekApiKeyForGame(gameId);
  if (!apiKey) throw new AIDecisionError(`${envName} is not configured`, "missing_api_key");
  const label = modelMetadata(config.model)?.label ?? config.model;
  callbacks.onStatus?.(`Connecting to ${label}…`);

  const prompt = `${instructions}\n\nReturn ONLY one JSON object that matches this schema (no markdown fences, no extra text):\n${JSON.stringify(schema)}`;
  let response;
  try {
    response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: typeof input === "string" ? input : JSON.stringify(input) },
        ],
        response_format: { type: "json_object" },
        max_tokens: maxOutputTokens,
        stream: true,
      }),
    });
  } catch (error) {
    throw new AIDecisionError(`Could not reach DeepSeek: ${error.message}`, "connection_error");
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
  const outputText = await readChatCompletionStream(response, callbacks);
  if (!outputText) throw new AIDecisionError("The model completed without a decision", "empty_output");

  let output;
  try {
    output = JSON.parse(outputText);
  } catch {
    throw new AIDecisionError("The model's structured decision could not be parsed", "invalid_json");
  }

  return {
    output,
    reasoningSummary: "",
    responseId: null,
    modelConfig: config,
  };
}

export async function requestStructuredDecision({
  gameId,
  modelConfig,
  instructions,
  input,
  schemaName,
  schema,
  maxOutputTokens = 65_536,
}, callbacks = {}) {
  const config = normalizeModelConfig(gameId, modelConfig);
  if (modelProvider(config.model) === "deepseek") {
    return requestDeepSeekStructuredDecision({ gameId, modelConfig: config, instructions, input, schema, maxOutputTokens }, callbacks);
  }
  const { envName, value: apiKey } = apiKeyForGame(gameId);
  if (!apiKey) throw new AIDecisionError(`${envName} is not configured`, "missing_api_key");
  const label = modelMetadata(config.model)?.label ?? config.model;
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
        model: config.model,
        reasoning: { effort: config.reasoningEffort, summary: "auto" },
        instructions,
        input: typeof input === "string" ? input : JSON.stringify(input),
        text: {
          format: {
            type: "json_schema",
            name: schemaName,
            strict: true,
            schema,
          },
        },
        max_output_tokens: maxOutputTokens,
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
  if (!streamed.outputText) throw new AIDecisionError("The model completed without a decision", "empty_output");

  let output;
  try {
    output = JSON.parse(streamed.outputText);
  } catch {
    throw new AIDecisionError("The model's structured decision could not be parsed", "invalid_json");
  }

  return {
    output,
    reasoningSummary: streamed.summaryText,
    responseId: streamed.response?.id ?? null,
    modelConfig: config,
  };
}
