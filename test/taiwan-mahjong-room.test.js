// HTTP-level tests of the Taiwan Mahjong room with the model call replaced (ctx.decide).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { registerGameDefaults } from "../src/platform/model-registry.js";
import { ResultsStore } from "../src/platform/results-store.js";
import * as room from "../src/rooms/taiwan-mahjong.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-mahjong-room-"));
const results = new ResultsStore(path.join(dataDir, "results.json"));
let failNext = 0;
const calls = [];
async function decide(request) {
  calls.push(request);
  if (failNext > 0) {
    failNext -= 1;
    throw new Error("upstream timeout");
  }
  return { output: { actionId: 1 }, tableTalk: calls.length % 9 === 0 ? "Pour me another glass." : null };
}

registerGameDefaults(room.id, room.defaults);
const app = express();
app.use(express.json());
room.register(app, { rootDir: process.cwd(), dataDir, results, decide });
app.use((error, _request, response, _next) => response.status(error.status ?? 500).json({ error: error.message }));
const server = await new Promise((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const base = `http://127.0.0.1:${server.address().port}/api/taiwan-mahjong`;
test.after(() => server.close());

async function call(method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

async function waitFor(predicate, timeoutMs = 15000) {
  const started = Date.now();
  for (;;) {
    const { body } = await call("GET", "/state");
    if (predicate(body)) return body;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out; phase ${body?.phase}, toAct ${body?.seatsToAct}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const luna = { model: "gpt-6-luna", reasoningEffort: "low" };

test("an unknown model is a 400, not a crash", async () => {
  const { status, body } = await call("POST", "/game", { mode: "arena", aiPlayers: [{ model: "gpt-0" }] });
  assert.equal(status, 400);
  assert.match(body.error, /Unsupported model/);
});

test("an arena hand plays to the end through the AI loop and lands on the ladder once", async () => {
  const { status, body } = await call("POST", "/game", { mode: "arena", length: "single", aiPlayers: [luna, luna, luna, { ...luna, characterId: "hana" }] });
  assert.equal(status, 201);
  assert.equal(body.players[3].character.id, "hana");
  assert.equal(new Set(body.players.map((player) => player.character.id)).size, 4, "four distinct characters");
  const done = await waitFor((state) => state.phase === "gameOver");
  assert.equal(done.scores.reduce((sum, score) => sum + score, 0), 0);
  assert.equal(done.standings.length, 4);
  const ladder = results.ladder("taiwan-mahjong");
  assert.equal(ladder.matchCount, 1);
  assert.equal(ladder.recentMatches[0].mode, "arena");
  await call("GET", "/state");
  assert.equal(results.ladder("taiwan-mahjong").matchCount, 1, "a finished table is recorded once");
  // Saves are written in order in the background; the last one holds the finished table.
  let saved = null;
  for (let attempt = 0; attempt < 100 && saved?.state?.phase !== "gameOver"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    saved = JSON.parse(fs.readFileSync(path.join(dataDir, "taiwan-mahjong-table.json"), "utf8"));
  }
  assert.equal(saved.state.phase, "gameOver", "the table is saved for resume");
});

test("a human table waits for the human, rejects illegal moves, and pauses on an AI failure until retried", async () => {
  const { body: opened } = await call("POST", "/game", { mode: "human-vs-ai", humanName: "Jay", aiPlayers: [luna, luna, luna] });
  assert.equal(opened.humanSeat, 0);
  assert.equal(opened.players[0].name, "Jay");
  assert.equal(opened.players[1].hand, null, "opponents' hands stay hidden");
  assert.deepEqual(opened.seatsToAct, [0]);

  const illegal = await call("POST", "/action", { action: { type: "discard", tile: "ZZ" } });
  assert.equal(illegal.status, 400);
  assert.equal((await call("POST", "/next-hand")).status, 409);
  assert.equal((await call("POST", "/review", { seat: 1 })).status, 409);

  failNext = 1;
  const discard = opened.humanActions.find((action) => action.type === "discard");
  assert.equal((await call("POST", "/action", { action: discard })).status, 200);
  const paused = await waitFor((state) => state.aiError);
  assert.match(paused.aiError.message, /upstream timeout/);
  assert.equal((await call("POST", "/retry-ai")).status, 200);
  const back = await waitFor((state) => state.seatsToAct.includes(0) || ["handOver", "gameOver"].includes(state.phase));
  assert.equal(back.aiError, null);
});
