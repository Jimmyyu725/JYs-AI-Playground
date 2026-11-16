import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIAL_RATING, ResultsStore } from "../src/platform/results-store.js";
import { createMatchRecorder } from "../src/platform/room-kit.js";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "results-"));
  return { file: path.join(dir, "results.json"), store: new ResultsStore(path.join(dir, "results.json")) };
}

const sol = { kind: "ai", name: "A", characterId: "a", model: "gpt-6.1-sol", reasoningEffort: "high" };
const luna = { kind: "ai", name: "B", characterId: "b", model: "gpt-6-luna", reasoningEffort: "low" };

test("records a match, persists it, and moves Elo toward the winner", () => {
  const { file, store } = tempStore();
  const match = store.recordMatch({ gameId: "go", mode: "arena", participants: [{ ...sol, place: 1 }, { ...luna, place: 2 }] });
  assert.equal(match.ratingChanges["gpt-6.1-sol@high"], 16);
  assert.equal(match.ratingChanges["gpt-6-luna@low"], -16);
  const reloaded = new ResultsStore(file);
  const ladder = reloaded.ladder("go");
  assert.equal(ladder.matchCount, 1);
  assert.equal(ladder.ratings[0].key, "gpt-6.1-sol@high");
  assert.equal(ladder.ratings[0].rating, INITIAL_RATING + 16);
  assert.equal(ladder.recentMatches.length, 1);
});

test("scores rank highest first and the overall ladder spans games", () => {
  const { store } = tempStore();
  store.recordMatch({ gameId: "holdem", mode: "human-vs-ai", participants: [{ kind: "human", name: "You", score: 400 }, { ...luna, score: 1600 }] });
  store.recordMatch({ gameId: "wuziqi", mode: "arena", participants: [{ ...sol, place: 1 }, { ...luna, place: 1 }] });
  const overview = store.overview();
  assert.equal(overview.matchCount, 2);
  const lunaEntry = overview.overall.find((entry) => entry.key === "gpt-6-luna@low");
  assert.equal(lunaEntry.wins, 1);
  assert.equal(lunaEntry.draws, 1);
  assert.equal(overview.games.holdem[0].key, "gpt-6-luna@low");
});

test("rejects malformed matches", () => {
  const { store } = tempStore();
  assert.throws(() => store.recordMatch({ gameId: "go", mode: "solo", participants: [] }), /mode/);
  assert.throws(() => store.recordMatch({ gameId: "go", mode: "arena", participants: [{ ...sol, place: 1 }] }), /two participants/);
  assert.throws(() => store.recordMatch({ gameId: "go", mode: "arena", participants: [{ kind: "ai", name: "x", place: 1 }, { ...luna, place: 2 }] }), /model/);
});

test("the room recorder stores each table result once", () => {
  const { store } = tempStore();
  const recordOnce = createMatchRecorder(store, "go");
  const table = {};
  const build = () => ({ mode: "arena", participants: [{ ...sol, place: 1 }, { ...luna, place: 2 }] });
  assert.ok(recordOnce(table, "game", build));
  assert.equal(recordOnce(table, "game", build), null);
  assert.equal(store.ladder("go").matchCount, 1);
});
