import fs from "node:fs";
import path from "node:path";
import { describeAction, requestLiarsDiceMove, requestLiarsDiceReview } from "../games/liars-dice/ai.js";
import { LiarsDiceTable } from "../games/liars-dice/table.js";
import { findCharacter } from "../platform/seating.js";
import { pushTableTalk } from "../platform/table-talk.js";
import { createMatchRecorder, createSSEChannel, httpError, participantFrom, publicError } from "../platform/room-kit.js";

export const id = "liars-dice";
export const defaults = { model: "gpt-6-luna", reasoningEffort: "low" };

// After a challenge the next round is already rolled; hold the next AI move so every
// client can play the cup-lift reveal first.
const REVEAL_HOLD_MS = Math.max(0, Number(process.env.LIARS_DICE_REVEAL_MS ?? 4200) || 0);

const channel = createSSEChannel();
const activeChains = new Set();
let table = null;
let tableVersion = 0;
let recordOnce = () => null;
let savePath = null;
let reviewInFlight = false;

function persist() {
  if (!savePath || !table) return;
  try {
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    const temporary = `${savePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(table.toSave()));
    fs.renameSync(temporary, savePath);
  } catch (error) {
    console.error(`Could not save the Liar's Dice table: ${String(error?.message || error)}`);
  }
}

function restore() {
  if (!savePath) return;
  try {
    table = LiarsDiceTable.fromSave(JSON.parse(fs.readFileSync(savePath, "utf8")));
    tableVersion += 1;
    // A finished game was recorded before the restart; mark it so it is not recorded twice.
    if (table.isComplete) recordOnce(table, "game", () => null);
  } catch (error) {
    if (error?.code !== "ENOENT") console.error(`Ignoring the saved Liar's Dice table: ${String(error?.message || error)}`);
  }
}

function recordResult() {
  const result = table?.matchResult();
  if (!result) return;
  recordOnce(table, "game", () => ({
    mode: result.mode,
    participants: result.participants.map(({ player, place }) => participantFrom(player, { place })),
    details: result.details,
  }));
}

function broadcastState() {
  if (!table) return;
  recordResult();
  persist();
  channel.broadcast("state", table.publicState());
}

function requireTable() {
  if (!table) throw httpError(409, "Start a Liar's Dice table first");
  return table;
}

function afterAction(current, seat, action, reveal) {
  if (reveal) {
    current.holdUntil = Date.now() + REVEAL_HOLD_MS;
    channel.broadcast("reveal", { reveal, actorSeat: seat, action });
  } else {
    channel.broadcast("action", { seat, action, round: current.state.round });
  }
}

function canAIAct(current) {
  return Boolean(current) && !current.isComplete && !current.aiError && !(current.isArenaMode && current.arenaPaused) && current.currentActor && !current.currentActor.isHuman;
}

function scheduleAI(version = tableVersion) {
  if (!table || activeChains.has(version)) return;
  setImmediate(() => runAIChain(version));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runAIChain(version) {
  if (activeChains.has(version)) return;
  activeChains.add(version);
  const live = (current) => table === current && version === tableVersion;
  try {
    while (table && version === tableVersion) {
      const current = table;
      const wait = current.holdUntil - Date.now();
      if (wait > 0) await sleep(wait);
      if (!live(current) || !canAIAct(current)) break;
      const actor = current.currentActor;
      const seat = actor.seat;
      const startedAt = performance.now();
      current.aiThinking = { seat, playerName: actor.name, status: `Asking ${actor.aiConfig.model}…`, startedAt: Date.now() };
      channel.broadcast("ai_stream", { phase: "started", seat, playerName: actor.name });
      broadcastState();
      try {
        const decision = await requestLiarsDiceMove({
          state: current.state,
          seat,
          seatNames: current.seatNames,
          character: actor.character,
          modelConfig: actor.aiConfig,
          shouldContinue: () => live(current),
          callbacks: {
            onStatus(status) {
              if (!live(current) || !current.aiThinking) return;
              current.aiThinking = { ...current.aiThinking, status };
              channel.broadcast("ai_stream", { phase: "status", seat, status });
            },
            onSummaryDelta(delta) {
              // Reasoning can mention hidden dice: stream it to spectators of an arena only.
              if (live(current) && current.isArenaMode) channel.broadcast("ai_stream", { phase: "summary_delta", seat, delta });
            },
          },
          onRetry({ error, retryNumber, maxRetries }) {
            if (!live(current)) return;
            const status = `Rejected: ${error.message}. Retrying (${retryNumber}/${maxRetries})…`;
            current.aiThinking = { ...current.aiThinking, status, retryNumber };
            channel.broadcast("ai_stream", { phase: "retry", seat, status, retryNumber, maxRetries });
            broadcastState();
          },
        });
        if (!live(current)) return;
        const latencyMs = performance.now() - startedAt;
        const talk = pushTableTalk(current, { speaker: seat, playerName: actor.name, characterId: actor.character?.id ?? null, text: decision.tableTalk });
        current.aiThinking = null;
        const { reveal } = current.act(seat, decision.action);
        current.recordInsight(seat, {
          action: describeAction(decision.action),
          explanation: decision.explanation,
          summary: decision.reasoningSummary,
          latencyMs,
          attempts: decision.attempts,
        });
        afterAction(current, seat, decision.action, reveal);
        broadcastState();
        // After the state, so the ship's log writes the bid before the line said with it.
        if (talk) channel.broadcast("table_talk", talk);
      } catch (error) {
        if (!live(current)) return;
        const message = publicError(error);
        current.setAIError(seat, message);
        channel.broadcast("ai_stream", { phase: "error", seat, message });
        broadcastState();
        break;
      }
    }
  } finally {
    activeChains.delete(version);
    if (table && version === tableVersion && canAIAct(table)) scheduleAI(version);
  }
}

function parseHumanAction(body) {
  const type = body?.type;
  if (type === "dudo" || type === "calza") return { type };
  if (type === "bid") return { type, quantity: Number(body.quantity), face: Number(body.face) };
  throw httpError(400, "Send { type: \"bid\", quantity, face }, { type: \"dudo\" } or { type: \"calza\" }");
}

export function register(app, ctx) {
  recordOnce = createMatchRecorder(ctx.results, id);
  savePath = ctx.dataDir ? path.join(ctx.dataDir, "liars-dice", "table.json") : null;
  restore();

  app.get("/api/liars-dice/state", (_request, response) => {
    response.json(table ? table.publicState() : null);
  });

  app.get("/api/liars-dice/events", channel.handler(() => table?.publicState() ?? null));

  app.post("/api/liars-dice/game", (request, response) => {
    const next = new LiarsDiceTable(request.body ?? {});
    tableVersion += 1;
    table = next;
    reviewInFlight = false;
    response.status(201).json(table.publicState());
    broadcastState();
    scheduleAI(tableVersion);
  });

  app.post("/api/liars-dice/action", (request, response) => {
    const current = requireTable();
    const actor = current.currentActor;
    if (!actor?.isHuman) throw httpError(409, "It is not your turn");
    if (current.aiError) throw httpError(409, "An AI request is paused; retry it first");
    const action = parseHumanAction(request.body);
    const { reveal } = current.act(actor.seat, action);
    afterAction(current, actor.seat, action, reveal);
    response.json(current.publicState());
    broadcastState();
    scheduleAI(tableVersion);
  });

  app.post("/api/liars-dice/retry-ai", (_request, response) => {
    const current = requireTable();
    if (!current.aiError) throw httpError(409, "There is no paused AI request to retry");
    current.clearAIError();
    response.json(current.publicState());
    broadcastState();
    scheduleAI(tableVersion);
  });

  app.post("/api/liars-dice/arena/pause", (_request, response) => {
    const current = requireTable();
    current.pauseArena();
    response.json(current.publicState());
    broadcastState();
  });

  app.post("/api/liars-dice/arena/resume", (_request, response) => {
    const current = requireTable();
    current.resumeArena();
    response.json(current.publicState());
    broadcastState();
    scheduleAI(tableVersion);
  });

  // "Ask <character> to review this game": one AI seat looks back over a finished game.
  app.post("/api/liars-dice/review", async (request, response) => {
    const current = requireTable();
    if (!current.isComplete) throw httpError(409, "The game is still running");
    if (reviewInFlight) throw httpError(409, "A review is already being written");
    const player = current.players.find((entry) => !entry.isHuman && entry.character?.id === request.body?.characterId)
      ?? current.players.find((entry) => !entry.isHuman);
    const reviewer = player?.character ?? findCharacter(request.body?.characterId);
    if (!reviewer) throw httpError(400, "Pick a character at this table to review the game");
    reviewInFlight = true;
    try {
      const review = await requestLiarsDiceReview({ table: current, reviewer, modelConfig: player?.aiConfig ?? defaults });
      response.json({ ...review, playerName: reviewer.name });
    } catch (error) {
      throw httpError(502, publicError(error));
    } finally {
      reviewInFlight = false;
    }
  });

  return {
    onListen() {
      if (table && canAIAct(table)) scheduleAI(tableVersion);
    },
  };
}
