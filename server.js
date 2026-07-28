import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import { PokerGame } from "./src/poker-game.js";
import { AIDecisionError, requestLunaDecision } from "./src/openai-player.js";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(rootDir, ".env.local") });

const app = express();
const sseClients = new Set();
const activeAIVersions = new Set();
let game = null;
let gameVersion = 0;

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

function requireGame() {
  if (!game) {
    const error = new Error("Start a table first");
    error.status = 409;
    throw error;
  }
  return game;
}

function publicError(error) {
  if (error instanceof AIDecisionError) return error.message;
  return String(error?.message || "Unexpected server error").slice(0, 400);
}

function scheduleAITurn(version = gameVersion) {
  if (!game || activeAIVersions.has(version)) return;
  setImmediate(() => runAIChain(version));
}

async function runAIChain(version) {
  if (activeAIVersions.has(version)) return;
  activeAIVersions.add(version);
  try {
    while (game && version === gameVersion) {
      const table = game;
      const actor = table.currentActor;
      if (!actor || actor.isHuman || table.aiError || !["preflop", "flop", "turn", "river"].includes(table.phase)) break;

      const seat = actor.seat;
      const startedAt = performance.now();
      table.aiThinking = { seat, playerName: actor.name, status: "Connecting to GPT-5.6 Luna…", startedAt: Date.now() };
      broadcast("ai_stream", { phase: "started", seat, playerName: actor.name, summary: "" });
      broadcastState();

      try {
        const snapshot = table.aiSnapshot();
        const decision = await requestLunaDecision(snapshot, {
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
        const summarySource = decision.reasoningSummary ? "openai_reasoning_summary" : "public_decision_rationale";
        table.recordAIInsight(seat, {
          summary: visibleSummary,
          summarySource,
          explanation: decision.explanation,
          latencyMs,
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
    if (game && version === gameVersion && game.currentActor && !game.currentActor.isHuman && !game.aiError) {
      scheduleAITurn(version);
    }
  }
}

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
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

app.use((error, _request, response, _next) => {
  const status = Number.isInteger(error.status) ? error.status : 400;
  response.status(status).json({ error: publicError(error) });
});

const port = Number.parseInt(process.env.PORT, 10) || 4173;
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`Luna Hold'em is ready at http://127.0.0.1:${port}`);
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
