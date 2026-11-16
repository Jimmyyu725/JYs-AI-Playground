import test from "node:test";
import assert from "node:assert/strict";
import { AIDecisionError } from "../src/platform/ai-decision-error.js";
import { DEFAULT_CONFIG, applyAction, createDrawGuessGame, wordById } from "../src/games/draw-guess/engine.js";
import {
  buildAiView,
  decisionInstructions,
  decisionSchema,
  numberedActions,
  parseDecision,
  toAIDecisionError,
} from "../src/games/draw-guess/ai-view.js";

const BANK = [
  { id: "apple", word: "apple", zh: "苹果", difficulty: "easy", synonyms: [], zhSynonyms: [] },
  { id: "ice-cream", word: "ice cream", zh: "冰淇淋", difficulty: "medium", synonyms: ["gelato"], zhSynonyms: [] },
  { id: "astronaut", word: "astronaut", zh: "宇航员", difficulty: "hard", synonyms: ["spaceman"], zhSynonyms: ["航天员"] },
];

// Seat 0 is human; seats 1-3 are models. Seat 1 draws first.
function newGame(overrides = {}) {
  return createDrawGuessGame({
    seats: [
      { id: "h", name: "Jay", kind: "human" },
      { id: "a", name: "Vesper", kind: "ai" },
      { id: "b", name: "Rook", kind: "ai" },
      { id: "c", name: "Selene", kind: "ai" },
    ],
    firstDrawerSeat: 1,
    wordBank: BANK,
    ...overrides,
  }, { seed: 11, now: 0 });
}

function chosen(wordId = "ice-cream") {
  const state = newGame();
  const index = state.round.wordOptions.indexOf(wordId);
  return applyAction(state, { type: "choose_word", seat: 1, optionIndex: index }, { now: 10 }).state;
}

function guessing(wordId = "ice-cream") {
  let state = chosen(wordId);
  state = applyAction(state, { type: "submit_prompt", seat: 1, prompt: "a swirl of cold dessert in a waffle cone" }, { now: 20 }).state;
  return applyAction(state, { type: "image_ready", imageRef: "img-1" }, { now: 1000 }).state;
}

test("the drawer's choosing view lists the word options with tiers and numbered actions", () => {
  const state = newGame();
  const view = buildAiView(state, 1, { now: 5, character: { name: "Vesper", personality: "Theatrical." } });
  assert.equal(view.you.role, "drawer");
  assert.equal(view.choosing.options.length, 3);
  assert.deepEqual(view.legalActions.map((action) => action.number), [1, 2, 3]);
  assert.ok(view.legalActions.every((action) => action.type === "choose_word" && !action.needsText));
  assert.match(view.legalActions[0].label, /\(.+\), (easy|medium|hard)/);
  assert.equal(view.round.secondsLeft, 20);
  assert.match(decisionInstructions(view), /Character: Theatrical\./);
  assert.throws(() => buildAiView(state, 2, { now: 5 }), /no Draw & Guess decision/);
});

test("the drawer's prompting view carries the secret, forbidden terms and rejected attempts", () => {
  let state = chosen("astronaut");
  state = applyAction(state, { type: "submit_prompt", seat: 1, prompt: "a spaceman waving" }, { now: 11 }).state;
  const view = buildAiView(state, 1, { now: 12 });
  assert.equal(view.drawing.secretWord, "astronaut");
  assert.deepEqual(view.drawing.forbidden, ["astronaut", "spaceman", "宇航员", "航天员"]);
  assert.equal(view.drawing.attemptsLeft, 2);
  assert.deepEqual(view.drawing.rejectedAttempts, [{ prompt: "a spaceman waving", reason: "synonym", match: "spaceman" }]);
  assert.deepEqual(view.legalActions, [{ number: 1, type: "submit_prompt", label: view.legalActions[0].label, needsText: true }]);
  const instructions = decisionInstructions(view);
  assert.match(instructions, /“spaceman”/);
  assert.match(instructions, /2 remaining attempts/);
});

test("a model drawer is never offered the human-only sketch action", () => {
  const state = chosen();
  assert.deepEqual(numberedActions(state, 1, { now: 11 }).map((action) => action.type), ["submit_prompt"]);
});

test("a guesser's view contains no trace of the word, the prompt or correct guess texts", () => {
  let state = guessing("ice-cream");
  state = applyAction(state, { type: "guess", seat: 2, text: "Gelato" }, { now: 2000 }).state;
  state = applyAction(state, { type: "guess", seat: 0, text: "sundae", tableTalk: "So cold." }, { now: 3000 }).state;
  const view = buildAiView(state, 3, { now: 16000 });
  const serialized = JSON.stringify(view);
  for (const secret of ["ice", "cream", "gelato", "冰淇淋", "waffle", "dessert"]) {
    assert.ok(!serialized.toLowerCase().includes(secret), `guesser view leaks “${secret}”`);
  }
  assert.equal(view.you.role, "guesser");
  assert.equal(view.guessing.wordShape, "___ _____");
  assert.equal(view.guessing.letterCount, 8);
  assert.equal(view.guessing.pointsIfCorrectNow, 8 + 2);
  assert.deepEqual(view.guessing.imageBlur, { stage: 2, of: 4, blurPx: 16 });
  assert.deepEqual(view.guessing.othersWrongGuesses, [{ name: "Jay", text: "sundae" }]);
  assert.deepEqual(view.guessing.solvedBy, ["Rook"]);
  assert.deepEqual(view.tableTalk, [{ name: "Jay", text: "So cold." }]);
  assert.deepEqual(view.legalActions.map((action) => [action.number, action.type, action.needsText]), [[1, "guess", true], [2, "pass", false]]);
  const instructions = decisionInstructions(view);
  assert.ok(!/cream/i.test(instructions));
  assert.match(instructions, /“___ _____”/);
});

test("a guesser sees its own guesses with close flags and remaining guesses", () => {
  let state = guessing("astronaut");
  state = applyAction(state, { type: "guess", seat: 2, text: "astronot" }, { now: 2000 }).state;
  const view = buildAiView(state, 2, { now: 2100 });
  assert.deepEqual(view.guessing.yourGuesses, [{ text: "astronot", close: true }]);
  assert.equal(view.guessing.guessesLeft, DEFAULT_CONFIG.maxGuessesPerRound - 1);
  assert.deepEqual(buildAiView(state, 3, { now: 2100 }).guessing.othersWrongGuesses, [{ name: "Rook", text: "astronot" }]);
});

test("the decision schema is strict with a numbered choice and a 140-character tableTalk", () => {
  const schema = decisionSchema(guessing(), 2, { now: 2000 });
  assert.deepEqual(schema.required, ["choice", "text", "tableTalk"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.choice.enum, [1, 2]);
  assert.equal(schema.properties.tableTalk.anyOf[0].maxLength, 140);
  assert.deepEqual(schema.properties.tableTalk.anyOf[1], { type: "null" });
  assert.deepEqual(decisionSchema(newGame(), 1, { now: 1 }).properties.choice.enum, [1, 2, 3]);
});

test("parseDecision maps answers to legal engine actions", () => {
  const choosing = newGame();
  const pick = parseDecision(choosing, 1, { choice: 2, text: null, tableTalk: "  Watch this.  " }, { now: 5 });
  assert.deepEqual(pick, {
    ok: true,
    action: { type: "choose_word", seat: 1, optionIndex: 1, wordId: choosing.round.wordOptions[1], tableTalk: "Watch this." },
  });
  assert.equal(applyAction(choosing, pick.action, { now: 5 }).state.phase, "prompting");

  const prompt = parseDecision(chosen(), 1, { choice: 1, text: "  a cold swirl in a cone ", tableTalk: null }, { now: 11 });
  assert.deepEqual(prompt, { ok: true, action: { type: "submit_prompt", seat: 1, prompt: "a cold swirl in a cone" } });

  const guess = parseDecision(guessing(), 2, { choice: 1, text: "ice cream", tableTalk: "" }, { now: 2000 });
  assert.deepEqual(guess, { ok: true, action: { type: "guess", seat: 2, text: "ice cream" } });
  const pass = parseDecision(guessing(), 2, { choice: 2, text: null, tableTalk: null }, { now: 2000 });
  assert.deepEqual(pass, { ok: true, action: { type: "pass", seat: 2 } });
});

test("a leaking prompt parses fine so the engine can count it as a rejected attempt", () => {
  const state = chosen();
  const parsed = parseDecision(state, 1, { choice: 1, text: "two ice creams", tableTalk: null }, { now: 11 });
  assert.equal(parsed.ok, true);
  const { events } = applyAction(state, parsed.action, { now: 11 });
  assert.equal(events[0].type, "prompt_rejected");
});

test("parseDecision returns precise retryable errors for malformed answers", () => {
  const state = guessing();
  const cases = [
    [null, "bad_shape"],
    [[1], "bad_shape"],
    [{ choice: 0, text: "x", tableTalk: null }, "bad_choice"],
    [{ choice: 3, text: "x", tableTalk: null }, "bad_choice"],
    [{ choice: "1", text: "x", tableTalk: null }, "bad_choice"],
    [{ choice: 1.5, text: "x", tableTalk: null }, "bad_choice"],
    [{ choice: 1, text: 42, tableTalk: null }, "bad_text"],
    [{ choice: 1, text: "   ", tableTalk: null }, "missing_text"],
    [{ choice: 1, text: null, tableTalk: null }, "missing_text"],
    [{ choice: 2, text: "pizza", tableTalk: null }, "unexpected_text"],
    [{ choice: 1, text: "pizza", tableTalk: 5 }, "bad_table_talk"],
    [{ choice: 1, text: "pizza", tableTalk: "x".repeat(141) }, "bad_table_talk"],
    [{ choice: 1, text: "pizza", tableTalk: "maybe ice cream?" }, "talk_leak"],
    [{ choice: 1, text: "x".repeat(61), tableTalk: null }, "guess_too_long"],
  ];
  for (const [output, code] of cases) {
    const result = parseDecision(state, 2, output, { now: 2000 });
    assert.equal(result.ok, false, JSON.stringify(output));
    assert.equal(result.code, code, JSON.stringify(output));
    assert.equal(result.retryable, true);
    assert.ok(result.message.length > 10);
  }
  assert.match(parseDecision(state, 2, { choice: 3, text: null, tableTalk: null }, { now: 2000 }).message, /from 1 to 2/);
  assert.match(parseDecision(state, 2, { choice: 1, text: "", tableTalk: "maybe ice cream?" }, { now: 2000 }).message, /missing|needs/);
});

test("guesser talk leaks are explained as guesses; drawer talk leaks name the match", () => {
  const guesser = parseDecision(guessing(), 2, { choice: 2, text: null, tableTalk: "gelato?" }, { now: 2000 });
  assert.equal(guesser.code, "talk_leak");
  assert.match(guesser.message, /guess action/);
  const drawer = parseDecision(chosen(), 1, { choice: 1, text: "a cone", tableTalk: "冰淇淋 time" }, { now: 11 });
  assert.equal(drawer.code, "talk_leak");
  assert.match(drawer.message, /chinese: “冰淇淋”/);
});

test("repeated guesses come back as a retryable engine error", () => {
  let state = guessing();
  state = applyAction(state, { type: "guess", seat: 2, text: "pizza" }, { now: 2000 }).state;
  const repeated = parseDecision(state, 2, { choice: 1, text: "Pizza!", tableTalk: null }, { now: 2100 });
  assert.deepEqual([repeated.ok, repeated.code, repeated.retryable], [false, "repeated_guess", true]);
});

test("seats without a decision and expired clocks are not retryable", () => {
  const state = guessing();
  const drawer = parseDecision(state, 1, { choice: 1, text: "x", tableTalk: null }, { now: 2000 });
  assert.deepEqual([drawer.ok, drawer.code, drawer.retryable], [false, "no_decision", false]);
  const late = parseDecision(state, 2, { choice: 1, text: "x", tableTalk: null }, { now: 1000 + DEFAULT_CONFIG.roundDurationMs });
  assert.equal(late.retryable, false);
});

test("toAIDecisionError wraps a failed parse for the platform retry loop", () => {
  const output = { choice: 9, text: null, tableTalk: null };
  const result = parseDecision(guessing(), 2, output, { now: 2000 });
  const error = toAIDecisionError(result, output);
  assert.ok(error instanceof AIDecisionError);
  assert.equal(error.code, "invalid_draw_guess_decision");
  assert.equal(error.parseCode, "bad_choice");
  assert.deepEqual(error.rejectedDecision, output);
  const fatal = toAIDecisionError({ ok: false, code: "no_decision", message: "none", retryable: false });
  assert.equal(fatal.code, "draw_guess_no_decision");
  assert.equal(fatal.rejectedDecision, null);
});

test("a full model-driven round plays through views, schemas and the parser", () => {
  let state = newGame({ rotations: 1 });
  let now = 1;
  const answer = (seat, output) => {
    const parsed = parseDecision(state, seat, output, { now });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    state = applyAction(state, parsed.action, { now }).state;
    now += 10;
  };
  const target = state.round.wordOptions.indexOf("apple") + 1;
  answer(1, { choice: target, text: null, tableTalk: null });
  answer(1, { choice: 1, text: "a shiny red fruit with a leaf on a stem", tableTalk: "Easy one." });
  state = applyAction(state, { type: "image_ready", imageRef: "img-a" }, { now }).state;
  for (const seat of [2, 3]) {
    assert.equal(buildAiView(state, seat, { now }).round.number, 1);
    answer(seat, { choice: 1, text: seat === 2 ? "cherry" : "Apples", tableTalk: null });
  }
  answer(2, { choice: 1, text: "apple", tableTalk: null });
  // Seat 0 is human and still active, so the round waits for it or for the clock.
  assert.equal(state.phase, "guessing");
  state = applyAction(state, { type: "pass", seat: 0 }, { now }).state;
  assert.equal(state.phase, "round_over");
  assert.deepEqual(state.round.points, { 0: 0, 1: 6, 2: 8, 3: 10 });
  assert.equal(wordById(state, state.round.wordId).word, "apple");
});
