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

test("starts an all-Luna arena and reveals every card to the spectator", () => {
  const game = new PokerGame({ gameMode: "arena", opponentCount: 3, arenaHandTarget: 10 });
  const state = game.publicState();
  assert.equal(state.gameMode, "arena");
  assert.equal(state.players.length, 3);
  assert.ok(state.players.every((player) => !player.isHuman));
  assert.ok(state.players.every((player) => player.holeCards.length === 2 && !player.holeCards.includes("BACK")));
  assert.equal(state.legalActions, null);
  assert.deepEqual(state.arena, { paused: false, finished: false, handTarget: 10, handsPlayed: 0 });
  assert.equal(game.currentActor.isHuman, false);
});

test("pauses an arena when its completed-hand target is reached", () => {
  const game = new PokerGame({ gameMode: "arena", opponentCount: 2, arenaHandTarget: 1 });
  let safety = 0;
  while (["preflop", "flop", "turn", "river"].includes(game.phase) && safety < 30) {
    const actor = game.currentActor;
    const legal = game.legalActionsFor(actor);
    game.applyAction(actor.seat, legal.toCall > 0 ? "call" : "check");
    safety += 1;
  }
  const state = game.publicState();
  assert.equal(state.phase, "hand_over");
  assert.equal(state.arena.handsPlayed, 1);
  assert.equal(state.arena.finished, true);
  assert.equal(state.arena.paused, true);
  assert.throws(() => game.resumeArena(), /session is complete/i);
});

test("supports pausing and resuming an active arena", () => {
  const game = new PokerGame({ gameMode: "arena", opponentCount: 2, arenaHandTarget: 5 });
  game.pauseArena();
  assert.equal(game.publicState().arena.paused, true);
  game.resumeArena();
  assert.equal(game.publicState().arena.paused, false);
});

test("keeps a persistent transcript of completed AI summaries", () => {
  const game = new PokerGame({ gameMode: "arena", opponentCount: 2, arenaPaused: true });
  game.recordAIInsight(0, {
    summary: "Pressure the capped blind with a compact raise.",
    summarySource: "openai_reasoning_summary",
    explanation: "Position and stack depth favor initiative.",
    latencyMs: 2_450,
    action: "raise",
  });
  game.recordAIInsight(1, {
    summary: "The price supports a disciplined call.",
    summarySource: "public_decision_rationale",
    explanation: "The pot odds are sufficient.",
    latencyMs: 1_820,
    action: "call",
  });
  const state = game.publicState();
  assert.equal(state.aiInsights.length, 2);
  assert.equal(state.aiInsights[0].playerName, game.players[1].name);
  assert.equal(state.aiInsights[0].summary, "The price supports a disciplined call.");
  assert.equal(state.aiInsights[1].summary, "Pressure the capped blind with a compact raise.");
});
