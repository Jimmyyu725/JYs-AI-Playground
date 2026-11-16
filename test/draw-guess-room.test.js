import assert from "node:assert/strict";
import test from "node:test";

import { AIDecisionError } from "../src/platform/ai-decision-error.js";
import { applyAction, createDrawGuessGame } from "../src/games/draw-guess/engine.js";
import { blur, blurredPngDataUrl, decodePng, downscale, encodePng } from "../src/games/draw-guess/png-blur.js";
import { imagePromptFor, requestDrawGuessDecision } from "../src/games/draw-guess/room-ai.js";

function checkerboard(size) {
  const rgb = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) rgb.fill((x + y) % 2 ? 255 : 0, (y * size + x) * 3, (y * size + x) * 3 + 3);
  return { width: size, height: size, rgb };
}

test("PNG encode and decode round-trip exactly", () => {
  const image = checkerboard(17);
  const decoded = decodePng(encodePng(image));
  assert.equal(decoded.width, 17);
  assert.equal(decoded.height, 17);
  assert.deepEqual([...decoded.rgb], [...image.rgb]);
});

test("blur flattens a checkerboard toward grey and keeps the size", () => {
  const blurred = blur(checkerboard(32), 4);
  assert.equal(blurred.rgb.length, 32 * 32 * 3);
  const centre = blurred.rgb[(16 * 32 + 16) * 3];
  assert.ok(Math.abs(centre - 128) < 20, `centre ${centre} should be near grey`);
  assert.equal(blur(checkerboard(8), 0).rgb[0], 0, "blur 0 is a no-op");
});

test("downscale caps the longer side and blurredPngDataUrl returns a PNG data URL", () => {
  const big = { width: 1024, height: 512, rgb: new Uint8Array(1024 * 512 * 3).fill(200) };
  const small = downscale(big, 512);
  assert.deepEqual([small.width, small.height], [512, 256]);
  const url = blurredPngDataUrl(encodePng(big), 16);
  assert.match(url, /^data:image\/png;base64,/);
  const decoded = decodePng(Buffer.from(url.split(",")[1], "base64"));
  assert.equal(decoded.width, 512);
  assert.equal(decoded.rgb[0], 200);
});

test("decodePng rejects data that is not a PNG", () => {
  assert.throws(() => decodePng(Buffer.from("not a png at all")), /Not a PNG/);
});

test("the image prompt frame never adds the word and forbids text", () => {
  const prompt = imagePromptFor("A striped tower on a rocky coast.");
  assert.match(prompt, /A striped tower on a rocky coast\./);
  assert.match(prompt, /no text/i);
});

function aiTable() {
  return createDrawGuessGame({ seats: [{ name: "Ada", kind: "ai" }, { name: "Bo", kind: "ai" }], firstDrawerSeat: 0 }, { seed: 7, now: 1000 });
}

test("a malformed answer is retried with the error fed back, then accepted", async () => {
  const state = aiTable();
  const calls = [];
  const answers = [{ choice: 9, text: null, tableTalk: null }, { choice: 2, text: null, tableTalk: null }];
  const request = async (payload) => {
    calls.push(payload);
    return { output: answers[calls.length - 1], reasoningSummary: "" };
  };
  const realNow = Date.now;
  Date.now = () => 2000;
  try {
    const decision = await requestDrawGuessDecision({ getState: () => state, seat: 0, modelConfig: { model: "gpt-6-luna", reasoningEffort: "high" }, request });
    assert.equal(calls.length, 2);
    assert.match(calls[1].instructions, /AUTOMATIC RETRY 1\/2/);
    assert.match(calls[1].instructions, /choice must be an integer/);
    assert.deepEqual(decision.action, { type: "choose_word", seat: 0, optionIndex: 1, wordId: state.round.wordOptions[1] });
    assert.equal(decision.attempts, 2);
    assert.doesNotThrow(() => applyAction(state, decision.action, { now: 2000 }));
  } finally {
    Date.now = realNow;
  }
});

test("three malformed answers pause with an AIDecisionError", async () => {
  const state = aiTable();
  let count = 0;
  const request = async () => {
    count += 1;
    return { output: { choice: 1, text: "unexpected", tableTalk: null } };
  };
  const realNow = Date.now;
  Date.now = () => 2000;
  try {
    await assert.rejects(
      requestDrawGuessDecision({ getState: () => state, seat: 0, modelConfig: {}, request }),
      (error) => error instanceof AIDecisionError && /takes no text/.test(error.message),
    );
    assert.equal(count, 3);
  } finally {
    Date.now = realNow;
  }
});

test("network failures are not retried automatically", async () => {
  const state = aiTable();
  let count = 0;
  const request = async () => {
    count += 1;
    throw new AIDecisionError("Could not reach OpenAI", "connection_error");
  };
  const realNow = Date.now;
  Date.now = () => 2000;
  try {
    await assert.rejects(requestDrawGuessDecision({ getState: () => state, seat: 0, modelConfig: {}, request }), /Could not reach/);
    assert.equal(count, 1);
  } finally {
    Date.now = realNow;
  }
});

test("a guesser receives the image and a seat with nothing to decide gets null", async () => {
  let state = aiTable();
  state = applyAction(state, { type: "choose_word", seat: 0, optionIndex: 0 }, { now: 2000 }).state;
  state = applyAction(state, { type: "submit_prompt", seat: 0, prompt: "Something round and shiny." }, { now: 2100 }).state;
  state = applyAction(state, { type: "image_ready", imageRef: "/api/draw-guess/image/test-image.png" }, { now: 2200 }).state;
  const seen = [];
  const request = async (payload) => {
    seen.push(payload);
    return { output: { choice: 2, text: null, tableTalk: null } };
  };
  const realNow = Date.now;
  Date.now = () => 3000;
  try {
    const decision = await requestDrawGuessDecision({ getState: () => state, seat: 1, modelConfig: {}, request, getImage: () => "data:image/png;base64,AAAA" });
    assert.equal(seen[0].image, "data:image/png;base64,AAAA");
    assert.equal(decision.action.type, "pass");
    assert.equal(await requestDrawGuessDecision({ getState: () => state, seat: 0, modelConfig: {}, request }), null, "the drawer cannot guess");
  } finally {
    Date.now = realNow;
  }
});
