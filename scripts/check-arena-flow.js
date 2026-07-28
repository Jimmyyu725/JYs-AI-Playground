const baseURL = process.env.LUNA_HOLDEM_URL || "http://127.0.0.1:4173";

let state = await fetch(`${baseURL}/api/game`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    gameMode: "arena",
    opponentCount: 2,
    arenaHandTarget: 1,
    startingStack: 200,
    smallBlind: 100,
    bigBlind: 200,
  }),
}).then((response) => response.json());

if (state.gameMode !== "arena" || state.players.length !== 2 || state.players.some((player) => player.isHuman)) {
  throw new Error(`Arena did not start with two AI seats: ${JSON.stringify(state)}`);
}

const startedAt = Date.now();
while (!state.arena?.finished && !state.aiError) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  state = await fetch(`${baseURL}/api/state`).then((response) => response.json());
  if (Date.now() - startedAt > 900_000) throw new Error("Arena verification exceeded 15 minutes");
}

if (state.aiError) throw new Error(`Luna paused the arena: ${state.aiError.message}`);
if (state.arena.handsPlayed !== 1 || !state.arena.paused || !state.arena.finished) {
  throw new Error(`Arena target was not honored: ${JSON.stringify(state.arena)}`);
}
if (state.players.some((player) => player.holeCards.includes("BACK"))) {
  throw new Error("Arena spectator state hid an AI hole card");
}
const modelActions = state.logs.filter((entry) => entry.kind === "action" && entry.action).length;
if (modelActions < 1) throw new Error("No Luna decision was applied during the arena hand");
if (!state.aiInsights?.length || !state.aiInsights[0].summary) {
  throw new Error("The completed Luna summary was not retained in the persistent transcript");
}

console.log(JSON.stringify({
  ok: true,
  model: state.model,
  reasoningEffort: state.reasoningEffort,
  handsPlayed: state.arena.handsPlayed,
  modelActions,
  retainedInsights: state.aiInsights.length,
  finalPhase: state.phase,
}));
