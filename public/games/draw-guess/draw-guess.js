import { backToLobby, characterPicker, drawer, loadCharacters, loadModels, modelPicker, portraitUrl, seat as seatFigure, setSeatExpression, toast } from "/shared/kit.js";
import { sfx } from "/shared/sfx.js";
import { atelier } from "/games/draw-guess/atelier-sfx.js";
import { speak } from "/shared/speech.js";

const API = "/api/draw-guess";
const $ = (id) => document.getElementById(id);
const BLUR_REFERENCE_WIDTH = 512; // Matches the server: blurPx is defined for a 512 px wide image.
const PAPER = "#f6efdf";
const CHARCOAL = "#2b2420";
// Paint blobs on palette.webp: centre in % of the image, and the paint colour.
const BLOBS = [
  { name: "Cream", x: 17, y: 33, color: "#f3e8cf" },
  { name: "Amber", x: 32, y: 17, color: "#e29b2c" },
  { name: "Apricot", x: 51, y: 13, color: "#f2955c" },
  { name: "Terracotta", x: 70, y: 16, color: "#c0412a" },
  { name: "Rose", x: 83, y: 33, color: "#d9707c" },
  { name: "Umber", x: 14, y: 53, color: "#4a2414" },
  { name: "Slate", x: 21, y: 73, color: "#5a7499" },
  { name: "Sage", x: 37, y: 82, color: "#7d9a66" },
];
const BRUSH_SIZES = [{ label: "Fine", size: 6 }, { label: "Round", size: 16 }, { label: "Flat", size: 34 }];

let characters = [];
let registry = null;
let state = null;
let clockOffset = 0;
let renderedTableId = null;
let renderedRound = null;
const seatNodes = new Map();
const slipIds = new Set();
let lastHistoryLength = -1;
let lastOwnGuesses = 0;
let promptMode = "paint";

// ------------------------------------------------------------------ helpers

async function post(path, body, { raw = false } = {}) {
  const response = await fetch(`${API}${path}`, raw
    ? { method: "POST", headers: { "Content-Type": "image/png" }, body }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  if (payload?.view) render(payload);
  return payload;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function modelLabel(config) {
  if (!config) return "";
  const model = registry?.models.find((entry) => entry.id === config.model);
  return `${model?.shortLabel ?? config.model} · ${config.reasoningEffort}`;
}

const serverNow = () => Date.now() + clockOffset;
const humanSeat = () => (state?.humanSeat ?? -1);
const humanSeatOf = (snapshot) => (snapshot?.humanSeat ?? -1);
const isArena = () => state?.mode === "arena";

// ------------------------------------------------------------------ setup drawer

function buildSetup() {
  const setup = drawer({ title: "A new sitting", open: true });
  const form = el("form", "setup");
  form.addEventListener("submit", (event) => event.preventDefault());

  let mode = "human-vs-ai";
  const modeField = el("fieldset");
  modeField.append(el("legend", "", "Who holds the brush"));
  const segmented = el("div", "segmented");
  const modeButtons = [["human-vs-ai", "Play with the house"], ["arena", "AI arena"]].map(([value, label]) => {
    const button = el("button", "", label);
    button.type = "button";
    button.setAttribute("aria-pressed", String(value === mode));
    button.addEventListener("click", () => {
      mode = value;
      modeButtons.forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
      nameLabel.hidden = mode === "arena";
      syncCount();
    });
    segmented.append(button);
    return button;
  });
  modeField.append(segmented);

  const nameLabel = el("label");
  nameLabel.append(el("span", "", "Your name"));
  const nameInput = el("input");
  nameInput.type = "text";
  nameInput.maxLength = 24;
  nameInput.value = "You";
  nameLabel.append(nameInput);

  const countLabel = el("label");
  countLabel.append(el("span", "", "AI painters"));
  const countSelect = el("select");
  countLabel.append(countSelect);

  const castField = el("fieldset");
  castField.append(el("legend", "", "The sitters (random; reroll or choose)"));
  const cast = characterPicker({ characters, seats: 2 });
  castField.append(cast.el);

  const modelsField = el("fieldset");
  modelsField.append(el("legend", "", "Model per seat"));
  const modelsList = el("div", "seat-models");
  modelsField.append(modelsList);
  let modelPickers = [];
  const defaultConfig = registry.defaults?.["draw-guess"] ?? registry.defaultConfig;

  function syncModels(count) {
    const values = modelPickers.map((picker) => picker.value);
    modelPickers = Array.from({ length: count }, (_, index) => modelPicker({ registry, value: values[index] ?? values[0] ?? defaultConfig, label: "Model" }));
    modelsList.replaceChildren(...modelPickers.map((picker, index) => {
      const row = el("div", "seat-model");
      row.append(el("b", "", `Seat ${index + 1}`), picker.el);
      return row;
    }));
  }

  let countTouched = false;
  function syncCount() {
    const [min, max] = mode === "arena" ? [2, 6] : [1, 5];
    // Until the player picks a count, each mode gets its own default (3 painters make a livelier arena).
    const previous = (countTouched && Number(countSelect.value)) || (mode === "arena" ? 3 : 2);
    countSelect.replaceChildren(...Array.from({ length: max - min + 1 }, (_, index) => {
      const option = el("option", "", String(min + index));
      option.value = String(min + index);
      return option;
    }));
    countSelect.value = String(Math.min(max, Math.max(min, previous)));
    cast.setSeats(Number(countSelect.value));
    syncModels(Number(countSelect.value));
  }
  countSelect.addEventListener("change", () => {
    countTouched = true;
    cast.setSeats(Number(countSelect.value));
    syncModels(Number(countSelect.value));
  });

  const selects = el("div", "setup-grid");
  const makeSelect = (label, options, value) => {
    const wrap = el("label");
    wrap.append(el("span", "", label));
    const select = el("select");
    for (const [optionValue, text] of options) {
      const option = el("option", "", text);
      option.value = optionValue;
      select.append(option);
    }
    select.value = value;
    wrap.append(select);
    selects.append(wrap);
    return select;
  };
  const rotations = makeSelect("Rounds", [["1", "Once around"], ["2", "Twice around"], ["3", "Three times"]], "1");
  const difficulty = makeSelect("Words", [["mixed", "Mixed (choose)"], ["easy", "Easy"], ["medium", "Medium"], ["hard", "Hard"]], "mixed");
  const roundSeconds = makeSelect("Guessing time", [["60", "60 s"], ["90", "90 s"], ["120", "120 s"], ["180", "180 s"]], "90");
  const imageQuality = makeSelect("Painting quality", [["low", "Quick sketch"], ["medium", "Finished"]], "low");
  selects.prepend(countLabel);

  const start = el("button", "hang", "Open the atelier");
  start.type = "submit";
  start.addEventListener("click", async () => {
    start.disabled = true;
    try {
      const ids = cast.value;
      await post("/game", {
        mode,
        humanName: nameInput.value,
        aiCount: Number(countSelect.value),
        aiPlayers: modelPickers.map((picker, index) => ({ ...picker.value, characterId: ids[index] })),
        rotations: Number(rotations.value),
        difficulty: difficulty.value,
        roundSeconds: Number(roundSeconds.value),
        imageQuality: imageQuality.value,
      });
      sfx.play("cardFlick");
      setup.close();
    } catch (error) {
      toast(error.message, { tone: "error" });
      sfx.play("error");
    } finally {
      start.disabled = false;
    }
  });

  form.append(modeField, nameLabel, castField, selects, modelsField, start);
  setup.body.append(form);
  syncCount();
  return setup;
}

// ------------------------------------------------------------------ seats

function buildSeats() {
  const row = $("seat-row");
  seatNodes.clear();
  row.replaceChildren(...state.players.map((player) => {
    const card = el("article", "sitter");
    const character = player.character ?? { initials: (player.name || "You").slice(0, 2).toUpperCase(), color: "#56708f" };
    const figure = seatFigure({ character: player.character ?? undefined, name: player.name, caption: "", size: "sm" });
    if (!player.character) {
      figure.style.setProperty("--seat-color", character.color);
      figure.querySelector(".kit-initials").textContent = character.initials;
    }
    const text = el("div", "sitter-text");
    const name = el("span", "sitter-name", player.name);
    const caption = el("span", "sitter-caption", player.isHuman ? "Your seat" : modelLabel(player.aiConfig));
    text.append(name, caption);
    const score = el("span", "sitter-score", "0");
    const role = el("span", "sitter-role", "Drawing");
    role.hidden = true;
    card.style.setProperty("--seat-color", player.character?.color ?? "#56708f");
    card.append(figure, text, score, role);
    seatNodes.set(player.seat, { card, figure, caption, score, role, player });
    return card;
  }));
  // Warm every expression now, so a swap later is instant.
  for (const player of state.players) {
    if (!player.character) continue;
    for (const expression of ["thinking", "triumphant", "defeated"]) new Image().src = portraitUrl(player.character.id, expression);
  }
}

function updateSeats() {
  const view = state.view;
  const round = view.round;
  const over = view.phase === "game_over";
  for (const [seatIndex, node] of seatNodes) {
    const seatState = view.seats[seatIndex];
    const isDrawer = round?.drawerSeat === seatIndex && !over;
    const solved = round?.solvedOrder.includes(seatIndex) && !over;
    const passed = round?.passedSeats.includes(seatIndex);
    const thinking = state.thinking?.[seatIndex];
    if (node.score.textContent !== String(seatState.score)) {
      node.score.textContent = String(seatState.score);
      node.score.animate?.([{ scale: 1.5 }, { scale: 1 }], { duration: 500, easing: "cubic-bezier(.2,1.4,.4,1)" });
    }
    node.card.dataset.drawer = String(isDrawer);
    node.card.dataset.solved = String(Boolean(solved));
    node.role.hidden = !isDrawer;
    let caption = node.player.isHuman ? "Your seat" : modelLabel(node.player.aiConfig);
    if (thinking) caption = thinking.status || "Thinking…";
    else if (solved) caption = "Guessed it!";
    else if (passed) caption = "Passed";
    node.caption.textContent = caption;
    node.caption.dataset.busy = String(Boolean(thinking));
    const insight = state.insights?.[seatIndex]?.text;
    if (insight) node.card.title = `${node.player.name} was thinking: ${insight}`;
    else node.card.removeAttribute("title");
    let expression = "neutral";
    if (over) expression = view.result?.winners.includes(seatIndex) ? "triumphant" : "defeated";
    else if (solved) expression = "triumphant";
    else if (thinking) expression = "thinking";
    if (node.expression !== expression) showExpression(node, expression);
  }
}

/** Swaps the portrait only once the new expression has loaded, so the initials never flash through. */
function showExpression(node, expression) {
  node.expression = expression;
  const id = node.player.character?.id;
  if (!id) return setSeatExpression(node.figure, expression);
  const image = new Image();
  image.src = portraitUrl(id, expression);
  const swap = () => { if (node.expression === expression) setSeatExpression(node.figure, expression); };
  image.decode().then(swap, swap);
}

// ------------------------------------------------------------------ the wall of slips

function addSlip({ id, kind, who, text, seat, correct }) {
  if (slipIds.has(id)) return;
  slipIds.add(id);
  const slip = el("li", "slip");
  slip.dataset.kind = kind;
  if (correct) slip.dataset.correct = "true";
  const player = state.players.find((entry) => entry.name === who || entry.seat === seat);
  if (player?.character?.color) slip.style.setProperty("--seat-color", player.character.color);
  if (who) slip.append(el("span", "slip-who", who));
  slip.append(el("span", "slip-text", text));
  const list = $("slips");
  list.prepend(slip);
  while (list.children.length > 80) list.lastElementChild.remove();
}

function updateSlips() {
  const items = [
    ...state.log.map((entry) => ({ ...entry, correct: entry.text.startsWith("got it") })),
    ...state.tableTalk.map((entry) => ({ id: `talk-${entry.id}`, kind: "talk", who: entry.playerName, text: `“${entry.text}”`, seat: entry.speaker, at: entry.at })),
  ].sort((left, right) => left.at - right.at);
  for (const item of items) addSlip(item);
}

// ------------------------------------------------------------------ the frame

function panel(...children) {
  $("frame-panel").replaceChildren(...children);
}

function waitingPanel(title, copy, hand) {
  const wrap = el("div", "painting-wait");
  const dance = el("div", "brush-dance");
  dance.append(el("i"), el("i"), el("i"));
  wrap.append(dance, el("h2", "panel-title", title));
  if (copy) wrap.append(el("p", "panel-copy", copy));
  if (hand) wrap.append(el("p", "panel-hand", hand));
  return wrap;
}

function welcomePanel() {
  const wrap = el("div");
  wrap.append(
    el("h2", "panel-title", "The atelier is quiet"),
    el("p", "panel-copy", "Pull up a stool. One of you paints a secret word, the rest guess before the sun goes down. The house painters describe their word and the easel paints it; you can paint yours by hand."),
  );
  const open = el("button", "hang", "Set up a sitting");
  open.type = "button";
  open.addEventListener("click", () => setupDrawer.open());
  wrap.append(open);
  return wrap;
}

function choosePanel(round) {
  const wrap = el("div");
  wrap.append(el("h2", "panel-title", "Pick your word"), el("p", "panel-copy", "Harder words earn guessers a bonus, and you earn 3 for every correct guess."));
  const cards = el("div", "word-cards");
  round.wordOptions.forEach((option, index) => {
    const card = el("button", "word-card");
    card.type = "button";
    card.style.setProperty("--i", index);
    card.append(el("strong", "", option.word), el("span", "", option.zh), el("small", "", option.difficulty));
    card.addEventListener("click", async () => {
      sfx.play("cardFlick");
      try {
        await post("/action", { type: "choose_word", optionIndex: index });
      } catch (error) {
        toast(error.message, { tone: "error" });
      }
    });
    cards.append(card);
  });
  wrap.append(cards);
  return wrap;
}

function promptPanel(round) {
  const wrap = el("div");
  const tabs = el("div", "mode-tabs");
  for (const [value, label] of [["paint", "Paint it"], ["describe", "Describe it"]]) {
    const button = el("button", "", label);
    button.type = "button";
    button.setAttribute("aria-pressed", String(promptMode === value));
    button.addEventListener("click", () => {
      promptMode = value;
      renderFrame();
    });
    tabs.append(button);
  }
  wrap.append(tabs);
  if (promptMode === "describe") {
    const form = el("form", "prompt-form");
    form.append(el("p", "panel-copy", `Describe “${round.secret.word}” for the easel without naming it, its synonyms or 「${round.secret.zh}」. ${round.promptAttemptsLeft} attempt${round.promptAttemptsLeft === 1 ? "" : "s"} left.`));
    const rejected = (round.promptAttempts ?? []).filter((attempt) => !attempt.accepted).at(-1);
    if (rejected) form.append(el("p", "panel-hand", `Rejected: it said “${rejected.leak.match}”.`));
    const text = el("textarea");
    text.maxLength = state.view.config.maxPromptLength;
    text.placeholder = "A tall striped tower on a rocky coast, beam of light at night…";
    text.value = draftPrompt;
    text.addEventListener("input", () => { draftPrompt = text.value; });
    const send = el("button", "hang", "Hand it to the easel");
    send.type = "submit";
    form.append(text, send);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      send.disabled = true;
      try {
        await post("/action", { type: "submit_prompt", prompt: text.value });
        draftPrompt = "";
        sfx.play("chipClack");
      } catch (error) {
        toast(error.message, { tone: "error" });
      } finally {
        send.disabled = false;
      }
    });
    wrap.append(form);
  }
  return wrap;
}
let draftPrompt = "";

function resultsPanel(view) {
  const wrap = el("div", "results");
  const winners = view.result.winners.map((seat) => state.players[seat].name);
  wrap.append(el("h2", "panel-title", winners.length > 1 ? `${winners.join(" & ")} share the wall` : `${winners[0]} ${winners[0] === "You" ? "take" : "takes"} the salon`));
  const list = el("ol");
  for (const entry of view.result.standings) {
    const item = el("li");
    item.dataset.winner = String(view.result.winners.includes(entry.seat));
    item.append(el("b", "", String(entry.rank)), el("span", "", state.players[entry.seat].name), el("em", "", String(entry.score)));
    list.append(item);
  }
  const again = el("button", "hang", "Another sitting");
  again.type = "button";
  again.addEventListener("click", () => setupDrawer.open());
  const reviews = el("div", "review-row");
  for (const player of state.players.filter((entry) => !entry.isHuman)) {
    const ask = el("button", "ghost", `Ask ${player.name} to review`);
    ask.type = "button";
    ask.addEventListener("click", async () => {
      reviews.querySelectorAll("button").forEach((button) => { button.disabled = true; });
      try {
        const { review } = await post("/review", { seat: player.seat });
        const node = seatNodes.get(player.seat);
        if (node) speak(node.card, review, { placement: matchMedia("(max-width: 760px)").matches ? "bottom" : "right", duration: 14000 });
      } catch (error) {
        toast(error.message, { tone: "error" });
      } finally {
        reviews.querySelectorAll("button").forEach((button) => { button.disabled = false; });
      }
    });
    reviews.append(ask);
  }
  wrap.append(list, reviews, again);
  return wrap;
}

function setPainting(image, blurPx) {
  const painting = $("painting");
  if (!image?.imageRef) {
    painting.hidden = true;
    painting.removeAttribute("src");
    return;
  }
  // At a human table the server blurs the picture itself (stage by stage), so nothing sharper ever
  // reaches the browser; arena spectators get the original with the same blur applied in CSS.
  const serverBlurred = !isArena() && blurPx > 0;
  const src = serverBlurred ? `${image.imageRef}?stage=${image.stage}` : image.imageRef;
  if (painting.getAttribute("src") !== src) painting.src = src;
  painting.hidden = false;
  const scale = (painting.clientWidth || 512) / BLUR_REFERENCE_WIDTH;
  painting.style.filter = blurPx > 0 && !serverBlurred ? `blur(${(blurPx * scale).toFixed(1)}px) saturate(1.05)` : "none";
}

function renderFrame() {
  const view = state?.view;
  const sketch = $("sketch");
  const tools = $("tools");
  const guessBar = $("guess-bar");
  $("stamp").hidden = true;
  if (!view) {
    setPainting(null);
    sketch.hidden = true;
    tools.hidden = true;
    guessBar.hidden = true;
    panel(welcomePanel());
    return;
  }
  const round = view.round;
  const me = humanSeat();
  const drawer = state.players[round.drawerSeat];
  const iAmDrawer = me >= 0 && round.drawerSeat === me;
  const drawingByHand = iAmDrawer && view.phase === "prompting" && promptMode === "paint";
  sketch.hidden = !drawingByHand;
  tools.hidden = !drawingByHand;
  // While painting by hand only the tab strip floats over the canvas; strokes must reach the canvas.
  $("frame-panel").dataset.layer = drawingByHand ? "tabs" : "full";
  const canGuess = me >= 0 && view.phase === "guessing" && !iAmDrawer && !round.solvedOrder.includes(me) && !round.passedSeats.includes(me)
    && round.guesses.filter((guess) => guess.seat === me).length < view.config.maxGuessesPerRound;
  guessBar.hidden = !canGuess;

  switch (view.phase) {
    case "choosing":
      setPainting(null);
      panel(iAmDrawer ? choosePanel(round) : waitingPanel(`${drawer.name} is choosing a word`, isArena() ? "Three cards, one secret." : "Look away from the easel…"));
      break;
    case "prompting":
      setPainting(null);
      if (iAmDrawer) panel(promptPanel(round));
      else panel(waitingPanel(`${drawer.name} is describing the picture`, isArena() && round.secret ? `The word is “${round.secret.word}”. The description must not give it away.` : "The easel listens for a description that never names the word."));
      break;
    case "rendering":
      setPainting(null);
      if (state.aiError?.kind === "image") panel(waitingPanel("The easel stopped", "Retry the picture or skip this round below."));
      else panel(waitingPanel("The easel is painting", null, round.prompt ? `“${round.prompt}”` : "Wet paint. Nobody peek."));
      break;
    case "guessing": {
      panel();
      const blurPx = isArena() ? (round.reveal?.blurPx ?? 0) : (round.image?.blurPx ?? 0);
      setPainting(round.image, blurPx);
      if (me >= 0 && round.solvedOrder.includes(me)) $("stamp").hidden = false;
      break;
    }
    case "round_over": {
      setPainting(round.image, 0);
      if (!round.image?.imageRef) panel(waitingPanel("No painting this round", reasonCopy(round.endReason)));
      else panel();
      break;
    }
    case "game_over":
      setPainting(null);
      panel(resultsPanel(view));
      break;
    default:
      panel();
  }
}

function reasonCopy(reason) {
  return {
    prompt_failed: "Every description named the word, so the round is void.",
    prompt_timeout: "The description never came, so the round is void.",
    image_failed: "The easel could not paint it, so the round is void.",
  }[reason] ?? "";
}

// ------------------------------------------------------------------ tape, notices, clock

function renderTape() {
  const view = state?.view;
  const word = $("tape-word");
  const meta = $("tape-meta");
  if (!view) {
    word.textContent = "Pull up a stool";
    word.dataset.shape = "false";
    meta.textContent = "";
    return;
  }
  const round = view.round;
  if (view.phase === "game_over") {
    word.textContent = "Fin.";
    word.dataset.shape = "false";
    meta.textContent = `${view.totalTurns} rounds`;
    return;
  }
  if (round.secret) {
    word.textContent = `${round.secret.word} · ${round.secret.zh}`;
    word.dataset.shape = "false";
  } else if (round.wordShape) {
    word.textContent = round.wordShape;
    word.dataset.shape = "true";
  } else {
    word.textContent = "choosing…";
    word.dataset.shape = "false";
  }
  const bits = [`Round ${round.number}/${view.totalTurns}`];
  if (round.difficulty) bits.push(round.difficulty);
  if (round.wordLength && !round.secret) bits.push(`${round.wordShape.replace(/[^_]/g, "").length} letters`);
  meta.textContent = bits.join(" · ");
}

function renderNotice() {
  const notice = $("notice");
  const view = state?.view;
  notice.replaceChildren();
  notice.hidden = true;
  delete notice.dataset.tone;
  if (!view) return;
  if (state.aiError) {
    const who = state.players[state.aiError.seat]?.name ?? "A painter";
    notice.dataset.tone = "error";
    notice.append(el("span", "", `${state.aiError.kind === "image" ? "The easel failed" : `${who}'s model failed`}: ${state.aiError.message}`));
    const retry = el("button", "hang", "Retry");
    retry.type = "button";
    retry.addEventListener("click", () => post("/retry-ai").catch((error) => toast(error.message, { tone: "error" })));
    notice.append(retry);
    if (state.aiError.kind === "image") {
      const skip = el("button", "ghost", "Skip this round");
      skip.type = "button";
      skip.addEventListener("click", () => post("/skip-image").catch((error) => toast(error.message, { tone: "error" })));
      notice.append(skip);
    }
    notice.hidden = false;
    return;
  }
  if (view.phase === "round_over") {
    const round = view.round;
    const lines = el("div");
    lines.append(el("strong", "", round.secret ? `It was “${round.secret.word}” (${round.secret.zh}).` : "Round over."));
    const points = el("div", "points-row");
    for (const player of state.players) {
      const gain = round.points?.[player.seat] ?? 0;
      const chip = el("span", "", `${player.name} +${gain}`);
      chip.dataset.gain = String(gain > 0);
      points.append(chip);
    }
    if (round.prompt) lines.append(el("p", "notice-prompt", `${state.players[round.drawerSeat].name} told the easel: “${round.prompt}”`));
    lines.append(points);
    notice.append(lines);
    const next = el("button", "hang", view.turnNumber >= view.totalTurns ? "See the results" : "Next round");
    next.type = "button";
    next.addEventListener("click", () => post("/next-round").catch((error) => toast(error.message, { tone: "error" })));
    notice.append(next);
    notice.hidden = false;
  }
}

function totalFor(view) {
  if (view.phase === "choosing") return view.config.chooseTimeoutMs;
  if (view.phase === "prompting") return view.config.promptTimeoutMs;
  if (view.phase === "guessing") return view.config.roundDurationMs;
  return null;
}

function updateClock() {
  const clock = $("clock");
  const view = state?.view;
  const root = document.documentElement;
  const round = view?.round;
  const total = view ? totalFor(view) : null;
  const drawerIsAi = round && !state.players[round.drawerSeat]?.isHuman;
  const frozen = state?.paused || state?.aiError;
  if (!view || !total || !round?.deadlineAt || (drawerIsAi && view.phase !== "guessing")) {
    clock.hidden = true;
    root.style.setProperty("--t", view?.phase === "round_over" || view?.phase === "game_over" ? "0.35" : "1");
    return;
  }
  const remaining = Math.max(0, round.deadlineAt - serverNow());
  const t = frozen ? Number(root.style.getPropertyValue("--t") || 1) : Math.max(0, Math.min(1, remaining / total));
  clock.hidden = false;
  if (!frozen) {
    $("clock-text").textContent = String(Math.ceil(remaining / 1000));
    root.style.setProperty("--t", t.toFixed(3));
  }
  const urgent = remaining < 10000 && view.phase === "guessing";
  clock.dataset.urgent = String(urgent);
  const drawerNode = seatNodes.get(round.drawerSeat);
  if (drawerNode) drawerNode.card.dataset.urgent = String(urgent);
}

function renderChrome() {
  const chip = $("round-chip");
  const view = state?.view;
  chip.textContent = view ? (view.phase === "game_over" ? "Sitting over" : `Round ${view.round.number} of ${view.totalTurns}`) : "Atelier closed";
  pauseButton.hidden = !isArena() || view?.phase === "game_over";
  pauseButton.dataset.state = state?.paused ? "paused" : "running";
  pauseButton.textContent = state?.paused ? "Resume" : "Pause";
}

function renderSalon() {
  const history = state?.view?.history ?? [];
  if (history.length === lastHistoryLength) return;
  lastHistoryLength = history.length;
  const pieces = history.filter((item) => item.imageRef);
  $("salon").hidden = pieces.length === 0;
  $("salon-grid").replaceChildren(...pieces.map((item) => {
    const figure = el("figure", "salon-piece");
    const image = el("img");
    image.src = `${item.imageRef}?thumb`;
    image.alt = `${state.players[item.drawerSeat]?.name}'s ${item.word}`;
    image.loading = "lazy";
    figure.append(image, el("figcaption", "", item.word));
    return figure;
  }));
}

// ------------------------------------------------------------------ render

function render(next) {
  if (!next) return;
  clockOffset = next.serverNow - Date.now();
  const previous = state;
  state = next;
  if (next.tableId !== renderedTableId) {
    renderedTableId = next.tableId;
    renderedRound = null;
    lastHistoryLength = -1;
    slipIds.clear();
    $("slips").replaceChildren();
    buildSeats();
  }
  const round = next.view.round;
  if (round.number !== renderedRound) {
    renderedRound = round.number;
    if (humanSeatOf(next) >= 0 && round.drawerSeat === humanSeatOf(next) && next.view.phase === "choosing") atelier.knock();
    promptMode = "paint";
    draftPrompt = "";
    lastOwnGuesses = 0;
    sketchPad.clear();
  }
  const me = humanSeat();
  if (me >= 0) {
    const mine = round.guesses.filter((guess) => guess.seat === me);
    if (mine.length > lastOwnGuesses && mine.at(-1)?.close && !mine.at(-1).correct) toast("So close! Check the spelling.", { tone: "info" });
    lastOwnGuesses = mine.length;
  }
  document.body.dataset.phase = next.view.phase;
  const phaseChanged = previous?.view?.phase !== next.view.phase || previous?.tableId !== next.tableId;
  updateSeats();
  updateSlips();
  renderTape();
  if (phaseChanged || needsFrameRefresh(previous, next)) renderFrame();
  else refreshPaintingOnly();
  renderNotice();
  renderChrome();
  renderSalon();
  updateClock();
}

function needsFrameRefresh(previous, next) {
  const a = previous?.view?.round;
  const b = next.view.round;
  return !a || previous.aiError?.kind !== next.aiError?.kind || a.number !== b.number || a.promptAttemptsLeft !== b.promptAttemptsLeft
    || a.solvedOrder.length !== b.solvedOrder.length || a.passedSeats.length !== b.passedSeats.length
    || a.guesses.length !== b.guesses.length || a.image?.imageRef !== b.image?.imageRef || a.prompt !== b.prompt;
}

function refreshPaintingOnly() {
  const view = state.view;
  if (view.phase !== "guessing") return;
  const round = view.round;
  setPainting(round.image, isArena() ? (round.reveal?.blurPx ?? 0) : (round.image?.blurPx ?? 0));
}

// ------------------------------------------------------------------ hand sketching

const sketchPad = (() => {
  const canvas = $("sketch");
  const context = canvas.getContext("2d");
  const strokes = [];
  let current = null;
  let color = CHARCOAL;
  let size = BRUSH_SIZES[1].size;
  let erasing = false;

  function drawStroke(stroke) {
    context.save();
    context.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over";
    context.strokeStyle = stroke.color;
    context.fillStyle = stroke.color;
    context.lineWidth = stroke.size;
    context.lineCap = "round";
    context.lineJoin = "round";
    const [first, ...rest] = stroke.points;
    context.beginPath();
    if (!rest.length) {
      context.arc(first.x, first.y, stroke.size / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      context.moveTo(first.x, first.y);
      for (let index = 0; index < rest.length; index += 1) {
        const point = rest[index];
        const following = rest[index + 1];
        if (following) context.quadraticCurveTo(point.x, point.y, (point.x + following.x) / 2, (point.y + following.y) / 2);
        else context.lineTo(point.x, point.y);
      }
      context.stroke();
    }
    context.restore();
  }

  function redraw() {
    context.clearRect(0, 0, canvas.width, canvas.height);
    strokes.forEach(drawStroke);
  }

  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * canvas.width, y: ((event.clientY - rect.top) / rect.height) * canvas.height };
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    canvas.setPointerCapture(event.pointerId);
    current = { color, size: erasing ? size * 2.2 : size, erase: erasing, points: [point(event)] };
    strokes.push(current);
    drawStroke(current);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!current) return;
    const events = event.getCoalescedEvents?.() ?? [event];
    for (const item of events) current.points.push(point(item));
    atelier.scratch();
    redraw();
  });
  const end = () => { current = null; };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  return {
    clear() {
      strokes.length = 0;
      redraw();
    },
    undo() {
      strokes.pop();
      redraw();
    },
    setColor(next) {
      color = next;
      erasing = false;
      canvas.style.cursor = "crosshair";
    },
    setSize(next) { size = next; },
    setErasing(next) { erasing = next; },
    get isEmpty() { return strokes.filter((stroke) => !stroke.erase).length === 0; },
    async toPng() {
      const out = document.createElement("canvas");
      out.width = canvas.width;
      out.height = canvas.height;
      const outContext = out.getContext("2d");
      outContext.fillStyle = PAPER;
      outContext.fillRect(0, 0, out.width, out.height);
      outContext.drawImage(canvas, 0, 0);
      return new Promise((resolve) => out.toBlob(resolve, "image/png"));
    },
  };
})();

function buildTools() {
  const palette = $("palette");
  const blobButtons = BLOBS.map((blob) => {
    const button = el("button", "blob");
    button.type = "button";
    button.style.left = `${blob.x}%`;
    button.style.top = `${blob.y}%`;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", "false");
    button.setAttribute("aria-label", blob.name);
    button.title = blob.name;
    button.addEventListener("click", () => {
      sketchPad.setColor(blob.color);
      blobButtons.forEach((other) => other.setAttribute("aria-checked", String(other === button)));
      eraser.setAttribute("aria-pressed", "false");
      document.documentElement.style.setProperty("--brush-color", blob.color);
      atelier.swish();
    });
    palette.append(button);
    return button;
  });
  const brushes = $("brushes");
  const charcoal = el("button", "brush");
  charcoal.type = "button";
  charcoal.title = "Charcoal";
  charcoal.setAttribute("aria-label", "Charcoal");
  charcoal.style.background = CHARCOAL;
  charcoal.addEventListener("click", () => {
    sketchPad.setColor(CHARCOAL);
    blobButtons.forEach((other) => other.setAttribute("aria-checked", "false"));
    eraser.setAttribute("aria-pressed", "false");
    document.documentElement.style.setProperty("--brush-color", CHARCOAL);
  });
  const sizeButtons = BRUSH_SIZES.map((brush, index) => {
    const button = el("button", "brush");
    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(index === 1));
    button.setAttribute("aria-label", `${brush.label} brush`);
    button.title = `${brush.label} brush`;
    const dot = el("i");
    dot.style.setProperty("--size", `${Math.max(4, brush.size / 1.6)}px`);
    button.append(dot);
    button.addEventListener("click", () => {
      sketchPad.setSize(brush.size);
      sizeButtons.forEach((other) => other.setAttribute("aria-checked", String(other === button)));
    });
    return button;
  });
  brushes.append(charcoal, ...sizeButtons);

  const eraser = $("tool-eraser");
  eraser.addEventListener("click", () => {
    const next = eraser.getAttribute("aria-pressed") !== "true";
    eraser.setAttribute("aria-pressed", String(next));
    sketchPad.setErasing(next);
  });
  $("tool-undo").addEventListener("click", () => sketchPad.undo());
  $("tool-clear").addEventListener("click", () => sketchPad.clear());
  $("tool-submit").addEventListener("click", async (event) => {
    if (sketchPad.isEmpty) {
      toast("The canvas is still blank.", { tone: "error" });
      return;
    }
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await post("/sketch", await sketchPad.toPng(), { raw: true });
      sfx.play("chipClack");
    } catch (error) {
      toast(error.message, { tone: "error" });
      sfx.play("error");
    } finally {
      button.disabled = false;
    }
  });
}

// ------------------------------------------------------------------ guessing

function bindGuessing() {
  const bar = $("guess-bar");
  const input = $("guess-input");
  bar.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    try {
      await post("/action", { type: "guess", text });
      input.value = "";
    } catch (error) {
      bar.dataset.shake = "true";
      setTimeout(() => delete bar.dataset.shake, 450);
      toast(error.message, { tone: "error" });
    }
  });
  $("pass-button").addEventListener("click", () => post("/action", { type: "pass" }).catch((error) => toast(error.message, { tone: "error" })));
}

// ------------------------------------------------------------------ live events

function connect() {
  const events = new EventSource(`${API}/events`);
  events.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    const { type, payload } = message;
    if (type === "state") render(payload);
    else if (type === "table_talk") {
      const node = seatNodes.get(payload.speaker);
      if (node) speak(node.card, payload.text, { placement: matchMedia("(max-width: 760px)").matches ? "bottom" : "right" });
    } else if (type === "thinking" && state) {
      const node = seatNodes.get(payload.seat);
      if (node) node.caption.textContent = payload.status;
    } else if (type === "game_event") onGameEvent(payload);
  });
}

function onGameEvent(event) {
  const me = humanSeat();
  switch (event.type) {
    case "guess_correct":
      atelier.chord();
      if (event.seat === me) sfx.play("win");
      break;
    case "guess_wrong":
      sfx.play("tileClack");
      break;
    case "guessing_started":
    case "round_started":
      sfx.play("cardFlick");
      break;
    case "prompt_rejected":
      sfx.play("error");
      break;
    case "round_over":
      atelier.duskBell();
      break;
    case "game_over":
      sfx.play("win");
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------ boot

const pauseButton = el("button", "chip-button", "Pause");
pauseButton.type = "button";
pauseButton.hidden = true;
pauseButton.addEventListener("click", () => post(state?.paused ? "/arena/resume" : "/arena/pause").catch((error) => toast(error.message, { tone: "error" })));

let setupDrawer;

async function boot() {
  [characters, registry] = await Promise.all([loadCharacters(), loadModels()]);
  setupDrawer = buildSetup();
  $("topbar-left").append(backToLobby(), sfx.muteButton());
  $("topbar-right").append(pauseButton, setupDrawer.toggleButton);
  buildTools();
  bindGuessing();
  const initial = await fetch(`${API}/state`).then((response) => response.json()).catch(() => null);
  if (initial) {
    render(initial);
    setupDrawer.close();
  } else {
    renderFrame();
  }
  connect();
  setInterval(updateClock, 250);
  addEventListener("resize", () => state && refreshPaintingOnly());
}

boot().catch((error) => toast(error.message, { tone: "error" }));
