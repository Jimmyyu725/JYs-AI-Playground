import {
  backToLobby,
  characterPicker,
  drawer,
  loadCharacters,
  loadModels,
  modelPicker,
  prefersReducedMotion,
  seat as seatFigure,
  setSeatCaption,
  setSeatExpression,
  toast,
  transcript as createTranscript,
} from "/shared/kit.js";
import { sfx } from "/shared/sfx.js";
import { speak } from "/shared/speech.js";
import { tileElement, tileName } from "/games/taiwan-mahjong/tiles.js";

const ROOM = "taiwan-mahjong";
const API = `/api/${ROOM}`;
const POSITIONS = ["bottom", "right", "top", "left"];
const WIND_ZH = { EW: "東", SW: "南", WW: "西", NW: "北" };
const WIND_EN = { EW: "East", SW: "South", WW: "West", NW: "North" };
const $ = (id) => document.getElementById(id);

let characters = [];
let registry = null;
let state = null;
let selectedTile = null;
let busy = false;
let seenLog = { hand: 0, count: 0 };
let lastResultKey = null;
let thinkingSummary = "";
const reviews = new Map(); // "<hand>:<seat>" -> { player, text }, survives re-renders of the result card
const seatFigures = new Map(); // seat -> figure.kit-seat

// ---------------------------------------------------------------------------
// Helpers

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

async function post(path, body = {}) {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function viewSeat() {
  return state?.humanSeat ?? 0;
}
function posOf(seat) {
  return POSITIONS[(seat - viewSeat() + 4) % 4];
}
function playerName(seat) {
  return state?.players?.[seat]?.name ?? `Seat ${seat}`;
}
function seededTilt(seat, index) {
  const x = Math.sin(seat * 97.13 + index * 12.9898) * 43758.5453;
  return Math.round(((x - Math.floor(x)) * 6 - 3) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Setup drawer

const setup = { mode: "human-vs-ai", picker: null, models: [], drawer: null };

function aiSeatLabels(mode) {
  return mode === "arena"
    ? ["East 東 (dealer)", "South 南", "West 西", "North 北"]
    : ["South 南 · right", "West 西 · across", "North 北 · left"];
}

function renderSeatModels(container) {
  const defaults = registry.defaults?.[ROOM] ?? registry.defaultConfig;
  const labels = aiSeatLabels(setup.mode);
  const previous = setup.models.map((picker) => picker.value);
  setup.models = labels.map((label, index) => modelPicker({ registry, value: previous[index] ?? defaults, label }));
  container.replaceChildren(...labels.map((label, index) => {
    const row = el("div", "mj-model-row");
    row.append(el("span", "mj-model-label", label), setup.models[index].el);
    return row;
  }));
}

function buildSetup() {
  const panel = drawer({ title: "Open a table 開桌", open: false });
  setup.drawer = panel;
  panel.el.classList.add("mj-shutter");

  const modeRow = el("div", "mj-segment");
  modeRow.setAttribute("role", "radiogroup");
  modeRow.setAttribute("aria-label", "Mode");
  const modes = [["human-vs-ai", "Sit in", "You + 3 characters"], ["arena", "Arena", "4 AI, you watch"]];
  const modeButtons = modes.map(([value, label, hint]) => {
    const button = el("button", "mj-segment-button");
    button.type = "button";
    button.dataset.value = value;
    button.setAttribute("role", "radio");
    button.append(el("strong", null, label), el("small", null, hint));
    button.addEventListener("click", () => setMode(value));
    return button;
  });
  modeRow.append(...modeButtons);

  const nameField = el("label", "mj-field");
  const nameInput = el("input", "mj-input");
  nameInput.value = "You";
  nameInput.maxLength = 24;
  nameField.append(el("span", null, "Your name"), nameInput);

  const lengthField = el("label", "mj-field");
  const lengthSelect = el("select", "kit-select");
  for (const [value, label] of [["single", "One hand"], ["short", "Four hands"], ["east", "East round 東風圈 (up to 16 hands)"]]) {
    lengthSelect.add(new Option(label, value));
  }
  lengthSelect.value = "short";
  lengthField.append(el("span", null, "Length"), lengthSelect);

  const castTitle = el("h3", "mj-setup-title", "Who sits down");
  setup.picker = characterPicker({ characters, seats: 3 });
  const modelTitle = el("h3", "mj-setup-title", "Model and reasoning per seat");
  const modelsBox = el("div", "mj-models");

  const start = el("button", "mj-primary", "Deal 開牌");
  start.type = "button";
  start.addEventListener("click", async () => {
    start.disabled = true;
    try {
      const aiPlayers = setup.models.map((picker, index) => ({ ...picker.value, characterId: setup.picker.value[index] }));
      const next = await post("/game", { mode: setup.mode, humanName: nameInput.value.trim() || "You", length: lengthSelect.value, aiPlayers });
      seenLog = { hand: 0, count: 0 };
      lastResultKey = null;
      transcript.clear();
      transcript.add({ text: `New table: ${next.lengthLabel}, ${setup.mode === "arena" ? "four characters play" : "you deal first"}.`, kind: "system" });
      sfx.play("diceRoll");
      apply(next);
      panel.close();
    } catch (error) {
      sfx.play("error");
      toast(error.message, { tone: "error" });
    } finally {
      start.disabled = false;
    }
  });

  function setMode(value) {
    setup.mode = value;
    for (const button of modeButtons) button.setAttribute("aria-checked", String(button.dataset.value === value));
    nameField.hidden = value === "arena";
    setup.picker.setSeats(value === "arena" ? 4 : 3);
    renderSeatModels(modelsBox);
  }

  panel.body.append(modeRow, nameField, lengthField, castTitle, setup.picker.el, modelTitle, modelsBox, start);
  setMode("human-vs-ai");
  panel.toggleButton.textContent = "Table 開桌";
  return panel;
}

// ---------------------------------------------------------------------------
// Rendering

function renderChips() {
  const chips = $("chips");
  if (!state) {
    chips.replaceChildren(el("span", "mj-chip", "No table yet"));
    return;
  }
  const items = [
    ["mj-chip mj-chip-wind", `${WIND_ZH[state.roundWind]}風 ${WIND_EN[state.roundWind]} round`],
    ["mj-chip", `Hand ${state.handNumber}`],
    ["mj-chip", state.dealerStreak > 0 ? `連莊 ×${state.dealerStreak}` : `莊 ${playerName(state.dealer)}`],
    ["mj-chip mj-chip-wall", `Wall ${state.wallRemaining}`],
  ];
  if (state.mode === "arena") items.push(["mj-chip mj-chip-arena", state.arenaPaused ? "Arena · paused" : "Arena"]);
  chips.replaceChildren(...items.map(([cls, text]) => el("span", cls, text)));
}

function meldElement(meld, size) {
  const group = el("span", `mj-meld mj-meld-${meld.type}`);
  if (!meld.tiles) {
    for (let index = 0; index < 4; index += 1) group.append(tileElement(null, { size }));
    group.title = "Concealed kong 暗槓";
    return group;
  }
  const tiles = meld.type === "concealedKong" ? meld.tiles.map((tile, index) => (index === 0 || index === 3 ? null : tile)) : meld.tiles;
  let marked = false;
  tiles.forEach((tile) => {
    const item = tileElement(tile, { size });
    if (!marked && tile && tile === meld.calledTile && meld.type !== "concealedKong") {
      item.classList.add("is-called");
      marked = true;
    }
    group.append(item);
  });
  return group;
}

function seatFigureFor(player) {
  let figure = seatFigures.get(player.seat);
  const key = player.isHuman ? `human:${player.name}` : `ai:${player.character?.id}`;
  if (!figure || figure.dataset.key !== key) {
    figure = player.isHuman
      ? seatFigure({ name: player.name, caption: "You", size: "sm" })
      : seatFigure({ character: player.character, name: player.character?.shortName ?? player.name, caption: player.character?.title ?? "", size: "sm" });
    figure.dataset.key = key;
    seatFigures.set(player.seat, figure);
  }
  return figure;
}

function expressionFor(player) {
  const result = state.result;
  if (result && (state.phase === "handOver" || state.phase === "gameOver")) {
    if (result.winner === player.seat) return "triumphant";
    if (result.deltas?.[player.seat] < 0) return "defeated";
    return "neutral";
  }
  if (state.aiThinking?.seat === player.seat || state.aiThinking?.seats?.includes(player.seat)) return "thinking";
  return "neutral";
}

function renderSeat(player) {
  const pos = posOf(player.seat);
  const box = $(`seat-${pos}`);
  box.dataset.seat = player.seat;
  const active = state.turnSeat === player.seat || state.seatsToAct?.includes(player.seat);
  box.dataset.active = String(Boolean(active));
  box.style.setProperty("--seat-color", player.character?.color ?? "#ff4fb8");

  const figure = seatFigureFor(player);
  figure.dataset.active = String(Boolean(active));
  if (!player.isHuman) setSeatExpression(figure, expressionFor(player));
  const caption = player.isHuman ? "You" : `${player.character?.title ?? ""}`;
  setSeatCaption(figure, caption);

  const head = el("div", "mj-seat-head");
  const meta = el("div", "mj-seat-meta");
  const wind = el("span", "mj-wind", WIND_ZH[player.seatWind]);
  wind.title = `${WIND_EN[player.seatWind]} seat`;
  if (player.isDealer) wind.classList.add("is-dealer");
  meta.append(wind);
  if (player.isDealer) meta.append(el("span", "mj-dealer", "莊"));
  meta.append(el("span", "mj-score", formatScore(state.scores[player.seat])));
  if (!player.isHuman) meta.append(el("span", "mj-count", `${player.handCount} tiles`));
  if (player.model) meta.append(el("span", "mj-model", `${player.model.replace(/^gpt-/, "")} · ${player.reasoningEffort}`));
  head.append(figure, meta);

  const tiles = el("div", "mj-seat-tiles");
  const isBottomHuman = player.isHuman;
  if (!isBottomHuman) {
    const hand = el("div", "mj-concealed");
    const size = player.hand && (pos === "bottom" || pos === "top") ? "sm" : "xs";
    if (player.hand) {
      for (const tile of player.hand) hand.append(tileElement(tile, { size }));
    } else {
      for (let index = 0; index < player.handCount; index += 1) hand.append(tileElement(null, { size }));
    }
    hand.dataset.count = player.handCount;
    tiles.append(hand);
  }
  const melds = el("div", "mj-melds");
  for (const meld of player.melds) melds.append(meldElement(meld, "xs"));
  if (player.flowers.length) {
    const flowers = el("span", "mj-flowers");
    for (const flower of player.flowers) flowers.append(tileElement(flower, { size: "xs" }));
    melds.append(flowers);
  }
  if (!isBottomHuman) tiles.append(melds);

  box.replaceChildren(head, tiles);
  return melds;
}

function formatScore(value) {
  return `${value > 0 ? "+" : ""}${value.toLocaleString("en-US")}`;
}

function renderRivers() {
  const fresh = state.lastDiscard;
  for (const player of state.players) {
    const river = $(`river-${posOf(player.seat)}`);
    river.replaceChildren(...player.discards.map((tile, index) => {
      const item = tileElement(tile, { size: "xs", tilt: seededTilt(player.seat, index) });
      if (fresh && fresh.seat === player.seat && index === player.discards.length - 1) item.classList.add("is-fresh");
      return item;
    }));
    river.setAttribute("aria-label", player.isHuman ? "Your discards" : `${playerName(player.seat)} discards`);
  }
}

function renderHub() {
  const body = $("hub-body");
  const arrow = $("arrow");
  const activeSeat = state.turnSeat ?? state.seatsToAct?.[0] ?? null;
  if (activeSeat !== null && activeSeat !== undefined) {
    const angle = { bottom: 90, right: 0, top: -90, left: 180 }[posOf(activeSeat)];
    arrow.style.setProperty("--arrow-angle", `${angle}deg`);
    arrow.hidden = false;
  } else {
    arrow.hidden = true;
  }
  const items = [];
  const tile = state.pending?.tile ?? state.lastDiscard?.tile ?? null;
  if (tile && state.phase !== "handOver" && state.phase !== "gameOver") {
    const big = tileElement(tile, { size: "md", extraClass: state.pending ? "is-claimable" : "" });
    items.push(big);
    const from = state.pending?.from ?? state.lastDiscard?.seat;
    const label = state.pending?.kind === "addedKong" ? `${playerName(from)} adds a kong — rob it?` : `${playerName(from)} discarded`;
    items.push(el("span", "mj-hub-label", label));
  } else {
    items.push(el("span", "mj-hub-wall", String(state.wallRemaining)), el("span", "mj-hub-label", "tiles left in the wall"));
  }
  body.replaceChildren(...items);
}

function describeOptionLabel(action) {
  switch (action.type) {
    case "win":
      return state.phase === "discard" ? ["自摸", "Self-draw win"] : state.phase === "robKong" ? ["搶槓", "Rob the kong"] : ["胡", "Win"];
    case "kong":
      return ["槓", "Kong"];
    case "pung":
      return ["碰", "Pung"];
    case "chow":
      return ["吃", "Chow"];
    case "pass":
      return ["過", "Pass"];
    case "concealedKong":
      return ["暗槓", "Concealed kong"];
    case "addedKong":
      return ["加槓", "Add to kong"];
    default:
      return [action.type, action.type];
  }
}

function renderDock() {
  const hand = $("hand");
  const actions = $("actions");
  const prompt = $("prompt");
  const ownMelds = $("own-melds");
  const dock = $("dock");
  const human = state.humanSeat === null ? null : state.players[state.humanSeat];
  dock.hidden = !human;
  if (!human) {
    hand.replaceChildren();
    actions.replaceChildren();
    ownMelds.replaceChildren();
    prompt.textContent = "";
    return;
  }
  const legal = state.humanActions ?? [];
  const discards = new Set(legal.filter((action) => action.type === "discard").map((action) => action.tile));
  const myTurn = state.phase === "discard" && state.turnSeat === human.seat;
  if (!discards.has(selectedTile)) selectedTile = null;

  // Hand: sorted, with the freshly drawn tile set apart on the right.
  const tiles = [...(human.hand ?? [])];
  let drawn = null;
  if (myTurn && state.drawnTile && tiles.includes(state.drawnTile)) {
    tiles.splice(tiles.lastIndexOf(state.drawnTile), 1);
    drawn = state.drawnTile;
  }
  const make = (tile, extra = "") => {
    const button = tileElement(tile, { size: "lg", button: true, extraClass: extra });
    const playable = discards.has(tile);
    button.disabled = !playable || busy;
    if (tile === selectedTile) button.classList.add("is-selected");
    button.addEventListener("click", () => onHandTile(tile));
    button.addEventListener("dblclick", () => discard(tile));
    return button;
  };
  const nodes = tiles.map((tile) => make(tile));
  if (drawn) nodes.push(make(drawn, "is-drawn"));
  hand.replaceChildren(...nodes);
  hand.dataset.active = String(myTurn);

  ownMelds.replaceChildren(...human.melds.map((meld) => meldElement(meld, "sm")));
  if (human.flowers.length) {
    const flowers = el("span", "mj-flowers");
    for (const flower of human.flowers) flowers.append(tileElement(flower, { size: "sm" }));
    ownMelds.append(flowers);
  }

  // Action bar: claim window and own-turn specials.
  const buttons = [];
  for (const action of legal) {
    if (action.type === "discard") continue;
    const [zh, en] = describeOptionLabel(action);
    const button = el("button", `mj-claim mj-claim-${action.type}`);
    button.type = "button";
    button.disabled = busy;
    button.append(el("span", "mj-claim-zh", zh), el("span", "mj-claim-en", en));
    if (action.type === "chow") {
      const shown = el("span", "mj-claim-tiles");
      for (const tile of [...action.tiles, state.pending.tile].sort()) shown.append(tileElement(tile, { size: "xs" }));
      button.append(shown);
    }
    if (action.tile && (action.type === "concealedKong" || action.type === "addedKong")) {
      const shown = el("span", "mj-claim-tiles");
      shown.append(tileElement(action.tile, { size: "xs" }));
      button.append(shown);
    }
    button.addEventListener("click", () => act(action));
    buttons.push(button);
  }
  if (myTurn && selectedTile) {
    const button = el("button", "mj-claim mj-claim-discard");
    button.type = "button";
    button.append(el("span", "mj-claim-zh", "打"), el("span", "mj-claim-en", `Discard ${tileName(selectedTile)}`));
    button.addEventListener("click", () => discard(selectedTile));
    buttons.push(button);
  }
  actions.replaceChildren(...buttons);
  actions.dataset.claim = String(state.phase !== "discard" && legal.length > 0);

  const claimWindow = state.phase !== "discard" && legal.length > 0;
  let line = "";
  let neon = "";
  if (state.phase === "gameOver") line = "The game is over.";
  else if (state.phase === "handOver") line = "Hand over.";
  else if (claimWindow) {
    neon = "Claim?";
    line = state.pending.kind === "addedKong"
      ? `${playerName(state.pending.from)} is adding ${tileName(state.pending.tile)} to a kong. Rob it or pass.`
      : `${playerName(state.pending.from)} let go of ${tileName(state.pending.tile)}. Claim it or pass.`;
  } else if (myTurn) {
    neon = "Your turn";
    line = selectedTile ? "Tap it again, or press 打, to discard." : "Pick a tile to discard.";
  } else if (state.aiThinking) line = `${state.aiThinking.playerName} is thinking…`;
  const parts = [];
  if (neon) parts.push(el("span", "mj-turn-neon", neon));
  parts.push(el("span", null, line));
  prompt.replaceChildren(...parts);
  if (claimWindow && dock.dataset.claimKey !== `${state.seq}`) sfx.play("chipClack");
  dock.dataset.claimKey = claimWindow ? `${state.seq}` : "";
}

function renderSide() {
  const thinking = $("thinking");
  thinking.hidden = !state?.aiThinking;
  if (state?.aiThinking) {
    $("thinking-who").textContent = state.aiThinking.playerName;
    $("thinking-status").textContent = state.aiThinking.status ?? "";
    $("thinking-summary").textContent = thinkingSummary.slice(-280);
  }
  const error = $("ai-error");
  error.hidden = !state?.aiError;
  if (state?.aiError) {
    const retry = el("button", "mj-primary mj-small", "Retry 再試");
    retry.type = "button";
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      try {
        apply(await post("/retry-ai"));
      } catch (problem) {
        toast(problem.message, { tone: "error" });
        retry.disabled = false;
      }
    });
    error.replaceChildren(el("strong", null, `${state.aiError.playerName} is stuck`), el("p", null, state.aiError.message), retry);
  }
  const scores = $("scores");
  if (!state) {
    scores.replaceChildren();
    return;
  }
  const max = Math.max(1000, ...state.scores.map(Math.abs));
  scores.replaceChildren(...state.players.map((player) => {
    const row = el("div", "mj-glass-row");
    row.style.setProperty("--seat-color", player.character?.color ?? "#ff4fb8");
    const glass = el("span", "mj-glass");
    glass.style.setProperty("--level", String(Math.round(50 + (state.scores[player.seat] / max) * 45)));
    row.append(glass, el("span", "mj-glass-name", `${WIND_ZH[player.seatWind]} ${player.name}`), el("span", "mj-glass-score", formatScore(state.scores[player.seat])));
    return row;
  }));
  if (state.mode === "arena" && state.phase !== "gameOver") {
    const toggle = el("button", "mj-ghost", state.arenaPaused ? "Resume arena" : "Pause arena");
    toggle.type = "button";
    toggle.addEventListener("click", async () => {
      try {
        apply(await post(state.arenaPaused ? "/arena/resume" : "/arena/pause"));
      } catch (problem) {
        toast(problem.message, { tone: "error" });
      }
    });
    scores.append(toggle);
  }
}

function renderResult() {
  const box = $("result");
  const over = state.phase === "handOver" || state.phase === "gameOver";
  box.hidden = !over || !state.result;
  if (box.hidden) return;
  const result = state.result;
  const key = `${state.handNumber}:${result.type}`;
  const fresh = key !== lastResultKey;
  lastResultKey = key;

  const parts = [];
  const winner = result.winner ?? null;
  if (result.type === "exhaustiveDraw") {
    parts.push(el("p", "mj-result-zh", "流局"), el("h2", "mj-result-title", "Wall exhausted — the dealer stays"));
  } else {
    const zh = { selfDraw: "自摸", discardWin: "胡", robbingKong: "搶槓" }[result.type];
    parts.push(el("p", "mj-result-zh", zh));
    const how = result.type === "selfDraw" ? "draws the winning tile" : result.type === "robbingKong" ? `robs ${playerName(result.from)}'s kong` : `wins on ${playerName(result.from)}'s discard`;
    parts.push(el("h2", "mj-result-title", `${playerName(winner)} ${how}`));
    const winningHand = el("div", "mj-result-hand");
    for (const meld of state.players[winner].melds) winningHand.append(meldElement({ ...meld, tiles: meld.tiles ?? null }, "sm"));
    const concealed = el("span", "mj-meld");
    for (const tile of result.hands?.[winner] ?? []) {
      const item = tileElement(tile, { size: "sm" });
      if (tile === result.winTile) item.classList.add("is-called");
      concealed.append(item);
    }
    winningHand.append(concealed);
    parts.push(winningHand);
    const fans = el("ul", "mj-fans");
    for (const fan of [...(result.fans ?? []), ...(result.dealerFans ?? [])]) {
      const item = el("li");
      item.append(el("span", null, fan.count > 1 && fan.key !== "dealerStreak" ? `${fan.name} ×${fan.count}` : fan.name), el("b", null, `${fan.tai} 台`));
      fans.append(item);
    }
    if (!fans.children.length) fans.append(el("li", null, "No tai: base payment only"));
    parts.push(fans);
    const pays = el("p", "mj-pays");
    pays.textContent = result.payments.map((payment) => `${playerName(payment.payer)} pays ${payment.amount} (${payment.tai} 台)`).join(" · ");
    parts.push(pays);
  }
  const deltas = el("div", "mj-deltas");
  state.players.forEach((player) => {
    const delta = result.deltas?.[player.seat] ?? 0;
    const chip = el("span", `mj-delta ${delta > 0 ? "is-up" : delta < 0 ? "is-down" : ""}`, `${player.name} ${formatScore(delta)}`);
    deltas.append(chip);
  });
  parts.push(deltas);

  const reviewers = state.players.filter((player) => !player.isHuman);
  if (reviewers.length) {
    const ask = el("div", "mj-review-ask");
    const quote = el("blockquote", "mj-review");
    quote.hidden = true;
    const showReview = (player, text) => {
      quote.hidden = false;
      const cite = el("cite", null, `— ${player.character?.name ?? player.name}, ${player.character?.title ?? ""}`);
      quote.replaceChildren(el("p", null, text), cite);
    };
    const shown = [...reviews.entries()].filter(([key]) => key.startsWith(`${state.handNumber}:`)).pop();
    if (shown) showReview(shown[1].player, shown[1].text);
    for (const player of reviewers) {
      const button = el("button", "mj-ghost mj-small", `Ask ${player.name} to review`);
      button.type = "button";
      button.addEventListener("click", async () => {
        for (const other of ask.querySelectorAll("button")) other.disabled = true;
        quote.hidden = false;
        quote.replaceChildren(el("p", "mj-review-wait", `${player.name} lights a cigarette and thinks it over…`));
        try {
          const answer = await post("/review", { seat: player.seat });
          reviews.set(`${answer.handNumber}:${player.seat}`, { player, text: answer.review });
          showReview(player, answer.review);
          if (!quote.isConnected) renderResult();
          transcript.add({ who: player.name, text: answer.review, kind: "talk" });
        } catch (error) {
          quote.replaceChildren(el("p", "mj-review-wait", error.message));
          sfx.play("error");
        } finally {
          for (const other of ask.querySelectorAll("button")) other.disabled = false;
        }
      });
      ask.append(button);
    }
    parts.push(ask, quote);
  }

  if (state.phase === "gameOver") {
    const standings = el("ol", "mj-standings");
    const order = state.players.map((player) => player.seat).sort((a, b) => state.scores[b] - state.scores[a]);
    for (const seat of order) standings.append(el("li", null, `${state.standings?.[seat] ?? ""}. ${playerName(seat)} ${formatScore(state.scores[seat])}`));
    parts.push(el("h3", "mj-result-sub", "Final standings"), standings);
    const again = el("button", "mj-primary", "New table 再開一桌");
    again.type = "button";
    again.addEventListener("click", () => setup.drawer.open());
    parts.push(again);
  } else if (state.mode === "arena") {
    parts.push(el("p", "mj-result-note", state.arenaPaused ? "Arena paused." : "Next hand deals in a few seconds…"));
  } else {
    const next = el("button", "mj-primary", "Next hand 下一局");
    next.type = "button";
    next.addEventListener("click", async () => {
      next.disabled = true;
      try {
        sfx.play("diceRoll");
        apply(await post("/next-hand"));
      } catch (problem) {
        toast(problem.message, { tone: "error" });
        next.disabled = false;
      }
    });
    parts.push(next);
  }
  box.replaceChildren(el("div", "mj-result-card", ""));
  box.firstChild.append(...parts);
  if (fresh) {
    box.classList.remove("is-flicker");
    void box.offsetWidth;
    box.classList.add("is-flicker");
    if (result.type !== "exhaustiveDraw") sfx.play(result.winner === state.humanSeat ? "win" : "cupSlam");
  }
}

function render() {
  document.body.dataset.phase = state?.phase ?? "empty";
  document.body.dataset.mode = state?.mode ?? "none";
  renderChips();
  renderSide();
  const table = $("table");
  table.dataset.empty = String(!state);
  if (!state) {
    const cup = el("img", "mj-neon mj-empty-teacup");
    cup.src = "/assets/rooms/taiwan-mahjong/neon-tile.webp";
    cup.alt = "";
    const open = el("button", "mj-primary", "Open a table 開桌");
    open.type = "button";
    open.addEventListener("click", () => setup.drawer.open());
    $("hub-body").replaceChildren(cup, el("span", "mj-empty-title", "三缺一 · one seat open"), el("span", "mj-hub-label", "The tea is poured and three regulars are waiting."), open);
    $("dock").hidden = true;
    return;
  }
  const activeSeat = state.turnSeat ?? state.seatsToAct?.[0];
  table.dataset.lamp = activeSeat === undefined || activeSeat === null ? "center" : posOf(activeSeat);
  for (const player of state.players) renderSeat(player);
  renderRivers();
  renderHub();
  renderDock();
  renderResult();
}

// ---------------------------------------------------------------------------
// Log → transcript and sound

function describeEvent(event) {
  const who = event.seat !== undefined ? playerName(event.seat) : "";
  switch (event.type) {
    case "deal":
      return { text: `Hand dealt. ${event.dealer === state?.humanSeat ? "You deal" : `${playerName(event.dealer)} deals`} (莊).`, kind: "system", sound: "diceRoll" };
    case "discard":
      return { who, text: `discards ${tileName(event.tile)}`, sound: "tileClack" };
    case "chow":
    case "pung":
    case "kong":
      return { who, text: `${{ chow: "吃 chows", pung: "碰 pungs", kong: "槓 kongs" }[event.type]} ${tileName(event.tile)} from ${playerName(event.from)}`, sound: "cupSlam" };
    case "concealedKong":
      return { who, text: "declares a concealed kong 暗槓", sound: "cupSlam" };
    case "addedKong":
      return { who, text: `adds ${tileName(event.tile)} to a kong 加槓`, sound: "cupSlam" };
    case "flower":
      return { who, text: `sets aside ${tileName(event.tile)}`, sound: null, quiet: true };
    case "win":
      return { who, text: event.selfDraw ? "自摸! Self-drawn win" : event.robbingKong ? "搶槓! Robs the kong" : `胡! Wins on ${playerName(event.from)}'s ${tileName(event.tile)}`, kind: "system", sound: null };
    case "handEnd":
      return event.result === "exhaustiveDraw" ? { text: "流局 The wall runs dry.", kind: "system", sound: null } : null;
    default:
      return null;
  }
}

function consumeLog(next, { silent = false } = {}) {
  if (!next?.log) return;
  if (next.handNumber !== seenLog.hand) seenLog = { hand: next.handNumber, count: 0 };
  const total = next.logTotal ?? next.log.length;
  const startIndex = total - next.log.length;
  const fresh = next.log.slice(Math.max(0, seenLog.count - startIndex));
  seenLog.count = total;
  let sound = null;
  for (const event of fresh) {
    const line = describeEvent(event);
    if (!line) continue;
    if (!line.quiet || fresh.length < 6) transcript.add({ who: line.who, text: line.text, kind: line.kind ?? "move" });
    if (line.sound) sound = line.sound;
  }
  if (sound && !silent) sfx.play(sound);
}

function apply(next) {
  if (!next) return;
  const firstLoad = !state;
  if (state && next.handNumber === state.handNumber && next.seq < state.seq) return; // out-of-order
  state = next;
  if ((state.logTotal ?? 0) < seenLog.count && state.handNumber === seenLog.hand) seenLog.count = 0;
  consumeLog(state, { silent: firstLoad });
  if (!state.aiThinking) thinkingSummary = "";
  render();
}

// ---------------------------------------------------------------------------
// Human actions

function onHandTile(tile) {
  if (selectedTile === tile) {
    discard(tile);
    return;
  }
  selectedTile = tile;
  sfx.play("stoneClick");
  renderDock();
}

async function act(action) {
  if (busy) return;
  busy = true;
  try {
    apply(await post("/action", { action }));
  } catch (error) {
    sfx.play("error");
    toast(error.message, { tone: "error" });
  } finally {
    busy = false;
    if (state) renderDock();
  }
}

function discard(tile) {
  selectedTile = null;
  act({ type: "discard", tile });
}

// ---------------------------------------------------------------------------
// Boot

const transcript = createTranscript({ title: "Table log 牌局", limit: 160 });

async function boot() {
  $("transcript-slot").append(transcript.el);
  $("top-left").append(backToLobby());
  try {
    [characters, registry] = await Promise.all([loadCharacters(), loadModels()]);
  } catch (error) {
    toast(`Could not load the roster: ${error.message}`, { tone: "error" });
    return;
  }
  const panel = buildSetup();
  $("top-right").append(sfx.muteButton(), panel.toggleButton);

  const initial = await fetch(`${API}/state`).then((response) => response.json()).catch(() => null);
  if (initial) apply(initial);
  else {
    render();
    panel.open();
  }

  const events = new EventSource(`${API}/events`);
  events.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "state") apply(message.payload);
    else if (message.type === "ai_stream") {
      if (message.payload.phase === "summary_delta") {
        thinkingSummary += message.payload.delta;
        $("thinking-summary").textContent = thinkingSummary.slice(-280);
      } else if (message.payload.phase === "status") {
        $("thinking-status").textContent = message.payload.status;
      } else if (message.payload.phase === "error") {
        sfx.play("error");
      }
    }
  });
  // Table talk: the bubble opens toward the middle of the table from each seat.
  const heard = new Set();
  events.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    const talk = message?.type === "table_talk" ? message.payload : null;
    if (!talk || heard.has(talk.id)) return;
    heard.add(talk.id);
    const seat = Number(talk.speaker);
    const pos = posOf(seat);
    const anchor = seatFigures.get(seat) ?? $(`seat-${pos}`);
    const phone = matchMedia("(max-width: 720px)").matches;
    const placement = phone ? (pos === "bottom" ? "top" : "bottom") : { top: "bottom", bottom: "top", left: "right", right: "left" }[pos];
    speak(anchor, talk.text, { placement });
    transcript.add({ who: talk.playerName, text: talk.text, kind: "talk" });
  });
  if (prefersReducedMotion()) document.body.dataset.motion = "reduced";
}

boot();
