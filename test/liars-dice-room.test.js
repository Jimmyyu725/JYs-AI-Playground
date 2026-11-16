import assert from "node:assert/strict";
import test from "node:test";
import { AIDecisionError } from "../src/platform/ai-decision-error.js";
import { GATEWAY_SCHEMA, LIARS_DICE_MAX_ATTEMPTS, requestLiarsDiceMove, reviewInput } from "../src/games/liars-dice/ai.js";
import { LiarsDiceTable } from "../src/games/liars-dice/table.js";
import { numberedOptions } from "../src/games/liars-dice/ai-view.js";
import { registerGameDefaults } from "../src/platform/model-registry.js";

registerGameDefaults("liars-dice", { model: "gpt-6-luna", reasoningEffort: "low" });

function humanTable(extra = {}) {
  return new LiarsDiceTable({ gameMode: "human", seatCount: 4, ...extra });
}

test("a human table seats the human at seat 0 and distinct random characters elsewhere", () => {
  const table = humanTable();
  assert.equal(table.players.length, 4);
  assert.equal(table.players[0].isHuman, true);
  const ids = table.players.slice(1).map((player) => player.character.id);
  assert.equal(new Set(ids).size, 3);
  for (const player of table.players.slice(1)) {
    assert.equal(player.aiConfig.model, "gpt-6-luna");
    assert.equal(player.name, player.character.name);
  }
});

test("aiPlayers pins characters and per-seat models", () => {
  const table = new LiarsDiceTable({
    gameMode: "arena",
    seatCount: 3,
    aiPlayers: [
      { characterId: "vesper", model: "gpt-6.1-sol", reasoningEffort: "high" },
      { characterId: "rook", model: "deepseek-flash", reasoningEffort: "none" },
      { characterId: "vesper" },
    ],
  });
  assert.equal(table.players[0].character.id, "vesper");
  assert.equal(table.players[1].character.id, "rook");
  assert.notEqual(table.players[2].character.id, "vesper");
  assert.deepEqual(table.players[0].aiConfig, { model: "gpt-6.1-sol", reasoningEffort: "high" });
  assert.equal(table.players[1].aiConfig.model, "deepseek-flash");
  assert.ok(table.players.every((player) => !player.isHuman));
});

test("seat count is validated", () => {
  assert.throws(() => new LiarsDiceTable({ seatCount: 1 }), /2 to 6/);
  assert.throws(() => new LiarsDiceTable({ seatCount: 7 }), /2 to 6/);
});

test("the human view hides AI dice; the arena view reveals all", () => {
  const table = humanTable();
  const view = table.publicState();
  assert.equal(view.humanSeat, 0);
  assert.equal(view.seats[0].dice.length, 5);
  for (const seat of view.seats.slice(1)) assert.equal(seat.dice, null);
  assert.equal(JSON.stringify(view).includes("rngState"), false);
  assert.equal(view.players[1].character.personality, undefined);

  const arena = new LiarsDiceTable({ gameMode: "arena", seatCount: 3 });
  for (const seat of arena.publicState().seats) assert.equal(seat.dice.length, 5);
});

test("human controls follow the turn", () => {
  const table = humanTable();
  table.state = { ...table.state, currentSeat: 0, roundStarter: 0 };
  let view = table.publicState();
  assert.equal(view.human.canAct, true);
  assert.equal(view.human.canDudo, false);
  assert.ok(view.human.bidRanges.length > 0);
  table.act(0, { type: "bid", quantity: 2, face: 3 });
  view = table.publicState();
  assert.equal(view.human.canAct, false);
  assert.deepEqual(view.currentBid, { seat: 0, quantity: 2, face: 3 });
  assert.throws(() => table.act(0, { type: "dudo" }), (error) => error.status === 409);
});

test("an illegal human bid is a 400", () => {
  const table = humanTable();
  table.state = { ...table.state, currentSeat: 0, roundStarter: 0 };
  assert.throws(() => table.act(0, { type: "bid", quantity: 99, face: 3 }), (error) => error.status === 400);
});

test("act() returns the reveal after a challenge", () => {
  const table = humanTable();
  table.state = { ...table.state, currentSeat: 0, roundStarter: 0 };
  assert.equal(table.act(0, { type: "bid", quantity: 1, face: 2 }).reveal, null);
  const { reveal } = table.act(1, { type: "dudo" });
  assert.equal(reveal.type, "dudo");
  assert.equal(reveal.callerSeat, 1);
  assert.equal(reveal.dice.length, 4);
});

test("save and restore keep players, dice and turn", () => {
  const table = humanTable({ humanName: "Jimmy" });
  table.state = { ...table.state, currentSeat: 0, roundStarter: 0 };
  table.act(0, { type: "bid", quantity: 3, face: 4 });
  table.tableTalk = [{ id: "x", speaker: 1, text: "Arr." }];
  const restored = LiarsDiceTable.fromSave(JSON.parse(JSON.stringify(table.toSave())));
  assert.deepEqual(restored.state, table.state);
  assert.deepEqual(restored.players.map((player) => player.character?.id ?? null), table.players.map((player) => player.character?.id ?? null));
  assert.equal(restored.players[0].name, "Jimmy");
  assert.equal(restored.tableTalk.length, 1);
  assert.throws(() => LiarsDiceTable.fromSave({ version: 99 }), /Unsupported/);
});

test("a finished game produces placements for the ladder", () => {
  const table = new LiarsDiceTable({ gameMode: "arena", seatCount: 2, rules: { calza: false } });
  let guard = 0;
  while (!table.isComplete && guard < 500) {
    const seat = table.state.currentSeat;
    if (table.state.currentBid) table.act(seat, { type: "dudo" });
    else table.act(seat, { type: "bid", quantity: 1, face: 2 });
    guard += 1;
  }
  assert.equal(table.isComplete, true);
  const result = table.matchResult();
  assert.equal(result.mode, "arena");
  assert.deepEqual(result.participants.map((entry) => entry.place).sort(), [1, 2]);
  assert.ok(reviewInput(table).log.some((line) => line.includes("wins the game")));
});

test("AI rationales stay hidden from a human opponent until the game ends", () => {
  const table = humanTable();
  table.recordInsight(1, { action: "bids 3 × 4s", explanation: "I hold three 4s", latencyMs: 10 });
  assert.deepEqual(table.publicState().aiInsights, []);
  const arena = new LiarsDiceTable({ gameMode: "arena", seatCount: 3 });
  arena.recordInsight(0, { action: "bids 3 × 4s", explanation: "I hold three 4s", latencyMs: 10 });
  assert.equal(arena.publicState().aiInsights.length, 1);
});

test("the gateway schema declares tableTalk only through the gateway", () => {
  assert.equal(GATEWAY_SCHEMA.properties.tableTalk, undefined);
  assert.equal(GATEWAY_SCHEMA.required.includes("tableTalk"), false);
  assert.deepEqual(GATEWAY_SCHEMA.required, ["option", "quantity", "face", "explanation"]);
});

function openingTable() {
  const table = humanTable();
  table.state = { ...table.state, currentSeat: 1, roundStarter: 1 };
  return table;
}

function bidOption(table, face) {
  return numberedOptions(table.state, 1).find((entry) => entry.type === "bid" && entry.face === face);
}

test("a valid AI answer maps to an engine action and keeps table talk", async () => {
  const table = openingTable();
  const option = bidOption(table, 4);
  const calls = [];
  const result = await requestLiarsDiceMove({
    state: table.state,
    seat: 1,
    seatNames: table.seatNames,
    character: table.players[1].character,
    modelConfig: table.players[1].aiConfig,
    requestDecision: async (request) => {
      calls.push(request);
      return { output: { option: option.option, quantity: 3, face: 4, explanation: "Solid fours." }, tableTalk: "Fours, mates.", reasoningSummary: "" };
    },
  });
  assert.deepEqual(result.action, { type: "bid", quantity: 3, face: 4 });
  assert.equal(result.tableTalk, "Fours, mates.");
  assert.equal(result.attempts, 1);
  assert.equal(calls[0].gameId, "liars-dice");
  assert.ok(calls[0].tableTalk.voice);
  assert.equal(calls[0].input.you.dice.length, 5);
});

test("a malformed answer is retried with the error fed back", async () => {
  const table = openingTable();
  const option = bidOption(table, 5);
  const prompts = [];
  const retries = [];
  const result = await requestLiarsDiceMove({
    state: table.state,
    seat: 1,
    seatNames: table.seatNames,
    character: table.players[1].character,
    modelConfig: table.players[1].aiConfig,
    onRetry: (info) => retries.push(info),
    requestDecision: async (request) => {
      prompts.push(request.instructions);
      if (prompts.length === 1) return { output: { option: option.option, quantity: 99, face: 5, explanation: "x" } };
      return { output: { option: option.option, quantity: 2, face: 5, explanation: "Better." } };
    },
  });
  assert.deepEqual(result.action, { type: "bid", quantity: 2, face: 5 });
  assert.equal(result.attempts, 2);
  assert.equal(retries.length, 1);
  assert.match(prompts[1], /AUTOMATIC RETRY 1\/2/);
  assert.match(prompts[1], /quantity from/);
});

test("three rejected answers pause with an illegal_move error", async () => {
  const table = openingTable();
  let calls = 0;
  await assert.rejects(
    requestLiarsDiceMove({
      state: table.state,
      seat: 1,
      seatNames: table.seatNames,
      character: table.players[1].character,
      modelConfig: table.players[1].aiConfig,
      requestDecision: async () => {
        calls += 1;
        return { output: { option: 999, quantity: null, face: null, explanation: "?" } };
      },
    }),
    (error) => error instanceof AIDecisionError && error.code === "illegal_move",
  );
  assert.equal(calls, LIARS_DICE_MAX_ATTEMPTS);
});

test("an unparseable model answer is retried like an illegal one", async () => {
  const table = openingTable();
  const option = bidOption(table, 3);
  let calls = 0;
  const result = await requestLiarsDiceMove({
    state: table.state,
    seat: 1,
    seatNames: table.seatNames,
    character: table.players[1].character,
    modelConfig: table.players[1].aiConfig,
    requestDecision: async () => {
      calls += 1;
      if (calls === 1) throw new AIDecisionError("The model's structured decision could not be parsed", "invalid_json");
      return { output: { option: option.option, quantity: 2, face: 3, explanation: "Threes." } };
    },
  });
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.action, { type: "bid", quantity: 2, face: 3 });
});

test("a gateway failure is not retried", async () => {
  const table = openingTable();
  let calls = 0;
  await assert.rejects(
    requestLiarsDiceMove({
      state: table.state,
      seat: 1,
      seatNames: table.seatNames,
      character: table.players[1].character,
      modelConfig: table.players[1].aiConfig,
      requestDecision: async () => {
        calls += 1;
        throw new AIDecisionError("Network down", "network");
      },
    }),
    /Network down/,
  );
  assert.equal(calls, 1);
});
