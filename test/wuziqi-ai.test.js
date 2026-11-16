import assert from "node:assert/strict";
import test from "node:test";
import { AIDecisionError } from "../src/platform/ai-decision-error.js";
import { requestWuziqiDecision, requestWuziqiDecisionWithRetry, requestWuziqiReview } from "../src/games/wuziqi-ai.js";
import { WuziqiGame } from "../src/games/wuziqi-game.js";

const config = { model: "gpt-6-luna", reasoningEffort: "high" };

function arena() {
  return new WuziqiGame({ gameMode: "arena", arenaPaused: true, aiPlayers: [config, config] });
}

function fakeGateway(outputs, seen = []) {
  return async (request) => {
    seen.push(request);
    const output = outputs.shift();
    return { output, reasoningSummary: "", reasoningSource: "public_decision_rationale", responseId: "r1", tableTalk: "Ink dries fast." };
  };
}

test("a legal decision passes through with table talk", async () => {
  const game = arena();
  const seen = [];
  const decision = await requestWuziqiDecision(game.aiSnapshot(), config, {}, fakeGateway([{ action: "place", row: 7, column: 7, explanation: "Center." }], seen));
  assert.equal(decision.row, 7);
  assert.equal(decision.tableTalk, "Ink dries fast.");
  assert.deepEqual(seen[0].tableTalk, { voice: game.currentPlayer.character.voice });
});

test("an occupied intersection is rejected as a retryable illegal move", async () => {
  const game = arena();
  game.applyAction("black", "place", 7, 7);
  await assert.rejects(
    requestWuziqiDecision(game.aiSnapshot(), config, {}, fakeGateway([{ action: "place", row: 7, column: 7, explanation: "Here." }])),
    (error) => error instanceof AIDecisionError && error.code === "illegal_move" && error.rejectedDecision.row === 7,
  );
});

test("illegal moves retry twice with the rejection fed back, then succeed", async () => {
  const game = arena();
  game.applyAction("black", "place", 7, 7);
  const seen = [];
  const retries = [];
  const outputs = [
    { action: "place", row: 7, column: 7, explanation: "Again." },
    { action: "place", row: null, column: 3, explanation: "Oops." },
    { action: "place", row: 6, column: 6, explanation: "Diagonal." },
  ];
  const { decision, attempts } = await requestWuziqiDecisionWithRetry({
    snapshotFactory: () => game.aiSnapshot(),
    modelConfig: config,
    onRetry: (info) => retries.push(info.retryNumber),
    requestDecision: (snapshot, modelConfig, callbacks) => requestWuziqiDecision(snapshot, modelConfig, callbacks, fakeGateway(outputs, seen)),
  });
  assert.equal(attempts, 3);
  assert.deepEqual([decision.row, decision.column], [6, 6]);
  assert.deepEqual(retries, [1, 2]);
  assert.equal(seen[0].input.retryContext, undefined);
  assert.equal(seen[1].input.retryContext.retryNumber, 1);
  assert.deepEqual(seen[1].input.retryContext.rejectedDecision, { action: "place", row: 7, column: 7 });
  assert.match(seen[1].instructions, /AUTOMATIC RETRY 1\/2/);
  assert.match(seen[2].instructions, /AUTOMATIC RETRY 2\/2/);
});

test("a third illegal move is thrown so the room pauses", async () => {
  const game = arena();
  game.applyAction("black", "place", 7, 7);
  const outputs = Array.from({ length: 3 }, () => ({ action: "place", row: 7, column: 7, explanation: "Stubborn." }));
  await assert.rejects(
    requestWuziqiDecisionWithRetry({
      snapshotFactory: () => game.aiSnapshot(),
      modelConfig: config,
      requestDecision: (snapshot, modelConfig, callbacks) => requestWuziqiDecision(snapshot, modelConfig, callbacks, fakeGateway(outputs)),
    }),
    /occupied/,
  );
  assert.equal(outputs.length, 0);
});

test("network-style failures are not retried automatically", async () => {
  let calls = 0;
  await assert.rejects(
    requestWuziqiDecisionWithRetry({
      snapshotFactory: () => arena().aiSnapshot(),
      modelConfig: config,
      requestDecision: async () => {
        calls += 1;
        throw new Error("upstream 503");
      },
    }),
    /503/,
  );
  assert.equal(calls, 1);
});

test("moves are recorded and a finished game yields a review snapshot", async () => {
  const game = new WuziqiGame({ aiPlayers: [config] });
  for (let column = 0; column < 4; column += 1) {
    game.applyAction("black", "place", 7, column);
    game.applyAction("white", "place", 0, column);
  }
  assert.throws(() => game.reviewSnapshot(), /not finished/);
  game.applyAction("black", "place", 7, 4);
  const state = game.publicState();
  assert.equal(state.moves.length, 9);
  assert.equal(state.moves[0].coordinate, "A8");
  const snapshot = game.reviewSnapshot("black");
  assert.equal(snapshot.reviewer.color, "white", "the human seat cannot review; the AI opponent does");
  assert.equal(snapshot.result.winningLine.length, 5);

  const review = await requestWuziqiReview(snapshot, config, fakeGateway([{
    verdict: "Black ran away with row 8.",
    keyMoments: [{ moveNumber: 7, comment: "D8 made an open four." }, { moveNumber: 99, comment: "Invented." }],
    lesson: "Block open threes early.",
  }]));
  assert.equal(review.keyMoments.length, 1, "moments outside the game are dropped");
  assert.equal(review.lesson, "Block open threes early.");
});

test("a saved game restores with in-flight requests paused and arenas paused", () => {
  const game = new WuziqiGame({ gameMode: "arena", aiPlayers: [config, config] });
  game.applyAction("black", "place", 7, 7);
  game.aiThinking = { color: "white", status: "Reasoning" };
  game.tableTalk = [{ id: "t", speaker: "black", text: "Center." }];
  const restored = WuziqiGame.restore(JSON.parse(JSON.stringify(game.toSave())));
  assert.equal(restored.arenaPaused, true);
  assert.equal(restored.aiThinking, null);
  assert.equal(restored.currentColor, "white");
  assert.deepEqual(restored.publicState().board, game.publicState().board);
  assert.equal(restored.publicState().tableTalk.length, 1);
  restored.resumeArena();
  restored.applyAction("white", "place", 7, 8);
  assert.equal(restored.moves.length, 2);
  assert.throws(() => WuziqiGame.restore({ version: 2 }), /Unrecognized/);
});
