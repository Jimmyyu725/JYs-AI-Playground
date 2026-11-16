import { AIDecisionError } from "./ai-decision-error.js";

export function sendSSE(response, type, payload) {
  response.write(`data: ${JSON.stringify({ type, payload })}\n\n`);
}

export function publicError(error) {
  if (error instanceof AIDecisionError) return error.message;
  return String(error?.message || "Unexpected server error").slice(0, 400);
}

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * One server-sent-events fan-out. `handler(getState)` is an Express route handler that
 * subscribes a client and immediately sends the current state when there is one.
 */
export function createSSEChannel() {
  const clients = new Set();
  function broadcast(type, payload) {
    for (const response of [...clients]) {
      try {
        sendSSE(response, type, payload);
      } catch {
        clients.delete(response);
      }
    }
  }
  function handler(getState) {
    return (request, response) => {
      response.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.flushHeaders();
      clients.add(response);
      sendSSE(response, "connected", { at: Date.now() });
      const state = getState();
      if (state) sendSSE(response, "state", state);
      const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
      request.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(response);
      });
    };
  }
  return { clients, broadcast, handler };
}

/**
 * Records each finished match exactly once. `key` distinguishes several results that one
 * table object can produce (for example consecutive deals on the same table).
 */
export function createMatchRecorder(results, gameId) {
  const recorded = new WeakMap();
  return function recordOnce(table, key, buildMatch) {
    if (!results || !table) return null;
    const keys = recorded.get(table) ?? new Set();
    if (keys.has(key)) return null;
    keys.add(key);
    recorded.set(table, keys);
    try {
      const match = buildMatch();
      return match ? results.recordMatch({ gameId, ...match }) : null;
    } catch (error) {
      console.error(`Could not record ${gameId} result: ${String(error?.message || error)}`);
      return null;
    }
  };
}

/** Maps an engine player ({ isHuman, name, character, aiConfig }) to a results-store participant. */
export function participantFrom(player, outcome) {
  const base = player.isHuman
    ? { kind: "human", name: player.name }
    : {
        kind: "ai",
        name: player.name,
        characterId: characterIdOf(player.character),
        model: player.aiConfig?.model,
        reasoningEffort: player.aiConfig?.reasoningEffort,
      };
  return { ...base, ...outcome };
}

export function characterIdOf(character) {
  if (!character) return null;
  if (character.id) return String(character.id);
  return String(character.name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || null;
}
