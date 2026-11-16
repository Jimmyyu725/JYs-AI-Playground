// Liar's Dice room client. The server is authoritative; this page renders state from
// /api/liars-dice/events and sends intents (bid, dudo, calza) to /api/liars-dice/action.
import {
  backToLobby,
  characterPicker,
  drawer,
  loadCharacters,
  loadModels,
  modelPicker,
  portraitUrl,
  prefersReducedMotion,
  seat as seatFigure,
  setSeatCaption,
  toast,
} from "/shared/kit.js";
import { sfx } from "/shared/sfx.js";
import { bindTableTalk } from "/shared/speech.js";

const API = "/api/liars-dice";
const ASSETS = "/assets/rooms/liars-dice";
const REVEAL_MS = 3900;
const HOLD_MS = 450;
// Pip cells on a 3x3 grid (1 = top left, 9 = bottom right).
const PIPS = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const plural = (quantity, face) => `${quantity} × ${face}${quantity === 1 ? "" : "s"}`;

let state = null;
let tableId = null;
let crewBySeat = new Map();
let selection = { quantity: 1, face: 2 };
let lastEventIndex = -1;
let seenInsights = new Set();
let revealKey = null;
let revealing = false;
let lastRound = null;
let resultShownFor = null;
let registry = null;
let characters = [];

// ---------------------------------------------------------------------------
// Dice

/** An ivory die showing `face`. Chinese dice paint the 1 and 4 pips red. */
function die(face, { size = "md", state: mark = "" } = {}) {
  const node = el("span", "die");
  node.dataset.face = String(face);
  node.dataset.size = size;
  if (mark) node.dataset.mark = mark;
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", `${face}`);
  for (const cell of PIPS[face] ?? []) {
    const pip = el("i", "pip");
    pip.style.gridArea = `${Math.ceil(cell / 3)} / ${((cell - 1) % 3) + 1}`;
    node.append(pip);
  }
  return node;
}

const counts = (reveal, value) => value === reveal.bid.face || (reveal.onesWild && reveal.bid.face !== 1 && value === 1);

// Portrait expressions. Not every character has every expression painted yet: a missing one
// falls back to the neutral portrait (and is remembered), instead of dropping to initials for good.
const missingPortraits = new Set();
function setExpression(figure, expression) {
  figure.dataset.expression = expression;
  const id = figure.dataset.characterId;
  const frame = figure.querySelector(".kit-portrait");
  if (!id || !frame) return;
  const wanted = missingPortraits.has(`${id}/${expression}`) ? "neutral" : expression;
  if (missingPortraits.has(`${id}/neutral`)) return;
  let image = frame.querySelector("img[data-own]");
  if (!image) {
    frame.querySelector("img")?.remove();
    image = el("img");
    image.alt = "";
    image.dataset.own = "";
    frame.append(image);
  }
  const url = portraitUrl(id, wanted);
  if (image.getAttribute("src") === url) return;
  image.onerror = () => {
    missingPortraits.add(`${id}/${wanted}`);
    if (wanted !== "neutral") image.src = portraitUrl(id, "neutral");
    else image.remove();
  };
  image.src = url;
}

// ---------------------------------------------------------------------------
// Setup drawer

const setup = drawer({ title: "Who sits at the table?", open: false });
const setupForm = el("form", "setup-form");
setupForm.innerHTML = `
  <fieldset class="setup-group">
    <legend>Game</legend>
    <div class="segmented" role="radiogroup" aria-label="Mode">
      <label><input type="radio" name="mode" value="human" checked /><span>Play vs AI</span></label>
      <label><input type="radio" name="mode" value="arena" /><span>AI arena</span></label>
    </div>
    <label class="field" data-human-only><span>Your name</span><input class="kit-input" name="humanName" maxlength="18" value="You" autocomplete="nickname" /></label>
    <div class="field"><span>Players at the table</span>
      <div class="segmented seats" role="radiogroup" aria-label="Players">
        ${[2, 3, 4, 5, 6].map((count) => `<label><input type="radio" name="seats" value="${count}" ${count === 4 ? "checked" : ""}/><span>${count}</span></label>`).join("")}
      </div>
    </div>
  </fieldset>
  <fieldset class="setup-group" id="cast-group"><legend>The crew</legend></fieldset>
  <fieldset class="setup-group" id="model-group"><legend>Models</legend></fieldset>
  <fieldset class="setup-group">
    <legend>House rules</legend>
    <label class="check"><input type="checkbox" name="calza" checked /><span><strong>Calza</strong> — call “spot on”; exact wins a die back (3+ players)</span></label>
    <label class="check"><input type="checkbox" name="palifico" checked /><span><strong>Palifico</strong> — first drop to one die: ones are not wild, face is locked</span></label>
  </fieldset>
  <button type="submit" class="brass-button deal">Shake the cups</button>
  <details class="rules-sheet">
    <summary>How the table plays</summary>
    <ul>
      <li>Everyone shakes five dice under a cup and sees only their own.</li>
      <li>A bid claims “at least this many of this face on the whole table”. Ones are wild and count toward every other face; nobody opens a round on ones.</li>
      <li>Raise with more dice, or the same number on a higher face. Moving to ones needs half the count (rounded up); leaving ones needs double plus one.</li>
      <li><strong>Liar!</strong> lifts every cup. If the bid holds, the caller loses a die; if not, the bidder does.</li>
      <li><strong>Spot on</strong> claims the bid is exact: right wins a die back, wrong loses one.</li>
      <li><strong>Palifico</strong>: the first time someone drops to one die, the next round has no wild ones and the opening face is locked.</li>
      <li>Whoever loses a die opens the next round. The last cup with dice wins.</li>
    </ul>
  </details>
`;
setup.body.append(setupForm);

// The tavern ladder: Elo for this room from GET /api/ladder/liars-dice.
const ladder = el("details", "rules-sheet ladder");
ladder.append(el("summary", null, "The tavern ladder"));
const ladderList = el("ol", "ladder-list");
ladder.append(ladderList);
setup.body.append(ladder);

async function refreshLadder() {
  try {
    const response = await fetch("/api/ladder/liars-dice");
    if (!response.ok) return;
    const { ratings = [], matchCount = 0 } = await response.json();
    if (!ratings.length) {
      ladderList.replaceChildren(el("li", "ladder-empty", "No finished games yet."));
      return;
    }
    ladderList.replaceChildren(
      ...ratings.slice(0, 10).map((entry) => {
        const model = registry?.models.find((candidate) => candidate.id === entry.model);
        const name = entry.kind === "human" ? "Humans" : `${model?.label ?? entry.model} · ${entry.reasoningEffort}`;
        const row = el("li", "ladder-row");
        row.append(el("span", "ladder-name", name), el("span", "ladder-record", `${entry.wins}–${entry.losses}`), el("strong", "ladder-rating", String(Math.round(entry.rating))));
        return row;
      }),
    );
    ladder.querySelector("summary").textContent = `The tavern ladder · ${matchCount} game${matchCount === 1 ? "" : "s"}`;
  } catch {
    // The ladder is a nicety; the table works without it.
  }
}

let cast = null;
let allModels = null;
let seatModels = [];

function setupMode() {
  return setupForm.elements.mode.value;
}

function aiSeatCount() {
  const total = Number(setupForm.elements.seats.value);
  return setupMode() === "arena" ? total : total - 1;
}

function setSelectValues(picker, value) {
  const [model, effort] = picker.el.querySelectorAll("select");
  model.value = value.model;
  effort.value = value.reasoningEffort;
}

function renderSeatModels() {
  const group = $("model-group");
  group.querySelector(".seat-models")?.remove();
  const details = el("details", "seat-models");
  details.append(el("summary", null, "Per-seat models"));
  const previous = seatModels.map((picker) => picker.value);
  seatModels = cast.characters.map((character, index) => {
    const row = el("div", "seat-model-row");
    row.append(el("span", "seat-model-name", character.shortName ?? character.name));
    const picker = modelPicker({ registry, value: previous[index] ?? allModels.value, label: character.name });
    row.append(picker.el);
    details.append(row);
    return picker;
  });
  group.append(details);
}

function syncSetup() {
  const arena = setupMode() === "arena";
  setupForm.querySelectorAll("[data-human-only]").forEach((node) => (node.hidden = arena));
  cast.setSeats(aiSeatCount());
}

async function initSetup() {
  [characters, registry] = await Promise.all([loadCharacters(), loadModels()]);
  cast = characterPicker({ characters, seats: aiSeatCount(), onChange: () => seatModels.length && renderSeatModels() });
  $("cast-group").append(cast.el);
  allModels = modelPicker({
    registry,
    label: "Every seat",
    onChange: (value) => seatModels.forEach((picker) => setSelectValues(picker, value)),
  });
  const allRow = el("div", "seat-model-row");
  allRow.append(el("span", "seat-model-name", "Every seat"), allModels.el);
  $("model-group").append(allRow);
  renderSeatModels();
  setupForm.addEventListener("change", (event) => {
    if (event.target.name === "mode" || event.target.name === "seats") syncSetup();
  });
}

setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = setupForm.elements;
  const body = {
    gameMode: setupMode(),
    seatCount: Number(form.seats.value),
    humanName: form.humanName.value,
    rules: { calza: form.calza.checked, palifico: form.palifico.checked },
    aiPlayers: cast.value.map((characterId, index) => ({ ...(seatModels[index]?.value ?? allModels.value), characterId })),
  };
  const button = setupForm.querySelector(".deal");
  button.disabled = true;
  try {
    applyState(await post("/game", body));
    setup.close();
  } catch (error) {
    toast(error.message, { tone: "error" });
  } finally {
    button.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Server calls

async function post(path, body = {}) {
  const response = await fetch(`${API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

async function act(action) {
  try {
    applyState(await post("/action", action));
  } catch (error) {
    sfx.play("error");
    toast(error.message, { tone: "error" });
  }
}

// ---------------------------------------------------------------------------
// Crew (seats around the table)

function captionFor(player) {
  if (player.isHuman) return "You";
  const model = registry?.models.find((entry) => entry.id === player.aiConfig?.model);
  return `${model?.shortLabel ?? player.aiConfig?.model ?? ""} · ${player.aiConfig?.reasoningEffort ?? ""}`;
}

function buildCrew() {
  const crew = $("crew");
  crew.replaceChildren();
  crewBySeat = new Map();
  for (const player of state.players) {
    if (player.isHuman) continue;
    const item = el("li", "mate");
    item.dataset.seat = String(player.seat);
    item.style.setProperty("--mate-color", player.character?.color ?? "var(--ld-brass)");
    const cupZone = el("div", "cup-zone");
    const under = el("div", "under-dice");
    const cup = el("img", "cup");
    cup.src = `${ASSETS}/dice-cup-down.png`;
    cup.alt = "";
    cup.decoding = "async";
    cupZone.append(under, cup);
    const figure = seatFigure({ character: player.character, name: player.character?.shortName ?? player.name, caption: captionFor(player), size: "sm" });
    const tally = el("div", "tally");
    tally.setAttribute("aria-label", "Dice left");
    item.append(cupZone, figure, tally);
    crew.append(item);
    crewBySeat.set(player.seat, { item, under, figure, tally, cup });
  }
  crew.dataset.count = String(crewBySeat.size);
}

function renderTally(tally, count, max) {
  const marks = [];
  for (let index = 0; index < max; index += 1) {
    const mark = el("i", index < count ? "tally-die" : "tally-die lost");
    marks.push(mark);
  }
  tally.replaceChildren(...marks);
  tally.setAttribute("aria-label", `${count} dice left`);
}

function renderCrew() {
  const max = state.rules.startingDice;
  for (const seatState of state.seats) {
    const entry = crewBySeat.get(seatState.seat);
    if (!entry) continue;
    const active = state.phase === "bidding" && state.currentSeat === seatState.seat;
    entry.item.dataset.active = String(active);
    entry.item.dataset.thinking = String(state.aiThinking?.seat === seatState.seat);
    entry.item.dataset.out = String(seatState.eliminated);
    entry.figure.dataset.active = String(active);
    renderTally(entry.tally, seatState.diceCount, max);
    if (!revealing) {
      entry.under.replaceChildren(...(seatState.dice ?? []).map((face) => die(face, { size: "xs" })));
      entry.item.dataset.open = String(Boolean(seatState.dice));
      const thinking = state.aiThinking?.seat === seatState.seat;
      const won = state.phase === "complete" && state.winnerSeat === seatState.seat;
      setExpression(entry.figure, won ? "triumphant" : seatState.eliminated ? "defeated" : thinking ? "thinking" : "neutral");
    }
    const player = state.players[seatState.seat];
    const status = state.aiThinking?.seat === seatState.seat ? "thinking…" : seatState.eliminated ? "out of dice" : captionFor(player);
    setSeatCaption(entry.figure, status);
  }
}

// ---------------------------------------------------------------------------
// Bid plaque, turn line, tray

function nameOf(seat) {
  const player = state?.players[seat];
  if (!player) return `Seat ${seat}`;
  return player.isHuman ? player.name : player.character?.shortName ?? player.name;
}

// Sentence helpers: the human is "you" in running text, whatever name they chose.
const isHumanSeat = (seat) => Boolean(state?.players[seat]?.isHuman);
const subj = (seat) => (isHumanSeat(seat) ? "You" : nameOf(seat));
const obj = (seat) => (isHumanSeat(seat) ? "you" : nameOf(seat));
const verb = (seat, third, base) => `${subj(seat)} ${isHumanSeat(seat) ? base : third}`;

function renderPlaque() {
  const bid = state.currentBid;
  $("plaque-empty").hidden = Boolean(bid) || state.phase === "complete";
  $("plaque-empty").textContent = state.phase === "bidding" ? `Round ${state.round}: ${verb(state.roundStarter, "opens", "open")} the bidding.` : "";
  $("plaque-bid").hidden = !bid;
  if (bid) {
    const changed = $("plaque-quantity").textContent !== String(bid.quantity) || $("plaque-die").dataset.face !== String(bid.face);
    $("plaque-quantity").textContent = String(bid.quantity);
    $("plaque-die").replaceChildren(die(bid.face, { size: "lg" }));
    $("plaque-die").dataset.face = String(bid.face);
    $("plaque-by").textContent = `claims ${nameOf(bid.seat)}`;
    if (changed && !prefersReducedMotion()) $("plaque-bid").animate([{ transform: "scale(1.12) rotate(-2deg)", opacity: 0.4 }, { transform: "none", opacity: 1 }], { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" });
  }
  const thinking = state.aiThinking;
  let line = "";
  if (state.phase === "complete") line = `${verb(state.winnerSeat, "keeps", "keep")} the last dice and ${isHumanSeat(state.winnerSeat) ? "win" : "wins"}.`;
  else if (state.aiError) line = `${state.aiError.playerName}'s request is paused.`;
  else if (thinking) line = `${nameOf(thinking.seat)} eyes the table… ${thinking.retryNumber ? `(retry ${thinking.retryNumber})` : ""}`;
  else if (state.players[state.currentSeat]?.isHuman) line = state.currentBid ? "Your call: raise the bid, or call the liar." : "You open: name a quantity and a face.";
  else if (state.arena?.paused) line = "Arena paused.";
  else line = `${nameOf(state.currentSeat)} to act.`;
  $("turn-line").textContent = line;

  $("round-number").textContent = String(state.round);
  $("dice-total").textContent = String(state.totalDice);
  const badge = $("rule-badge");
  badge.textContent = state.palifico ? `Palifico · ${nameOf(state.palificoSeat)} on one die · ones not wild` : "Ones are wild";
  badge.dataset.palifico = String(state.palifico);
}

function rangeFor(face) {
  return state.human?.bidRanges.find((range) => range.face === face) ?? null;
}

function defaultSelection() {
  const ranges = state.human?.bidRanges ?? [];
  if (!ranges.length) return;
  const mine = state.seats[state.humanSeat]?.dice ?? [];
  const score = (face) => mine.filter((value) => value === face || (state.onesWild && face !== 1 && value === 1)).length;
  const keep = rangeFor(selection.face);
  if (keep && selection.quantity >= keep.minQuantity && selection.quantity <= keep.maxQuantity && selection.round === state.round && selection.bids === state.bids.length) return;
  const best = [...ranges].sort((left, right) => score(right.face) - score(left.face) || left.minQuantity - right.minQuantity)[0];
  selection = { face: best.face, quantity: best.minQuantity, round: state.round, bids: state.bids.length };
}

function renderFaces() {
  const row = $("face-row");
  if (!row.childElementCount) {
    for (let face = 1; face <= 6; face += 1) {
      const button = el("button", "face-pick");
      button.type = "button";
      button.dataset.face = String(face);
      button.setAttribute("role", "radio");
      button.setAttribute("aria-label", `${face}s`);
      button.append(die(face, { size: "sm" }));
      button.addEventListener("click", () => {
        const range = rangeFor(face);
        if (!range) return;
        selection = { ...selection, face, quantity: Math.min(Math.max(selection.quantity, range.minQuantity), range.maxQuantity) };
        sfx.play("stoneClick");
        renderTray();
      });
      row.append(button);
    }
  }
  for (const button of row.children) {
    const face = Number(button.dataset.face);
    const range = rangeFor(face);
    button.disabled = !range;
    button.setAttribute("aria-checked", String(face === selection.face));
  }
}

function renderTray() {
  const arena = state.gameMode === "arena";
  $("bid-controls").hidden = arena || state.phase === "complete";
  $("arena-controls").hidden = !arena;
  $("tray").dataset.turn = String(Boolean(state.human?.canAct));
  if (arena) {
    $("arena-toggle").textContent = state.arena?.paused ? "Resume" : "Pause";
    $("arena-toggle").disabled = state.phase === "complete";
    $("hand").replaceChildren();
    $("hand-label").textContent = "";
    return;
  }
  const me = state.seats[state.humanSeat];
  $("hand-label").textContent = me.eliminated ? "Your cup is empty" : "Your cup";
  if (!revealing) $("hand").replaceChildren(...(me.dice ?? []).map((face) => die(face, { size: "md" })));
  defaultSelection();
  const human = state.human;
  const range = rangeFor(selection.face);
  $("qty").textContent = String(selection.quantity);
  $("qty-down").disabled = !human.canAct || !range || selection.quantity <= range.minQuantity;
  $("qty-up").disabled = !human.canAct || !range || selection.quantity >= range.maxQuantity;
  $("raise-button").disabled = !human.canAct || !range;
  $("raise-button").textContent = state.currentBid ? `Raise to ${plural(selection.quantity, selection.face)}` : `Open: ${plural(selection.quantity, selection.face)}`;
  $("liar-button").disabled = !human.canDudo;
  $("calza-button").disabled = !human.canCalza;
  $("calza-button").hidden = !state.rules.calza;
  renderFaces();
}

$("qty-down").addEventListener("click", () => {
  selection.quantity -= 1;
  sfx.play("stoneClick");
  renderTray();
});
$("qty-up").addEventListener("click", () => {
  selection.quantity += 1;
  sfx.play("stoneClick");
  renderTray();
});
$("raise-button").addEventListener("click", () => {
  sfx.play("tileClack");
  act({ type: "bid", quantity: selection.quantity, face: selection.face });
});
$("calza-button").addEventListener("click", () => act({ type: "calza" }));
$("retry-ai").addEventListener("click", async () => {
  try {
    applyState(await post("/retry-ai"));
  } catch (error) {
    toast(error.message, { tone: "error" });
  }
});
$("arena-toggle").addEventListener("click", async () => {
  try {
    applyState(await post(state.arena?.paused ? "/arena/resume" : "/arena/pause"));
  } catch (error) {
    toast(error.message, { tone: "error" });
  }
});

// "Liar!" is a press-and-hold wax seal so nobody calls a bluff by accident.
{
  const seal = $("liar-button");
  let timer = null;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    seal.classList.remove("holding");
  };
  seal.style.setProperty("--hold-ms", `${HOLD_MS}ms`);
  seal.addEventListener("pointerdown", (event) => {
    if (seal.disabled || event.button !== 0) return;
    seal.setPointerCapture?.(event.pointerId);
    seal.classList.add("holding");
    timer = setTimeout(() => {
      cancel();
      act({ type: "dudo" });
    }, HOLD_MS);
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) seal.addEventListener(type, cancel);
  // Keyboard activation (detail 0) calls at once; the hold guards pointer slips only.
  seal.addEventListener("click", (event) => {
    if (event.detail === 0 && !seal.disabled) act({ type: "dudo" });
  });
}

// ---------------------------------------------------------------------------
// Ship's log

function logEntry(kind, html, { who = null, color = null } = {}) {
  const item = el("li", "log-item");
  item.dataset.kind = kind;
  if (color) item.style.setProperty("--who-color", color);
  if (who) item.append(el("strong", "log-who", who));
  const text = el("span", "log-text");
  if (html instanceof Node) text.append(html);
  else text.textContent = html;
  item.append(text);
  const list = $("log-list");
  const pinned = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.append(item);
  while (list.children.length > 220) list.firstElementChild.remove();
  if (pinned) list.scrollTop = list.scrollHeight;
  return item;
}

function bidLine(quantity, face) {
  const span = el("span", "log-bid");
  span.append(el("b", null, `${quantity} ×`), die(face, { size: "xs" }));
  return span;
}

function colorOf(seat) {
  return state.players[seat]?.character?.color ?? "var(--ld-sea-bright)";
}

function appendEvent(event) {
  const who = (seat) => nameOf(seat);
  switch (event.type) {
    case "round_start":
      logEntry("round", `Round ${event.round}${event.palifico ? " · palifico" : ""} — ${event.totalDice} dice, ${obj(event.starterSeat)} to open`);
      break;
    case "bid":
      logEntry("bid", bidLine(event.quantity, event.face), { who: who(event.seat), color: colorOf(event.seat) });
      break;
    case "dudo":
    case "calza": {
      const call = event.type === "dudo" ? "Liar!" : "Spot on!";
      const verdict = event.type === "dudo"
        ? event.outcome === "bid_holds" ? "the bid held" : "the bid was a bluff"
        : event.outcome === "exact" ? "exactly right" : "not exact";
      logEntry("call", `${call} on ${plural(event.bid.quantity, event.bid.face)} — there were ${event.count}: ${verdict}`, { who: who(event.seat), color: colorOf(event.seat) });
      break;
    }
    case "die_lost":
      logEntry("loss", `${verb(event.seat, "loses", "lose")} a die (${event.diceLeft} left)`);
      break;
    case "die_gained":
      logEntry("gain", `${verb(event.seat, "wins", "win")} a die back (${event.diceLeft})`);
      break;
    case "eliminated":
      logEntry("loss", `${verb(event.seat, "is", "are")} out of dice`);
      break;
    case "game_over":
      logEntry("round", `${verb(event.winnerSeat, "wins", "win")} the game`);
      break;
    default:
  }
}

function renderLog(fresh) {
  if (fresh) {
    $("log-list").replaceChildren();
    lastEventIndex = -1;
    seenInsights = new Set();
  }
  // A new rationale is written just before the move it explains.
  for (const insight of state.aiInsights ?? []) {
    if (seenInsights.has(insight.id)) continue;
    seenInsights.add(insight.id);
    if (!fresh) logEntry("reasoning", insight.explanation, { who: `${nameOf(insight.seat)}'s thinking`, color: colorOf(insight.seat) });
  }
  for (const event of state.events) {
    if (event.index <= lastEventIndex) continue;
    lastEventIndex = event.index;
    appendEvent(event);
  }
  if (fresh) for (const talk of state.tableTalk ?? []) logEntry("talk", talk.text, { who: nameOf(talk.speaker), color: colorOf(talk.speaker) });
  $("log-sub").textContent = state.gameMode === "arena" ? "arena · reasoning shown" : "bids, calls and table talk";
}

// ---------------------------------------------------------------------------
// Reveal

function playReveal(reveal) {
  revealing = true;
  const tavern = $("tavern");
  tavern.dataset.reveal = "lifting";
  for (const [seat, entry] of crewBySeat) {
    const dice = reveal.dice[seat] ?? [];
    entry.under.replaceChildren(
      ...dice.map((face, index) => {
        const node = die(face, { size: "xs", state: counts(reveal, face) ? "match" : "dim" });
        node.style.setProperty("--i", String(seat * 2 + index));
        return node;
      }),
    );
    entry.item.style.setProperty("--lift-delay", `${60 * seat}ms`);
    const outcome = reveal.loserSeat === seat ? "defeated" : reveal.gainerSeat === seat || (reveal.type === "dudo" && (seat === reveal.callerSeat || seat === reveal.bid.seat)) ? "triumphant" : null;
    if (outcome) setExpression(entry.figure, outcome);
    entry.item.dataset.loser = String(reveal.loserSeat === seat);
  }
  if (state.humanSeat !== null) {
    const mine = reveal.dice[state.humanSeat] ?? [];
    $("hand").replaceChildren(...mine.map((face) => die(face, { size: "md", state: counts(reveal, face) ? "match" : "dim" })));
  }
  const caller = subj(reveal.callerSeat);
  const bidder = obj(reveal.bid.seat);
  const c = (third, base) => verb(reveal.callerSeat, third, base);
  const b = (third, base) => verb(reveal.bid.seat, third, base);
  $("reveal-stamp").textContent = reveal.type === "dudo" ? "Liar!" : "Spot on!";
  let text;
  if (reveal.type === "dudo") {
    text = reveal.outcome === "bid_holds"
      ? `${caller} called ${bidder} a liar, but there were ${reveal.count}, so ${plural(reveal.bid.quantity, reveal.bid.face)} holds. ${c("loses", "lose")} a die.`
      : `${caller} caught ${bidder}: only ${reveal.count} for ${plural(reveal.bid.quantity, reveal.bid.face)}. ${b("loses", "lose")} a die.`;
  } else {
    text = reveal.outcome === "exact"
      ? `${caller} called it to the die: exactly ${reveal.count}. ${c("wins", "win")} a die back.`
      : `${caller} said exactly ${reveal.bid.quantity}; there were ${reveal.count}. ${c("loses", "lose")} a die.`;
  }
  $("reveal-text").textContent = `${text}${reveal.onesWild ? "" : " (No wild ones this round.)"}`;
  $("reveal").hidden = false;
  $("reveal").dataset.outcome = reveal.loserSeat === state.humanSeat ? "lost" : "neutral";
  sfx.play("cupSlam");
  setTimeout(() => sfx.play(reveal.loserSeat === state.humanSeat ? "error" : "chipClack"), 420);
  setTimeout(() => {
    $("reveal").hidden = true;
    tavern.dataset.reveal = "";
    revealing = false;
    for (const entry of crewBySeat.values()) entry.item.dataset.loser = "false";
    if (state) {
      render();
      if (state.phase === "bidding") shakeCups();
    }
  }, prefersReducedMotion() ? 2600 : REVEAL_MS);
}

function shakeCups() {
  if (prefersReducedMotion()) return;
  sfx.play("diceRoll");
  setTimeout(() => sfx.play("cupSlam"), 700);
  for (const entry of crewBySeat.values()) {
    // Shaken mouth-up, then slammed down over the dice.
    entry.cup.src = `${ASSETS}/dice-cup.png`;
    setTimeout(() => (entry.cup.src = `${ASSETS}/dice-cup-down.png`), 560);
    entry.cup.animate(
      [
        { transform: "rotate(0) translateY(0)" },
        { transform: "rotate(-8deg) translateY(-6px)" },
        { transform: "rotate(8deg) translateY(-2px)" },
        { transform: "rotate(-6deg) translateY(-7px)" },
        { transform: "rotate(5deg) translateY(-1px)" },
        { transform: "scale(1.05)" },
        { transform: "none" },
      ],
      { duration: 680, easing: "ease-out", delay: Math.random() * 90 },
    );
  }
  $("hand").animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 420, delay: 380, fill: "backwards" });
}

// ---------------------------------------------------------------------------
// Result card and review

function renderResult() {
  if (state.phase !== "complete" || resultShownFor === state.tableId) return;
  resultShownFor = state.tableId;
  const card = $("result-card");
  const humanWon = state.humanSeat !== null && state.winnerSeat === state.humanSeat;
  $("result-title").textContent = humanWon ? "The last cup on the table is yours." : `${nameOf(state.winnerSeat)} takes the table.`;
  $("placements").replaceChildren(
    ...state.result.placements.map((entry) => {
      const item = el("li", "placement");
      item.append(el("span", "place", `${entry.place}`), el("span", "place-name", nameOf(entry.seat)), el("span", "place-dice", entry.diceLeft ? `${entry.diceLeft} dice left` : ""));
      return item;
    }),
  );
  const buttons = $("review-buttons");
  buttons.replaceChildren();
  for (const player of state.players.filter((entry) => !entry.isHuman)) {
    const button = el("button", "sea-button", `Ask ${player.character.shortName} to review this game`);
    button.type = "button";
    button.addEventListener("click", () => askReview(player, button));
    buttons.append(button);
  }
  $("review").hidden = true;
  card.hidden = false;
  sfx.play(humanWon || state.humanSeat === null ? "win" : "error");
  setTimeout(refreshLadder, 600);
}

async function askReview(player, button) {
  const all = $("review-buttons").querySelectorAll("button");
  all.forEach((node) => (node.disabled = true));
  const review = $("review");
  review.hidden = false;
  review.replaceChildren(el("p", "review-wait", `${player.character.shortName} pours a rum and flips back through the log…`));
  try {
    const result = await post("/review", { characterId: player.character.id });
    review.replaceChildren(el("h3", null, result.headline), el("p", null, result.review), el("p", "review-key", `Turning point: ${result.keyMoment}`));
  } catch (error) {
    review.replaceChildren(el("p", "review-wait", `The review failed: ${error.message}`));
    button.disabled = false;
  } finally {
    all.forEach((node) => node !== button && (node.disabled = false));
  }
}

$("again-button").addEventListener("click", () => {
  $("result-card").hidden = true;
  setup.open();
});
$("close-result").addEventListener("click", () => ($("result-card").hidden = true));

// ---------------------------------------------------------------------------
// State

function render() {
  if (!state) return;
  $("tavern").dataset.mode = state.gameMode;
  $("tavern").dataset.phase = state.phase;
  renderCrew();
  renderPlaque();
  renderTray();
  $("ai-pause").hidden = !state.aiError;
  $("ai-pause-text").textContent = state.aiError ? `${state.aiError.playerName}'s model request failed: ${state.aiError.message}` : "";
  const thinking = $("thinking");
  thinking.hidden = !state.aiThinking;
  thinking.textContent = state.aiThinking ? `${nameOf(state.aiThinking.seat)}: ${state.aiThinking.status}` : "";
}

function applyState(next) {
  if (!next) return;
  const fresh = next.tableId !== tableId;
  const previousRound = lastRound;
  state = next;
  if (fresh) {
    tableId = next.tableId;
    resultShownFor = null;
    buildCrew();
    revealKey = next.lastReveal ? `${next.tableId}:${next.lastReveal.round}` : null;
    $("result-card").hidden = true;
  }
  renderLog(fresh);
  const key = next.lastReveal ? `${next.tableId}:${next.lastReveal.round}` : null;
  if (key && key !== revealKey) {
    revealKey = key;
    render();
    playReveal(next.lastReveal);
  } else {
    render();
    if (fresh || (previousRound !== null && next.round !== previousRound && !revealing)) shakeCups();
  }
  lastRound = next.round;
  if (!revealing) renderResult();
  else setTimeout(() => state?.phase === "complete" && renderResult(), REVEAL_MS + 200);
}

// ---------------------------------------------------------------------------
// Optional ambience: a slow brown-noise sea swell and a rare hull creak. Off by default,
// and silent whenever the shared sound effects are muted.

let sea = null;
function startSea() {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass || sea) return;
  const ctx = new AudioContextClass();
  const seconds = 4;
  const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let index = 0; index < data.length; index += 1) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    data[index] = last * 3.2;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 420;
  const swell = ctx.createGain();
  swell.gain.value = 0.07;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 1 / 9;
  const depth = ctx.createGain();
  depth.gain.value = 0.045;
  lfo.connect(depth).connect(swell.gain);
  source.connect(lowpass).connect(swell).connect(ctx.destination);
  source.start();
  lfo.start();
  const creak = () => {
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 18;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    band.frequency.setValueAtTime(260, now);
    band.frequency.exponentialRampToValueAtTime(720, now + 0.9);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.3);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
    noise.connect(band).connect(gain).connect(ctx.destination);
    noise.start(now, Math.random() * 2, 1.2);
    sea.timer = setTimeout(creak, 11000 + Math.random() * 19000);
  };
  sea = { ctx, timer: setTimeout(creak, 6000) };
}
function stopSea() {
  if (!sea) return;
  clearTimeout(sea.timer);
  sea.ctx.close().catch(() => {});
  sea = null;
}
function seaButton() {
  const button = el("button", "kit-mute sea-toggle");
  button.type = "button";
  button.title = "Sea and hull ambience";
  const sync = () => {
    button.setAttribute("aria-pressed", String(Boolean(sea)));
    button.setAttribute("aria-label", sea ? "Turn the sea ambience off" : "Turn the sea ambience on");
    button.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M2 9c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2"/><path d="M2 15c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2"/></svg>';
  };
  button.addEventListener("click", () => {
    if (sea) stopSea();
    else if (!sfx.muted) startSea();
    else toast("Sound is muted. Unmute to hear the sea.");
    sync();
  });
  sfx.onChange((muted) => {
    if (muted) stopSea();
    sync();
  });
  sync();
  return button;
}

// ---------------------------------------------------------------------------
// Boot

const nav = $("nav-slot");
nav.append(backToLobby());
$("tools-slot").append(seaButton(), sfx.muteButton(), setup.toggleButton);
setup.toggleButton.textContent = "Setup";

await initSetup();
refreshLadder();
const initial = await fetch(`${API}/state`).then((response) => response.json()).catch(() => null);
if (initial) applyState(initial);
else setup.open();

const events = new EventSource(`${API}/events`);
events.addEventListener("message", (event) => {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  if (message.type === "state") applyState(message.payload);
  else if (message.type === "action" && message.payload?.action?.type === "bid" && state && message.payload.seat !== state.humanSeat) sfx.play("tileClack");
});
bindTableTalk(events, (speaker) => crewBySeat.get(speaker)?.figure ?? null, {
  placement: "bottom",
  onTalk(talk) {
    if (state) logEntry("talk", talk.text, { who: nameOf(talk.speaker), color: colorOf(talk.speaker) });
  },
});
