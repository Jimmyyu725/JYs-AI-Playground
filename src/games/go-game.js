import { AI_CHARACTERS } from "../platform/characters.js";
import { normalizeModelConfig } from "../platform/model-registry.js";

const COLORS = Object.freeze(["black", "white"]);
const BOARD_SIZES = new Set([9, 13, 19]);
const COLUMN_LABELS = "ABCDEFGHJKLMNOPQRST";

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

    const requestedAI = Array.isArray(config.aiPlayers) ? config.aiPlayers : [];
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
      const character = AI_CHARACTERS[colorIndex === 0 ? 0 : 2];
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

  scorePosition() {
    const scores = { black: 0, white: this.komi };
    for (const cell of this.board) if (cell) scores[cell] += 1;
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
        if (borders.size === 1) scores[[...borders][0]] += region.length;
      }
    }
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

  publicState() {
    const aiConfigs = this.players.filter((player) => !player.isHuman).map((player) => player.aiConfig);
    const models = new Set(aiConfigs.map((config) => config.model));
    const efforts = new Set(aiConfigs.map((config) => config.reasoningEffort));
    return {
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
