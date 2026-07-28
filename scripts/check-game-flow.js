const baseURL = process.env.LUNA_HOLDEM_URL || "http://127.0.0.1:4173";

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseURL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

let state = await jsonRequest("/api/game", {
  method: "POST",
  body: JSON.stringify({ humanName: "Flow Check", opponentCount: 2, startingStack: 1_000, smallBlind: 10, bigBlind: 20 }),
});
if (state.currentActorSeat !== 0 || !state.legalActions?.actions.includes("call")) {
  throw new Error("Expected the human to open the three-handed pre-flop action");
}

state = await jsonRequest("/api/action", { method: "POST", body: JSON.stringify({ action: "call" }) });
const startedAt = Date.now();
while (Date.now() - startedAt < 120_000) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  state = await jsonRequest("/api/state");
  const actor = state.players.find((player) => player.seat === state.currentActorSeat);
  const aiCompleted = state.players.some((player) => !player.isHuman && player.lastLatencyMs !== null);
  if (state.aiError) throw new Error(`AI flow paused: ${state.aiError.message}`);
  if (aiCompleted && (!actor || actor.isHuman || ["hand_over", "game_over"].includes(state.phase))) {
    console.log(JSON.stringify({
      ok: true,
      phase: state.phase,
      currentActor: actor?.name ?? null,
      completedAIDecisions: state.players.filter((player) => !player.isHuman && player.lastLatencyMs !== null).length,
      summarySources: state.players.filter((player) => !player.isHuman && player.lastSummarySource).map((player) => player.lastSummarySource),
    }));
    process.exit(0);
  }
}
throw new Error("The live AI game-flow check did not reach the next human decision within 120 seconds");

