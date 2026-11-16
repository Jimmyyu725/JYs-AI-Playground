import assert from "node:assert/strict";
import test from "node:test";
import {
  activeSeats,
  applyAction,
  bidError,
  calzaAllowed,
  countMatching,
  createLiarsDiceGame,
  DEFAULT_RULES,
  isGameOver,
  legalActions,
  legalBidRanges,
  LiarsDiceError,
  minimumQuantityForFace,
  nextActiveSeat,
  publicView,
  restoreLiarsDiceState,
  totalDice,
  viewForSeat,
} from "../src/games/liars-dice/engine.js";

// A random source that always rolls `face`.
function constantRoll(face) {
  return () => (face - 1) / 6 + 0.01;
}

// Returns a copy of `state` with the given dice per seat (an empty array knocks a seat out).
function withDice(state, diceBySeat) {
  const next = structuredClone(state);
  diceBySeat.forEach((dice, seat) => {
    next.seats[seat].dice = [...dice].sort((left, right) => left - right);
  });
  return next;
}

function game(seatCount, extra = {}) {
  return createLiarsDiceGame({ seatCount, startingSeat: 0, seed: 1, ...extra });
}

function bid(state, seat, quantity, face) {
  return applyAction(state, seat, { type: "bid", quantity, face });
}

function expectError(fn, code) {
  assert.throws(fn, (error) => error instanceof LiarsDiceError && error.code === code);
}

// ---------------------------------------------------------------------------
// Setup

test("creates 2 to 6 seats with five sorted hidden dice each", () => {
  for (let seatCount = 2; seatCount <= 6; seatCount += 1) {
    const state = game(seatCount);
    assert.equal(state.seats.length, seatCount);
    assert.equal(state.phase, "bidding");
    assert.equal(state.round, 1);
    assert.equal(state.currentSeat, 0);
    assert.equal(state.currentBid, null);
    assert.equal(totalDice(state), seatCount * 5);
    for (const seat of state.seats) {
      assert.equal(seat.dice.length, 5);
      assert.ok(seat.dice.every((die) => Number.isInteger(die) && die >= 1 && die <= 6));
      assert.deepEqual(seat.dice, [...seat.dice].sort((a, b) => a - b));
    }
  }
});

test("rejects seat counts outside 2-6 and bad options", () => {
  expectError(() => createLiarsDiceGame({ seatCount: 1 }), "bad_config");
  expectError(() => createLiarsDiceGame({ seatCount: 7 }), "bad_config");
  expectError(() => createLiarsDiceGame({}), "bad_config");
  expectError(() => createLiarsDiceGame({ seatCount: 3, startingSeat: 3 }), "bad_config");
  expectError(() => createLiarsDiceGame({ seatCount: 3, seed: 1.5 }), "bad_config");
  expectError(() => createLiarsDiceGame({ seatCount: 3, rules: { startingDice: 0 } }), "bad_config");
});

test("applies default rules and accepts overrides", () => {
  assert.deepEqual(game(3).rules, { ...DEFAULT_RULES });
  const custom = game(3, { rules: { startingDice: 3, calza: false, palifico: false, openingOnes: true } });
  assert.deepEqual(custom.rules, { startingDice: 3, calza: false, palifico: false, openingOnes: true });
  assert.ok(custom.seats.every((seat) => seat.dice.length === 3));
});

test("a seed makes the rolls reproducible and an injected rng wins over it", () => {
  const first = createLiarsDiceGame({ seatCount: 4, seed: 99 });
  const second = createLiarsDiceGame({ seatCount: 4, seed: 99 });
  assert.deepEqual(first.seats, second.seats);
  assert.equal(first.currentSeat, second.currentSeat);
  const forced = createLiarsDiceGame({ seatCount: 3, seed: 99, startingSeat: 1, rng: constantRoll(4) });
  assert.ok(forced.seats.every((seat) => seat.dice.every((die) => die === 4)));
  assert.equal(forced.currentSeat, 1);
});

test("picks a random opener when none is given", () => {
  const state = createLiarsDiceGame({ seatCount: 6, rng: () => 0.99 });
  assert.equal(state.currentSeat, 5);
});

test("rejects a random source that leaves [0, 1)", () => {
  expectError(() => createLiarsDiceGame({ seatCount: 2, startingSeat: 0, rng: () => 1 }), "bad_rng");
  expectError(() => createLiarsDiceGame({ seatCount: 2, startingSeat: 0, rng: () => Number.NaN }), "bad_rng");
});

// ---------------------------------------------------------------------------
// Bidding

test("a round cannot open on ones unless the openingOnes rule is on", () => {
  const state = game(3);
  assert.match(bidError(state, 2, 1), /cannot open/);
  expectError(() => bid(state, 0, 2, 1), "illegal_bid");
  assert.equal(minimumQuantityForFace(state, 1), null);
  const lenient = game(3, { rules: { openingOnes: true } });
  assert.equal(bid(lenient, 0, 2, 1).currentBid.face, 1);
});

test("opening offers no challenge and challenging without a bid is refused", () => {
  const state = game(3);
  const actions = legalActions(state, 0);
  assert.ok(actions.every((action) => action.type === "bid"));
  assert.equal(calzaAllowed(state), false);
  expectError(() => applyAction(state, 0, { type: "dudo" }), "no_bid");
  expectError(() => applyAction(state, 0, { type: "calza" }), "no_bid");
});

test("a raise on faces 2-6 needs more dice, or the same dice on a higher face", () => {
  const state = bid(game(3), 0, 3, 4);
  assert.equal(bidError(state, 3, 5), null);
  assert.equal(bidError(state, 3, 6), null);
  assert.equal(bidError(state, 4, 2), null);
  assert.equal(bidError(state, 4, 4), null);
  assert.match(bidError(state, 3, 4), /does not raise/);
  assert.match(bidError(state, 3, 3), /does not raise/);
  assert.match(bidError(state, 2, 6), /keep at least 3/);
  assert.equal(minimumQuantityForFace(state, 5), 3);
  assert.equal(minimumQuantityForFace(state, 3), 4);
});

test("switching to ones needs half the quantity rounded up", () => {
  const even = bid(game(3), 0, 4, 5);
  assert.equal(minimumQuantityForFace(even, 1), 2);
  assert.equal(bidError(even, 2, 1), null);
  assert.match(bidError(even, 1, 1), /Switching to ones.*at least 2/);
  const odd = bid(game(3), 0, 5, 3);
  assert.equal(minimumQuantityForFace(odd, 1), 3);
  assert.match(bidError(odd, 2, 1), /at least 3/);
  const single = bid(game(3), 0, 1, 6);
  assert.equal(minimumQuantityForFace(single, 1), 1);
});

test("switching from ones needs double plus one, and ones on ones need more", () => {
  const state = bid(bid(game(3), 0, 4, 5), 1, 2, 1);
  assert.equal(minimumQuantityForFace(state, 6), 5);
  assert.equal(minimumQuantityForFace(state, 2), 5);
  assert.equal(bidError(state, 5, 2), null);
  assert.match(bidError(state, 4, 6), /Switching from ones.*at least 5/);
  assert.equal(minimumQuantityForFace(state, 1), 3);
  assert.equal(bidError(state, 3, 1), null);
  assert.match(bidError(state, 2, 1), /at least 3/);
});

test("bids cannot exceed the dice on the table and malformed bids are refused", () => {
  const state = game(2);
  assert.match(bidError(state, 11, 4), /cannot exceed 10/);
  assert.equal(bidError(state, 10, 4), null);
  assert.match(bidError(state, 0, 4), /positive integer/);
  assert.match(bidError(state, 2.5, 4), /positive integer/);
  assert.match(bidError(state, 2, 7), /face/);
  assert.match(bidError(state, 2, "3"), /face/);
  const top = bid(state, 0, 10, 6);
  assert.equal(minimumQuantityForFace(top, 6), null);
  assert.equal(minimumQuantityForFace(top, 1), 5);
  const maxed = bid(bid(state, 0, 10, 2), 1, 5, 1);
  // From 5 ones, every other face needs 11 dice: only ones (6+) remain.
  assert.deepEqual(legalBidRanges(maxed, 0), [{ face: 1, minQuantity: 6, maxQuantity: 10 }]);
});

test("legal actions list every legal bid exactly once, and nothing off-turn", () => {
  const state = bid(game(3), 0, 3, 4);
  const actions = legalActions(state, 1);
  assert.deepEqual(actions.slice(0, 2), [{ type: "dudo" }, { type: "calza" }]);
  const bids = actions.filter((action) => action.type === "bid");
  const keys = new Set(bids.map((action) => `${action.quantity}x${action.face}`));
  assert.equal(keys.size, bids.length);
  for (let face = 1; face <= 6; face += 1) {
    for (let quantity = 1; quantity <= 15; quantity += 1) {
      assert.equal(keys.has(`${quantity}x${face}`), bidError(state, quantity, face) === null, `${quantity}x${face}`);
    }
  }
  assert.deepEqual(legalActions(state, 0), []);
  assert.deepEqual(legalActions(state, 2), []);
});

test("only the current seat may act, and unknown actions are refused", () => {
  const state = game(3);
  expectError(() => bid(state, 1, 2, 3), "not_your_turn");
  expectError(() => bid(state, 9, 2, 3), "bad_seat");
  expectError(() => applyAction(state, 0, { type: "fold" }), "unknown_action");
  expectError(() => applyAction(state, 0, null), "unknown_action");
});

test("turns go clockwise and skip players who are out", () => {
  let state = withDice(game(4), [[2, 2, 3, 4, 5], [], [1, 6, 6, 6, 6], [3, 3, 3, 3, 3]]);
  state.eliminationOrder = [1];
  state = bid(state, 0, 2, 3);
  assert.equal(state.currentSeat, 2);
  state = bid(state, 2, 3, 3);
  assert.equal(state.currentSeat, 3);
  state = bid(state, 3, 4, 3);
  assert.equal(state.currentSeat, 0);
  assert.equal(nextActiveSeat(state, 3), 0);
  assert.deepEqual(activeSeats(state), [0, 2, 3]);
});

test("applyAction never mutates its input", () => {
  const state = game(3);
  const snapshot = structuredClone(state);
  const next = bid(state, 0, 2, 3);
  applyAction(next, 1, { type: "dudo" }, { rng: constantRoll(2) });
  assert.deepEqual(state, snapshot);
  assert.notEqual(next, state);
});

// ---------------------------------------------------------------------------
// Dudo

test("counting treats ones as wild except for bids on ones or when told not to", () => {
  const dice = [1, 1, 3, 3, 5];
  assert.equal(countMatching(dice, 3), 4);
  assert.equal(countMatching(dice, 1), 2);
  assert.equal(countMatching(dice, 3, { onesWild: false }), 2);
  assert.equal(countMatching(dice, 6), 2);
});

test("dudo on a bid that holds (thanks to wild ones) costs the caller a die", () => {
  let state = withDice(game(3), [[1, 4, 4, 2, 2], [1, 3, 3, 3, 6], [5, 5, 5, 6, 6]]);
  state = bid(state, 0, 4, 4);
  state = applyAction(state, 1, { type: "dudo" }, { rng: constantRoll(2) });
  assert.equal(state.lastReveal.count, 4);
  assert.equal(state.lastReveal.outcome, "bid_holds");
  assert.equal(state.lastReveal.loserSeat, 1);
  assert.equal(state.lastReveal.onesWild, true);
  assert.deepEqual(state.lastReveal.dice[0], [1, 2, 2, 4, 4]);
  assert.deepEqual(state.seats.map((seat) => seat.dice.length), [5, 4, 5]);
  assert.equal(state.round, 2);
  assert.equal(state.currentSeat, 1, "the loser opens the next round");
  assert.equal(state.currentBid, null);
  assert.deepEqual(state.bids, []);
  assert.ok(state.seats.every((seat) => seat.dice.every((die) => die === 2)), "everyone re-rolls");
  assert.equal(state.seats[1].stats.dudoCalls, 1);
  assert.equal(state.seats[1].stats.dudoWins, 0);
  assert.equal(state.seats[1].stats.diceLost, 1);
});

test("dudo on a bid that fails costs the bidder a die, and the bidder opens next", () => {
  let state = withDice(game(3), [[1, 4, 4, 2, 2], [1, 3, 3, 3, 6], [5, 5, 5, 6, 6]]);
  state = bid(state, 0, 2, 3);
  state = bid(state, 1, 6, 4);
  state = applyAction(state, 2, { type: "dudo" }, { rng: constantRoll(3) });
  assert.equal(state.lastReveal.count, 4);
  assert.equal(state.lastReveal.outcome, "bid_fails");
  assert.equal(state.lastReveal.loserSeat, 1);
  assert.deepEqual(state.seats.map((seat) => seat.dice.length), [5, 4, 5]);
  assert.equal(state.currentSeat, 1);
  assert.equal(state.seats[2].stats.dudoWins, 1);
});

test("a bid on ones counts only ones", () => {
  let state = withDice(game(2), [[1, 1, 2, 2, 2], [1, 2, 2, 2, 2]]);
  state = bid(state, 0, 4, 2);
  state = bid(state, 1, 4, 1);
  state = applyAction(state, 0, { type: "dudo" }, { rng: constantRoll(5) });
  assert.equal(state.lastReveal.count, 3);
  assert.equal(state.lastReveal.loserSeat, 1);
});

test("a bid exactly met still holds against dudo", () => {
  let state = withDice(game(2), [[6, 6, 2, 3, 4], [6, 2, 2, 3, 4]]);
  state = bid(state, 0, 3, 6);
  state = applyAction(state, 1, { type: "dudo" }, { rng: constantRoll(1) });
  assert.equal(state.lastReveal.count, 3);
  assert.equal(state.lastReveal.loserSeat, 1);
});

// ---------------------------------------------------------------------------
// Calza

test("an exact calza wins the caller a die back", () => {
  let state = withDice(game(3), [[1, 4, 4, 2], [1, 3, 3, 3, 6], [5, 5, 5, 6, 6]]);
  state = bid(state, 0, 4, 3);
  state = bid(state, 1, 4, 4);
  state = applyAction(state, 2, { type: "calza" }, { rng: constantRoll(6) });
  assert.equal(state.lastReveal.type, "calza");
  assert.equal(state.lastReveal.count, 4);
  assert.equal(state.lastReveal.outcome, "exact");
  assert.equal(state.lastReveal.gainerSeat, 2);
  assert.equal(state.lastReveal.loserSeat, null);
  // Seat 2 already had five dice, so the gain is capped.
  assert.deepEqual(state.seats.map((seat) => seat.dice.length), [4, 5, 5]);
  assert.equal(state.events.some((event) => event.type === "die_gain_capped" && event.seat === 2), true);
  assert.equal(state.currentSeat, 2, "the calza caller opens the next round");
  assert.equal(state.seats[2].stats.calzaWins, 1);
});

test("an exact calza from a short-handed caller restores a die", () => {
  let state = withDice(game(3), [[1, 4, 4, 2, 2], [1, 3, 3], [5, 5, 5, 6, 6]]);
  state = bid(state, 0, 4, 4);
  state = applyAction(state, 1, { type: "calza" }, { rng: constantRoll(6) });
  assert.equal(state.lastReveal.outcome, "exact");
  assert.deepEqual(state.seats.map((seat) => seat.dice.length), [5, 4, 5]);
  assert.equal(state.seats[1].stats.diceGained, 1);
  assert.ok(state.seats[1].dice.every((die) => die === 6), "the regained die is rolled with the rest");
});

test("a wrong calza costs the caller a die, even if the bid was low", () => {
  let state = withDice(game(3), [[1, 4, 4, 2, 2], [1, 3, 3, 3, 6], [5, 5, 5, 6, 6]]);
  state = bid(state, 0, 3, 4);
  state = applyAction(state, 1, { type: "calza" }, { rng: constantRoll(6) });
  assert.equal(state.lastReveal.count, 4);
  assert.equal(state.lastReveal.outcome, "not_exact");
  assert.equal(state.lastReveal.loserSeat, 1);
  assert.deepEqual(state.seats.map((seat) => seat.dice.length), [5, 4, 5]);
  assert.equal(state.currentSeat, 1);
});

test("calza is unavailable heads-up or when the rule is off", () => {
  const headsUp = bid(game(2), 0, 2, 3);
  assert.equal(calzaAllowed(headsUp), false);
  assert.ok(!legalActions(headsUp, 1).some((action) => action.type === "calza"));
  expectError(() => applyAction(headsUp, 1, { type: "calza" }), "calza_heads_up");

  const off = bid(game(3, { rules: { calza: false } }), 0, 2, 3);
  assert.equal(calzaAllowed(off), false);
  assert.ok(!legalActions(off, 1).some((action) => action.type === "calza"));
  expectError(() => applyAction(off, 1, { type: "calza" }), "calza_disabled");

  let shrunk = withDice(game(3), [[2, 2, 2], [3, 3], []]);
  shrunk.eliminationOrder = [2];
  shrunk = bid(shrunk, 0, 2, 3);
  assert.equal(calzaAllowed(shrunk), false, "two live players left counts as heads-up");
});

// ---------------------------------------------------------------------------
// Elimination and game over

test("losing the last die knocks a player out and the next live seat opens", () => {
  let state = withDice(game(3), [[2, 2, 2, 2, 2], [6], [3, 3, 3, 3, 3]]);
  state.seats[1].palificoUsed = true;
  state = bid(state, 0, 5, 2);
  state = applyAction(state, 1, { type: "dudo" }, { rng: constantRoll(4) });
  assert.equal(state.lastReveal.loserSeat, 1);
  assert.deepEqual(state.seats.map((seat) => seat.dice.length), [5, 0, 5]);
  assert.deepEqual(state.eliminationOrder, [1]);
  assert.equal(state.currentSeat, 2);
  assert.equal(state.phase, "bidding");
  assert.deepEqual(legalActions(state, 1), []);
  state = bid(state, 2, 2, 4);
  assert.equal(state.currentSeat, 0, "seat 1 is skipped");
});

test("the last player with dice wins and the game stops", () => {
  let state = withDice(game(3), [[6], [], [5, 5]]);
  state.eliminationOrder = [1];
  state.seats[0].palificoUsed = true;
  state = bid(state, 0, 2, 6);
  state = applyAction(state, 2, { type: "dudo" }, { rng: constantRoll(1) });
  assert.equal(isGameOver(state), true);
  assert.equal(state.phase, "complete");
  assert.equal(state.winnerSeat, 2);
  assert.equal(state.currentSeat, null);
  assert.deepEqual(state.result.placements, [
    { seat: 2, place: 1, diceLeft: 2 },
    { seat: 0, place: 2, diceLeft: 0 },
    { seat: 1, place: 3, diceLeft: 0 },
  ]);
  assert.equal(state.events.at(-1).type, "game_over");
  assert.deepEqual(legalActions(state, 2), []);
  expectError(() => bid(state, 2, 1, 2), "game_over");
});

// ---------------------------------------------------------------------------
// Palifico

test("dropping to one die starts a palifico round: ones not wild, face locked", () => {
  let state = withDice(game(3), [[1, 1, 4, 4, 4], [2, 2], [3, 3, 3, 3, 3]]);
  state = bid(state, 0, 3, 2);
  state = applyAction(state, 1, { type: "dudo" }, { rng: constantRoll(1) });
  assert.equal(state.lastReveal.loserSeat, 1);
  assert.equal(state.seats[1].dice.length, 1);
  assert.equal(state.palifico, true);
  assert.equal(state.palificoSeat, 1);
  assert.equal(state.seats[1].palificoUsed, true);
  assert.equal(state.currentSeat, 1);

  // The palifico opener may bid on ones; later bids keep the face.
  assert.equal(bidError(state, 1, 1), null);
  state = bid(state, 1, 2, 5);
  assert.match(bidError(state, 3, 6), /stay on 5s/);
  assert.match(bidError(state, 2, 5), /raise the quantity/);
  assert.match(bidError(state, 1, 1), /stay on 5s/);
  assert.deepEqual(legalBidRanges(state, 2), [{ face: 5, minQuantity: 3, maxQuantity: 11 }]);

  // Ones do not count: three 5s claimed, only zero 5s (all dice are 1s).
  state = withDice(state, [[1, 1, 1, 1, 1], [5], [1, 1, 1, 1, 1]]);
  state = bid(state, 2, 3, 5);
  state = applyAction(state, 0, { type: "dudo" }, { rng: constantRoll(4) });
  assert.equal(state.lastReveal.onesWild, false);
  assert.equal(state.lastReveal.palifico, true);
  assert.equal(state.lastReveal.count, 1);
  assert.equal(state.lastReveal.loserSeat, 2);
  assert.equal(state.palifico, false, "the next round is normal again");
});

test("palifico happens once per player and never heads-up or when switched off", () => {
  let state = withDice(game(3), [[4, 4], [2, 2], [3, 3, 3, 3, 3]]);
  state.seats[0].palificoUsed = true;
  state = bid(state, 0, 5, 4);
  state = applyAction(state, 1, { type: "dudo" }, { rng: constantRoll(2) });
  assert.equal(state.lastReveal.loserSeat, 0);
  assert.equal(state.seats[0].dice.length, 1);
  assert.equal(state.palifico, false, "seat 0 already had its palifico");

  let headsUp = withDice(game(2), [[4, 4], [3, 3, 3]]);
  headsUp = bid(headsUp, 0, 4, 4);
  headsUp = applyAction(headsUp, 1, { type: "dudo" }, { rng: constantRoll(2) });
  assert.equal(headsUp.seats[0].dice.length, 1);
  assert.equal(headsUp.palifico, false);
  assert.equal(headsUp.seats[0].palificoUsed, false);

  let off = withDice(game(3, { rules: { palifico: false } }), [[4, 4], [3, 3, 3], [2, 2]]);
  off = bid(off, 0, 6, 4);
  off = applyAction(off, 1, { type: "dudo" }, { rng: constantRoll(2) });
  assert.equal(off.seats[0].dice.length, 1);
  assert.equal(off.palifico, false);
});

// ---------------------------------------------------------------------------
// Views

test("a seat's view shows its own dice only and never the RNG state", () => {
  const state = game(4);
  const view = viewForSeat(state, 2);
  assert.deepEqual(view.seats[2].dice, state.seats[2].dice);
  for (const seat of [0, 1, 3]) assert.equal(view.seats[seat].dice, null);
  assert.equal(view.seats[0].diceCount, 5);
  assert.equal("rngState" in view, false);
  assert.equal(view.onesWild, true);
  const spectator = publicView(state);
  assert.ok(spectator.seats.every((seat) => seat.dice === null));
  const arena = publicView(state, { revealAll: true });
  assert.ok(arena.seats.every((seat) => seat.dice.length === 5));
});

test("the previous round's reveal is public to every seat", () => {
  let state = bid(game(3), 0, 2, 3);
  const revealed = structuredClone(state.seats.map((seat) => seat.dice));
  state = applyAction(state, 1, { type: "dudo" }, { rng: constantRoll(5) });
  const view = viewForSeat(state, 0);
  assert.deepEqual(view.lastReveal.dice, revealed);
  assert.equal(view.seats[1].dice, null);
});

// ---------------------------------------------------------------------------
// Save and resume

test("a saved game resumes exactly, including seeded rolls", () => {
  let original = createLiarsDiceGame({ seatCount: 4, seed: 2026 });
  original = bid(original, original.currentSeat, 3, 4);
  const saved = JSON.stringify(original);
  const restored = restoreLiarsDiceState(saved);
  assert.deepEqual(restored, original);
  const left = applyAction(original, original.currentSeat, { type: "dudo" });
  const right = applyAction(restored, restored.currentSeat, { type: "dudo" });
  assert.deepEqual(left, right);
});

test("restoring rejects corrupted saves", () => {
  const good = bid(game(3), 0, 2, 3);
  expectError(() => restoreLiarsDiceState("{not json"), "bad_save");
  expectError(() => restoreLiarsDiceState({ ...good, game: "poker" }), "bad_save");
  expectError(() => restoreLiarsDiceState({ ...good, version: 99 }), "bad_save");
  const badDie = structuredClone(good);
  badDie.seats[0].dice[0] = 7;
  expectError(() => restoreLiarsDiceState(badDie), "bad_save");
  const tooMany = structuredClone(good);
  tooMany.seats[0].dice.push(3);
  expectError(() => restoreLiarsDiceState(tooMany), "bad_save");
  const deadTurn = structuredClone(good);
  deadTurn.seats[1].dice = [];
  deadTurn.eliminationOrder = [1];
  expectError(() => restoreLiarsDiceState(deadTurn), "bad_save");
  const ghost = structuredClone(good);
  ghost.seats[2].dice = [];
  expectError(() => restoreLiarsDiceState(ghost), "bad_save");
  const badRules = structuredClone(good);
  badRules.rules.calza = "yes";
  expectError(() => restoreLiarsDiceState(badRules), "bad_save");
  expectError(() => restoreLiarsDiceState({ ...good, rules: { ...good.rules, startingDice: 0 } }), "bad_save");
  expectError(() => restoreLiarsDiceState({ ...good, rules: undefined }), "bad_save");
  expectError(() => restoreLiarsDiceState(null), "bad_save");
});

// ---------------------------------------------------------------------------
// Whole games

test("random legal playouts always finish with one winner and consistent state", () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const seatCount = 2 + (seed % 5);
    let state = createLiarsDiceGame({ seatCount, seed });
    let pick = seed * 7919;
    let steps = 0;
    while (!isGameOver(state)) {
      const actor = state.currentSeat;
      const actions = legalActions(state, actor);
      assert.ok(actions.length > 0, "the acting seat always has a legal action");
      for (let seat = 0; seat < seatCount; seat += 1) {
        if (seat !== actor) assert.deepEqual(legalActions(state, seat), []);
      }
      // Bias toward challenging once bids get high so games end quickly.
      pick = (pick * 1103515245 + 12345) % 2147483648;
      const challenges = actions.filter((action) => action.type !== "bid");
      const highBid = state.currentBid && state.currentBid.quantity >= totalDice(state) / 3;
      const pool = highBid && challenges.length ? challenges : actions.slice(0, Math.min(actions.length, 12));
      const before = totalDice(state);
      state = applyAction(state, actor, pool[pick % pool.length]);
      assert.ok(Math.abs(totalDice(state) - before) <= 1);
      assert.deepEqual(restoreLiarsDiceState(JSON.stringify(state)), state);
      steps += 1;
      assert.ok(steps < 5000, "game must terminate");
    }
    assert.equal(activeSeats(state).length, 1);
    assert.equal(state.result.placements.length, seatCount);
    assert.deepEqual(new Set(state.result.placements.map((entry) => entry.seat)).size, seatCount);
    assert.equal(state.result.placements[0].seat, state.winnerSeat);
  }
});
