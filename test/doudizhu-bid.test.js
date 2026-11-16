import assert from "node:assert/strict";
import test from "node:test";
import { AIDecisionError } from "../src/platform/decision-gateway.js";
import { requestDoudizhuBidWithRetry, validateBidDecision } from "../src/games/doudizhu-ai.js";
import { DouDizhuGame } from "../src/games/doudizhu-game.js";

const snapshotWithBid = (currentBid) => ({ table: { currentBid }, actor: { hand: [] } });

test("bid validation accepts a pass and a higher bid", () => {
  assert.doesNotThrow(() => validateBidDecision({ action: "pass", score: null }, snapshotWithBid(1)));
  assert.doesNotThrow(() => validateBidDecision({ action: "bid", score: 2 }, snapshotWithBid(1)));
});

test("bid validation rejects a bid that does not beat the current one, out-of-range scores, and scored passes", () => {
  const isInvalidBid = (error) => error instanceof AIDecisionError && error.code === "invalid_bid" && Boolean(error.rejectedDecision);
  assert.throws(() => validateBidDecision({ action: "bid", score: 2 }, snapshotWithBid(2)), isInvalidBid);
  assert.throws(() => validateBidDecision({ action: "bid", score: 4 }, snapshotWithBid(0)), isInvalidBid);
  assert.throws(() => validateBidDecision({ action: "bid", score: null }, snapshotWithBid(0)), isInvalidBid);
  assert.throws(() => validateBidDecision({ action: "pass", score: 1 }, snapshotWithBid(0)), isInvalidBid);
});

test("an invalid bid is retried with the error fed back, then accepted", async () => {
  const seenRetryContexts = [];
  let calls = 0;
  const { decision, attempts } = await requestDoudizhuBidWithRetry({
    snapshotFactory: () => snapshotWithBid(2),
    modelConfig: { model: "gpt-6-luna", reasoningEffort: "none" },
    requestDecision: async (snapshot) => {
      calls += 1;
      seenRetryContexts.push(snapshot.retryContext ?? null);
      if (calls === 1) {
        const error = new AIDecisionError("The model bid 2, which does not beat 2", "invalid_bid");
        error.rejectedDecision = { action: "bid", score: 2 };
        throw error;
      }
      return { action: "bid", score: 3, explanation: "Strong hand." };
    },
  });
  assert.equal(attempts, 2);
  assert.equal(decision.score, 3);
  assert.equal(seenRetryContexts[0], null);
  assert.match(seenRetryContexts[1].previousError, /does not beat/);
  assert.deepEqual(seenRetryContexts[1].rejectedDecision, { action: "bid", score: 2 });
});

test("a bid that stays invalid pauses after two automatic retries", async () => {
  let calls = 0;
  await assert.rejects(
    () => requestDoudizhuBidWithRetry({
      snapshotFactory: () => snapshotWithBid(3),
      modelConfig: { model: "gpt-6-luna", reasoningEffort: "none" },
      requestDecision: async () => {
        calls += 1;
        throw new AIDecisionError("The model returned an invalid bid score", "invalid_bid");
      },
    }),
    /invalid bid score/,
  );
  assert.equal(calls, 3);
});

test("the bottom three stay hidden from the public state and the AI snapshot until a landlord takes them", () => {
  const game = new DouDizhuGame({ gameMode: "arena" });
  assert.deepEqual(game.publicState().bottomCards, []);
  assert.equal(game.publicState().bottomRevealed, false);
  assert.deepEqual(game.aiSnapshot().table.bottomCards, []);
  const bottom = [...game.bottomCards];
  game.applyBid(game.currentActorSeat, 3);
  assert.equal(game.publicState().bottomRevealed, true);
  assert.deepEqual(game.publicState().bottomCards, bottom);
  assert.deepEqual(game.aiSnapshot().table.bottomCards, bottom);
});
