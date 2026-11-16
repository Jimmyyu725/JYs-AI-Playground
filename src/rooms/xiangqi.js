import fs from "node:fs";
import path from "node:path";
import { requestXiangqiDecisionWithRetry } from "../games/xiangqi/ai.js";
import { requestXiangqiReview } from "../games/xiangqi/review.js";
import { XiangqiTable } from "../games/xiangqi/table.js";
import { pushTableTalk } from "../platform/table-talk.js";
import { createMatchRecorder, createSSEChannel, httpError, participantFrom, publicError } from "../platform/room-kit.js";

export const id = "xiangqi";
export const defaults = { model: "gpt-6-luna", reasoningEffort: "low" };

const channel = createSSEChannel();
const activeVersions = new Set();
let table = null;
let version = 0;
let savePath = null;
let recordOnce = () => null;

function recordResult() {
  if (!table || table.phase !== "complete" || !table.result) return;
  const current = table;
  recordOnce(current, "game", () => ({
    mode: current.isArenaMode ? "arena" : "human-vs-ai",
    participants: current.players.map((player) => participantFrom(player, { place: current.placeFor(player.side) })),
    details: { reason: current.result.reason, plies: current.state.ply, winner: current.result.winner },
  }));
}

function persist() {
  if (!table || !savePath) return;
  try {
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    const temp = `${savePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(table.toSave()));
    fs.renameSync(temp, savePath);
    table.savedAt = new Date().toISOString();
  } catch (error) {
    console.error(`Xiangqi save failed: ${String(error?.message || error)}`);
  }
}

function restore() {
  try {
    if (!savePath || !fs.existsSync(savePath)) return null;
    return XiangqiTable.fromSave(JSON.parse(fs.readFileSync(savePath, "utf8")));
  } catch (error) {
    console.error(`Xiangqi save restore skipped: ${String(error?.message || error)}`);
    return null;
  }
}

// Every state sent out carries a rising `seq`, so a client can drop an HTTP response that
// arrives after a newer state pushed over SSE.
let seq = 0;
function snapshot(current) {
  seq += 1;
  return { ...current.publicState(), seq };
}

function broadcastState() {
  recordResult();
  if (table) channel.broadcast("state", snapshot(table));
}

function requireTable() {
  if (!table) throw httpError(409, "Start a Xiangqi game first");
  return table;
}

function schedule(forVersion = version) {
  if (!table || activeVersions.has(forVersion)) return;
  setImmediate(() => runAIChain(forVersion));
}

async function runAIChain(forVersion) {
  if (activeVersions.has(forVersion)) return;
  activeVersions.add(forVersion);
  const live = (current) => table === current && forVersion === version;
  try {
    while (table && forVersion === version && table.aiShouldMove) {
      const current = table;
      const actor = current.currentPlayer;
      const side = actor.side;
      const startedAt = performance.now();
      current.aiThinking = { side, color: side, playerName: actor.name, status: `Connecting to ${actor.aiConfig.model}…`, startedAt: Date.now() };
      channel.broadcast("ai_stream", { phase: "started", side, playerName: actor.name });
      broadcastState();
      try {
        const { decision, attempts } = await requestXiangqiDecisionWithRetry({
          viewFactory: () => ({ state: current.state, view: current.aiView(side) }),
          side,
          modelConfig: actor.aiConfig,
          voice: actor.character?.voice ?? "",
          shouldContinue: () => live(current),
          callbacks: {
            onStatus(status) {
              if (!live(current)) return;
              current.aiThinking = { ...current.aiThinking, status };
              channel.broadcast("ai_stream", { phase: "status", side, playerName: actor.name, status });
            },
            onSummaryDelta(delta) {
              if (!live(current)) return;
              channel.broadcast("ai_stream", { phase: "summary_delta", side, playerName: actor.name, delta });
            },
          },
          onRetry({ error, retryNumber, maxRetries }) {
            if (!live(current)) return;
            const message = publicError(error);
            current.recordAIRetry(side, message, retryNumber, maxRetries);
            current.aiThinking = { ...current.aiThinking, status: `Rejected: ${message} Retrying (${retryNumber}/${maxRetries})…` };
            channel.broadcast("ai_stream", { phase: "retry", side, playerName: actor.name, message, retryNumber, maxRetries });
            broadcastState();
          },
        });
        if (!live(current)) return;
        const latencyMs = performance.now() - startedAt;
        current.recordAIInsight(side, {
          summary: decision.reasoningSummary || decision.explanation,
          summarySource: decision.reasoningSource || "public_decision_rationale",
          explanation: decision.explanation,
          latencyMs,
          move: decision.move,
          attempts,
        });
        current.aiThinking = null;
        current.applyAIMove(side, decision.move);
        const talk = pushTableTalk(current, { speaker: side, playerName: actor.name, characterId: actor.character?.id ?? null, text: decision.tableTalk });
        if (talk) channel.broadcast("table_talk", talk);
        channel.broadcast("ai_stream", { phase: "completed", side, playerName: actor.name, move: decision.move, explanation: decision.explanation, latencyMs: Math.round(latencyMs) });
        persist();
        broadcastState();
      } catch (error) {
        if (!live(current)) return;
        const message = publicError(error);
        current.setAIError(side, message);
        persist();
        channel.broadcast("ai_stream", { phase: "error", side, playerName: actor.name, message });
        broadcastState();
        break;
      }
    }
  } finally {
    activeVersions.delete(forVersion);
    if (table && forVersion === version && table.aiShouldMove) schedule(forVersion);
  }
}

function startTable(next) {
  version += 1;
  table = next;
  persist();
  broadcastState();
  schedule(version);
}

export function register(app, ctx) {
  recordOnce = createMatchRecorder(ctx.results, id);
  savePath = path.join(ctx.dataDir, "xiangqi-table.json");
  table = restore();
  version = table ? 1 : 0;
  // A finished game restored from disk was recorded before the restart.
  if (table?.phase === "complete") recordOnce(table, "game", () => null);

  app.get("/api/xiangqi/state", (_request, response) => {
    response.json(table ? snapshot(table) : null);
  });

  app.get("/api/xiangqi/events", channel.handler(() => table ? snapshot(table) : null));

  app.post("/api/xiangqi/game", (request, response, next) => {
    try {
      startTable(new XiangqiTable(request.body ?? {}));
      response.status(201).json(snapshot(table));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/xiangqi/action", (request, response, next) => {
    try {
      const current = requireTable();
      const body = request.body ?? {};
      const action = body.type === "resign" ? { type: "resign" } : { type: "move", move: body.move, from: body.from, to: body.to };
      try {
        current.applyHumanAction(action);
      } catch (error) {
        if (!error.status) error.status = 400;
        throw error;
      }
      persist();
      response.json(snapshot(current));
      broadcastState();
      schedule(version);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/xiangqi/retry-ai", (_request, response, next) => {
    try {
      const current = requireTable();
      if (!current.aiError) throw httpError(409, "There is no paused AI request to retry");
      current.clearAIError();
      persist();
      response.json(snapshot(current));
      broadcastState();
      schedule(version);
    } catch (error) {
      next(error);
    }
  });

  // Post-game review by one of the AI characters (cached per side for the finished table).
  app.post("/api/xiangqi/review", async (request, response, next) => {
    try {
      const current = requireTable();
      if (current.phase !== "complete") throw httpError(409, "Finish the game before asking for a review");
      const side = request.body?.side;
      const player = current.playerFor(side);
      if (!player || player.isHuman) throw httpError(400, "Choose an AI player to review the game");
      current.reviews ??= {};
      current.reviews[side] ??= requestXiangqiReview(current, side).catch((error) => {
        delete current.reviews[side];
        throw error;
      });
      response.json(await current.reviews[side]);
    } catch (error) {
      if (!error.status) error.status = 502;
      error.message = publicError(error);
      next(error);
    }
  });

  app.post("/api/xiangqi/arena/pause",(_request, response, next) => {
    try {
      const current = requireTable();
      current.pauseArena();
      persist();
      response.json(snapshot(current));
      broadcastState();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/xiangqi/arena/resume", (_request, response, next) => {
    try {
      const current = requireTable();
      current.resumeArena();
      persist();
      response.json(snapshot(current));
      broadcastState();
      schedule(version);
    } catch (error) {
      next(error);
    }
  });

  return {
    onListen() {
      if (!table) return;
      console.log(`Restored Xiangqi ply ${table.state.ply} from the local save slot`);
      schedule(version);
    },
  };
}
