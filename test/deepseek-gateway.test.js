import assert from "node:assert/strict";
import test from "node:test";
import { AIDecisionError } from "../src/platform/ai-decision-error.js";
import { requestStructuredDecision } from "../src/platform/decision-gateway.js";

const SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["fold", "call"] },
    explanation: { type: "string" },
  },
  required: ["action", "explanation"],
  additionalProperties: false,
};

// Mirrors the chunk shape returned by api.deepseek.com/chat/completions.
function chunk(delta, finishReason = null) {
  return { id: "ds-response-1", object: "chat.completion.chunk", choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }] };
}

function streamResponse(chunks, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const item of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(item)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

function withStubbedFetch(handler, run) {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return handler(calls.at(-1));
  };
  process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
  return (async () => {
    try {
      return await run(calls);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = originalKey;
    }
  })();
}

const DECISION_CHUNKS = [
  chunk({ role: "assistant", content: null, reasoning_content: "" }),
  chunk({ content: null, reasoning_content: "Weigh " }),
  chunk({ content: null, reasoning_content: "the pot odds." }),
  chunk({ content: '{"action":', reasoning_content: null }),
  chunk({ content: '"fold","explanation":"Price is wrong."}', reasoning_content: null }, "stop"),
];

test("routes a DeepSeek model to the DeepSeek chat endpoint with all required fields", async () => {
  await withStubbedFetch(() => streamResponse(DECISION_CHUNKS), async (calls) => {
    await requestStructuredDecision({
      gameId: "holdem",
      modelConfig: { model: "deepseek-v4-pro", reasoningEffort: "xhigh" },
      instructions: "You are a poker character.",
      input: { pot: 120 },
      schemaName: "holdem_decision",
      schema: SCHEMA,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
    assert.equal(calls[0].body.model, "deepseek-v4-pro");
    assert.equal(calls[0].body.reasoning_effort, "xhigh");
    assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
    assert.equal(calls[0].body.stream, true);
    // DeepSeek has no strict json_schema mode, so the schema must ride along in the prompt.
    assert.match(calls[0].body.messages[0].content, /You are a poker character\./);
    assert.match(calls[0].body.messages[0].content, /"additionalProperties":false/);
    assert.equal(calls[0].body.messages[1].content, JSON.stringify({ pot: 120 }));
  });
});

test("streams reasoning_content and reports it as raw DeepSeek reasoning", async () => {
  await withStubbedFetch(() => streamResponse(DECISION_CHUNKS), async () => {
    const deltas = [];
    const result = await requestStructuredDecision({
      gameId: "go",
      modelConfig: { model: "deepseek-v4-pro", reasoningEffort: "medium" },
      instructions: "Play Go.",
      input: {},
      schemaName: "go_decision",
      schema: SCHEMA,
    }, { onSummaryDelta: (delta) => deltas.push(delta) });

    assert.deepEqual(result.output, { action: "fold", explanation: "Price is wrong." });
    assert.equal(result.reasoningSummary, "Weigh the pot odds.");
    assert.equal(result.reasoningSource, "deepseek_reasoning_content");
    assert.equal(result.responseId, "ds-response-1");
    assert.deepEqual(deltas, ["Weigh ", "the pot odds."]);
  });
});

test("tolerates a fenced JSON decision", async () => {
  const fenced = [chunk({ content: '```json\n{"action":"call","explanation":"Ok."}\n```', reasoning_content: null }, "stop")];
  await withStubbedFetch(() => streamResponse(fenced), async () => {
    const result = await requestStructuredDecision({
      gameId: "wuziqi",
      modelConfig: { model: "deepseek-v4-pro" },
      instructions: "Play Wuziqi.",
      input: {},
      schemaName: "wuziqi_decision",
      schema: SCHEMA,
    });
    assert.deepEqual(result.output, { action: "call", explanation: "Ok." });
  });
});

test("unwraps a decision the model nested under a single envelope key", async () => {
  const wrapped = [chunk({ content: '{"holdem_decision":{"action":"call","explanation":"Priced in."}}', reasoning_content: null }, "stop")];
  await withStubbedFetch(() => streamResponse(wrapped), async () => {
    const result = await requestStructuredDecision({
      gameId: "holdem",
      modelConfig: { model: "deepseek-v4-pro" },
      instructions: "Play.",
      input: {},
      schemaName: "holdem_decision",
      schema: SCHEMA,
    });
    assert.deepEqual(result.output, { action: "call", explanation: "Priced in." });
  });
});

test("leaves a correctly shaped decision untouched", async () => {
  const nested = [chunk({ content: '{"action":"call","explanation":"Keeps the pot small."}', reasoning_content: null }, "stop")];
  await withStubbedFetch(() => streamResponse(nested), async () => {
    const result = await requestStructuredDecision({
      gameId: "holdem",
      modelConfig: { model: "deepseek-v4-pro" },
      instructions: "Play.",
      input: {},
      schemaName: "holdem_decision",
      schema: SCHEMA,
    });
    assert.deepEqual(result.output, { action: "call", explanation: "Keeps the pot small." });
  });
});

test("tells the model not to nest the decision under the schema name", async () => {
  await withStubbedFetch(() => streamResponse(DECISION_CHUNKS), async (calls) => {
    await requestStructuredDecision({
      gameId: "holdem",
      modelConfig: { model: "deepseek-v4-pro" },
      instructions: "Play.",
      input: {},
      schemaName: "holdem_decision",
      schema: SCHEMA,
    });
    assert.match(calls[0].body.messages[0].content, /top-level keys must be exactly \["action","explanation"\]/);
    assert.match(calls[0].body.messages[0].content, /Do not nest the decision inside a wrapper object/);
  });
});

test("fails loudly when the token ceiling truncates the decision", async () => {
  const truncated = [chunk({ content: '{"action":"fo', reasoning_content: null }, "length")];
  await withStubbedFetch(() => streamResponse(truncated), async () => {
    await assert.rejects(
      requestStructuredDecision({
        gameId: "holdem",
        modelConfig: { model: "deepseek-v4-pro" },
        instructions: "Play.",
        input: {},
        schemaName: "holdem_decision",
        schema: SCHEMA,
      }),
      (error) => error instanceof AIDecisionError && error.code === "output_truncated",
    );
  });
});

test("surfaces a DeepSeek API error without leaking the credential", async () => {
  const failing = () => new Response(JSON.stringify({ error: { message: "Insufficient Balance", code: "invalid_request_error" } }), {
    status: 402,
    headers: { "Content-Type": "application/json" },
  });
  await withStubbedFetch(failing, async () => {
    await assert.rejects(
      requestStructuredDecision({
        gameId: "holdem",
        modelConfig: { model: "deepseek-v4-pro" },
        instructions: "Play.",
        input: {},
        schemaName: "holdem_decision",
        schema: SCHEMA,
      }),
      (error) => {
        assert.ok(error instanceof AIDecisionError);
        assert.match(error.message, /Insufficient Balance/);
        assert.doesNotMatch(error.message, /test-deepseek-key/);
        return true;
      },
    );
  });
});

test("still routes OpenAI models to the OpenAI Responses endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    return new Response(JSON.stringify({ error: { message: "stop here" } }), { status: 400, headers: { "Content-Type": "application/json" } });
  };
  process.env.OPENAI_API_KEY = "test-openai-key";
  try {
    await assert.rejects(requestStructuredDecision({
      gameId: "holdem",
      modelConfig: { model: "gpt-5.6-luna" },
      instructions: "Play.",
      input: {},
      schemaName: "holdem_decision",
      schema: SCHEMA,
    }));
    assert.deepEqual(calls, ["https://api.openai.com/v1/responses"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});
