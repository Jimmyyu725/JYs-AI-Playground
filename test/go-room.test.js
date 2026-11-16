import assert from "node:assert/strict";
import test from "node:test";
import { AI_CHARACTERS } from "../src/platform/characters.js";
import { pushTableTalk } from "../src/platform/table-talk.js";
import { GoGame } from "../src/games/go-game.js";

function play(game, color, row, column) {
  game.applyAction(color, "place", row, column);
}

test("a restored Go save keeps the seated characters and table talk", () => {
  const game = new GoGame({
    gameMode: "arena",
    arenaPaused: true,
    aiPlayers: [
      { model: "gpt-6-luna", reasoningEffort: "high", characterId: AI_CHARACTERS[10].id },
      { model: "gpt-6-luna", reasoningEffort: "low", characterId: AI_CHARACTERS[20].id },
    ],
  });
  pushTableTalk(game, { speaker: "black", playerName: game.players[0].name, characterId: AI_CHARACTERS[10].id, text: "The kettle is singing." });
  const restored = GoGame.fromSave(game.toSave("2026-11-17T00:00:00.000Z"));
  assert.deepEqual(restored.players.map((player) => player.character.id), [AI_CHARACTERS[10].id, AI_CHARACTERS[20].id]);
  assert.equal(restored.publicState().tableTalk[0].text, "The kettle is singing.");
});

test("a human game restore keeps the opponent's character", () => {
  const game = new GoGame({ humanColor: "white", aiPlayers: [{ model: "gpt-6-luna", reasoningEffort: "low", characterId: "hana" }] });
  const restored = GoGame.fromSave(game.toSave("2026-11-17T00:00:00.000Z"));
  assert.equal(restored.players.find((player) => player.color === "black").character.id, "hana");
  assert.equal(restored.players.find((player) => player.color === "white").isHuman, true);
});

test("older saves without character ids still restore with a random cast", () => {
  const game = new GoGame({ boardSize: 9 });
  const payload = game.toSave("2026-11-17T00:00:00.000Z");
  for (const player of payload.state.players) delete player.characterId;
  delete payload.state.tableTalk;
  delete payload.state.review;
  const restored = GoGame.fromSave(payload);
  assert.ok(restored.players.find((player) => !player.isHuman).character.id);
  assert.deepEqual(restored.publicState().tableTalk, []);
});

test("scoring exposes a territory map that matches the area count", () => {
  const game = new GoGame({ boardSize: 9, komi: 0.5 });
  // Black walls column 3 and owns columns 0-2; White walls column 5 and owns columns 6-8.
  for (let row = 0; row < 9; row += 1) {
    play(game, "black", row, 3);
    play(game, "white", row, 5);
  }
  game.applyAction("black", "pass");
  game.applyAction("white", "pass");
  const state = game.publicState();
  assert.equal(state.phase, "complete");
  assert.equal(state.territory.length, 9);
  assert.equal(state.territory[0][0], "black");
  assert.equal(state.territory[0][8], "white");
  assert.equal(state.territory[0][4], null, "the neutral column belongs to nobody");
  assert.equal(state.territory[0][3], null, "stones are not territory");
  const owned = state.territory.flat();
  assert.equal(state.result.scores.black, 9 + owned.filter((owner) => owner === "black").length);
  assert.equal(state.result.scores.white, 9 + owned.filter((owner) => owner === "white").length + 0.5);
  assert.equal(state.result.winner, "white");
});

test("territory is hidden while the game is active or after a resignation", () => {
  const game = new GoGame({ boardSize: 9 });
  assert.equal(game.publicState().territory, null);
  game.applyAction("black", "resign");
  assert.equal(game.publicState().territory, null);
});

test("a review snapshot needs a finished game and an AI reviewer", () => {
  const game = new GoGame({ boardSize: 9, humanColor: "black" });
  assert.throws(() => game.reviewSnapshot("white"), /Finish the game/);
  play(game, "black", 4, 4);
  game.applyAction("white", "resign");
  assert.throws(() => game.reviewSnapshot("black"), /Only an AI player/);
  const snapshot = game.reviewSnapshot("white");
  assert.equal(snapshot.reviewer.color, "white");
  assert.ok(snapshot.moveRecord.some((line) => line.includes("E5")));
  assert.equal(snapshot.finalBoardRows[4][4], "B");
});

test("a stored review survives a save round trip", () => {
  const game = new GoGame({ boardSize: 9 });
  game.applyAction("black", "resign");
  game.review = { text: "A brave start.", keyMoments: [{ coordinate: "E5", note: "Centre." }], color: "white", playerName: "X" };
  const restored = GoGame.fromSave(game.toSave("2026-11-17T00:00:00.000Z"));
  assert.equal(restored.publicState().review.keyMoments[0].coordinate, "E5");
});
