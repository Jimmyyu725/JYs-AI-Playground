import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAction,
  createLiarsDiceGame,
  isGameOver,
  legalActions,
  minimumQuantityForFace,
} from "../src/games/liars-dice/engine.js";
import {
  buildAIView,
  buildInstructions,
  DECISION_SCHEMA,
  numberedOptions,
  parseDecision,
  TABLE_TALK_MAX,
} from "../src/games/liars-dice/ai-view.js";

const NAMES = ["Vesper Vale", "Rook Mercer", "Juniper Quill", "Otto Brass"];

function withDice(state, diceBySeat) {
  const next = structuredClone(state);
  diceBySeat.forEach((dice, seat) => {
    next.seats[seat].dice = [...dice].sort((left, right) => left - right);
  });
  return next;
}

function game(seatCount = 4) {
  return createLiarsDiceGame({ seatCount, startingSeat: 0, seed: 5 });
}

function bid(state, seat, quantity, face) {
  return applyAction(state, seat, { type: "bid", quantity, face });
}

function answer(fields) {
  return { option: 1, quantity: null, face: null, tableTalk: null, explanation: "Because.", ...fields };
}

function optionFor(state, seat, predicate) {
  return numberedOptions(state, seat).find(predicate);
}

// ---------------------------------------------------------------------------
// Snapshot

test("the view holds the seat's own dice and no other hidden information", () => {
  const state = withDice(game(), [[1, 2, 3, 4, 5], [6, 6, 6, 6, 6], [2, 2, 2, 2, 2], [3, 3, 3, 3, 3]]);
  const view = buildAIView(state, 0, { seatNames: NAMES, character: { title: "The Velvet Knife", personality: "Patient." } });
  assert.deepEqual(view.you.dice, [1, 2, 3, 4, 5]);
  assert.equal(view.you.name, "Vesper Vale");
  assert.equal(view.you.title, "The Velvet Knife");
  assert.equal(view.totalDiceOnTable, 20);
  assert.equal(view.unknownDice, 15);
  assert.equal(view.yourTurn, true);
  assert.deepEqual(view.players.map((player) => player.diceCount), [5, 5, 5, 5]);
  assert.ok(view.players.every((player) => !("dice" in player)));
  const text = JSON.stringify(view);
  assert.equal(text.includes("rngState"), false);
  assert.equal(text.includes("6,6,6,6,6"), false, "another seat's dice must not leak");
  assert.equal(text.includes("stats"), false);
});

test("odds hints count the seat's own matches and the expected hidden matches", () => {
  const state = withDice(game(2), [[1, 1, 4, 4, 6], [2, 2, 2, 2, 2]]);
  const view = buildAIView(state, 0);
  const fours = view.odds.find((entry) => entry.face === 4);
  assert.equal(fours.yourMatching, 4);
  assert.equal(fours.expectedTotal, Math.round((4 + 5 / 3) * 10) / 10);
  const ones = view.odds.find((entry) => entry.face === 1);
  assert.equal(ones.yourMatching, 2);
  assert.equal(ones.expectedTotal, Math.round((2 + 5 / 6) * 10) / 10);
});

test("the view carries this round's bids and the previous public reveal", () => {
  let state = bid(game(), 0, 3, 4);
  state = bid(state, 1, 4, 4);
  let view = buildAIView(state, 2, { seatNames: NAMES });
  assert.equal(view.currentBid.label, "4 × 4s");
  assert.equal(view.currentBid.bidder, "Rook Mercer");
  assert.deepEqual(view.bidsThisRound.map((entry) => entry.label), ["3 × 4s", "4 × 4s"]);
  assert.equal(view.previousReveal, null);

  const revealed = state.seats.map((seat) => [...seat.dice]);
  state = applyAction(state, 2, { type: "dudo" });
  view = buildAIView(state, 3, { seatNames: NAMES });
  assert.equal(view.previousReveal.type, "dudo");
  assert.equal(view.previousReveal.caller, "Juniper Quill");
  assert.equal(view.previousReveal.bid, "4 × 4s");
  assert.deepEqual(view.previousReveal.dice.map((entry) => entry.dice), revealed);
  assert.deepEqual(view.bidsThisRound, []);
});

test("off-turn and default names still produce a view without options", () => {
  const view = buildAIView(game(3), 2);
  assert.equal(view.yourTurn, false);
  assert.deepEqual(view.options, []);
  assert.equal(view.you.name, "Seat 2");
  assert.throws(() => buildAIView(game(3), 5), /not at this table/);
});

// ---------------------------------------------------------------------------
// Numbered options

test("opening options are bids only, one range per face, ones excluded", () => {
  const options = numberedOptions(game(), 0);
  assert.deepEqual(options.map((entry) => entry.option), [1, 2, 3, 4, 5]);
  assert.ok(options.every((entry) => entry.type === "bid" && entry.minQuantity === 1 && entry.maxQuantity === 20));
  assert.deepEqual(options.map((entry) => entry.face), [2, 3, 4, 5, 6]);
});

test("after a bid the options are Liar, Calza, then bid ranges that match the engine", () => {
  const state = bid(game(), 0, 3, 4);
  const options = numberedOptions(state, 1);
  assert.equal(options[0].type, "dudo");
  assert.match(options[0].label, /Liar.*3 × 4s/);
  assert.equal(options[1].type, "calza");
  for (const entry of options.slice(2)) {
    assert.equal(entry.type, "bid");
    assert.equal(entry.minQuantity, minimumQuantityForFace(state, entry.face));
  }
  assert.deepEqual(options.map((entry) => entry.option), options.map((_, index) => index + 1));
  assert.deepEqual(numberedOptions(state, 0), []);
});

test("heads-up tables offer no Calza", () => {
  const state = bid(game(2), 0, 2, 3);
  assert.ok(!numberedOptions(state, 1).some((entry) => entry.type === "calza"));
});

// ---------------------------------------------------------------------------
// Schema and prompt

test("the decision schema is strict and caps table talk at 140 characters", () => {
  assert.equal(DECISION_SCHEMA.additionalProperties, false);
  assert.deepEqual([...DECISION_SCHEMA.required].sort(), Object.keys(DECISION_SCHEMA.properties).sort());
  const talk = DECISION_SCHEMA.properties.tableTalk.anyOf.find((entry) => entry.type === "string");
  assert.equal(talk.maxLength, 140);
  assert.equal(TABLE_TALK_MAX, 140);
  assert.ok(DECISION_SCHEMA.properties.tableTalk.anyOf.some((entry) => entry.type === "null"));
});

test("instructions list the numbered options, the dice, and retry feedback", () => {
  const state = bid(game(), 0, 3, 4);
  const view = buildAIView(state, 1, { seatNames: NAMES });
  const text = buildInstructions(view);
  assert.match(text, /You are Rook Mercer/);
  assert.match(text, /1\. Call Liar \(dudo\) on 3 × 4s/);
  assert.match(text, /2\. Call Calza/);
  assert.match(text, new RegExp(`Your dice: ${view.you.dice.join(" ")}`));
  assert.match(text, /Ones are wild/);
  const retry = buildInstructions(view, { retryNumber: 1, maxRetries: 2, rejected: { option: 9 }, error: "bad option" });
  assert.match(retry, /AUTOMATIC RETRY 1\/2.*\{"option":9\}.*bad option/);
});

test("palifico rounds are announced in the prompt", () => {
  let state = withDice(game(3), [[1, 1, 4, 4, 4], [2, 2], [3, 3, 3, 3, 3]]);
  state = bid(state, 0, 3, 2);
  state = applyAction(state, 1, { type: "dudo" });
  assert.equal(state.palifico, true);
  const view = buildAIView(state, 1);
  assert.equal(view.onesWild, false);
  assert.match(buildInstructions(view), /PALIFICO ROUND: ones are NOT wild/);
  assert.equal(numberedOptions(state, 1)[0].face, 1, "the palifico opener may bid on ones");
});

// ---------------------------------------------------------------------------
// Parsing

test("a bid answer maps to the engine action", () => {
  const state = bid(game(), 0, 3, 4);
  const fives = optionFor(state, 1, (entry) => entry.face === 5);
  const result = parseDecision(state, 1, answer({ option: fives.option, quantity: 3, face: 5, tableTalk: "  Fives, friends.  " }));
  assert.deepEqual(result, { ok: true, action: { type: "bid", quantity: 3, face: 5 }, tableTalk: "Fives, friends.", explanation: "Because." });
  assert.doesNotThrow(() => applyAction(state, 1, result.action));
});

test("Liar and Calza answers map to their actions", () => {
  const state = bid(game(), 0, 3, 4);
  assert.deepEqual(parseDecision(state, 1, answer({ option: 1 })).action, { type: "dudo" });
  assert.deepEqual(parseDecision(state, 1, answer({ option: 2 })).action, { type: "calza" });
});

test("a JSON string answer is accepted and broken JSON is a precise error", () => {
  const state = bid(game(), 0, 3, 4);
  assert.deepEqual(parseDecision(state, 1, JSON.stringify(answer({ option: 1 }))).action, { type: "dudo" });
  assert.deepEqual(parseDecision(state, 1, "{oops").error.code, "malformed");
  assert.deepEqual(parseDecision(state, 1, "[1]").error.code, "malformed");
  assert.deepEqual(parseDecision(state, 1, null).error.code, "malformed");
});

test("rejections name the exact problem", () => {
  const state = bid(game(), 0, 3, 4);
  const fives = optionFor(state, 1, (entry) => entry.face === 5);

  const unknown = parseDecision(state, 1, answer({ option: 99 }));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "unknown_option");
  assert.match(unknown.error.message, /must be one of 1, 2, 3/);
  assert.equal(parseDecision(state, 1, answer({ option: "1" })).error.code, "unknown_option");

  const mismatch = parseDecision(state, 1, answer({ option: fives.option, quantity: 4, face: 6 }));
  assert.equal(mismatch.error.code, "face_mismatch");
  assert.match(mismatch.error.message, /bids on 5s, but "face" is 6/);

  const low = parseDecision(state, 1, answer({ option: fives.option, quantity: 2, face: 5 }));
  assert.equal(low.error.code, "quantity_out_of_range");
  assert.match(low.error.message, /from 3 to 20; got 2/);
  const high = parseDecision(state, 1, answer({ option: fives.option, quantity: 21, face: 5 }));
  assert.equal(high.error.code, "quantity_out_of_range");

  assert.equal(parseDecision(state, 1, answer({ option: fives.option, quantity: null, face: 5 })).error.code, "bad_fields");
  assert.equal(parseDecision(state, 1, answer({ option: fives.option, quantity: 3, face: null })).error.code, "bad_fields");
  assert.equal(parseDecision(state, 1, answer({ option: fives.option, quantity: 3.5, face: 5 })).error.code, "bad_fields");

  const dudoWithBid = parseDecision(state, 1, answer({ option: 1, quantity: 5, face: 4 }));
  assert.equal(dudoWithBid.error.code, "bad_fields");
  assert.match(dudoWithBid.error.message, /Liar.*set "quantity" and "face" to null/);

  assert.equal(parseDecision(state, 2, answer({ option: 1 })).error.code, "not_your_turn");
});

test("Liar cannot be chosen at the opening because option 1 is a bid there", () => {
  const state = game();
  const result = parseDecision(state, 0, answer({ option: 1 }));
  assert.equal(result.error.code, "bad_fields");
  assert.match(result.error.message, /bid on 2s/);
});

test("table talk is cleaned, capped at 140 code points, and empty talk becomes null", () => {
  const state = bid(game(), 0, 3, 4);
  const long = "🎲".repeat(200);
  const capped = parseDecision(state, 1, answer({ option: 1, tableTalk: long }));
  assert.equal(Array.from(capped.tableTalk).length, 140);
  assert.ok(capped.tableTalk.isWellFormed());
  const cleaned = parseDecision(state, 1, answer({ option: 1, tableTalk: "line\none\u0007 two" }));
  assert.equal(cleaned.tableTalk, "line one two");
  assert.equal(parseDecision(state, 1, answer({ option: 1, tableTalk: "   " })).tableTalk, null);
  assert.equal(parseDecision(state, 1, answer({ option: 1, tableTalk: 42 })).tableTalk, null);
});

test("every option the view offers parses into an action the engine accepts", () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    let state = createLiarsDiceGame({ seatCount: 2 + (seed % 5), seed });
    let steps = 0;
    while (!isGameOver(state) && steps < 400) {
      const seat = state.currentSeat;
      const options = numberedOptions(state, seat);
      assert.ok(options.length > 0);
      for (const entry of options) {
        const quantities = entry.type === "bid" ? [entry.minQuantity, entry.maxQuantity] : [null];
        for (const quantity of quantities) {
          const result = parseDecision(state, seat, answer({ option: entry.option, quantity, face: entry.type === "bid" ? entry.face : null }));
          assert.equal(result.ok, true, JSON.stringify(result.error));
          assert.ok(legalActions(state, seat).some((action) => JSON.stringify(action) === JSON.stringify(result.action)));
        }
      }
      // Advance: raise by the cheapest option early, challenge once bids reach a third of the dice.
      const choice = state.currentBid && state.currentBid.quantity * 3 >= state.seats.reduce((sum, entry) => sum + entry.dice.length, 0)
        ? options[(seed + steps) % (options[1]?.type === "calza" ? 2 : 1)]
        : options.find((entry) => entry.type === "bid");
      const parsed = parseDecision(state, seat, answer({
        option: choice.option,
        quantity: choice.type === "bid" ? choice.minQuantity : null,
        face: choice.type === "bid" ? choice.face : null,
      }));
      state = applyAction(state, seat, parsed.action);
      steps += 1;
    }
    assert.equal(isGameOver(state), true);
  }
});
