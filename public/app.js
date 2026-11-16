const BOT_PREVIEW = [
  { name: "Vesper Vale", title: "The Velvet Knife", initials: "VV", color: "#d96f9f" },
  { name: "Rook Mercer", title: "The Enforcer", initials: "RM", color: "#e89a44" },
  { name: "Selene Park", title: "The Oracle", initials: "SP", color: "#75c8d8" },
  { name: "Moss Calder", title: "The Anchor", initials: "MC", color: "#79b989" },
  { name: "Iris Knox", title: "The Wildcard", initials: "IK", color: "#9f87e8" },
];

const MODEL_OPTIONS = [
  ["gpt-5.6-sol", "GPT-5.6 Sol"],
  ["gpt-5.6-terra", "GPT-5.6 Terra"],
  ["gpt-5.6-luna", "GPT-5.6 Luna"],
  ["deepseek-v4-pro", "DeepSeek V4 Pro"],
  ["deepseek-v4-flash", "DeepSeek V4 Flash"],
];
const REASONING_OPTIONS = ["none", "low", "medium", "high", "xhigh", "max"];
const SUMMARY_SOURCE_LABELS = {
  openai_reasoning_summary: "OpenAI reasoning summary",
  deepseek_reasoning_content: "DeepSeek raw reasoning",
  public_decision_rationale: "public rationale",
};

const elements = Object.fromEntries(
  [
    "hand-number", "blind-label", "phase-label", "turn-label", "pot-value", "community-cards", "seat-layer",
    "table-overlay", "overlay-eyebrow", "overlay-title", "overlay-copy", "overlay-action", "action-context-title",
    "action-context-eyebrow", "action-context-copy", "action-dock", "primary-actions", "raise-console", "fold-button", "check-call-button", "check-call-label", "all-in-button", "raise-kind",
    "raise-value", "raise-slider", "raise-min", "raise-max", "raise-button", "live-indicator", "thinker-profile",
    "reasoning-status", "reasoning-text", "thinking-cursor", "reasoning-count", "reasoning-feed", "decision-explanation", "history-list", "scroll-latest",
    "arena-controls", "arena-progress", "arena-track-fill", "arena-toggle", "arena-new-table", "setup-modal", "setup-form",
    "setup-lede", "mode-options", "human-name-field", "player-count-legend", "opponent-options", "setup-grid",
    "arena-target-field", "arena-hand-target", "setup-submit", "character-preview", "ai-roster", "apply-roster", "table-model", "table-reasoning", "cancel-setup", "new-table-button", "toast",
  ].map((id) => [id.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase()), document.getElementById(id)]),
);

let state = null;
let selectedSeat = null;
let actionBusy = false;
let liveSummary = "";
let liveSeat = null;
let toastTimer = null;
let raiseTurnKey = "";
let renderedInsightIds = "";
let requestInFlight = 0;

function chips(value) {
  return Number(value ?? 0).toLocaleString("en-US");
}

function plainSummary(value) {
  return String(value ?? "").replace(/\*\*/g, "").replace(/^#{1,6}\s+/gm, "").trim();
}

function phaseName(phase) {
  return {
    waiting: "Waiting",
    preflop: "Pre-flop",
    flop: "Flop",
    turn: "Turn",
    river: "River",
    showdown: "Showdown",
    hand_over: "Hand complete",
    game_over: "Table complete",
  }[phase] ?? phase;
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 4500);
}

async function request(path, options = {}) {
  requestInFlight += 1;
  try {
    const response = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* empty response */ }
    if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
    return payload;
  } finally {
    requestInFlight -= 1;
  }
}

function cardElement(code, placeholder = false) {
  const card = document.createElement("div");
  card.className = `playing-card${placeholder ? " placeholder" : ""}`;
  if (!placeholder) {
    const image = document.createElement("img");
    image.src = code === "BACK" ? "/cards/BACK.jpg" : `/cards/${code}.png`;
    image.alt = code === "BACK" ? "Face-down card" : code;
    image.loading = "eager";
    card.append(image);
  }
  return card;
}

function renderBoard() {
  elements.communityCards.replaceChildren();
  for (let index = 0; index < 5; index += 1) {
    const code = state.communityCards[index];
    elements.communityCards.append(cardElement(code, !code));
  }
}

function seatPositions(count) {
  const maps = {
    2: [[50, 91], [50, 7]],
    3: [[50, 91], [12, 24], [88, 24]],
    4: [[50, 91], [8, 54], [50, 7], [92, 54]],
    5: [[50, 91], [9, 64], [24, 8], [76, 8], [91, 64]],
    6: [[50, 91], [8, 68], [15, 18], [50, 6], [85, 18], [92, 68]],
  };
  return maps[count] ?? maps[4];
}

function renderSeats() {
  elements.seatLayer.replaceChildren();
  const positions = seatPositions(state.players.length);
  for (const player of state.players) {
    const character = player.character;
    const seat = document.createElement("article");
    seat.className = [
      "player-seat",
      state.currentActorSeat === player.seat ? "active" : "",
      player.folded ? "folded" : "",
      player.stack <= 0 ? "busted" : "",
      selectedSeat === player.seat ? "selected" : "",
    ].filter(Boolean).join(" ");
    seat.style.setProperty("--seat-x", `${positions[player.seat][0]}%`);
    seat.style.setProperty("--seat-y", `${positions[player.seat][1]}%`);
    seat.style.setProperty("--seat-color", character?.color ?? "#d7b66a");
    seat.dataset.seat = player.seat;
    seat.tabIndex = 0;

    const cards = document.createElement("div");
    cards.className = "seat-cards";
    for (const code of player.holeCards) cards.append(cardElement(code));

    const panel = document.createElement("div");
    panel.className = "seat-panel";
    const avatar = document.createElement("div");
    avatar.className = "seat-avatar";
    avatar.textContent = player.isHuman ? "YOU" : character.initials;

    const copy = document.createElement("div");
    copy.className = "seat-copy";
    const name = document.createElement("strong");
    name.textContent = player.name;
    const title = document.createElement("small");
    title.textContent = player.isHuman ? "House guest" : character.title;
    const stack = document.createElement("span");
    stack.className = "seat-stack";
    stack.textContent = chips(player.stack);
    copy.append(name, title, stack);

    const action = document.createElement("span");
    action.className = "seat-action";
    action.textContent = player.stack <= 0 ? "Out" : player.folded ? "Folded" : player.lastAction || "Seated";
    panel.append(avatar, copy, action);

    const markers = document.createElement("div");
    markers.className = "seat-markers";
    for (const [markerSeat, label] of [[state.dealerSeat, "D"], [state.smallBlindSeat, "SB"], [state.bigBlindSeat, "BB"]]) {
      if (markerSeat === player.seat) {
        const marker = document.createElement("span");
        marker.className = "seat-marker";
        marker.textContent = label;
        markers.append(marker);
      }
    }

    seat.append(cards, panel, markers);
    if (player.streetBet > 0) {
      const wager = document.createElement("span");
      wager.className = "seat-wager";
      wager.textContent = chips(player.streetBet);
      seat.append(wager);
    }

    const select = () => {
      selectedSeat = player.seat;
      liveSeat = null;
      renderSeats();
      renderInsight();
    };
    seat.addEventListener("click", select);
    seat.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") select();
    });
    elements.seatLayer.append(seat);
  }
}

function renderControls() {
  const isArena = state.gameMode === "arena";
  elements.actionDock.classList.toggle("arena-mode", isArena);
  elements.primaryActions.classList.toggle("hidden", isArena);
  elements.raiseConsole.classList.toggle("hidden", isArena);
  elements.arenaControls.classList.toggle("hidden", !isArena);
  elements.actionContextEyebrow.textContent = isArena ? "AI Arena director" : "Your decision";

  if (isArena) {
    elements.foldButton.disabled = true;
    elements.checkCallButton.disabled = true;
    elements.allInButton.disabled = true;
    elements.raiseSlider.disabled = true;
    elements.raiseButton.disabled = true;
    const target = state.arena.handTarget;
    const completed = state.arena.handsPlayed;
    elements.arenaProgress.textContent = target === null
      ? `${completed} hand${completed === 1 ? "" : "s"} · unlimited`
      : `${completed} / ${target} hands`;
    elements.arenaTrackFill.style.width = target === null ? "100%" : `${Math.min(100, (completed / target) * 100)}%`;
    elements.arenaToggle.textContent = state.arena.paused ? "Resume arena" : "Pause arena";
    elements.arenaToggle.disabled = state.arena.finished;

    if (state.aiError) {
      elements.actionContextTitle.textContent = "Model request paused";
      elements.actionContextCopy.textContent = "Retry the selected model to continue. No local action will be substituted.";
    } else if (state.arena.finished) {
      elements.actionContextTitle.textContent = "Arena session complete";
      elements.actionContextCopy.textContent = `${completed} hand${completed === 1 ? "" : "s"} played with every decision made by the selected OpenAI models.`;
    } else if (state.arena.paused) {
      elements.actionContextTitle.textContent = state.aiThinking ? "Pausing after this decision" : "Arena paused";
      elements.actionContextCopy.textContent = "Resume when you are ready for the next model decision.";
    } else if (state.aiThinking) {
      elements.actionContextTitle.textContent = `${state.aiThinking.playerName} is considering the room`;
      elements.actionContextCopy.textContent = state.model === "mixed"
        ? "The AI seats are using individual GPT-5.6 model configurations."
        : `Every AI seat uses ${state.model} with ${state.reasoningEffort} reasoning.`;
    } else {
      elements.actionContextTitle.textContent = state.phase === "hand_over" ? "Preparing the next hand" : "AI Arena is live";
      elements.actionContextCopy.textContent = "All hole cards are visible to you; each AI sees only its own cards.";
    }
    return;
  }

  const legal = state.legalActions;
  const active = Boolean(legal) && !actionBusy && !state.aiError;
  const has = (action) => active && legal.actions.includes(action);
  elements.foldButton.disabled = !has("fold");
  elements.checkCallButton.disabled = !(has("check") || has("call"));
  elements.allInButton.disabled = !has("all_in");
  elements.checkCallLabel.textContent = has("call") ? `Call ${chips(legal.callAmount)}` : "Check";

  const aggressive = active && legal.aggressiveAction;
  const turnKey = `${state.handNumber}-${state.phase}-${state.currentActorSeat}-${state.currentBet}`;
  if (aggressive && raiseTurnKey !== turnKey) {
    elements.raiseSlider.min = legal.minimumTotal;
    elements.raiseSlider.max = legal.maximumTotal;
    elements.raiseSlider.value = Math.min(legal.maximumTotal, Math.max(legal.minimumTotal, state.pot + legal.toCall));
    raiseTurnKey = turnKey;
  }
  elements.raiseSlider.disabled = !aggressive;
  elements.raiseButton.disabled = !aggressive;
  elements.raiseKind.textContent = legal?.aggressiveAction === "bet" ? "Bet to" : "Raise to";
  elements.raiseValue.textContent = aggressive ? chips(elements.raiseSlider.value) : "—";
  elements.raiseMin.textContent = aggressive ? `Min ${chips(legal.minimumTotal)}` : "Min —";
  elements.raiseMax.textContent = aggressive ? `Max ${chips(legal.maximumTotal)}` : "Max —";
  elements.raiseButton.textContent = legal?.aggressiveAction === "bet" ? "Place bet" : "Set chips";

  if (legal) {
    elements.actionContextTitle.textContent = legal.toCall > 0 ? `${chips(legal.toCall)} to continue` : "The action is on you";
    elements.actionContextCopy.textContent = legal.toCall > 0 ? `Call ${chips(legal.callAmount)}, find a raise, or leave the hand.` : "Check the room or take the betting lead.";
  } else if (state.aiError) {
    elements.actionContextTitle.textContent = "Model request paused";
    elements.actionContextCopy.textContent = "Retry the selected model to continue. No local action will be substituted.";
  } else if (state.aiThinking) {
    elements.actionContextTitle.textContent = `${state.aiThinking.playerName} is considering the room`;
    elements.actionContextCopy.textContent = "There is no artificial decision timer.";
  } else {
    elements.actionContextTitle.textContent = state.phase === "hand_over" ? "The pot is settled" : "Waiting for the action";
    elements.actionContextCopy.textContent = "OpenAI opponents may take as long as needed.";
  }
}

function renderOverlay() {
  elements.tableOverlay.classList.add("hidden");
  if (state.aiError) {
    elements.overlayEyebrow.textContent = "OpenAI turn paused";
    elements.overlayTitle.textContent = `${state.aiError.playerName} needs a retry`;
    elements.overlayCopy.textContent = state.aiError.message;
    elements.overlayAction.textContent = "Retry model";
    elements.overlayAction.dataset.action = "retry";
    elements.tableOverlay.classList.remove("hidden");
  } else if (state.gameMode === "arena" && state.phase === "game_over") {
    elements.overlayEyebrow.textContent = "Arena complete";
    elements.overlayTitle.textContent = "The Luna Room has a champion";
    elements.overlayCopy.textContent = state.logs.find((entry) => entry.kind === "result")?.text ?? "Open a new arena to watch another battle.";
    elements.overlayAction.textContent = "Open new table";
    elements.overlayAction.dataset.action = "new";
    elements.tableOverlay.classList.remove("hidden");
  } else if (state.gameMode === "arena" && state.arena.finished) {
    elements.overlayEyebrow.textContent = "Session target reached";
    elements.overlayTitle.textContent = `${state.arena.handsPlayed} hands complete`;
    elements.overlayCopy.textContent = state.logs.find((entry) => entry.kind === "result")?.text ?? "The AI Arena session is complete.";
    elements.overlayAction.textContent = "Open new table";
    elements.overlayAction.dataset.action = "new";
    elements.tableOverlay.classList.remove("hidden");
  } else if (state.gameMode === "arena" && state.phase === "hand_over" && state.arena.paused) {
    elements.overlayEyebrow.textContent = "Arena paused";
    elements.overlayTitle.textContent = "The pot is settled";
    elements.overlayCopy.textContent = state.logs.find((entry) => entry.kind === "result")?.text ?? "Resume when you are ready for another hand.";
    elements.overlayAction.textContent = "Resume arena";
    elements.overlayAction.dataset.action = "resume";
    elements.tableOverlay.classList.remove("hidden");
  } else if (state.gameMode !== "arena" && state.phase === "hand_over") {
    elements.overlayEyebrow.textContent = "Hand complete";
    elements.overlayTitle.textContent = "The pot is settled";
    const lastResult = state.logs.find((entry) => entry.kind === "result");
    elements.overlayCopy.textContent = lastResult?.text ?? "The room is ready for another hand.";
    elements.overlayAction.textContent = "Deal next hand";
    elements.overlayAction.dataset.action = "next";
    elements.tableOverlay.classList.remove("hidden");
  } else if (state.gameMode !== "arena" && state.phase === "game_over") {
    elements.overlayEyebrow.textContent = "Table complete";
    elements.overlayTitle.textContent = "The Luna Room has a winner";
    elements.overlayCopy.textContent = state.logs.find((entry) => entry.kind === "result")?.text ?? "Open a new table to play again.";
    elements.overlayAction.textContent = "Open new table";
    elements.overlayAction.dataset.action = "new";
    elements.tableOverlay.classList.remove("hidden");
  }
}

function renderInsight() {
  const thinkingPlayer = state.players.find((player) => player.seat === (liveSeat ?? state.aiThinking?.seat));
  const selected = state.players.find((player) => player.seat === selectedSeat);
  const player = thinkingPlayer ?? selected ?? state.players.find((candidate) => !candidate.isHuman) ?? state.players[0];
  const character = player.character;
  elements.thinkerProfile.replaceChildren();
  const avatar = document.createElement("div");
  avatar.className = "profile-avatar";
  avatar.style.borderColor = character?.color ?? "#d7b66a";
  avatar.textContent = player.isHuman ? "YOU" : character.initials;
  const copy = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = player.name;
  const title = document.createElement("span");
  title.textContent = player.isHuman ? "House guest" : `${character.title} · ${player.aiConfig.model} · ${player.aiConfig.reasoningEffort}`;
  copy.append(name, title);
  elements.thinkerProfile.append(avatar, copy);

  const isThinking = state.aiThinking?.seat === player.seat;
  elements.liveIndicator.classList.toggle("active", isThinking);
  elements.liveIndicator.innerHTML = `<i></i> ${isThinking ? "Live" : "Idle"}`;
  elements.thinkingCursor.classList.toggle("hidden", !isThinking);
  if (isThinking) {
    elements.reasoningStatus.textContent = state.aiThinking.status || "The selected model is reasoning…";
    elements.reasoningText.textContent = liveSummary || "Waiting for the API-provided reasoning summary…";
  } else {
    elements.reasoningStatus.textContent = "No model request is active.";
    elements.reasoningText.textContent = (state.aiInsights?.length ?? 0) > 0
      ? "Completed summaries stay in the decision log below. Select a player to review their latest table note."
      : player.isHuman ? "Your decisions stay yours." : "Completed model summaries will remain in the decision log below.";
  }
  elements.decisionExplanation.textContent = player.lastExplanation || "A concise player-facing explanation will appear after the decision.";
  renderReasoningFeed();
}

function renderReasoningFeed() {
  const insights = state.aiInsights ?? [];
  elements.reasoningCount.textContent = `${insights.length} ${insights.length === 1 ? "entry" : "entries"}`;
  const insightIds = insights.map((insight) => insight.id).join("|");
  if (insightIds === renderedInsightIds) return;
  renderedInsightIds = insightIds;
  elements.reasoningFeed.replaceChildren();
  for (const insight of insights) {
    const item = document.createElement("li");
    item.className = "reasoning-entry";
    item.style.setProperty("--entry-color", insight.characterColor);

    const heading = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = insight.playerName;
    const meta = document.createElement("span");
    const action = insight.action ? ` · ${insight.action.replace("_", " ")}` : "";
    const source = SUMMARY_SOURCE_LABELS[insight.summarySource] ?? "";
    meta.textContent = `Hand ${insight.handNumber} · ${phaseName(insight.phase)}${action} · ${(insight.latencyMs / 1000).toFixed(1)}s${source ? ` · ${source}` : ""}`;
    heading.append(name, meta);

    const summary = document.createElement("p");
    summary.textContent = plainSummary(insight.summary || insight.explanation) || "Decision completed without a visible summary.";
    item.append(heading, summary);
    elements.reasoningFeed.append(item);
  }
}

function renderHistory() {
  const entries = state.logs.slice(0, 38);
  elements.historyList.replaceChildren();
  entries.forEach((entry, index) => {
    const item = document.createElement("li");
    item.className = `history-entry ${entry.kind}`;
    const number = document.createElement("span");
    number.className = "history-index";
    number.textContent = String(entries.length - index).padStart(2, "0");
    const text = document.createElement("span");
    text.textContent = entry.text;
    item.append(number, text);
    elements.historyList.append(item);
  });
}

function render() {
  if (!state) return;
  if (selectedSeat === null) selectedSeat = state.players.find((player) => !player.isHuman)?.seat ?? 0;
  elements.handNumber.textContent = state.handNumber;
  elements.blindLabel.textContent = `${chips(state.smallBlind)} / ${chips(state.bigBlind)}`;
  elements.phaseLabel.textContent = phaseName(state.phase);
  elements.potValue.textContent = chips(state.pot);
  elements.tableModel.innerHTML = `<i></i> ${state.model === "mixed" ? "Mixed GPT-5.6" : MODEL_OPTIONS.find(([id]) => id === state.model)?.[1] ?? state.model}`;
  elements.tableReasoning.textContent = `Reasoning · ${state.reasoningEffort}`;
  const actor = state.players.find((player) => player.seat === state.currentActorSeat);
  elements.turnLabel.textContent = state.gameMode === "arena" && state.arena.paused
    ? state.aiThinking ? "Pausing after the current decision" : "Arena paused"
    : actor ? `${actor.name} to act` : state.phase === "hand_over" ? "Pot settled" : "Dealer resolving the hand";
  renderBoard();
  renderSeats();
  renderControls();
  renderOverlay();
  renderInsight();
  renderHistory();
}

async function performAction(action, targetTotal = null) {
  if (actionBusy) return;
  actionBusy = true;
  renderControls();
  try {
    state = await request("/api/action", { method: "POST", body: JSON.stringify({ action, targetTotal }) });
    liveSummary = "";
    liveSeat = state.aiThinking?.seat ?? null;
    render();
  } catch (error) {
    showToast(error.message);
  } finally {
    actionBusy = false;
    renderControls();
  }
}

function updateCharacterPreview() {
  const count = Number(new FormData(elements.setupForm).get("opponentCount") ?? 3);
  const existing = [...elements.aiRoster.querySelectorAll(".ai-roster-row")].map((row) => ({
    model: row.querySelector(".seat-model")?.value,
    reasoningEffort: row.querySelector(".seat-reasoning")?.value,
  }));
  elements.aiRoster.replaceChildren();
  elements.characterPreview.replaceChildren();
  BOT_PREVIEW.slice(0, count).forEach((character, index) => {
    const row = document.createElement("div");
    row.className = "ai-roster-row";
    row.dataset.aiIndex = String(index);
    const characterBlock = document.createElement("div");
    characterBlock.className = "roster-character";
    const rosterAvatar = document.createElement("span");
    rosterAvatar.className = "roster-avatar";
    rosterAvatar.style.setProperty("--character-color", character.color);
    rosterAvatar.textContent = character.initials;
    const characterCopy = document.createElement("span");
    const characterName = document.createElement("strong");
    characterName.textContent = character.name;
    const characterTitle = document.createElement("small");
    characterTitle.textContent = character.title;
    characterCopy.append(characterName, characterTitle);
    characterBlock.append(rosterAvatar, characterCopy);

    const model = document.createElement("select");
    model.className = "seat-model";
    model.setAttribute("aria-label", `${character.name} model`);
    for (const [value, label] of MODEL_OPTIONS) model.add(new Option(label, value));
    model.value = existing[index]?.model ?? "gpt-5.6-luna";
    const reasoning = document.createElement("select");
    reasoning.className = "seat-reasoning";
    reasoning.setAttribute("aria-label", `${character.name} reasoning effort`);
    for (const effort of REASONING_OPTIONS) reasoning.add(new Option(`Reasoning: ${effort}`, effort));
    reasoning.value = existing[index]?.reasoningEffort ?? "medium";
    row.append(characterBlock, model, reasoning);
    elements.aiRoster.append(row);

    const avatar = document.createElement("span");
    avatar.className = "preview-character";
    avatar.style.setProperty("--character-color", character.color);
    avatar.textContent = character.initials;
    elements.characterPreview.append(avatar);
  });
}

function selectedSetupMode() {
  return new FormData(elements.setupForm).get("gameMode") === "arena" ? "arena" : "human";
}

function updateSetupMode() {
  const isArena = selectedSetupMode() === "arena";
  elements.humanNameField.classList.toggle("hidden", isArena);
  elements.arenaTargetField.classList.toggle("hidden", !isArena);
  elements.setupGrid.classList.toggle("arena-configured", isArena);
  elements.playerCountLegend.textContent = isArena ? "Choose AI seats" : "Choose your opponents";
  elements.setupLede.textContent = isArena
    ? "An all-OpenAI table. See every card, follow every decision, and pause the action whenever you like."
    : "One human. Distinct characters. Choose the GPT-5.6 model behind every opponent.";
  elements.setupSubmit.textContent = isArena ? "Start AI Arena" : "Take your seat";
  for (const label of elements.opponentOptions.querySelectorAll("small")) {
    label.textContent = isArena ? label.dataset.arena : label.dataset.human;
  }
  updateCharacterPreview();
}

elements.setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(elements.setupForm);
  const gameMode = data.get("gameMode") === "arena" ? "arena" : "human";
  const [smallBlind, bigBlind] = String(data.get("blinds")).split(",").map(Number);
  const targetValue = data.get("arenaHandTarget");
  const payload = {
    gameMode,
    humanName: data.get("humanName"),
    opponentCount: Number(data.get("opponentCount")),
    startingStack: Number(data.get("startingStack")),
    smallBlind,
    bigBlind,
    arenaHandTarget: targetValue === "unlimited" ? null : Number(targetValue),
    aiPlayers: [...elements.aiRoster.querySelectorAll(".ai-roster-row")].map((row) => ({
      model: row.querySelector(".seat-model").value,
      reasoningEffort: row.querySelector(".seat-reasoning").value,
    })),
  };
  const submit = elements.setupForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = "Opening the room…";
  try {
    state = await request("/api/game", { method: "POST", body: JSON.stringify(payload) });
    selectedSeat = state.players.find((player) => !player.isHuman)?.seat ?? 0;
    liveSummary = "";
    liveSeat = null;
    elements.setupModal.classList.add("hidden");
    elements.cancelSetup.classList.remove("hidden");
    render();
  } catch (error) {
    showToast(error.message);
  } finally {
    submit.disabled = false;
    submit.textContent = selectedSetupMode() === "arena" ? "Start AI Arena" : "Take your seat";
  }
});

elements.opponentOptions.addEventListener("change", updateCharacterPreview);
elements.modeOptions.addEventListener("change", updateSetupMode);
elements.applyRoster.addEventListener("click", () => {
  const first = elements.aiRoster.querySelector(".ai-roster-row");
  if (!first) return;
  const model = first.querySelector(".seat-model").value;
  const reasoning = first.querySelector(".seat-reasoning").value;
  for (const row of elements.aiRoster.querySelectorAll(".ai-roster-row")) {
    row.querySelector(".seat-model").value = model;
    row.querySelector(".seat-reasoning").value = reasoning;
  }
});

async function openSetup() {
  try {
    if (state?.gameMode === "arena" && !state.arena.paused && !state.arena.finished) {
      state = await request("/api/arena/pause", { method: "POST", body: "{}" });
      render();
    }
  } catch (error) {
    showToast(error.message);
  }
  elements.setupModal.classList.remove("hidden");
}

async function toggleArena() {
  if (!state?.arena || state.arena.finished) return;
  elements.arenaToggle.disabled = true;
  try {
    const endpoint = state.arena.paused ? "/api/arena/resume" : "/api/arena/pause";
    state = await request(endpoint, { method: "POST", body: "{}" });
    render();
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.arenaToggle.disabled = Boolean(state?.arena?.finished);
  }
}

elements.newTableButton.addEventListener("click", openSetup);
elements.cancelSetup.addEventListener("click", () => elements.setupModal.classList.add("hidden"));
elements.arenaToggle.addEventListener("click", toggleArena);
elements.arenaNewTable.addEventListener("click", openSetup);
elements.foldButton.addEventListener("click", () => performAction("fold"));
elements.checkCallButton.addEventListener("click", () => performAction(state.legalActions?.actions.includes("call") ? "call" : "check"));
elements.allInButton.addEventListener("click", () => performAction("all_in"));
elements.raiseSlider.addEventListener("input", () => { elements.raiseValue.textContent = chips(elements.raiseSlider.value); });
elements.raiseButton.addEventListener("click", () => performAction(state.legalActions?.aggressiveAction, Number(elements.raiseSlider.value)));
elements.scrollLatest.addEventListener("click", () => { elements.historyList.scrollTop = 0; });

elements.overlayAction.addEventListener("click", async () => {
  const action = elements.overlayAction.dataset.action;
  try {
    if (action === "new") {
      await openSetup();
      return;
    }
    const endpoint = action === "retry" ? "/api/retry-ai" : action === "resume" ? "/api/arena/resume" : "/api/next-hand";
    elements.overlayAction.disabled = true;
    state = await request(endpoint, { method: "POST", body: "{}" });
    liveSummary = "";
    liveSeat = state.aiThinking?.seat ?? null;
    render();
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.overlayAction.disabled = false;
  }
});

document.addEventListener("keydown", (event) => {
  if (!state?.legalActions || !elements.setupModal.classList.contains("hidden")) return;
  if (event.target.matches("input, select, textarea")) return;
  const key = event.key.toLowerCase();
  if (key === "f" && !elements.foldButton.disabled) elements.foldButton.click();
  if (key === "c" && !elements.checkCallButton.disabled) elements.checkCallButton.click();
  if (key === "a" && !elements.allInButton.disabled) elements.allInButton.click();
});

setInterval(() => {
  if (state?.aiThinking) {
    const seconds = Math.max(0, Math.round((Date.now() - state.aiThinking.startedAt) / 1000));
    elements.reasoningStatus.textContent = `${state.aiThinking.status ?? "Reasoning"} (${seconds}s)`;
  }
}, 1000);

const events = new EventSource("/api/events");
events.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "state" && requestInFlight === 0) {
    state = message.payload;
    if (!state.aiThinking) liveSeat = null;
    render();
  } else if (message.type === "ai_stream") {
    const update = message.payload;
    if (update.phase === "started") {
      liveSeat = update.seat;
      liveSummary = "";
    } else if (update.phase === "summary_delta") {
      liveSeat = update.seat;
      liveSummary += update.delta;
    } else if (update.phase === "completed") {
      liveSummary = update.summary || liveSummary;
    }
    if (state) renderInsight();
  }
};
events.onerror = () => showToast("Live table updates disconnected. Reconnecting…");

async function bootstrap() {
  updateSetupMode();
  try {
    state = await request("/api/state");
    if (state) {
      selectedSeat = state.players.find((player) => !player.isHuman)?.seat ?? 0;
      elements.setupModal.classList.add("hidden");
      elements.cancelSetup.classList.remove("hidden");
      render();
    }
  } catch (error) {
    showToast(error.message);
  }
}

bootstrap();
