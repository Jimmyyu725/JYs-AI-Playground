import { PokerGame } from "../poker-game.js";
import { requestHoldemDecision } from "../openai-player.js";
import { pushTableTalk } from "../platform/table-talk.js";
import { createMatchRecorder, participantFrom, publicError, sendSSE } from "../platform/room-kit.js";

export const id = "holdem";
export const defaults = { model: "gpt-6-luna", reasoningEffort: "low" };

const sseClients = new Set();

const activeAIVersions = new Set();

let game = null;

let gameVersion = 0;

const bettingPhases = new Set(["preflop", "flop", "turn", "river"]);

function broadcast(type, payload) {
  for (const response of [...sseClients]) {
    try {
      sendSSE(response, type, payload);
    } catch {
      sseClients.delete(response);
    }
  }
}

function recordResult() {
  const table = game;
  if (!table || !(table.phase === "game_over" || table.arenaFinished)) return;
  recordOnce(table, "session", () => ({
    mode: table.gameMode === "arena" ? "arena" : "human-vs-ai",
    participants: table.players.map((player) => participantFrom(player, { score: player.stack })),
    details: { hands: table.completedHands },
  }));
}

let recordOnce = () => null;

function broadcastState() {
  recordResult();
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

function scheduleAITurn(version = gameVersion) {
  if (!game || activeAIVersions.has(version)) return;
  setImmediate(() => runAIChain(version));
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
        const talk = pushTableTalk(table, { speaker: seat, playerName: actor.name, characterId: actor.character?.id ?? null, text: decision.tableTalk });
        if (talk) broadcast("table_talk", talk);
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

export function register(app, ctx) {
  recordOnce = createMatchRecorder(ctx.results, id);
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
      const next = new PokerGame(request.body ?? {});
      gameVersion += 1;
      game = next;
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
}
