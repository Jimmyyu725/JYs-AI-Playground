const MODEL_OPTIONS = [
  ["gpt-5.6-sol", "GPT-5.6 Sol"],
  ["gpt-5.6-terra", "GPT-5.6 Terra"],
  ["gpt-5.6-luna", "GPT-5.6 Luna"],
  ["deepseek-v4-pro", "DeepSeek V4 Pro"],
  ["deepseek-v4-flash", "DeepSeek V4 Flash"],
];
const REASONING_OPTIONS = ["none", "low", "medium", "high", "xhigh", "max"];
const CHARACTERS = [
  { name: "Vesper Vale", title: "The Velvet Knife", initials: "VV", color: "#d96f9f" },
  { name: "Rook Mercer", title: "The Enforcer", initials: "RM", color: "#e89a44" },
  { name: "Iris Knox", title: "The Wildcard", initials: "IK", color: "#9f87e8" },
];

const ids = [
  "new-game-button", "model-pill", "reasoning-pill", "hand-number", "turn-label", "turn-detail", "ribbon-mark", "thinking-elapsed",
  "player-slot-0", "player-slot-1", "player-slot-2", "bottom-cards", "last-play", "bid-status",
  "game-overlay", "overlay-eyebrow", "overlay-title", "overlay-copy", "overlay-action",
  "hand-dock", "hand-title", "hand-cards", "selected-count", "bid-actions", "bid-1", "bid-2", "bid-3", "bid-pass",
  "play-actions", "play-button", "pass-button", "hint-label", "arena-toggle",
  "base-score", "bomb-count", "multiplier", "result-label",
  "live-indicator", "thinker-profile", "reasoning-status", "reasoning-text", "reasoning-count", "reasoning-feed",
  "history-list", "setup-modal", "setup-form", "setup-lede", "mode-options", "human-name-field",
  "ai-roster", "apply-roster", "setup-submit", "cancel-setup", "toast",
];
const elements = Object.fromEntries(ids.map((id) => [id.replace(/-([a-z0-9])/g, (_match, letter) => letter.toUpperCase()), document.getElementById(id)]));

let state = null;
let selectedCards = new Set();
let liveSummary = "";
let toastTimer = null;
let actionBusy = false;
let requestInFlight = 0;

function modelLabel(id) {
  return MODEL_OPTIONS.find(([value]) => value === id)?.[1] ?? id;
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 5000);
}

async function request(path, options = {}) {
  requestInFlight += 1;
  try {
    const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers ?? {}) } });
    let payload = null;
    try { payload = await response.json(); } catch { /* empty */ }
    if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
    return payload;
  } finally {
    requestInFlight -= 1;
  }
}

function cardSrc(code) {
  if (code === "SJ" || code === "BJ") return `/cards/${code}.svg`;
  if (code === "BACK") return "/cards/BACK.jpg";
  return `/cards/${code}.png`;
}

function cardElement(code, { small = false, selectable = false, selected = false, back = false } = {}) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = `dd-card${small ? " small" : ""}${selectable ? " selectable" : ""}${selected ? " selected" : ""}${back ? " back" : ""}`;
  const image = document.createElement("img");
  image.src = cardSrc(back ? "BACK" : code);
  image.alt = back ? "Face-down card" : code;
  image.loading = "eager";
  card.append(image);
  return card;
}

function renderPlayerSlot(seat, player) {
  const target = elements[`playerSlot${seat}`];
  target.replaceChildren();
  target.className = `player-slot ${seat === 0 ? "bottom" : seat === 1 ? "top-left" : "top-right"}${state.currentActorSeat === seat && state.phase !== "complete" ? " active" : ""}${player.isLandlord ? " landlord" : ""}`;
  target.style.setProperty("--player-color", player.character?.color ?? "#d7b66a");

  const avatar = document.createElement("span");
  avatar.className = "slot-avatar";
  avatar.textContent = player.isHuman ? "YOU" : player.character.initials;
  const copy = document.createElement("div");
  copy.className = "slot-copy";
  const name = document.createElement("strong");
  name.textContent = player.name;
  const sub = document.createElement("small");
  sub.textContent = player.isLandlord ? `地主 Landlord · ${player.cardCount} cards` : `农民 Farmer · ${player.cardCount} cards`;
  copy.append(name, sub);

  const action = document.createElement("span");
  action.className = "slot-action";
  action.textContent = player.lastAction || (state.phase === "bidding" ? (player.bid ? `Bid ${player.bid}` : "Waiting") : "Seated");
  target.append(avatar, copy, action);

  if (state.gameMode === "arena" || player.isHuman) {
    const hand = document.createElement("div");
    hand.className = "slot-hand";
    for (const code of player.hand) hand.append(cardElement(code, { small: true }));
    target.append(hand);
  } else if (player.cardCount > 0) {
    const backs = document.createElement("div");
    backs.className = "slot-backs";
    for (let index = 0; index < Math.min(player.cardCount, 12); index += 1) {
      backs.append(cardElement("BACK", { small: true, back: true }));
    }
    target.append(backs);
  }
}

function renderBottomCards() {
  elements.bottomCards.replaceChildren();
  for (let index = 0; index < 3; index += 1) {
    const code = state.bottomCards[index];
    const revealed = state.bottomRevealed;
    elements.bottomCards.append(cardElement(revealed ? code : "BACK", { small: true, back: !revealed }));
  }
}

function renderLastPlay() {
  elements.lastPlay.replaceChildren();
  if (!state.lastPlay) {
    const span = document.createElement("span");
    span.textContent = state.phase === "bidding" ? "Bidding in progress…" : "No play yet";
    elements.lastPlay.append(span);
    return;
  }
  const label = document.createElement("span");
  label.textContent = `${state.players[state.lastPlay.seat].name} · ${state.lastPlay.description}`;
  elements.lastPlay.append(label);
  const cards = document.createElement("div");
  cards.className = "last-play-cards";
  for (const code of state.lastPlay.cards) cards.append(cardElement(code, { small: true }));
  elements.lastPlay.append(cards);
}

function renderHand() {
  elements.handCards.replaceChildren();
  const human = state.players.find((player) => player.isHuman);
  if (!human || human.hand.length === 0) {
    elements.handDock.classList.add("hidden");
    return;
  }
  elements.handDock.classList.remove("hidden");
  elements.handTitle.textContent = `${human.isLandlord ? "地主 Landlord — " : ""}Your hand · ${human.hand.length} cards`;
  for (const code of human.hand) {
    const card = cardElement(code, { selectable: true, selected: selectedCards.has(code) });
    card.addEventListener("click", () => {
      if (!state.humanCanAct || state.phase !== "playing" || actionBusy) return;
      if (selectedCards.has(code)) selectedCards.delete(code);
      else selectedCards.add(code);
      renderHand();
      renderControls();
    });
    elements.handCards.append(card);
  }
  elements.selectedCount.classList.toggle("hidden", selectedCards.size === 0);
  elements.selectedCount.textContent = `${selectedCards.size} selected`;
}

function renderControls() {
  const human = state.players.find((player) => player.isHuman);
  const bidding = state.phase === "bidding";
  const playing = state.phase === "playing";
  const canAct = Boolean(state.humanCanAct) && !actionBusy;
  elements.bidActions.classList.toggle("hidden", !bidding);
  elements.playActions.classList.toggle("hidden", !playing);
  elements.arenaToggle.classList.toggle("hidden", state.gameMode !== "arena" || state.phase === "complete");
  if (state.arena) elements.arenaToggle.textContent = state.arena.paused ? "Resume arena" : "Pause arena";

  if (bidding) {
    for (const score of [1, 2, 3]) {
      const button = elements[`bid${score}`];
      button.disabled = !canAct || score <= state.highestBid;
    }
    elements.bidPass.disabled = !canAct;
    elements.hintLabel.textContent = state.aiError
      ? "Model request paused — retry to continue."
      : canAct && state.currentActorSeat === human.seat
        ? "Your bid: pass, or beat the current bid (3 wins immediately)."
        : state.aiThinking
          ? `${state.aiThinking.playerName} is considering a bid…`
          : "Bidding is open.";
  } else if (playing) {
    const isHumanTurn = canAct && state.currentActorSeat === human?.seat;
    const leading = state.leaderSeat === human?.seat || !state.lastPlay;
    elements.playButton.disabled = !isHumanTurn || selectedCards.size === 0;
    elements.passButton.disabled = !isHumanTurn || leading;
    elements.hintLabel.textContent = state.aiError
      ? "Model request paused — retry to continue."
      : isHumanTurn
        ? leading ? "You lead — play any legal combo." : "Beat the last play, or pass."
        : state.aiThinking
          ? `${state.aiThinking.playerName} is choosing cards…`
          : "Waiting for the next player.";
  } else {
    elements.hintLabel.textContent = state.aiError ? "Model request paused — retry to continue." : "The hand is settled.";
  }
}

function renderScoreDock() {
  elements.baseScore.textContent = state.phase === "bidding" && !state.landlordSeat ? `${state.highestBid || "—"}` : String(state.highestBid);
  elements.bombCount.textContent = String(state.bombsPlayed ?? 0);
  elements.multiplier.textContent = String(state.multiplier ?? 1);
  elements.resultLabel.textContent = state.result
    ? state.result.winner === "landlord"
      ? `地主胜 × ${state.result.score}`
      : `农民胜 × ${state.result.score}`
    : "—";
}

function renderBidStatus() {
  if (state.phase === "bidding") {
    elements.bidStatus.textContent = state.highestBidderSeat !== null
      ? `最高叫分 ${state.highestBid} · ${state.players[state.highestBidderSeat].name}`
      : "无人叫分 · 三家不叫则重发";
  } else {
    elements.bidStatus.textContent = `地主 ${state.players[state.landlordSeat].name} · 叫 ${state.highestBid} 分`;
  }
}

function renderOverlay() {
  elements.gameOverlay.classList.add("hidden");
  if (state.aiError) {
    elements.overlayEyebrow.textContent = "Model request paused";
    elements.overlayTitle.textContent = `${state.aiError.playerName} needs a retry`;
    elements.overlayCopy.textContent = state.aiError.message;
    elements.overlayAction.textContent = "Retry model";
    elements.overlayAction.dataset.action = "retry";
    elements.gameOverlay.classList.remove("hidden");
  } else if (state.phase === "complete") {
    const result = state.result;
    elements.overlayEyebrow.textContent = "Hand complete";
    elements.overlayTitle.textContent = result.winner === "landlord" ? "The landlord takes it" : "The farmers take it";
    const springText = result.spring === "spring" ? " Spring: the farmers never played a card." : result.spring === "anti_spring" ? " Anti-spring: the landlord managed only one play." : "";
    elements.overlayCopy.textContent = `${state.players[state.landlordSeat].name} was the landlord for ${state.highestBid}. ${state.bombsPlayed} bomb${state.bombsPlayed === 1 ? "" : "s"} doubled the pot.${springText} Total: ${state.highestBid} × ${state.multiplier} = ${result.score}.`;
    elements.overlayAction.textContent = "Deal a new hand";
    elements.overlayAction.dataset.action = "new";
    elements.gameOverlay.classList.remove("hidden");
  }
}

function updateElapsedLabel() {
  if (state?.aiThinking) {
    const seconds = Math.max(0, Math.round((Date.now() - state.aiThinking.startedAt) / 1000));
    elements.thinkingElapsed.textContent = `${seconds}s`;
    elements.thinkingElapsed.classList.remove("hidden");
  } else {
    elements.thinkingElapsed.classList.add("hidden");
  }
}

setInterval(updateElapsedLabel, 1000);

function renderInsight() {
  const actor = state.players.find((player) => player.seat === (state.aiThinking?.seat ?? state.currentActorSeat));
  const thinking = Boolean(state.aiThinking);
  elements.liveIndicator.classList.toggle("active", thinking);
  elements.liveIndicator.innerHTML = `<i></i> ${thinking ? "Live" : "Idle"}`;
  elements.thinkerProfile.replaceChildren();
  const mark = document.createElement("span");
  mark.className = "profile-stone black";
  const copy = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = actor?.name ?? "No active player";
  const meta = document.createElement("span");
  meta.textContent = actor?.isHuman ? "Human player" : `${modelLabel(actor?.aiConfig.model)} · ${actor?.aiConfig.reasoningEffort} reasoning`;
  copy.append(name, meta);
  elements.thinkerProfile.append(mark, copy);
  elements.reasoningStatus.textContent = state.aiThinking?.status ?? "No model request is active.";
  elements.reasoningText.textContent = thinking ? liveSummary || "Waiting for a supported reasoning summary…" : "Completed summaries remain in the transcript below.";

  elements.reasoningCount.textContent = `${state.aiInsights.length} ${state.aiInsights.length === 1 ? "entry" : "entries"}`;
  elements.reasoningFeed.replaceChildren();
  for (const insight of state.aiInsights) {
    const item = document.createElement("li");
    item.className = "reasoning-entry";
    item.style.setProperty("--entry-color", insight.characterColor);
    const heading = document.createElement("div");
    const insightName = document.createElement("strong");
    insightName.textContent = insight.playerName;
    const info = document.createElement("span");
    info.textContent = `Hand ${insight.handNumber} · ${insight.model?.replace("gpt-5.6-", "")} · ${(insight.latencyMs / 1000).toFixed(1)}s · ${insight.action}`;
    heading.append(insightName, info);
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
  elements.handNumber.textContent = state.handNumber;
  elements.modelPill.innerHTML = `<i></i> ${state.model === "mixed" ? "Mixed models" : modelLabel(state.model)}`;
  elements.reasoningPill.textContent = `Reasoning · ${state.reasoningEffort}`;
  const phaseText = { bidding: "叫地主 Bidding", playing: "出牌 Playing", complete: "牌局结束 Hand complete" }[state.phase] ?? state.phase;
  elements.turnLabel.textContent = state.phase === "complete" ? "Hand complete" : phaseText;
  const actor = state.players.find((player) => player.seat === state.currentActorSeat);
  elements.turnDetail.textContent = state.phase === "bidding"
    ? `${actor?.name ?? "…"} to bid`
    : state.phase === "playing"
      ? `${actor?.name ?? "…"} ${actor?.seat === state.leaderSeat || !state.lastPlay ? "leads" : "to follow"}`
      : "The hand is settled";
  elements.ribbonMark.textContent = state.phase === "bidding" ? "叫" : state.phase === "playing" ? "出" : "胜";
  renderBidStatus();
  renderBottomCards();
  renderLastPlay();
  state.players.forEach((player) => renderPlayerSlot(player.seat, player));
  renderHand();
  renderControls();
  renderScoreDock();
  renderOverlay();
  renderInsight();
  renderHistory();
}

async function performBid(score) {
  if (actionBusy) return;
  actionBusy = true;
  renderControls();
  try {
    state = await request("/api/doudizhu/bid", { method: "POST", body: JSON.stringify({ score }) });
    liveSummary = "";
    selectedCards.clear();
    render();
  } catch (error) {
    showToast(error.message);
  } finally {
    actionBusy = false;
    renderControls();
  }
}

async function performPlay(action, cards = null) {
  if (actionBusy) return;
  actionBusy = true;
  renderControls();
  try {
    state = await request("/api/doudizhu/action", { method: "POST", body: JSON.stringify({ action, cards }) });
    liveSummary = "";
    selectedCards.clear();
    render();
  } catch (error) {
    showToast(error.message);
  } finally {
    actionBusy = false;
    renderControls();
  }
}

function selectedMode() {
  return new FormData(elements.setupForm).get("gameMode") === "arena" ? "arena" : "human";
}

function addRosterRow(character, existing = {}) {
  const row = document.createElement("div");
  row.className = "ai-roster-row";
  const block = document.createElement("div");
  block.className = "roster-character";
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
  block.append(avatar, copy);
  const model = document.createElement("select");
  model.className = "seat-model";
  model.setAttribute("aria-label", `${character.name} model`);
  for (const [value, label] of MODEL_OPTIONS) model.add(new Option(label, value));
  model.value = existing.model ?? "gpt-5.6-luna";
  const reasoning = document.createElement("select");
  reasoning.className = "seat-reasoning";
  reasoning.setAttribute("aria-label", `${character.name} reasoning effort`);
  for (const effort of REASONING_OPTIONS) reasoning.add(new Option(`Reasoning: ${effort}`, effort));
  reasoning.value = existing.reasoningEffort ?? "low";
  row.append(block, model, reasoning);
  elements.aiRoster.append(row);
}

function updateSetup() {
  const mode = selectedMode();
  const existing = [...elements.aiRoster.querySelectorAll(".ai-roster-row")].map((row) => ({
    model: row.querySelector(".seat-model").value,
    reasoningEffort: row.querySelector(".seat-reasoning").value,
  }));
  elements.humanNameField.classList.toggle("hidden", mode === "arena");
  elements.setupSubmit.textContent = mode === "arena" ? "Deal for three AI" : "Deal the cards";
  elements.setupLede.textContent = mode === "arena"
    ? "Three public characters, three independently selected models, one authoritative deck."
    : "One landlord against two farmers. Bombs and the rocket double the score.";
  elements.aiRoster.replaceChildren();
  const roster = mode === "arena" ? CHARACTERS : CHARACTERS.slice(1);
  roster.forEach((character, index) => addRosterRow(character, existing[index]));
}

elements.bid1.addEventListener("click", () => performBid(1));
elements.bid2.addEventListener("click", () => performBid(2));
elements.bid3.addEventListener("click", () => performBid(3));
elements.bidPass.addEventListener("click", () => performBid(0));
elements.playButton.addEventListener("click", () => performPlay("play", [...selectedCards]));
elements.passButton.addEventListener("click", () => performPlay("pass"));
elements.modeOptions.addEventListener("change", updateSetup);
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
    aiPlayers: [...elements.aiRoster.querySelectorAll(".ai-roster-row")].map((row) => ({
      model: row.querySelector(".seat-model").value,
      reasoningEffort: row.querySelector(".seat-reasoning").value,
    })),
  };
  elements.setupSubmit.disabled = true;
  elements.setupSubmit.textContent = "Dealing…";
  try {
    state = await request("/api/doudizhu/game", { method: "POST", body: JSON.stringify(payload) });
    elements.setupModal.classList.add("hidden");
    elements.cancelSetup.classList.remove("hidden");
    liveSummary = "";
    selectedCards.clear();
    render();
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.setupSubmit.disabled = false;
    updateSetup();
  }
});

async function openSetup() {
  if (state?.gameMode === "arena" && !state.arena.paused && state.phase !== "complete") {
    try {
      state = await request("/api/doudizhu/arena/pause", { method: "POST", body: "{}" });
      render();
    } catch (error) { showToast(error.message); }
  }
  elements.setupModal.classList.remove("hidden");
}

elements.newGameButton.addEventListener("click", openSetup);
elements.cancelSetup.addEventListener("click", () => elements.setupModal.classList.add("hidden"));
elements.arenaToggle.addEventListener("click", async () => {
  try {
    const path = state.arena.paused ? "/api/doudizhu/arena/resume" : "/api/doudizhu/arena/pause";
    state = await request(path, { method: "POST", body: "{}" });
    render();
  } catch (error) { showToast(error.message); }
});
elements.overlayAction.addEventListener("click", async () => {
  if (elements.overlayAction.dataset.action === "new") return openSetup();
  try {
    state = await request("/api/doudizhu/retry-ai", { method: "POST", body: "{}" });
    render();
  } catch (error) { showToast(error.message); }
});

const events = new EventSource("/api/doudizhu/events");
events.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "state" && requestInFlight === 0) {
    state = message.payload;
    if (!state.aiThinking) liveSummary = "";
    if (state.phase === "playing" || state.phase === "complete") {
      selectedCards = new Set([...selectedCards].filter((code) => state.players.find((player) => player.isHuman)?.hand.includes(code)));
    }
    render();
  } else if (message.type === "ai_stream") {
    if (message.payload.phase === "started") liveSummary = "";
    if (message.payload.phase === "summary_delta") liveSummary += message.payload.delta;
    if (message.payload.phase === "completed") liveSummary = message.payload.summary || liveSummary;
    if (state) renderInsight();
  }
};
events.onerror = () => showToast("Live Dou Dizhu updates disconnected. Reconnecting…");

async function bootstrap() {
  updateSetup();
  try {
    state = await request("/api/doudizhu/state");
    if (state) {
      elements.setupModal.classList.add("hidden");
      elements.cancelSetup.classList.remove("hidden");
      render();
    }
  } catch (error) { showToast(error.message); }
}

bootstrap();
