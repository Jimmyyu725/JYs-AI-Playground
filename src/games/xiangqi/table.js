// A Xiangqi table: the pure engine state plus the seats around it (a human or AI
// characters with their model settings), AI status, insights, table talk and the arena
// pause flag. The room module owns one table at a time and drives the AI turns.

import { normalizeModelConfig } from "../../platform/model-registry.js";
import { findCharacter, seatCharacters } from "../../platform/seating.js";
import { buildXiangqiAiView } from "./ai-view.js";
import {
  SIDES,
  XiangqiRuleError,
  applyAction,
  createXiangqiGame,
  legalMoves,
  publicView,
  restoreGame,
  serializeGame,
} from "./engine.js";

export const XIANGQI_TABLE_SAVE_VERSION = 1;

function ruleError(message, status = 400) {
  const error = new XiangqiRuleError(message, "invalid_action");
  error.status = status;
  return error;
}

function cleanName(value) {
  return String(value ?? "Player").replace(/\s+/g, " ").trim().slice(0, 18) || "Player";
}

function characterSummary(character) {
  if (!character) return null;
  const { id, name, shortName, title, color, initials } = character;
  return { id, name, shortName, title, color, initials };
}

export class XiangqiTable {
  // config: { gameMode: "human"|"arena", humanSide: "red"|"black"|"random", humanName,
  //           aiPlayers: [{ model, reasoningEffort, characterId }], model, reasoningEffort, arenaPaused }
  constructor(config = {}, { rng = Math.random } = {}) {
    this.gameMode = config.gameMode === "arena" ? "arena" : "human";
    const requestedSide = config.humanSide === "random" ? (rng() < 0.5 ? "red" : "black") : config.humanSide;
    this.humanSide = this.gameMode === "human" ? (requestedSide === "black" ? "black" : "red") : null;
    this.arenaPaused = this.gameMode === "arena" && Boolean(config.arenaPaused);
    this.state = createXiangqiGame({});
    this.aiInsights = [];
    this.aiThinking = null;
    this.aiError = null;
    this.tableTalk = [];
    this.retries = [];
    this.createdAt = new Date().toISOString();
    this.savedAt = null;

    const requestedAI = Array.isArray(config.aiPlayers) ? config.aiPlayers : [];
    const aiCount = this.gameMode === "human" ? 1 : 2;
    const cast = seatCharacters(aiCount, requestedAI.map((player) => player?.characterId), { rng });
    let aiIndex = 0;
    this.players = SIDES.map((side) => {
      if (side === this.humanSide) {
        return { side, color: side, name: cleanName(config.humanName), isHuman: true, character: null, aiConfig: null };
      }
      const character = cast[aiIndex];
      const aiConfig = normalizeModelConfig("xiangqi", requestedAI[aiIndex] ?? config);
      aiIndex += 1;
      return { side, color: side, name: character.name, isHuman: false, character, aiConfig };
    });
    this.state = { ...this.state, seats: { red: this.playerFor("red").character?.id ?? "human", black: this.playerFor("black").character?.id ?? "human" } };
  }

  get isArenaMode() {
    return this.gameMode === "arena";
  }

  get phase() {
    return this.state.status === "complete" ? "complete" : "active";
  }

  get result() {
    return this.state.result;
  }

  playerFor(side) {
    return this.players.find((player) => player.side === side) ?? null;
  }

  get currentPlayer() {
    return this.phase === "active" ? this.playerFor(this.state.turn) : null;
  }

  get aiShouldMove() {
    const actor = this.currentPlayer;
    return Boolean(actor && !actor.isHuman && !this.aiError && !(this.isArenaMode && this.arenaPaused));
  }

  // Human move or resignation. `side` must be the human's side.
  applyHumanAction(action) {
    const human = this.players.find((player) => player.isHuman);
    if (!human) throw ruleError("This is an arena table; no human seat", 409);
    if (this.phase !== "active") throw ruleError("The game is already over", 409);
    if (action?.type === "resign") {
      this.state = applyAction(this.state, { type: "resign", side: human.side });
      // A resignation can land while the AI is still thinking; that request is now moot.
      this.aiThinking = null;
      return this.state;
    }
    if (this.state.turn !== human.side) throw ruleError("It is not your turn", 409);
    this.state = applyAction(this.state, { ...action, type: "move", side: human.side });
    return this.state;
  }

  applyAIMove(side, move) {
    if (this.state.turn !== side) throw ruleError(`It is ${this.state.turn}'s turn, not ${side}'s`, 409);
    this.state = applyAction(this.state, { type: "move", move, side });
    return this.state;
  }

  aiView(side = this.state.turn) {
    const player = this.playerFor(side);
    const character = player?.character
      ? { name: player.character.name, title: player.character.title, personality: player.character.personality }
      : null;
    const talk = this.tableTalk.map((entry) => ({ side: entry.speaker, text: entry.text }));
    return buildXiangqiAiView(this.state, side, { character, tableTalk: talk });
  }

  recordAIInsight(side, { summary, summarySource, explanation, latencyMs, move, attempts }) {
    const player = this.playerFor(side);
    this.aiInsights = [
      ...this.aiInsights,
      {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        side,
        playerName: player?.name ?? side,
        characterId: player?.character?.id ?? null,
        model: player?.aiConfig?.model ?? null,
        reasoningEffort: player?.aiConfig?.reasoningEffort ?? null,
        ply: this.state.ply + 1,
        move,
        summary: String(summary ?? "").slice(0, 2400),
        summarySource: summarySource ?? null,
        explanation: String(explanation ?? "").slice(0, 420),
        latencyMs: Math.round(latencyMs ?? 0),
        attempts: attempts ?? 1,
        at: Date.now(),
      },
    ].slice(-40);
  }

  recordAIRetry(side, message, retryNumber, maxRetries) {
    this.retries = [...this.retries, { side, message: String(message).slice(0, 300), retryNumber, maxRetries, at: Date.now() }].slice(-10);
  }

  setAIError(side, message) {
    this.aiThinking = null;
    this.aiError = { side, color: side, message: String(message).slice(0, 400), playerName: this.playerFor(side)?.name ?? "AI player" };
  }

  clearAIError() {
    this.aiError = null;
  }

  pauseArena() {
    if (!this.isArenaMode) throw ruleError("Only arena tables can be paused", 409);
    this.arenaPaused = true;
  }

  resumeArena() {
    if (!this.isArenaMode) throw ruleError("Only arena tables can be resumed", 409);
    this.arenaPaused = false;
  }

  // Ranks for the ladder: winner place 1, loser place 2; a draw is place 1 for both.
  placeFor(side) {
    const winner = this.state.result?.winner ?? null;
    return !winner || winner === side ? 1 : 2;
  }

  publicState() {
    const view = publicView(this.state);
    const human = this.players.find((player) => player.isHuman);
    const humanTurn = Boolean(human && this.phase === "active" && this.state.turn === human.side);
    return {
      ...view,
      gameMode: this.gameMode,
      phase: this.phase,
      humanSide: this.humanSide,
      arenaPaused: this.arenaPaused,
      players: this.players.map((player) => ({
        side: player.side,
        color: player.side,
        name: player.name,
        isHuman: player.isHuman,
        character: characterSummary(player.character),
        aiConfig: player.aiConfig ? { ...player.aiConfig } : null,
      })),
      legalMoves: humanTurn ? legalMoves(this.state).map(({ move, from, to, captured, givesCheck }) => ({ move, from, to, captured, givesCheck })) : [],
      aiThinking: this.aiThinking ? { ...this.aiThinking } : null,
      aiError: this.aiError ? { ...this.aiError } : null,
      aiInsights: this.aiInsights.slice(-12),
      retries: this.retries.slice(-3),
      tableTalk: this.tableTalk.slice(-30),
      createdAt: this.createdAt,
      savedAt: this.savedAt,
    };
  }

  toSave() {
    return {
      kind: "xiangqi-table",
      version: XIANGQI_TABLE_SAVE_VERSION,
      gameMode: this.gameMode,
      humanSide: this.humanSide,
      arenaPaused: this.arenaPaused,
      players: this.players.map((player) => ({
        side: player.side,
        name: player.name,
        isHuman: player.isHuman,
        characterId: player.character?.id ?? null,
        aiConfig: player.aiConfig,
      })),
      game: serializeGame(this.state),
      aiInsights: this.aiInsights,
      aiError: this.aiError,
      tableTalk: this.tableTalk,
      createdAt: this.createdAt,
    };
  }

  static fromSave(payload) {
    if (!payload || payload.kind !== "xiangqi-table" || payload.version !== XIANGQI_TABLE_SAVE_VERSION) {
      throw new Error("Not a Xiangqi table save");
    }
    const table = Object.create(XiangqiTable.prototype);
    table.gameMode = payload.gameMode === "arena" ? "arena" : "human";
    table.humanSide = table.gameMode === "human" ? (payload.humanSide === "black" ? "black" : "red") : null;
    table.arenaPaused = table.gameMode === "arena" && Boolean(payload.arenaPaused);
    table.state = restoreGame(payload.game);
    table.players = SIDES.map((side) => {
      const saved = (payload.players ?? []).find((player) => player?.side === side);
      if (side === table.humanSide) return { side, color: side, name: cleanName(saved?.name), isHuman: true, character: null, aiConfig: null };
      const character = findCharacter(saved?.characterId);
      if (!character) throw new Error(`Unknown character in Xiangqi save for ${side}`);
      return { side, color: side, name: character.name, isHuman: false, character, aiConfig: normalizeModelConfig("xiangqi", saved?.aiConfig ?? {}) };
    });
    table.aiInsights = Array.isArray(payload.aiInsights) ? payload.aiInsights.slice(-40) : [];
    table.aiError = payload.aiError && typeof payload.aiError === "object" ? payload.aiError : null;
    table.aiThinking = null;
    table.tableTalk = Array.isArray(payload.tableTalk) ? payload.tableTalk.slice(-30) : [];
    table.retries = [];
    table.createdAt = payload.createdAt ?? new Date().toISOString();
    table.savedAt = null;
    return table;
  }
}
