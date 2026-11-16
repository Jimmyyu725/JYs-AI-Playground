// One Taiwan Mahjong table: seats (human or AI character), the engine state, and the AI
// turn loop. The model call is injected (`decide`) so tests can drive the table without a
// network. The table pauses on any AI failure until `retryAI()` is called; malformed or
// illegal answers are retried automatically with the error fed back before pausing.

import {
  applyAction,
  createTaiwanMahjongGame,
  getLegalActions,
  getPublicState,
  getSeatsToAct,
  isLegalAction,
  startNextHand,
} from "./engine.js";
import { TABLE_TALK_NUDGE, TAIWAN_MAHJONG_RETRYABLE_CODES, buildDecisionInstructions, buildSeatSnapshot, parseSeatDecision } from "./ai-view.js";
import { pushTableTalk } from "../../platform/table-talk.js";

export const MAX_AUTOMATIC_RETRIES = 2;
export const LENGTHS = Object.freeze({
  single: { rounds: 1, maxHands: 1, label: "One hand" },
  short: { rounds: 1, maxHands: 4, label: "Four hands" },
  east: { rounds: 1, maxHands: 16, label: "East round 東風圈" },
});

function publicCharacter(character) {
  if (!character) return null;
  const { id, name, shortName, title, color, initials } = character;
  return { id, name, shortName, title, color, initials };
}

export class TaiwanMahjongTable {
  /**
   * @param {object} config
   * @param {"human-vs-ai"|"arena"} config.mode
   * @param {Array<{ character, aiConfig }>} config.aiSeats  AI seats in seat order (3 or 4)
   * @param {string} [config.humanName]
   * @param {string} [config.length] one of LENGTHS
   * @param {number} [config.seed]
   * @param {object} [config.state] a saved engine state to resume
   */
  constructor({ mode = "human-vs-ai", aiSeats, humanName = "You", length = "short", seed, state = null, wall } = {}) {
    if (mode !== "human-vs-ai" && mode !== "arena") throw Object.assign(new Error("mode must be human-vs-ai or arena"), { status: 400 });
    const aiCount = mode === "arena" ? 4 : 3;
    if (!Array.isArray(aiSeats) || aiSeats.length !== aiCount) throw new Error(`A ${mode} table needs ${aiCount} AI seats`);
    const lengthKey = LENGTHS[length] ? length : "short";
    this.mode = mode;
    this.length = lengthKey;
    this.humanSeat = mode === "arena" ? null : 0;
    const ai = [...aiSeats];
    this.players = Array.from({ length: 4 }, (_, seat) => {
      if (seat === this.humanSeat) return { seat, isHuman: true, name: String(humanName || "You").slice(0, 24), character: null, aiConfig: null };
      const { character, aiConfig } = ai.shift();
      return { seat, isHuman: false, name: character.shortName ?? character.name, character, aiConfig };
    });
    const { rounds, maxHands } = LENGTHS[lengthKey];
    this.state = state ?? createTaiwanMahjongGame({ rounds, maxHands, seed, wall, dealer: 0 });
    this.tableTalk = [];
    this.aiInsights = [];
    this.aiThinking = null;
    this.aiError = null;
    this.arenaPaused = false;
    this.createdAt = Date.now();
    this.tableId = `${this.createdAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  get isOver() {
    return this.state.phase === "gameOver";
  }

  /** The AI seat the loop should ask next, or null when a human, a pause or the hand end blocks it. */
  nextAISeat() {
    if (this.aiError || (this.mode === "arena" && this.arenaPaused)) return null;
    const seats = getSeatsToAct(this.state);
    return seats.find((seat) => !this.players[seat].isHuman) ?? null;
  }

  /** Every AI seat whose decision is due now: one on a turn, several in a claim window. */
  aiSeatsToAct() {
    if (this.aiError || (this.mode === "arena" && this.arenaPaused)) return [];
    return getSeatsToAct(this.state).filter((seat) => !this.players[seat].isHuman);
  }

  seatStillToAct(seat) {
    return getSeatsToAct(this.state).includes(seat);
  }

  humanAction(action) {
    if (this.humanSeat === null) throw Object.assign(new Error("This is an arena table; nobody human is seated"), { status: 409 });
    if (!getSeatsToAct(this.state).includes(this.humanSeat)) throw Object.assign(new Error("It is not your decision right now"), { status: 409 });
    if (!isLegalAction(this.state, this.humanSeat, action)) throw Object.assign(new Error("That move is not legal here"), { status: 400 });
    this.state = applyAction(this.state, this.humanSeat, action);
    // A paused AI seat whose decision the human's move made moot (the claim window closed) is no longer stuck.
    if (this.aiError && !getSeatsToAct(this.state).includes(this.aiError.seat)) this.aiError = null;
  }

  nextHand() {
    if (this.state.phase !== "handOver") throw Object.assign(new Error("The current hand is not over"), { status: 409 });
    this.state = startNextHand(this.state);
  }

  snapshotFor(seat) {
    const snapshot = buildSeatSnapshot(this.state, seat, { players: this.players });
    return snapshot;
  }

  /**
   * Asks one AI seat for its decision and applies it. `decide({ instructions, input, modelConfig, voice })`
   * returns `{ output, tableTalk, reasoningSummary }`. Throws (after setting aiError) on failure.
   */
  async playAISeat(seat, decide, { onRetry } = {}) {
    const player = this.players[seat];
    let retry = null;
    for (let attempt = 0; attempt <= MAX_AUTOMATIC_RETRIES; attempt += 1) {
      const snapshot = this.snapshotFor(seat);
      const instructions = buildDecisionInstructions(snapshot, { character: player.character, retry, tableTalk: false }) + TABLE_TALK_NUDGE;
      const startedAt = Date.now();
      const response = await decide({ instructions, input: snapshot, modelConfig: player.aiConfig, voice: player.character?.voice ?? "" });
      const answer = { ...(response.output ?? {}), tableTalk: response.tableTalk ?? "" };
      let parsed = parseSeatDecision(this.state, seat, answer, { expectedSeq: snapshot.seq });
      // A human answering the same claim window moves seq on. The seat's own options do not
      // change with other seats' responses, so the answer stands if the seat is still deciding.
      if (parsed.code === "stale_decision") parsed = parseSeatDecision(this.state, seat, answer);
      if (parsed.code === "not_your_turn") return null;
      if (parsed.ok) {
        this.state = applyAction(this.state, seat, parsed.action);
        const talk = pushTableTalk(this, { speaker: seat, playerName: player.name, characterId: player.character?.id ?? null, text: parsed.tableTalk });
        this.aiInsights = [...this.aiInsights, {
          seat,
          playerName: player.name,
          action: parsed.label,
          summary: response.reasoningSummary || "",
          latencyMs: Date.now() - startedAt,
          retries: attempt,
          at: Date.now(),
        }].slice(-12);
        return { decision: parsed, talk };
      }
      if (!TAIWAN_MAHJONG_RETRYABLE_CODES.includes(parsed.code) || attempt === MAX_AUTOMATIC_RETRIES) {
        const error = new Error(`${player.name} gave an unusable answer: ${parsed.error}`);
        error.code = parsed.code;
        throw error;
      }
      retry = { retryNumber: attempt + 1, maxRetries: MAX_AUTOMATIC_RETRIES, rejectedDecision: parsed.rejectedDecision, error: parsed.error };
      onRetry?.({ seat, retryNumber: attempt + 1, maxRetries: MAX_AUTOMATIC_RETRIES, error: parsed.error });
    }
    return null;
  }

  setAIError(seat, message) {
    this.aiError = { seat, playerName: this.players[seat]?.name ?? `Seat ${seat}`, message, at: Date.now() };
    this.aiThinking = null;
  }

  clearAIError() {
    this.aiError = null;
  }

  /** Final places by score (1 = best; equal scores share a place). */
  standings() {
    const scores = this.state.scores;
    return scores.map((score) => 1 + scores.filter((other) => other > score).length);
  }

  publicState() {
    const state = this.state;
    const arena = this.mode === "arena";
    const view = getPublicState(state, this.humanSeat);
    if (arena) {
      // Spectators of an all-AI table see every hand; the AI seats never receive this view.
      view.players = view.players.map((player) => ({ ...player, hand: [...state.players[player.seat].hand] }));
      view.drawnTile = state.phase === "discard" ? state.turn.drawnTile : null;
    }
    return {
      tableId: this.tableId,
      mode: this.mode,
      length: this.length,
      lengthLabel: LENGTHS[this.length].label,
      humanSeat: this.humanSeat,
      ...view,
      players: view.players.map((player) => {
        const seat = this.players[player.seat];
        return {
          ...player,
          name: seat.name,
          isHuman: seat.isHuman,
          character: publicCharacter(seat.character),
          model: seat.aiConfig?.model ?? null,
          reasoningEffort: seat.aiConfig?.reasoningEffort ?? null,
        };
      }),
      turnDrew: state.phase === "discard" ? state.turn.drew : null,
      log: state.log.slice(-60),
      logTotal: state.log.length,
      history: state.history,
      standings: state.phase === "gameOver" ? this.standings() : null,
      humanActions: this.humanSeat === null ? [] : getLegalActions(state, this.humanSeat),
      tableTalk: this.tableTalk,
      aiInsights: this.aiInsights,
      aiThinking: this.aiThinking,
      aiError: this.aiError,
      arenaPaused: this.arenaPaused,
    };
  }

  toJSON() {
    return {
      mode: this.mode,
      length: this.length,
      players: this.players.map(({ seat, isHuman, name, character, aiConfig }) => ({ seat, isHuman, name, characterId: character?.id ?? null, aiConfig })),
      state: this.state,
      tableTalk: this.tableTalk,
      arenaPaused: this.arenaPaused,
      createdAt: this.createdAt,
      tableId: this.tableId,
    };
  }

  static fromJSON(saved, findCharacter) {
    const aiSeats = saved.players.filter((player) => !player.isHuman).map((player) => ({
      character: findCharacter(player.characterId) ?? { id: player.characterId, name: player.name, shortName: player.name },
      aiConfig: player.aiConfig,
    }));
    const human = saved.players.find((player) => player.isHuman);
    const table = new TaiwanMahjongTable({ mode: saved.mode, aiSeats, humanName: human?.name, length: saved.length, state: saved.state });
    table.tableTalk = saved.tableTalk ?? [];
    table.arenaPaused = Boolean(saved.arenaPaused);
    table.createdAt = saved.createdAt ?? Date.now();
    if (saved.tableId) table.tableId = saved.tableId;
    return table;
  }
}
