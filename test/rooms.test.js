import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roomsDir = path.join(rootDir, "src", "rooms");
const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "public", "games", "manifest.json"), "utf8"));

test("every room module follows the contract and matches its file name", async () => {
  for (const file of fs.readdirSync(roomsDir).filter((name) => name.endsWith(".js"))) {
    const room = await import(pathToFileURL(path.join(roomsDir, file)).href);
    assert.equal(`${room.id}.js`, file);
    assert.equal(typeof room.register, "function");
    assert.equal(typeof room.defaults?.model, "string");
  }
});

test("the manifest lists all nine rooms and every live room has a server module", () => {
  const ids = manifest.games.map((game) => game.id);
  assert.deepEqual(ids, ["holdem", "go", "wuziqi", "doudizhu", "liars-dice", "xiangqi", "coup", "draw-guess", "taiwan-mahjong"]);
  for (const game of manifest.games) {
    for (const field of ["name", "nameZh", "route", "pitch", "players", "modes", "status"]) assert.ok(game[field], `${game.id} lacks ${field}`);
    assert.ok(["live", "opening"].includes(game.status));
    if (game.status === "live") assert.ok(fs.existsSync(path.join(roomsDir, `${game.id}.js`)), `${game.id} is live without src/rooms/${game.id}.js`);
  }
});
