import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { requestWuziqiDecisionWithRetry, requestWuziqiReview } from "../games/wuziqi-ai.js";
import { WuziqiGame } from "../games/wuziqi-game.js";
import { pushTableTalk } from "../platform/table-talk.js";
import { createMatchRecorder, httpError, participantFrom, publicError, sendSSE } from "../platform/room-kit.js";

export const id = "wuziqi";
export const defaults = { model: "gpt-6-luna", reasoningEffort: "low" };

const wuziqiSSEClients = new Set();

const activeWuziqiAIVersions = new Set();

let wuziqiGame = null;

let wuziqiGameVersion = 0;

function broadcastWuziqi(type, payload) {
  for (const response of [...wuziqiSSEClients]) {
    try {
      sendSSE(response, type, payload);
    } catch {
      wuziqiSSEClients.delete(response);
    }
  }
}

let savePath = null;

/** Keeps the current game on disk so a server restart resumes it. Saving is best effort. */
function saveWuziqiGame() {
  if (!savePath || !wuziqiGame) return;
  try {
    mkdirSync(path.dirname(savePath), { recursive: true });
    writeFileSync(`${savePath}.tmp`, JSON.stringify(wuziqiGame.toSave()));
    renameSync(`${savePath}.tmp`, savePath);
  } catch (error) {
    console.error(`Could not save the Wuziqi game: ${String(error?.message || error)}`);
  }
}

function loadWuziqiGame() {
  try {
    return WuziqiGame.restore(JSON.parse(readFileSync(savePath, "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") console.error(`Could not restore the Wuziqi game: ${String(error?.message || error)}`);
    return null;
  }
}

function recordResult() {
  const table = wuziqiGame;
  if (!table || table.phase !== "complete" || !table.result || table.resultRecorded) return;
  table.resultRecorded = true;
  recordOnce(table, "game", () => ({
    mode: table.gameMode === "arena" ? "arena" : "human-vs-ai",
    participants: table.players.map((player) => participantFrom(player, { place: !table.result.winner || table.result.winner === player.color ? 1 : 2 })),
    details: { reason: table.result.reason },
  }));
}

let recordOnce = () => null;

function broadcastWuziqiState() {
  recordResult();
  saveWuziqiGame();
  if (wuziqiGame) broadcastWuziqi("state", wuziqiGame.publicState());
}

function requireWuziqiGame() {
  if (!wuziqiGame) {
    const error = new Error("Start a Wuziqi game first");
    error.status = 409;
    throw error;
  }
  return wuziqiGame;
}

function scheduleWuziqiAITurn(version = wuziqiGameVersion) {
  if (!wuziqiGame || activeWuziqiAIVersions.has(version)) return;
  setImmediate(() => runWuziqiAIChain(version));
}

async function runWuziqiAIChain(version) {
  if (activeWuziqiAIVersions.has(version)) return;
  activeWuziqiAIVersions.add(version);
  try {
    while (wuziqiGame && version === wuziqiGameVersion) {
      const table = wuziqiGame;
      if (table.phase !== "active" || table.aiError || (table.isArenaMode && table.arenaPaused)) break;
      const actor = table.currentPlayer;
      if (!actor || actor.isHuman) break;

      const color = actor.color;
      const startedAt = performance.now();
      table.aiThinking = { color, playerName: actor.name, status: `Connecting to ${actor.aiConfig.model}…`, startedAt: Date.now() };
      broadcastWuziqi("ai_stream", { phase: "started", color, playerName: actor.name, summary: "" });
      broadcastWuziqiState();

      try {
        const current = () => wuziqiGame === table && version === wuziqiGameVersion;
        const { decision } = await requestWuziqiDecisionWithRetry({
          snapshotFactory: () => table.aiSnapshot(),
          modelConfig: actor.aiConfig,
          callbacks: {
            onStatus(status) {
              if (!current()) return;
              table.aiThinking = { ...table.aiThinking, status };
              broadcastWuziqi("ai_stream", { phase: "status", color, playerName: actor.name, status });
              broadcastWuziqiState();
            },
            onSummaryDelta(delta) {
              if (!current()) return;
              broadcastWuziqi("ai_stream", { phase: "summary_delta", color, playerName: actor.name, delta });
            },
          },
          shouldContinue: current,
          onRetry({ error, retryNumber, maxRetries }) {
            if (!current()) return;
            const message = publicError(error);
            table.recordAIRetry(color, message, retryNumber, maxRetries);
            table.aiThinking = { ...table.aiThinking, status: `${message}. Retrying automatically (${retryNumber}/${maxRetries})…` };
            broadcastWuziqi("ai_stream", { phase: "started", color, playerName: actor.name, summary: "", automaticRetry: true, retryNumber, maxRetries });
            broadcastWuziqiState();
          },
        });

        if (wuziqiGame !== table || version !== wuziqiGameVersion) return;
        const latencyMs = performance.now() - startedAt;
        const visibleSummary = decision.reasoningSummary || decision.explanation;
        const talk = pushTableTalk(table, { speaker: color, playerName: actor.name, characterId: actor.character?.id ?? null, text: decision.tableTalk });
        if (talk) broadcastWuziqi("table_talk", talk);
        table.recordAIInsight(color, {
          summary: visibleSummary,
          summarySource: decision.reasoningSource || "public_decision_rationale",
          explanation: decision.explanation,
          latencyMs,
          action: decision.action,
        });
        table.aiThinking = null;
        broadcastWuziqi("ai_stream", {
          phase: "completed",
          color,
          playerName: actor.name,
          summary: visibleSummary,
          explanation: decision.explanation,
          latencyMs: Math.round(latencyMs),
        });
        table.applyAction(color, decision.action, decision.row, decision.column);
        broadcastWuziqiState();
      } catch (error) {
        if (wuziqiGame !== table || version !== wuziqiGameVersion) return;
        const message = publicError(error);
        table.setAIError(color, message);
        broadcastWuziqi("ai_stream", { phase: "error", color, playerName: actor.name, message });
        broadcastWuziqiState();
        break;
      }
    }
  } finally {
    activeWuziqiAIVersions.delete(version);
    if (wuziqiGame && version === wuziqiGameVersion && wuziqiGame.phase === "active" && !wuziqiGame.aiError && !wuziqiGame.currentPlayer?.isHuman && !(wuziqiGame.isArenaMode && wuziqiGame.arenaPaused)) {
      scheduleWuziqiAITurn(version);
    }
  }
}

export function register(app, ctx) {
  recordOnce = createMatchRecorder(ctx.results, id);
  savePath = ctx.dataDir ? path.join(ctx.dataDir, "wuziqi-game.json") : null;
  if (savePath) wuziqiGame = loadWuziqiGame();
  app.get("/api/wuziqi/state", (_request, response) => {
    response.json(wuziqiGame ? wuziqiGame.publicState() : null);
  });

  app.get("/api/wuziqi/events", (request, response) => {
    response.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    wuziqiSSEClients.add(response);
    sendSSE(response, "connected", { at: Date.now() });
    if (wuziqiGame) sendSSE(response, "state", wuziqiGame.publicState());
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      wuziqiSSEClients.delete(response);
    });
  });

  app.post("/api/wuziqi/game", (request, response, next) => {
    try {
      const next = new WuziqiGame(request.body ?? {});
      wuziqiGameVersion += 1;
      wuziqiGame = next;
      response.status(201).json(wuziqiGame.publicState());
      broadcastWuziqiState();
      scheduleWuziqiAITurn(wuziqiGameVersion);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/wuziqi/action", (request, response, next) => {
    try {
      const table = requireWuziqiGame();
      const actor = table.currentPlayer;
      if (!actor?.isHuman) {
        const error = new Error("It is not the human player's turn");
        error.status = 409;
        throw error;
      }
      table.applyAction(actor.color, request.body?.action, request.body?.row ?? null, request.body?.column ?? null);
      response.json(table.publicState());
      broadcastWuziqiState();
      scheduleWuziqiAITurn(wuziqiGameVersion);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/wuziqi/retry-ai", (_request, response, next) => {
    try {
      const table = requireWuziqiGame();
      if (!table.aiError) {
        const error = new Error("There is no paused AI request to retry");
        error.status = 409;
        throw error;
      }
      table.clearAIError();
      response.json(table.publicState());
      broadcastWuziqiState();
      scheduleWuziqiAITurn(wuziqiGameVersion);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/wuziqi/review", (request, response, next) => {
    try {
      const table = requireWuziqiGame();
      if (table.review?.status === "pending") throw httpError(409, "A review is already being written");
      const snapshot = table.reviewSnapshot(request.body?.color);
      const reviewer = table.players.find((player) => player.color === snapshot.reviewer.color);
      table.setReview({ status: "pending", color: reviewer.color, playerName: reviewer.name, characterId: reviewer.character?.id ?? null });
      response.status(202).json(table.publicState());
      broadcastWuziqiState();
      requestWuziqiReview(snapshot, reviewer.aiConfig)
        .then((review) => {
          if (wuziqiGame !== table) return;
          table.setReview({ ...table.review, status: "done", ...review });
          broadcastWuziqiState();
        })
        .catch((error) => {
          if (wuziqiGame !== table) return;
          table.setReview({ ...table.review, status: "error", error: publicError(error) });
          broadcastWuziqiState();
        });
    } catch (error) {
      if (!error.status) error.status = 409;
      next(error);
    }
  });

  app.post("/api/wuziqi/arena/pause", (_request, response, next) => {
    try {
      const table = requireWuziqiGame();
      table.pauseArena();
      response.json(table.publicState());
      broadcastWuziqiState();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/wuziqi/arena/resume", (_request, response, next) => {
    try {
      const table = requireWuziqiGame();
      table.resumeArena();
      response.json(table.publicState());
      broadcastWuziqiState();
      scheduleWuziqiAITurn(wuziqiGameVersion);
    } catch (error) {
      next(error);
    }
  });

  return {
    // A restored human game whose AI seat was mid-request picks the request up again; arenas wait paused.
    onListen() {
      scheduleWuziqiAITurn(wuziqiGameVersion);
    },
  };
}
