import assert from "node:assert/strict";
import test from "node:test";
import { resolveSidePots } from "../src/hand-evaluator.js";
import { PokerGame } from "../src/poker-game.js";

// Deterministic generator so a failure is always reproducible from the seed.
function makeRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const BOARD = ["2C", "3D", "4H", "8S", "9C"];
const BETTING_PHASES = new Set(["preflop", "flop", "turn", "river"]);

test("returns an uncalled layer instead of destroying the chips", () => {
  // Seat 2 committed the most and folded, so seat 2's top 50 was never called.
  const players = [
    { seat: 0, totalCommitted: 100, inHand: true, folded: false, holeCards: ["AS", "AD"] },
    { seat: 1, totalCommitted: 0, inHand: true, folded: false, holeCards: ["7S", "2D"] },
    { seat: 2, totalCommitted: 150, inHand: true, folded: true, holeCards: ["KS", "KD"] },
  ];
  const result = resolveSidePots(players, BOARD, 0);
  assert.deepEqual(result.payouts, { 0: 200, 1: 0, 2: 50 });
});

test("returns every layer when no live player contested the pot at all", () => {
  const players = [
    { seat: 0, totalCommitted: 200, inHand: true, folded: true, holeCards: ["AS", "AD"] },
    { seat: 1, totalCommitted: 0, inHand: true, folded: false, holeCards: ["7S", "2D"] },
  ];
  const result = resolveSidePots(players, BOARD, 0);
  assert.deepEqual(result.payouts, { 0: 200, 1: 0 });
});

test("conserves chips across randomized side-pot layouts", () => {
  const random = makeRandom(20260801);
  const ranks = "23456789TJQKA";
  const suits = "CDHS";

  for (let trial = 0; trial < 3_000; trial += 1) {
    const deck = [];
    for (const rank of ranks) for (const suit of suits) deck.push(`${rank}${suit}`);
    for (let index = deck.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [deck[index], deck[other]] = [deck[other], deck[index]];
    }

    const communityCards = deck.splice(0, 5);
    const seatCount = 2 + Math.floor(random() * 4);
    const players = [];
    for (let seat = 0; seat < seatCount; seat += 1) {
      players.push({
        seat,
        totalCommitted: Math.floor(random() * 5) * 50,
        inHand: true,
        folded: random() < 0.35,
        holeCards: deck.splice(0, 2),
      });
    }

    const committed = players.reduce((total, player) => total + player.totalCommitted, 0);
    const result = resolveSidePots(players, communityCards, Math.floor(random() * seatCount));
    const paid = Object.values(result.payouts).reduce((total, value) => total + value, 0);
    assert.equal(paid, committed, `trial ${trial} lost chips: ${JSON.stringify(players.map((p) => [p.totalCommitted, p.folded]))}`);
    assert.ok(Object.values(result.payouts).every((value) => value >= 0), `trial ${trial} paid a negative amount`);
  }
});

test("conserves chips and terminates across randomized full tables", () => {
  const random = makeRandom(777);
  const pick = (list) => list[Math.floor(random() * list.length)];

  for (let trial = 0; trial < 120; trial += 1) {
    const opponentCount = 2 + Math.floor(random() * 4);
    const startingStack = pick([200, 300, 1_000, 2_500]);
    const bigBlind = pick([20, 50, 200]);
    const game = new PokerGame({
      gameMode: "arena",
      opponentCount,
      arenaPaused: true,
      startingStack,
      smallBlind: Math.floor(bigBlind / 2),
      bigBlind,
    });
    const bank = game.players.length * startingStack;

    for (let hand = 0; hand < 5; hand += 1) {
      let guard = 0;
      while (BETTING_PHASES.has(game.phase) && guard < 400) {
        guard += 1;
        const actor = game.currentActor;
        assert.ok(actor, `trial ${trial}: a betting phase had no actor`);
        const legal = game.legalActionsFor(actor);
        assert.ok(legal, `trial ${trial}: the acting seat had no legal actions`);

        const action = pick(legal.actions);
        let targetTotal = null;
        if (action === "bet" || action === "raise") {
          const span = legal.maximumTotal - legal.minimumTotal;
          targetTotal = legal.minimumTotal + Math.floor(random() * (span + 1));
        }
        game.applyAction(actor.seat, action, targetTotal);

        const held = game.players.reduce((total, player) => total + player.stack + player.totalCommitted, 0);
        assert.equal(held, bank, `trial ${trial}: chips changed mid-hand`);
        assert.ok(game.players.every((player) => player.stack >= 0), `trial ${trial}: a stack went negative`);
      }
      assert.ok(guard < 400, `trial ${trial}: the hand never terminated`);
      assert.equal(game.players.reduce((total, player) => total + player.stack, 0), bank, `trial ${trial}: chips changed at showdown`);

      if (game.phase === "game_over") break;
      assert.equal(game.phase, "hand_over", `trial ${trial}: unexpected terminal phase`);
      game.startNewHand();
    }
  }
});
