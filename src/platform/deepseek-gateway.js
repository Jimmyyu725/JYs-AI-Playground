import { AIDecisionError } from "./ai-decision-error.js";
import { apiKeyFor, modelMetadata } from "./model-registry.js";

const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";

// DeepSeek rejects `response_format: {type: "json_schema"}`, so the schema travels
// in the system prompt and `json_object` mode guarantees only syntactic validity.
// Every caller still validates the decoded object against the live game rules.
function schemaContract(schemaName, schema) {
  const keys = Object.keys(schema?.properties ?? {});
  return `\n\nReturn a single JSON object that validates against this JSON Schema:\n\n${JSON.stringify(schema)}\n\nIts top-level keys must be exactly ${JSON.stringify(keys)}. Do not nest the decision inside a wrapper object or a key such as "${schemaName}". Return raw JSON only. Do not wrap it in Markdown fences and do not add commentary.`;
}

// Without a strict schema the model intermittently wraps the decision in a single
// envelope key (observed: {"holdem_decision": {...}}), so unwrap it before validation.
function unwrapEnvelope(value, schema) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const required = Array.isArray(schema?.required) ? schema.required : [];
  if (required.length > 0 && required.every((key) => key in value)) return value;
  const keys = Object.keys(value);
  if (keys.length !== 1) return value;
  const inner = value[keys[0]];
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return value;
  return inner;
}

function stripFences(text) {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return (fenced ? fenced[1] : text).trim();
}

function safeAPIError(status, payload, requestId) {
  const message = payload?.error?.message || payload?.message || `DeepSeek returned HTTP ${status}`;
  const code = payload?.error?.code || payload?.error?.type || `http_${status}`;
  const suffix = requestId ? ` (request ${requestId})` : "";
  return new AIDecisionError(`${message}${suffix}`, code);
}

async function readChatStream(response, callbacks) {
  if (!response.body) throw new AIDecisionError("DeepSeek returned an empty response stream", "empty_stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outputText = "";
  let reasoningText = "";
  let responseId = null;
  let finishReason = null;

  const handleChunk = (chunk) => {
    if (!chunk || typeof chunk !== "object") return;
    if (chunk.error) throw new AIDecisionError(chunk.error.message || "DeepSeek stream error", chunk.error.code || "stream_error");
    if (chunk.id) responseId = chunk.id;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (delta.reasoning_content) {
      reasoningText += delta.reasoning_content;
      callbacks.onSummaryDelta?.(delta.reasoning_content);
    }
    if (delta.content) {
      outputText += delta.content;
      callbacks.onOutputDelta?.(delta.content);
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
        handleChunk(JSON.parse(data));
      } catch (error) {
        if (error instanceof AIDecisionError) throw error;
      }
    }
    if (done) break;
  }

  return { outputText: outputText.trim(), reasoningText: reasoningText.trim(), responseId, finishReason };
}

export async function requestDeepSeekStructuredDecision({
  config,
  gameId,
  instructions,
  input,
  schemaName,
  schema,
  maxOutputTokens = 4096,
}, callbacks = {}) {
  const { envName, value: apiKey } = apiKeyFor("deepseek", gameId);
  if (!apiKey) throw new AIDecisionError(`${envName} is not configured`, "missing_api_key");
  const label = modelMetadata(config.model)?.label ?? config.model;
  callbacks.onStatus?.(`Connecting to ${label}…`);

  let response;
  try {
    response = await fetch(DEEPSEEK_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: `${instructions}${schemaContract(schemaName, schema)}` },
          { role: "user", content: typeof input === "string" ? input : JSON.stringify(input) },
        ],
        reasoning_effort: config.reasoningEffort,
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
  const streamed = await readChatStream(response, callbacks);
  if (streamed.finishReason === "length") {
    throw new AIDecisionError(`${label} hit the ${maxOutputTokens}-token ceiling before finishing its decision`, "output_truncated");
  }
  if (!streamed.outputText) throw new AIDecisionError("The model completed without a decision", "empty_output");

  let output;
  try {
    output = JSON.parse(stripFences(streamed.outputText));
  } catch {
    throw new AIDecisionError("The model's structured decision could not be parsed", "invalid_json");
  }

  return {
    output: unwrapEnvelope(output, schema),
    // DeepSeek returns full reasoning_content rather than an abridged summary.
    reasoningSummary: streamed.reasoningText,
    reasoningSource: streamed.reasoningText ? "deepseek_reasoning_content" : "",
    responseId: streamed.responseId,
    modelConfig: config,
  };
}
