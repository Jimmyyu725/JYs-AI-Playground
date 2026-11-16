import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { registerGameDefaults } from "../src/platform/model-registry.js";
import { ResultsStore } from "../src/platform/results-store.js";
import * as room from "../src/rooms/xiangqi.js";

// The room's HTTP contract, without any model call: arena tables are created paused and the
// human table seats the human as Red, so no AI turn is ever scheduled while it is the human's move.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiangqi-routes-"));
registerGameDefaults(room.id, room.defaults);
const results = new ResultsStore(path.join(dataDir, "results.json"));
const app = express();
app.use(express.json());
room.register(app, { rootDir: process.cwd(), dataDir, results });
app.use((error, _request, response, _next) => response.status(error.status || 500).json({ error: error.message }));
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
test.after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function call(method, route, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: route, method, headers: { "Content-Type": "application/json" } }, (response) => {
      let text = "";
      response.on("data", (chunk) => (text += chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    request.on("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test("a human game accepts legal moves, rejects illegal ones and records the result once", async () => {
  const empty = await call("GET", "/api/xiangqi/state");
  assert.equal(empty.body, null);
  assert.equal((await call("POST", "/api/xiangqi/action", { move: "h2e2" })).status, 409);

  const created = await call("POST", "/api/xiangqi/game", { gameMode: "human", humanSide: "red", humanName: "Jay", aiPlayers: [{ characterId: "aino", model: "gpt-6-luna", reasoningEffort: "high" }] });
  assert.equal(created.status, 201);
  assert.equal(created.body.players[1].character.id, "aino");
  assert.equal(created.body.legalMoves.length, 44);
  assert.ok(Number.isInteger(created.body.seq));

  const illegal = await call("POST", "/api/xiangqi/action", { move: "a0a5" });
  assert.equal(illegal.status, 400);
  assert.match(illegal.body.error, /a0a5 is illegal/);

  const review = await call("POST", "/api/xiangqi/review", { side: "black" });
  assert.equal(review.status, 409);

  const resigned = await call("POST", "/api/xiangqi/action", { type: "resign" });
  assert.equal(resigned.status, 200);
  assert.equal(resigned.body.status, "complete");
  assert.equal(resigned.body.result.winner, "black");
  assert.ok(resigned.body.seq > created.body.seq);

  const ladder = results.ladder("xiangqi");
  assert.equal(ladder.matchCount, 1);
  assert.equal(ladder.recentMatches[0].mode, "human-vs-ai");
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "xiangqi-table.json"), "utf8"));
  assert.equal(saved.kind, "xiangqi-table");
  assert.equal(saved.game.state.status, "complete");
  assert.equal((await call("POST", "/api/xiangqi/review", { side: "red" })).status, 400);
});

test("a paused arena stays paused and only arenas can be paused", async () => {
  const created = await call("POST", "/api/xiangqi/game", { gameMode: "arena", arenaPaused: true, aiPlayers: [{ characterId: "kai" }, { characterId: "kai" }] });
  assert.equal(created.status, 201);
  assert.equal(created.body.arenaPaused, true);
  assert.notEqual(created.body.players[0].character.id, created.body.players[1].character.id);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const state = await call("GET", "/api/xiangqi/state");
  assert.equal(state.body.aiThinking, null);
  assert.equal(state.body.ply, 0);
  assert.equal((await call("POST", "/api/xiangqi/action", { move: "h2e2" })).status, 409);
  assert.equal((await call("POST", "/api/xiangqi/retry-ai")).status, 409);

  await call("POST", "/api/xiangqi/game", { gameMode: "human", humanSide: "red" });
  assert.equal((await call("POST", "/api/xiangqi/arena/pause")).status, 409);
});
