import test from "node:test";
import assert from "node:assert/strict";
import { AIDecisionError } from "../src/platform/openai-gateway.js";
import { requestDoudizhuPlayWithRetry, validatePlayDecision } from "../src/games/doudizhu-ai.js";

function snapshotFor(hand, { leading = false, mustBeat = null } = {}) {
  return {
    game: "Dou Dizhu",
    phase: "playing",
    handNumber: 1,
    actor: { seat: 1, name: "Rook Mercer", title: "The Enforcer", personality: "Direct.", hand, isLandlord: false },
    table: { landlordSeat: 0, currentBid: 1, highestBidderSeat: 0, bottomCards: [], players: [] },
    play: { leading, lastPlay: null, mustBeat },
    rules: { rankOrder: "", cardCodes: "", combos: "", following: "" },
    recentPlays: [],
  };
}

test("accepts a legal play that beats the last play", () => {
  const snapshot = snapshotFor(["9C", "9D", "3C", "4C"], {
    mustBeat: { comboType: "pair", mainRank: 8, length: 1, description: "Pair 8C 8D" },
  });
  const result = validatePlayDecision({ action: "play", cards: ["9C", "9D"] }, snapshot);
  assert.deepEqual(result, { action: "play", cards: ["9C", "9D"] });
});

test("accepts any legal combo when leading", () => {
  const snapshot = snapshotFor(["3C", "4C", "5C", "6C", "7C", "9C", "9D"], { leading: true });
  const result = validatePlayDecision({ action: "play", cards: ["3C", "4C", "5C", "6C", "7C"] }, snapshot);
  assert.equal(result.action, "play");
});

test("accepts a legal pass while following", () => {
  const snapshot = snapshotFor(["3C"], { leading: false });
  assert.deepEqual(validatePlayDecision({ action: "pass", cards: null }, snapshot), { action: "pass", cards: null });
});

test("rejects a malformed combo as a retryable illegal play", () => {
  const snapshot = snapshotFor(["3C", "4C", "9C", "9D"], { leading: true });
  assert.throws(
    () => validatePlayDecision({ action: "play", cards: ["3C", "4C"] }, snapshot),
    (error) => error instanceof AIDecisionError && error.code === "illegal_play" && /not a legal/.test(error.message),
  );
});

test("rejects a combo that cannot beat the last play", () => {
  const snapshot = snapshotFor(["3C", "3D", "9C", "9D"], {
    mustBeat: { comboType: "pair", mainRank: 8, length: 1, description: "Pair 8C 8D" },
  });
  assert.throws(
    () => validatePlayDecision({ action: "play", cards: ["3C", "3D"] }, snapshot),
    (error) => error instanceof AIDecisionError && error.code === "illegal_play" && /cannot beat/.test(error.message),
  );
});

test("rejects cards outside the hand and unknown codes", () => {
  const snapshot = snapshotFor(["3C", "4C"], { leading: true });
  assert.throws(() => validatePlayDecision({ action: "play", cards: ["9D"] }, snapshot), /not in its hand/);
  assert.throws(() => validatePlayDecision({ action: "play", cards: ["XX"] }, snapshot), /unknown card code/);
});

test("rejects passing while leading", () => {
  const snapshot = snapshotFor(["3C", "4C"], { leading: true });
  assert.throws(
    () => validatePlayDecision({ action: "pass", cards: null }, snapshot),
    (error) => error instanceof AIDecisionError && error.code === "illegal_play" && /leading/i.test(error.message),
  );
});

test("retries a rejected play and accepts the corrected decision", async () => {
  const snapshot = snapshotFor(["9C", "9D", "3C", "4C"], {
    mustBeat: { comboType: "pair", mainRank: 8, length: 1, description: "Pair 8C 8D" },
  });
  const retries = [];
  let calls = 0;
  const { decision, attempts } = await requestDoudizhuPlayWithRetry({
    snapshotFactory: () => snapshot,
    modelConfig: { model: "gpt-5.6-luna", reasoningEffort: "none" },
    onRetry: ({ retryNumber }) => retries.push(retryNumber),
    requestDecision: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new AIDecisionError("That combination is not a legal Dou Dizhu play", "illegal_play");
        error.rejectedDecision = { action: "play", cards: ["3C", "4C"] };
        throw error;
      }
      return { action: "play", cards: ["9C", "9D"], explanation: "Higher pair.", reasoningSummary: "", responseId: null };
    },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(retries, [1]);
  assert.deepEqual(decision.cards, ["9C", "9D"]);
});

test("does not retry non-retryable errors", async () => {
  const snapshot = snapshotFor(["3C", "4C"], { leading: false });
  let calls = 0;
  await assert.rejects(
    () => requestDoudizhuPlayWithRetry({
      snapshotFactory: () => snapshot,
      modelConfig: { model: "gpt-5.6-luna", reasoningEffort: "none" },
      requestDecision: async () => {
        calls += 1;
        throw new AIDecisionError("connection failed", "connection_error");
      },
    }),
    /connection failed/,
  );
  assert.equal(calls, 1);
});
