import assert from "node:assert/strict";
import test from "node:test";
import { AIDecisionError } from "../src/platform/openai-gateway.js";
import { requestGoDecisionWithRetry } from "../src/games/go-ai.js";

function snapshot() {
  return {
    legalPlacements: [[0, 0, "A9"]],
  };
}

test("automatically retries an illegal Go decision with corrective context", async () => {
  const snapshots = [];
  const retries = [];
  let calls = 0;
  const requestDecision = async (currentSnapshot) => {
    snapshots.push(currentSnapshot);
    calls += 1;
    if (calls === 1) {
      const error = new AIDecisionError("The model selected an illegal Go intersection", "illegal_move");
      error.rejectedDecision = { action: "place", row: 9, column: 9 };
      throw error;
    }
    return { action: "place", row: 0, column: 0 };
  };

  const result = await requestGoDecisionWithRetry({
    snapshotFactory: snapshot,
    modelConfig: {},
    requestDecision,
    onRetry: (retry) => retries.push(retry),
  });

  assert.equal(result.attempts, 2);
  assert.equal(result.decision.row, 0);
  assert.equal(retries.length, 1);
  assert.equal(snapshots[0].retryContext, undefined);
  assert.deepEqual(snapshots[1].retryContext.rejectedDecision, { action: "place", row: 9, column: 9 });
  assert.equal(snapshots[1].retryContext.retryNumber, 1);
  assert.equal(snapshots[1].retryContext.maxRetries, 2);
});

test("pauses after the automatic Go retry limit is exhausted", async () => {
  let calls = 0;
  const requestDecision = async () => {
    calls += 1;
    throw new AIDecisionError("The model selected an illegal Go intersection", "illegal_move");
  };

  await assert.rejects(
    requestGoDecisionWithRetry({ snapshotFactory: snapshot, modelConfig: {}, requestDecision }),
    /illegal Go intersection/,
  );
  assert.equal(calls, 3);
});

test("does not retry OpenAI connection errors", async () => {
  let calls = 0;
  const requestDecision = async () => {
    calls += 1;
    throw new AIDecisionError("Could not reach OpenAI", "connection_error");
  };

  await assert.rejects(
    requestGoDecisionWithRetry({ snapshotFactory: snapshot, modelConfig: {}, requestDecision }),
    /Could not reach OpenAI/,
  );
  assert.equal(calls, 1);
});
