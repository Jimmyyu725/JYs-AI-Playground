// Xiangqi 象棋 room client. The server is authoritative: this page renders state from
// /api/xiangqi/* and sends intents (start, move, resign, retry, arena pause/resume).

import { backToLobby, characterPicker, drawer, loadCharacters, loadModels, modelPicker, prefersReducedMotion, seat, toast } from "/shared/kit.js";
import { sfx } from "/shared/sfx.js";
import { bindTableTalk } from "/shared/speech.js";

const GLYPHS = {
  red: { K: "帥", A: "仕", B: "相", N: "傌", R: "俥", C: "炮", P: "兵" },
  black: { K: "將", A: "士", B: "象", N: "馬", R: "車", C: "砲", P: "卒" },
};
const PIECE_NAMES = { K: "General", A: "Advisor", B: "Elephant", N: "Horse", R: "Chariot", C: "Cannon", P: "Soldier" };
const CN_DIGITS = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
const FILES = "abcdefghi";
const INITIAL_FEN = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR";
const SIDE_LABEL = { red: "Red", black: "Black" };

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

let state = null;
let previous = null;
let characters = [];
let registry = null;
let selected = null; // square index of the selected human piece
let liveSummary = "";
let busy = false;
let resultDismissedFor = null;
const seatElements = { red: null, black: null };

// ---------------------------------------------------------------------------
// Board geometry

const sideOf = (piece) => (piece === piece.toUpperCase() ? "red" : "black");
const squareOf = (iccs) => Number(iccs[1]) * 9 + FILES.indexOf(iccs[0]);
const iccsOf = (square) => `${FILES[square % 9]}${Math.floor(square / 9)}`;
const bottomSide = () => state?.humanSide ?? "red";

function displayXY(square) {
  const file = square % 9;
  const rank = Math.floor(square / 9);
  return bottomSide() === "red" ? { x: file, y: 9 - rank } : { x: 8 - file, y: rank };
}

function place(node, square) {
  const { x, y } = displayXY(square);
  node.style.setProperty("--x", x);
  node.style.setProperty("--y", y);
}

function drawGrid() {
  const svg = $("grid");
  const at = (v) => 50 + v * 100;
  const lines = [];
  for (let y = 0; y < 10; y += 1) lines.push(`<line x1="50" y1="${at(y)}" x2="850" y2="${at(y)}"/>`);
  for (let x = 0; x < 9; x += 1) {
    if (x === 0 || x === 8) lines.push(`<line x1="${at(x)}" y1="50" x2="${at(x)}" y2="950"/>`);
    else lines.push(`<line x1="${at(x)}" y1="50" x2="${at(x)}" y2="450"/><line x1="${at(x)}" y1="550" x2="${at(x)}" y2="950"/>`);
  }
  // Palaces.
  lines.push('<line x1="350" y1="50" x2="550" y2="250"/><line x1="550" y1="50" x2="350" y2="250"/>');
  lines.push('<line x1="350" y1="750" x2="550" y2="950"/><line x1="550" y1="750" x2="350" y2="950"/>');
  // Cannon and soldier position marks.
  const marks = [[1, 2], [7, 2], [1, 7], [7, 7], [0, 3], [2, 3], [4, 3], [6, 3], [8, 3], [0, 6], [2, 6], [4, 6], [6, 6], [8, 6]];
  const ticks = [];
  for (const [x, y] of marks) {
    const cx = at(x);
    const cy = at(y);
    for (const dx of [-1, 1]) {
      if ((x === 0 && dx < 0) || (x === 8 && dx > 0)) continue;
      for (const dy of [-1, 1]) {
        const sx = cx + dx * 9;
        const sy = cy + dy * 9;
        ticks.push(`<path d="M${sx + dx * 18} ${sy}H${sx}V${sy + dy * 18}"/>`);
      }
    }
  }
  svg.innerHTML = `<rect class="grid-border" x="34" y="34" width="832" height="932" rx="2"/><g class="grid-lines">${lines.join("")}</g><g class="grid-ticks">${ticks.join("")}</g>`;
}

// ---------------------------------------------------------------------------
// Traditional notation (炮二平五 / 馬8進7), computed by replaying the move list.

function parseBoard(fen) {
  const board = new Array(90).fill(null);
  fen.split("/").forEach((row, index) => {
    const rank = 9 - index;
    let file = 0;
    for (const char of row) {
      if (/\d/.test(char)) file += Number(char);
      else board[rank * 9 + file++] = char;
    }
  });
  return board;
}

function notation(board, move) {
  const from = squareOf(move.slice(0, 2));
  const to = squareOf(move.slice(2, 4));
  const piece = board[from];
  if (!piece) return move;
  const side = sideOf(piece);
  const type = piece.toUpperCase();
  const glyph = GLYPHS[side][type];
  const [file, rank, toFile, toRank] = [from % 9, Math.floor(from / 9), to % 9, Math.floor(to / 9)];
  const fileNumber = (value) => (side === "red" ? 9 - value : value + 1);
  const numeral = (value) => (side === "red" ? CN_DIGITS[value - 1] : String(value));
  const ahead = (r) => (side === "red" ? r : -r);
  let prefix = `${glyph}${numeral(fileNumber(file))}`;
  const sameFile = [];
  for (let r = 0; r < 10; r += 1) if (board[r * 9 + file] === piece) sameFile.push(r);
  if (sameFile.length >= 2) {
    sameFile.sort((a, b) => ahead(b) - ahead(a));
    const index = sameFile.indexOf(rank);
    const labels = sameFile.length === 2 ? ["前", "後"] : sameFile.length === 3 ? ["前", "中", "後"] : CN_DIGITS;
    prefix = `${labels[index]}${glyph}`;
  }
  if (toRank === rank) return `${prefix}平${numeral(fileNumber(toFile))}`;
  const action = ahead(toRank - rank) > 0 ? "進" : "退";
  const straight = "RCPK".includes(type);
  return `${prefix}${action}${numeral(straight ? Math.abs(toRank - rank) : fileNumber(toFile))}`;
}

function movesWithNotation(history) {
  const board = parseBoard(INITIAL_FEN);
  const rows = [];
  for (const entry of history) {
    if (entry.resigned) {
      rows.push({ ...entry, text: "認輸", english: `${SIDE_LABEL[entry.side]} resigns` });
      continue;
    }
    const text = notation(board, entry.move);
    const from = squareOf(entry.move.slice(0, 2));
    const to = squareOf(entry.move.slice(2, 4));
    board[to] = board[from];
    board[from] = null;
    rows.push({ ...entry, text });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Rendering

function playerFor(side) {
  return state?.players.find((player) => player.side === side) ?? null;
}

function modelLabel(config) {
  if (!config) return "";
  const entry = registry?.models.find((model) => model.id === config.model);
  return `${entry?.label ?? config.model} · ${config.reasoningEffort}`;
}

function pieceNode(piece, square) {
  const side = sideOf(piece);
  const type = piece.toUpperCase();
  const node = el("button", "piece");
  node.type = "button";
  node.dataset.side = side;
  node.dataset.type = type;
  node.dataset.square = square;
  node.setAttribute("aria-label", `${SIDE_LABEL[side]} ${PIECE_NAMES[type]} on ${iccsOf(square)}`);
  const glyph = el("span", "glyph", GLYPHS[side][type]);
  glyph.lang = "zh-Hant";
  node.append(glyph);
  place(node, square);
  return node;
}

function renderPieces(animate) {
  const layer = $("pieces");
  layer.replaceChildren();
  const last = state.lastMove && !state.lastMove.resigned ? state.lastMove : null;
  const moving = animate && last ? { from: squareOf(last.move.slice(0, 2)), to: squareOf(last.move.slice(2, 4)) } : null;
  state.board.forEach((piece, square) => {
    if (!piece) return;
    const node = pieceNode(piece, square);
    if (moving && square === moving.to) {
      place(node, moving.from);
      node.classList.add("is-moving");
      requestAnimationFrame(() => requestAnimationFrame(() => {
        place(node, moving.to);
        node.addEventListener("transitionend", () => node.classList.remove("is-moving"), { once: true });
        setTimeout(() => node.classList.remove("is-moving"), 500);
      }));
    }
    layer.append(node);
  });
  if (moving && last.captured) {
    const ghost = pieceNode(last.captured, moving.to);
    ghost.classList.add("is-captured");
    ghost.disabled = true;
    ghost.tabIndex = -1;
    layer.prepend(ghost);
    setTimeout(() => ghost.remove(), 700);
  }
}

function renderMarks() {
  const layer = $("marks");
  layer.replaceChildren();
  const last = state.lastMove && !state.lastMove.resigned ? state.lastMove : null;
  if (last) {
    for (const [key, iccs] of [["from", last.move.slice(0, 2)], ["to", last.move.slice(2, 4)]]) {
      const mark = el("span", `last-mark last-${key}`);
      place(mark, squareOf(iccs));
      layer.append(mark);
    }
  }
  document.querySelectorAll(".piece.is-selected, .piece.is-checked, .piece.is-movable").forEach((node) => node.classList.remove("is-selected", "is-checked", "is-movable"));
  const movableFrom = new Set((state.legalMoves ?? []).map((move) => move.from));
  for (const node of document.querySelectorAll("#pieces .piece:not(.is-captured)")) {
    if (movableFrom.has(iccsOf(Number(node.dataset.square)))) node.classList.add("is-movable");
  }
  if (state.inCheck) {
    const general = state.board.findIndex((piece) => piece === (state.turn === "red" ? "K" : "k"));
    document.querySelector(`#pieces .piece[data-square="${general}"]:not(.is-captured)`)?.classList.add("is-checked");
  }
  if (selected === null) return;
  document.querySelector(`#pieces .piece[data-square="${selected}"]`)?.classList.add("is-selected");
  for (const move of state.legalMoves.filter((candidate) => candidate.from === iccsOf(selected))) {
    const target = el("button", move.captured ? "target is-capture" : "target");
    target.type = "button";
    target.dataset.move = move.move;
    target.setAttribute("aria-label", `Move to ${move.to}${move.captured ? " and capture" : ""}${move.givesCheck ? ", check" : ""}`);
    place(target, squareOf(move.to));
    layer.append(target);
  }
}

function buildSeat(side) {
  const player = playerFor(side);
  const block = el("div", "seat-inner");
  block.dataset.side = side;
  const ring = el("div", "moon-ring");
  const seatNode = seat({
    character: player.character ?? undefined,
    name: player.name,
    caption: player.isHuman ? "You" : player.character?.title ?? "",
    size: "md",
  });
  seatNode.dataset.speaker = side;
  ring.append(seatNode);
  const meta = el("div", "seat-meta");
  meta.append(el("strong", "seat-name", player.name), el("span", "seat-title", player.isHuman ? "You, at the near side" : player.character?.title ?? ""));
  const sideTag = el("span", "side-tag", `${side === "red" ? "紅" : "黑"} · ${SIDE_LABEL[side]}${side === "red" ? " moves first" : ""}`);
  meta.append(sideTag);
  if (!player.isHuman) meta.append(el("span", "model-tag", modelLabel(player.aiConfig)));
  const tray = el("div", "tray");
  tray.setAttribute("aria-label", `Pieces ${SIDE_LABEL[side]} has captured`);
  block.append(ring, meta, tray);
  seatElements[side] = seatNode;
  return block;
}

function renderSeats(rebuild) {
  const top = bottomSide() === "red" ? "black" : "red";
  const slots = { [top]: $("seat-top"), [bottomSide()]: $("seat-bottom") };
  for (const side of ["red", "black"]) {
    if (rebuild || !slots[side].firstChild) slots[side].replaceChildren(buildSeat(side));
    const block = slots[side].firstChild;
    const active = state.status === "active" && state.turn === side;
    block.dataset.active = String(active);
    block.dataset.thinking = String(Boolean(state.aiThinking && state.aiThinking.side === side));
    const outcome = state.status === "complete" ? (state.result?.winner === side ? "triumphant" : state.result?.winner ? "defeated" : "neutral") : active && state.aiThinking ? "thinking" : "neutral";
    seatElements[side].dataset.expression = outcome;
    const tray = block.querySelector(".tray");
    const taken = state.captured?.[side === "red" ? "black" : "red"] ?? [];
    if (tray.childElementCount !== taken.length) {
      tray.replaceChildren(...taken.map((piece) => {
        const chip = el("span", "tray-piece", GLYPHS[sideOf(piece)][piece.toUpperCase()]);
        chip.dataset.side = sideOf(piece);
        chip.lang = "zh-Hant";
        return chip;
      }));
    }
  }
}

function humanPlayer() {
  return state?.players.find((player) => player.isHuman) ?? null;
}

function renderStatus() {
  const line = $("status-line");
  const thought = $("status-thought");
  const actions = $("status-actions");
  actions.replaceChildren();
  const human = humanPlayer();
  const card = $("status");
  card.dataset.tone = "";
  thought.textContent = "";
  if (state.status === "complete") {
    line.textContent = state.resultText ?? "The game is over.";
    card.dataset.tone = "done";
    actions.append(button("New game", () => setup.open()));
  } else if (state.aiError) {
    card.dataset.tone = "error";
    line.textContent = `${state.aiError.playerName} could not move: ${state.aiError.message}`;
    thought.textContent = "The table is paused. Nothing is played for them until you retry.";
    actions.append(button("Retry the AI move", retryAI, "primary"));
  } else if (state.aiThinking) {
    card.dataset.tone = "thinking";
    const player = playerFor(state.aiThinking.side);
    line.textContent = `${player?.name ?? "The AI"} is thinking… ${state.aiThinking.status ?? ""}`.trim();
    const clean = liveSummary.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ");
    thought.textContent = clean ? `“${clean.slice(-260).trim()}”` : "";
  } else if (state.gameMode === "arena" && state.arenaPaused) {
    line.textContent = "The arena is paused.";
  } else if (human && state.turn === human.side) {
    card.dataset.tone = state.inCheck ? "check" : "yours";
    line.textContent = state.inCheck ? "Check! Protect your general." : `Your move as ${SIDE_LABEL[human.side]}. Pick up a piece.`;
  } else {
    line.textContent = `${SIDE_LABEL[state.turn]} to move.`;
  }
  if (state.status === "active") {
    if (state.gameMode === "arena") {
      actions.append(button(state.arenaPaused ? "Resume arena" : "Pause arena", toggleArena));
    } else if (human) {
      actions.append(button("Resign", resign, "danger"));
    }
  }
}

function button(label, onClick, tone = "") {
  const node = el("button", `xq-button ${tone}`.trim(), label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function renderScroll() {
  const list = $("moves");
  const rows = movesWithNotation(state.history);
  $("move-count").textContent = rows.length ? `${Math.ceil(state.ply / 2)} moves` : "—";
  const insight = state.aiInsights?.at(-1);
  const box = $("insight");
  if (insight) {
    box.hidden = false;
    box.replaceChildren(el("strong", null, `${insight.playerName} on ${insight.move}`), el("span", null, insight.explanation));
  } else box.hidden = true;
  const fresh = list.childElementCount !== rows.length || list.dataset.game !== state.createdAt;
  if (!fresh) return;
  const appendOnly = list.dataset.game === state.createdAt && rows.length === list.childElementCount + 1;
  if (!appendOnly) list.replaceChildren();
  list.dataset.game = state.createdAt;
  for (const row of rows.slice(list.childElementCount)) {
    const item = el("li", "move-row");
    item.dataset.side = row.side;
    const number = el("span", "move-no", row.side === "red" || row.resigned ? `${Math.floor((row.ply - 1) / 2) + 1}.` : "");
    const text = el("span", "move-text", row.text);
    text.lang = "zh-Hant";
    const detail = el("span", "move-iccs", row.resigned ? row.english : `${row.move}${row.captured ? " ×" : ""}${row.check ? " +" : ""}`);
    item.append(number, text, detail);
    if (appendOnly) item.classList.add("is-new");
    list.append(item);
  }
  list.scrollTop = list.scrollHeight;
}

function renderResult() {
  const card = $("result");
  if (state.status !== "complete" || resultDismissedFor === state.createdAt) {
    card.hidden = true;
    return;
  }
  const human = humanPlayer();
  const winner = state.result?.winner;
  card.hidden = false;
  card.dataset.outcome = !winner ? "draw" : human ? (winner === human.side ? "win" : "loss") : "win";
  $("result-glyph").textContent = !winner ? "和" : human && winner !== human.side ? "負" : "勝";
  $("result-title").textContent = !winner ? "A drawn game" : `${playerFor(winner)?.name ?? SIDE_LABEL[winner]} wins`;
  $("result-copy").textContent = state.resultText ?? "";
}

function render() {
  if (!state) return;
  const sameGame = previous && previous.createdAt === state.createdAt && previous.humanSide === state.humanSide;
  const positionChanged = !sameGame || previous.ply !== state.ply || previous.status !== state.status;
  const animate = sameGame && state.ply === previous.ply + 1;
  document.body.dataset.flipped = String(bottomSide() === "black");
  document.body.dataset.mode = state.gameMode;
  if (!sameGame) selected = null;
  if (positionChanged) {
    selected = null;
    renderPieces(animate);
    if (animate) moveFeedback();
  }
  if (!sameGame) $("seal").classList.remove("is-stamped");
  renderSeats(!sameGame);
  renderMarks();
  renderStatus();
  renderScroll();
  renderResult();
  $("seal").classList.toggle("is-stamped", Boolean(state.inCheck));
  $("seal").firstElementChild.textContent = state.turn === "red" ? "帥" : "將";
  if (sameGame && previous.status === "active" && state.status === "complete") sfx.play("win");
  previous = state;
}

function moveFeedback() {
  const last = state.lastMove;
  if (!last || last.resigned) return;
  setTimeout(() => {
    sfx.play(last.captured ? "tileClack" : "stoneClick");
    if (last.check) pluck();
  }, prefersReducedMotion() ? 0 : 240);
}

// A low guqin-like pluck for "check", through its own tiny audio graph; respects the shared mute.
let pluckContext = null;
function pluck() {
  if (sfx.muted) return;
  try {
    pluckContext ??= new AudioContext();
    const ctx = pluckContext;
    const now = ctx.currentTime;
    for (const [frequency, gainValue] of [[146.8, 0.32], [293.6, 0.12], [440.4, 0.05]]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(frequency * 1.02, now);
      osc.frequency.exponentialRampToValueAtTime(frequency, now + 0.25);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(gainValue, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.6);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 1.7);
    }
  } catch {
    // Audio is optional.
  }
}

// ---------------------------------------------------------------------------
// Server calls

async function request(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Empty body.
  }
  if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
  return payload;
}

let lastSeq = 0;
function accept(next) {
  if (!next) return;
  const sameGame = state && next.createdAt === state.createdAt;
  if (sameGame && Number.isFinite(next.seq) && next.seq < lastSeq) return; // an HTTP reply older than an SSE push
  lastSeq = next.seq ?? 0;
  delete document.body.dataset.empty;
  state = next;
  render();
}

async function act(path, body) {
  if (busy) return;
  busy = true;
  try {
    accept(await request(path, body ?? {}));
  } catch (error) {
    sfx.play("error");
    toast(error.message, { tone: "error" });
  } finally {
    busy = false;
  }
}

const retryAI = () => act("/api/xiangqi/retry-ai");
const toggleArena = () => act(state.arenaPaused ? "/api/xiangqi/arena/resume" : "/api/xiangqi/arena/pause");
function resign() {
  if (!confirm("Resign this game?")) return;
  act("/api/xiangqi/action", { type: "resign" });
}

function onBoardClick(event) {
  if (!state || state.status !== "active") return;
  const target = event.target.closest(".target");
  if (target) {
    const move = target.dataset.move;
    selected = null;
    act("/api/xiangqi/action", { move });
    return;
  }
  const piece = event.target.closest(".piece");
  if (!piece || !state.legalMoves?.length) return;
  const square = Number(piece.dataset.square);
  if (!state.legalMoves.some((move) => move.from === iccsOf(square))) {
    if (piece.dataset.side === humanPlayer()?.side) sfx.play("error");
    return;
  }
  selected = selected === square ? null : square;
  if (selected !== null) sfx.play("cardFlick");
  renderMarks();
}

// ---------------------------------------------------------------------------
// Setup drawer

let setup;
function buildSetup() {
  setup = drawer({ title: "Set the table", open: false });
  setup.el.classList.add("xq-drawer");
  setup.toggleButton.textContent = "Table setup";
  const body = setup.body;
  const defaults = registry.defaults?.xiangqi ?? registry.defaultConfig;

  const intro = el("p", "setup-intro", "A quiet game in the pavilion. Choose who sits across the board; every new table seats a random character unless you pick one.");

  const modeField = el("fieldset", "segmented");
  modeField.append(el("legend", null, "Mode"));
  for (const [value, label] of [["human", "Play vs AI"], ["arena", "AI arena"]]) {
    const option = el("label");
    const input = el("input");
    input.type = "radio";
    input.name = "mode";
    input.value = value;
    input.checked = value === "human";
    option.append(input, el("span", null, label));
    modeField.append(option);
  }

  const humanBox = el("div", "setup-human");
  const nameLabel = el("label", "field");
  const nameInput = el("input", "kit-input xq-input");
  nameInput.maxLength = 18;
  nameInput.value = "Jay";
  nameLabel.append(el("span", null, "Your name"), nameInput);
  const sideLabel = el("label", "field");
  const sideSelect = el("select", "kit-select");
  for (const [value, text] of [["red", "Red 紅 (moves first)"], ["black", "Black 黑"], ["random", "Draw lots"]]) sideSelect.add(new Option(text, value));
  sideLabel.append(el("span", null, "Your side"), sideSelect);
  humanBox.append(nameLabel, sideLabel);

  const castHeading = el("h3", "setup-heading", "Opponent");
  const cast = characterPicker({ characters, seats: 1 });
  const modelsBox = el("div", "setup-models");
  let pickers = [];
  const syncModels = (count) => {
    const labels = count === 2 ? ["Red seat", "Black seat"] : ["Opponent"];
    const keep = pickers.map((picker) => picker.value);
    modelsBox.replaceChildren();
    pickers = labels.map((label, index) => {
      const picker = modelPicker({ registry, value: keep[index] ?? defaults, label });
      const wrap = el("div", "model-row");
      wrap.append(el("span", "model-row-label", label), picker.el);
      modelsBox.append(wrap);
      return picker;
    });
  };
  syncModels(1);

  const syncSegments = () => {
    for (const label of modeField.querySelectorAll("label")) label.classList.toggle("is-on", label.querySelector("input").checked);
  };
  syncSegments();
  modeField.addEventListener("change", () => {
    syncSegments();
    const arena = modeField.querySelector("input:checked").value === "arena";
    humanBox.hidden = arena;
    castHeading.textContent = arena ? "Red seat, then Black seat" : "Opponent";
    cast.setSeats(arena ? 2 : 1);
    syncModels(arena ? 2 : 1);
  });

  const start = el("button", "xq-button primary start", "Sit down at the table");
  start.type = "button";
  start.addEventListener("click", async () => {
    const mode = modeField.querySelector("input:checked").value;
    const aiPlayers = pickers.map((picker, index) => ({ ...picker.value, characterId: cast.value[index] }));
    start.disabled = true;
    try {
      const next = await request("/api/xiangqi/game", { gameMode: mode, humanName: nameInput.value, humanSide: sideSelect.value, aiPlayers });
      previous = null;
      liveSummary = "";
      resultDismissedFor = null;
      accept(next);
      setup.close();
      sfx.play("stoneClick");
    } catch (error) {
      toast(error.message, { tone: "error" });
    } finally {
      start.disabled = false;
    }
  });

  body.append(intro, modeField, humanBox, castHeading, cast.el, el("h3", "setup-heading", "Model and reasoning"), modelsBox, start);
}

// ---------------------------------------------------------------------------
// Ambient: a few plum petals drifting across the pavilion.

function startPetals() {
  if (prefersReducedMotion()) return;
  const host = $("petals");
  const spawn = () => {
    if (host.childElementCount < 3 && !document.hidden) {
      const petal = el("span", "petal");
      petal.style.setProperty("--start", `${Math.round(Math.random() * 90)}vw`);
      petal.style.setProperty("--drift", `${Math.round(-12 + Math.random() * 30)}vw`);
      petal.style.setProperty("--spin", `${Math.round(200 + Math.random() * 360)}deg`);
      petal.style.setProperty("--duration", `${(12 + Math.random() * 8).toFixed(1)}s`);
      petal.addEventListener("animationend", () => petal.remove());
      host.append(petal);
    }
    setTimeout(spawn, 6000 + Math.random() * 4000);
  };
  setTimeout(spawn, 1200);
}

// ---------------------------------------------------------------------------
// Boot

function connect() {
  const events = new EventSource("/api/xiangqi/events");
  events.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "connected") lastSeq = 0; // the server may have restarted
    else if (message.type === "state") accept(message.payload);
    else if (message.type === "ai_stream") onStream(message.payload);
  });
  bindTableTalk(events, (speaker) => seatElements[speaker], { placement: "right" });
}

function onStream(payload) {
  if (payload.phase === "started") liveSummary = "";
  else if (payload.phase === "summary_delta") liveSummary = `${liveSummary}${payload.delta ?? ""}`.slice(-1200);
  else if (payload.phase === "retry") toast(`${payload.playerName}'s answer was rejected; retrying (${payload.retryNumber}/${payload.maxRetries}).`);
  else if (payload.phase === "error") {
    sfx.play("error");
    toast(`${payload.playerName}: ${payload.message}`, { tone: "error", duration: 7000 });
  } else if (payload.phase === "status" && state?.aiThinking) state.aiThinking.status = payload.status;
  if (state?.aiThinking) renderStatus();
}

async function boot() {
  drawGrid();
  $("nav").append(backToLobby({ label: "Playground" }));
  [characters, registry] = await Promise.all([loadCharacters(), loadModels()]);
  buildSetup();
  $("tools").append(sfx.muteButton(), setup.toggleButton);
  $("board").addEventListener("click", onBoardClick);
  $("result-new").addEventListener("click", () => setup.open());
  $("result-close").addEventListener("click", () => {
    resultDismissedFor = state?.createdAt ?? null;
    renderResult();
  });
  startPetals();
  const initial = await request("/api/xiangqi/state").catch(() => null);
  if (initial) accept(initial);
  else {
    document.body.dataset.empty = "true";
    $("pieces").replaceChildren(...parseBoard(INITIAL_FEN).flatMap((piece, square) => (piece ? [pieceNode(piece, square)] : [])));
    setup.open();
  }
  connect();
}

boot().catch((error) => toast(`The room could not load: ${error.message}`, { tone: "error", duration: 9000 }));

// Exposed for the headless checks in tmp/.
globalThis.__xiangqi = { notation: (fen, move) => notation(parseBoard(fen), move), get state() { return state; } };
