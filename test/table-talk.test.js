import assert from "node:assert/strict";
import test from "node:test";
import { requestStructuredDecision } from "../src/platform/decision-gateway.js";
import { buildInput } from "../src/platform/openai-gateway.js";
import { cleanTableTalk, pushTableTalk, withTableTalk } from "../src/platform/table-talk.js";

const schema = { type: "object", properties: { action: { type: "string" } }, required: ["action"], additionalProperties: false };

function mockOpenAI(outputText) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: outputText })}\n\n`));
        controller.close();
      },
    });
    return { ok: true, body, headers: new Headers() };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("withTableTalk adds a required bounded string", () => {
  const extended = withTableTalk(schema);
  assert.deepEqual(extended.required, ["action", "tableTalk"]);
  assert.equal(extended.properties.tableTalk.maxLength, 140);
  assert.deepEqual(schema.required, ["action"]);
});

test("cleanTableTalk trims, collapses, caps, and treats silence as null", () => {
  assert.equal(cleanTableTalk("  "), null);
  assert.equal(cleanTableTalk("Nice\n  try."), "Nice try.");
  assert.equal(cleanTableTalk("x".repeat(300)).length, 140);
  const table = {};
  assert.equal(pushTableTalk(table, { speaker: 1, playerName: "A", text: "" }), null);
  assert.equal(pushTableTalk(table, { speaker: 1, playerName: "A", text: "Your move." }).text, "Your move.");
  assert.equal(table.tableTalk.length, 1);
});

test("the gateway asks for table talk in the character's voice and strips it from the decision", async () => {
  process.env.OPENAI_API_KEY ||= "test-key";
  const mock = mockOpenAI('{"action":"call","tableTalk":"  I smell fear. "}');
  try {
    const result = await requestStructuredDecision({
      gameId: "holdem",
      modelConfig: { model: "gpt-6-luna", reasoningEffort: "low" },
      instructions: "Play.",
      input: "{}",
      schemaName: "t",
      schema,
      tableTalk: { voice: "Dry, clipped, never says more than five words." },
    });
    assert.deepEqual(result.output, { action: "call" });
    assert.equal(result.tableTalk, "I smell fear.");
    assert.match(mock.calls[0].body.instructions, /never says more than five words/);
    assert.ok(mock.calls[0].body.text.format.schema.required.includes("tableTalk"));
  } finally {
    mock.restore();
  }
});

test("an optional image becomes a multimodal input for vision models only", async () => {
  const image = "data:image/png;base64,iVBORw0KGgo=";
  const input = buildInput("Guess the drawing.", image);
  assert.equal(input[0].content[1].type, "input_image");
  assert.equal(input[0].content[1].image_url, image);
  assert.equal(buildInput("plain", null), "plain");
  assert.throws(() => buildInput("x", "https://example.com/a.png"), /data URL/);

  process.env.OPENAI_API_KEY ||= "test-key";
  const mock = mockOpenAI('{"action":"guess"}');
  try {
    await requestStructuredDecision({ gameId: "draw-guess", modelConfig: { model: "gpt-6-luna", reasoningEffort: "low" }, instructions: "Guess.", input: "{}", schemaName: "t", schema, image });
    assert.equal(mock.calls[0].body.input[0].content[1].image_url, image);
  } finally {
    mock.restore();
  }
});
