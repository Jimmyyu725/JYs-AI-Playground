import {
  backToLobby,
  characterPicker,
  drawer,
  loadCharacters,
  loadModels,
  modelPicker,
  portraitUrl,
  prefersReducedMotion,
  seat,
  setSeatExpression,
  toast,
  transcript,
} from "/shared/kit.js";
import { sfx } from "/shared/sfx.js";
import { speak } from "/shared/speech.js";

const COLUMN_LABELS = "ABCDEFGHJKLMNOPQRST";
const COLORS = ["black", "white"];
const $ = (id) => document.getElementById(id);
const el = {
  room: $("room"),
  topbarLeft: $("topbar-left"),
  topbarRight: $("topbar-right"),
  moveNumber: $("move-number"),
  rulesChip: $("rules-chip"),
  seats: { black: $("seat-black"), white: $("seat-white") },
  turnLine: $("turn-line"),
  turnStone: $("turn-stone"),
  turnText: $("turn-text"),
  goban: $("goban"),
  lines: $("goban-lines"),
  territory: $("goban-territory"),
  stones: $("goban-stones"),
  hits: $("goban-hits"),
  pass: $("pass-button"),
  resign: $("resign-button"),
  arena: $("arena-toggle"),
  save: $("save-button"),
  notice: $("notice"),
  liveDot: $("live-dot"),
  readingWho: $("reading-who"),
  readingText: $("reading-text"),
  record: $("record"),
};

let state = null;
let characters = [];
let registry = null;
let liveSummary = "";
let busy = false;
let requestsInFlight = 0;
let builtSize = 0;
const stoneNodes = new Map();
let lastSeen = { moveNumber: -1, phase: null, castKey: "", humanTurn: false };
let highlighted = null;

/* ---------- Sound: the room's own quiet palette, gated by the shared mute switch ---------- */

let audioContext = null;
function audio() {
  if (sfx.muted) return null;
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) return null;
  audioContext ??= new AudioContextClass();
  if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
  return audioContext;
}

function noise(ctx, seconds) {
  const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * seconds)), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
  return buffer;
}

function envelope(ctx, start, peak, decay) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.003);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + decay);
  gain.connect(ctx.destination);
  return gain;
}

function click(ctx, at, { frequency = 3200, q = 6, gain = 0.5, body = 180, lowpass = 0 } = {}) {
  const start = ctx.currentTime + at;
  const detune = 1 + (Math.random() * 0.06 - 0.03);
  const source = ctx.createBufferSource();
  source.buffer = noise(ctx, 0.02);
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = frequency * detune;
  band.Q.value = q;
  let chain = source.connect(band);
  if (lowpass) {
    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = lowpass;
    chain = chain.connect(low);
  }
  chain.connect(envelope(ctx, start, gain, 0.03));
  source.start(start);
  if (body) {
    const wood = ctx.createOscillator();
    wood.frequency.value = body * detune;
    wood.connect(envelope(ctx, start, gain * 0.5, 0.07));
    wood.start(start);
    wood.stop(start + 0.1);
  }
}

function partial(ctx, at, frequency, gain, decay) {
  const start = ctx.currentTime + at;
  const oscillator = ctx.createOscillator();
  oscillator.frequency.value = frequency;
  oscillator.connect(envelope(ctx, start, gain, decay));
  oscillator.start(start);
  oscillator.stop(start + decay + 0.05);
}

const sound = {
  pachi() {
    const ctx = audio();
    if (ctx) click(ctx, 0, { gain: 0.6 });
  },
  capture(count) {
    const ctx = audio();
    if (!ctx) return;
    for (let index = 0; index < Math.min(4, Math.max(2, count)); index += 1) click(ctx, 0.14 + index * 0.03, { gain: 0.22, lowpass: 1800, body: 0 });
  },
  chime() {
    const ctx = audio();
    if (!ctx) return;
    partial(ctx, 0, 2600, 0.06, 1.2);
    partial(ctx, 0.002, 5900, 0.03, 0.9);
  },
  bell() {
    const ctx = audio();
    if (!ctx) return;
    [[98, 0.22], [98 * 2.76, 0.07], [98 * 5.4, 0.04], [98 * 1.51, 0.05]].forEach(([frequency, gain]) => partial(ctx, 0, frequency, gain, 4));
  },
  tok() {
    const ctx = audio();
    if (ctx) click(ctx, 0, { frequency: 900, q: 3, gain: 0.25, body: 140 });
  },
};

/* ---------- Helpers ---------- */

// Long requests (a review) pass track: false so live state updates keep flowing meanwhile.
async function request(path, body, { track = true } = {}) {
  if (track) requestsInFlight += 1;
  try {
    const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // Empty body.
    }
    if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
    return payload;
  } finally {
    if (track) requestsInFlight -= 1;
  }
}

const capitalize = (text) => `${text[0].toUpperCase()}${text.slice(1)}`;
const opposite = (color) => (color === "black" ? "white" : "black");
const modelLabel = (id) => registry?.models.find((model) => model.id === id)?.label ?? id;
const playerOf = (color) => state?.players.find((player) => player.color === color);
const coordinate = (row, column, size) => `${COLUMN_LABELS[column]}${size - row}`;
const isWide = () => matchMedia("(min-width: 1100px)").matches;

function parseCoordinate(text, size) {
  const match = /^([A-HJ-T])(\d{1,2})$/.exec(String(text).toUpperCase());
  if (!match) return null;
  const column = COLUMN_LABELS.indexOf(match[1]);
  const row = size - Number(match[2]);
  return column >= 0 && column < size && row >= 0 && row < size ? { row, column } : null;
}

function starPoints(size) {
  const lines = size === 9 ? [2, 4, 6] : size === 13 ? [3, 6, 9] : [3, 9, 15];
  const points = lines.flatMap((row) => lines.map((column) => [row, column]));
  return size === 19 ? points : points.filter(([row, column]) => (row === column) || (row + column === size - 1));
}

/* ---------- Board ---------- */

function place(node, row, column, size) {
  node.style.setProperty("--x", `${((column + 1) / (size + 1)) * 100}%`);
  node.style.setProperty("--y", `${((row + 1) / (size + 1)) * 100}%`);
}

function buildBoard(size) {
  builtSize = size;
  el.goban.dataset.size = String(size);
  el.goban.style.setProperty("--n", size + 1);
  const span = size + 1;
  const svg = [`<rect x="1" y="1" width="${size - 1}" height="${size - 1}" class="edge" />`];
  for (let index = 1; index <= size; index += 1) {
    svg.push(`<line x1="1" y1="${index}" x2="${size}" y2="${index}" /><line x1="${index}" y1="1" x2="${index}" y2="${size}" />`);
    svg.push(`<text x="${index}" y="0.45" class="label">${COLUMN_LABELS[index - 1]}</text>`);
    svg.push(`<text x="0.42" y="${index}" class="label" dominant-baseline="central">${size - index + 1}</text>`);
  }
  for (const [row, column] of starPoints(size)) svg.push(`<circle cx="${column + 1}" cy="${row + 1}" r="${size === 19 ? 0.11 : 0.09}" class="star" />`);
  el.lines.setAttribute("viewBox", `0 0 ${span} ${span}`);
  el.lines.innerHTML = svg.join("");

  el.stones.replaceChildren();
  stoneNodes.clear();
  el.territory.replaceChildren();
  el.hits.replaceChildren();
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const hit = document.createElement("button");
      hit.type = "button";
      hit.className = "hit";
      hit.dataset.row = String(row);
      hit.dataset.column = String(column);
      hit.setAttribute("role", "gridcell");
      hit.setAttribute("aria-label", coordinate(row, column, size));
      place(hit, row, column, size);
      el.hits.append(hit);
    }
  }
}

let focusPoint = { row: -1, column: -1 };
function hitAt(row, column) {
  if (row < 0 || column < 0 || row >= builtSize || column >= builtSize) return null;
  return el.hits.children[row * builtSize + column] ?? null;
}

function stoneTurn(row, column) {
  return ((row * 7919 + column * 104729) % 360) | 0;
}

function renderBoard(previousBoard) {
  const size = state.boardSize;
  if (builtSize !== size) buildBoard(size);
  const animate = !prefersReducedMotion();
  let added = 0;
  const removed = [];
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const key = `${row},${column}`;
      const cell = state.board[row][column];
      const node = stoneNodes.get(key);
      if (node && node.dataset.color !== cell) {
        stoneNodes.delete(key);
        if (previousBoard && animate) {
          node.classList.add("is-captured");
          node.addEventListener("animationend", () => node.remove(), { once: true });
          setTimeout(() => node.remove(), 900);
        } else node.remove();
        removed.push(key);
      }
      if (cell && !stoneNodes.has(key)) {
        const stone = document.createElement("span");
        stone.className = `stone ${cell}`;
        stone.dataset.color = cell;
        stone.style.setProperty("--turn", `${stoneTurn(row, column)}deg`);
        place(stone, row, column, size);
        if (previousBoard) stone.classList.add("is-new");
        el.stones.append(stone);
        stoneNodes.set(key, stone);
        added += 1;
      }
    }
  }
  for (const node of el.stones.querySelectorAll(".is-last")) node.classList.remove("is-last");
  if (state.lastMove?.action === "place") stoneNodes.get(`${state.lastMove.row},${state.lastMove.column}`)?.classList.add("is-last");

  const canAct = state.humanCanAct && !busy;
  el.goban.dataset.ghost = canAct ? state.currentColor : "";
  for (const hit of el.hits.children) {
    const occupied = Boolean(state.board[Number(hit.dataset.row)][Number(hit.dataset.column)]);
    hit.disabled = !canAct || occupied;
    hit.tabIndex = -1;
  }
  // Roving focus: one tab stop on the board, arrow keys move between open points.
  const centre = Math.floor(size / 2);
  const rover = [hitAt(focusPoint.row, focusPoint.column), hitAt(centre, centre), el.hits.querySelector(".hit:not(:disabled)")].find((hit) => hit && !hit.disabled);
  if (rover) rover.tabIndex = 0;
  renderTerritory();
  renderHighlight();
  return { added, removed: removed.length };
}

function renderTerritory() {
  const key = state.territory ? JSON.stringify(state.territory) : "";
  if (el.territory.dataset.key === key) return;
  el.territory.dataset.key = key;
  el.territory.replaceChildren();
  if (!state.territory) return;
  let index = 0;
  state.territory.forEach((cells, row) =>
    cells.forEach((owner, column) => {
      if (!owner) return;
      const mark = document.createElement("span");
      mark.className = `territory ${owner}`;
      mark.style.setProperty("--i", String(index++));
      place(mark, row, column, state.boardSize);
      el.territory.append(mark);
    }),
  );
}

function renderHighlight() {
  el.stones.querySelector(".moment-ring")?.remove();
  if (!highlighted || !state) return;
  const point = parseCoordinate(highlighted, state.boardSize);
  if (!point) return;
  const ring = document.createElement("span");
  ring.className = "moment-ring";
  place(ring, point.row, point.column, state.boardSize);
  el.stones.append(ring);
}

/* ---------- Seats ---------- */

function lidTray(count, stoneColor) {
  const tray = document.createElement("div");
  tray.className = "lid";
  tray.title = `${count} prisoner${count === 1 ? "" : "s"}`;
  const pile = document.createElement("span");
  pile.className = "lid-pile";
  for (let index = 0; index < Math.min(count, 14); index += 1) {
    const stone = document.createElement("i");
    stone.className = `lid-stone ${stoneColor}`;
    stone.style.setProperty("--k", String(index));
    stone.style.setProperty("--turn", `${(index * 137) % 360}deg`);
    pile.append(stone);
  }
  const label = document.createElement("b");
  label.textContent = String(count);
  tray.append(pile, label);
  return tray;
}

function steam() {
  const wrap = document.createElement("span");
  wrap.className = "steam";
  wrap.setAttribute("aria-hidden", "true");
  wrap.innerHTML = '<svg viewBox="0 0 40 90"><g filter="url(#steam-filter)"><path d="M20 88 C 8 70, 30 58, 18 40 S 26 12, 20 2" /><path d="M26 88 C 16 72, 36 60, 25 44 S 30 18, 27 8" /></g></svg>';
  return wrap;
}

function renderSeat(color) {
  const card = el.seats[color];
  const player = playerOf(color);
  const key = `${player.character?.id ?? "human"}|${player.name}|${player.aiConfig?.model}|${player.aiConfig?.reasoningEffort}`;
  if (card.dataset.key !== key) {
    card.dataset.key = key;
    card.replaceChildren();
    const portrait = seat({
      character: player.character ?? { initials: "YOU", color: "#e39a52" },
      name: player.name,
      caption: player.isHuman ? "House guest" : player.character.title,
      size: isWide() ? "lg" : "sm",
    });
    portrait.classList.add("seat-portrait");
    const meta = document.createElement("div");
    meta.className = "seat-meta";
    const stone = document.createElement("span");
    stone.className = `seat-stone ${color}`;
    const config = document.createElement("span");
    config.className = "seat-config";
    config.textContent = player.isHuman ? `You play ${color}` : `${modelLabel(player.aiConfig.model)} · ${player.aiConfig.reasoningEffort}`;
    meta.append(stone, config);
    const tray = document.createElement("div");
    tray.className = "seat-tray";
    card.append(steam(), portrait, meta, tray);
  }
  const tray = card.querySelector(".seat-tray");
  const prisoners = state.captures[color];
  if (tray.dataset.count !== String(prisoners)) {
    tray.dataset.count = String(prisoners);
    tray.replaceChildren(lidTray(prisoners, opposite(color)));
  }
  const thinking = state.aiThinking?.color === color;
  const active = state.phase === "active" && state.currentColor === color;
  card.dataset.active = String(active);
  card.dataset.thinking = String(thinking);
  card.dataset.human = String(player.isHuman);
  const portrait = card.querySelector(".kit-seat");
  portrait.dataset.active = String(active);
  let expression = thinking ? "thinking" : "neutral";
  if (state.phase === "complete" && state.result) {
    expression = !state.result.winner ? "neutral" : state.result.winner === color ? "triumphant" : "defeated";
  }
  if (!player.isHuman) swapExpression(portrait, expression);
  else portrait.dataset.expression = expression === "thinking" ? "neutral" : expression;
}

// Paint a new expression only once its image has loaded, so a missing one keeps the current face.
const missingExpressions = new Set();
function swapExpression(portrait, expression) {
  const id = portrait.dataset.characterId;
  if (!id || portrait.dataset.wanted === expression) return;
  portrait.dataset.wanted = expression;
  const url = portraitUrl(id, expression);
  if (missingExpressions.has(url)) return;
  const probe = new Image();
  probe.onload = () => {
    if (portrait.dataset.wanted === expression) setSeatExpression(portrait, expression);
  };
  probe.onerror = () => missingExpressions.add(url);
  probe.src = url;
}

/* ---------- Status, notice, reading ---------- */

function resultLine() {
  const result = state.result;
  if (result.reason === "resignation") return `${capitalize(result.winner)} wins by resignation.`;
  if (!result.winner) return `A tie at ${result.scores.black} each.`;
  return `${capitalize(result.winner)} wins by ${result.margin}. Black ${result.scores.black} · White ${result.scores.white}.`;
}

function renderStatus() {
  el.moveNumber.textContent = String(state.moveNumber);
  el.rulesChip.textContent = `${state.boardSize} × ${state.boardSize} · komi ${state.komi}`;
  const actor = playerOf(state.currentColor);
  el.turnStone.className = `turn-stone ${state.phase === "complete" ? "done" : state.currentColor}`;
  let text;
  if (state.phase === "complete") text = resultLine();
  else if (state.aiError) text = `${state.aiError.playerName} is paused. Retry to continue.`;
  else if (state.arena?.paused) text = "The arena is paused.";
  else if (state.aiThinking) text = `${actor.name} is reading the board…`;
  else if (actor?.isHuman) text = state.consecutivePasses ? "Your move. Your opponent passed." : "Your move.";
  else text = `${actor?.name ?? capitalize(state.currentColor)} to play.`;
  el.turnText.textContent = text;
  el.turnLine.dataset.tone = state.aiError ? "alert" : state.humanCanAct ? "you" : "";
  el.pass.disabled = !state.humanCanAct || busy;
  el.resign.disabled = !state.humanCanAct || busy;
  el.save.disabled = false;
  el.save.title = state.save?.savedAt ? `Saved ${new Date(state.save.savedAt).toLocaleTimeString()}${state.save.restored ? " · restored after a restart" : ""}` : "Save this game";
  el.save.dataset.error = String(Boolean(state.save?.error));
  el.arena.classList.toggle("hidden", state.gameMode !== "arena" || state.phase === "complete");
  if (state.arena) el.arena.textContent = state.arena.paused ? "Resume arena" : "Pause arena";
  const dusk = state.phase === "complete" ? 1 : Math.min(1, state.moveNumber / (state.boardSize * state.boardSize * 0.55));
  document.body.style.setProperty("--dusk", dusk.toFixed(3));
}

function button(label, className, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}

// The house ladder line on the result slip: this table's ratings after the game was recorded.
async function showLadder(target) {
  try {
    const { ratings } = await request("/api/ladder/go", undefined, { track: false });
    const keys = state.players.map((player) => (player.isHuman ? "human" : `${player.aiConfig.model}@${player.aiConfig.reasoningEffort}`));
    const shown = ratings.filter((rating) => keys.includes(rating.key));
    if (!shown.length) return;
    target.textContent = `Go ladder · ${shown.map((rating) => `${rating.kind === "human" ? "You" : `${modelLabel(rating.model)} ${rating.reasoningEffort}`} ${rating.rating}`).join(" · ")}`;
  } catch {
    // The ladder line is optional.
  }
}

function renderNotice() {
  const notice = el.notice;
  const key = JSON.stringify([state.aiError, state.phase, state.result, state.review, state.reviewPending, state.gameMode]);
  if (notice.dataset.key === key) return;
  notice.dataset.key = key;
  notice.replaceChildren();
  notice.dataset.tone = "";
  if (state.aiError) {
    notice.dataset.tone = "alert";
    const title = document.createElement("h2");
    title.textContent = `${state.aiError.playerName} needs a retry`;
    const copy = document.createElement("p");
    copy.textContent = state.aiError.message;
    notice.append(title, copy, button("Retry the model", "act act-primary", retryAI));
  } else if (state.phase === "complete") {
    const title = document.createElement("h2");
    title.textContent = state.result.winner ? `${playerOf(state.result.winner).name} takes the board` : "The board is even";
    const copy = document.createElement("p");
    copy.textContent = resultLine();
    notice.append(title, copy);
    if (state.territory) {
      const legend = document.createElement("p");
      legend.className = "legend";
      legend.innerHTML = '<i class="territory-key black"></i>Black area <i class="territory-key white"></i>White area';
      notice.append(legend);
    }
    const ladder = document.createElement("p");
    ladder.className = "ladder";
    notice.append(ladder);
    showLadder(ladder);
    if (state.review) {
      const review = document.createElement("div");
      review.className = "review";
      const who = document.createElement("strong");
      who.textContent = `${state.review.playerName} reviews the game`;
      const text = document.createElement("p");
      text.textContent = state.review.text;
      review.append(who, text);
      if (state.review.keyMoments?.length) {
        const list = document.createElement("ul");
        list.className = "moments";
        for (const moment of state.review.keyMoments) {
          const item = document.createElement("li");
          const chip = button(moment.coordinate, "moment", () => {
            highlighted = highlighted === moment.coordinate ? null : moment.coordinate;
            renderHighlight();
          });
          const note = document.createElement("span");
          note.textContent = moment.note;
          item.append(chip, note);
          list.append(item);
        }
        review.append(list);
      }
      notice.append(review);
    }
    const row = document.createElement("div");
    row.className = "notice-actions";
    row.append(button("New game", "act act-primary", () => openSetup()));
    for (const player of state.players.filter((candidate) => !candidate.isHuman)) {
      if (state.review?.color === player.color) continue;
      const pending = state.reviewPending === player.color;
      const name = player.character?.shortName ?? player.name;
      const ask = button(pending ? `${name} is writing a review…` : `Ask ${name} to review this game`, "act", () => askReview(player.color));
      ask.disabled = Boolean(state.reviewPending);
      row.append(ask);
    }
    notice.append(row);
  }
  notice.classList.toggle("hidden", !notice.childElementCount);
}

// OpenAI summaries arrive as Markdown with bold section titles; show them as plain prose.
const plain = (text) => String(text ?? "").replace(/\*\*(.+?)\*\*\s*/g, "$1 · ").replace(/\s+/g, " ").trim();

function renderReading() {
  const thinking = state.aiThinking;
  el.liveDot.textContent = thinking ? "Live" : "Idle";
  el.liveDot.dataset.on = String(Boolean(thinking));
  if (thinking) {
    const seconds = Math.max(0, Math.round((Date.now() - thinking.startedAt) / 1000));
    el.readingWho.textContent = `${thinking.playerName} · ${thinking.status ?? "Reading"} (${seconds}s)`;
    el.readingText.textContent = plain(liveSummary) || "Waiting for a reasoning summary…";
  } else {
    const latest = state.aiInsights[0];
    el.readingWho.textContent = latest ? `${latest.playerName} · move ${latest.moveNumber} · ${(latest.latencyMs / 1000).toFixed(1)}s` : "No model request is active.";
    el.readingText.textContent = latest ? plain(latest.summary || latest.explanation) : "Public rationales and supported reasoning summaries appear here and stay in the record below.";
  }
}

/* ---------- Record (shared transcript) ---------- */

const record = transcript({ title: "Game record" });
el.record.append(record.el);
const recorded = new Set();

function syncRecord(reset) {
  if (reset) {
    record.clear();
    recorded.clear();
  }
  const entries = [
    ...[...state.logs].reverse().map((entry) => ({ id: `log-${entry.id}`, at: Date.parse(entry.at), who: "", text: entry.text, kind: entry.kind === "move" ? "move" : entry.kind === "error" ? "error" : "system" })),
    ...(state.tableTalk ?? []).map((line) => ({ id: `talk-${line.id}`, at: line.at, who: line.playerName, text: line.text, kind: "talk" })),
    ...state.aiInsights.map((insight) => ({ id: `ai-${insight.id}`, at: Date.parse(insight.at) - 1, who: insight.playerName, text: insight.explanation || insight.summary, kind: "reasoning" })),
  ].filter((entry) => !recorded.has(entry.id));
  entries.sort((a, b) => a.at - b.at);
  for (const entry of entries) {
    recorded.add(entry.id);
    record.add(entry);
  }
  if (reset) {
    const list = record.el.querySelector(".kit-transcript-list");
    list.scrollTop = list.scrollHeight;
  }
}

/* ---------- Render ---------- */

function render(previous = null) {
  if (!state) return;
  const castKey = state.players.map((player) => player.character?.id ?? player.name).join("|") + state.boardSize;
  const newGame = castKey !== lastSeen.castKey || state.moveNumber < lastSeen.moveNumber;
  if (newGame) highlighted = null;
  const { added, removed } = renderBoard(newGame ? null : previous?.board ?? null);
  for (const color of COLORS) renderSeat(color);
  renderStatus();
  renderNotice();
  renderReading();
  syncRecord(newGame);

  if (!newGame && lastSeen.moveNumber >= 0) {
    if (added) sound.pachi();
    if (removed) sound.capture(removed);
    if (state.moveNumber > lastSeen.moveNumber && state.lastMove?.action === "pass") sound.chime();
    if (state.humanCanAct && !lastSeen.humanTurn && state.moveNumber > 0) setTimeout(sound.chime, 260);
    if (state.phase === "complete" && lastSeen.phase === "active") sound.bell();
  }
  lastSeen = { moveNumber: state.moveNumber, phase: state.phase, castKey, humanTurn: state.humanCanAct };
}

let ready = false; // Rendering waits for the roster and model registry so labels are right the first time.
function accept(next) {
  const previous = state;
  state = next;
  if (!state?.aiThinking) liveSummary = "";
  if (ready) render(previous);
}

/* ---------- Actions ---------- */

async function act(action, row = null, column = null) {
  if (busy) return;
  busy = true;
  render(state);
  try {
    accept(await request("/api/go/action", { action, row, column }));
  } catch (error) {
    toast(error.message, { tone: "error" });
  } finally {
    busy = false;
    render(state);
  }
}

async function retryAI() {
  try {
    accept(await request("/api/go/retry-ai", {}));
  } catch (error) {
    toast(error.message, { tone: "error" });
  }
}

async function askReview(color) {
  try {
    accept(await request("/api/go/review", { color }, { track: false }));
  } catch (error) {
    toast(error.message, { tone: "error" });
    try {
      accept(await request("/api/go/state"));
    } catch {
      // The state stream will catch up.
    }
  }
}

const ARROWS = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
el.hits.addEventListener("keydown", (event) => {
  const step = ARROWS[event.key];
  const from = event.target.closest(".hit");
  if (!step || !from || !state) return;
  event.preventDefault();
  let row = Number(from.dataset.row);
  let column = Number(from.dataset.column);
  for (;;) {
    row += step[0];
    column += step[1];
    const next = hitAt(row, column);
    if (!next) return;
    if (next.disabled) continue;
    from.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
    focusPoint = { row, column };
    return;
  }
});
el.hits.addEventListener("focusin", (event) => {
  const hit = event.target.closest(".hit");
  if (hit) focusPoint = { row: Number(hit.dataset.row), column: Number(hit.dataset.column) };
});

el.hits.addEventListener("click", (event) => {
  const hit = event.target.closest(".hit");
  if (!hit || hit.disabled || !state?.humanCanAct) return;
  act("place", Number(hit.dataset.row), Number(hit.dataset.column));
});
el.pass.addEventListener("click", () => act("pass"));
el.resign.addEventListener("click", () => {
  if (el.resign.dataset.armed === "true") {
    el.resign.dataset.armed = "false";
    el.resign.textContent = "Resign";
    act("resign");
    return;
  }
  el.resign.dataset.armed = "true";
  el.resign.textContent = "Confirm resign";
  setTimeout(() => {
    el.resign.dataset.armed = "false";
    el.resign.textContent = "Resign";
  }, 3500);
});
el.save.addEventListener("click", async () => {
  try {
    accept(await request("/api/go/save", {}));
    toast(`Saved at ${new Date(state.save.savedAt).toLocaleTimeString()}.`, { tone: "success" });
  } catch (error) {
    toast(error.message, { tone: "error" });
  }
});
el.arena.addEventListener("click", async () => {
  try {
    accept(await request(state.arena.paused ? "/api/go/arena/resume" : "/api/go/arena/pause", {}));
  } catch (error) {
    toast(error.message, { tone: "error" });
  }
});

/* ---------- Setup drawer ---------- */

const setup = drawer({ title: "Set the board", open: false });
setup.el.classList.add("shoji");
setup.toggleButton.textContent = "New game";
setup.toggleButton.classList.add("new-game");
const form = document.createElement("form");
form.className = "setup";
form.innerHTML = `
  <fieldset class="seg" data-name="gameMode">
    <legend>Mode</legend>
    <label><input type="radio" name="gameMode" value="human" checked /><span>Play vs AI</span></label>
    <label><input type="radio" name="gameMode" value="arena" /><span>AI arena</span></label>
  </fieldset>
  <div class="human-only two">
    <label class="field"><span>Your name</span><input class="kit-input" name="humanName" maxlength="18" value="Player" autocomplete="nickname" /></label>
    <fieldset class="seg compact">
      <legend>Your stones</legend>
      <label><input type="radio" name="humanColor" value="black" checked /><span>Black</span></label>
      <label><input type="radio" name="humanColor" value="white" /><span>White</span></label>
    </fieldset>
  </div>
  <div class="two">
    <fieldset class="seg compact">
      <legend>Board</legend>
      <label><input type="radio" name="boardSize" value="9" checked /><span>9</span></label>
      <label><input type="radio" name="boardSize" value="13" /><span>13</span></label>
      <label><input type="radio" name="boardSize" value="19" /><span>19</span></label>
    </fieldset>
    <label class="field"><span>Komi</span><select class="kit-select" name="komi"><option value="5.5">5.5</option><option value="6.5">6.5</option><option value="7.5" selected>7.5</option></select></label>
  </div>
  <div class="cast-block"><p class="setup-label">Guests at the board</p><div class="cast"></div><div class="seat-models"></div></div>
  <button class="kit-button start" type="submit">Begin</button>
  <p class="setup-note">Chinese area scoring, positional superko, no suicide. Every move is saved. Illegal model moves retry twice, then the game pauses for you.</p>`;
setup.body.append(form);

let cast = null;
let seatModels = [];

function mode() {
  return form.elements.gameMode.value === "arena" ? "arena" : "human";
}

function seatColors() {
  if (mode() === "arena") return ["black", "white"];
  return [opposite(form.elements.humanColor.value === "white" ? "white" : "black")];
}

function syncSetup() {
  const colors = seatColors();
  form.querySelector(".human-only").hidden = mode() === "arena";
  if (cast) {
    if (cast.value.length !== colors.length) cast.setSeats(colors.length);
    const models = form.querySelector(".seat-models");
    const values = seatModels.map((picker) => picker.value);
    seatModels = colors.map((color, index) =>
      modelPicker({ registry, value: values[index] ?? registry.defaultConfig, label: `${capitalize(color)} seat` }),
    );
    models.replaceChildren(
      ...seatModels.map((picker, index) => {
        const row = document.createElement("div");
        row.className = "seat-model";
        const label = document.createElement("span");
        label.className = "seat-model-label";
        label.innerHTML = `<i class="seat-stone ${colors[index]}"></i>${cast.characters[index]?.shortName ?? cast.characters[index]?.name ?? "Seat"} · ${colors[index]}`;
        row.append(label, picker.el);
        return row;
      }),
    );
    form.querySelectorAll(".kit-pick-row").forEach((row, index) => {
      row.dataset.color = colors[index];
    });
  }
  form.querySelector(".start").textContent = mode() === "arena" ? "Open the arena" : `Sit down as ${form.elements.humanColor.value === "white" ? "White" : "Black"}`;
}

form.addEventListener("change", (event) => {
  if (event.target.name === "gameMode" || event.target.name === "humanColor") syncSetup();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const start = form.querySelector(".start");
  start.disabled = true;
  start.textContent = "Setting the stones…";
  const ids = cast.value;
  try {
    const next = await request("/api/go/game", {
      gameMode: mode(),
      humanName: form.elements.humanName.value,
      humanColor: form.elements.humanColor.value,
      boardSize: Number(form.elements.boardSize.value),
      komi: Number(form.elements.komi.value),
      aiPlayers: seatModels.map((picker, index) => ({ ...picker.value, characterId: ids[index] })),
    });
    setup.close();
    accept(next);
  } catch (error) {
    toast(error.message, { tone: "error" });
  } finally {
    start.disabled = false;
    syncSetup();
  }
});

async function openSetup() {
  if (state?.gameMode === "arena" && state.phase === "active" && !state.arena.paused) {
    try {
      accept(await request("/api/go/arena/pause", {}));
    } catch (error) {
      toast(error.message, { tone: "error" });
    }
  }
  setup.open();
  sound.tok();
}

setup.toggleButton.addEventListener("click", () => {
  if (setup.el.dataset.open === "true") sound.tok();
});

/* ---------- Live updates ---------- */

const events = new EventSource("/api/go/events");
events.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "state" && requestsInFlight === 0) accept(message.payload);
  else if (message.type === "ai_stream") {
    if (message.payload.phase === "started") liveSummary = "";
    if (message.payload.phase === "summary_delta") liveSummary += message.payload.delta;
    if (message.payload.phase === "completed") liveSummary = message.payload.summary || liveSummary;
    if (state) renderReading();
  } else if (message.type === "table_talk") {
    const card = el.seats[message.payload.speaker];
    if (card?.childElementCount) speak(card, message.payload.text, { placement: isWide() ? "right" : "bottom" });
  }
};
events.onerror = () => {
  if (events.readyState === EventSource.CLOSED) toast("Live updates disconnected. Reload the room.", { tone: "error" });
};

setInterval(() => {
  if (state?.aiThinking) renderReading();
}, 1000);

matchMedia("(min-width: 1100px)").addEventListener("change", () => {
  for (const card of Object.values(el.seats)) card.dataset.key = "";
  if (state) render(state);
});

/* ---------- Boot ---------- */

async function boot() {
  el.topbarLeft.append(backToLobby({ label: "Playground" }));
  el.topbarRight.append(sfx.muteButton(), setup.toggleButton);
  buildBoard(9);
  try {
    [characters, registry] = await Promise.all([loadCharacters(), loadModels()]);
    cast = characterPicker({ characters, seats: 1, onChange: () => syncSetup() });
    form.querySelector(".cast").append(cast.el);
    syncSetup();
  } catch (error) {
    toast(`The guest list did not load: ${error.message}`, { tone: "error" });
  }
  ready = true;
  if (state) render(null);
  try {
    const current = await request("/api/go/state");
    if (current) accept(current);
    else setup.open();
  } catch (error) {
    toast(error.message, { tone: "error" });
    setup.open();
  }
}

boot();
