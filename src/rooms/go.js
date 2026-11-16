import { requestGoDecisionWithRetry, requestGoReview } from "../games/go-ai.js";
import { GoGame } from "../games/go-game.js";
import { GoSaveStore } from "../games/go-save-store.js";
import { pushTableTalk } from "../platform/table-talk.js";
import { createMatchRecorder, participantFrom, publicError, sendSSE } from "../platform/room-kit.js";

export const id = "go";
export const defaults = { model: "gpt-6-luna", reasoningEffort: "low" };

let goSaveStore = null;

const goSSEClients = new Set();

const activeGoAIVersions = new Set();

let goGame = null;

let goGameVersion = 0;

function broadcastGo(type, payload) {
  for (const response of [...goSSEClients]) {
    try {
      sendSSE(response, type, payload);
    } catch {
      goSSEClients.delete(response);
    }
  }
}

function recordResult() {
  const table = goGame;
  if (!table || table.phase !== "complete" || !table.result) return;
  recordOnce(table, "game", () => ({
    mode: table.gameMode === "arena" ? "arena" : "human-vs-ai",
    participants: table.players.map((player) => participantFrom(player, { place: !table.result.winner || table.result.winner === player.color ? 1 : 2 })),
    details: { reason: table.result.reason, margin: table.result.margin ?? null },
  }));
}

let recordOnce = () => null;

function broadcastGoState() {
  recordResult();
  if (goGame) broadcastGo("state", goGame.publicState());
}

function requireGoGame() {
  if (!goGame) {
    const error = new Error("Start a Go game first");
    error.status = 409;
    throw error;
  }
  return goGame;
}

function restoreGoGame() {
  try {
    const payload = goSaveStore.load();
    return payload ? GoGame.fromSave(payload) : null;
  } catch (error) {
    console.error(`Go save restore skipped: ${String(error?.message || error)}`);
    return null;
  }
}

function persistGoGame({ required = false } = {}) {
  if (!goGame) return null;
  try {
    const savedAt = new Date().toISOString();
    goSaveStore.save(goGame.toSave(savedAt));
    goGame.markSaved(savedAt);
    return savedAt;
  } catch (error) {
    goGame.markSaveError();
    console.error(`Go automatic save failed: ${String(error?.message || error)}`);
    if (required) {
      const saveError = new Error("The Go game could not be saved to disk");
      saveError.status = 500;
      throw saveError;
    }
    return null;
  }
}

function scheduleGoAITurn(version = goGameVersion) {
  if (!goGame || activeGoAIVersions.has(version)) return;
  setImmediate(() => runGoAIChain(version));
}

async function runGoAIChain(version) {
  if (activeGoAIVersions.has(version)) return;
  activeGoAIVersions.add(version);
  try {
    while (goGame && version === goGameVersion) {
      const table = goGame;
      if (table.phase !== "active" || table.aiError || (table.isArenaMode && table.arenaPaused)) break;
      const actor = table.currentPlayer;
      if (!actor || actor.isHuman) break;

      const color = actor.color;
      const startedAt = performance.now();
      table.aiThinking = { color, playerName: actor.name, status: `Connecting to ${actor.aiConfig.model}…`, startedAt: Date.now() };
      broadcastGo("ai_stream", { phase: "started", color, playerName: actor.name, summary: "" });
      broadcastGoState();

      try {
        const { decision } = await requestGoDecisionWithRetry({
          snapshotFactory: () => table.aiSnapshot(),
          modelConfig: actor.aiConfig,
          callbacks: {
            onStatus(status) {
              if (goGame !== table || version !== goGameVersion) return;
              table.aiThinking = { ...table.aiThinking, status };
              broadcastGo("ai_stream", { phase: "status", color, playerName: actor.name, status });
              broadcastGoState();
            },
            onSummaryDelta(delta) {
              if (goGame !== table || version !== goGameVersion) return;
              broadcastGo("ai_stream", { phase: "summary_delta", color, playerName: actor.name, delta });
            },
          },
          shouldContinue: () => goGame === table && version === goGameVersion,
          onRetry({ error, retryNumber, maxRetries }) {
            if (goGame !== table || version !== goGameVersion) return;
            const message = publicError(error);
            const status = `${message}. Retrying automatically (${retryNumber}/${maxRetries})…`;
            table.recordAIRetry(color, message, retryNumber, maxRetries);
            table.aiThinking = { ...table.aiThinking, status };
            persistGoGame();
            broadcastGo("ai_stream", {
              phase: "started",
              color,
              playerName: actor.name,
              summary: "",
              automaticRetry: true,
              retryNumber,
              maxRetries,
            });
            broadcastGoState();
          },
        });

        if (goGame !== table || version !== goGameVersion) return;
        const latencyMs = performance.now() - startedAt;
        const visibleSummary = decision.reasoningSummary || decision.explanation;
        const talk = pushTableTalk(table, { speaker: color, playerName: actor.name, characterId: actor.character?.id ?? null, text: decision.tableTalk });
        if (talk) broadcastGo("table_talk", talk);
        table.recordAIInsight(color, {
          summary: visibleSummary,
          summarySource: decision.reasoningSource || "public_decision_rationale",
          explanation: decision.explanation,
          latencyMs,
          action: decision.action,
        });
        table.aiThinking = null;
        broadcastGo("ai_stream", {
          phase: "completed",
          color,
          playerName: actor.name,
          summary: visibleSummary,
          explanation: decision.explanation,
          latencyMs: Math.round(latencyMs),
        });
        table.applyAction(color, decision.action, decision.row, decision.column);
        persistGoGame();
        broadcastGoState();
      } catch (error) {
        if (goGame !== table || version !== goGameVersion) return;
        const message = publicError(error);
        table.setAIError(color, message);
        persistGoGame();
        broadcastGo("ai_stream", { phase: "error", color, playerName: actor.name, message });
        broadcastGoState();
        break;
      }
    }
  } finally {
    activeGoAIVersions.delete(version);
    if (goGame && version === goGameVersion && goGame.phase === "active" && !goGame.aiError && !goGame.currentPlayer?.isHuman && !(goGame.isArenaMode && goGame.arenaPaused)) {
      scheduleGoAITurn(version);
    }
  }
}

export function register(app, ctx) {
  recordOnce = createMatchRecorder(ctx.results, id);
  goSaveStore = new GoSaveStore(ctx.dataDir);
  goGame = restoreGoGame();
  goGameVersion = goGame ? 1 : 0;
  // A finished game restored from disk was already recorded before the restart.
  if (goGame?.phase === "complete") recordOnce(goGame, "game", () => null);

  app.get("/api/go/state", (_request, response) => {
    response.json(goGame ? goGame.publicState() : null);
  });

  app.get("/api/go/events", (request, response) => {
    response.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    goSSEClients.add(response);
    sendSSE(response, "connected", { at: Date.now() });
    if (goGame) sendSSE(response, "state", goGame.publicState());
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      goSSEClients.delete(response);
    });
  });

  app.post("/api/go/game", (request, response, next) => {
    try {
      const next = new GoGame(request.body ?? {});
      goGameVersion += 1;
      goGame = next;
      persistGoGame();
      response.status(201).json(goGame.publicState());
      broadcastGoState();
      scheduleGoAITurn(goGameVersion);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/go/action", (request, response, next) => {
    try {
      const table = requireGoGame();
      const actor = table.currentPlayer;
      if (!actor?.isHuman) {
        const error = new Error("It is not the human player's turn");
        error.status = 409;
        throw error;
      }
      table.applyAction(actor.color, request.body?.action, request.body?.row ?? null, request.body?.column ?? null);
      persistGoGame();
      response.json(table.publicState());
      broadcastGoState();
      scheduleGoAITurn(goGameVersion);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/go/retry-ai", (_request, response, next) => {
    try {
      const table = requireGoGame();
      if (!table.aiError) {
        const error = new Error("There is no paused AI request to retry");
        error.status = 409;
        throw error;
      }
      table.clearAIError();
      persistGoGame();
      response.json(table.publicState());
      broadcastGoState();
      scheduleGoAITurn(goGameVersion);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/go/save", (_request, response, next) => {
    try {
      const table = requireGoGame();
      persistGoGame({ required: true });
      response.json(table.publicState());
      broadcastGoState();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/go/review", async (request, response, next) => {
    const table = goGame;
    try {
      requireGoGame();
      const requested = request.body?.color;
      const color = requested === "black" || requested === "white" ? requested : table.players.find((player) => !player.isHuman)?.color;
      const snapshot = table.reviewSnapshot(color);
      if (table.reviewPending) {
        const error = new Error("A review is already being written");
        error.status = 409;
        throw error;
      }
      const reviewer = table.players.find((player) => player.color === color);
      table.reviewPending = color;
      broadcastGoState();
      try {
        const review = await requestGoReview(snapshot, reviewer.aiConfig);
        table.review = {
          ...review,
          color,
          playerName: reviewer.name,
          characterId: reviewer.character?.id ?? null,
          model: reviewer.aiConfig.model,
          reasoningEffort: reviewer.aiConfig.reasoningEffort,
          at: new Date().toISOString(),
        };
      } finally {
        table.reviewPending = null;
      }
      if (goGame !== table) return response.status(409).json({ error: "A new game started before the review arrived" });
      persistGoGame();
      response.json(table.publicState());
      broadcastGoState();
    } catch (error) {
      if (goGame === table && table) broadcastGoState();
      next(error);
    }
  });

  app.post("/api/go/arena/pause",(_request, response, next) => {
    try {
      const table = requireGoGame();
      table.pauseArena();
      persistGoGame();
      response.json(table.publicState());
      broadcastGoState();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/go/arena/resume", (_request, response, next) => {
    try {
      const table = requireGoGame();
      table.resumeArena();
      persistGoGame();
      response.json(table.publicState());
      broadcastGoState();
      scheduleGoAITurn(goGameVersion);
    } catch (error) {
      next(error);
    }
  });

  return {
    onListen() {
      if (!goGame) return;
      console.log(`Restored Go move ${goGame.moveNumber} from the local save slot`);
      scheduleGoAITurn(goGameVersion);
    },
  };
}
