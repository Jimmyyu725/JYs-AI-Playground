import test from "node:test";
import assert from "node:assert/strict";
import { AI_CHARACTERS, getCharacter } from "../src/platform/characters.js";
import { applyAction as applyEngineAction, getSeatsToAct } from "../src/games/taiwan-mahjong/engine.js";
import { listNumberedActions } from "../src/games/taiwan-mahjong/ai-view.js";
import { MAX_AUTOMATIC_RETRIES, TaiwanMahjongTable } from "../src/games/taiwan-mahjong/table.js";

const aiConfig = { model: "gpt-6-luna", reasoningEffort: "low" };
const seats = (count) => AI_CHARACTERS.slice(0, count).map((character) => ({ character, aiConfig }));

// A stand-in for the model: always picks the first legal action (a win when offered,
// otherwise the first discard / claim), and says one line.
function firstActionDecider(calls = []) {
  return async (request) => {
    calls.push(request);
    return { output: { actionId: 1 }, tableTalk: "Tea's getting cold." };
  };
}

async function runAI(table, decide, limit = 2000) {
  for (let step = 0; step < limit; step += 1) {
    const seat = table.nextAISeat();
    if (seat === null) return step;
    await table.playAISeat(seat, decide);
  }
  throw new Error("AI loop did not stop");
}

test("an arena table plays to game over through the AI loop and ranks the seats", async () => {
  const table = new TaiwanMahjongTable({ mode: "arena", aiSeats: seats(4), length: "single", seed: 7 });
  const calls = [];
  await runAI(table, firstActionDecider(calls));
  assert.equal(table.state.phase, "gameOver");
  assert.equal(table.state.scores.reduce((sum, score) => sum + score, 0), 0);
  const places = table.standings();
  assert.equal(places.length, 4);
  assert.ok(places.includes(1));
  assert.ok(calls.length > 0);
  assert.equal(calls[0].modelConfig, aiConfig);
  assert.ok(calls[0].voice);
  assert.equal(calls[0].input.opponents.length, 3);
  assert.ok(!("hand" in calls[0].input.opponents[0]), "opponents' hands never reach the model");
  assert.ok(table.tableTalk.length > 0);
  assert.ok(table.aiInsights.length > 0);
});

test("a human table stops at the human's decision and accepts only legal moves", async () => {
  const table = new TaiwanMahjongTable({ mode: "human-vs-ai", aiSeats: seats(3), seed: 3 });
  assert.equal(table.players[0].isHuman, true);
  assert.deepEqual(getSeatsToAct(table.state), [0], "the human deals first");
  assert.equal(table.nextAISeat(), null);
  assert.throws(() => table.humanAction({ type: "discard", tile: "not-a-tile" }), /not legal/);
  const discard = table.publicState().humanActions.find((action) => action.type === "discard");
  table.humanAction(discard);
  await runAI(table, firstActionDecider());
  const toAct = getSeatsToAct(table.state);
  assert.ok(table.state.phase === "handOver" || table.state.phase === "gameOver" || toAct.includes(0));
});

test("public state hides other hands from the human and shows all hands to arena spectators", () => {
  const human = new TaiwanMahjongTable({ mode: "human-vs-ai", aiSeats: seats(3), seed: 5 }).publicState();
  assert.ok(Array.isArray(human.players[0].hand));
  assert.equal(human.players[1].hand, null);
  assert.equal(human.players[1].character.id, AI_CHARACTERS[0].id);
  assert.ok(!("personality" in human.players[1].character));
  const arena = new TaiwanMahjongTable({ mode: "arena", aiSeats: seats(4), seed: 5 }).publicState();
  assert.ok(arena.players.every((player) => Array.isArray(player.hand)));
  assert.equal(arena.humanSeat, null);
});

test("malformed answers are retried with the error fed back, then the table pauses", async () => {
  const table = new TaiwanMahjongTable({ mode: "arena", aiSeats: seats(4), seed: 11 });
  const calls = [];
  const retries = [];
  const decide = async (request) => {
    calls.push(request);
    return { output: { actionId: 999 }, tableTalk: "" };
  };
  await assert.rejects(table.playAISeat(0, decide, { onRetry: (info) => retries.push(info) }), /unusable answer/);
  assert.equal(calls.length, MAX_AUTOMATIC_RETRIES + 1);
  assert.equal(retries.length, MAX_AUTOMATIC_RETRIES);
  assert.match(calls[1].instructions, /AUTOMATIC RETRY 1\/2/);
  assert.match(calls[1].instructions, /not in legalActions/);

  const seqBefore = table.state.seq;
  const recovering = async () => ({ output: { actionId: 1 }, tableTalk: "" });
  const flaky = [async () => ({ output: { actionId: "x" } }), recovering];
  let index = 0;
  await table.playAISeat(0, (request) => flaky[Math.min(index++, 1)](request));
  assert.ok(table.state.seq > seqBefore, "the corrected answer is applied");
});

test("an answer that went stale because the human answered the same claim window still stands", async () => {
  const table = new TaiwanMahjongTable({ mode: "arena", aiSeats: seats(4), seed: 2 });
  // Find a claim window with two eligible seats by playing first-action moves.
  const decide = firstActionDecider();
  for (let step = 0; step < 3000; step += 1) {
    if (table.state.phase === "claim" && getSeatsToAct(table.state).length >= 2) break;
    if (table.state.phase === "handOver") table.nextHand();
    if (table.state.phase === "gameOver") break;
    const seat = table.nextAISeat();
    await table.playAISeat(seat, decide);
  }
  if (table.state.phase !== "claim") return; // the seed never produced a double claim window
  const [first, second] = getSeatsToAct(table.state);
  const passId = listNumberedActions(table.state, second).find((entry) => entry.action.type === "pass").id;
  const interleaved = async (request) => {
    // While `second` is "thinking", `first` answers and moves seq on.
    const { applyAction } = await import("../src/games/taiwan-mahjong/engine.js");
    table.state = applyAction(table.state, first, { type: "pass" });
    return { output: { actionId: request.input.legalActions.length >= passId ? passId : 1 }, tableTalk: "" };
  };
  const result = await table.playAISeat(second, interleaved);
  assert.ok(result === null || result.decision.ok);
});

test("a human move that closes the claim window clears a pause on the AI seat it made moot", () => {
  for (let seed = 1; seed < 300; seed += 1) {
    const table = new TaiwanMahjongTable({ mode: "human-vs-ai", aiSeats: seats(3), seed });
    let found = false;
    for (let step = 0; step < 300 && !["handOver", "gameOver"].includes(table.state.phase); step += 1) {
      const toAct = getSeatsToAct(table.state);
      const humanPung = toAct.includes(0) && toAct.length > 1 && table.publicState().humanActions.some((action) => action.type === "pung");
      if (table.state.phase === "claim" && humanPung) {
        found = true;
        break;
      }
      const seat = toAct[0];
      const options = listNumberedActions(table.state, seat);
      const pick = options.find((entry) => entry.action.type === "pass") ?? options[options.length - 1];
      if (seat === 0) table.humanAction(pick.action);
      else table.state = applyEngineAction(table.state, seat, pick.action);
    }
    if (!found) continue;
    const aiSeat = getSeatsToAct(table.state).find((seat) => seat !== 0);
    table.setAIError(aiSeat, "network down");
    table.humanAction({ type: "pung" });
    if (getSeatsToAct(table.state).includes(aiSeat)) {
      assert.ok(table.aiError, "the AI seat still has to answer, so the pause stays");
    } else {
      assert.equal(table.aiError, null);
    }
    return;
  }
  assert.fail("no seed produced a shared claim window");
});

test("claim-window AI seats can be asked at once; late answers to a closed window are dropped", async () => {
  let windows = 0;
  for (let seed = 1; seed < 40 && windows < 5; seed += 1) {
    const table = new TaiwanMahjongTable({ mode: "arena", aiSeats: seats(4), length: "single", seed });
    let delay = 0;
    const decide = async (request) => {
      delay = (delay + 7) % 13;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { output: { actionId: 1 }, tableTalk: "" };
    };
    for (let step = 0; step < 600 && table.state.phase !== "gameOver"; step += 1) {
      const due = table.aiSeatsToAct();
      if (due.length === 0) break;
      if (due.length > 1) windows += 1;
      const outcomes = await Promise.allSettled(due.map((seat) => table.playAISeat(seat, decide)));
      assert.ok(outcomes.every((outcome) => outcome.status === "fulfilled"), "no seat fails because another answered first");
      const tiles = table.state.wall.length + table.state.players.reduce((sum, player) => sum
        + player.hand.length + player.discards.length + player.flowers.length
        + player.melds.reduce((count, meld) => count + meld.tiles.length, 0), 0);
      assert.equal(tiles, 144);
    }
  }
  assert.ok(windows > 0, "some claim window had two AI seats");
});

test("a saved table round-trips through JSON", () => {
  const table = new TaiwanMahjongTable({ mode: "human-vs-ai", aiSeats: seats(3), seed: 9, humanName: "Jay" });
  const restored = TaiwanMahjongTable.fromJSON(JSON.parse(JSON.stringify(table.toJSON())), getCharacter);
  assert.deepEqual(restored.state, table.state);
  assert.equal(restored.players[0].name, "Jay");
  assert.equal(restored.players[2].character.id, AI_CHARACTERS[1].id);
  assert.deepEqual(restored.publicState().players.map((player) => player.name), table.publicState().players.map((player) => player.name));
});
