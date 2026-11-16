import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  DEFAULT_REVEAL_SCHEDULE,
  DEFAULT_WORD_BANK,
  DIFFICULTIES,
  DrawGuessRuleError,
  applyAction,
  createDrawGuessGame,
  createSeededRng,
  findPromptLeak,
  fromSave,
  imageRequestFor,
  inflectedForms,
  isCloseGuess,
  isCorrectGuess,
  legalActions,
  normalizeGuess,
  pluralForms,
  revealAt,
  systemActions,
  toSave,
  validateAction,
  viewFor,
  visionInputFor,
  wordById,
} from "../src/games/draw-guess/engine.js";

const BANK = [
  { id: "apple", word: "apple", zh: "苹果", difficulty: "easy", synonyms: [], zhSynonyms: [] },
  { id: "cat", word: "cat", zh: "猫", difficulty: "easy", synonyms: ["kitty"], zhSynonyms: ["猫咪"] },
  { id: "ice-cream", word: "ice cream", zh: "冰淇淋", difficulty: "medium", synonyms: ["gelato"], zhSynonyms: ["冰激凌"] },
  { id: "butterfly", word: "butterfly", zh: "蝴蝶", difficulty: "medium", synonyms: [], zhSynonyms: [] },
  { id: "astronaut", word: "astronaut", zh: "宇航员", difficulty: "hard", synonyms: ["spaceman"], zhSynonyms: ["航天员"] },
  { id: "knife", word: "knife", zh: "刀", difficulty: "hard", synonyms: [], zhSynonyms: ["小刀"] },
];

function seats(count, humans = [0]) {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index}`,
    name: `Player ${index}`,
    kind: humans.includes(index) ? "human" : "ai",
    characterId: humans.includes(index) ? null : `char-${index}`,
  }));
}

function newGame(overrides = {}, options = {}) {
  return createDrawGuessGame(
    { seats: seats(overrides.seatCount ?? 3), firstDrawerSeat: 0, wordBank: BANK, ...overrides },
    { seed: 42, now: 0, ...options },
  );
}

function act(state, action, now = 1) {
  return applyAction(state, action, { now });
}

/** Moves a fresh game to the guessing phase with the given word (forcing it into the options). */
function toGuessing(state, wordId = "apple", now = 100) {
  const forced = structuredClone(state);
  forced.round.wordOptions[0] = wordId;
  const drawer = forced.round.drawerSeat;
  let next = act(forced, { type: "choose_word", seat: drawer, optionIndex: 0 }, now).state;
  next = act(next, { type: "submit_prompt", seat: drawer, prompt: "a shiny round object on a wooden table" }, now).state;
  return act(next, { type: "image_ready", imageRef: "img-1" }, now).state;
}

function assertRule(fn, code) {
  assert.throws(fn, (error) => error instanceof DrawGuessRuleError && error.code === code);
}

test("creates a table with validated seats and a choosing first round", () => {
  const state = newGame();
  assert.equal(state.gameId, "draw-guess");
  assert.equal(state.phase, "choosing");
  assert.equal(state.round.number, 1);
  assert.equal(state.round.drawerSeat, 0);
  assert.equal(state.totalTurns, 3);
  assert.deepEqual(state.drawerOrder, [0, 1, 2]);
  assert.equal(state.round.deadlineAt, DEFAULT_CONFIG.chooseTimeoutMs);
  assert.ok(state.seats.every((seat) => seat.score === 0));
  assert.equal(state.seats[1].characterId, "char-1");
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(state)));
});

test("rejects bad seat counts, duplicate ids and bad config", () => {
  assertRule(() => createDrawGuessGame({ seats: seats(1) }, { seed: 1, now: 0 }), "bad_config");
  assertRule(() => createDrawGuessGame({ seats: seats(9) }, { seed: 1, now: 0 }), "bad_config");
  assertRule(() => createDrawGuessGame({ seats: [{ id: "x" }, { id: "x" }] }, { seed: 1, now: 0 }), "bad_config");
  assertRule(() => newGame({ difficulty: "insane" }), "bad_config");
  assertRule(() => newGame({ rotations: 0 }), "bad_config");
  assertRule(() => newGame({ firstDrawerSeat: 5 }), "bad_config");
  assertRule(() => newGame({ revealSchedule: [{ afterMs: 5, blurPx: 1 }] }), "bad_config");
  assertRule(() => newGame({ revealSchedule: [{ afterMs: 0, blurPx: 9 }, { afterMs: 0, blurPx: 1 }] }), "bad_config");
  assertRule(() => newGame({ scoring: { orderPoints: [] } }), "bad_config");
  assertRule(() => newGame({ wordBank: [{ id: "a", word: "a", zh: "", difficulty: "easy" }] }), "bad_config");
  assertRule(() => newGame({ wordBank: [...BANK, BANK[0]] }), "bad_config");
  assertRule(() => newGame({ wordBank: [{ ...BANK[0], difficulty: "extreme" }] }), "bad_config");
});

test("the default word bank is well formed with every tier and Chinese translations", () => {
  const game = createDrawGuessGame({ seats: seats(2) }, { seed: 3, now: 0 });
  assert.equal(game.customWordBank, null);
  assert.equal(new Set(DEFAULT_WORD_BANK.map((item) => item.id)).size, DEFAULT_WORD_BANK.length);
  for (const tier of DIFFICULTIES) assert.ok(DEFAULT_WORD_BANK.filter((item) => item.difficulty === tier).length >= 15, tier);
  for (const item of DEFAULT_WORD_BANK) {
    assert.ok(/\p{Script=Han}/u.test(item.zh), item.id);
    assert.ok(isCorrectGuess(item.word, item), item.id);
    assert.ok(isCorrectGuess(item.zh, item), item.id);
    for (const synonym of item.synonyms) assert.ok(isCorrectGuess(synonym, item), synonym);
  }
});

test("mixed difficulty offers one word per tier; a fixed tier offers only that tier", () => {
  const mixed = newGame();
  const tiers = mixed.round.wordOptions.map((id) => wordById(mixed, id).difficulty).sort();
  assert.deepEqual(tiers, ["easy", "hard", "medium"]);
  const hard = newGame({ difficulty: "hard", wordChoices: 2 });
  assert.deepEqual(hard.round.wordOptions.map((id) => wordById(hard, id).difficulty), ["hard", "hard"]);
  assert.equal(new Set(hard.round.wordOptions).size, 2);
});

test("the seed and an injected rng make tables deterministic", () => {
  const first = createDrawGuessGame({ seats: seats(4) }, { seed: 99, now: 0 });
  const second = createDrawGuessGame({ seats: seats(4) }, { seed: 99, now: 0 });
  assert.deepEqual(first, second);
  const injected = createDrawGuessGame({ seats: seats(4) }, { rng: createSeededRng(5), now: 0 });
  const injectedAgain = createDrawGuessGame({ seats: seats(4) }, { rng: createSeededRng(5), now: 0 });
  assert.deepEqual(injected.round.wordOptions, injectedAgain.round.wordOptions);
  assert.deepEqual(injected.drawerOrder, injectedAgain.drawerOrder);
  const zero = createDrawGuessGame({ seats: seats(4) }, { rng: () => 0, now: 0 });
  assert.equal(zero.round.drawerSeat, 0);
  const last = createDrawGuessGame({ seats: seats(4) }, { rng: () => 0.999, now: 0 });
  assert.equal(last.round.drawerSeat, 3);
  assertRule(() => createDrawGuessGame({ seats: seats(2) }, { rng: () => 1, now: 0 }), "bad_rng");
});

test("only the drawer chooses a listed word, and choosing opens the prompt phase", () => {
  const state = newGame();
  assertRule(() => act(state, { type: "choose_word", seat: 1, optionIndex: 0 }), "not_drawer");
  assertRule(() => act(state, { type: "choose_word", seat: 0, optionIndex: 3 }), "bad_option");
  assertRule(() => act(state, { type: "choose_word", seat: 0, optionIndex: -1 }), "bad_option");
  assertRule(() => act(state, { type: "choose_word", seat: 7, optionIndex: 0 }), "bad_seat");
  assertRule(() => act(state, { type: "submit_prompt", seat: 0, prompt: "x" }), "wrong_phase");
  assertRule(() => act(state, { type: "fly" }), "bad_action");
  assertRule(() => act(state, null), "bad_action");
  const legal = legalActions(state, 0, { now: 1 });
  assert.deepEqual(legal.map((action) => action.optionIndex), [0, 1, 2]);
  assert.deepEqual(legalActions(state, 1, { now: 1 }), []);
  const { state: next, events } = act(state, { type: "choose_word", seat: 0, optionIndex: 1 }, 500);
  assert.equal(next.phase, "prompting");
  assert.equal(next.round.wordId, state.round.wordOptions[1]);
  assert.equal(next.round.deadlineAt, 500 + DEFAULT_CONFIG.promptTimeoutMs);
  assert.deepEqual(next.usedWordIds, [next.round.wordId]);
  assert.equal(events[0].type, "word_chosen");
  assert.equal(events[0].auto, false);
});

test("applyAction never mutates the input state", () => {
  const state = newGame();
  const snapshot = structuredClone(state);
  act(state, { type: "choose_word", seat: 0, optionIndex: 0 });
  assert.deepEqual(state, snapshot);
  const guessing = toGuessing(state);
  const guessingCopy = structuredClone(guessing);
  act(guessing, { type: "guess", seat: 1, text: "apple" }, 200);
  assert.deepEqual(guessing, guessingCopy);
});

test("deadlines: tick auto-picks a word, voids a silent drawer and ends guessing on time", () => {
  const state = newGame();
  assertRule(() => act(state, { type: "tick" }, 10), "not_yet");
  assertRule(() => act(state, { type: "choose_word", seat: 0, optionIndex: 0 }, DEFAULT_CONFIG.chooseTimeoutMs), "time_up");
  assert.deepEqual(legalActions(state, 0, { now: DEFAULT_CONFIG.chooseTimeoutMs }), []);
  assert.deepEqual(systemActions(state, { now: DEFAULT_CONFIG.chooseTimeoutMs }), [{ type: "tick" }]);
  const auto = applyAction(state, { type: "tick" }, { now: 20000, rng: () => 0.99 });
  assert.equal(auto.state.phase, "prompting");
  assert.equal(auto.state.round.wordId, state.round.wordOptions[2]);
  assert.equal(auto.events[0].auto, true);

  const silent = act(auto.state, { type: "tick" }, 20000 + DEFAULT_CONFIG.promptTimeoutMs);
  assert.equal(silent.state.phase, "round_over");
  assert.equal(silent.state.round.endReason, "prompt_timeout");
  assert.ok(silent.state.seats.every((seat) => seat.score === 0));

  const guessing = toGuessing(newGame(), "apple", 1000);
  const correct = act(guessing, { type: "guess", seat: 1, text: "apple" }, 2000).state;
  const late = 1000 + DEFAULT_CONFIG.roundDurationMs;
  assertRule(() => act(correct, { type: "guess", seat: 2, text: "pear" }, late), "time_up");
  const over = act(correct, { type: "tick" }, late);
  assert.equal(over.state.round.endReason, "time_up");
  assert.equal(over.state.seats[1].score, 10);
  assert.equal(over.state.seats[0].score, 3);
  assert.equal(over.state.seats[2].score, 0);
});

test("prompt validator rejects the word, plurals, inflections, synonyms, Chinese and spelled-out letters", () => {
  const apple = BANK[0];
  const cat = BANK[1];
  const iceCream = BANK[2];
  const butterfly = BANK[3];
  const knife = BANK[5];
  const leaks = [
    ["An APPLE on a desk", apple, "word"],
    ["three apples in a bowl", apple, "word"],
    ["an apple's shadow", apple, "word"],
    ["cats chasing yarn", cat, "word"],
    ["a cat-like creature", cat, "word"],
    ["a cute kitty", cat, "synonym"],
    ["kitties everywhere", cat, "synonym"],
    ["a cone of ice cream", iceCream, "word"],
    ["two ice creams melting", iceCream, "word"],
    ["an ice-cream truck", iceCream, "word"],
    ["icecream cone", iceCream, "word"],
    ["butterflies in a meadow", butterfly, "word"],
    ["three knives", knife, "word"],
    ["画一个苹果", apple, "chinese"],
    ["苹 果 on a plate", apple, "chinese"],
    ["a 猫咪 sleeping", cat, "chinese"],
    ["A-P-P-L-E", apple, "word"],
    ["a.p.p.l.e", apple, "word"],
    ["the letters a p p l e floating", apple, "spelled_out"],
    ["letters A, P, P, L, E", apple, "spelled_out"],
    ["e l p p a backwards", apple, "spelled_out"],
    ["c a t", cat, "spelled_out"],
  ];
  for (const [prompt, word, reason] of leaks) {
    const leak = findPromptLeak(prompt, word);
    assert.ok(leak, `expected a leak in “${prompt}”`);
    assert.equal(leak.reason, reason, prompt);
  }
  const clean = [
    ["a red fruit hanging from a branch", apple],
    ["a pineapple on a beach", apple],
    ["a catalog of furniture, a cathedral", cat],
    ["a cold dessert in a cone", iceCream],
    ["a cream cake with ice cubes", iceCream],
    ["a winged insect with colorful wings", butterfly],
    ["a man in a white suit floating in space", BANK[4]],
    ["a sharp kitchen blade", knife],
    ["a b c blocks", cat],
  ];
  for (const [prompt, word] of clean) assert.equal(findPromptLeak(prompt, word), null, prompt);
});

test("inflection helpers cover plural and verb forms", () => {
  assert.ok(pluralForms("berry").has("berries"));
  assert.ok(pluralForms("leaf").has("leaves"));
  assert.ok(pluralForms("box").has("boxes"));
  assert.ok(!pluralForms("cat").has("cating"));
  const run = inflectedForms("run");
  assert.ok(run.has("running") && run.has("runs"));
  const dance = inflectedForms("dance");
  assert.ok(dance.has("dancing") && dance.has("danced"));
  assert.ok(inflectedForms("cry").has("cried"));
});

test("a leaking prompt costs an attempt; the third rejection voids the round", () => {
  let state = act(newGame(), { type: "choose_word", seat: 0, optionIndex: 0 }).state;
  const word = wordById(state, state.round.wordId);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = act(state, { type: "submit_prompt", seat: 0, prompt: `a big ${word.word}` });
    state = result.state;
    assert.equal(state.phase, "prompting");
    assert.equal(result.events[0].type, "prompt_rejected");
    assert.equal(result.events[0].attemptsLeft, 3 - attempt);
  }
  const final = act(state, { type: "submit_prompt", seat: 0, prompt: `${word.zh}!` });
  assert.equal(final.state.phase, "round_over");
  assert.equal(final.state.round.endReason, "prompt_failed");
  assert.deepEqual(final.events.map((event) => event.type), ["prompt_rejected", "round_over"]);
  assert.ok(final.state.seats.every((seat) => seat.score === 0));
  assert.equal(final.state.history[0].endReason, "prompt_failed");
});

test("a clean prompt after a rejection moves to rendering and exposes the image request", () => {
  let state = act(newGame(), { type: "choose_word", seat: 0, optionIndex: 0 }).state;
  const word = wordById(state, state.round.wordId);
  state = act(state, { type: "submit_prompt", seat: 0, prompt: word.word }).state;
  assertRule(() => act(state, { type: "submit_prompt", seat: 1, prompt: "x" }), "not_drawer");
  assertRule(() => act(state, { type: "submit_prompt", seat: 0, prompt: "   " }), "empty_prompt");
  assertRule(() => act(state, { type: "submit_prompt", seat: 0, prompt: "x".repeat(401) }), "prompt_too_long");
  assert.equal(imageRequestFor(state), null);
  const { state: rendering, events } = act(state, { type: "submit_prompt", seat: 0, prompt: "  a mysterious object  " });
  assert.equal(rendering.phase, "rendering");
  assert.equal(events[0].type, "prompt_accepted");
  assert.deepEqual(imageRequestFor(rendering), { roundNumber: 1, drawerSeat: 0, prompt: "a mysterious object" });
  assert.deepEqual(systemActions(rendering, { now: 1 }).map((action) => action.type), ["image_ready", "image_failed"]);
  assert.deepEqual(legalActions(rendering, 0, { now: 1 }), []);
  assertRule(() => act(rendering, { type: "image_ready", seat: 0, imageRef: "x" }), "bad_seat");
  assertRule(() => act(rendering, { type: "image_ready", imageRef: " " }), "bad_image");
  const failed = act(rendering, { type: "image_failed", reason: "safety system" });
  assert.equal(failed.state.round.endReason, "image_failed");
  assert.ok(failed.state.seats.every((seat) => seat.score === 0));
  const ready = act(rendering, { type: "image_ready", imageRef: "img-9" }, 777);
  assert.equal(ready.state.phase, "guessing");
  assert.equal(ready.state.round.guessingStartedAt, 777);
  assert.equal(ready.state.round.deadlineAt, 777 + DEFAULT_CONFIG.roundDurationMs);
  assert.equal(ready.state.round.imageSource, "generated");
});

test("only a human drawer may submit a hand sketch, which skips rendering", () => {
  const humanDrawer = act(newGame(), { type: "choose_word", seat: 0, optionIndex: 0 }).state;
  assert.deepEqual(legalActions(humanDrawer, 0, { now: 1 }).map((action) => action.type), ["submit_prompt", "submit_sketch"]);
  assertRule(() => act(humanDrawer, { type: "submit_sketch", seat: 0, imageRef: "" }), "bad_image");
  const sketched = act(humanDrawer, { type: "submit_sketch", seat: 0, imageRef: "sketch-1" });
  assert.equal(sketched.state.phase, "guessing");
  assert.equal(sketched.state.round.imageSource, "sketch");

  const aiDrawer = act(newGame({ firstDrawerSeat: 1 }), { type: "choose_word", seat: 1, optionIndex: 0 }).state;
  assert.deepEqual(legalActions(aiDrawer, 1, { now: 1 }).map((action) => action.type), ["submit_prompt"]);
  assertRule(() => act(aiDrawer, { type: "submit_sketch", seat: 1, imageRef: "x" }), "not_human");
});

test("guess normalization accepts case, spacing, punctuation, articles, plurals, synonyms and Chinese", () => {
  const [apple, cat, iceCream, butterfly, astronaut, knife] = BANK;
  const accepted = [
    ["Apple", apple], ["  APPLES!! ", apple], ["an apple", apple], ["the apple?", apple],
    ["苹果", apple], [" 苹 果 ", apple],
    ["Kitty", cat], ["kitties", cat], ["猫咪", cat], ["the cats", cat],
    ["Ice Cream", iceCream], ["ice-cream", iceCream], ["icecream", iceCream], ["ice   creams", iceCream], ["gelato", iceCream], ["冰激凌", iceCream],
    ["butterflies", butterfly], ["spaceman", astronaut], ["knives", knife], ["Ápple", apple],
  ];
  for (const [guess, word] of accepted) assert.ok(isCorrectGuess(guess, word), `${guess} should match ${word.word}`);
  const rejected = [["pear", apple], ["apple pie", apple], ["", apple], ["cream", iceCream], ["catalog", cat], ["苹", apple], ["a", apple]];
  for (const [guess, word] of rejected) assert.ok(!isCorrectGuess(guess, word), `${guess} should not match ${word.word}`);
  assert.equal(normalizeGuess("  The   Big-Apple!! "), "bigapple");
  assert.equal(normalizeGuess("the"), "the");
});

test("close guesses are flagged within one typo, two for long words", () => {
  const [apple, cat, , butterfly] = BANK;
  assert.ok(isCloseGuess("aple", apple));
  assert.ok(isCloseGuess("applr", apple));
  assert.ok(!isCloseGuess("apple", apple));
  assert.ok(!isCloseGuess("banana", apple));
  assert.ok(!isCloseGuess("car", cat), "three-letter answers never flag close");
  assert.ok(isCloseGuess("buterfly", butterfly));
  assert.ok(isCloseGuess("butterfyl", butterfly));
});

test("guessing: drawer cannot guess, repeats are refused, solvers stop, guess limit applies", () => {
  const state = toGuessing(newGame({ seatCount: 4, maxGuessesPerRound: 2 }), "apple");
  assertRule(() => act(state, { type: "guess", seat: 0, text: "apple" }, 200), "is_drawer");
  assertRule(() => act(state, { type: "guess", seat: 1, text: "  " }, 200), "empty_guess");
  assertRule(() => act(state, { type: "guess", seat: 1, text: "x".repeat(61) }, 200), "guess_too_long");
  let next = act(state, { type: "guess", seat: 1, text: "Pear" }, 200);
  assert.deepEqual(next.events[0], { type: "guess_wrong", seat: 1, text: "Pear", close: false, guessesLeft: 1 });
  assertRule(() => act(next.state, { type: "guess", seat: 1, text: "pear!" }, 201), "repeated_guess");
  next = act(next.state, { type: "guess", seat: 1, text: "plum" }, 202);
  assertRule(() => act(next.state, { type: "guess", seat: 1, text: "apple" }, 203), "no_guesses_left");
  assert.deepEqual(legalActions(next.state, 1, { now: 203 }), []);
  next = act(next.state, { type: "guess", seat: 2, text: "APPLE" }, 204);
  assert.deepEqual(next.events[0], { type: "guess_correct", seat: 2, order: 1 });
  assertRule(() => act(next.state, { type: "guess", seat: 2, text: "apple" }, 205), "already_solved");
  assert.equal(next.state.phase, "guessing");
  const passed = act(next.state, { type: "pass", seat: 3 }, 206);
  assertRule(() => act(passed.state, { type: "guess", seat: 3, text: "x" }, 207), "wrong_phase");
  assert.equal(passed.state.phase, "round_over");
  assert.equal(passed.state.round.endReason, "all_done");
});

test("a pass is final for the round", () => {
  const state = toGuessing(newGame({ seatCount: 4 }), "apple");
  const passed = act(state, { type: "pass", seat: 1 }, 200).state;
  assertRule(() => act(passed, { type: "guess", seat: 1, text: "apple" }, 201), "already_passed");
  assertRule(() => act(passed, { type: "pass", seat: 1 }, 201), "already_passed");
});

test("scoring follows guess order with tier bonus and a drawer bonus per solver", () => {
  const base = newGame({ seatCount: 6 });
  let state = toGuessing(base, "ice-cream");
  for (const [seat, guess] of [[3, "gelato"], [1, "icecream"], [5, "冰淇淋"], [2, "ice creams"], [4, "Ice Cream"]]) {
    state = act(state, { type: "guess", seat, text: guess }, 300).state;
  }
  assert.equal(state.phase, "round_over");
  assert.equal(state.round.endReason, "all_solved");
  // orderPoints [10, 8, 6, 5, 4] + medium bonus 2; drawer 3 x 5 solvers.
  assert.deepEqual(state.round.points, { 0: 15, 1: 10, 2: 7, 3: 12, 4: 6, 5: 8 });
  assert.deepEqual(state.seats.map((seat) => seat.score), [15, 10, 7, 12, 6, 8]);

  const custom = toGuessing(newGame({ seatCount: 4, scoring: { orderPoints: [5], tierBonus: { easy: 1, medium: 2, hard: 3 }, drawerPerCorrect: 2 } }), "astronaut");
  let after = act(custom, { type: "guess", seat: 2, text: "astronaut" }, 300).state;
  after = act(after, { type: "guess", seat: 1, text: "astronauts" }, 301).state;
  after = act(after, { type: "pass", seat: 3 }, 302).state;
  assert.deepEqual(after.round.points, { 0: 4, 1: 8, 2: 8, 3: 0 });
});

test("nobody solving gives the drawer nothing", () => {
  const state = toGuessing(newGame(), "apple", 0);
  const over = act(state, { type: "tick" }, DEFAULT_CONFIG.roundDurationMs).state;
  assert.deepEqual(over.round.points, { 0: 0, 1: 0, 2: 0 });
});

test("the reveal schedule lowers blur over time and solvers see the image sharp", () => {
  const state = toGuessing(newGame(), "apple", 1000);
  assert.deepEqual(revealAt(state, 1000), { stage: 0, blurPx: 28, nextChangeAt: 16000, stages: 4 });
  assert.deepEqual(revealAt(state, 16000), { stage: 1, blurPx: 16, nextChangeAt: 31000, stages: 4 });
  assert.deepEqual(revealAt(state, 31000), { stage: 2, blurPx: 8, nextChangeAt: 46000, stages: 4 });
  assert.deepEqual(revealAt(state, 59000), { stage: 3, blurPx: 2, nextChangeAt: null, stages: 4 });
  assert.deepEqual(visionInputFor(state, 1, 20000), { imageRef: "img-1", blurPx: 16, stage: 1 });
  assert.equal(visionInputFor(state, 0, 20000).blurPx, 0);
  const solved = act(state, { type: "guess", seat: 1, text: "apple" }, 20000).state;
  assert.equal(visionInputFor(solved, 1, 20001).blurPx, 0);
  assert.equal(visionInputFor(solved, 2, 20001).blurPx, 16);
  const over = act(solved, { type: "pass", seat: 2 }, 20002).state;
  assert.equal(revealAt(over, 20003).blurPx, 0);
  assert.equal(visionInputFor(over, 2, 20003).blurPx, 0);
  assert.equal(visionInputFor(newGame(), 1, 0), null);

  const custom = toGuessing(newGame({ revealSchedule: [{ afterMs: 0, blurPx: 10 }, { afterMs: 5000, blurPx: 0 }] }), "apple", 0);
  assert.equal(revealAt(custom, 4999).blurPx, 10);
  assert.equal(revealAt(custom, 5000).blurPx, 0);
  assert.equal(DEFAULT_REVEAL_SCHEDULE[0].afterMs, 0);
});

test("table talk is stored, capped at 140 characters and may not leak the word", () => {
  const state = toGuessing(newGame(), "apple");
  const talked = act(state, { type: "guess", seat: 1, text: "pear", tableTalk: "  Looks juicy.  " }, 200);
  assert.deepEqual(talked.state.round.talk, [{ seat: 1, text: "Looks juicy.", at: 200 }]);
  assert.ok(talked.events.some((event) => event.type === "table_talk" && event.text === "Looks juicy."));
  assertRule(() => act(state, { type: "guess", seat: 1, text: "pear", tableTalk: "x".repeat(141) }, 200), "bad_table_talk");
  assertRule(() => act(state, { type: "guess", seat: 1, text: "pear", tableTalk: 7 }, 200), "bad_table_talk");
  assertRule(() => act(state, { type: "pass", seat: 1, tableTalk: "is it an apple?" }, 200), "talk_leak");
  const prompting = act(newGame(), { type: "choose_word", seat: 0, optionIndex: 0 }).state;
  const word = wordById(prompting, prompting.round.wordId);
  assertRule(() => act(prompting, { type: "submit_prompt", seat: 0, prompt: "a thing", tableTalk: `Easy: ${word.zh}` }), "talk_leak");
  assert.deepEqual(validateAction(prompting, { type: "submit_prompt", seat: 0, prompt: "a thing", tableTalk: word.word }, { now: 1 }).code, "talk_leak");
});

test("talk from seats that know the word is held from seats still guessing until the round ends", () => {
  const state = toGuessing(newGame({ seatCount: 4 }), "apple");
  const solved = act(state, { type: "guess", seat: 1, text: "apple", tableTalk: "Crisp and red, obviously." }, 200);
  assert.ok(solved.events.some((event) => event.type === "table_talk" && event.held === true));
  assert.equal(solved.state.phase, "guessing");
  assert.deepEqual(viewFor(solved.state, 2, { now: 201 }).round.talk, []);
  assert.equal(viewFor(solved.state, 1, { now: 201 }).round.talk.length, 1);
  assert.equal(viewFor(solved.state, 0, { now: 201 }).round.talk.length, 1);
  assert.equal(viewFor(solved.state, null, { now: 201, revealSecret: true }).round.talk.length, 1);
  const wrong = act(solved.state, { type: "guess", seat: 2, text: "pear", tableTalk: "Fruit?" }, 300);
  assert.ok(wrong.events.some((event) => event.type === "table_talk" && !event.held));
  assert.equal(viewFor(wrong.state, 3, { now: 301 }).round.talk.length, 1);
  const over = act(wrong.state, { type: "tick" }, 100 + DEFAULT_CONFIG.roundDurationMs);
  assert.equal(viewFor(over.state, 3, { now: 99999 }).round.talk.length, 2);

  const prompting = act(newGame(), { type: "choose_word", seat: 0, optionIndex: 0, tableTalk: "Here we go." }).state;
  assert.deepEqual(viewFor(prompting, 1, { now: 2 }).round.talk, []);
});

test("the drawer rotates every round and the game ends after every seat drew each rotation", () => {
  let state = newGame({ rotations: 2, firstDrawerSeat: 1, wordBank: undefined });
  assert.equal(state.totalTurns, 6);
  const drawers = [];
  const used = [];
  for (let turn = 1; turn <= 6; turn += 1) {
    drawers.push(state.round.drawerSeat);
    assert.equal(state.round.number, turn);
    assert.equal(state.round.rotation, turn <= 3 ? 1 : 2);
    state = act(state, { type: "choose_word", seat: state.round.drawerSeat, optionIndex: 0 }).state;
    used.push(state.round.wordId);
    state = act(state, { type: "tick" }, 1 + DEFAULT_CONFIG.promptTimeoutMs).state;
    assert.equal(state.phase, "round_over");
    assert.deepEqual(systemActions(state, { now: 1 }), [{ type: "next_round" }]);
    const result = act(state, { type: "next_round" }, 2);
    state = result.state;
    assert.equal(result.events[0].type, turn < 6 ? "round_started" : "game_over");
  }
  assert.deepEqual(drawers, [1, 2, 0, 1, 2, 0]);
  assert.equal(new Set(used).size, 6, "words do not repeat while the bank lasts");
  assert.equal(state.phase, "game_over");
  assert.equal(state.history.length, 6);
  assertRule(() => act(state, { type: "next_round" }), "game_over");
  assert.deepEqual(systemActions(state, { now: 1 }), []);
});

test("a small word bank reuses words instead of stalling", () => {
  const tiny = BANK.slice(0, 3);
  let state = newGame({ wordBank: tiny, wordChoices: 2, rotations: 3, seatCount: 2 });
  for (let turn = 0; turn < 6; turn += 1) {
    assert.equal(state.round.wordOptions.length, 2);
    state = act(state, { type: "choose_word", seat: state.round.drawerSeat, optionIndex: 0 }).state;
    state = act(state, { type: "tick" }, 1 + DEFAULT_CONFIG.promptTimeoutMs).state;
    state = act(state, { type: "next_round" }).state;
  }
  assert.equal(state.phase, "game_over");
  assertRule(() => newGame({ wordBank: tiny, wordChoices: 4 }), "bad_config");
});

test("final standings rank by score and share first place on a tie", () => {
  let state = newGame({ seatCount: 2, rotations: 1 });
  state = toGuessing(state, "apple");
  state = act(state, { type: "guess", seat: 1, text: "apple" }, 200).state; // seat 1: 10, drawer 0: 3
  state = act(state, { type: "next_round" }).state;
  state = toGuessing(state, "cat");
  state = act(state, { type: "pass", seat: 0 }, 300).state;
  const final = act(state, { type: "next_round" });
  assert.equal(final.state.phase, "game_over");
  assert.deepEqual(final.state.result.standings, [{ seat: 1, score: 10, rank: 1 }, { seat: 0, score: 3, rank: 2 }]);
  assert.deepEqual(final.state.result.winners, [1]);

  let tied = newGame({ seatCount: 2, scoring: { orderPoints: [3], drawerPerCorrect: 3 } });
  tied = toGuessing(tied, "apple");
  tied = act(tied, { type: "guess", seat: 1, text: "apple" }, 200).state;
  tied = act(tied, { type: "next_round" }).state;
  tied = toGuessing(tied, "cat");
  tied = act(tied, { type: "pass", seat: 0 }, 300).state;
  const end = act(tied, { type: "next_round" }).state;
  assert.deepEqual(end.result.standings, [{ seat: 0, score: 3, rank: 1 }, { seat: 1, score: 3, rank: 1 }]);
  assert.deepEqual(end.result.winners, [0, 1]);
});

test("views hide the secret, options, prompt and correct guesses from those who must not know", () => {
  const choosing = newGame({ seatCount: 4 });
  assert.equal(viewFor(choosing, 1, { now: 1 }).round.wordOptions, null);
  assert.equal(viewFor(choosing, 0, { now: 1 }).round.wordOptions.length, 3);
  assert.equal(viewFor(choosing, null, { now: 1, revealSecret: true }).round.wordOptions.length, 3);

  let state = toGuessing(choosing, "apple", 100);
  state = act(state, { type: "guess", seat: 1, text: "Apple!" }, 200).state;
  state = act(state, { type: "guess", seat: 2, text: "pear" }, 201).state;
  const outsider = viewFor(state, 3, { now: 202 });
  const serialized = JSON.stringify(outsider);
  assert.ok(!serialized.includes("苹果") && !/apple/i.test(serialized), "an unsolved guesser sees no trace of the word");
  assert.equal(outsider.round.secret, null);
  assert.equal(outsider.round.prompt, null);
  assert.equal(outsider.round.promptAttempts, null);
  assert.deepEqual(outsider.round.guesses.map((guess) => guess.text), [null, "pear"]);
  assert.equal(outsider.round.wordShape, "_____");
  assert.equal(outsider.round.image.blurPx, 28);
  assert.equal(outsider.round.points, null);

  const spectator = viewFor(state, null, { now: 202 });
  assert.ok(!/apple/i.test(JSON.stringify(spectator)));
  assert.equal(spectator.round.image.blurPx, 28);

  const solver = viewFor(state, 1, { now: 202 });
  assert.equal(solver.round.secret.word, "apple");
  assert.equal(solver.round.image.blurPx, 0);
  assert.equal(solver.round.guesses[0].text, "Apple!");

  const drawer = viewFor(state, 0, { now: 202 });
  assert.equal(drawer.round.secret.zh, "苹果");
  assert.ok(drawer.round.prompt);
  assert.equal(viewFor(state, null, { now: 202, revealSecret: true }).round.secret.word, "apple");

  const over = act(state, { type: "tick" }, 100 + DEFAULT_CONFIG.roundDurationMs).state;
  const after = viewFor(over, 3, { now: 1 });
  assert.equal(after.round.secret.word, "apple");
  assert.ok(after.round.prompt);
  assert.equal(after.round.guesses[0].text, "Apple!");
  assert.equal(after.round.image.blurPx, 0);
  assert.deepEqual(after.round.points, { 0: 3, 1: 10, 2: 0, 3: 0 });
});

test("save and resume round-trips through JSON and continues identically", () => {
  let state = toGuessing(newGame({ seatCount: 3, rotations: 2 }), "apple");
  state = act(state, { type: "guess", seat: 1, text: "pear", tableTalk: "hmm" }, 200).state;
  const payload = JSON.parse(JSON.stringify(toSave(state, "2026-11-17T03:00:00.000Z")));
  const restored = fromSave(payload);
  assert.deepEqual(restored, state);
  const continueGame = (start) => {
    let next = act(start, { type: "tick" }, 100 + DEFAULT_CONFIG.roundDurationMs).state;
    next = act(next, { type: "next_round" }).state;
    return next.round.wordOptions;
  };
  assert.deepEqual(continueGame(restored), continueGame(state), "the stored rng state resumes the same draws");

  const done = (() => {
    let game = newGame({ seatCount: 2 });
    for (let turn = 0; turn < 2; turn += 1) {
      game = act(game, { type: "choose_word", seat: game.round.drawerSeat, optionIndex: 0 }).state;
      game = act(game, { type: "tick" }, 1 + DEFAULT_CONFIG.promptTimeoutMs).state;
      game = act(game, { type: "next_round" }).state;
    }
    return game;
  })();
  assert.deepEqual(fromSave(JSON.parse(JSON.stringify(toSave(done)))), done);
});

test("fromSave rejects tampered or foreign payloads", () => {
  const state = toGuessing(newGame(), "apple");
  const good = () => JSON.parse(JSON.stringify(toSave(state)));
  const cases = [
    (payload) => { payload.gameId = "go"; },
    (payload) => { payload.version = 99; },
    (payload) => { delete payload.state; },
    (payload) => { payload.state.phase = "dancing"; },
    (payload) => { payload.state.seats[1].score = -4; },
    (payload) => { payload.state.round.drawerSeat = 2; },
    (payload) => { payload.state.drawerOrder = [0, 0, 1]; },
    (payload) => { payload.state.round.wordId = "zebra"; },
    (payload) => { payload.state.round.imageRef = null; },
    (payload) => { payload.state.totalTurns = 99; },
    (payload) => { payload.state.rngState = -1; },
    (payload) => { payload.state.config.difficulty = "extreme"; },
    (payload) => { payload.state.seats = payload.state.seats.slice(0, 1); },
    (payload) => { payload.state.round.solvedOrder = [0]; },
  ];
  for (const tamper of cases) {
    const payload = good();
    tamper(payload);
    assertRule(() => fromSave(payload), "bad_save");
  }
  assertRule(() => fromSave(null), "bad_save");
});
