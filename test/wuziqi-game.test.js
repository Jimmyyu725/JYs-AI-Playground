import assert from "node:assert/strict";
import test from "node:test";
import { WuziqiGame } from "../src/games/wuziqi-game.js";

function play(game, color, row, column) {
  game.applyAction(color, "place", row, column);
}

test("starts a 15x15 human Wuziqi game", () => {
  const state = new WuziqiGame({}).publicState();
  assert.equal(state.boardSize, 15);
  assert.equal(state.currentColor, "black");
  assert.equal(state.humanCanAct, true);
  assert.equal(state.noLocalFallback, true);
});

test("detects horizontal five", () => {
  const game = new WuziqiGame({});
  for (let column = 0; column < 4; column += 1) {
    play(game, "black", 7, column);
    play(game, "white", 0, column);
  }
  play(game, "black", 7, 4);
  assert.equal(game.phase, "complete");
  assert.equal(game.result.winner, "black");
  assert.equal(game.result.winningLine.length, 5);
});

test("detects vertical and diagonal wins", () => {
  for (const [rowStep, columnStep] of [[1, 0], [1, 1], [1, -1]]) {
    const game = new WuziqiGame({});
    for (let index = 0; index < 4; index += 1) {
      play(game, "black", 2 + index * rowStep, 7 + index * columnStep);
      play(game, "white", 12, index);
    }
    play(game, "black", 2 + 4 * rowStep, 7 + 4 * columnStep);
    assert.equal(game.result.winner, "black");
  }
});

test("freestyle overlines win", () => {
  const game = new WuziqiGame({});
  game.board.fill(null);
  for (let column = 0; column < 5; column += 1) game.board[game.boardSize * 7 + column] = "black";
  game.currentColor = "black";
  game.moveNumber = 5;
  play(game, "black", 7, 5);
  assert.equal(game.result.winningLine.length, 6);
});

test("rejects occupied intersections and turn violations", () => {
  const game = new WuziqiGame({});
  play(game, "black", 7, 7);
  assert.throws(() => play(game, "black", 7, 8), /white's turn/);
  assert.throws(() => play(game, "white", 7, 7), /occupied/);
});

test("AI Arena retains per-seat model configuration and public characters", () => {
  const game = new WuziqiGame({
    gameMode: "arena",
    arenaPaused: true,
    aiPlayers: [
      { model: "gpt-5.6-sol", reasoningEffort: "high" },
      { model: "gpt-5.6-terra", reasoningEffort: "low" },
    ],
  });
  const state = game.publicState();
  assert.equal(state.model, "mixed");
  assert.equal(state.players.every((player) => !player.isHuman), true);
  const snapshot = game.aiSnapshot();
  assert.equal(snapshot.legalPlacements.length, 225);
  assert.match(snapshot.players[1].personality, /Creative/i);
});
