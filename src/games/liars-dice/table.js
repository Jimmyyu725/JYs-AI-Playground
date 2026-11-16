// One Liar's Dice table: the pure engine state plus the people sitting at it
// (human seat, AI characters and their model configs), AI status, table talk and
// insights. The room module owns one of these; everything here is synchronous.

import { normalizeModelConfig } from "../../platform/model-registry.js";
import { findCharacter, seatCharacters } from "../../platform/seating.js";
import { buildAIView } from "./ai-view.js";
import {
  applyAction,
  calzaAllowed,
  createLiarsDiceGame,
  legalBidRanges,
  LiarsDiceError,
  MAX_SEATS,
  MIN_SEATS,
  restoreLiarsDiceState,
  viewForSeat,
} from "./engine.js";

export const TABLE_SAVE_VERSION = 1;
const MAX_INSIGHTS = 60;

function tableError(message, status = 400, code = "bad_request") {
  const error = new LiarsDiceError(message, code);
  error.status = status;
  return error;
}

function publicCharacter(character) {
  if (!character) return null;
  const { id, name, shortName, title, color, initials } = character;
  return { id, name, shortName, title, color, initials };
}

export class LiarsDiceTable {
  /**
   * @param {object} config
   * @param {"human"|"arena"} [config.gameMode]
   * @param {number} [config.seatCount] 2-6, default 4.
   * @param {string} [config.humanName]
   * @param {{model, reasoningEffort, characterId}[]} [config.aiPlayers] one entry per AI seat, in seat order.
   * @param {{calza?: boolean, palifico?: boolean}} [config.rules]
   */
  constructor(config = {}, { rng } = {}) {
    if (config === null || typeof config !== "object") throw tableError("Table setup must be an object");
    this.gameMode = config.gameMode === "arena" ? "arena" : "human";
    const seatCount = Number(config.seatCount ?? 4);
    if (!Number.isInteger(seatCount) || seatCount < MIN_SEATS || seatCount > MAX_SEATS) {
      throw tableError(`Liar's Dice seats ${MIN_SEATS} to ${MAX_SEATS} players`);
    }
    const rules = {
      calza: config.rules?.calza !== false,
      palifico: config.rules?.palifico !== false,
    };
    this.id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.createdAt = new Date().toISOString();
    this.arenaPaused = false;
    this.aiThinking = null;
    this.aiError = null;
    this.aiInsights = [];
    this.tableTalk = [];
    this.holdUntil = 0;

    const humanSeats = this.gameMode === "human" ? 1 : 0;
    const requested = Array.isArray(config.aiPlayers) ? config.aiPlayers : [];
    const cast = seatCharacters(seatCount - humanSeats, requested.map((player) => player?.characterId), rng ? { rng } : undefined);
    const fallbackConfig = { model: config.model, reasoningEffort: config.reasoningEffort };
    this.players = [];
    for (let seat = 0; seat < seatCount; seat += 1) {
      if (seat < humanSeats) {
        this.players.push({
          seat,
          isHuman: true,
          name: String(config.humanName ?? "You").trim().slice(0, 18) || "You",
          character: null,
          aiConfig: null,
        });
        continue;
      }
      const aiIndex = seat - humanSeats;
      const character = cast[aiIndex];
      this.players.push({
        seat,
        isHuman: false,
        name: character.name,
        character,
        aiConfig: normalizeModelConfig("liars-dice", requested[aiIndex] ?? fallbackConfig),
      });
    }
    this.state = createLiarsDiceGame({ seatCount, rules, seed: Math.floor((rng ?? Math.random)() * 0xffffffff) });
  }

  get isArenaMode() {
    return this.gameMode === "arena";
  }

  get seatNames() {
    return this.players.map((player) => player.name);
  }

  get humanSeat() {
    return this.isArenaMode ? null : 0;
  }

  get currentActor() {
    if (this.state.phase !== "bidding") return null;
    return this.players[this.state.currentSeat] ?? null;
  }

  get isComplete() {
    return this.state.phase === "complete";
  }

  /**
   * Applies an action for `seat`. Returns { reveal } where reveal is the new lastReveal when the
   * action was a challenge (dudo or calza), else null. Throws LiarsDiceError (status 400) when illegal.
   */
  act(seat, action) {
    const before = this.state.lastReveal;
    try {
      this.state = applyAction(this.state, seat, action);
    } catch (error) {
      if (error instanceof LiarsDiceError) error.status = error.code === "not_your_turn" || error.code === "game_over" ? 409 : 400;
      throw error;
    }
    const reveal = this.state.lastReveal !== before && this.state.lastReveal ? this.state.lastReveal : null;
    return { reveal };
  }

  aiView(seat) {
    return buildAIView(this.state, seat, { seatNames: this.seatNames, character: this.players[seat]?.character });
  }

  setAIError(seat, message) {
    this.aiError = { seat, message, playerName: this.players[seat]?.name ?? "AI player" };
    this.aiThinking = null;
  }

  clearAIError() {
    this.aiError = null;
  }

  pauseArena() {
    if (!this.isArenaMode) throw tableError("This is not an AI arena table", 409, "not_arena");
    this.arenaPaused = true;
  }

  resumeArena() {
    if (!this.isArenaMode) throw tableError("This is not an AI arena table", 409, "not_arena");
    this.arenaPaused = false;
  }

  recordInsight(seat, { action, explanation, summary, latencyMs, attempts }) {
    const player = this.players[seat];
    this.aiInsights.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      round: this.state.round,
      seat,
      playerName: player?.name,
      characterId: player?.character?.id ?? null,
      model: player?.aiConfig?.model,
      reasoningEffort: player?.aiConfig?.reasoningEffort,
      action,
      explanation,
      summary: summary || explanation,
      latencyMs: Math.round(latencyMs ?? 0),
      attempts: attempts ?? 1,
      at: Date.now(),
    });
    this.aiInsights = this.aiInsights.slice(-MAX_INSIGHTS);
  }

  /** The participants list for ResultsStore.recordMatch, or null while the game runs. */
  matchResult() {
    if (!this.isComplete || !this.state.result) return null;
    const placeBySeat = new Map(this.state.result.placements.map((entry) => [entry.seat, entry.place]));
    return {
      mode: this.isArenaMode ? "arena" : "human-vs-ai",
      participants: this.players.map((player) => ({ player, place: placeBySeat.get(player.seat) })),
      details: { rounds: this.state.result.rounds, winnerSeat: this.state.result.winnerSeat, seats: this.players.length },
    };
  }

  publicState() {
    const viewer = this.humanSeat;
    const view = viewForSeat(this.state, viewer, { revealAll: this.isArenaMode || this.isComplete });
    const actor = this.currentActor;
    const humanTurn = Boolean(actor?.isHuman) && !this.aiError;
    return {
      tableId: this.id,
      gameMode: this.gameMode,
      humanSeat: viewer,
      ...view,
      players: this.players.map((player) => ({
        seat: player.seat,
        isHuman: player.isHuman,
        name: player.name,
        character: publicCharacter(player.character),
        aiConfig: player.aiConfig,
      })),
      human: viewer === null
        ? null
        : {
            canAct: humanTurn && !this.isComplete,
            canDudo: humanTurn && Boolean(this.state.currentBid),
            canCalza: humanTurn && calzaAllowed(this.state),
            bidRanges: humanTurn ? legalBidRanges(this.state, viewer) : [],
          },
      arena: this.isArenaMode ? { paused: this.arenaPaused } : null,
      aiThinking: this.aiThinking,
      aiError: this.aiError,
      // A model's rationale can mention its own hidden dice, so a human opponent only sees it after the game.
      aiInsights: this.isArenaMode || this.isComplete ? this.aiInsights.slice(-24) : [],
      tableTalk: this.tableTalk,
      holdUntil: this.holdUntil,
      serverNow: Date.now(),
    };
  }

  toSave() {
    return {
      version: TABLE_SAVE_VERSION,
      id: this.id,
      createdAt: this.createdAt,
      gameMode: this.gameMode,
      arenaPaused: this.arenaPaused,
      aiError: this.aiError,
      aiInsights: this.aiInsights,
      tableTalk: this.tableTalk,
      players: this.players.map((player) => ({
        seat: player.seat,
        isHuman: player.isHuman,
        name: player.name,
        characterId: player.character?.id ?? null,
        aiConfig: player.aiConfig,
      })),
      state: this.state,
    };
  }

  /** Rebuilds a table from toSave() output; throws on a corrupt save. */
  static fromSave(saved) {
    if (!saved || saved.version !== TABLE_SAVE_VERSION || !Array.isArray(saved.players)) throw tableError("Unsupported Liar's Dice table save", 400, "bad_save");
    const state = restoreLiarsDiceState(saved.state);
    if (saved.players.length !== state.seats.length) throw tableError("Saved players do not match the saved seats", 400, "bad_save");
    const table = Object.create(LiarsDiceTable.prototype);
    table.id = String(saved.id ?? "restored");
    table.createdAt = saved.createdAt ?? new Date().toISOString();
    table.gameMode = saved.gameMode === "arena" ? "arena" : "human";
    table.arenaPaused = Boolean(saved.arenaPaused);
    table.aiThinking = null;
    table.aiError = saved.aiError ?? null;
    table.aiInsights = Array.isArray(saved.aiInsights) ? saved.aiInsights.slice(-MAX_INSIGHTS) : [];
    table.tableTalk = Array.isArray(saved.tableTalk) ? saved.tableTalk.slice(-30) : [];
    table.holdUntil = 0;
    table.players = saved.players.map((player, seat) => {
      if (player.isHuman) return { seat, isHuman: true, name: String(player.name ?? "You").slice(0, 18), character: null, aiConfig: null };
      const character = findCharacter(player.characterId);
      if (!character) throw tableError(`Saved character ${player.characterId} is not in the roster`, 400, "bad_save");
      return { seat, isHuman: false, name: character.name, character, aiConfig: normalizeModelConfig("liars-dice", player.aiConfig ?? {}) };
    });
    table.state = state;
    return table;
  }
}
