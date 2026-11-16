import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildProfiles, PROFILES_PATH } from "../scripts/check-lobby-profiles.js";
import {
  characterRecords,
  countLabel,
  entrantLabel,
  isOpen,
  mergeMatches,
  numberWord,
  pickTrio,
  playersLabel,
  ratingPaths,
  roomLight,
} from "../public/assets/lobby/house-data.js";
import { ResultsStore } from "../src/platform/results-store.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function seededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test("lobby browser scripts parse", () => {
  for (const file of [
    "public/lobby.js",
    "public/assets/lobby/house-data.js",
    "public/assets/lobby/house-ui.js",
    "public/characters/house.js",
    "public/ladder/ladder.js",
  ]) {
    execFileSync(process.execPath, ["--check", path.join(rootDir, file)]);
  }
});

test("profiles.json matches the roster's personality and voice", () => {
  assert.equal(fs.readFileSync(PROFILES_PATH, "utf8"), buildProfiles(), "run node scripts/check-lobby-profiles.js --write");
});

test("every room in the manifest has a door painting and its own light", () => {
  const { games } = JSON.parse(fs.readFileSync(path.join(rootDir, "public/games/manifest.json"), "utf8"));
  for (const game of games) {
    const door = path.join(rootDir, "public/assets/lobby", `door-${game.id}.webp`);
    assert.ok(fs.existsSync(door), `missing ${path.relative(rootDir, door)}`);
    assert.ok(fs.statSync(door).size < 600 * 1024, `${game.id} door is over 600 KB`);
    assert.notEqual(roomLight(game.id).glow, roomLight("not-a-room").glow, `${game.id} has no light of its own`);
  }
});

test("a door opens only for live rooms the server mounts", () => {
  assert.equal(isOpen({ status: "live", serverRoom: true }), true);
  assert.equal(isOpen({ status: "live", serverRoom: false }), false);
  assert.equal(isOpen({ status: "opening", serverRoom: true }), false);
});

test("pickTrio returns three distinct characters and avoids the last trio", () => {
  const cast = Array.from({ length: 50 }, (_, index) => ({ id: `c${index}` }));
  const rng = seededRng(3);
  const first = pickTrio(cast, { rng });
  assert.equal(new Set(first.map((character) => character.id)).size, 3);
  const second = pickTrio(cast, { exclude: first.map((character) => character.id), rng });
  assert.equal(second.filter((character) => first.some((other) => other.id === character.id)).length, 0);
  assert.equal(pickTrio(cast.slice(0, 4), { exclude: ["c0", "c1", "c2"], rng }).length, 3, "falls back to the whole cast");
});

test("labels read naturally", () => {
  assert.equal(numberWord(9), "Nine");
  assert.equal(numberWord(42), "42");
  assert.equal(playersLabel({ min: 2, max: 6 }), "2–6 players");
  assert.equal(playersLabel({ min: 3, max: 3 }), "3 players");
  assert.equal(countLabel(1, "loss", "losses"), "1 loss");
  assert.equal(countLabel(0, "loss", "losses"), "0 losses");
  assert.equal(countLabel(2, "win"), "2 wins");
  const registry = { models: [{ id: "gpt-6-luna", label: "GPT-6 Luna" }] };
  assert.equal(entrantLabel({ kind: "ai", model: "gpt-6-luna", reasoningEffort: "high" }, registry), "GPT-6 Luna · high");
  assert.equal(entrantLabel({ kind: "ai", model: "mystery", reasoningEffort: "low" }, registry), "mystery · low");
  assert.equal(entrantLabel({ key: "human", kind: "human" }, registry), "Human players");
});

function storeWithMatches() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lobby-test-"));
  const store = new ResultsStore(path.join(directory, "results.json"));
  const ai = (characterId, model, place) => ({ kind: "ai", name: characterId, characterId, model, reasoningEffort: "high", place });
  store.recordMatch({ gameId: "go", mode: "arena", participants: [ai("vesper", "gpt-6-luna", 1), ai("rook", "gpt-6.1-sol", 2)] });
  store.recordMatch({ gameId: "go", mode: "arena", participants: [ai("rook", "gpt-6.1-sol", 1), ai("selene", "gpt-6-luna", 2)] });
  store.recordMatch({
    gameId: "doudizhu",
    mode: "human-vs-ai",
    participants: [{ kind: "human", name: "You", place: 1 }, ai("vesper", "gpt-6-astra", 2), ai("moss", "deepseek-flash", 2)],
  });
  return { store, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test("characterRecords tallies wins and losses per character across games", () => {
  const { store, cleanup } = storeWithMatches();
  try {
    const records = characterRecords(store.ladder().recentMatches);
    assert.deepEqual(records.vesper, { matches: 2, wins: 1, losses: 1, draws: 0, games: ["doudizhu", "go"] });
    assert.deepEqual(records.rook, { matches: 2, wins: 1, losses: 1, draws: 0, games: ["go"] });
    assert.equal(records.moss.losses, 1);
    assert.equal(records.you, undefined, "humans have no character record");
  } finally {
    cleanup();
  }
});

test("ratingPaths walks back from the current rating to 1500 when every match is present", () => {
  const { store, cleanup } = storeWithMatches();
  try {
    const ladder = store.ladder("go");
    const paths = ratingPaths(ladder.ratings, ladder.recentMatches);
    for (const entry of ladder.ratings) {
      assert.equal(paths[entry.key].at(-1), entry.rating);
      assert.ok(Math.abs(paths[entry.key][0] - 1500) <= 1, `${entry.key} starts near 1500, got ${paths[entry.key][0]}`);
    }
    assert.equal(paths["gpt-6.1-sol@high"].length, 3, "two matches give three points");
  } finally {
    cleanup();
  }
});

test("mergeMatches de-duplicates by id and sorts newest first", () => {
  const merged = mergeMatches(
    [{ id: "a", at: "2026-11-17T01:00:00Z" }, { id: "b", at: "2026-11-17T03:00:00Z" }],
    [{ id: "a", at: "2026-11-17T01:00:00Z" }, { id: "c", at: "2026-11-17T02:00:00Z" }],
    undefined,
  );
  assert.deepEqual(merged.map((match) => match.id), ["b", "c", "a"]);
});
