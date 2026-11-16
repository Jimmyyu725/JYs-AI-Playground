// Wuziqi 五子棋 — the scholar's study. The server is authoritative; this page renders state and sends intents.
import { backToLobby, characterPicker, drawer, loadCharacters, loadModels, modelPicker, prefersReducedMotion, seat, toast, transcript } from "/shared/kit.js";
import { sfx } from "/shared/sfx.js";
import { speak } from "/shared/speech.js";

const COLORS = ["black", "white"];
const STONE_NAME = { black: "Ink", white: "Jade" };
const SUMMARY_SOURCE = { openai_reasoning_summary: "reasoning summary", deepseek_reasoning_content: "raw reasoning", public_decision_rationale: "public rationale" };
const $ = (id) => document.getElementById(id);

const ui = {
  room: $("study-room"),
  moveNumber: $("move-number"),
  sheet: $("sheet"),
  lines: $("sheet-lines"),
  stars: $("sheet-stars"),
  ink: $("sheet-ink"),
  sealLayer: $("sheet-seal"),
  board: $("board"),
  empty: $("sheet-empty"),
  turnLine: $("turn-line"),
  plates: { black: $("plate-black"), white: $("plate-white") },
  liveLeaf: $("live-leaf"),
  liveKicker: $("live-kicker"),
  liveTimer: $("live-timer"),
  liveName: $("live-name"),
  liveStatus: $("live-status"),
  liveSummary: $("live-summary"),
  pauseLeaf: $("pause-leaf"),
  pauseName: $("pause-name"),
  pauseMessage: $("pause-message"),
  retry: $("retry-button"),
  resultLeaf: $("result-leaf"),
  resultKicker: $("result-kicker"),
  resultTitle: $("result-title"),
  resultCopy: $("result-copy"),
  reviewActions: $("review-actions"),
  review: $("review"),
  newGame: $("new-game-button"),
  arenaToggle: $("arena-toggle"),
  resign: $("resign-button"),
  record: $("record"),
};

let state = null;
let liveSummary = "";
let requestsInFlight = 0;
let builtSize = 0;
let plateKey = "";
let gameKey = "";
let lastSoundedMove = -1;
let drawnVictoryKey = "";
let focusPoint = [7, 7];
const seenRecord = new Set();
const log = transcript({ title: "Brush record · 棋谱", limit: 240 });
ui.record.append(log.el);

/* ---------- Sound: shared kit clicks plus a guqin pluck for the ending ---------- */
let pluckContext = null;
function pluck(notes, { decay = 2, bend = 1 } = {}) {
  if (sfx.muted) return;
  try {
    pluckContext ??= new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    const ctx = pluckContext;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const out = ctx.createGain();
    out.gain.value = 0.18;
    out.connect(ctx.destination);
    notes.forEach((frequency, index) => {
      const start = ctx.currentTime + index * 0.09;
      for (const detune of [-4, 4]) {
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(frequency, start);
        osc.frequency.exponentialRampToValueAtTime(frequency * bend, start + decay);
        osc.detune.value = detune;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, start);
        env.gain.exponentialRampToValueAtTime(0.7, start + 0.008);
        env.gain.exponentialRampToValueAtTime(0.0001, start + decay);
        osc.connect(env).connect(out);
        osc.start(start);
        osc.stop(start + decay + 0.05);
      }
    });
  } catch {
    // Audio is decoration; a blocked AudioContext must never break the game.
  }
}

/* ---------- Server calls ---------- */
async function api(path, body) {
  requestsInFlight += 1;
  try {
    const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // Empty bodies are fine (GET /state before any game returns null).
    }
    if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
    return payload;
  } finally {
    requestsInFlight -= 1;
  }
}

function fail(error) {
  sfx.play("error");
  toast(error.message, { tone: "error" });
}

/* ---------- Board ---------- */
function starPoints(size) {
  const marks = size === 13 ? [3, 9] : size === 15 ? [3, 11] : [3, 15];
  const center = (size - 1) / 2;
  const points = [[center, center], ...marks.flatMap((row) => marks.map((column) => [row, column]))];
  if (size === 19) points.push([3, 9], [9, 3], [9, 15], [15, 9]);
  return points;
}

function buildBoard(size) {
  builtSize = size;
  ui.sheet.style.setProperty("--n", size);
  ui.stars.replaceChildren(
    ...starPoints(size).map(([row, column]) => {
      const dot = document.createElement("i");
      dot.style.setProperty("--r", row);
      dot.style.setProperty("--c", column);
      return dot;
    }),
  );
  const points = [];
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const point = document.createElement("button");
      point.type = "button";
      point.className = "point";
      point.dataset.row = row;
      point.dataset.column = column;
      point.tabIndex = -1;
      point.setAttribute("role", "gridcell");
      points.push(point);
    }
  }
  ui.board.replaceChildren(...points);
  focusPoint = [Math.floor(size / 2), Math.floor(size / 2)];
  ui.ink.replaceChildren();
  ui.sealLayer.replaceChildren();
  drawnVictoryKey = "";
}

function pointAt(row, column) {
  return ui.board.children[row * builtSize + column] ?? null;
}

function coordinate(row, column) {
  return `${"ABCDEFGHJKLMNOPQRST"[column]}${builtSize - row}`;
}

function renderBoard({ animate }) {
  if (builtSize !== state.boardSize) buildBoard(state.boardSize);
  const canAct = Boolean(state.humanCanAct);
  const humanColor = state.players.find((player) => player.isHuman)?.color ?? "black";
  ui.board.dataset.canAct = String(canAct);
  ui.board.dataset.ghost = humanColor;
  const winners = new Set((state.result?.winningLine ?? []).map(([row, column]) => `${row},${column}`));
  for (const point of ui.board.children) {
    const row = Number(point.dataset.row);
    const column = Number(point.dataset.column);
    const cell = state.board[row][column];
    let stone = point.firstElementChild;
    if (cell && stone?.dataset.color !== cell) {
      stone?.remove();
      stone = document.createElement("span");
      stone.className = "stone";
      stone.dataset.color = cell;
      if (animate && state.lastMove?.row === row && state.lastMove?.column === column) stone.classList.add("is-new");
      point.append(stone);
    } else if (!cell && stone) {
      stone.remove();
    }
    point.classList.toggle("is-last", state.lastMove?.row === row && state.lastMove?.column === column);
    point.classList.toggle("is-winning", winners.has(`${row},${column}`));
    point.disabled = !canAct || Boolean(cell);
    point.setAttribute("aria-label", `${coordinate(row, column)}, ${cell ? `${STONE_NAME[cell]} stone` : "empty"}`);
  }
  const [focusRow, focusColumn] = focusPoint;
  for (const point of ui.board.children) point.tabIndex = -1;
  const focusTarget = pointAt(Math.min(focusRow, builtSize - 1), Math.min(focusColumn, builtSize - 1));
  if (focusTarget) focusTarget.tabIndex = 0;
  if (animate && state.lastMove && state.lastMove.moveNumber !== lastSoundedMove) {
    lastSoundedMove = state.lastMove.moveNumber;
    sfx.play("stoneClick");
  }
  renderVictory(animate);
}

function renderVictory(animate) {
  const line = state.result?.reason === "five" ? state.result.winningLine : null;
  const key = line ? `${gameKey}:${line.map((point) => point.join(",")).join(";")}` : "";
  if (key === drawnVictoryKey) return;
  drawnVictoryKey = key;
  ui.ink.replaceChildren();
  ui.sealLayer.replaceChildren();
  if (!line) return;
  const [startRow, startColumn] = line[0];
  const [endRow, endColumn] = line[line.length - 1];
  const dRow = endRow - startRow;
  const dColumn = endColumn - startColumn;
  const span = Math.hypot(dRow, dColumn);
  const stroke = document.createElement("div");
  stroke.className = "victory-stroke";
  stroke.style.setProperty("--r0", startRow);
  stroke.style.setProperty("--c0", startColumn);
  stroke.style.setProperty("--len", (span + 1.9).toFixed(3));
  stroke.style.setProperty("--angle", `${(Math.atan2(dRow, dColumn) * 180) / Math.PI}deg`);
  stroke.dataset.color = state.result.winner;

  const unitRow = span ? dRow / span : 0;
  const unitColumn = span ? dColumn / span : 1;
  const clamp = (value) => Math.max(0.7, Math.min(builtSize - 1.7, value));
  let sealRow = endRow + unitRow * 1.4 + unitColumn * 0.9;
  let sealColumn = endColumn + unitColumn * 1.4 - unitRow * 0.9;
  if (sealRow < 0 || sealRow > builtSize - 1 || sealColumn < 0 || sealColumn > builtSize - 1) {
    sealRow = startRow - unitRow * 1.4 + unitColumn * 0.9;
    sealColumn = startColumn - unitColumn * 1.4 - unitRow * 0.9;
  }
  const seal = document.createElement("div");
  seal.className = "victory-seal";
  seal.lang = "zh-Hans";
  seal.textContent = "胜";
  seal.style.setProperty("--r", clamp(sealRow).toFixed(2));
  seal.style.setProperty("--c", clamp(sealColumn).toFixed(2));
  if (!animate || prefersReducedMotion()) {
    stroke.classList.add("is-static");
    seal.classList.add("is-static");
  } else {
    seal.addEventListener("animationstart", () => setTimeout(() => sfx.play("cupSlam"), 260), { once: true });
  }
  ui.ink.append(stroke);
  ui.sealLayer.append(seal);
}

function placeFromPoint(point) {
  if (!point || point.disabled || !state?.humanCanAct) return;
  focusPoint = [Number(point.dataset.row), Number(point.dataset.column)];
  act({ action: "place", row: focusPoint[0], column: focusPoint[1] });
}

ui.board.addEventListener("click", (event) => placeFromPoint(event.target.closest(".point")));
ui.board.addEventListener("keydown", (event) => {
  const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  if (!moves[event.key] || !builtSize) return;
  event.preventDefault();
  const [dRow, dColumn] = moves[event.key];
  focusPoint = [Math.max(0, Math.min(builtSize - 1, focusPoint[0] + dRow)), Math.max(0, Math.min(builtSize - 1, focusPoint[1] + dColumn))];
  for (const point of ui.board.children) point.tabIndex = -1;
  const target = pointAt(...focusPoint);
  target.tabIndex = 0;
  target.focus();
});
let lastRustle = 0;
ui.board.addEventListener("pointerover", (event) => {
  const point = event.target.closest(".point");
  if (!point || point.disabled || performance.now() - lastRustle < 150) return;
  lastRustle = performance.now();
  point.classList.add("is-hover-bleed");
  setTimeout(() => point.classList.remove("is-hover-bleed"), 400);
});

/* ---------- Players ---------- */
function modelLabel(config) {
  if (!config) return "";
  const entry = registry?.models.find((model) => model.id === config.model);
  return `${entry?.shortLabel ?? entry?.label ?? config.model} · ${config.reasoningEffort}`;
}

function buildPlates() {
  for (const color of COLORS) {
    const player = state.players.find((candidate) => candidate.color === color);
    const plate = ui.plates[color];
    const character = player.character ? characters?.find((entry) => entry.id === player.character.id) ?? player.character : null;
    const portrait = seat({ character, name: player.name, caption: player.isHuman ? "House guest" : character?.title ?? "", size: "md" });
    const body = document.createElement("div");
    body.className = "plate-body";
    const stoneLine = document.createElement("span");
    stoneLine.className = "plate-stone";
    stoneLine.innerHTML = `<i data-color="${color}"></i>${STONE_NAME[color]} · ${color === "black" ? "first" : "second"}`;
    const model = document.createElement("span");
    model.className = "plate-model";
    model.textContent = player.isHuman ? "Your brush, your judgment" : modelLabel(player.aiConfig);
    const count = document.createElement("span");
    count.className = "plate-count";
    body.append(stoneLine, model, count);
    const chop = document.createElement("span");
    chop.className = "plate-chop";
    chop.lang = "zh-Hans";
    chop.textContent = "行";
    chop.title = "To move";
    plate.replaceChildren(portrait, body, chop);
    plate.dataset.human = String(player.isHuman);
  }
}

function renderPlates() {
  const key = `${gameKey}|${state.players.map((player) => `${player.color}:${player.name}:${player.aiConfig?.model}:${player.aiConfig?.reasoningEffort}`).join("|")}`;
  if (key !== plateKey) {
    plateKey = key;
    buildPlates();
  }
  const flat = state.board.flat();
  for (const color of COLORS) {
    const plate = ui.plates[color];
    const active = state.phase === "active" && state.currentColor === color;
    plate.dataset.active = String(active);
    const portrait = plate.querySelector(".kit-seat");
    portrait.dataset.active = String(active);
    // Expression drives CSS only: not every character has every expression painted yet.
    let expression = "neutral";
    if (state.aiThinking?.color === color) expression = "thinking";
    if (state.phase === "complete" && state.result?.winner) expression = state.result.winner === color ? "triumphant" : "defeated";
    plate.dataset.expression = expression;
    portrait.dataset.expression = expression;
    plate.querySelector(".plate-count").textContent = `${stoneCount(flat.filter((cell) => cell === color).length)} on the paper`;
  }
}

function stoneCount(count) {
  return `${count} ${count === 1 ? "stone" : "stones"}`;
}

/** Reasoning summaries often arrive as Markdown; the record shows plain prose. */
function plainSummary(text) {
  return String(text ?? "").replace(/[‘’]/g, "'").replace(/\*\*([^*]+)\*\*\s*/g, "$1 — ").replace(/[*_`#]+/g, "").replace(/\s+/g, " ").trim();
}

/* ---------- Rail ---------- */
function playerOf(color) {
  return state.players.find((player) => player.color === color);
}

function resultText() {
  const result = state.result;
  if (!result) return { kicker: "", title: "", copy: "" };
  if (result.reason === "draw") return { kicker: "和棋 · Draw", title: "The paper is full", copy: "Neither side found five. The game is drawn." };
  const winner = playerOf(result.winner);
  const loser = playerOf(result.winner === "black" ? "white" : "black");
  const youWon = winner.isHuman;
  const youLost = loser.isHuman;
  const kicker = youWon ? "胜 · You win" : youLost ? "负 · You lose" : "胜负 · Result";
  if (result.reason === "resignation") return { kicker, title: `${winner.name} wins`, copy: `${loser.name} laid down the brush and resigned after ${state.moveNumber} moves.` };
  return { kicker, title: `${winner.name} wins`, copy: `${STONE_NAME[result.winner]} joined ${result.winningLine.length} stones in a row on move ${state.moveNumber}.` };
}

function renderReview() {
  const review = state.review;
  ui.reviewActions.replaceChildren();
  ui.review.hidden = !review;
  if (!review || review.status === "error") {
    for (const player of state.players.filter((candidate) => !candidate.isHuman)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost-button";
      button.textContent = `Ask ${player.character?.shortName ?? player.name} to review this game`;
      button.addEventListener("click", () => requestReview(player.color, button));
      ui.reviewActions.append(button);
    }
  }
  if (!review) return;
  ui.review.replaceChildren();
  const who = document.createElement("strong");
  who.textContent = `${review.playerName}'s notes`;
  ui.review.append(who);
  if (review.status === "pending") {
    const pending = document.createElement("p");
    pending.className = "review-pending";
    pending.textContent = "Grinding ink and replaying the game…";
    ui.review.append(pending);
    return;
  }
  if (review.status === "error") {
    const error = document.createElement("p");
    error.className = "review-error";
    error.textContent = `The review failed: ${review.error}`;
    ui.review.append(error);
    return;
  }
  const verdict = document.createElement("p");
  verdict.className = "review-verdict";
  verdict.textContent = review.verdict;
  const moments = document.createElement("ol");
  moments.className = "review-moments";
  for (const moment of review.keyMoments ?? []) {
    const item = document.createElement("li");
    const move = state.moves?.[moment.moveNumber - 1];
    const label = document.createElement("b");
    label.textContent = `Move ${moment.moveNumber}${move ? ` · ${move.coordinate}` : ""}`;
    const text = document.createElement("span");
    text.textContent = moment.comment;
    item.append(label, text);
    if (move) {
      item.tabIndex = 0;
      const flash = () => {
        const point = pointAt(move.row, move.column);
        point?.classList.remove("is-recalled");
        void point?.offsetWidth;
        point?.classList.add("is-recalled");
      };
      item.addEventListener("pointerenter", flash);
      item.addEventListener("focus", flash);
    }
    moments.append(item);
  }
  const lesson = document.createElement("p");
  lesson.className = "review-lesson";
  lesson.textContent = review.lesson;
  ui.review.append(verdict, moments, lesson);
}

async function requestReview(color, button) {
  button.disabled = true;
  try {
    state = await api("/api/wuziqi/review", { color });
    render();
  } catch (error) {
    button.disabled = false;
    fail(error);
  }
}

function renderRail() {
  const thinking = state.aiThinking;
  ui.liveLeaf.hidden = !thinking;
  if (thinking) {
    const player = playerOf(thinking.color);
    ui.liveKicker.textContent = `${STONE_NAME[thinking.color]} is reading the board`;
    ui.liveName.textContent = `${player?.name ?? thinking.playerName} · ${modelLabel(player?.aiConfig)}`;
    ui.liveStatus.textContent = thinking.status ?? "Thinking…";
    ui.liveSummary.textContent = plainSummary(liveSummary) || "Waiting for the first brushstroke of reasoning…";
    tickTimer();
  }
  ui.pauseLeaf.hidden = !state.aiError;
  if (state.aiError) {
    ui.pauseName.textContent = `${state.aiError.playerName} could not move`;
    ui.pauseMessage.textContent = state.aiError.message;
  }
  const complete = state.phase === "complete";
  ui.resultLeaf.hidden = !complete;
  if (complete) {
    const text = resultText();
    ui.resultKicker.textContent = text.kicker;
    ui.resultTitle.textContent = text.title;
    ui.resultCopy.textContent = text.copy;
    renderReview();
  }
  ui.arenaToggle.hidden = state.gameMode !== "arena" || complete;
  ui.arenaToggle.textContent = state.arena?.paused ? "Resume the arena" : "Pause the arena";
  ui.resign.hidden = state.gameMode === "arena" || complete;
  ui.resign.disabled = !state.humanCanAct;
}

function tickTimer() {
  if (!state?.aiThinking?.startedAt) return;
  const seconds = Math.max(0, Math.round((Date.now() - state.aiThinking.startedAt) / 1000));
  ui.liveTimer.textContent = `${seconds}s`;
}
setInterval(tickTimer, 1000);

function renderTurnLine() {
  if (state.phase === "complete") {
    ui.turnLine.textContent = resultText().title + ".";
    return;
  }
  const actor = playerOf(state.currentColor);
  const stone = STONE_NAME[state.currentColor];
  if (state.aiError) ui.turnLine.textContent = `Paused — ${state.aiError.playerName}'s request needs a retry.`;
  else if (state.arena?.paused) ui.turnLine.textContent = `Arena paused with ${stone} to move.`;
  else if (actor?.isHuman) ui.turnLine.textContent = `Your move — place a${stone === "Ink" ? "n ink" : " jade"} stone.`;
  else ui.turnLine.textContent = `${stone} to move — ${actor?.name} is reading the board…`;
}

/* ---------- Brush record (transcript) ---------- */
function recordEntries() {
  const entries = [];
  for (const entry of state.logs ?? []) {
    if (seenRecord.has(entry.id)) continue;
    const kind = entry.kind === "move" ? "move" : entry.kind === "result" ? "result" : entry.kind === "error" ? "error" : "system";
    entries.push({ id: entry.id, at: Date.parse(entry.at), who: entry.kind === "move" ? `${entry.moveNumber}.` : "", text: entry.text, kind });
  }
  for (const insight of state.aiInsights ?? []) {
    if (seenRecord.has(insight.id)) continue;
    const source = SUMMARY_SOURCE[insight.summarySource] ?? "rationale";
    entries.push({ id: insight.id, at: Date.parse(insight.at) - 1, who: insight.playerName, text: `${plainSummary(insight.summary || insight.explanation)} (${source}, ${(insight.latencyMs / 1000).toFixed(1)}s)`, kind: "reasoning" });
  }
  for (const talk of state.tableTalk ?? []) {
    if (seenRecord.has(talk.id)) continue;
    entries.push({ id: talk.id, at: talk.at, who: talk.playerName, text: talk.text, kind: "talk" });
  }
  return entries.sort((a, b) => a.at - b.at);
}

function renderRecord() {
  for (const entry of recordEntries()) {
    seenRecord.add(entry.id);
    const item = log.add({ who: entry.who, text: entry.text, kind: entry.kind === "result" || entry.kind === "error" ? "system" : entry.kind });
    item.dataset.tone = entry.kind;
    if (entry.kind === "reasoning") {
      item.tabIndex = 0;
      item.title = "Show the whole summary";
      const toggle = () => item.toggleAttribute("data-expanded");
      item.addEventListener("click", toggle);
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      });
    }
  }
}

/* ---------- Render ---------- */
let gameSerial = 0;
let beginsId = null;
function openingLogId(next) {
  const oldest = next.logs?.[next.logs.length - 1];
  return oldest?.moveNumber === 0 ? oldest.id : null;
}
function seatingOf(next) {
  return `${next.gameMode}|${next.boardSize}|${next.players.map((player) => `${player.color}:${player.name}`).join("/")}`;
}
/** True when `next` is a different game from the one on screen (the log can be truncated, so no single id suffices). */
function isNewGame(next) {
  if (!state) return true;
  if (seatingOf(next) !== seatingOf(state) || next.moveNumber < state.moveNumber) return true;
  const opening = openingLogId(next);
  return Boolean(opening && beginsId && opening !== beginsId);
}

function render({ animate = true, forceNew = false } = {}) {
  if (!state) {
    ui.room.dataset.phase = "idle";
    return;
  }
  if (forceNew) {
    gameSerial += 1;
    gameKey = String(gameSerial);
    beginsId = openingLogId(state);
    log.clear();
    seenRecord.clear();
    builtSize = 0;
    lastSoundedMove = state.lastMove?.moveNumber ?? -1;
    animate = false;
  }
  ui.room.dataset.phase = state.phase;
  ui.room.dataset.mode = state.gameMode;
  ui.moveNumber.textContent = state.moveNumber;
  renderBoard({ animate });
  renderPlates();
  renderRail();
  renderTurnLine();
  renderRecord();
}

function applyState(next, options = {}) {
  const wasActive = state?.phase === "active";
  const fresh = isNewGame(next);
  const sameGame = !fresh;
  state = next;
  if (!beginsId) beginsId = openingLogId(next);
  render({ ...options, forceNew: fresh });
  if (sameGame && wasActive && state.phase === "complete") celebrate();
}

function celebrate() {
  const winner = state.result?.winner ? playerOf(state.result.winner) : null;
  const human = state.players.find((player) => player.isHuman);
  if (human && winner && !winner.isHuman) pluck([146.83], { decay: 1.6, bend: 0.82 });
  else pluck([196, 293.66], { decay: 2.2 });
}

/* ---------- Actions ---------- */
let acting = false;
async function act(body) {
  if (acting) return;
  acting = true;
  try {
    applyState(await api("/api/wuziqi/action", body));
    liveSummary = "";
  } catch (error) {
    fail(error);
  } finally {
    acting = false;
  }
}

ui.resign.addEventListener("click", () => {
  if (confirmResign()) act({ action: "resign" });
});
function confirmResign() {
  if (ui.resign.dataset.armed === "true") return true;
  ui.resign.dataset.armed = "true";
  ui.resign.textContent = "Click again to resign";
  setTimeout(() => {
    ui.resign.dataset.armed = "false";
    ui.resign.textContent = "Resign";
  }, 3000);
  return false;
}

ui.retry.addEventListener("click", async () => {
  ui.retry.disabled = true;
  try {
    applyState(await api("/api/wuziqi/retry-ai", {}));
  } catch (error) {
    fail(error);
  } finally {
    ui.retry.disabled = false;
  }
});

ui.arenaToggle.addEventListener("click", async () => {
  try {
    applyState(await api(state.arena?.paused ? "/api/wuziqi/arena/resume" : "/api/wuziqi/arena/pause", {}));
  } catch (error) {
    fail(error);
  }
});

/* ---------- Setup scroll ---------- */
let characters = null;
let registry = null;
let setup = null;
let cast = null;
let seatModels = [];

function setupMode(form) {
  return new FormData(form).get("gameMode") === "arena" ? "arena" : "human";
}

function seatColors(form) {
  if (setupMode(form) === "arena") return ["black", "white"];
  return [new FormData(form).get("humanColor") === "white" ? "black" : "white"];
}

function labelSeats(form) {
  const colors = seatColors(form);
  const names = cast.characters;
  form.querySelectorAll(".kit-pick-row").forEach((row, index) => {
    row.dataset.seatColor = colors[index] ?? "";
    row.dataset.seatLabel = STONE_NAME[colors[index]] ?? "";
  });
  seatModels.forEach((picker, index) => {
    picker.label.textContent = `${STONE_NAME[colors[index]]} · ${names[index]?.shortName ?? names[index]?.name ?? "AI"}`;
  });
}

function syncSetup(form) {
  const mode = setupMode(form);
  const colors = seatColors(form);
  form.dataset.mode = mode;
  form.querySelector("[data-human-only]").hidden = mode === "arena";
  form.querySelector("#cast-heading").textContent = mode === "arena" ? "At the table" : `Your opponent plays ${STONE_NAME[colors[0]]}`;
  form.querySelector("#setup-submit").textContent = mode === "arena" ? "Seat them and watch" : `Begin as ${STONE_NAME[colors[0] === "black" ? "white" : "black"]}`;
  if (cast.value.length !== colors.length) cast.setSeats(colors.length);
  const slot = form.querySelector("#model-slot");
  const previous = seatModels.map((picker) => picker.value);
  if (seatModels.length !== colors.length) {
    seatModels = colors.map((_, index) => {
      const wrap = document.createElement("div");
      wrap.className = "setup-model";
      const label = document.createElement("span");
      label.className = "setup-model-label";
      const picker = modelPicker({ registry, value: previous[index] ?? previous[0] ?? registry.defaultConfig, label: `Seat ${index + 1}` });
      wrap.append(label, picker.el);
      return { wrap, label, get value() { return picker.value; } };
    });
    slot.replaceChildren(...seatModels.map((picker) => picker.wrap));
  }
  labelSeats(form);
}

async function pauseRunningArena() {
  if (state?.gameMode === "arena" && state.phase === "active" && !state.arena?.paused) {
    try {
      applyState(await api("/api/wuziqi/arena/pause", {}));
      toast("Arena paused while the setup scroll is open.");
    } catch (error) {
      fail(error);
    }
  }
}

async function buildSetup() {
  [characters, registry] = await Promise.all([loadCharacters(), loadModels()]);
  setup = drawer({ title: "Setup scroll · 布局", open: false });
  setup.el.classList.add("scroll-drawer");
  setup.toggleButton.textContent = "New board";
  setup.toggleButton.classList.add("seal-toggle");
  // Opening the scroll during a running arena pauses it, so nothing is missed while choosing.
  setup.toggleButton.addEventListener("click", () => {
    if (setup.el.dataset.open !== "true") pauseRunningArena();
  }, { capture: true });
  const form = $("setup-template").content.firstElementChild.cloneNode(true);
  cast = characterPicker({ characters, seats: 1, onChange: () => labelSeats(form) });
  form.querySelector("#cast-slot").append(cast.el);
  setup.body.append(form);
  form.addEventListener("change", (event) => {
    if (event.target.name === "gameMode" || event.target.name === "humanColor") syncSetup(form);
  });
  syncSetup(form);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("#setup-submit");
    const data = new FormData(form);
    const payload = {
      gameMode: setupMode(form),
      humanName: data.get("humanName"),
      humanColor: data.get("humanColor"),
      boardSize: Number(data.get("boardSize")),
      aiPlayers: cast.value.map((characterId, index) => ({ ...seatModels[index].value, characterId })),
    };
    submit.disabled = true;
    const label = submit.textContent;
    submit.textContent = "Grinding ink…";
    const previous = state;
    try {
      liveSummary = "";
      state = null;
      const next = await api("/api/wuziqi/game", payload);
      applyState(next, { animate: false });
      setup.close();
      sfx.play("stoneClick");
    } catch (error) {
      state ??= previous;
      fail(error);
    } finally {
      submit.disabled = false;
      submit.textContent = label;
    }
  });
  ui.newGame.addEventListener("click", () => {
    cast.setSeats(cast.value.length);
    for (let index = 0; index < cast.value.length; index += 1) cast.reroll(index);
    setup.open();
  });
  return setup;
}

/* ---------- Live updates ---------- */
function seatFor(color) {
  return ui.plates[color]?.querySelector(".kit-seat") ?? null;
}

function connect() {
  const events = new EventSource("/api/wuziqi/events");
  events.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    const { type, payload } = message;
    if (type === "state" && requestsInFlight === 0 && payload) {
      if (!payload.aiThinking) liveSummary = "";
      applyState(payload);
    } else if (type === "ai_stream") {
      if (payload.phase === "started") liveSummary = "";
      if (payload.phase === "summary_delta") liveSummary += payload.delta;
      if (payload.phase === "completed") liveSummary = payload.summary || liveSummary;
      if (state?.aiThinking) ui.liveSummary.textContent = plainSummary(liveSummary) || "Waiting for the first brushstroke of reasoning…";
    } else if (type === "table_talk") {
      const anchor = seatFor(payload.speaker);
      const narrow = matchMedia("(max-width: 1099px)").matches;
      speak(anchor, payload.text, { placement: narrow ? "bottom" : "right" });
      if (!seenRecord.has(payload.id)) {
        seenRecord.add(payload.id);
        log.add({ who: payload.playerName, text: payload.text, kind: "talk" }).dataset.tone = "talk";
      }
    }
  };
  let warned = false;
  events.onerror = () => {
    if (!warned) toast("Live updates dropped. Reconnecting…", { tone: "error" });
    warned = true;
  };
  events.onopen = () => {
    warned = false;
  };
}

/* ---------- Boot ---------- */
async function boot() {
  $("masthead-left").append(backToLobby({ label: "Playground" }));
  const right = $("masthead-right");
  right.append(sfx.muteButton());
  try {
    await buildSetup();
    right.append(setup.toggleButton);
  } catch (error) {
    fail(error);
  }
  try {
    const current = await api("/api/wuziqi/state");
    if (current) applyState(current, { animate: false });
    else setup?.open();
  } catch (error) {
    fail(error);
  }
  connect();
}

boot();
