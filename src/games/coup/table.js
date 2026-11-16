// One live Coup table: seats (human or AI character), the engine state, and the AI driver.
//
// The driver asks every AI seat the engine is waiting on, in parallel (reaction windows have
// several responders). An answer is applied only if the decision it was made for is still open;
// otherwise it is dropped. Malformed answers are retried twice with the error fed back, then the
// table pauses until someone presses retry. There is no fallback player.

import { normalizeModelConfig } from "../../platform/model-registry.js";
import { seatCharacters } from "../../platform/seating.js";
import { pushTableTalk } from "../../platform/table-talk.js";
import { buildCoupAiView, parseCoupDecision } from "./ai-view.js";
import {
  CoupRuleError,
  MAX_PLAYERS,
  MIN_PLAYERS,
  applyAction,
  awaitingSeats,
  createCoupGame,
  describeAction,
  getLegalActions,
  isAlive,
  liveCards,
  publicView,
  restoreCoupGame,
  serializeCoupGame,
} from "./engine.js";

export const GAME_ID = "coup";
export const MODES = Object.freeze(["human-vs-ai", "arena"]);
export const MAX_DECISION_RETRIES = 2;
/** Arena games stop after this many turns (AI players can steal back and forth forever). */
export const ARENA_TURN_CAP = 150;
const WINDOW_PHASES = new Set(["challenge_action", "block", "challenge_block"]);
// Gateway errors that mean "the answer was malformed", worth an automatic retry.
const RETRYABLE_GATEWAY_CODES = new Set(["invalid_json", "empty_output", "incomplete_response"]);

function tableError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function publicCharacter(character) {
  if (!character) return null;
  const { id, name, shortName, title, color, initials } = character;
  return { id, name, shortName, title, color, initials };
}

export class CoupTable {
  /**
   * @param {object} config { mode, playerCount, humanName, aiPlayers: [{ model, reasoningEffort, characterId }], seed }
   * @param {object} deps   { decide(request) -> { output, tableTalk, reasoningSummary }, emit(type, payload), rng }
   */
  constructor(config = {}, { decide, emit = () => {}, rng = Math.random, restore = null } = {}) {
    if (typeof decide !== "function") throw new Error("CoupTable needs a decide function");
    this.decide = decide;
    this.emit = emit;
    this.inflight = new Map();
    this.insights = {};
    this.tableTalk = [];
    this.aiError = null;
    this.paused = false;
    this.stalemate = null;
    this.id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    if (restore) {
      Object.assign(this, {
        id: restore.id ?? this.id,
        mode: restore.mode,
        seats: restore.seats,
        state: restoreCoupGame(restore.state),
        tableTalk: restore.tableTalk ?? [],
        insights: restore.insights ?? {},
        stalemate: restore.stalemate ?? null,
        paused: restore.mode === "arena",
      });
      return;
    }

    const mode = MODES.includes(config.mode) ? config.mode : "human-vs-ai";
    const playerCount = Number(config.playerCount ?? 4);
    if (!Number.isInteger(playerCount) || playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
      throw tableError(400, `Coup seats ${MIN_PLAYERS}-${MAX_PLAYERS} players`);
    }
    const aiCount = mode === "arena" ? playerCount : playerCount - 1;
    const requested = Array.isArray(config.aiPlayers) ? config.aiPlayers : [];
    const cast = seatCharacters(aiCount, requested.map((entry) => entry?.characterId), { rng });
    const aiSeats = cast.map((character, index) => ({
      isHuman: false,
      name: character.shortName ?? character.name,
      character,
      aiConfig: normalizeModelConfig(GAME_ID, requested[index] ?? requested[0] ?? {}),
    }));
    const humanName = String(config.humanName ?? "").trim().slice(0, 24) || "Guest";
    const seats = mode === "arena" ? aiSeats : [{ isHuman: true, name: humanName, character: null, aiConfig: null }, ...aiSeats];
    this.mode = mode;
    this.seats = seats.map((entry, seat) => ({ seat, ...entry }));
    this.state = createCoupGame({
      players: this.seats.map((entry) => entry.name),
      seed: Number.isInteger(config.seed) ? config.seed : undefined,
    });
  }

  get humanSeat() {
    return this.mode === "arena" ? null : 0;
  }

  get isOver() {
    return this.state.phase === "game_over" || Boolean(this.stalemate);
  }

  /** Key of the decision a seat is being asked for; null when the seat is not awaited. */
  decisionKey(seat) {
    if (this.isOver || !awaitingSeats(this.state).includes(seat)) return null;
    const { state } = this;
    // A reaction window stays the same decision while other seats pass, so answers made
    // in parallel all count. Every other decision is tied to the exact engine step.
    if (WINDOW_PHASES.has(state.phase)) return `w:${state.turn}:${state.phase}:${state.block?.seat ?? ""}`;
    return `s:${state.step}`;
  }

  /** Starts a request for every AI seat the engine waits on that is not already being asked. */
  pump() {
    if (this.isOver || this.aiError || this.paused) return;
    for (const seat of awaitingSeats(this.state)) {
      const player = this.seats[seat];
      if (player.isHuman) continue;
      const key = this.decisionKey(seat);
      const slot = `${seat}|${key}`;
      if (this.inflight.has(slot)) continue;
      this.inflight.set(slot, { seat, key, startedAt: Date.now(), status: "Thinking…" });
      this.askSeat(seat, key, slot);
    }
  }

  async askSeat(seat, key, slot) {
    const player = this.seats[seat];
    const tableId = this.id;
    const stillOpen = () => this.id === tableId && this.inflight.has(slot) && this.decisionKey(seat) === key;
    let retry = null;
    let lastError = "";
    this.emitState();
    try {
      for (let attempt = 0; attempt <= MAX_DECISION_RETRIES; attempt += 1) {
        const view = buildCoupAiView(this.state, seat, { persona: personaFor(player.character) });
        const startedAt = Date.now();
        let response;
        try {
          response = await this.decide({
            seat,
            player,
            view,
            retry,
            onStatus: (status) => {
              const entry = this.inflight.get(slot);
              if (!entry || !stillOpen()) return;
              entry.status = status;
              this.emit("ai_status", { seat, status });
            },
          });
        } catch (error) {
          if (!stillOpen()) return;
          if (!RETRYABLE_GATEWAY_CODES.has(error?.code) || attempt === MAX_DECISION_RETRIES) {
            this.pauseForError(seat, String(error?.message || error));
            return;
          }
          lastError = String(error?.message || error);
          retry = { retryNumber: attempt + 1, maxRetries: MAX_DECISION_RETRIES, error: lastError };
          continue;
        }
        if (!stillOpen()) return;
        const parsed = parseCoupDecision(this.state, seat, {
          actionId: response?.output?.actionId,
          tableTalk: response?.tableTalk ?? response?.output?.tableTalk ?? null,
        });
        if (!parsed.ok) {
          if (!parsed.retryable) return;
          lastError = parsed.error;
          retry = { retryNumber: attempt + 1, maxRetries: MAX_DECISION_RETRIES, error: lastError };
          continue;
        }
        this.insights[seat] = {
          label: parsed.label,
          summary: String(response?.reasoningSummary ?? "").slice(0, 1200),
          latencyMs: Date.now() - startedAt,
          step: this.state.step,
        };
        if (parsed.tableTalk) {
          const talk = pushTableTalk(this, { speaker: seat, playerName: player.name, characterId: player.character?.id ?? null, text: parsed.tableTalk });
          if (talk) this.emit("table_talk", talk);
        }
        this.inflight.delete(slot);
        this.apply(seat, parsed.action);
        return;
      }
      this.pauseForError(seat, `${player.name} gave ${MAX_DECISION_RETRIES + 1} unusable answers. Last problem: ${lastError}`);
    } catch (error) {
      if (this.id === tableId) this.pauseForError(seat, String(error?.message || error));
    } finally {
      if (this.inflight.get(slot)) this.inflight.delete(slot);
      if (this.id === tableId) {
        this.pump();
        this.emitState();
      }
    }
  }

  pauseForError(seat, message) {
    this.aiError = { seat, name: this.seats[seat].name, message: message.slice(0, 400) };
    this.emit("ai_error", this.aiError);
  }

  apply(seat, action) {
    this.state = applyAction(this.state, seat, action);
    if (this.mode === "arena" && this.state.phase === "action" && this.state.turn > ARENA_TURN_CAP) this.declareStalemate();
    this.emit("changed", null);
    this.emitState();
  }

  /** The arena turn cap: rank by influence left, then coins. */
  declareStalemate() {
    const order = this.state.players
      .filter(isAlive)
      .sort((a, b) => liveCards(b).length - liveCards(a).length || b.coins - a.coins);
    const ranking = [...order.map((player) => player.seat), ...[...this.state.eliminationOrder].reverse()];
    this.stalemate = {
      turns: this.state.turn,
      ranking: ranking.map((seat, index) => ({ seat, place: index + 1 })),
      text: `The masquerade ends after ${ARENA_TURN_CAP} turns without a single survivor; the table ranks by influence, then coins.`,
    };
  }

  /** A move from the human seat (validated by the engine). */
  humanAction(action) {
    if (this.humanSeat === null) throw tableError(409, "This is an arena table: there is no human seat");
    if (this.isOver) throw tableError(409, "The game is over");
    if (!awaitingSeats(this.state).includes(this.humanSeat)) throw tableError(409, "The table is not waiting for you right now");
    try {
      this.apply(this.humanSeat, action);
    } catch (error) {
      if (error instanceof CoupRuleError) throw tableError(400, error.message);
      throw error;
    }
    this.pump();
  }

  retryAI() {
    if (!this.aiError) throw tableError(409, "There is no paused AI request to retry");
    this.aiError = null;
    this.pump();
    this.emitState();
  }

  setPaused(paused) {
    if (this.mode !== "arena") throw tableError(409, "Only arena tables can pause");
    this.paused = Boolean(paused);
    this.pump();
    this.emitState();
  }

  emitState() {
    this.emit("state", this.publicState());
  }

  /** Final places for the ladder, or null while the game runs. */
  finalRanking() {
    if (this.state.result) return this.state.result.ranking.map(({ seat, place }) => ({ seat, place }));
    return this.stalemate?.ranking ?? null;
  }

  publicState() {
    const human = this.humanSeat;
    const reveal = this.mode === "arena" || this.isOver;
    const view = publicView(this.state, human, { revealAll: reveal });
    const legal = human === null || this.isOver ? [] : getLegalActions(this.state, human);
    return {
      id: this.id,
      mode: this.mode,
      humanSeat: human,
      ...view,
      seats: this.seats.map((entry) => ({
        seat: entry.seat,
        isHuman: entry.isHuman,
        name: entry.name,
        character: publicCharacter(entry.character),
        model: entry.aiConfig?.model ?? null,
        reasoningEffort: entry.aiConfig?.reasoningEffort ?? null,
      })),
      legalActions: legal.map((action) => ({ action, label: describeAction(this.state, human, action) })),
      thinking: [...this.inflight.values()].map(({ seat, status, startedAt }) => ({ seat, status, startedAt })),
      aiError: this.aiError,
      paused: this.paused,
      stalemate: this.stalemate,
      over: this.isOver,
      // Reasoning summaries mention hidden cards: only spectators and finished games see them.
      insights: reveal
        ? this.insights
        : Object.fromEntries(Object.entries(this.insights).map(([seat, insight]) => [seat, { ...insight, summary: "" }])),
      tableTalk: this.tableTalk,
    };
  }

  toJSON() {
    return {
      id: this.id,
      mode: this.mode,
      seats: this.seats,
      state: serializeCoupGame(this.state),
      tableTalk: this.tableTalk,
      insights: this.insights,
      stalemate: this.stalemate,
    };
  }
}

export function personaFor(character) {
  if (!character) return null;
  return `${character.name}, "${character.title}". ${character.personality ?? ""}`.trim();
}
