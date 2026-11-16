import { seatCharacters } from "../platform/seating.js";
import { normalizeModelConfig } from "../platform/model-registry.js";

const COLORS = Object.freeze(["black", "white"]);
const BOARD_SIZES = new Set([9, 13, 19]);
const COLUMN_LABELS = "ABCDEFGHJKLMNOPQRST";
const GO_SAVE_VERSION = 1;

function opposite(color) {
  return color === "black" ? "white" : "black";
}

function clampNumber(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function boardHash(board) {
  return board.map((cell) => (cell === "black" ? "B" : cell === "white" ? "W" : ".")).join("");
}

function requireSaved(condition, message) {
  if (!condition) throw new Error(`Invalid Go save: ${message}`);
}

function savedArray(value, name) {
  requireSaved(Array.isArray(value), `${name} must be an array`);
  return structuredClone(value);
}

export function goCoordinate(row, column, size) {
  return `${COLUMN_LABELS[column]}${size - row}`;
}

export class GoGame {
  constructor(config = {}) {
    const requestedSize = Number.parseInt(config.boardSize, 10);
    this.boardSize = BOARD_SIZES.has(requestedSize) ? requestedSize : 9;
    this.komi = clampNumber(config.komi, 0, 20, 7.5);
    this.gameMode = config.gameMode === "arena" ? "arena" : "human";
    this.humanColor = config.humanColor === "white" ? "white" : "black";
    this.arenaPaused = this.gameMode === "arena" && Boolean(config.arenaPaused);
    this.phase = "active";
    this.currentColor = "black";
    this.moveNumber = 0;
    this.board = Array(this.boardSize * this.boardSize).fill(null);
    this.captures = { black: 0, white: 0 };
    this.consecutivePasses = 0;
    this.lastMove = null;
    this.result = null;
    this.logs = [];
    this.aiInsights = [];
    this.aiThinking = null;
    this.aiError = null;
    this.positionHistory = new Set([boardHash(this.board)]);
    this.tableTalk = [];
    this.review = null;
    this.saveStatus = { savedAt: null, error: null, restored: false };

    const requestedAI = Array.isArray(config.aiPlayers) ? config.aiPlayers : [];
    const cast = seatCharacters(this.gameMode === "human" ? 1 : 2, requestedAI.map((player) => player?.characterId));
    let aiIndex = 0;
    this.players = COLORS.map((color, colorIndex) => {
      const isHuman = this.gameMode === "human" && color === this.humanColor;
      if (isHuman) {
        return {
          color,
          name: String(config.humanName ?? "Player").trim().slice(0, 18) || "Player",
          isHuman: true,
          character: null,
          aiConfig: null,
          lastAction: "",
        };
      }
      const character = cast[aiIndex];
      const player = {
        color,
        name: character.name,
        isHuman: false,
        character,
        aiConfig: normalizeModelConfig("go", requestedAI[aiIndex] ?? config),
        lastAction: "",
      };
      aiIndex += 1;
      return player;
    });

    this._log("system", `${this.boardSize}×${this.boardSize} Go begins under Chinese area scoring with ${this.komi} komi.`);
  }

  static fromSave(payload) {
    requireSaved(payload && typeof payload === "object", "payload is missing");
    requireSaved(payload.gameId === "go", "game identifier is not Go");
    requireSaved(payload.version === GO_SAVE_VERSION, `unsupported version ${payload.version}`);
    requireSaved(typeof payload.savedAt === "string" && Number.isFinite(Date.parse(payload.savedAt)), "savedAt is invalid");
    const state = payload.state;
    requireSaved(state && typeof state === "object", "state is missing");
    requireSaved(BOARD_SIZES.has(state.boardSize), "board size is unsupported");
    requireSaved(Number.isFinite(state.komi) && state.komi >= 0 && state.komi <= 20, "komi is invalid");
    requireSaved(state.gameMode === "human" || state.gameMode === "arena", "game mode is invalid");
    requireSaved(typeof state.arenaPaused === "boolean", "arena pause state is invalid");
    requireSaved(COLORS.includes(state.currentColor), "current color is invalid");
    requireSaved(state.phase === "active" || state.phase === "complete", "phase is invalid");
    requireSaved(Number.isInteger(state.moveNumber) && state.moveNumber >= 0, "move number is invalid");
    requireSaved(Array.isArray(state.players) && state.players.length === 2, "two players are required");
    requireSaved(state.players.every((player) => COLORS.includes(player?.color)), "player colors are invalid");
    requireSaved(new Set(state.players.map((player) => player.color)).size === 2, "player colors must be unique");

    const board = savedArray(state.board, "board");
    requireSaved(board.length === state.boardSize ** 2, "board length does not match board size");
    requireSaved(board.every((cell) => cell === null || COLORS.includes(cell)), "board contains an invalid stone");
    requireSaved(state.captures && COLORS.every((color) => Number.isInteger(state.captures[color]) && state.captures[color] >= 0), "capture counts are invalid");
    requireSaved(Number.isInteger(state.consecutivePasses) && state.consecutivePasses >= 0 && state.consecutivePasses <= 2, "pass count is invalid");

    const positionHistory = savedArray(state.positionHistory, "position history");
    const expectedHashLength = state.boardSize ** 2;
    requireSaved(positionHistory.length > 0, "position history is empty");
    requireSaved(positionHistory.every((hash) => typeof hash === "string" && hash.length === expectedHashLength && /^[BW.]+$/.test(hash)), "position history contains an invalid board");
    requireSaved(positionHistory.includes(boardHash(board)), "current board is absent from position history");
    requireSaved(state.moveNumber >= positionHistory.length - 1, "move number is lower than the played stone count");
    requireSaved(state.consecutivePasses !== 2 || state.phase === "complete", "two consecutive passes require a completed game");

    const humanPlayers = state.players.filter((player) => player.isHuman === true);
    const human = humanPlayers[0];
    requireSaved(state.gameMode === "human" ? humanPlayers.length === 1 : humanPlayers.length === 0, "human player does not match game mode");
    const aiPlayers = state.players
      .filter((player) => !player.isHuman)
      .map((player) => ({ ...player.aiConfig, characterId: typeof player.characterId === "string" ? player.characterId : undefined }));
    const game = new GoGame({
      boardSize: state.boardSize,
      komi: state.komi,
      gameMode: state.gameMode,
      humanColor: human?.color,
      humanName: human?.name,
      arenaPaused: state.arenaPaused,
      aiPlayers,
    });

    game.phase = state.phase;
    game.currentColor = state.currentColor;
    game.moveNumber = state.moveNumber;
    game.board = board;
    game.captures = { black: state.captures.black, white: state.captures.white };
    game.consecutivePasses = state.consecutivePasses;
    game.lastMove = state.lastMove == null ? null : structuredClone(state.lastMove);
    game.result = state.result == null ? null : structuredClone(state.result);
    game.logs = savedArray(state.logs, "logs").slice(-220);
    game.aiInsights = savedArray(state.aiInsights, "AI insights");
    game.aiError = state.aiError == null ? null : structuredClone(state.aiError);
    game.aiThinking = null;
    game.positionHistory = new Set(positionHistory);
    game.tableTalk = Array.isArray(state.tableTalk) ? structuredClone(state.tableTalk).slice(-30) : [];
    game.review = state.review && typeof state.review === "object" ? structuredClone(state.review) : null;
    game.players.forEach((player) => {
      const savedPlayer = state.players.find((candidate) => candidate.color === player.color);
      player.lastAction = String(savedPlayer.lastAction ?? "").slice(0, 120);
      if (player.isHuman) player.name = String(savedPlayer.name ?? "Player").trim().slice(0, 18) || "Player";
    });
    game.saveStatus = { savedAt: payload.savedAt, error: null, restored: true };
    return game;
  }

  get isArenaMode() {
    return this.gameMode === "arena";
  }

  get currentPlayer() {
    return this.players.find((player) => player.color === this.currentColor) ?? null;
  }

  _index(row, column) {
    return row * this.boardSize + column;
  }

  _isInside(row, column) {
    return row >= 0 && column >= 0 && row < this.boardSize && column < this.boardSize;
  }

  _neighbors(row, column) {
    return [[row - 1, column], [row + 1, column], [row, column - 1], [row, column + 1]]
      .filter(([nextRow, nextColumn]) => this._isInside(nextRow, nextColumn));
  }

  _groupAt(board, row, column) {
    const color = board[this._index(row, column)];
    if (!color) return { stones: [], liberties: new Set() };
    const stones = [];
    const liberties = new Set();
    const visited = new Set();
    const stack = [[row, column]];
    while (stack.length) {
      const [currentRow, currentColumn] = stack.pop();
      const key = this._index(currentRow, currentColumn);
      if (visited.has(key)) continue;
      visited.add(key);
      stones.push([currentRow, currentColumn]);
      for (const [nextRow, nextColumn] of this._neighbors(currentRow, currentColumn)) {
        const nextKey = this._index(nextRow, nextColumn);
        const nextCell = board[nextKey];
        if (!nextCell) liberties.add(nextKey);
        else if (nextCell === color && !visited.has(nextKey)) stack.push([nextRow, nextColumn]);
      }
    }
    return { stones, liberties };
  }

  _simulatePlacement(color, row, column) {
    if (!Number.isInteger(row) || !Number.isInteger(column) || !this._isInside(row, column)) {
      throw new Error("Choose an intersection on the board");
    }
    const placementIndex = this._index(row, column);
    if (this.board[placementIndex]) throw new Error(`${goCoordinate(row, column, this.boardSize)} is occupied`);

    const nextBoard = [...this.board];
    nextBoard[placementIndex] = color;
    let captured = 0;
    const inspected = new Set();
    for (const [nextRow, nextColumn] of this._neighbors(row, column)) {
      const nextIndex = this._index(nextRow, nextColumn);
      if (nextBoard[nextIndex] !== opposite(color) || inspected.has(nextIndex)) continue;
      const group = this._groupAt(nextBoard, nextRow, nextColumn);
      for (const [stoneRow, stoneColumn] of group.stones) inspected.add(this._index(stoneRow, stoneColumn));
      if (group.liberties.size > 0) continue;
      captured += group.stones.length;
      for (const [stoneRow, stoneColumn] of group.stones) nextBoard[this._index(stoneRow, stoneColumn)] = null;
    }

    if (this._groupAt(nextBoard, row, column).liberties.size === 0) throw new Error("Suicide is not legal");
    const hash = boardHash(nextBoard);
    if (this.positionHistory.has(hash)) throw new Error("Positional superko prevents repeating an earlier board");
    return { board: nextBoard, captured, hash };
  }

  isLegalPlacement(row, column, color = this.currentColor) {
    try {
      this._simulatePlacement(color, row, column);
      return true;
    } catch {
      return false;
    }
  }

  legalPlacements(color = this.currentColor) {
    const moves = [];
    for (let row = 0; row < this.boardSize; row += 1) {
      for (let column = 0; column < this.boardSize; column += 1) {
        if (this.isLegalPlacement(row, column, color)) moves.push([row, column]);
      }
    }
    return moves;
  }

  applyAction(color, action, row = null, column = null) {
    if (this.phase !== "active") throw new Error("This Go game is complete");
    if (color !== this.currentColor) throw new Error(`It is ${this.currentColor}'s turn`);
    const player = this.currentPlayer;
    if (!player) throw new Error("Current player is unavailable");

    if (action === "resign") {
      player.lastAction = "Resigned";
      this._log("result", `${player.name} resigns. ${opposite(color)} wins.`, { color });
      this.phase = "complete";
      this.result = { winner: opposite(color), reason: "resignation", margin: null, scores: null };
      this.aiThinking = null;
      return;
    }

    if (action === "pass") {
      player.lastAction = "Passed";
      this.consecutivePasses += 1;
      this.moveNumber += 1;
      this.lastMove = { action: "pass", color, moveNumber: this.moveNumber };
      this._log("move", `${player.name} passes.`, { color });
      if (this.consecutivePasses >= 2) {
        this._completeByScore();
        return;
      }
      this.currentColor = opposite(this.currentColor);
      return;
    }

    if (action !== "place") throw new Error(`Unknown Go action “${action}”`);
    const simulation = this._simulatePlacement(color, row, column);
    this.board = simulation.board;
    this.positionHistory.add(simulation.hash);
    this.captures[color] += simulation.captured;
    this.consecutivePasses = 0;
    this.moveNumber += 1;
    const coordinate = goCoordinate(row, column, this.boardSize);
    player.lastAction = simulation.captured ? `${coordinate} · captured ${simulation.captured}` : coordinate;
    this.lastMove = { action: "place", color, row, column, coordinate, captured: simulation.captured, moveNumber: this.moveNumber };
    this._log("move", `${player.name} plays ${coordinate}${simulation.captured ? ` and captures ${simulation.captured}` : ""}.`, { color, row, column });
    this.currentColor = opposite(this.currentColor);
  }

  /** Owner of every empty point under area scoring: a region bordered by one colour only, else null. */
  territoryOwners() {
    const owners = Array(this.board.length).fill(null);
    const visited = new Set();
    for (let row = 0; row < this.boardSize; row += 1) {
      for (let column = 0; column < this.boardSize; column += 1) {
        const start = this._index(row, column);
        if (this.board[start] || visited.has(start)) continue;
        const region = [];
        const borders = new Set();
        const stack = [[row, column]];
        while (stack.length) {
          const [regionRow, regionColumn] = stack.pop();
          const key = this._index(regionRow, regionColumn);
          if (visited.has(key) || this.board[key]) continue;
          visited.add(key);
          region.push(key);
          for (const [nextRow, nextColumn] of this._neighbors(regionRow, regionColumn)) {
            const nextCell = this.board[this._index(nextRow, nextColumn)];
            if (nextCell) borders.add(nextCell);
            else if (!visited.has(this._index(nextRow, nextColumn))) stack.push([nextRow, nextColumn]);
          }
        }
        if (borders.size === 1) for (const key of region) owners[key] = [...borders][0];
      }
    }
    return owners;
  }

  scorePosition() {
    const scores = { black: 0, white: this.komi };
    for (const cell of this.board) if (cell) scores[cell] += 1;
    for (const owner of this.territoryOwners()) if (owner) scores[owner] += 1;
    return scores;
  }

  _completeByScore() {
    const scores = this.scorePosition();
    const winner = scores.black === scores.white ? null : scores.black > scores.white ? "black" : "white";
    const margin = Math.abs(scores.black - scores.white);
    this.phase = "complete";
    this.result = { winner, reason: "score", margin, scores };
    this.aiThinking = null;
    const resultText = winner ? `${winner} wins by ${margin}.` : "The game is tied.";
    this._log("result", `Two consecutive passes end the game. ${resultText}`, { scores });
  }

  pauseArena() {
    if (!this.isArenaMode) throw new Error("This is not an AI vs AI game");
    this.arenaPaused = true;
  }

  resumeArena() {
    if (!this.isArenaMode) throw new Error("This is not an AI vs AI game");
    if (this.phase !== "active") throw new Error("This Go game is complete");
    this.arenaPaused = false;
  }

  recordAIInsight(color, { summary, summarySource, explanation, latencyMs, action }) {
    const player = this.players.find((candidate) => candidate.color === color);
    this.aiInsights.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      moveNumber: this.moveNumber + 1,
      color,
      playerName: player.name,
      characterColor: player.character.color,
      characterId: player.character?.id ?? null,
      model: player.aiConfig.model,
      reasoningEffort: player.aiConfig.reasoningEffort,
      summary: String(summary ?? "").trim(),
      summarySource: String(summarySource ?? ""),
      explanation: String(explanation ?? "").trim(),
      latencyMs: Math.round(latencyMs),
      action: String(action ?? ""),
      at: new Date().toISOString(),
    });
  }

  recordAIRetry(color, message, retryNumber, maxRetries) {
    const player = this.players.find((candidate) => candidate.color === color);
    this._log(
      "system",
      `${player.name}'s rejected model move was not played. Retrying automatically (${retryNumber}/${maxRetries}): ${message}`,
      { color, retryNumber, maxRetries },
    );
  }

  setAIError(color, message) {
    this.aiThinking = null;
    const player = this.players.find((candidate) => candidate.color === color);
    this.aiError = { color, message, playerName: player?.name ?? "AI player" };
    this._log("error", `${this.aiError.playerName}'s model request paused: ${message}`, { color });
  }

  clearAIError() {
    this.aiError = null;
  }

  toSave(savedAt = new Date().toISOString()) {
    return {
      gameId: "go",
      version: GO_SAVE_VERSION,
      savedAt,
      state: {
        boardSize: this.boardSize,
        komi: this.komi,
        gameMode: this.gameMode,
        humanColor: this.humanColor,
        arenaPaused: this.arenaPaused,
        phase: this.phase,
        currentColor: this.currentColor,
        moveNumber: this.moveNumber,
        board: [...this.board],
        captures: { ...this.captures },
        consecutivePasses: this.consecutivePasses,
        lastMove: this.lastMove == null ? null : structuredClone(this.lastMove),
        result: this.result == null ? null : structuredClone(this.result),
        logs: structuredClone(this.logs),
        aiInsights: structuredClone(this.aiInsights),
        aiError: this.aiError == null ? null : structuredClone(this.aiError),
        positionHistory: [...this.positionHistory],
        players: this.players.map((player) => ({
          color: player.color,
          name: player.name,
          isHuman: player.isHuman,
          aiConfig: player.aiConfig ? { ...player.aiConfig } : null,
          lastAction: player.lastAction,
          characterId: player.character?.id ?? null,
        })),
        tableTalk: structuredClone(this.tableTalk ?? []),
        review: this.review == null ? null : structuredClone(this.review),
      },
    };
  }

  markSaved(savedAt, restored = this.saveStatus.restored) {
    this.saveStatus = { savedAt, error: null, restored };
  }

  markSaveError() {
    this.saveStatus = { ...this.saveStatus, error: "The latest automatic save failed." };
  }

  _log(kind, text, extra = {}) {
    this.logs.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      kind,
      text,
      moveNumber: this.moveNumber,
      at: new Date().toISOString(),
      ...extra,
    });
    this.logs = this.logs.slice(-220);
  }

  aiSnapshot() {
    const actor = this.currentPlayer;
    if (!actor || actor.isHuman) throw new Error("No AI Go player is currently acting");
    return {
      game: "Go",
      rules: { scoring: "Chinese area", komi: this.komi, ko: "positional superko", suicide: "forbidden" },
      boardSize: this.boardSize,
      moveNumber: this.moveNumber + 1,
      currentColor: this.currentColor,
      boardRows: Array.from({ length: this.boardSize }, (_, row) =>
        this.board.slice(row * this.boardSize, (row + 1) * this.boardSize).map((cell) => cell === "black" ? "B" : cell === "white" ? "W" : ".").join(""),
      ),
      legalPlacements: this.legalPlacements().map(([row, column]) => [row, column, goCoordinate(row, column, this.boardSize)]),
      captures: { ...this.captures },
      consecutivePasses: this.consecutivePasses,
      actor: {
        color: actor.color,
        name: actor.name,
        title: actor.character.title,
        personality: actor.character.personality,
        voice: actor.character.voice ?? "",
      },
      players: this.players.map((player) => ({
        color: player.color,
        name: player.name,
        title: player.character?.title ?? "House guest",
        personality: player.character?.personality ?? "Human guest",
        lastAction: player.lastAction,
      })),
      recentPublicMoves: this.logs.filter((entry) => entry.kind === "move").slice(-20).map((entry) => entry.text),
    };
  }

  /** Input for a post-game review by the AI player of `color`. */
  reviewSnapshot(color) {
    if (this.phase !== "complete") throw new Error("Finish the game before asking for a review");
    const reviewer = this.players.find((player) => player.color === color && !player.isHuman);
    if (!reviewer) throw new Error("Only an AI player can review this game");
    return {
      game: "Go",
      rules: { scoring: "Chinese area", komi: this.komi },
      boardSize: this.boardSize,
      finalBoardRows: Array.from({ length: this.boardSize }, (_, row) =>
        this.board.slice(row * this.boardSize, (row + 1) * this.boardSize).map((cell) => cell === "black" ? "B" : cell === "white" ? "W" : ".").join(""),
      ),
      result: this.result,
      captures: { ...this.captures },
      reviewer: {
        color: reviewer.color,
        name: reviewer.name,
        title: reviewer.character.title,
        personality: reviewer.character.personality,
        voice: reviewer.character.voice ?? "",
      },
      players: this.players.map((player) => ({ color: player.color, name: player.name, isHuman: player.isHuman })),
      moveRecord: this.logs.filter((entry) => entry.kind === "move" || entry.kind === "result").map((entry) => entry.text),
    };
  }

  publicState() {
    const aiConfigs = this.players.filter((player) => !player.isHuman).map((player) => player.aiConfig);
    const models = new Set(aiConfigs.map((config) => config.model));
    const efforts = new Set(aiConfigs.map((config) => config.reasoningEffort));
    return {
      tableTalk: this.tableTalk ?? [],
      gameId: "go",
      gameMode: this.gameMode,
      boardSize: this.boardSize,
      komi: this.komi,
      phase: this.phase,
      currentColor: this.currentColor,
      moveNumber: this.moveNumber,
      board: Array.from({ length: this.boardSize }, (_, row) => this.board.slice(row * this.boardSize, (row + 1) * this.boardSize)),
      captures: { ...this.captures },
      consecutivePasses: this.consecutivePasses,
      lastMove: this.lastMove,
      result: this.result,
      territory: this.phase === "complete" && this.result?.reason === "score"
        ? (() => {
            const owners = this.territoryOwners();
            return Array.from({ length: this.boardSize }, (_, row) => owners.slice(row * this.boardSize, (row + 1) * this.boardSize));
          })()
        : null,
      review: this.review,
      reviewPending: this.reviewPending ?? null,
      arena: this.isArenaMode ? { paused: this.arenaPaused } : null,
      model: models.size === 1 ? aiConfigs[0].model : "mixed",
      reasoningEffort: efforts.size === 1 ? aiConfigs[0].reasoningEffort : "mixed",
      noLocalFallback: true,
      save: { ...this.saveStatus },
      aiThinking: this.aiThinking,
      aiError: this.aiError,
      aiInsights: [...this.aiInsights].reverse(),
      players: this.players.map((player) => ({ ...player, character: player.character ? { ...player.character } : null, aiConfig: player.aiConfig ? { ...player.aiConfig } : null })),
      humanCanAct: this.phase === "active" && Boolean(this.currentPlayer?.isHuman) && !this.aiError,
      logs: [...this.logs].reverse(),
    };
  }
}
