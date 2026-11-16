// Xiangqi (Chinese chess, 象棋) rules engine.
//
// Pure functions over a plain, JSON-serializable state object. Every function that
// "changes" the game returns a new state and leaves its input untouched, so the
// server can keep the authoritative state, save it, and replay it.
//
// Coordinates follow ICCS: files a-i from Red's left to right, ranks 0-9 from Red's
// back rank (0) to Black's back rank (9). A move is written "h2e2" (from, to).
// Internally a square is the index rank * 9 + file.
//
// Pieces use the common FEN letters: uppercase for Red, lowercase for Black.
//   K general, A advisor, B elephant, N horse, R chariot, C cannon, P soldier.
//
// Game-ending rules implemented:
//   - checkmate and stalemate: the side to move with no legal move loses (困毙 also loses);
//   - repetition: when a position (board + side to move) occurs `repetitionLimit` times
//     (default 3), the plies since the earliest of those occurrences are judged. A side
//     that gave check with every one of its moves in that span while the other side did
//     not is the perpetual checker and loses ("长将判负"). Otherwise the game is drawn.
//     Perpetual chasing of unprotected pieces ("长捉") is NOT detected;
//   - no capture for `noCaptureDrawPlies` plies (default 120, i.e. 60 moves each): draw;
//   - neither side has a chariot, horse, cannon or soldier left: draw;
//   - `maxPlies` reached (default 600): draw;
//   - resignation.

export const XIANGQI_STATE_VERSION = 1;
export const FILES = "abcdefghi";
export const SIDES = Object.freeze(["red", "black"]);
export const INITIAL_FEN = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w";

export const PIECE_INFO = Object.freeze({
  K: Object.freeze({ name: "General", red: "帅", black: "将", value: 0 }),
  A: Object.freeze({ name: "Advisor", red: "仕", black: "士", value: 2 }),
  B: Object.freeze({ name: "Elephant", red: "相", black: "象", value: 2 }),
  N: Object.freeze({ name: "Horse", red: "马", black: "马", value: 4 }),
  R: Object.freeze({ name: "Chariot", red: "车", black: "车", value: 9 }),
  C: Object.freeze({ name: "Cannon", red: "炮", black: "炮", value: 4.5 }),
  P: Object.freeze({ name: "Soldier", red: "兵", black: "卒", value: 1 }),
});

export const DEFAULT_OPTIONS = Object.freeze({
  repetitionLimit: 3,
  noCaptureDrawPlies: 120,
  maxPlies: 600,
});

const ORTHOGONAL = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAGONAL = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const HORSE_OFFSETS = [[1, 2], [-1, 2], [1, -2], [-1, -2], [2, 1], [2, -1], [-2, 1], [-2, -1]];
const ATTACKERS = new Set(["R", "N", "C", "P"]);

export class XiangqiRuleError extends Error {
  constructor(message, code = "illegal_move") {
    super(message);
    this.name = "XiangqiRuleError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Basic helpers

export function opposite(side) {
  return side === "red" ? "black" : "red";
}

export function sideOf(piece) {
  return piece === piece.toUpperCase() ? "red" : "black";
}

function typeOf(piece) {
  return piece.toUpperCase();
}

const toSquare = (file, rank) => rank * 9 + file;
const fileOf = (square) => square % 9;
const rankOf = (square) => Math.floor(square / 9);
const onBoard = (file, rank) => file >= 0 && file < 9 && rank >= 0 && rank < 10;
const inPalace = (side, file, rank) => file >= 3 && file <= 5 && (side === "red" ? rank <= 2 : rank >= 7);
const onOwnHalf = (side, rank) => (side === "red" ? rank <= 4 : rank >= 5);
const forwardOf = (side) => (side === "red" ? 1 : -1);

export function pieceName(piece) {
  return PIECE_INFO[typeOf(piece)].name;
}

export function pieceLabel(piece) {
  const side = sideOf(piece);
  const info = PIECE_INFO[typeOf(piece)];
  return `${side === "red" ? "Red" : "Black"} ${info.name} ${info[side]}`;
}

export function squareToIccs(square) {
  return `${FILES[fileOf(square)]}${rankOf(square)}`;
}

export function iccsToSquare(text) {
  if (typeof text !== "string" || !/^[a-i][0-9]$/i.test(text.trim())) return null;
  const value = text.trim().toLowerCase();
  return toSquare(FILES.indexOf(value[0]), Number(value[1]));
}

// Accepts "h2e2", "H2-E2", "h2 e2", "h2xe2". Returns { from, to } squares or null.
export function parseIccsMove(text) {
  if (typeof text !== "string") return null;
  const compact = text.trim().toLowerCase().replace(/[\s\-–—x:>]/g, "");
  const match = /^([a-i][0-9])([a-i][0-9])$/.exec(compact);
  if (!match) return null;
  return { from: iccsToSquare(match[1]), to: iccsToSquare(match[2]) };
}

export function moveToIccs(from, to) {
  return `${squareToIccs(from)}${squareToIccs(to)}`;
}

// ---------------------------------------------------------------------------
// FEN

export function parseFen(fen) {
  if (typeof fen !== "string") throw new XiangqiRuleError("FEN must be a string", "invalid_position");
  const [placement, sideField = "w"] = fen.trim().split(/\s+/);
  const rows = placement.split("/");
  if (rows.length !== 10) throw new XiangqiRuleError("FEN must have 10 ranks", "invalid_position");
  const board = Array(90).fill(null);
  rows.forEach((row, rowIndex) => {
    const rank = 9 - rowIndex;
    let file = 0;
    for (const char of row) {
      if (/[1-9]/.test(char)) {
        file += Number(char);
        continue;
      }
      // Some sources write E for elephant and H for horse.
      const normalized = { E: "B", e: "b", H: "N", h: "n" }[char] ?? char;
      if (!/^[KABNRCPkabnrcp]$/.test(normalized)) {
        throw new XiangqiRuleError(`Unknown FEN piece "${char}"`, "invalid_position");
      }
      if (file > 8) throw new XiangqiRuleError(`FEN rank ${rank} is too long`, "invalid_position");
      board[toSquare(file, rank)] = normalized;
      file += 1;
    }
    if (file !== 9) throw new XiangqiRuleError(`FEN rank ${rank} does not have 9 files`, "invalid_position");
  });
  const turn = sideField === "b" ? "black" : sideField === "w" || sideField === "r" ? "red" : null;
  if (!turn) throw new XiangqiRuleError(`Unknown side to move "${sideField}"`, "invalid_position");
  return { board, turn };
}

export function boardToFen(board, turn) {
  const rows = [];
  for (let rank = 9; rank >= 0; rank -= 1) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 9; file += 1) {
      const piece = board[toSquare(file, rank)];
      if (!piece) {
        empty += 1;
        continue;
      }
      if (empty) row += empty;
      empty = 0;
      row += piece;
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return `${rows.join("/")} ${turn === "black" ? "b" : "w"}`;
}

export function positionKey(board, turn) {
  return boardToFen(board, turn);
}

// Checks piece counts and that every piece stands on a point it can legally occupy.
export function validatePosition(board, turn) {
  if (!Array.isArray(board) || board.length !== 90) return "the board must have 90 points";
  if (!SIDES.includes(turn)) return "the side to move is invalid";
  const limits = { K: 1, A: 2, B: 2, N: 2, R: 2, C: 2, P: 5 };
  const counts = { red: {}, black: {} };
  for (let square = 0; square < 90; square += 1) {
    const piece = board[square];
    if (piece === null) continue;
    if (typeof piece !== "string" || !/^[KABNRCPkabnrcp]$/.test(piece)) return `unknown piece at ${squareToIccs(square)}`;
    const side = sideOf(piece);
    const type = typeOf(piece);
    const file = fileOf(square);
    const rank = rankOf(square);
    counts[side][type] = (counts[side][type] ?? 0) + 1;
    if (counts[side][type] > limits[type]) return `${side} has too many ${PIECE_INFO[type].name.toLowerCase()}s`;
    const where = squareToIccs(square);
    if (type === "K" && !inPalace(side, file, rank)) return `the ${side} general at ${where} is outside its palace`;
    if (type === "A" && !(inPalace(side, file, rank) && (file + rank) % 2 === (side === "red" ? 1 : 0))) {
      return `the ${side} advisor at ${where} is not on a palace diagonal point`;
    }
    if (type === "B") {
      const homeRank = side === "red" ? rank : 9 - rank;
      const valid = onOwnHalf(side, rank) && file % 2 === 0 && homeRank % 2 === 0 && (file + homeRank) % 4 === 2;
      if (!valid) return `the ${side} elephant at ${where} is not on an elephant point`;
    }
    if (type === "P") {
      const homeRank = side === "red" ? rank : 9 - rank;
      if (homeRank < 3 || (homeRank < 5 && file % 2 === 1)) return `the ${side} soldier at ${where} is behind its starting line`;
    }
  }
  if (counts.red.K !== 1 || counts.black.K !== 1) return "each side needs exactly one general";
  if (isInCheck(board, opposite(turn))) return "the side that just moved is still in check";
  return null;
}

// ---------------------------------------------------------------------------
// Move generation

// Destinations a piece could reach ignoring whether its own general is left in check.
function pseudoTargets(board, from) {
  const piece = board[from];
  const side = sideOf(piece);
  const file = fileOf(from);
  const rank = rankOf(from);
  const targets = [];
  const add = (toFile, toRank) => {
    if (!onBoard(toFile, toRank)) return;
    const occupant = board[toSquare(toFile, toRank)];
    if (occupant && sideOf(occupant) === side) return;
    targets.push(toSquare(toFile, toRank));
  };

  switch (typeOf(piece)) {
    case "K":
      for (const [df, dr] of ORTHOGONAL) if (inPalace(side, file + df, rank + dr)) add(file + df, rank + dr);
      break;
    case "A":
      for (const [df, dr] of DIAGONAL) if (inPalace(side, file + df, rank + dr)) add(file + df, rank + dr);
      break;
    case "B":
      for (const [df, dr] of DIAGONAL) {
        const toFile = file + 2 * df;
        const toRank = rank + 2 * dr;
        if (!onBoard(toFile, toRank) || !onOwnHalf(side, toRank)) continue;
        if (board[toSquare(file + df, rank + dr)]) continue; // elephant eye blocked
        add(toFile, toRank);
      }
      break;
    case "N":
      for (const [df, dr] of ORTHOGONAL) {
        const legFile = file + df;
        const legRank = rank + dr;
        if (!onBoard(legFile, legRank) || board[toSquare(legFile, legRank)]) continue; // horse leg blocked
        if (df !== 0) {
          add(file + 2 * df, rank + 1);
          add(file + 2 * df, rank - 1);
        } else {
          add(file + 1, rank + 2 * dr);
          add(file - 1, rank + 2 * dr);
        }
      }
      break;
    case "R":
      for (const [df, dr] of ORTHOGONAL) {
        let toFile = file + df;
        let toRank = rank + dr;
        while (onBoard(toFile, toRank)) {
          const occupant = board[toSquare(toFile, toRank)];
          if (!occupant) targets.push(toSquare(toFile, toRank));
          else {
            if (sideOf(occupant) !== side) targets.push(toSquare(toFile, toRank));
            break;
          }
          toFile += df;
          toRank += dr;
        }
      }
      break;
    case "C":
      for (const [df, dr] of ORTHOGONAL) {
        let toFile = file + df;
        let toRank = rank + dr;
        let screened = false;
        while (onBoard(toFile, toRank)) {
          const occupant = board[toSquare(toFile, toRank)];
          if (!screened) {
            if (!occupant) targets.push(toSquare(toFile, toRank));
            else screened = true;
          } else if (occupant) {
            if (sideOf(occupant) !== side) targets.push(toSquare(toFile, toRank));
            break;
          }
          toFile += df;
          toRank += dr;
        }
      }
      break;
    case "P": {
      add(file, rank + forwardOf(side));
      if (!onOwnHalf(side, rank)) {
        add(file - 1, rank);
        add(file + 1, rank);
      }
      break;
    }
    default:
      break;
  }
  return targets;
}

export function findGeneral(board, side) {
  const general = side === "red" ? "K" : "k";
  return board.indexOf(general);
}

// True when `attacker` attacks the general standing on `target` (includes the flying-general rule).
function generalAttacked(board, target, attacker) {
  const file = fileOf(target);
  const rank = rankOf(target);
  const isEnemy = (piece, type) => piece && sideOf(piece) === attacker && typeOf(piece) === type;

  for (const [df, dr] of ORTHOGONAL) {
    let toFile = file + df;
    let toRank = rank + dr;
    let screens = 0;
    while (onBoard(toFile, toRank)) {
      const piece = board[toSquare(toFile, toRank)];
      if (piece) {
        if (screens === 0) {
          if (isEnemy(piece, "R")) return true;
          if (df === 0 && isEnemy(piece, "K")) return true; // flying general
          screens = 1;
        } else {
          if (isEnemy(piece, "C")) return true;
          break;
        }
      }
      toFile += df;
      toRank += dr;
    }
  }

  for (const [dx, dy] of HORSE_OFFSETS) {
    // (dx, dy) is the horse's jump; the horse stands at target - jump.
    const horseFile = file - dx;
    const horseRank = rank - dy;
    if (!onBoard(horseFile, horseRank) || !isEnemy(board[toSquare(horseFile, horseRank)], "N")) continue;
    const legFile = horseFile + (Math.abs(dx) === 2 ? dx / 2 : 0);
    const legRank = horseRank + (Math.abs(dy) === 2 ? dy / 2 : 0);
    if (!board[toSquare(legFile, legRank)]) return true;
  }

  const behind = rank - forwardOf(attacker);
  if (onBoard(file, behind) && isEnemy(board[toSquare(file, behind)], "P")) return true;
  if (!onOwnHalf(attacker, rank)) {
    for (const df of [-1, 1]) {
      if (onBoard(file + df, rank) && isEnemy(board[toSquare(file + df, rank)], "P")) return true;
    }
  }
  return false;
}

export function isInCheck(board, side) {
  const general = findGeneral(board, side);
  if (general === -1) return true;
  return generalAttacked(board, general, opposite(side));
}

function generalsFace(board) {
  const red = findGeneral(board, "red");
  const black = findGeneral(board, "black");
  if (red === -1 || black === -1 || fileOf(red) !== fileOf(black)) return false;
  for (let square = red + 9; square < black; square += 9) if (board[square]) return false;
  return true;
}

function movedBoard(board, from, to) {
  const next = board.slice();
  next[to] = next[from];
  next[from] = null;
  return next;
}

// All legal moves for `side` on `board`, as { from, to } squares, in board order.
export function generateLegalMoves(board, side) {
  const moves = [];
  for (let from = 0; from < 90; from += 1) {
    const piece = board[from];
    if (!piece || sideOf(piece) !== side) continue;
    for (const to of pseudoTargets(board, from)) {
      if (!isInCheck(movedBoard(board, from, to), side)) moves.push({ from, to });
    }
  }
  return moves;
}

// Counts leaf nodes of the legal move tree; used to verify move generation.
export function perft(board, side, depth) {
  if (depth === 0) return 1;
  const moves = generateLegalMoves(board, side);
  if (depth === 1) return moves.length;
  let total = 0;
  for (const { from, to } of moves) total += perft(movedBoard(board, from, to), opposite(side), depth - 1);
  return total;
}

// ---------------------------------------------------------------------------
// Precise explanations for illegal moves (fed back to the model on retry).

function between(board, from, to) {
  const df = Math.sign(fileOf(to) - fileOf(from));
  const dr = Math.sign(rankOf(to) - rankOf(from));
  const pieces = [];
  let file = fileOf(from) + df;
  let rank = rankOf(from) + dr;
  while (toSquare(file, rank) !== to) {
    if (board[toSquare(file, rank)]) pieces.push(toSquare(file, rank));
    file += df;
    rank += dr;
  }
  return pieces;
}

function geometryReason(board, from, to) {
  const piece = board[from];
  const side = sideOf(piece);
  const type = typeOf(piece);
  const name = PIECE_INFO[type].name;
  const df = fileOf(to) - fileOf(from);
  const dr = rankOf(to) - rankOf(from);
  const adf = Math.abs(df);
  const adr = Math.abs(dr);
  const target = board[to];
  const where = squareToIccs(to);

  switch (type) {
    case "K":
      if (adf + adr !== 1) return "The general moves exactly one point horizontally or vertically.";
      return `The general must stay inside its palace (files d-f, ranks ${side === "red" ? "0-2" : "7-9"}); ${where} is outside.`;
    case "A":
      if (!(adf === 1 && adr === 1)) return "The advisor moves exactly one point diagonally.";
      return `The advisor must stay inside its palace; ${where} is outside.`;
    case "B": {
      if (!(adf === 2 && adr === 2)) return "The elephant moves exactly two points diagonally.";
      if (!onOwnHalf(side, rankOf(to))) return "The elephant cannot cross the river.";
      const eye = toSquare(fileOf(from) + df / 2, rankOf(from) + dr / 2);
      return `The elephant's eye at ${squareToIccs(eye)} is blocked.`;
    }
    case "N": {
      if (!((adf === 1 && adr === 2) || (adf === 2 && adr === 1))) {
        return "The horse moves one point straight and then one point diagonally (an L shape).";
      }
      const leg = adf === 2 ? toSquare(fileOf(from) + df / 2, rankOf(from)) : toSquare(fileOf(from), rankOf(from) + dr / 2);
      return `The horse's leg at ${squareToIccs(leg)} is blocked.`;
    }
    case "R": {
      if (df !== 0 && dr !== 0) return "The chariot moves only along a rank or a file.";
      const blockers = between(board, from, to);
      return `The chariot's path is blocked at ${squareToIccs(blockers[0])}.`;
    }
    case "C": {
      if (df !== 0 && dr !== 0) return "The cannon moves only along a rank or a file.";
      const screens = between(board, from, to).length;
      if (!target) return `The cannon may not jump when it does not capture; ${screens} piece(s) stand in the way.`;
      return `The cannon captures only by jumping exactly one screen; there ${screens === 1 ? "is" : "are"} ${screens} piece(s) between.`;
    }
    case "P": {
      const forward = forwardOf(side);
      if (dr === -forward) return "Soldiers never move backward.";
      if (dr === 0 && adf === 1) return "Soldiers may move sideways only after crossing the river.";
      return "Soldiers move one point forward (or sideways after crossing the river).";
    }
    default:
      return `That is not a legal ${name.toLowerCase()} move.`;
  }
}

// Returns null when the move is legal, otherwise a human-readable reason.
export function explainIllegalMove(board, side, from, to) {
  if (from === null || to === null || from === undefined || to === undefined) {
    return "The move must name two points in ICCS notation such as h2e2.";
  }
  if (from === to) return "The move must go to a different point.";
  const piece = board[from];
  if (!piece) return `There is no piece on ${squareToIccs(from)}.`;
  if (sideOf(piece) !== side) return `The piece on ${squareToIccs(from)} is a ${pieceLabel(piece)}; it is ${side}'s turn.`;
  const target = board[to];
  if (target && sideOf(target) === side) return `You cannot capture your own ${pieceName(target).toLowerCase()} on ${squareToIccs(to)}.`;
  if (!pseudoTargets(board, from).includes(to)) return geometryReason(board, from, to);
  const after = movedBoard(board, from, to);
  if (isInCheck(after, side)) {
    if (generalsFace(after)) return "The two generals would face each other on an open file (flying general rule).";
    return isInCheck(board, side)
      ? "You are in check and this move does not get your general out of check."
      : "This move would leave your own general in check.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Game state

function normalizeOptions(options = {}) {
  const pick = (key, minimum) => {
    const value = options[key];
    return Number.isInteger(value) && value >= minimum ? value : DEFAULT_OPTIONS[key];
  };
  return {
    repetitionLimit: pick("repetitionLimit", 2),
    noCaptureDrawPlies: pick("noCaptureDrawPlies", 1),
    maxPlies: pick("maxPlies", 1),
  };
}

// options:
//   fen               starting position (default: the standard opening position)
//   participants      optional two opaque ids (e.g. character ids) to seat
//   colorAssignment   "fixed" (participants[0] plays Red) or "random"
//   rng               injectable () => [0, 1) used for random color assignment
//   repetitionLimit, noCaptureDrawPlies, maxPlies   see DEFAULT_OPTIONS
export function createXiangqiGame(options = {}) {
  const { board, turn } = parseFen(options.fen ?? INITIAL_FEN);
  const problem = validatePosition(board, turn);
  if (problem) throw new XiangqiRuleError(`Invalid starting position: ${problem}`, "invalid_position");

  const participants = Array.isArray(options.participants) ? options.participants.slice(0, 2) : [];
  const rng = typeof options.rng === "function" ? options.rng : Math.random;
  const swap = options.colorAssignment === "random" && rng() < 0.5;
  const seats = {
    red: (swap ? participants[1] : participants[0]) ?? null,
    black: (swap ? participants[0] : participants[1]) ?? null,
  };

  const state = {
    gameId: "xiangqi",
    version: XIANGQI_STATE_VERSION,
    options: normalizeOptions(options),
    startFen: boardToFen(board, turn),
    seats,
    board,
    turn,
    ply: 0,
    pliesSinceCapture: 0,
    positions: [positionKey(board, turn)],
    history: [],
    status: "active",
    result: null,
  };
  if (generateLegalMoves(board, turn).length === 0) {
    const inCheck = isInCheck(board, turn);
    state.status = "complete";
    state.result = { winner: opposite(turn), reason: inCheck ? "checkmate" : "stalemate" };
  }
  return state;
}

export function isGameOver(state) {
  return state.status === "complete";
}

export function sideForSeat(state, seatId) {
  if (state.seats.red !== null && state.seats.red === seatId) return "red";
  if (state.seats.black !== null && state.seats.black === seatId) return "black";
  return null;
}

function describeMove(board, from, to) {
  const piece = board[from];
  return {
    type: "move",
    move: moveToIccs(from, to),
    from: squareToIccs(from),
    to: squareToIccs(to),
    piece,
    pieceName: pieceName(piece),
    captured: board[to] ?? null,
  };
}

// Legal actions for the side to move: every legal move plus resignation.
// Each move action carries { type, move, from, to, piece, pieceName, captured, givesCheck }.
export function legalMoves(state) {
  if (state.status !== "active") return [];
  return generateLegalMoves(state.board, state.turn).map(({ from, to }) => ({
    ...describeMove(state.board, from, to),
    givesCheck: isInCheck(movedBoard(state.board, from, to), opposite(state.turn)),
  }));
}

export function legalActions(state) {
  if (state.status !== "active") return [];
  return [...legalMoves(state), { type: "resign", side: state.turn }];
}

function hasAttackingMaterial(board) {
  return board.some((piece) => piece && ATTACKERS.has(typeOf(piece)));
}

// Judges a repetition: who (if anyone) checked on every move since the earliest of
// the last `limit` occurrences of the current position.
function adjudicateRepetition(positions, history, limit) {
  const key = positions[positions.length - 1];
  const occurrences = [];
  positions.forEach((value, index) => {
    if (value === key) occurrences.push(index);
  });
  if (occurrences.length < limit) return null;
  const start = occurrences[occurrences.length - limit];
  const span = history.slice(start); // history[i] produced positions[i + 1]
  const perpetual = (side) => {
    const moves = span.filter((entry) => entry.side === side);
    return moves.length > 0 && moves.every((entry) => entry.check);
  };
  const redChecks = perpetual("red");
  const blackChecks = perpetual("black");
  if (redChecks && !blackChecks) return { winner: "black", reason: "perpetual_check", loser: "red" };
  if (blackChecks && !redChecks) return { winner: "red", reason: "perpetual_check", loser: "black" };
  return { winner: null, reason: "repetition" };
}

function playMove(state, from, to) {
  const mover = state.turn;
  const board = movedBoard(state.board, from, to);
  const turn = opposite(mover);
  const captured = state.board[to] ?? null;
  const check = isInCheck(board, turn);
  const ply = state.ply + 1;
  const entry = {
    ply,
    side: mover,
    move: moveToIccs(from, to),
    piece: state.board[from],
    captured,
    check,
  };
  const next = {
    ...state,
    board,
    turn,
    ply,
    pliesSinceCapture: captured ? 0 : state.pliesSinceCapture + 1,
    positions: [...state.positions, positionKey(board, turn)],
    history: [...state.history, entry],
  };

  let result = null;
  if (generateLegalMoves(board, turn).length === 0) {
    result = { winner: mover, reason: check ? "checkmate" : "stalemate" };
  }
  if (!result) result = adjudicateRepetition(next.positions, next.history, state.options.repetitionLimit);
  if (!result && next.pliesSinceCapture >= state.options.noCaptureDrawPlies) result = { winner: null, reason: "no_capture_limit" };
  if (!result && !hasAttackingMaterial(board)) result = { winner: null, reason: "insufficient_material" };
  if (!result && ply >= state.options.maxPlies) result = { winner: null, reason: "move_limit" };
  if (result) {
    next.status = "complete";
    next.result = result;
  }
  return next;
}

function resolveMoveSquares(action) {
  if (typeof action.move === "string") return parseIccsMove(action.move);
  const from = iccsToSquare(action.from);
  const to = iccsToSquare(action.to);
  return from === null || to === null ? null : { from, to };
}

// Returns { ok: true, from, to } or { ok: false, code, message }. Never throws.
export function validateAction(state, action) {
  if (!state || state.status !== "active") return { ok: false, code: "game_over", message: "The game is already over." };
  if (!action || typeof action !== "object") return { ok: false, code: "invalid_action", message: "The action must be an object." };
  if (action.type === "resign") {
    const side = action.side ?? state.turn;
    if (!SIDES.includes(side)) return { ok: false, code: "invalid_action", message: `Unknown side "${side}".` };
    return { ok: true, side };
  }
  if (action.type !== "move") return { ok: false, code: "invalid_action", message: `Unknown action type "${action.type}".` };
  if (action.side !== undefined && action.side !== state.turn) {
    return { ok: false, code: "not_your_turn", message: `It is ${state.turn}'s turn, not ${action.side}'s.` };
  }
  const squares = resolveMoveSquares(action);
  if (!squares) {
    return { ok: false, code: "bad_notation", message: "The move must be ICCS notation: from-point then to-point, e.g. h2e2." };
  }
  const reason = explainIllegalMove(state.board, state.turn, squares.from, squares.to);
  if (reason) return { ok: false, code: "illegal_move", message: `${moveToIccs(squares.from, squares.to)} is illegal: ${reason}` };
  return { ok: true, ...squares };
}

// Applies { type: "move", move: "h2e2" } (or { type: "move", from: "h2", to: "e2" }),
// or { type: "resign", side? }. Returns the new state; throws XiangqiRuleError if illegal.
export function applyAction(state, action) {
  const verdict = validateAction(state, action);
  if (!verdict.ok) throw new XiangqiRuleError(verdict.message, verdict.code);
  if (action.type === "resign") {
    return {
      ...state,
      history: [...state.history, { ply: state.ply, side: verdict.side, move: null, resigned: true }],
      status: "complete",
      result: { winner: opposite(verdict.side), reason: "resignation" },
    };
  }
  return playMove(state, verdict.from, verdict.to);
}

// What would happen if the side to move played this (legal) move. Used to warn players
// (and models) about moves that lose by perpetual check or end the game.
export function previewMove(state, move) {
  const squares = parseIccsMove(move);
  if (!squares || explainIllegalMove(state.board, state.turn, squares.from, squares.to)) return null;
  const next = playMove(state, squares.from, squares.to);
  return {
    givesCheck: next.history[next.history.length - 1].check,
    result: next.result,
    repetitionCount: next.positions.filter((key) => key === next.positions[next.positions.length - 1]).length,
  };
}

// ---------------------------------------------------------------------------
// Scoring and views

export function scoreGame(state) {
  if (state.status !== "complete" || !state.result) return null;
  if (state.result.winner === "red") return { red: 1, black: 0 };
  if (state.result.winner === "black") return { red: 0, black: 1 };
  return { red: 0.5, black: 0.5 };
}

export function materialCount(board) {
  const total = { red: 0, black: 0 };
  for (let square = 0; square < 90; square += 1) {
    const piece = board[square];
    if (!piece) continue;
    const side = sideOf(piece);
    let value = PIECE_INFO[typeOf(piece)].value;
    if (typeOf(piece) === "P" && !onOwnHalf(side, rankOf(square))) value = 2; // crossed soldiers are worth more
    total[side] += value;
  }
  return total;
}

export function capturedPieces(state) {
  const captured = { red: [], black: [] }; // pieces each side has lost
  for (const entry of state.history) {
    if (entry.captured) captured[sideOf(entry.captured)].push(entry.captured);
  }
  return captured;
}

export function describeResult(result) {
  if (!result) return null;
  const winner = result.winner === "red" ? "Red" : result.winner === "black" ? "Black" : null;
  const reasons = {
    checkmate: `${winner} wins by checkmate.`,
    stalemate: `${winner} wins: the opponent has no legal move (stalemate loses in Xiangqi).`,
    perpetual_check: `${winner} wins: the opponent repeated the position with perpetual check, which is forbidden.`,
    resignation: `${winner} wins by resignation.`,
    repetition: "Draw by repetition.",
    no_capture_limit: "Draw: too many moves without a capture.",
    insufficient_material: "Draw: neither side has an attacking piece left.",
    move_limit: "Draw: the move limit was reached.",
  };
  return reasons[result.reason] ?? result.reason;
}

// Xiangqi has no hidden information, so the public view is complete. It is still a
// fresh, render-friendly object so callers never hand out the authoritative state.
export function publicView(state) {
  const last = state.history.length ? state.history[state.history.length - 1] : null;
  return {
    gameId: "xiangqi",
    fen: boardToFen(state.board, state.turn),
    board: state.board.slice(),
    turn: state.turn,
    ply: state.ply,
    moveNumber: Math.floor(state.ply / 2) + 1,
    seats: { ...state.seats },
    inCheck: state.status === "active" ? isInCheck(state.board, state.turn) : false,
    lastMove: last ? { ...last } : null,
    history: state.history.map((entry) => ({ ...entry })),
    pliesSinceCapture: state.pliesSinceCapture,
    material: materialCount(state.board),
    captured: capturedPieces(state),
    status: state.status,
    result: state.result ? { ...state.result } : null,
    resultText: describeResult(state.result),
    score: scoreGame(state),
    options: { ...state.options },
  };
}

export function playerView(state, side) {
  if (!SIDES.includes(side)) throw new XiangqiRuleError(`Unknown side "${side}"`, "invalid_action");
  const view = publicView(state);
  const yourTurn = state.status === "active" && state.turn === side;
  return { ...view, you: side, yourTurn, legalMoves: yourTurn ? legalMoves(state).map((move) => move.move) : [] };
}

// ---------------------------------------------------------------------------
// Save / resume

export function serializeGame(state) {
  return JSON.parse(JSON.stringify({ gameId: "xiangqi", version: XIANGQI_STATE_VERSION, state }));
}

function requireSaved(condition, message) {
  if (!condition) throw new XiangqiRuleError(`Invalid Xiangqi save: ${message}`, "invalid_save");
}

// Restores a serialized game by replaying its move history from the start position,
// so a tampered board, history or result is rejected instead of trusted.
export function restoreGame(payload) {
  requireSaved(payload && typeof payload === "object", "payload is missing");
  requireSaved(payload.gameId === "xiangqi", "game identifier is not xiangqi");
  requireSaved(payload.version === XIANGQI_STATE_VERSION, `unsupported version ${payload.version}`);
  const saved = payload.state;
  requireSaved(saved && typeof saved === "object", "state is missing");
  requireSaved(Array.isArray(saved.history), "history must be an array");
  requireSaved(saved.seats && typeof saved.seats === "object", "seats are missing");

  let state;
  try {
    const { repetitionLimit, noCaptureDrawPlies, maxPlies } = saved.options ?? {};
    state = createXiangqiGame({ fen: saved.startFen, repetitionLimit, noCaptureDrawPlies, maxPlies });
  } catch (error) {
    requireSaved(false, error.message);
  }
  state.seats = { red: saved.seats.red ?? null, black: saved.seats.black ?? null };
  for (const [index, entry] of saved.history.entries()) {
    requireSaved(entry && typeof entry === "object", `history entry ${index} is invalid`);
    if (entry.resigned) {
      requireSaved(index === saved.history.length - 1, "resignation must be the last history entry");
      try {
        state = applyAction(state, { type: "resign", side: entry.side });
      } catch (error) {
        requireSaved(false, `resignation cannot be replayed: ${error.message}`);
      }
      continue;
    }
    try {
      state = applyAction(state, { type: "move", move: entry.move });
    } catch (error) {
      requireSaved(false, `move ${index + 1} (${entry.move}) cannot be replayed: ${error.message}`);
    }
  }
  requireSaved(boardToFen(state.board, state.turn) === boardToFen(saved.board ?? [], saved.turn), "board does not match the move history");
  requireSaved(state.status === saved.status, "status does not match the move history");
  requireSaved(JSON.stringify(state.result) === JSON.stringify(saved.result ?? null), "result does not match the move history");
  return state;
}
