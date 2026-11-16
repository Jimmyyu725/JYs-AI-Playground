import { seatCharacters } from "../platform/seating.js";
import { normalizeModelConfig } from "../platform/model-registry.js";

const COLORS = Object.freeze(["black", "white"]);
const BOARD_SIZES = new Set([13, 15, 19]);
const COLUMN_LABELS = "ABCDEFGHJKLMNOPQRST";

function opposite(color) {
  return color === "black" ? "white" : "black";
}

export function wuziqiCoordinate(row, column, size) {
  return `${COLUMN_LABELS[column]}${size - row}`;
}

export class WuziqiGame {
  constructor(config = {}) {
    const requestedSize = Number.parseInt(config.boardSize, 10);
    this.boardSize = BOARD_SIZES.has(requestedSize) ? requestedSize : 15;
    this.gameMode = config.gameMode === "arena" ? "arena" : "human";
    this.humanColor = config.humanColor === "white" ? "white" : "black";
    this.arenaPaused = this.gameMode === "arena" && Boolean(config.arenaPaused);
    this.phase = "active";
    this.currentColor = "black";
    this.moveNumber = 0;
    this.board = Array(this.boardSize * this.boardSize).fill(null);
    this.lastMove = null;
    this.moves = [];
    this.result = null;
    this.review = null;
    this.logs = [];
    this.aiInsights = [];
    this.aiThinking = null;
    this.aiError = null;

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
        aiConfig: normalizeModelConfig("wuziqi", requestedAI[aiIndex] ?? config),
        lastAction: "",
      };
      aiIndex += 1;
      return player;
    });
    this._log("system", `${this.boardSize}×${this.boardSize} freestyle Wuziqi begins. Five or more connected stones win.`);
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

  _lineThrough(row, column, rowStep, columnStep, color) {
    const cells = [[row, column]];
    for (const direction of [-1, 1]) {
      let nextRow = row + rowStep * direction;
      let nextColumn = column + columnStep * direction;
      const side = [];
      while (this._isInside(nextRow, nextColumn) && this.board[this._index(nextRow, nextColumn)] === color) {
        side.push([nextRow, nextColumn]);
        nextRow += rowStep * direction;
        nextColumn += columnStep * direction;
      }
      if (direction === -1) cells.unshift(...side.reverse());
      else cells.push(...side);
    }
    return cells;
  }

  _winningLine(row, column, color) {
    for (const [rowStep, columnStep] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      const line = this._lineThrough(row, column, rowStep, columnStep, color);
      if (line.length >= 5) return line;
    }
    return null;
  }

  applyAction(color, action, row = null, column = null) {
    if (this.phase !== "active") throw new Error("This Wuziqi game is complete");
    if (color !== this.currentColor) throw new Error(`It is ${this.currentColor}'s turn`);
    const player = this.currentPlayer;
    if (!player) throw new Error("Current player is unavailable");

    if (action === "resign") {
      player.lastAction = "Resigned";
      this.phase = "complete";
      this.result = { winner: opposite(color), reason: "resignation", winningLine: null };
      this.aiThinking = null;
      this._log("result", `${player.name} resigns. ${opposite(color)} wins.`, { color });
      return;
    }
    if (action !== "place") throw new Error(`Unknown Wuziqi action “${action}”`);
    if (!Number.isInteger(row) || !Number.isInteger(column) || !this._isInside(row, column)) throw new Error("Choose an intersection on the board");
    const index = this._index(row, column);
    if (this.board[index]) throw new Error(`${wuziqiCoordinate(row, column, this.boardSize)} is occupied`);

    this.board[index] = color;
    this.moveNumber += 1;
    const coordinate = wuziqiCoordinate(row, column, this.boardSize);
    player.lastAction = coordinate;
    this.lastMove = { action: "place", color, row, column, coordinate, moveNumber: this.moveNumber };
    this.moves.push({ moveNumber: this.moveNumber, color, row, column, coordinate });
    this._log("move", `${player.name} plays ${coordinate}.`, { color, row, column });

    const winningLine = this._winningLine(row, column, color);
    if (winningLine) {
      this.phase = "complete";
      this.result = { winner: color, reason: "five", winningLine };
      this.aiThinking = null;
      this._log("result", `${player.name} connects ${winningLine.length} stones and wins.`, { color, winningLine });
      return;
    }
    if (this.moveNumber === this.board.length) {
      this.phase = "complete";
      this.result = { winner: null, reason: "draw", winningLine: null };
      this.aiThinking = null;
      this._log("result", "The board is full. The game is a draw.");
      return;
    }
    this.currentColor = opposite(this.currentColor);
  }

  pauseArena() {
    if (!this.isArenaMode) throw new Error("This is not an AI vs AI game");
    this.arenaPaused = true;
  }

  resumeArena() {
    if (!this.isArenaMode) throw new Error("This is not an AI vs AI game");
    if (this.phase !== "active") throw new Error("This Wuziqi game is complete");
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
    this._log("system", `${player.name}'s rejected move was not played. Retrying automatically (${retryNumber}/${maxRetries}): ${message}`, { color, retryNumber, maxRetries });
  }

  /** The AI players who can be asked for a post-game review (the human's opponent, or either arena seat). */
  reviewers() {
    return this.players.filter((player) => !player.isHuman);
  }

  reviewSnapshot(color) {
    if (this.phase !== "complete") throw new Error("The game is not finished yet");
    const reviewer = this.reviewers().find((player) => player.color === color) ?? this.reviewers()[0];
    if (!reviewer) throw new Error("There is no AI player to review this game");
    return {
      game: "Wuziqi / freestyle Gomoku",
      boardSize: this.boardSize,
      reviewer: { color: reviewer.color, name: reviewer.name, title: reviewer.character.title, personality: reviewer.character.personality, voice: reviewer.character.voice ?? "", role: "player" },
      players: this.players.map((player) => ({ color: player.color, name: player.name, isHuman: player.isHuman })),
      result: { winner: this.result.winner, reason: this.result.reason, winningLine: (this.result.winningLine ?? []).map(([row, column]) => wuziqiCoordinate(row, column, this.boardSize)) },
      moves: this.moves.map((move) => ({ moveNumber: move.moveNumber, color: move.color, coordinate: move.coordinate, row: move.row, column: move.column })),
      finalBoardRows: Array.from({ length: this.boardSize }, (_, row) =>
        this.board.slice(row * this.boardSize, (row + 1) * this.boardSize).map((cell) => cell === "black" ? "B" : cell === "white" ? "W" : ".").join(""),
      ),
    };
  }

  setReview(review) {
    this.review = review;
  }

  /** Plain data for saving to disk; restore with WuziqiGame.restore(). */
  toSave() {
    return {
      version: 1,
      boardSize: this.boardSize,
      gameMode: this.gameMode,
      humanColor: this.humanColor,
      arenaPaused: this.arenaPaused,
      phase: this.phase,
      currentColor: this.currentColor,
      moveNumber: this.moveNumber,
      board: [...this.board],
      lastMove: this.lastMove,
      moves: this.moves,
      result: this.result,
      resultRecorded: Boolean(this.resultRecorded),
      review: this.review?.status === "pending" ? null : this.review,
      logs: this.logs,
      aiInsights: this.aiInsights,
      aiError: this.aiError,
      tableTalk: this.tableTalk ?? [],
      players: this.players.map((player) => ({ ...player })),
    };
  }

  /**
   * Rebuilds a saved game. A model request that was in flight is lost, so it comes back as a paused
   * request for an explicit retry, and a running arena comes back paused.
   */
  static restore(saved) {
    if (saved?.version !== 1 || !BOARD_SIZES.has(saved.boardSize) || saved.board?.length !== saved.boardSize ** 2) throw new Error("Unrecognized Wuziqi save");
    const game = Object.create(WuziqiGame.prototype);
    Object.assign(game, saved);
    delete game.version;
    game.board = [...saved.board];
    game.aiThinking = null;
    game.moves = saved.moves ?? [];
    game.review = saved.review ?? null;
    if (game.gameMode === "arena" && game.phase === "active") game.arenaPaused = true;
    return game;
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

  _log(kind, text, extra = {}) {
    this.logs.push({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, kind, text, moveNumber: this.moveNumber, at: new Date().toISOString(), ...extra });
    this.logs = this.logs.slice(-260);
  }

  legalPlacements() {
    const moves = [];
    for (let row = 0; row < this.boardSize; row += 1) {
      for (let column = 0; column < this.boardSize; column += 1) {
        if (!this.board[this._index(row, column)]) moves.push([row, column]);
      }
    }
    return moves;
  }

  aiSnapshot() {
    const actor = this.currentPlayer;
    if (!actor || actor.isHuman) throw new Error("No AI Wuziqi player is currently acting");
    return {
      game: "Wuziqi / freestyle Gomoku",
      rules: { win: "five or more contiguous stones", overlineWins: true, renjuForbiddenMoves: false },
      boardSize: this.boardSize,
      moveNumber: this.moveNumber + 1,
      currentColor: this.currentColor,
      boardRows: Array.from({ length: this.boardSize }, (_, row) =>
        this.board.slice(row * this.boardSize, (row + 1) * this.boardSize).map((cell) => cell === "black" ? "B" : cell === "white" ? "W" : ".").join(""),
      ),
      legalPlacements: this.legalPlacements().map(([row, column]) => [row, column, wuziqiCoordinate(row, column, this.boardSize)]),
      actor: { color: actor.color, name: actor.name, title: actor.character.title, personality: actor.character.personality, voice: actor.character.voice ?? "" },
      players: this.players.map((player) => ({
        color: player.color,
        name: player.name,
        title: player.character?.title ?? "House guest",
        personality: player.character?.personality ?? "Human guest",
        lastAction: player.lastAction,
      })),
      recentPublicMoves: this.logs.filter((entry) => entry.kind === "move").slice(-24).map((entry) => entry.text),
    };
  }

  publicState() {
    const aiConfigs = this.players.filter((player) => !player.isHuman).map((player) => player.aiConfig);
    const models = new Set(aiConfigs.map((config) => config.model));
    const efforts = new Set(aiConfigs.map((config) => config.reasoningEffort));
    return {
      tableTalk: this.tableTalk ?? [],
      gameId: "wuziqi",
      gameMode: this.gameMode,
      boardSize: this.boardSize,
      phase: this.phase,
      currentColor: this.currentColor,
      moveNumber: this.moveNumber,
      board: Array.from({ length: this.boardSize }, (_, row) => this.board.slice(row * this.boardSize, (row + 1) * this.boardSize)),
      lastMove: this.lastMove,
      moves: this.moves.map((move) => ({ ...move })),
      result: this.result,
      review: this.review,
      arena: this.isArenaMode ? { paused: this.arenaPaused } : null,
      model: models.size === 1 ? aiConfigs[0].model : "mixed",
      reasoningEffort: efforts.size === 1 ? aiConfigs[0].reasoningEffort : "mixed",
      noLocalFallback: true,
      aiThinking: this.aiThinking,
      aiError: this.aiError,
      aiInsights: [...this.aiInsights].reverse(),
      players: this.players.map((player) => ({ ...player, character: player.character ? { ...player.character } : null, aiConfig: player.aiConfig ? { ...player.aiConfig } : null })),
      humanCanAct: this.phase === "active" && Boolean(this.currentPlayer?.isHuman) && !this.aiError,
      logs: [...this.logs].reverse(),
    };
  }
}
