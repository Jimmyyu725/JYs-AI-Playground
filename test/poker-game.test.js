import test from "node:test";
import assert from "node:assert/strict";
import { PokerGame } from "../src/poker-game.js";

test("starts a three-handed hand with blinds and a human decision", () => {
  const game = new PokerGame({ opponentCount: 2, startingStack: 1000, smallBlind: 10, bigBlind: 20 });
  const state = game.publicState();
  assert.equal(state.players.length, 3);
  assert.equal(state.handNumber, 1);
  assert.equal(state.phase, "preflop");
  assert.equal(state.pot, 30);
  assert.equal(state.currentActorSeat, 0);
  assert.ok(state.legalActions.actions.includes("call"));
  assert.ok(state.legalActions.actions.includes("raise"));
  assert.equal(state.players[0].holeCards.length, 2);
  assert.deepEqual(state.players[1].holeCards, ["BACK", "BACK"]);
});

test("moves action clockwise after the human calls", () => {
  const game = new PokerGame({ opponentCount: 2 });
  game.applyAction(0, "call");
  assert.equal(game.currentActorSeat, 1);
  assert.equal(game.players[0].streetBet, 20);
  assert.equal(game.potTotal, 50);
});

test("never advertises a local policy fallback", () => {
  const game = new PokerGame({ opponentCount: 3 });
  const state = game.publicState();
  assert.equal(state.model, "gpt-5.6-luna");
  assert.equal(state.reasoningEffort, "medium");
  assert.equal(state.noLocalFallback, true);
});

test("completes a checked-down hand and conserves every chip", () => {
  const game = new PokerGame({ opponentCount: 2, startingStack: 1_000, smallBlind: 10, bigBlind: 20 });
  let safety = 0;
  while (["preflop", "flop", "turn", "river"].includes(game.phase) && safety < 30) {
    const actor = game.currentActor;
    const legal = game.legalActionsFor(actor);
    game.applyAction(actor.seat, legal.toCall > 0 ? "call" : "check");
    safety += 1;
  }
  assert.equal(game.phase, "hand_over");
  assert.ok(game.lastShowdown.pots.length >= 1);
  assert.equal(game.players.reduce((total, player) => total + player.stack, 0), 3_000);
  assert.ok(safety < 30);
});

