// Model-facing view of a Xiangqi game for one seat: a snapshot of what that side may
// know, a numbered list of its legal moves, the JSON schema for its decision, and a
// parser that maps the model's answer to a legal engine action or a precise error the
// caller can feed back on an automatic retry.

import {
  FILES,
  PIECE_INFO,
  SIDES,
  boardToFen,
  describeResult,
  explainIllegalMove,
  isInCheck,
  legalMoves,
  materialCount,
  opposite,
  parseIccsMove,
  pieceLabel,
  previewMove,
  sideOf,
  squareToIccs,
} from "./engine.js";

export const TABLE_TALK_MAX = 140;
export const EXPLANATION_MAX = 420;
export const XIANGQI_MAX_ATTEMPTS = 3;

const TYPE_ORDER = ["R", "N", "C", "P", "B", "A", "K"];

export const XIANGQI_DECISION_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    move: { type: "string", description: "The chosen move in ICCS notation, copied from the legal move list, e.g. h2e2." },
    choice: {
      anyOf: [{ type: "integer" }, { type: "null" }],
      description: "The number of the chosen move in the legal move list, or null.",
    },
    explanation: { type: "string", minLength: 1, maxLength: EXPLANATION_MAX },
    tableTalk: {
      anyOf: [{ type: "string", maxLength: TABLE_TALK_MAX }, { type: "null" }],
      description: "Optional in-character remark to the opponent, at most 140 characters, or null.",
    },
  },
  required: ["move", "choice", "explanation", "tableTalk"],
  additionalProperties: false,
});

export const XIANGQI_RULES_SUMMARY = Object.freeze({
  coordinates: "ICCS: files a-i from Red's left to right, ranks 0-9 from Red's back rank (0) to Black's back rank (9). A move is from-point + to-point, e.g. h2e2.",
  pieces: "Uppercase = Red, lowercase = Black. K general, A advisor, B elephant, N horse, R chariot, C cannon, P soldier.",
  movement: [
    "General: one point orthogonally, never leaves the palace (files d-f; Red ranks 0-2, Black ranks 7-9).",
    "Advisor: one point diagonally, never leaves the palace.",
    "Elephant: exactly two points diagonally, cannot cross the river, blocked if the point between (the eye) is occupied.",
    "Horse: one point straight then one diagonally outward; blocked if the adjacent straight point (the leg) is occupied.",
    "Chariot: any distance along a rank or file, no jumping.",
    "Cannon: moves like a chariot without capturing; captures only by jumping exactly one piece (the screen).",
    "Soldier: one point forward; after crossing the river it may also move one point sideways; never backward.",
  ].join(" "),
  special: "The two generals may never face each other on an open file (flying general). You may not leave your general in check. A side with no legal move loses (checkmate or stalemate). Repeating a position by checking on every move (perpetual check) loses; other repetitions are drawn.",
});

// Legal moves in a stable, readable order (by piece type, then from-point, then to-point),
// numbered from 1. The same state always yields the same numbering.
export function numberedLegalMoves(state) {
  return legalMoves(state)
    .sort((left, right) => {
      const byType = TYPE_ORDER.indexOf(left.piece.toUpperCase()) - TYPE_ORDER.indexOf(right.piece.toUpperCase());
      if (byType) return byType;
      return left.move < right.move ? -1 : left.move > right.move ? 1 : 0;
    })
    .map((move, index) => ({ n: index + 1, ...move }));
}

function annotate(state, move) {
  const preview = previewMove(state, move.move);
  const notes = [];
  if (move.captured) notes.push(`captures ${pieceLabel(move.captured)}`);
  if (move.givesCheck) notes.push("check");
  const result = preview?.result;
  if (result?.reason === "checkmate") notes.push("checkmate, wins the game");
  else if (result?.reason === "stalemate") notes.push("leaves the opponent without a legal move, wins the game");
  else if (result?.reason === "perpetual_check" && result.winner !== state.turn) notes.push("FORBIDDEN REPETITION: loses the game by perpetual check");
  else if (result?.reason === "perpetual_check") notes.push("opponent's perpetual check repeats; wins the game");
  else if (result) notes.push(`ends the game: ${describeResult(result)}`);
  else if (preview && preview.repetitionCount > 1) notes.push(`repeats a position (occurrence ${preview.repetitionCount})`);
  return {
    n: move.n,
    move: move.move,
    piece: move.piece,
    pieceName: move.pieceName,
    from: move.from,
    to: move.to,
    captures: move.captured ?? null,
    givesCheck: move.givesCheck,
    note: notes.join("; ") || null,
  };
}

export function boardDiagram(board) {
  const lines = [`   ${FILES.split("").join(" ")}`];
  for (let rank = 9; rank >= 0; rank -= 1) {
    const cells = [];
    for (let file = 0; file < 9; file += 1) cells.push(board[rank * 9 + file] ?? ".");
    lines.push(`${rank}  ${cells.join(" ")}`);
    if (rank === 5) lines.push("   ~ ~ ~ river ~ ~ ~");
  }
  return lines.join("\n");
}

function pieceList(board, side) {
  const pieces = [];
  for (let square = 0; square < 90; square += 1) {
    const piece = board[square];
    if (piece && sideOf(piece) === side) pieces.push(`${PIECE_INFO[piece.toUpperCase()].name} ${piece} ${squareToIccs(square)}`);
  }
  return pieces;
}

// Snapshot for the model seated as `side`. Xiangqi has no hidden information, so the
// seat sees the whole board; it only gets a move list when it is its turn.
// extras.character: { name, title, personality } for the prompt (optional)
// extras.tableTalk: recent public remarks [{ side, text }] (optional)
export function buildXiangqiAiView(state, side, extras = {}) {
  if (!SIDES.includes(side)) throw new Error(`Unknown Xiangqi side "${side}"`);
  const historyLimit = Number.isInteger(extras.historyLimit) && extras.historyLimit > 0 ? extras.historyLimit : 20;
  const yourTurn = state.status === "active" && state.turn === side;
  const moves = yourTurn ? numberedLegalMoves(state).map((move) => annotate(state, move)) : [];
  return {
    game: "Xiangqi 象棋",
    you: {
      side,
      pieces: side === "red" ? "uppercase letters, starting on ranks 0-4" : "lowercase letters, starting on ranks 5-9",
      character: extras.character ?? null,
    },
    status: state.status,
    result: state.result ? { ...state.result, text: describeResult(state.result) } : null,
    yourTurn,
    turn: state.turn,
    ply: state.ply,
    moveNumber: Math.floor(state.ply / 2) + 1,
    youAreInCheck: state.status === "active" && isInCheck(state.board, side),
    fen: boardToFen(state.board, state.turn),
    board: boardDiagram(state.board),
    pieces: { yours: pieceList(state.board, side), opponent: pieceList(state.board, opposite(side)) },
    material: materialCount(state.board),
    recentMoves: state.history.slice(-historyLimit).map((entry) => ({
      ply: entry.ply,
      side: entry.side,
      move: entry.move,
      piece: entry.piece ?? null,
      captured: entry.captured ?? null,
      check: Boolean(entry.check),
    })),
    pliesSinceCapture: state.pliesSinceCapture,
    limits: { ...state.options },
    tableTalk: Array.isArray(extras.tableTalk)
      ? extras.tableTalk.slice(-6).map((entry) => ({ side: entry.side, text: String(entry.text ?? "").slice(0, TABLE_TALK_MAX) }))
      : [],
    rules: XIANGQI_RULES_SUMMARY,
    legalMoves: moves,
    legalMoveCount: moves.length,
  };
}

export function buildXiangqiInstructions(view, retryContext = null) {
  const character = view.you.character;
  const intro = character
    ? `You are ${character.name}${character.title ? `, ${character.title}` : ""}, playing Xiangqi (Chinese chess) as ${view.you.side}.\nCharacter: ${character.personality ?? ""}`
    : `You are playing Xiangqi (Chinese chess) as ${view.you.side}.`;
  const moveLines = view.legalMoves
    .map((move) => `${move.n}. ${move.move} ${move.pieceName}${move.note ? ` (${move.note})` : ""}`)
    .join("\n");
  const retryText = retryContext
    ? `\n\nAUTOMATIC RETRY ${retryContext.retryNumber}/${retryContext.maxRetries}: your previous answer was rejected: ${retryContext.error}. Choose a move from the list exactly as written.`
    : "";
  return `${intro}

${view.rules.coordinates}
${view.rules.pieces}
${view.rules.movement}
${view.rules.special}

Board (rank 9 at the top, Black's side; rank 0 at the bottom, Red's side):
${view.board}
${view.youAreInCheck ? "\nYou are in check.\n" : ""}
Your legal moves (choose exactly one):
${moveLines}

Answer with "move" set to the ICCS move exactly as listed and "choice" set to its number. "explanation" is a short public rationale (at most 45 words). "tableTalk" is an optional in-character remark of at most ${TABLE_TALK_MAX} characters, or null. Return only the requested structured decision.${retryText}`;
}

function failure(code, error) {
  return { ok: false, code, error };
}

function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

// Maps a model answer (object or JSON string) to a legal action for `side`.
// Returns { ok: true, action: { type: "move", move }, choice, explanation, tableTalk }
// or { ok: false, code, error } where error says precisely what to fix.
export function parseXiangqiDecision(raw, state, side) {
  if (state.status !== "active") return failure("game_over", "The game is already over.");
  if (state.turn !== side) return failure("not_your_turn", `It is ${state.turn}'s turn, not ${side}'s.`);

  let decision = raw;
  if (typeof raw === "string") {
    try {
      decision = JSON.parse(raw);
    } catch {
      return failure("malformed", "The answer is not valid JSON. Return an object with move, choice, explanation and tableTalk.");
    }
  }
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return failure("malformed", "The answer must be a JSON object with move, choice, explanation and tableTalk.");
  }

  const moves = numberedLegalMoves(state);
  const choice = decision.choice;
  if (choice !== null && choice !== undefined && !(Number.isInteger(choice))) {
    return failure("bad_choice", `"choice" must be an integer from 1 to ${moves.length} or null.`);
  }
  const byChoice = Number.isInteger(choice) ? moves.find((move) => move.n === choice) : null;
  if (Number.isInteger(choice) && !byChoice) {
    return failure("bad_choice", `Choice ${choice} is not in the list; there are ${moves.length} legal moves numbered 1 to ${moves.length}.`);
  }

  const moveText = typeof decision.move === "string" ? decision.move.trim() : "";
  let chosen = null;
  if (moveText) {
    const squares = parseIccsMove(moveText);
    if (!squares) {
      return failure("bad_notation", `"${moveText.slice(0, 20)}" is not ICCS notation; write the from-point then the to-point, e.g. h2e2.`);
    }
    const reason = explainIllegalMove(state.board, side, squares.from, squares.to);
    const iccs = `${squareToIccs(squares.from)}${squareToIccs(squares.to)}`;
    if (reason) return failure("illegal_move", `${iccs} is illegal: ${reason}`);
    chosen = moves.find((move) => move.move === iccs);
    if (byChoice && byChoice.move !== chosen.move) {
      return failure("choice_mismatch", `Choice ${choice} is ${byChoice.move}, but move says ${chosen.move}. Make them agree.`);
    }
  } else if (byChoice) {
    chosen = byChoice;
  } else {
    return failure("missing_move", "No move given: set \"move\" to one of the listed ICCS moves.");
  }

  return {
    ok: true,
    action: { type: "move", move: chosen.move },
    choice: chosen.n,
    explanation: cleanText(decision.explanation, EXPLANATION_MAX) ?? "Move chosen.",
    tableTalk: cleanText(decision.tableTalk, TABLE_TALK_MAX),
  };
}
