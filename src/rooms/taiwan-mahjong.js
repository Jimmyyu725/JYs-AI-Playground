import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { requestStructuredDecision } from "../platform/decision-gateway.js";
import { normalizeModelConfig } from "../platform/model-registry.js";
import { createMatchRecorder, createSSEChannel, httpError, participantFrom, publicError } from "../platform/room-kit.js";
import { findCharacter, seatCharacters } from "../platform/seating.js";
import { ACTION_SCHEMA } from "../games/taiwan-mahjong/ai-view.js";
import { TaiwanMahjongTable } from "../games/taiwan-mahjong/table.js";

export const id = "taiwan-mahjong";
export const defaults = { model: "gpt-6-luna", reasoningEffort: "low" };

const ARENA_NEXT_HAND_DELAY_MS = 6000;
const channel = createSSEChannel();
let table = null;
let tableVersion = 0;
let running = false;
let recordOnce = () => null;
let savePath = null;
let arenaTimer = null;

function decide({ instructions, input, modelConfig, voice }, callbacks) {
  return requestStructuredDecision({
    gameId: id,
    modelConfig,
    tableTalk: { voice },
    instructions,
    input,
    schemaName: "taiwan_mahjong_decision",
    schema: ACTION_SCHEMA,
  }, callbacks);
}

const REVIEW_SCHEMA = {
  type: "object",
  properties: { review: { type: "string", description: "The spoken review, plain text, 3-6 sentences." } },
  required: ["review"],
  additionalProperties: false,
};

function reviewInput(current) {
  const state = current.state;
  const view = current.publicState();
  return {
    game: "Taiwan Mahjong 台灣麻將 (16 tiles)",
    handNumber: state.handNumber,
    players: view.players.map((player) => ({
      seat: player.seat,
      name: player.name,
      seatWind: player.seatWind,
      isDealer: player.isDealer,
      finalHand: state.players[player.seat].hand,
      melds: state.players[player.seat].melds.map((meld) => `${meld.type} ${meld.tiles.join(" ")}`),
      flowers: player.flowers,
      discards: player.discards,
      score: view.scores[player.seat],
    })),
    result: state.result,
    handLog: state.log,
    earlierHands: state.history.slice(0, -1),
  };
}

function recordResult(current) {
  if (!current?.isOver) return;
  const places = current.standings();
  recordOnce(current, "game", () => ({
    mode: current.mode,
    participants: current.players.map((player) => participantFrom(player, { place: places[player.seat] })),
    details: { scores: current.state.scores, hands: current.state.handNumber },
  }));
}

let saving = Promise.resolve();
function persist(current) {
  if (!savePath) return;
  const data = current ? JSON.stringify(current.toJSON()) : "null";
  saving = saving.then(async () => {
    const temp = `${savePath}.${process.pid}.tmp`;
    await writeFile(temp, data);
    await rename(temp, savePath);
  }).catch((error) => console.error(`Could not save the Taiwan Mahjong table: ${error.message}`));
}

function broadcastState() {
  if (!table) return;
  recordResult(table);
  channel.broadcast("state", table.publicState());
}

function requireTable() {
  if (!table) throw httpError(409, "Open a Taiwan Mahjong table first");
  return table;
}

function scheduleArenaNextHand(version) {
  clearTimeout(arenaTimer);
  if (!table || table.mode !== "arena" || table.state.phase !== "handOver" || table.arenaPaused) return;
  arenaTimer = setTimeout(() => {
    if (!table || version !== tableVersion || table.state.phase !== "handOver" || table.arenaPaused) return;
    table.nextHand();
    persist(table);
    broadcastState();
    schedule();
  }, ARENA_NEXT_HAND_DELAY_MS);
}

function schedule() {
  if (!table || running) return;
  setImmediate(runAIChain);
}

async function runAIChain() {
  if (running) return;
  running = true;
  const version = tableVersion;
  const current = table;
  const live = () => table === current && version === tableVersion;
  try {
    for (;;) {
      if (!live()) return;
      const seat = current.nextAISeat();
      if (seat === null) break;
      const player = current.players[seat];
      current.aiThinking = { seat, playerName: player.name, status: `Asking ${player.aiConfig.model}…`, startedAt: Date.now(), retry: null };
      broadcastState();
      try {
        const result = await current.playAISeat(seat, (request) => decide(request, {
          onStatus(status) {
            if (!live() || !current.aiThinking) return;
            current.aiThinking = { ...current.aiThinking, status };
            channel.broadcast("ai_stream", { phase: "status", seat, status });
          },
          onSummaryDelta(delta) {
            if (live()) channel.broadcast("ai_stream", { phase: "summary_delta", seat, delta });
          },
        }), {
          onRetry({ retryNumber, maxRetries, error }) {
            if (!live()) return;
            current.aiThinking = { ...current.aiThinking, status: `${error}. Retrying (${retryNumber}/${maxRetries})…`, retry: retryNumber };
            broadcastState();
          },
        });
        if (!live()) return;
        current.aiThinking = null;
        if (result?.talk) channel.broadcast("table_talk", result.talk);
        channel.broadcast("ai_move", { seat, label: result?.decision?.label ?? "" });
      } catch (error) {
        if (!live()) return;
        current.setAIError(seat, publicError(error));
        channel.broadcast("ai_stream", { phase: "error", seat, message: current.aiError.message });
      }
      persist(current);
      broadcastState();
    }
    if (live()) scheduleArenaNextHand(version);
  } finally {
    running = false;
    // A new table may have been opened while this chain was waiting on a model.
    if (table && table !== current) schedule();
  }
}

function buildAISeats(body, count) {
  const requested = Array.isArray(body.aiPlayers) ? body.aiPlayers.slice(0, count) : [];
  const cast = seatCharacters(count, requested.map((seat) => seat?.characterId));
  return cast.map((character, index) => ({
    character,
    aiConfig: normalizeModelConfig(id, requested[index] ?? {}),
  }));
}

function route(handler) {
  return async (request, response, next) => {
    try {
      await handler(request, response);
    } catch (error) {
      next(error);
    }
  };
}

export function register(app, ctx) {
  recordOnce = createMatchRecorder(ctx.results, id);
  savePath = ctx.dataDir ? path.join(ctx.dataDir, "taiwan-mahjong-table.json") : null;

  app.get("/api/taiwan-mahjong/state", (_request, response) => {
    response.json(table ? table.publicState() : null);
  });

  app.get("/api/taiwan-mahjong/events", channel.handler(() => table?.publicState() ?? null));

  app.post("/api/taiwan-mahjong/game", route((request, response) => {
    const body = request.body ?? {};
    const mode = body.mode === "arena" ? "arena" : "human-vs-ai";
    const aiSeats = buildAISeats(body, mode === "arena" ? 4 : 3);
    const next = new TaiwanMahjongTable({ mode, aiSeats, humanName: body.humanName, length: body.length });
    clearTimeout(arenaTimer);
    tableVersion += 1;
    table = next;
    persist(table);
    response.status(201).json(table.publicState());
    broadcastState();
    schedule();
  }));

  app.post("/api/taiwan-mahjong/action", route((request, response) => {
    const current = requireTable();
    const action = request.body?.action;
    if (!action || typeof action !== "object" || typeof action.type !== "string") throw httpError(400, "Send { action: { type, ... } }");
    current.humanAction(action);
    persist(current);
    response.json(current.publicState());
    broadcastState();
    schedule();
  }));

  app.post("/api/taiwan-mahjong/next-hand", route((_request, response) => {
    const current = requireTable();
    current.nextHand();
    persist(current);
    response.json(current.publicState());
    broadcastState();
    schedule();
  }));

  app.post("/api/taiwan-mahjong/review", route(async (request, response) => {
    const current = requireTable();
    const phase = current.state.phase;
    if (phase !== "handOver" && phase !== "gameOver") throw httpError(409, "A review is available once the hand is over");
    const seat = Number(request.body?.seat);
    const player = current.players[seat];
    if (!player || player.isHuman) throw httpError(400, "Pick an AI seat to review the hand");
    const key = `${current.state.handNumber}:${seat}`;
    current.reviews ??= {};
    if (!current.reviews[key]) {
      const character = player.character;
      const instructions = `You are ${character.name}, ${character.title}. Character: ${character.personality}
Voice: ${character.voice}
A hand of Taiwan Mahjong (16-tile) just finished at your table, and someone asked you to review it. Every hand is now face up. In character and in 3 to 6 sentences of plain spoken English (no markdown, no lists): say what decided the hand, name one sharp decision and one questionable one (say whose), and give one concrete lesson for next time. Refer to tiles by name (for example "the 5 of dots", "West wind"), not by code.`;
      const answer = await requestStructuredDecision({
        gameId: id,
        modelConfig: player.aiConfig,
        instructions,
        input: reviewInput(current),
        schemaName: "taiwan_mahjong_review",
        schema: REVIEW_SCHEMA,
      });
      const text = String(answer.output?.review ?? "").trim().slice(0, 1600);
      if (!text) throw httpError(502, `${player.name} had nothing to say. Try again.`);
      current.reviews[key] = text;
    }
    response.json({ seat, playerName: player.name, characterId: player.character?.id ?? null, handNumber: current.state.handNumber, review: current.reviews[key] });
  }));

  app.post("/api/taiwan-mahjong/retry-ai", route((_request, response) => {
    const current = requireTable();
    if (!current.aiError) throw httpError(409, "There is no paused AI request to retry");
    current.clearAIError();
    response.json(current.publicState());
    broadcastState();
    schedule();
  }));

  app.post("/api/taiwan-mahjong/arena/pause", route((_request, response) => {
    const current = requireTable();
    if (current.mode !== "arena") throw httpError(409, "Only an arena can be paused");
    current.arenaPaused = true;
    clearTimeout(arenaTimer);
    persist(current);
    response.json(current.publicState());
    broadcastState();
  }));

  app.post("/api/taiwan-mahjong/arena/resume", route((_request, response) => {
    const current = requireTable();
    if (current.mode !== "arena") throw httpError(409, "Only an arena can be resumed");
    current.arenaPaused = false;
    persist(current);
    response.json(current.publicState());
    broadcastState();
    schedule();
    if (!running) scheduleArenaNextHand(tableVersion);
  }));

  return {
    async onListen() {
      if (!savePath) return;
      try {
        await mkdir(path.dirname(savePath), { recursive: true });
        const saved = JSON.parse(await readFile(savePath, "utf8"));
        if (!saved) return;
        table = TaiwanMahjongTable.fromJSON(saved, findCharacter);
        // A resumed table never fires a model call by itself: it waits for an explicit retry.
        const seat = table.nextAISeat();
        if (seat !== null) table.setAIError(seat, "The server restarted mid-decision. Press retry to continue.");
        tableVersion += 1;
      } catch (error) {
        if (error.code !== "ENOENT") console.error(`Could not resume the Taiwan Mahjong table: ${error.message}`);
      }
    },
  };
}
