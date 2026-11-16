import test from "node:test";
import assert from "node:assert/strict";
import {
  INITIAL_FEN,
  XiangqiRuleError,
  applyAction,
  boardToFen,
  createXiangqiGame,
  explainIllegalMove,
  iccsToSquare,
  isInCheck,
  legalActions,
  legalMoves,
  materialCount,
  parseFen,
  parseIccsMove,
  perft,
  playerView,
  previewMove,
  publicView,
  restoreGame,
  scoreGame,
  serializeGame,
  sideForSeat,
  validateAction,
  validatePosition,
} from "../src/games/xiangqi/engine.js";

// Builds a FEN from { e0: "K", e9: "k", ... }.
function fenOf(pieces, turn = "red") {
  const board = Array(90).fill(null);
  for (const [point, piece] of Object.entries(pieces)) board[iccsToSquare(point)] = piece;
  return boardToFen(board, turn);
}

function game(pieces, turn = "red", options = {}) {
  return createXiangqiGame({ fen: fenOf(pieces, turn), ...options });
}

function movesFrom(state, point) {
  return legalMoves(state).filter((move) => move.from === point).map((move) => move.to).sort();
}

function play(state, ...moves) {
  return moves.reduce((current, move) => applyAction(current, { type: "move", move }), state);
}

function boardOf(pieces) {
  return parseFen(fenOf(pieces)).board;
}

test("the opening position has 44 legal moves and matches known perft counts", () => {
  const state = createXiangqiGame();
  assert.equal(state.turn, "red");
  assert.equal(state.status, "active");
  assert.equal(legalMoves(state).length, 44);
  assert.equal(perft(state.board, "red", 2), 1920);
  assert.equal(perft(state.board, "red", 3), 79666);
  assert.equal(perft(state.board, "red", 4), 3290240);
});

test("FEN parsing round-trips and accepts E/H piece aliases", () => {
  const { board, turn } = parseFen(INITIAL_FEN);
  assert.equal(boardToFen(board, turn), INITIAL_FEN);
  const alias = parseFen("rheakaehr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RHEAKAEHR b");
  assert.equal(alias.turn, "black");
  assert.equal(boardToFen(alias.board, "red"), INITIAL_FEN);
  assert.throws(() => parseFen("rnbakabnr/9 w"), /10 ranks/);
  assert.throws(() => parseFen("rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABN w"), /9 files/);
  assert.throws(() => parseFen("rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNX w"), /Unknown FEN piece/);
  assert.throws(() => parseFen(`${INITIAL_FEN.split(" ")[0]} z`), /side to move/);
});

test("ICCS notation is parsed leniently and validated strictly", () => {
  assert.deepEqual(parseIccsMove("h2e2"), { from: iccsToSquare("h2"), to: iccsToSquare("e2") });
  assert.deepEqual(parseIccsMove(" H2-E2 "), parseIccsMove("h2e2"));
  assert.deepEqual(parseIccsMove("h2 e2"), parseIccsMove("h2e2"));
  assert.equal(parseIccsMove("j2e2"), null);
  assert.equal(parseIccsMove("h2e"), null);
  assert.equal(parseIccsMove(42), null);
  assert.equal(iccsToSquare("a0"), 0);
  assert.equal(iccsToSquare("i9"), 89);
  assert.equal(iccsToSquare("e10"), null);
});

test("invalid starting positions are rejected", () => {
  const cases = [
    [{ e0: "K", d9: "k", e1: "K" }, /too many generals/],
    [{ e3: "K", d9: "k" }, /outside its palace/],
    [{ e0: "K", d9: "k", d1: "A" }, /palace diagonal/],
    [{ e0: "K", d9: "k", c6: "B" }, /elephant point/],
    [{ e0: "K", d9: "k", e2: "P" }, /behind its starting line/],
    [{ e0: "K", d9: "k", d3: "P" }, /behind its starting line/],
    [{ e0: "K" }, /exactly one general/],
    [{ e0: "K", e9: "k" }, /still in check/], // generals face each other with Red to move
  ];
  for (const [pieces, pattern] of cases) {
    assert.throws(() => game(pieces), (error) => error instanceof XiangqiRuleError && pattern.test(error.message), JSON.stringify(pieces));
  }
  assert.equal(validatePosition(parseFen(INITIAL_FEN).board, "red"), null);
});

test("the general moves one point orthogonally and never leaves the palace", () => {
  const state = game({ d0: "K", f9: "k" });
  assert.deepEqual(movesFrom(state, "d0"), ["d1", "e0"]);
  assert.match(explainIllegalMove(state.board, "red", iccsToSquare("d0"), iccsToSquare("c0")), /palace/);
  assert.match(explainIllegalMove(state.board, "red", iccsToSquare("d0"), iccsToSquare("d2")), /exactly one point/);
  const black = game({ d0: "K", e8: "k" }, "black");
  assert.deepEqual(movesFrom(black, "e8"), ["e7", "e9", "f8"]); // d8 would face the red general
});

test("flying general: the generals may never face each other on an open file", () => {
  const state = game({ e1: "K", f9: "k" });
  assert.deepEqual(movesFrom(state, "e1"), ["d1", "e0", "e2"]);
  assert.match(explainIllegalMove(state.board, "red", iccsToSquare("e1"), iccsToSquare("f1")), /flying general/);

  // A lone piece between the generals is pinned to the file.
  const pinned = game({ e0: "K", e9: "k", e5: "N", a9: "r" });
  assert.deepEqual(movesFrom(pinned, "e5"), []);
  assert.match(explainIllegalMove(pinned.board, "red", iccsToSquare("e5"), iccsToSquare("d7")), /flying general/);
  assert.equal(isInCheck(boardOf({ e0: "K", e9: "k" }), "red"), true);
  assert.equal(isInCheck(boardOf({ e0: "K", e9: "k" }), "black"), true);
});

test("advisors move one point diagonally inside the palace", () => {
  const center = game({ d0: "K", f9: "k", e1: "A" });
  assert.deepEqual(movesFrom(center, "e1"), ["d2", "f0", "f2"]); // d0 holds its own general
  const corner = game({ e0: "K", d9: "k", f0: "A" });
  assert.deepEqual(movesFrom(corner, "f0"), ["e1"]);
  const black = game({ e0: "K", d9: "k", e8: "a" }, "black");
  assert.deepEqual(movesFrom(black, "e8"), ["d7", "f7", "f9"]);
  assert.match(explainIllegalMove(corner.board, "red", iccsToSquare("f0"), iccsToSquare("f1")), /diagonally/);
});

test("elephants move two points diagonally, cannot cross the river, and are blocked at the eye", () => {
  const state = game({ e0: "K", d9: "k", c4: "B" });
  assert.deepEqual(movesFrom(state, "c4"), ["a2", "e2"]);
  assert.match(explainIllegalMove(state.board, "red", iccsToSquare("c4"), iccsToSquare("e6")), /cannot cross the river/);
  const blocked = game({ e0: "K", d9: "k", c4: "B", d3: "N" });
  assert.deepEqual(movesFrom(blocked, "c4"), ["a2"]);
  assert.match(explainIllegalMove(blocked.board, "red", iccsToSquare("c4"), iccsToSquare("e2")), /eye at d3 is blocked/);
  const black = game({ e0: "K", d9: "k", c5: "b" }, "black");
  assert.deepEqual(movesFrom(black, "c5"), ["a7", "e7"]);
});

test("horses move in an L and are blocked at the leg", () => {
  const free = game({ e0: "K", d9: "k", e4: "N" });
  assert.deepEqual(movesFrom(free, "e4"), ["c3", "c5", "d2", "d6", "f2", "f6", "g3", "g5"]);
  const blocked = game({ e0: "K", d9: "k", e4: "N", e5: "p" });
  assert.deepEqual(movesFrom(blocked, "e4"), ["c3", "c5", "d2", "f2", "g3", "g5"]);
  assert.match(explainIllegalMove(blocked.board, "red", iccsToSquare("e4"), iccsToSquare("d6")), /leg at e5 is blocked/);
  assert.match(explainIllegalMove(blocked.board, "red", iccsToSquare("e4"), iccsToSquare("e6")), /L shape/);
  const corner = game({ e0: "K", d9: "k", a0: "N" });
  assert.deepEqual(movesFrom(corner, "a0"), ["b2", "c1"]);
});

test("chariots slide along ranks and files and capture the first enemy piece", () => {
  const state = game({ e0: "K", d9: "k", a0: "R", a3: "P", c0: "n" });
  assert.deepEqual(movesFrom(state, "a0"), ["a1", "a2", "b0", "c0"]);
  assert.match(explainIllegalMove(state.board, "red", iccsToSquare("a0"), iccsToSquare("a5")), /path is blocked at a3/);
  assert.match(explainIllegalMove(state.board, "red", iccsToSquare("a0"), iccsToSquare("b1")), /rank or a file/);
  assert.match(explainIllegalMove(state.board, "red", iccsToSquare("a0"), iccsToSquare("a3")), /own soldier/);
});

test("cannons move freely but capture only over exactly one screen", () => {
  const state = game({ e0: "K", d9: "k", b2: "C", b5: "P", b7: "c", b9: "n", b1: "r" });
  const targets = movesFrom(state, "b2");
  assert.ok(targets.includes("b3") && targets.includes("b4"));
  assert.ok(targets.includes("b7"), "captures over one screen");
  assert.ok(!targets.includes("b9"), "two screens block the capture");
  assert.ok(!targets.includes("b1"), "no capture without a screen");
  assert.ok(!targets.includes("b6"), "cannot jump when not capturing");
  assert.match(explainIllegalMove(state.board, "red", iccsToSquare("b2"), iccsToSquare("b9")), /exactly one screen; there are 2/);
  assert.match(explainIllegalMove(state.board, "red", iccsToSquare("b2"), iccsToSquare("b1")), /there are 0/);
  assert.match(explainIllegalMove(state.board, "red", iccsToSquare("b2"), iccsToSquare("b6")), /may not jump/);

  const opening = createXiangqiGame();
  assert.ok(legalMoves(opening).some((move) => move.move === "b2b9" && move.captured === "n"));
  assert.ok(!legalMoves(opening).some((move) => move.move === "b2b7"));
});

test("soldiers move forward, sideways only after the river, and never backward", () => {
  const before = game({ e0: "K", d9: "k", e3: "P" });
  assert.deepEqual(movesFrom(before, "e3"), ["e4"]);
  assert.match(explainIllegalMove(before.board, "red", iccsToSquare("e3"), iccsToSquare("f3")), /after crossing the river/);
  const after = game({ e0: "K", d9: "k", e5: "P" });
  assert.deepEqual(movesFrom(after, "e5"), ["d5", "e6", "f5"]);
  assert.match(explainIllegalMove(after.board, "red", iccsToSquare("e5"), iccsToSquare("e4")), /never move backward/);
  const lastRank = game({ e0: "K", d9: "k", a9: "P" });
  assert.deepEqual(movesFrom(lastRank, "a9"), ["b9"]);
  const blackBefore = game({ e0: "K", d9: "k", c6: "p" }, "black");
  assert.deepEqual(movesFrom(blackBefore, "c6"), ["c5"]);
  const blackAfter = game({ e0: "K", d9: "k", c4: "p" }, "black");
  assert.deepEqual(movesFrom(blackAfter, "c4"), ["b4", "c3", "d4"]);
});

test("every attacking piece type gives check, and blocked attacks do not", () => {
  const check = (pieces) => isInCheck(boardOf(pieces), "red");
  assert.equal(check({ e0: "K", d9: "k", e5: "r" }), true, "chariot");
  assert.equal(check({ e0: "K", d9: "k", e5: "r", e3: "P" }), false, "chariot blocked");
  assert.equal(check({ e0: "K", d9: "k", e7: "c", e3: "P" }), true, "cannon over a screen");
  assert.equal(check({ e0: "K", d9: "k", e7: "c" }), false, "cannon without a screen");
  assert.equal(check({ e0: "K", d9: "k", e7: "c", e3: "P", e4: "p" }), false, "cannon over two screens");
  assert.equal(check({ e0: "K", d9: "k", f2: "n" }), true, "horse");
  assert.equal(check({ e0: "K", d9: "k", f2: "n", f1: "A" }), false, "horse with blocked leg");
  assert.equal(check({ e0: "K", d9: "k", d2: "n", d1: "A" }), false, "horse leg is the point next to the horse");
  assert.equal(check({ e0: "K", d9: "k", e1: "p" }), true, "soldier in front");
  assert.equal(check({ e0: "K", d9: "k", d0: "p" }), true, "crossed soldier beside");
  assert.equal(check({ e1: "K", d9: "k", e0: "p" }), false, "soldier behind");
  assert.equal(check({ e0: "K", e9: "k" }), true, "flying general");
});

test("a side in check must answer the check", () => {
  const state = game({ e0: "K", d9: "k", e5: "r", a3: "R", c2: "N" });
  const moves = legalMoves(state).map((move) => move.move).sort();
  // King steps aside, the chariot blocks on e3, or the horse blocks on e3 or e1.
  assert.deepEqual(moves, ["a3e3", "c2e1", "c2e3", "e0f0"]);
  assert.match(explainIllegalMove(state.board, "red", iccsToSquare("a3"), iccsToSquare("a4")), /does not get your general out of check/);
  assert.match(validateAction(state, { type: "move", move: "e0e1" }).message, /out of check/);
});

test("checkmate ends the game and the mated side loses (flying general covers an escape)", () => {
  const state = game({ d0: "K", e9: "k", a1: "R", b8: "R" });
  const mated = play(state, "a1a9");
  assert.equal(mated.status, "complete");
  assert.deepEqual(mated.result, { winner: "red", reason: "checkmate" });
  assert.deepEqual(scoreGame(mated), { red: 1, black: 0 });
  assert.equal(mated.history.at(-1).check, true);
  assert.match(explainIllegalMove(mated.board, "black", iccsToSquare("e9"), iccsToSquare("d9")), /flying general/);
  assert.deepEqual(legalActions(mated), []);
  assert.throws(() => play(mated, "e9e8"), (error) => error.code === "game_over");
});

test("stalemate loses for the side with no legal move", () => {
  const state = game({ d0: "K", e9: "k", f5: "R", e6: "P" });
  const stalemated = play(state, "e6e7");
  assert.equal(isInCheck(stalemated.board, "black"), false);
  assert.deepEqual(stalemated.result, { winner: "red", reason: "stalemate" });
  assert.deepEqual(scoreGame(stalemated), { red: 1, black: 0 });
});

test("a game created in a finished position is already complete", () => {
  const mated = game({ d0: "K", e9: "k", a9: "R", b8: "R" }, "black");
  assert.equal(mated.status, "complete");
  assert.deepEqual(mated.result, { winner: "red", reason: "checkmate" });
});

const PERPETUAL = ["a7a8", "e8e9", "a8a9", "e9e8", "a9a8", "e8e9", "a8a9", "e9e8"];

test("perpetual check: the side checking on every move of the repetition loses", () => {
  const start = game({ d0: "K", e8: "k", a7: "R" });
  const beforeRepeat = play(start, ...PERPETUAL);
  assert.equal(beforeRepeat.status, "active");
  assert.ok(beforeRepeat.history.filter((entry) => entry.side === "red").every((entry) => entry.check));
  assert.deepEqual(previewMove(beforeRepeat, "a9a8").result, { winner: "black", reason: "perpetual_check", loser: "red" });
  assert.equal(previewMove(beforeRepeat, "a9a7").result, null, "deviating avoids the loss");

  const lost = play(beforeRepeat, "a9a8");
  assert.deepEqual(lost.result, { winner: "black", reason: "perpetual_check", loser: "red" });
  assert.deepEqual(scoreGame(lost), { red: 0, black: 1 });
});

test("a repetition without perpetual check is a draw", () => {
  const start = game({ d0: "K", f9: "k", a4: "R", i5: "r" });
  const shuffle = ["a4a3", "i5i6", "a3a4", "i6i5"];
  const twice = play(start, ...shuffle);
  assert.equal(twice.status, "active");
  const drawn = play(twice, ...shuffle);
  assert.deepEqual(drawn.result, { winner: null, reason: "repetition" });
  assert.deepEqual(scoreGame(drawn), { red: 0.5, black: 0.5 });
});

test("the repetition limit is configurable", () => {
  const start = game({ d0: "K", f9: "k", a4: "R", i5: "r" }, "red", { repetitionLimit: 2 });
  const drawn = play(start, "a4a3", "i5i6", "a3a4", "i6i5");
  assert.deepEqual(drawn.result, { winner: null, reason: "repetition" });
});

test("too many plies without a capture is a draw", () => {
  const start = game({ d0: "K", f9: "k", a4: "R", i5: "r" }, "red", { noCaptureDrawPlies: 4 });
  const drawn = play(start, "a4a3", "i5i6", "a3a2", "i6i7");
  assert.deepEqual(drawn.result, { winner: null, reason: "no_capture_limit" });
  const reset = play(game({ d0: "K", f9: "k", a4: "R", a7: "r", i9: "c" }, "red", { noCaptureDrawPlies: 2 }), "a4a7");
  assert.equal(reset.pliesSinceCapture, 0);
  assert.equal(reset.status, "active");
});

test("the game is drawn when no attacking pieces remain", () => {
  const state = game({ e0: "K", d9: "k", e1: "p", f0: "A", c9: "b" });
  const drawn = play(state, "e0e1");
  assert.deepEqual(drawn.result, { winner: null, reason: "insufficient_material" });
});

test("the ply limit ends the game in a draw", () => {
  const state = createXiangqiGame({ maxPlies: 2 });
  const drawn = play(state, "h2e2", "h9g7");
  assert.deepEqual(drawn.result, { winner: null, reason: "move_limit" });
});

test("either side may resign at any time", () => {
  const state = createXiangqiGame();
  const resigned = applyAction(state, { type: "resign", side: "black" });
  assert.deepEqual(resigned.result, { winner: "red", reason: "resignation" });
  assert.deepEqual(scoreGame(resigned), { red: 1, black: 0 });
  const own = applyAction(state, { type: "resign" });
  assert.equal(own.result.winner, "black");
  assert.ok(legalActions(state).some((action) => action.type === "resign" && action.side === "red"));
});

test("illegal actions are rejected with precise codes", () => {
  const state = createXiangqiGame();
  const cases = [
    [{ type: "move", move: "zz" }, "bad_notation"],
    [{ type: "move", move: "e5e6" }, "illegal_move", /no piece on e5/],
    [{ type: "move", move: "h7e7" }, "illegal_move", /Black Cannon/],
    [{ type: "move", move: "a0a0" }, "illegal_move", /different point/],
    [{ type: "move", move: "h2e2", side: "black" }, "not_your_turn"],
    [{ type: "castle" }, "invalid_action"],
    [null, "invalid_action"],
  ];
  for (const [action, code, pattern] of cases) {
    const verdict = validateAction(state, action);
    assert.equal(verdict.ok, false, JSON.stringify(action));
    assert.equal(verdict.code, code, JSON.stringify(action));
    if (pattern) assert.match(verdict.message, pattern);
    assert.throws(() => applyAction(state, action), (error) => error instanceof XiangqiRuleError && error.code === code);
  }
  assert.equal(validateAction(state, { type: "move", from: "h2", to: "e2" }).ok, true);
});

test("applying an action never mutates the input state", () => {
  const state = createXiangqiGame();
  const before = JSON.stringify(state);
  const next = play(state, "h2e2");
  assert.equal(JSON.stringify(state), before);
  assert.equal(next.turn, "black");
  assert.equal(next.ply, 1);
  assert.deepEqual(next.history[0], { ply: 1, side: "red", move: "h2e2", piece: "C", captured: null, check: false });
  assert.equal(next.positions.length, 2);
});

test("seats are assigned fixed or by the injected RNG", () => {
  const fixed = createXiangqiGame({ participants: ["ada", "bo"] });
  assert.deepEqual(fixed.seats, { red: "ada", black: "bo" });
  const swapped = createXiangqiGame({ participants: ["ada", "bo"], colorAssignment: "random", rng: () => 0.1 });
  assert.deepEqual(swapped.seats, { red: "bo", black: "ada" });
  const kept = createXiangqiGame({ participants: ["ada", "bo"], colorAssignment: "random", rng: () => 0.9 });
  assert.deepEqual(kept.seats, { red: "ada", black: "bo" });
  assert.equal(sideForSeat(swapped, "ada"), "black");
  assert.equal(sideForSeat(swapped, "nobody"), null);
  assert.deepEqual(createXiangqiGame().seats, { red: null, black: null });
});

test("a saved game restores by replay and keeps playing", () => {
  const state = play(createXiangqiGame({ participants: ["ada", "bo"], noCaptureDrawPlies: 80 }), "h2e2", "h9g7", "h0g2", "i9h9");
  const saved = JSON.parse(JSON.stringify(serializeGame(state)));
  const restored = restoreGame(saved);
  assert.deepEqual(restored, state);
  const continued = play(restored, "i0h0");
  assert.equal(continued.ply, 5);

  const finished = play(game({ d0: "K", e9: "k", a1: "R", b8: "R" }), "a1a9");
  assert.deepEqual(restoreGame(serializeGame(finished)).result, finished.result);
  const resigned = applyAction(state, { type: "resign", side: "red" });
  assert.deepEqual(restoreGame(serializeGame(resigned)).result, resigned.result);
});

test("tampered or incompatible saves are rejected", () => {
  const state = play(createXiangqiGame(), "h2e2", "h9g7");
  const tamper = (mutate) => {
    const payload = serializeGame(state);
    mutate(payload);
    return () => restoreGame(payload);
  };
  assert.throws(tamper((payload) => { payload.version = 99; }), /unsupported version/);
  assert.throws(tamper((payload) => { payload.gameId = "go"; }), /not xiangqi/);
  assert.throws(tamper((payload) => { payload.state.board[0] = null; }), /board does not match/);
  assert.throws(tamper((payload) => { payload.state.history[1].move = "h9h5"; }), /cannot be replayed/);
  assert.throws(tamper((payload) => { payload.state.status = "complete"; }), /status does not match/);
  assert.throws(tamper((payload) => { payload.state.startFen = "bad"; }), /Invalid Xiangqi save/);
  assert.throws(() => restoreGame(null), /payload is missing/);
});

test("public and player views expose the full board but only the mover's legal moves", () => {
  const state = play(createXiangqiGame({ participants: ["ada", "bo"] }), "h2e2");
  const view = publicView(state);
  assert.equal(view.fen, boardToFen(state.board, "black"));
  assert.equal(view.turn, "black");
  assert.equal(view.moveNumber, 1);
  assert.equal(view.lastMove.move, "h2e2");
  assert.deepEqual(view.material, materialCount(state.board));
  assert.equal(view.score, null);
  view.board[0] = "X";
  assert.equal(state.board[0], "R", "views are copies");

  assert.equal(playerView(state, "black").yourTurn, true);
  assert.equal(playerView(state, "black").legalMoves.length, legalMoves(state).length);
  assert.deepEqual(playerView(state, "red").legalMoves, []);
  assert.throws(() => playerView(state, "green"), /Unknown side/);

  const captured = play(createXiangqiGame(), "b2b9");
  assert.deepEqual(publicView(captured).captured, { red: [], black: ["n"] });
});
