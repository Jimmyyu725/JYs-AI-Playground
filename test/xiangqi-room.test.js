import assert from "node:assert/strict";
import test from "node:test";
import { AIDecisionError } from "../src/platform/decision-gateway.js";
import { registerGameDefaults } from "../src/platform/model-registry.js";
import { XIANGQI_GATEWAY_SCHEMA, requestXiangqiDecisionWithRetry, xiangqiPrompt } from "../src/games/xiangqi/ai.js";
import { XIANGQI_REVIEW_SCHEMA, buildReviewRequest, requestXiangqiReview } from "../src/games/xiangqi/review.js";
import { XiangqiTable } from "../src/games/xiangqi/table.js";

registerGameDefaults("xiangqi", { model: "gpt-6-luna", reasoningEffort: "low" });

function seeded(seed = 7) {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}

const reply = (output, extra = {}) => ({ output, reasoningSummary: "", reasoningSource: "", tableTalk: null, ...extra });

test("a human table seats one random AI character opposite the human", () => {
  const table = new XiangqiTable({ gameMode: "human", humanSide: "black", humanName: "Jay", aiPlayers: [{ model: "gpt-6-luna", reasoningEffort: "high" }] }, { rng: seeded(3) });
  const state = table.publicState();
  assert.equal(state.humanSide, "black");
  const red = state.players.find((player) => player.side === "red");
  assert.equal(red.isHuman, false);
  assert.ok(red.character?.id);
  assert.deepEqual(red.aiConfig, { model: "gpt-6-luna", reasoningEffort: "high" });
  assert.equal(state.players.find((player) => player.side === "black").name, "Jay");
  // Red (the AI) moves first, so the human has no legal moves yet and the AI should move.
  assert.equal(state.legalMoves.length, 0);
  assert.equal(table.aiShouldMove, true);
});

test("arena tables seat two distinct characters and honour pinned ids", () => {
  const table = new XiangqiTable({ gameMode: "arena", aiPlayers: [{ characterId: "hana" }, { characterId: "hana" }] });
  const [red, black] = table.players;
  assert.equal(red.character.id, "hana");
  assert.notEqual(black.character.id, "hana");
  table.pauseArena();
  assert.equal(table.aiShouldMove, false);
  table.resumeArena();
  assert.equal(table.aiShouldMove, true);
});

test("human moves are validated by the engine and turns are enforced", () => {
  const table = new XiangqiTable({ gameMode: "human", humanSide: "red" });
  assert.equal(table.publicState().legalMoves.length, 44);
  assert.throws(() => table.applyHumanAction({ type: "move", move: "a0a5" }), /illegal/);
  table.applyHumanAction({ type: "move", from: "h2", to: "e2" });
  assert.equal(table.state.turn, "black");
  assert.throws(() => table.applyHumanAction({ type: "move", move: "b0c2" }), (error) => error.status === 409);
  table.applyAIMove("black", "h9g7");
  table.applyHumanAction({ type: "resign" });
  assert.equal(table.phase, "complete");
  assert.equal(table.result.winner, "black");
  assert.equal(table.placeFor("black"), 1);
  assert.equal(table.placeFor("red"), 2);
});

test("a table survives a save round trip, including a paused AI error", () => {
  const table = new XiangqiTable({ gameMode: "human", humanSide: "red", humanName: "Jay" });
  table.applyHumanAction({ type: "move", move: "h2e2" });
  table.setAIError("black", "Quota exceeded");
  const copy = XiangqiTable.fromSave(JSON.parse(JSON.stringify(table.toSave())));
  assert.equal(copy.state.ply, 1);
  assert.equal(copy.aiError.message, "Quota exceeded");
  assert.equal(copy.players[0].name, "Jay");
  assert.equal(copy.players[1].character.id, table.players[1].character.id);
  const tampered = table.toSave();
  tampered.game.state.history[0].move = "a0a5";
  assert.throws(() => XiangqiTable.fromSave(tampered), /Invalid Xiangqi save/);
});

test("the gateway schema leaves table talk to the gateway and the prompt drops the null-talk sentence", () => {
  assert.equal("tableTalk" in XIANGQI_GATEWAY_SCHEMA.properties, false);
  assert.deepEqual(XIANGQI_GATEWAY_SCHEMA.required, ["move", "choice", "explanation"]);
  const table = new XiangqiTable({ gameMode: "arena" });
  const { instructions, input } = xiangqiPrompt(table.aiView("red"));
  assert.doesNotMatch(instructions, /"tableTalk" is an optional/);
  assert.match(instructions, /h2e2/);
  assert.equal(input.you, "red");
});

test("an illegal answer is retried with the rejection fed back, then accepted", async () => {
  const table = new XiangqiTable({ gameMode: "arena" });
  const calls = [];
  const answers = [reply({ move: "a0a5", choice: null, explanation: "Charge." }), reply({ move: "h2e2", choice: null, explanation: "Central cannon." }, { tableTalk: "The middle is mine." })];
  const retries = [];
  const { decision, attempts } = await requestXiangqiDecisionWithRetry({
    viewFactory: () => ({ state: table.state, view: table.aiView("red") }),
    side: "red",
    modelConfig: { model: "gpt-6-luna", reasoningEffort: "high" },
    voice: "dry",
    onRetry: (info) => retries.push(info),
    gateway: async (request) => {
      calls.push(request);
      return answers.shift();
    },
  });
  assert.equal(attempts, 2);
  assert.equal(decision.move, "h2e2");
  assert.equal(decision.tableTalk, "The middle is mine.");
  assert.equal(retries.length, 1);
  assert.match(calls[1].instructions, /AUTOMATIC RETRY 1\/2: .*a0a5 is illegal/);
  assert.equal(calls[0].schema, XIANGQI_GATEWAY_SCHEMA);
  assert.deepEqual(calls[0].tableTalk, { voice: "dry" });
});

test("three bad answers pause with an error instead of playing a fallback move", async () => {
  const table = new XiangqiTable({ gameMode: "arena" });
  let count = 0;
  await assert.rejects(
    requestXiangqiDecisionWithRetry({
      viewFactory: () => ({ state: table.state, view: table.aiView("red") }),
      side: "red",
      modelConfig: {},
      gateway: async () => {
        count += 1;
        return reply({ move: "zz", choice: null, explanation: "?" });
      },
    }),
    /gave up after 3 attempts/,
  );
  assert.equal(count, 3);
  assert.equal(table.state.ply, 0);
});

test("gateway failures are not retried automatically", async () => {
  const table = new XiangqiTable({ gameMode: "arena" });
  let count = 0;
  await assert.rejects(
    requestXiangqiDecisionWithRetry({
      viewFactory: () => ({ state: table.state, view: table.aiView("red") }),
      side: "red",
      modelConfig: {},
      gateway: async () => {
        count += 1;
        throw new AIDecisionError("Rate limited", "rate_limited");
      },
    }),
    /Rate limited/,
  );
  assert.equal(count, 1);
});

test("an unparseable structured answer is retried like an illegal move", async () => {
  const table = new XiangqiTable({ gameMode: "arena" });
  let count = 0;
  const { decision, attempts } = await requestXiangqiDecisionWithRetry({
    viewFactory: () => ({ state: table.state, view: table.aiView("red") }),
    side: "red",
    modelConfig: {},
    gateway: async (request) => {
      count += 1;
      if (count === 1) throw new AIDecisionError("The model's structured decision could not be parsed", "invalid_json");
      assert.match(request.instructions, /AUTOMATIC RETRY 1\/2: your previous answer was rejected: The model's structured decision could not be parsed/);
      return reply({ move: "b0c2", choice: null, explanation: "Horse out." });
    },
  });
  assert.equal(attempts, 2);
  assert.equal(decision.move, "b0c2");
});

test("a finished game can be reviewed by the AI character in its own voice", async () => {
  const table = new XiangqiTable({ gameMode: "human", humanSide: "red", humanName: "Jay", aiPlayers: [{ characterId: "tenzin", model: "gpt-6-luna", reasoningEffort: "high" }] });
  table.applyHumanAction({ type: "move", move: "h2e2" });
  table.applyAIMove("black", "h9g7");
  table.applyHumanAction({ type: "resign" });
  const { instructions, input } = buildReviewRequest(table, "black");
  assert.match(instructions, /Tenzin Norbu/);
  assert.match(instructions, /against Jay \(a human player\)/);
  assert.deepEqual(input.moves, ["1. red h2e2", "2. black h9g7", "red resigned"]);
  let seen = null;
  const review = await requestXiangqiReview(table, "black", {
    gateway: async (request) => {
      seen = request;
      return { output: { review: "  A short   game. ", turningPoint: "Ply 3: the resignation.", advice: "Keep playing." } };
    },
  });
  assert.equal(seen.schema, XIANGQI_REVIEW_SCHEMA);
  assert.deepEqual(seen.modelConfig, { model: "gpt-6-luna", reasoningEffort: "high" });
  assert.equal(review.review, "A short game.");
  assert.equal(review.playerName, "Tenzin Norbu");
});
