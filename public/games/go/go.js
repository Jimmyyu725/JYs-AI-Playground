const MODEL_OPTIONS = [
  ["gpt-6.1-sol", "GPT-6.1 Sol"],
  ["gpt-6.1-terra", "GPT-6.1 Terra"],
  ["gpt-6-luna", "GPT-6 Luna"],
  ["gpt-6-astra", "GPT-6 Astra"],
  ["deepseek-v4-pro", "DeepSeek V4 Pro"],
  ["deepseek-flash", "DeepSeek Flash"],
];
const REASONING_OPTIONS = ["none", "low", "medium", "high", "xhigh", "max"];
const SUMMARY_SOURCE_LABELS = {
  openai_reasoning_summary: "OpenAI summary",
  deepseek_reasoning_content: "DeepSeek raw reasoning",
  public_decision_rationale: "public rationale",
};
const CHARACTERS = [
  { name: "Vesper Vale", title: "The Velvet Knife", initials: "VV", color: "#d96f9f" },
  { name: "Selene Park", title: "The Oracle", initials: "SP", color: "#75c8d8" },
];

const ids = [
  "new-game-button", "model-pill", "reasoning-pill", "move-number", "turn-stone", "turn-label", "turn-detail",
  "black-player", "white-player", "go-board", "game-overlay", "overlay-eyebrow", "overlay-title", "overlay-copy",
  "overlay-action", "black-captures", "white-captures", "komi-value", "save-button", "pass-button", "resign-button", "arena-toggle",
  "live-indicator", "thinker-profile", "reasoning-status", "reasoning-text", "reasoning-count", "reasoning-feed",
  "history-list", "setup-modal", "setup-form", "setup-lede", "mode-options", "human-name-field", "human-color-field",
  "ai-roster", "apply-roster", "setup-submit", "cancel-setup", "toast",
];
const elements = Object.fromEntries(ids.map((id) => [id.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase()), document.getElementById(id)]));

let state = null;
let liveSummary = "";
let toastTimer = null;
let boardSignature = "";
let actionBusy = false;
let requestInFlight = 0;

function modelLabel(id) {
  return MODEL_OPTIONS.find(([value]) => value === id)?.[1] ?? id;
}

function shortModelLabel(id) {
  return String(id).replace(/^gpt-6(\.1)?-/, "").replace(/^deepseek-/, "");
}

function showToast(message, tone = "error") {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("success", tone === "success");
  elements.toast.classList.add("visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 5000);
}

async function request(path, options = {}) {
  requestInFlight += 1;
  try {
    const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers ?? {}) } });
    let payload = null;
    try { payload = await response.json(); } catch { /* empty response */ }
    if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
    return payload;
  } finally {
    requestInFlight -= 1;
  }
}

function starPoints(size) {
  if (size === 9) return new Set(["2,2", "2,6", "4,4", "6,2", "6,6"]);
  if (size === 13) return new Set(["3,3", "3,9", "6,6", "9,3", "9,9"]);
  const points = [3, 9, 15];
  return new Set(points.flatMap((row) => points.map((column) => `${row},${column}`)));
}

function rebuildBoard() {
  elements.goBoard.replaceChildren();
  elements.goBoard.style.setProperty("--size", state.boardSize);
  const stars = starPoints(state.boardSize);
  for (let row = 0; row < state.boardSize; row += 1) {
    for (let column = 0; column < state.boardSize; column += 1) {
      const intersection = document.createElement("button");
      intersection.type = "button";
      intersection.className = "intersection";
      if (row === 0) intersection.classList.add("edge-top");
      if (row === state.boardSize - 1) intersection.classList.add("edge-bottom");
      if (column === 0) intersection.classList.add("edge-left");
      if (column === state.boardSize - 1) intersection.classList.add("edge-right");
      intersection.dataset.row = String(row);
      intersection.dataset.column = String(column);
      intersection.setAttribute("role", "gridcell");
      if (stars.has(`${row},${column}`)) {
        intersection.classList.add("star");
        const dot = document.createElement("span");
        dot.className = "star-dot";
        intersection.append(dot);
      }
      elements.goBoard.append(intersection);
    }
  }
}

function renderBoard() {
  const signature = `${state.boardSize}:${state.board.flat().map((cell) => cell?.[0] ?? ".").join("")}:${state.humanCanAct}:${state.lastMove?.row},${state.lastMove?.column}`;
  if (!elements.goBoard.children.length || boardSignature.split(":")[0] !== String(state.boardSize)) rebuildBoard();
  boardSignature = signature;
  for (const intersection of elements.goBoard.children) {
    const row = Number(intersection.dataset.row);
    const column = Number(intersection.dataset.column);
    const cell = state.board[row][column];
    intersection.classList.toggle("occupied", Boolean(cell));
    intersection.classList.toggle("human-turn", state.humanCanAct);
    intersection.classList.toggle("last-move", state.lastMove?.action === "place" && state.lastMove.row === row && state.lastMove.column === column);
    intersection.disabled = !state.humanCanAct || Boolean(cell);
    intersection.setAttribute("aria-label", `${cell ?? "Empty"} intersection, row ${row + 1}, column ${column + 1}`);
    intersection.querySelector(".stone")?.remove();
    if (cell) {
      const stone = document.createElement("span");
      stone.className = `stone ${cell}`;
      intersection.append(stone);
    }
  }
}

function playerCard(player) {
  const card = document.createDocumentFragment();
  const avatar = document.createElement("span");
  avatar.className = "player-avatar";
  avatar.textContent = player.isHuman ? "YOU" : player.character.initials;
  const name = document.createElement("strong");
  name.textContent = player.name;
  const title = document.createElement("small");
  title.textContent = player.isHuman ? "House guest" : player.character.title;
  const config = document.createElement("p");
  config.textContent = player.isHuman ? "Your move · your judgment" : `${modelLabel(player.aiConfig.model)} · ${player.aiConfig.reasoningEffort}`;
  const color = document.createElement("span");
  color.className = "color-label";
  color.innerHTML = `<i class="${player.color}"></i>${player.color}`;
  card.append(avatar, name, title, config, color);
  return card;
}

function renderPlayers() {
  for (const color of ["black", "white"]) {
    const player = state.players.find((candidate) => candidate.color === color);
    const target = color === "black" ? elements.blackPlayer : elements.whitePlayer;
    target.replaceChildren(playerCard(player));
    target.className = `player-card ${color}-player${player.isHuman ? " human" : ""}${state.phase === "active" && state.currentColor === color ? " active" : ""}`;
    target.style.setProperty("--player-color", player.character?.color ?? "#d7b66a");
  }
}

function resultCopy() {
  if (state.result.reason === "resignation") return `${state.result.winner[0].toUpperCase()}${state.result.winner.slice(1)} wins by resignation.`;
  const scores = state.result.scores;
  if (!state.result.winner) return `The final score is tied at ${scores.black}–${scores.white}.`;
  return `${state.result.winner[0].toUpperCase()}${state.result.winner.slice(1)} wins by ${state.result.margin}. Final area score: Black ${scores.black}, White ${scores.white}.`;
}

function renderOverlay() {
  if (state.aiError) {
    elements.gameOverlay.classList.remove("hidden");
    elements.overlayEyebrow.textContent = "Model request paused";
    elements.overlayTitle.textContent = `${state.aiError.playerName} needs a retry`;
    elements.overlayCopy.textContent = state.aiError.message;
    elements.overlayAction.textContent = "Retry model";
    elements.overlayAction.dataset.action = "retry";
  } else if (state.phase === "complete") {
    elements.gameOverlay.classList.remove("hidden");
    elements.overlayEyebrow.textContent = "Game complete";
    elements.overlayTitle.textContent = state.result.winner ? `${state.result.winner[0].toUpperCase()}${state.result.winner.slice(1)} takes the board` : "The board is even";
    elements.overlayCopy.textContent = resultCopy();
    elements.overlayAction.textContent = "Open new game";
    elements.overlayAction.dataset.action = "new";
  } else {
    elements.gameOverlay.classList.add("hidden");
  }
}

function renderInsight() {
  const actor = state.players.find((player) => player.color === (state.aiThinking?.color ?? state.currentColor));
  const isThinking = Boolean(state.aiThinking);
  elements.liveIndicator.classList.toggle("active", isThinking);
  elements.liveIndicator.innerHTML = `<i></i> ${isThinking ? "Live" : "Idle"}`;
  elements.thinkerProfile.replaceChildren();
  const stone = document.createElement("span");
  stone.className = `profile-stone ${actor?.color ?? "black"}`;
  const copy = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = actor?.name ?? "No active player";
  const meta = document.createElement("span");
  meta.textContent = actor?.isHuman ? "Human player" : `${modelLabel(actor?.aiConfig.model)} · ${actor?.aiConfig.reasoningEffort} reasoning`;
  copy.append(name, meta);
  elements.thinkerProfile.append(stone, copy);
  elements.reasoningStatus.textContent = state.aiThinking?.status ?? "No model request is active.";
  elements.reasoningText.textContent = isThinking ? liveSummary || "Waiting for a supported reasoning summary…" : "Completed summaries remain in the transcript below.";

  elements.reasoningCount.textContent = `${state.aiInsights.length} ${state.aiInsights.length === 1 ? "entry" : "entries"}`;
  elements.reasoningFeed.replaceChildren();
  for (const insight of state.aiInsights) {
    const item = document.createElement("li");
    item.className = "reasoning-entry";
    item.style.setProperty("--entry-color", insight.characterColor);
    const heading = document.createElement("div");
    const insightName = document.createElement("strong");
    insightName.textContent = insight.playerName;
    const metaLine = document.createElement("span");
    const source = SUMMARY_SOURCE_LABELS[insight.summarySource] ?? "";
    metaLine.textContent = `Move ${insight.moveNumber} · ${shortModelLabel(insight.model)} · ${(insight.latencyMs / 1000).toFixed(1)}s${source ? ` · ${source}` : ""}`;
    heading.append(insightName, metaLine);
    const summary = document.createElement("p");
    summary.textContent = insight.summary || insight.explanation;
    item.append(heading, summary);
    elements.reasoningFeed.append(item);
  }
}

function renderHistory() {
  elements.historyList.replaceChildren();
  state.logs.slice(0, 80).forEach((entry, index) => {
    const item = document.createElement("li");
    item.className = `history-entry ${entry.kind}`;
    const number = document.createElement("span");
    number.textContent = String(state.logs.length - index).padStart(2, "0");
    const text = document.createElement("span");
    text.textContent = entry.text;
    item.append(number, text);
    elements.historyList.append(item);
  });
}

function render() {
  if (!state) return;
  elements.moveNumber.textContent = state.moveNumber;
  elements.blackCaptures.textContent = state.captures.black;
  elements.whiteCaptures.textContent = state.captures.white;
  elements.komiValue.textContent = state.komi;
  elements.modelPill.innerHTML = `<i></i> ${state.model === "mixed" ? "Mixed models" : modelLabel(state.model)}`;
  elements.reasoningPill.textContent = `Reasoning · ${state.reasoningEffort}`;
  elements.turnStone.className = `turn-stone ${state.currentColor}`;
  elements.turnLabel.textContent = state.phase === "complete" ? "Game complete" : `${state.currentColor[0].toUpperCase()}${state.currentColor.slice(1)} to play`;
  const actor = state.players.find((player) => player.color === state.currentColor);
  elements.turnDetail.textContent = state.aiError ? "Waiting for retry" : state.arena?.paused ? "AI Arena paused" : actor ? `${actor.name}${state.aiThinking ? " is considering the board" : " has the move"}` : "Territory settled";
  elements.saveButton.disabled = false;
  elements.saveButton.title = state.save?.savedAt
    ? `Last saved ${new Date(state.save.savedAt).toLocaleString()}${state.save.restored ? " · restored after restart" : ""}`
    : "Save the current Go game to this Mac";
  elements.saveButton.classList.toggle("save-error", Boolean(state.save?.error));
  elements.passButton.disabled = !state.humanCanAct;
  elements.resignButton.disabled = !state.humanCanAct;
  elements.arenaToggle.classList.toggle("hidden", state.gameMode !== "arena" || state.phase === "complete");
  if (state.arena) elements.arenaToggle.textContent = state.arena.paused ? "Resume arena" : "Pause arena";
  renderBoard();
  renderPlayers();
  renderOverlay();
  renderInsight();
  renderHistory();
}

async function performAction(action, row = null, column = null) {
  if (actionBusy) return;
  actionBusy = true;
  try {
    state = await request("/api/go/action", { method: "POST", body: JSON.stringify({ action, row, column }) });
    liveSummary = "";
    render();
  } catch (error) {
    showToast(error.message);
  } finally {
    actionBusy = false;
  }
}

function selectedMode() {
  return new FormData(elements.setupForm).get("gameMode") === "arena" ? "arena" : "human";
}

function addRosterRow(character, existing = {}) {
  const row = document.createElement("div");
  row.className = "ai-roster-row";
  const characterBlock = document.createElement("div");
  characterBlock.className = "roster-character";
  const avatar = document.createElement("span");
  avatar.className = "roster-avatar";
  avatar.style.setProperty("--character-color", character.color);
  avatar.textContent = character.initials;
  const copy = document.createElement("span");
  const name = document.createElement("strong");
  name.textContent = character.name;
  const title = document.createElement("small");
  title.textContent = character.title;
  copy.append(name, title);
  characterBlock.append(avatar, copy);
  const model = document.createElement("select");
  model.className = "seat-model";
  model.setAttribute("aria-label", `${character.name} model`);
  for (const [value, label] of MODEL_OPTIONS) model.add(new Option(label, value));
  model.value = existing.model ?? "gpt-6-luna";
  const reasoning = document.createElement("select");
  reasoning.className = "seat-reasoning";
  reasoning.setAttribute("aria-label", `${character.name} reasoning effort`);
  for (const effort of REASONING_OPTIONS) reasoning.add(new Option(`Reasoning: ${effort}`, effort));
  reasoning.value = existing.reasoningEffort ?? "low";
  row.append(characterBlock, model, reasoning);
  elements.aiRoster.append(row);
}

function updateSetup() {
  const data = new FormData(elements.setupForm);
  const mode = selectedMode();
  const humanColor = data.get("humanColor") === "white" ? "white" : "black";
  const existing = [...elements.aiRoster.querySelectorAll(".ai-roster-row")].map((row) => ({ model: row.querySelector(".seat-model").value, reasoningEffort: row.querySelector(".seat-reasoning").value }));
  elements.humanNameField.classList.toggle("hidden", mode === "arena");
  elements.humanColorField.classList.toggle("hidden", mode === "arena");
  elements.setupSubmit.textContent = mode === "arena" ? "Start AI Arena" : `Begin as ${humanColor[0].toUpperCase()}${humanColor.slice(1)}`;
  elements.setupLede.textContent = mode === "arena" ? "Two public characters, two independently selected OpenAI models, one authoritative board." : "Play under Chinese area scoring with authoritative captures and positional superko.";
  elements.aiRoster.replaceChildren();
  const roster = mode === "arena" ? CHARACTERS : [humanColor === "black" ? CHARACTERS[1] : CHARACTERS[0]];
  roster.forEach((character, index) => addRosterRow(character, existing[index]));
}

elements.goBoard.addEventListener("click", (event) => {
  const intersection = event.target.closest(".intersection");
  if (!intersection || !state?.humanCanAct) return;
  performAction("place", Number(intersection.dataset.row), Number(intersection.dataset.column));
});
elements.passButton.addEventListener("click", () => performAction("pass"));
elements.resignButton.addEventListener("click", () => performAction("resign"));
elements.saveButton.addEventListener("click", async () => {
  try {
    state = await request("/api/go/save", { method: "POST", body: "{}" });
    render();
    showToast(`Game saved at ${new Date(state.save.savedAt).toLocaleTimeString()}.`, "success");
  } catch (error) {
    showToast(error.message);
  }
});
elements.modeOptions.addEventListener("change", updateSetup);
elements.setupForm.querySelector('[name="humanColor"]').addEventListener("change", updateSetup);
elements.applyRoster.addEventListener("click", () => {
  const first = elements.aiRoster.querySelector(".ai-roster-row");
  if (!first) return;
  for (const row of elements.aiRoster.querySelectorAll(".ai-roster-row")) {
    row.querySelector(".seat-model").value = first.querySelector(".seat-model").value;
    row.querySelector(".seat-reasoning").value = first.querySelector(".seat-reasoning").value;
  }
});
elements.setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(elements.setupForm);
  const payload = {
    gameMode: selectedMode(),
    humanName: data.get("humanName"),
    humanColor: data.get("humanColor"),
    boardSize: Number(data.get("boardSize")),
    komi: Number(data.get("komi")),
    aiPlayers: [...elements.aiRoster.querySelectorAll(".ai-roster-row")].map((row) => ({ model: row.querySelector(".seat-model").value, reasoningEffort: row.querySelector(".seat-reasoning").value })),
  };
  elements.setupSubmit.disabled = true;
  elements.setupSubmit.textContent = "Opening the board…";
  try {
    state = await request("/api/go/game", { method: "POST", body: JSON.stringify(payload) });
    elements.setupModal.classList.add("hidden");
    elements.cancelSetup.classList.remove("hidden");
    liveSummary = "";
    boardSignature = "";
    render();
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.setupSubmit.disabled = false;
    updateSetup();
  }
});

async function openSetup() {
  if (state?.gameMode === "arena" && !state.arena.paused && state.phase === "active") {
    try { state = await request("/api/go/arena/pause", { method: "POST", body: "{}" }); render(); } catch (error) { showToast(error.message); }
  }
  elements.setupModal.classList.remove("hidden");
}

elements.newGameButton.addEventListener("click", openSetup);
elements.cancelSetup.addEventListener("click", () => elements.setupModal.classList.add("hidden"));
elements.arenaToggle.addEventListener("click", async () => {
  try {
    const path = state.arena.paused ? "/api/go/arena/resume" : "/api/go/arena/pause";
    state = await request(path, { method: "POST", body: "{}" });
    render();
  } catch (error) { showToast(error.message); }
});
elements.overlayAction.addEventListener("click", async () => {
  if (elements.overlayAction.dataset.action === "new") return openSetup();
  try {
    state = await request("/api/go/retry-ai", { method: "POST", body: "{}" });
    render();
  } catch (error) { showToast(error.message); }
});

setInterval(() => {
  if (state?.aiThinking) {
    const seconds = Math.max(0, Math.round((Date.now() - state.aiThinking.startedAt) / 1000));
    elements.reasoningStatus.textContent = `${state.aiThinking.status ?? "Reasoning"} (${seconds}s)`;
  }
}, 1000);

const events = new EventSource("/api/go/events");
events.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "state" && requestInFlight === 0) {
    state = message.payload;
    if (!state.aiThinking) liveSummary = "";
    render();
  } else if (message.type === "ai_stream") {
    if (message.payload.phase === "started") liveSummary = "";
    if (message.payload.phase === "summary_delta") liveSummary += message.payload.delta;
    if (message.payload.phase === "completed") liveSummary = message.payload.summary || liveSummary;
    if (state) renderInsight();
  }
};
events.onerror = () => showToast("Live Go updates disconnected. Reconnecting…");

async function bootstrap() {
  updateSetup();
  try {
    state = await request("/api/go/state");
    if (state) {
      elements.setupModal.classList.add("hidden");
      elements.cancelSetup.classList.remove("hidden");
      render();
    }
  } catch (error) { showToast(error.message); }
}

bootstrap();
