import { requestDoudizhuBidWithRetry, requestDoudizhuPlayWithRetry, requestDoudizhuReview } from "../games/doudizhu-ai.js";
import { DouDizhuGame } from "../games/doudizhu-game.js";
import { pushTableTalk } from "../platform/table-talk.js";
import { createMatchRecorder, httpError, participantFrom, publicError, sendSSE } from "../platform/room-kit.js";

export const id = "doudizhu";
export const defaults = { model: "gpt-6-luna", reasoningEffort: "low" };

const doudizhuSSEClients = new Set();

const activeDoudizhuAIVersions = new Set();

let doudizhuGame = null;

let doudizhuGameVersion = 0;

function broadcastDoudizhu(type, payload) {
  for (const response of [...doudizhuSSEClients]) {
    try {
      sendSSE(response, type, payload);
    } catch {
      doudizhuSSEClients.delete(response);
    }
  }
}

function recordResult() {
  const table = doudizhuGame;
  if (!table || table.phase !== "complete" || !table.result) return;
  recordOnce(table, "game", () => ({
    mode: table.gameMode === "arena" ? "arena" : "human-vs-ai",
    participants: table.players.map((player) => participantFrom(player, { place: table.result.winningSeats.includes(player.seat) ? 1 : 2 })),
    details: { winner: table.result.winner },
  }));
}

let recordOnce = () => null;

function broadcastDoudizhuState() {
  recordResult();
  if (doudizhuGame) broadcastDoudizhu("state", doudizhuGame.publicState());
}

function requireDoudizhuGame() {
  if (!doudizhuGame) {
    const error = new Error("Start a Dou Dizhu game first");
    error.status = 409;
    throw error;
  }
  return doudizhuGame;
}

function scheduleDoudizhuAITurn(version = doudizhuGameVersion) {
  if (!doudizhuGame || activeDoudizhuAIVersions.has(version)) return;
  setImmediate(() => runDoudizhuAIChain(version));
}

async function runDoudizhuAIChain(version) {
  if (activeDoudizhuAIVersions.has(version)) return;
  activeDoudizhuAIVersions.add(version);
  try {
    while (doudizhuGame && version === doudizhuGameVersion) {
      const table = doudizhuGame;
      if (table.phase === "complete" || table.aiError || (table.isArenaMode && table.arenaPaused)) break;
      const actor = table.currentActor;
      if (!actor || actor.isHuman) break;

      const seat = actor.seat;
      const startedAt = performance.now();
      table.aiThinking = { seat, playerName: actor.name, status: `Connecting to ${actor.aiConfig.model}…`, startedAt: Date.now() };
      broadcastDoudizhu("ai_stream", { phase: "started", seat, playerName: actor.name, summary: "" });
      broadcastDoudizhuState();

      const callbacks = {
        onStatus(status) {
          if (doudizhuGame !== table || version !== doudizhuGameVersion) return;
          table.aiThinking = { ...table.aiThinking, status };
          broadcastDoudizhu("ai_stream", { phase: "status", seat, playerName: actor.name, status });
          broadcastDoudizhuState();
        },
        onSummaryDelta(delta) {
          if (doudizhuGame !== table || version !== doudizhuGameVersion) return;
          broadcastDoudizhu("ai_stream", { phase: "summary_delta", seat, playerName: actor.name, delta });
        },
      };

      try {
        const retryOptions = {
          snapshotFactory: () => table.aiSnapshot(),
          modelConfig: actor.aiConfig,
          callbacks,
          shouldContinue: () => doudizhuGame === table && version === doudizhuGameVersion,
          onRetry({ error, retryNumber, maxRetries }) {
            if (doudizhuGame !== table || version !== doudizhuGameVersion) return;
            const message = publicError(error);
            const status = `${message}. Retrying automatically (${retryNumber}/${maxRetries})…`;
            table.recordAIRetry(seat, message, retryNumber, maxRetries);
            table.aiThinking = { ...table.aiThinking, status };
            broadcastDoudizhu("ai_stream", {
              phase: "started",
              seat,
              playerName: actor.name,
              summary: "",
              automaticRetry: true,
              retryNumber,
              maxRetries,
            });
            broadcastDoudizhuState();
          },
        };
        let decision;
        let insightAction;
        if (table.phase === "bidding") {
          ({ decision } = await requestDoudizhuBidWithRetry(retryOptions));
          insightAction = decision.action === "bid" ? `bid ${decision.score}` : "pass bid";
        } else {
          ({ decision } = await requestDoudizhuPlayWithRetry(retryOptions));
          insightAction = decision.action === "play" ? `play ${decision.cards.join(" ")}` : "pass";
        }

        if (doudizhuGame !== table || version !== doudizhuGameVersion) return;
        const latencyMs = performance.now() - startedAt;
        const visibleSummary = decision.reasoningSummary || decision.explanation;
        const talk = pushTableTalk(table, { speaker: seat, playerName: actor.name, characterId: actor.character?.id ?? null, text: decision.tableTalk });
        if (talk) broadcastDoudizhu("table_talk", talk);
        table.recordAIInsight(seat, {
          summary: visibleSummary,
          summarySource: decision.reasoningSummary ? "openai_reasoning_summary" : "public_decision_rationale",
          explanation: decision.explanation,
          latencyMs,
          action: insightAction,
        });
        table.aiThinking = null;
        broadcastDoudizhu("ai_stream", {
          phase: "completed",
          seat,
          playerName: actor.name,
          summary: visibleSummary,
          explanation: decision.explanation,
          latencyMs: Math.round(latencyMs),
        });

        if (table.phase === "bidding") {
          table.applyBid(seat, decision.action === "bid" ? decision.score : 0);
        } else {
          table.applyAction(seat, decision.action, decision.cards);
        }
        broadcastDoudizhuState();
      } catch (error) {
        if (doudizhuGame !== table || version !== doudizhuGameVersion) return;
        const message = publicError(error);
        table.setAIError(seat, message);
        broadcastDoudizhu("ai_stream", { phase: "error", seat, playerName: actor.name, message });
        broadcastDoudizhuState();
        break;
      }
    }
  } finally {
    activeDoudizhuAIVersions.delete(version);
    if (doudizhuGame && version === doudizhuGameVersion && doudizhuGame.phase !== "complete" && !doudizhuGame.aiError && !doudizhuGame.currentActor?.isHuman && !(doudizhuGame.isArenaMode && doudizhuGame.arenaPaused)) {
      scheduleDoudizhuAITurn(version);
    }
  }
}

export function register(app, ctx) {
  recordOnce = createMatchRecorder(ctx.results, id);
  app.get("/api/doudizhu/state", (_request, response) => {
    response.json(doudizhuGame ? doudizhuGame.publicState() : null);
  });

  app.get("/api/doudizhu/events", (request, response) => {
    response.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    doudizhuSSEClients.add(response);
    sendSSE(response, "connected", { at: Date.now() });
    if (doudizhuGame) sendSSE(response, "state", doudizhuGame.publicState());
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      doudizhuSSEClients.delete(response);
    });
  });

  app.post("/api/doudizhu/game", (request, response, next) => {
    try {
      const next = new DouDizhuGame(request.body ?? {});
      doudizhuGameVersion += 1;
      doudizhuGame = next;
      response.status(201).json(doudizhuGame.publicState());
      broadcastDoudizhuState();
      scheduleDoudizhuAITurn(doudizhuGameVersion);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/doudizhu/bid", (request, response, next) => {
    try {
      const table = requireDoudizhuGame();
      const actor = table.currentActor;
      if (!actor?.isHuman) {
        const error = new Error("It is not the human player's turn");
        error.status = 409;
        throw error;
      }
      table.applyBid(actor.seat, request.body?.score ?? 0);
      response.json(table.publicState());
      broadcastDoudizhuState();
      scheduleDoudizhuAITurn(doudizhuGameVersion);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/doudizhu/action", (request, response, next) => {
    try {
      const table = requireDoudizhuGame();
      const actor = table.currentActor;
      if (!actor?.isHuman) {
        const error = new Error("It is not the human player's turn");
        error.status = 409;
        throw error;
      }
      table.applyAction(actor.seat, request.body?.action, request.body?.cards ?? null);
      response.json(table.publicState());
      broadcastDoudizhuState();
      scheduleDoudizhuAITurn(doudizhuGameVersion);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/doudizhu/retry-ai", (_request, response, next) => {
    try {
      const table = requireDoudizhuGame();
      if (!table.aiError) {
        const error = new Error("There is no paused AI request to retry");
        error.status = 409;
        throw error;
      }
      table.clearAIError();
      response.json(table.publicState());
      broadcastDoudizhuState();
      scheduleDoudizhuAITurn(doudizhuGameVersion);
    } catch (error) {
      next(error);
    }
  });

  // Post-game review: one AI seat looks back over the public record of the settled hand.
  app.post("/api/doudizhu/review", async (request, response, next) => {
    try {
      const table = requireDoudizhuGame();
      if (table.phase !== "complete") throw httpError(409, "The hand is still being played");
      const seat = Number(request.body?.seat);
      if (!Number.isInteger(seat) || !table.players[seat] || table.players[seat].isHuman) throw httpError(400, "Choose an AI seat to review the hand");
      table.reviews ??= {};
      const key = `${table.handNumber}:${seat}`;
      if (!table.reviews[key]) {
        try {
          table.reviews[key] = await requestDoudizhuReview(table, seat);
        } catch (error) {
          throw httpError(502, publicError(error));
        }
      }
      response.json({ seat, playerName: table.players[seat].name, characterId: table.players[seat].character?.id ?? null, review: table.reviews[key] });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/doudizhu/arena/pause", (_request, response, next) => {
    try {
      const table = requireDoudizhuGame();
      table.pauseArena();
      response.json(table.publicState());
      broadcastDoudizhuState();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/doudizhu/arena/resume", (_request, response, next) => {
    try {
      const table = requireDoudizhuGame();
      table.resumeArena();
      response.json(table.publicState());
      broadcastDoudizhuState();
      scheduleDoudizhuAITurn(doudizhuGameVersion);
    } catch (error) {
      next(error);
    }
  });
}
