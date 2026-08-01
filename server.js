import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import { requestGoDecisionWithRetry } from "./src/games/go-ai.js";
import { GoGame } from "./src/games/go-game.js";
import { GoSaveStore } from "./src/games/go-save-store.js";
import { requestWuziqiDecision } from "./src/games/wuziqi-ai.js";
import { WuziqiGame } from "./src/games/wuziqi-game.js";
import { PokerGame } from "./src/poker-game.js";
import { AIDecisionError, requestHoldemDecision } from "./src/openai-player.js";
import { apiKeyForGame, configuredProviderKeys, publicModelRegistry } from "./src/platform/model-registry.js";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(rootDir, ".env.local") });
const goSaveStore = new GoSaveStore(path.resolve(rootDir, process.env.PLAYGROUND_DATA_DIR || ".playground-data"));

const app = express();
const sseClients = new Set();
const activeAIVersions = new Set();
let game = null;
let gameVersion = 0;
const goSSEClients = new Set();
const activeGoAIVersions = new Set();
let goGame = restoreGoGame();
let goGameVersion = goGame ? 1 : 0;
const wuziqiSSEClients = new Set();
const activeWuziqiAIVersions = new Set();
let wuziqiGame = null;
let wuziqiGameVersion = 0;
const bettingPhases = new Set(["preflop", "flop", "turn", "river"]);

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(rootDir, "public"), { extensions: ["html"] }));

function sendSSE(response, type, payload) {
  response.write(`data: ${JSON.stringify({ type, payload })}\n\n`);
}

function broadcast(type, payload) {
  for (const response of [...sseClients]) {
    try {
      sendSSE(response, type, payload);
    } catch {
      sseClients.delete(response);
    }
  }
}

function broadcastState() {
  if (game) broadcast("state", game.publicState());
}

function broadcastGo(type, payload) {
  for (const response of [...goSSEClients]) {
    try {
      sendSSE(response, type, payload);
    } catch {
      goSSEClients.delete(response);
    }
  }
}

function broadcastGoState() {
  if (goGame) broadcastGo("state", goGame.publicState());
}

function broadcastWuziqi(type, payload) {
  for (const response of [...wuziqiSSEClients]) {
    try {
      sendSSE(response, type, payload);
    } catch {
      wuziqiSSEClients.delete(response);
    }
  }
}

function broadcastWuziqiState() {
  if (wuziqiGame) broadcastWuziqi("state", wuziqiGame.publicState());
}

function requireGame() {
  if (!game) {
    const error = new Error("Start a table first");
    error.status = 409;
    throw error;
  }
  return game;
}

function requireGoGame() {
  if (!goGame) {
    const error = new Error("Start a Go game first");
    error.status = 409;
    throw error;
  }
  return goGame;
}

function requireWuziqiGame() {
  if (!wuziqiGame) {
    const error = new Error("Start a Wuziqi game first");
    error.status = 409;
    throw error;
  }
  return wuziqiGame;
}

function publicError(error) {
  if (error instanceof AIDecisionError) return error.message;
  return String(error?.message || "Unexpected server error").slice(0, 400);
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

function scheduleAITurn(version = gameVersion) {
  if (!game || activeAIVersions.has(version)) return;
  setImmediate(() => runAIChain(version));
}

function scheduleGoAITurn(version = goGameVersion) {
  if (!goGame || activeGoAIVersions.has(version)) return;
  setImmediate(() => runGoAIChain(version));
}

function scheduleWuziqiAITurn(version = wuziqiGameVersion) {
  if (!wuziqiGame || activeWuziqiAIVersions.has(version)) return;
  setImmediate(() => runWuziqiAIChain(version));
}

function shouldRunAutomation(table) {
  if (!table || table.aiError) return false;
  if (table.isArenaMode) {
    if (table.arenaPaused || table.arenaFinished) return false;
    if (table.phase === "hand_over") return true;
  }
  return Boolean(table.currentActor && !table.currentActor.isHuman && bettingPhases.has(table.phase));
}

function arenaIntermission() {
  return new Promise((resolve) => setTimeout(resolve, 700));
}

async function runAIChain(version) {
  if (activeAIVersions.has(version)) return;
  activeAIVersions.add(version);
  try {
    while (game && version === gameVersion) {
      const table = game;
      if (table.isArenaMode && (table.arenaPaused || table.arenaFinished)) break;
      if (table.isArenaMode && table.phase === "hand_over") {
        await arenaIntermission();
        if (game !== table || version !== gameVersion || table.arenaPaused || table.arenaFinished) break;
        table.startNewHand();
        broadcastState();
        continue;
      }

      const actor = table.currentActor;
      if (!actor || actor.isHuman || table.aiError || !bettingPhases.has(table.phase)) break;

      const seat = actor.seat;
      const startedAt = performance.now();
      table.aiThinking = { seat, playerName: actor.name, status: `Connecting to ${actor.aiConfig.model}…`, startedAt: Date.now() };
      broadcast("ai_stream", { phase: "started", seat, playerName: actor.name, summary: "" });
      broadcastState();

      try {
        const snapshot = table.aiSnapshot();
        const decision = await requestHoldemDecision(snapshot, actor.aiConfig, {
          onStatus(status) {
            if (game !== table || version !== gameVersion) return;
            table.aiThinking = { ...table.aiThinking, status };
            broadcast("ai_stream", { phase: "status", seat, playerName: actor.name, status });
            broadcastState();
          },
          onSummaryDelta(delta) {
            if (game !== table || version !== gameVersion) return;
            broadcast("ai_stream", { phase: "summary_delta", seat, playerName: actor.name, delta });
          },
        });

        if (game !== table || version !== gameVersion) return;
        const latencyMs = performance.now() - startedAt;
        const visibleSummary = decision.reasoningSummary || decision.explanation;
        const summarySource = decision.reasoningSource || "public_decision_rationale";
        table.recordAIInsight(seat, {
          summary: visibleSummary,
          summarySource,
          explanation: decision.explanation,
          latencyMs,
          action: decision.action,
        });
        table.aiThinking = null;
        broadcast("ai_stream", {
          phase: "completed",
          seat,
          playerName: actor.name,
          summary: visibleSummary,
          summarySource,
          explanation: decision.explanation,
          latencyMs: Math.round(latencyMs),
        });
        table.applyAction(seat, decision.action, decision.targetTotal);
        broadcastState();
      } catch (error) {
        if (game !== table || version !== gameVersion) return;
        const message = publicError(error);
        table.setAIError(seat, message);
        broadcast("ai_stream", { phase: "error", seat, playerName: actor.name, message });
        broadcastState();
        break;
      }
    }
  } finally {
    activeAIVersions.delete(version);
    if (game && version === gameVersion && shouldRunAutomation(game)) {
      scheduleAITurn(version);
    }
  }
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
        const snapshot = table.aiSnapshot();
        const decision = await requestWuziqiDecision(snapshot, actor.aiConfig, {
          onStatus(status) {
            if (wuziqiGame !== table || version !== wuziqiGameVersion) return;
            table.aiThinking = { ...table.aiThinking, status };
            broadcastWuziqi("ai_stream", { phase: "status", color, playerName: actor.name, status });
            broadcastWuziqiState();
          },
          onSummaryDelta(delta) {
            if (wuziqiGame !== table || version !== wuziqiGameVersion) return;
            broadcastWuziqi("ai_stream", { phase: "summary_delta", color, playerName: actor.name, delta });
          },
        });

        if (wuziqiGame !== table || version !== wuziqiGameVersion) return;
        const latencyMs = performance.now() - startedAt;
        const visibleSummary = decision.reasoningSummary || decision.explanation;
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

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    apiKeys: {
      holdem: Boolean(apiKeyForGame("holdem").value),
      go: Boolean(apiKeyForGame("go").value),
      wuziqi: Boolean(apiKeyForGame("wuziqi").value),
    },
    providerKeys: configuredProviderKeys(),
    models: publicModelRegistry(),
    games: { holdem: true, go: true, wuziqi: true },
    noLocalFallback: true,
  });
});

app.get("/api/state", (_request, response) => {
  response.json(game ? game.publicState() : null);
});

app.get("/api/events", (request, response) => {
  response.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  sseClients.add(response);
  sendSSE(response, "connected", { at: Date.now() });
  if (game) sendSSE(response, "state", game.publicState());

  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  request.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(response);
  });
});

app.post("/api/game", (request, response, next) => {
  try {
    gameVersion += 1;
    game = new PokerGame(request.body ?? {});
    response.status(201).json(game.publicState());
    broadcastState();
    scheduleAITurn(gameVersion);
  } catch (error) {
    next(error);
  }
});

app.post("/api/action", (request, response, next) => {
  try {
    const table = requireGame();
    const actor = table.currentActor;
    if (!actor?.isHuman) {
      const error = new Error("It is not the human player's turn");
      error.status = 409;
      throw error;
    }
    table.applyAction(actor.seat, request.body?.action, request.body?.targetTotal ?? null);
    response.json(table.publicState());
    broadcastState();
    scheduleAITurn(gameVersion);
  } catch (error) {
    next(error);
  }
});

app.post("/api/next-hand", (_request, response, next) => {
  try {
    const table = requireGame();
    table.startNewHand();
    response.json(table.publicState());
    broadcastState();
    scheduleAITurn(gameVersion);
  } catch (error) {
    next(error);
  }
});

app.post("/api/retry-ai", (_request, response, next) => {
  try {
    const table = requireGame();
    if (!table.aiError) {
      const error = new Error("There is no paused AI request to retry");
      error.status = 409;
      throw error;
    }
    table.clearAIError();
    response.json(table.publicState());
    broadcastState();
    scheduleAITurn(gameVersion);
  } catch (error) {
    next(error);
  }
});

app.post("/api/arena/pause", (_request, response, next) => {
  try {
    const table = requireGame();
    table.pauseArena();
    response.json(table.publicState());
    broadcastState();
  } catch (error) {
    next(error);
  }
});

app.post("/api/arena/resume", (_request, response, next) => {
  try {
    const table = requireGame();
    table.resumeArena();
    response.json(table.publicState());
    broadcastState();
    scheduleAITurn(gameVersion);
  } catch (error) {
    next(error);
  }
});

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
    goGameVersion += 1;
    goGame = new GoGame(request.body ?? {});
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

app.post("/api/go/arena/pause", (_request, response, next) => {
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
    wuziqiGameVersion += 1;
    wuziqiGame = new WuziqiGame(request.body ?? {});
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

app.use((error, _request, response, _next) => {
  const status = Number.isInteger(error.status) ? error.status : 400;
  response.status(status).json({ error: publicError(error) });
});

const port = Number.parseInt(process.env.PORT, 10) || 4173;
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`JYs AI Playground is ready at http://127.0.0.1:${port}`);
  if (goGame) {
    console.log(`Restored Go move ${goGame.moveNumber} from the local save slot`);
    scheduleGoAITurn(goGameVersion);
  }
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
