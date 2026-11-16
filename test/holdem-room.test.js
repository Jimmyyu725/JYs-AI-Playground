import assert from "node:assert/strict";
import test from "node:test";
import { AIDecisionError } from "../src/platform/ai-decision-error.js";
import { decideWithRetries } from "../src/games/holdem/ai-retry.js";
import { PokerGame } from "../src/poker-game.js";

test("an illegal answer is retried with the rejection fed back, then applied", async () => {
  const inputs = [];
  const answers = [
    () => {
      throw new AIDecisionError("The model selected illegal action “check”", "illegal_action");
    },
    () => ({ action: "call", targetTotal: null }),
  ];
  const applied = [];
  const retries = [];
  const result = await decideWithRetries({
    snapshot: { legal: { actions: ["fold", "call"] } },
    request: async (input) => {
      inputs.push(input);
      return answers[inputs.length - 1]();
    },
    apply: (decision) => applied.push(decision),
    onRetry: (info) => retries.push(info.attempt),
  });
  assert.equal(result.attempts, 2);
  assert.deepEqual(applied, [{ action: "call", targetTotal: null }]);
  assert.equal(inputs[0].previousAttemptRejected, undefined);
  assert.match(inputs[1].previousAttemptRejected.error, /illegal action/);
  assert.deepEqual(retries, [1]);
});

test("an engine rejection counts as an illegal move and is retried", async () => {
  let calls = 0;
  const result = await decideWithRetries({
    snapshot: {},
    request: async () => ({ attempt: ++calls }),
    apply: (decision) => {
      if (decision.attempt < 3) throw new Error("Target total must be between 40 and 1000");
    },
  });
  assert.equal(result.attempts, 3);
});

test("after two retries the room pauses with the last rejection", async () => {
  let calls = 0;
  await assert.rejects(
    decideWithRetries({
      snapshot: {},
      request: async () => {
        calls += 1;
        throw new AIDecisionError("The model sized outside the legal range 40–1000", "invalid_sizing");
      },
      apply: () => {},
    }),
    (error) => error instanceof AIDecisionError && error.code === "invalid_sizing" && /rejected 3 times/.test(error.message),
  );
  assert.equal(calls, 3);
});

test("provider failures are not retried silently", async () => {
  let calls = 0;
  await assert.rejects(
    decideWithRetries({
      snapshot: {},
      request: async () => {
        calls += 1;
        throw new AIDecisionError("Missing OPENAI_API_KEY", "missing_api_key");
      },
      apply: () => {},
    }),
    /Missing OPENAI_API_KEY/,
  );
  assert.equal(calls, 1);
});

test("new tables seat a random distinct cast and honour pinned characters", () => {
  const casts = new Set();
  for (let index = 0; index < 6; index += 1) {
    const table = new PokerGame({ opponentCount: 4, aiPlayers: [{ characterId: "meiling" }] });
    const ids = table.players.filter((player) => !player.isHuman).map((player) => player.character.id);
    assert.equal(new Set(ids).size, 4);
    assert.equal(ids[0], "meiling");
    casts.add(ids.join(","));
  }
  assert.ok(casts.size > 1, "casts should vary between tables");
});

test("a hand review sees the public record, shown hands and its own cards only", async () => {
  const { reviewInput } = await import("../src/games/holdem/review.js");
  const table = new PokerGame({ opponentCount: 3 });
  const reviewer = table.players[1];
  const input = reviewInput(table, reviewer);
  assert.deepEqual(input.reviewer.ownHoleCards, reviewer.holeCards);
  for (const player of input.players) assert.equal(player.shownCards, null, "no cards are shown before a showdown");
  assert.ok(input.log.every((line) => typeof line === "string"));
});

test("an all-in for less than a full raise does not reopen the betting to players who already acted", () => {
  const table = new PokerGame({ opponentCount: 2, smallBlind: 10, bigBlind: 20 });
  // Hand 1: the human (seat 0) has the button, seat 1 posts the small blind, seat 2 the big blind.
  assert.equal(table.currentActorSeat, 0);
  table.players[2].stack = 15;
  table.applyAction(0, "call");
  table.applyAction(1, "call");
  table.applyAction(2, "all_in"); // to 35: a raise of 15, short of the 20 minimum
  assert.equal(table.currentActorSeat, 0);
  const legal = table.legalActionsFor();
  assert.deepEqual(legal.actions, ["fold", "call"]);
  assert.equal(legal.aggressiveAction, null);
  assert.throws(() => table.applyAction(0, "raise", 80), /not legal/);
  assert.throws(() => table.applyAction(0, "all_in"), /not legal/);
});

test("a full raise reopens the betting to players who already acted", () => {
  const table = new PokerGame({ opponentCount: 2, smallBlind: 10, bigBlind: 20 });
  table.applyAction(0, "call");
  table.applyAction(1, "call");
  table.applyAction(2, "raise", 60);
  const legal = table.legalActionsFor();
  assert.equal(legal.aggressiveAction, "raise");
  assert.equal(legal.minimumTotal, 100);
  assert.ok(legal.actions.includes("all_in"));
});

test("dead money from folded players stays in one pot, and an uncalled excess goes back", async () => {
  const { resolveSidePots } = await import("../src/hand-evaluator.js");
  const players = [
    { seat: 0, totalCommitted: 390, inHand: true, folded: false, holeCards: ["3H", "3C"] },
    { seat: 1, totalCommitted: 10, inHand: true, folded: true, holeCards: ["KD", "6D"] },
    { seat: 2, totalCommitted: 20, inHand: true, folded: true, holeCards: ["KC", "5S"] },
    { seat: 3, totalCommitted: 500, inHand: true, folded: false, holeCards: ["AH", "JH"] },
  ];
  const result = resolveSidePots(players, ["QH", "AS", "8H", "8D", "9S"], 0);
  assert.equal(result.pots.length, 1);
  assert.deepEqual(result.pots[0], { amount: 810, winners: [3], description: "Two pair" });
  assert.equal(result.payouts[3], 810 + 110);
  assert.equal(Object.values(result.payouts).reduce((sum, value) => sum + value, 0), 920);
});
