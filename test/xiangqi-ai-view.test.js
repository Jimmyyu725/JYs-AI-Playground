import test from "node:test";
import assert from "node:assert/strict";
import { applyAction, boardToFen, createXiangqiGame, iccsToSquare, legalMoves } from "../src/games/xiangqi/engine.js";
import {
  TABLE_TALK_MAX,
  XIANGQI_DECISION_SCHEMA,
  boardDiagram,
  buildXiangqiAiView,
  buildXiangqiInstructions,
  numberedLegalMoves,
  parseXiangqiDecision,
} from "../src/games/xiangqi/ai-view.js";

function fenOf(pieces, turn = "red") {
  const board = Array(90).fill(null);
  for (const [point, piece] of Object.entries(pieces)) board[iccsToSquare(point)] = piece;
  return boardToFen(board, turn);
}

function play(state, ...moves) {
  return moves.reduce((current, move) => applyAction(current, { type: "move", move }), state);
}

const decision = (overrides = {}) => ({ move: "h2e2", choice: null, explanation: "Central cannon.", tableTalk: null, ...overrides });

test("the decision schema is strict and caps table talk at 140 characters", () => {
  assert.equal(XIANGQI_DECISION_SCHEMA.type, "object");
  assert.equal(XIANGQI_DECISION_SCHEMA.additionalProperties, false);
  assert.deepEqual([...XIANGQI_DECISION_SCHEMA.required].sort(), Object.keys(XIANGQI_DECISION_SCHEMA.properties).sort());
  assert.equal(TABLE_TALK_MAX, 140);
  assert.deepEqual(XIANGQI_DECISION_SCHEMA.properties.tableTalk.anyOf, [{ type: "string", maxLength: 140 }, { type: "null" }]);
});

test("legal moves are numbered from 1 in a stable piece-grouped order", () => {
  const state = createXiangqiGame();
  const moves = numberedLegalMoves(state);
  assert.equal(moves.length, 44);
  assert.deepEqual(moves.map((move) => move.n), Array.from({ length: 44 }, (_, index) => index + 1));
  assert.deepEqual(new Set(moves.map((move) => move.move)), new Set(legalMoves(state).map((move) => move.move)));
  const order = moves.map((move) => move.piece);
  assert.equal(order[0], "R");
  assert.equal(order.at(-1), "K");
  assert.deepEqual(numberedLegalMoves(state), moves, "numbering is deterministic");
});

test("the seat to move gets a complete, serializable snapshot with annotated moves", () => {
  const state = play(createXiangqiGame(), "h2e2");
  const view = buildXiangqiAiView(state, "black", {
    character: { name: "Rook Mercer", title: "The Enforcer", personality: "Direct." },
    tableTalk: [{ side: "red", text: "Central cannon, classic." }],
  });
  assert.equal(view.yourTurn, true);
  assert.equal(view.you.side, "black");
  assert.match(view.you.pieces, /lowercase/);
  assert.equal(view.fen, boardToFen(state.board, "black"));
  assert.match(view.board, /river/);
  assert.equal(view.recentMoves.length, 1);
  assert.equal(view.recentMoves[0].move, "h2e2");
  assert.equal(view.legalMoveCount, view.legalMoves.length);
  assert.equal(view.legalMoves.length, legalMoves(state).length);
  assert.equal(view.pieces.yours.length, 16);
  assert.ok(view.pieces.yours.every((entry) => / [kabnrcp] [a-i][0-9]$/.test(entry)));
  assert.deepEqual(view.tableTalk, [{ side: "red", text: "Central cannon, classic." }]);
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view);

  const capture = view.legalMoves.find((move) => move.move === "b7b0");
  assert.equal(capture.captures, "N");
  assert.match(capture.note, /captures Red Horse/);
});

test("a seat that is not to move gets no legal moves", () => {
  const state = createXiangqiGame();
  const view = buildXiangqiAiView(state, "black");
  assert.equal(view.yourTurn, false);
  assert.deepEqual(view.legalMoves, []);
  assert.throws(() => buildXiangqiAiView(state, "green"), /Unknown Xiangqi side/);
});

test("finished games report the result and no moves", () => {
  const state = play(createXiangqiGame({ fen: fenOf({ d0: "K", e9: "k", a1: "R", b8: "R" }) }), "a1a9");
  const view = buildXiangqiAiView(state, "black");
  assert.equal(view.status, "complete");
  assert.match(view.result.text, /Red wins by checkmate/);
  assert.deepEqual(view.legalMoves, []);
});

test("moves are annotated with check, mate and forbidden perpetual check", () => {
  const mateIn1 = createXiangqiGame({ fen: fenOf({ d0: "K", e9: "k", a1: "R", b8: "R" }) });
  const mate = buildXiangqiAiView(mateIn1, "red").legalMoves.find((move) => move.move === "a1a9");
  assert.equal(mate.givesCheck, true);
  assert.match(mate.note, /checkmate, wins the game/);

  const start = createXiangqiGame({ fen: fenOf({ d0: "K", e8: "k", a7: "R" }) });
  const looping = play(start, "a7a8", "e8e9", "a8a9", "e9e8", "a9a8", "e8e9", "a8a9", "e9e8");
  const view = buildXiangqiAiView(looping, "red");
  assert.match(view.legalMoves.find((move) => move.move === "a9a8").note, /FORBIDDEN REPETITION/);
  assert.doesNotMatch(view.legalMoves.find((move) => move.move === "a9a7").note ?? "", /FORBIDDEN/);
  assert.match(buildXiangqiInstructions(view), /a9a8 Chariot \(check; FORBIDDEN REPETITION/);

  const once = play(start, "a7a8", "e8e9", "a8a9", "e9e8");
  assert.match(buildXiangqiAiView(once, "red").legalMoves.find((move) => move.move === "a9a8").note, /repeats a position \(occurrence 2\)/);
});

test("the in-check flag and the instructions reflect the position", () => {
  const state = createXiangqiGame({ fen: fenOf({ e0: "K", d9: "k", e5: "r", a3: "R" }) });
  const view = buildXiangqiAiView(state, "red", { character: { name: "Mei", title: "The Strategist", personality: "Calm." } });
  assert.equal(view.youAreInCheck, true);
  const prompt = buildXiangqiInstructions(view, { retryNumber: 1, maxRetries: 2, error: "a3a4 is illegal: you are in check" });
  assert.match(prompt, /You are Mei, The Strategist, playing Xiangqi/);
  assert.match(prompt, /You are in check/);
  assert.match(prompt, /1\. a3e3 Chariot/);
  assert.match(prompt, /AUTOMATIC RETRY 1\/2: .*a3a4 is illegal/);
  assert.equal(boardDiagram(state.board).split("\n").length, 12);
});

test("a listed move is accepted, with or without a matching choice number", () => {
  const state = createXiangqiGame();
  const moves = numberedLegalMoves(state);
  const target = moves.find((move) => move.move === "h2e2");
  const byMove = parseXiangqiDecision(decision(), state, "red");
  assert.deepEqual(byMove, { ok: true, action: { type: "move", move: "h2e2" }, choice: target.n, explanation: "Central cannon.", tableTalk: null });
  assert.equal(parseXiangqiDecision(decision({ choice: target.n }), state, "red").ok, true);
  const byChoice = parseXiangqiDecision(decision({ move: "", choice: target.n }), state, "red");
  assert.deepEqual(byChoice.action, { type: "move", move: "h2e2" });
  const sloppy = parseXiangqiDecision(decision({ move: " H2-E2 " }), state, "red");
  assert.deepEqual(sloppy.action, { type: "move", move: "h2e2" });
  const fromJson = parseXiangqiDecision(JSON.stringify(decision()), state, "red");
  assert.equal(fromJson.ok, true);
  // The parsed action is accepted by the engine.
  assert.equal(applyAction(state, byMove.action).turn, "black");
});

test("table talk is optional, trimmed, and capped at 140 characters", () => {
  const state = createXiangqiGame();
  const long = "炮".repeat(200);
  const parsed = parseXiangqiDecision(decision({ tableTalk: long }), state, "red");
  assert.equal(Array.from(parsed.tableTalk).length, 140);
  assert.equal(parseXiangqiDecision(decision({ tableTalk: "  Your move,\n friend.  " }), state, "red").tableTalk, "Your move, friend.");
  assert.equal(parseXiangqiDecision(decision({ tableTalk: "   " }), state, "red").tableTalk, null);
  assert.equal(parseXiangqiDecision(decision({ tableTalk: 7 }), state, "red").tableTalk, null);
  const noExplanation = parseXiangqiDecision(decision({ explanation: undefined }), state, "red");
  assert.equal(noExplanation.explanation, "Move chosen.");
});

test("bad answers return precise, retryable errors", () => {
  const state = createXiangqiGame();
  const count = numberedLegalMoves(state).length;
  const cases = [
    ["not json", "malformed", /not valid JSON/],
    [[1, 2], "malformed", /JSON object/],
    [null, "malformed", /JSON object/],
    [decision({ move: "" }), "missing_move", /No move given/],
    [decision({ move: "cannon to e2" }), "bad_notation", /not ICCS notation/],
    [decision({ move: "b0d2" }), "illegal_move", /b0d2 is illegal: .*L shape/],
    [decision({ move: "b0d1" }), "illegal_move", /b0d1 is illegal: The horse's leg at c0 is blocked/],
    [decision({ move: "b2b7" }), "illegal_move", /exactly one screen; there are 0/],
    [decision({ move: "e3e2" }), "illegal_move", /never move backward/],
    [decision({ move: "c0b3" }), "illegal_move", /two points diagonally/],
    [decision({ move: "h7h0" }), "illegal_move", /Black Cannon 炮; it is red's turn/],
    [decision({ move: "e5e6" }), "illegal_move", /no piece on e5/],
    [decision({ choice: count + 1 }), "bad_choice", new RegExp(`numbered 1 to ${count}`)],
    [decision({ choice: 1.5 }), "bad_choice", /must be an integer/],
    [decision({ choice: "3" }), "bad_choice", /must be an integer/],
  ];
  for (const [raw, code, pattern] of cases) {
    const result = parseXiangqiDecision(raw, state, "red");
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(result.code, code, JSON.stringify(raw));
    assert.match(result.error, pattern, JSON.stringify(raw));
  }

  const other = numberedLegalMoves(state).find((move) => move.move !== "h2e2");
  const mismatch = parseXiangqiDecision(decision({ choice: other.n }), state, "red");
  assert.equal(mismatch.code, "choice_mismatch");
  assert.equal(mismatch.error, `Choice ${other.n} is ${other.move}, but move says h2e2. Make them agree.`);
});

test("decisions out of turn or after the game are refused", () => {
  const state = createXiangqiGame();
  assert.equal(parseXiangqiDecision(decision(), state, "black").code, "not_your_turn");
  const over = applyAction(state, { type: "resign" });
  assert.equal(parseXiangqiDecision(decision(), over, "red").code, "game_over");
});

test("a move that leaves the general in check is explained", () => {
  const state = createXiangqiGame({ fen: fenOf({ e0: "K", d9: "k", e5: "r", a3: "R" }) });
  const result = parseXiangqiDecision(decision({ move: "a3a4" }), state, "red");
  assert.equal(result.code, "illegal_move");
  assert.match(result.error, /does not get your general out of check/);
  const flying = createXiangqiGame({ fen: fenOf({ e0: "K", e9: "k", e5: "N", a9: "r" }) });
  assert.match(parseXiangqiDecision(decision({ move: "e5d7" }), flying, "red").error, /flying general/);
});
