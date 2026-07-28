import assert from "node:assert/strict";
import test from "node:test";
import { GoGame } from "../src/games/go-game.js";

function play(game, color, row, column) {
  game.applyAction(color, "place", row, column);
}

test("starts a 9x9 human Go game with authoritative public state", () => {
  const game = new GoGame({ humanName: "Player", boardSize: 9 });
  const state = game.publicState();
  assert.equal(state.boardSize, 9);
  assert.equal(state.currentColor, "black");
  assert.equal(state.humanCanAct, true);
  assert.equal(state.board.flat().every((cell) => cell === null), true);
  assert.equal(state.noLocalFallback, true);
});

test("captures a surrounded stone and records prisoner count", () => {
  const game = new GoGame({ boardSize: 9 });
  play(game, "black", 0, 1);
  play(game, "white", 0, 0);
  play(game, "black", 1, 0);
  assert.equal(game.board[0], null);
  assert.equal(game.captures.black, 1);
});

test("rejects suicide", () => {
  const game = new GoGame({ boardSize: 9 });
  play(game, "black", 8, 8);
  play(game, "white", 0, 1);
  play(game, "black", 8, 7);
  play(game, "white", 1, 0);
  assert.throws(() => play(game, "black", 0, 0), /Suicide/);
});

test("enforces positional superko on an immediate recapture", () => {
  const game = new GoGame({ boardSize: 9 });
  play(game, "black", 0, 1);
  play(game, "white", 1, 1);
  play(game, "black", 1, 0);
  play(game, "white", 0, 2);
  play(game, "black", 2, 1);
  play(game, "white", 2, 2);
  play(game, "black", 8, 8);
  play(game, "white", 1, 3);
  play(game, "black", 1, 2);
  assert.throws(() => play(game, "white", 1, 1), /superko/);
});

test("two passes end the game with Chinese area scoring and komi", () => {
  const game = new GoGame({ boardSize: 9, komi: 7.5 });
  game.applyAction("black", "pass");
  game.applyAction("white", "pass");
  assert.equal(game.phase, "complete");
  assert.deepEqual(game.result, {
    winner: "white",
    reason: "score",
    margin: 7.5,
    scores: { black: 0, white: 7.5 },
  });
});

test("AI vs AI exposes both model configurations and public personas", () => {
  const game = new GoGame({
    gameMode: "arena",
    arenaPaused: true,
    aiPlayers: [
      { model: "gpt-5.6-sol", reasoningEffort: "max" },
      { model: "gpt-5.6-luna", reasoningEffort: "none" },
    ],
  });
  const state = game.publicState();
  assert.equal(state.model, "mixed");
  assert.equal(state.players.every((player) => !player.isHuman), true);
  const snapshot = game.aiSnapshot();
  assert.equal(snapshot.players.length, 2);
  assert.match(snapshot.players[1].personality, /Analytical/i);
  assert.equal(snapshot.legalPlacements.length, 81);
});
