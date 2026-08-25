import test from "node:test";
import assert from "node:assert/strict";
import { AIDecisionError, readChatCompletionStream, readResponseStream } from "../src/platform/openai-gateway.js";

function streamResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return { body };
}

function event(type, extra = {}) {
  return `data: ${JSON.stringify({ type, ...extra })}\n\n`;
}

test("assembles output text from streamed deltas", async () => {
  const stream = streamResponse([
    event("response.created"),
    event("response.output_text.delta", { delta: '{"action":' }),
    event("response.output_text.delta", { delta: '"place"}' }),
    "data: [DONE]\n\n",
  ]);
  const result = await readResponseStream(stream, {});
  assert.equal(result.outputText, '{"action":"place"}');
});

test("drains a final SSE block that lacks a trailing blank line", async () => {
  const stream = streamResponse([
    event("response.output_text.delta", { delta: '{"action":"pass"}' }),
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1" } })}`,
  ]);
  const result = await readResponseStream(stream, {});
  assert.equal(result.outputText, '{"action":"pass"}');
  assert.equal(result.response.id, "resp_1");
});

test("recovers output text from the completed response when no deltas streamed", async () => {
  const completed = {
    id: "resp_2",
    output: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "Reasoned." }] },
      { type: "message", content: [{ type: "output_text", text: '{"action":"resign"}' }] },
    ],
  };
  const stream = streamResponse([event("response.completed", { response: completed })]);
  const result = await readResponseStream(stream, {});
  assert.equal(result.outputText, '{"action":"resign"}');
  assert.equal(result.summaryText, "Reasoned.");
});

test("reports an incomplete response with its truncation reason", async () => {
  const stream = streamResponse([
    event("response.reasoning_summary_text.delta", { delta: "partial…" }),
    event("response.incomplete", { response: { incomplete_details: { reason: "max_output_tokens" } } }),
  ]);
  await assert.rejects(
    () => readResponseStream(stream, {}),
    (error) => error instanceof AIDecisionError
      && error.code === "incomplete_response"
      && /max_output_tokens/.test(error.message),
  );
});

test("propagates failed responses as decision errors", async () => {
  const stream = streamResponse([event("response.failed", { response: { error: { message: "boom" } } })]);
  await assert.rejects(
    () => readResponseStream(stream, {}),
    (error) => error instanceof AIDecisionError && error.code === "response_failed" && /boom/.test(error.message),
  );
});

test("assembles DeepSeek chat completion content deltas and ignores private reasoning", async () => {
  const chunk = (object) => `data: ${JSON.stringify(object)}\n\n`;
  const stream = streamResponse([
    chunk({ choices: [{ delta: { reasoning_content: "PRIVATE THINKING" }, finish_reason: null }] }),
    chunk({ choices: [{ delta: { content: '{"action":' }, finish_reason: null }] }),
    chunk({ choices: [{ delta: { content: '"pass"}' }, finish_reason: null }] }),
    "data: [DONE]\n\n",
  ]);
  const result = await readChatCompletionStream(stream, {});
  assert.equal(result, '{"action":"pass"}');
  assert.equal(result.includes("PRIVATE"), false);
});

test("drains a final DeepSeek SSE block without a trailing blank line", async () => {
  const stream = streamResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: "{\"row\": 3}" }, finish_reason: "stop" }] })}`,
  ]);
  const result = await readChatCompletionStream(stream, {});
  assert.equal(result, '{"row": 3}');
});

test("surfaces DeepSeek stream errors", async () => {
  const stream = streamResponse([`data: ${JSON.stringify({ error: { message: "quota exceeded" } })}\n\n`]);
  await assert.rejects(
    () => readChatCompletionStream(stream, {}),
    (error) => error instanceof AIDecisionError && error.code === "stream_error" && /quota exceeded/.test(error.message),
  );
});
