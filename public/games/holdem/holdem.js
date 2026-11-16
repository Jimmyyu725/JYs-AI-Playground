import {
  backToLobby,
  characterPicker,
  drawer,
  loadCharacters,
  loadModels,
  modelPicker,
  prefersReducedMotion,
  seat as kitSeat,
  setSeatCaption,
  setSeatExpression,
  toast,
  transcript as kitTranscript,
} from "/shared/kit.js";
import { sfx } from "/shared/sfx.js";
import { bindTableTalk, speak } from "/shared/speech.js";

const ART = "/assets/rooms/holdem";
const SUIT_NAMES = { S: "spades", H: "hearts", D: "diamonds", C: "clubs" };
const RANK_LABELS = { T: "10", J: "J", Q: "Q", K: "K", A: "A" };
const PHASE_LABELS = {
  waiting: "Waiting",
  preflop: "Pre-flop",
  flop: "The flop",
  turn: "The turn",
  river: "The river",
  showdown: "Showdown",
  hand_over: "Hand complete",
  game_over: "Table closed",
};
// Pip positions (x%, y%) for number cards; pips below the middle are drawn upside down.
const PIPS = {
  2: [[50, 18], [50, 82]],
  3: [[50, 18], [50, 50], [50, 82]],
  4: [[30, 18], [70, 18], [30, 82], [70, 82]],
  5: [[30, 18], [70, 18], [50, 50], [30, 82], [70, 82]],
  6: [[30, 18], [70, 18], [30, 50], [70, 50], [30, 82], [70, 82]],
  7: [[30, 18], [70, 18], [50, 34], [30, 50], [70, 50], [30, 82], [70, 82]],
  8: [[30, 18], [70, 18], [50, 34], [30, 50], [70, 50], [50, 66], [30, 82], [70, 82]],
  9: [[30, 18], [70, 18], [30, 39], [70, 39], [50, 50], [30, 61], [70, 61], [30, 82], [70, 82]],
  10: [[30, 18], [70, 18], [50, 29], [30, 39], [70, 39], [30, 61], [70, 61], [50, 71], [30, 82], [70, 82]],
};
// Seat ellipse radii (percent of the table) in the phone layout; they match --rx / --ry in holdem.css.
const PHONE_RX = 39;
const PHONE_RY = 40;
const CHIP_DENOMS = [
  [500, "black"],
  [100, "navy"],
  [25, "emerald"],
  [5, "oxblood"],
  [1, "cream"],
];

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};
const fmt = (value) => Number(value ?? 0).toLocaleString("en-US");
const motion = () => !prefersReducedMotion();

const view = {
  state: null,
  previous: null,
  seatEls: new Map(),
  tableKey: "",
  seenLogs: new Set(),
  lensSeat: null,
  lensText: "",
  portraits: {},
  characters: [],
  registry: null,
  pendingAction: false,
};

// ---------------------------------------------------------------- network

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

async function act(path, body = {}) {
  if (view.pendingAction) return null;
  view.pendingAction = true;
  renderActions();
  try {
    const state = await api(path, body);
    applyState(state);
    return state;
  } catch (error) {
    sfx.play("error");
    toast(error.message, { tone: "error" });
    return null;
  } finally {
    view.pendingAction = false;
    renderActions();
  }
}

// ---------------------------------------------------------------- cards

function suitIcon(suit, className = "suit") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#suit-${suit}`);
  svg.append(use);
  return svg;
}

function cardName(code) {
  const ranks = { T: "Ten", J: "Jack", Q: "Queen", K: "King", A: "Ace" };
  return `${ranks[code[0]] ?? code[0]} of ${SUIT_NAMES[code[1]]}`;
}

/** A card element. `code` is like "QH", or "BACK" for a hidden card. */
function cardElement(code) {
  const card = el("div", "card");
  const inner = el("div", "card-inner");
  const face = el("div", "card-face");
  const back = el("div", "card-back");
  inner.append(face, back);
  card.append(inner);
  setCardFace(card, code);
  return card;
}

function setCardFace(card, code) {
  card.dataset.code = code;
  const face = card.querySelector(".card-face");
  face.replaceChildren();
  if (!code || code === "BACK") {
    card.classList.add("is-down");
    card.setAttribute("role", "img");
    card.setAttribute("aria-label", "Face-down card");
    return;
  }
  const [rank, suit] = code;
  card.classList.remove("is-down");
  card.dataset.suit = suit;
  card.dataset.color = suit === "H" || suit === "D" ? "red" : "black";
  card.setAttribute("role", "img");
  card.setAttribute("aria-label", cardName(code));
  const label = RANK_LABELS[rank] ?? rank;
  if ("JQK".includes(rank)) {
    card.dataset.kind = "court";
    const art = el("img", "court-art");
    art.alt = "";
    art.decoding = "async";
    art.src = `${ART}/court-${rank.toLowerCase()}-${SUIT_NAMES[suit]}.webp`;
    face.append(art);
  } else if (rank === "A") {
    card.dataset.kind = "ace";
    const medallion = el("span", "ace-medallion");
    medallion.append(suitIcon(suit, "suit ace-suit"));
    face.append(medallion);
  } else {
    card.dataset.kind = "pips";
    const pips = el("span", "pips");
    for (const [x, y] of PIPS[Number(label)]) {
      const pip = suitIcon(suit, "suit pip");
      pip.style.left = `${x}%`;
      pip.style.top = `${y}%`;
      if (y > 50) pip.classList.add("is-flipped");
      pips.append(pip);
    }
    face.append(pips);
  }
  for (const corner of ["tl", "br"]) {
    const index = el("span", `index ${corner}`);
    index.append(el("b", null, label), suitIcon(suit));
    face.append(index);
  }
}

// ---------------------------------------------------------------- chips

function chipStack(amount, { max = 6 } = {}) {
  const stack = el("span", "chip-stack");
  let rest = amount;
  const chips = [];
  for (const [value, color] of CHIP_DENOMS) {
    while (rest >= value && chips.length < max) {
      chips.push(color);
      rest -= value;
    }
  }
  if (!chips.length) chips.push("cream");
  chips.reverse().forEach((color, index) => {
    const chip = el("img", "chip");
    chip.alt = "";
    chip.src = `${ART}/chip-${color}.webp`;
    chip.style.setProperty("--i", index);
    stack.append(chip);
  });
  return stack;
}

// ---------------------------------------------------------------- seats

/** Ellipse position for seat i of n, human/first seat at the bottom, clockwise. */
function seatPosition(index, count) {
  const angle = Math.PI / 2 + (index * 2 * Math.PI) / count;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

function characterForSeat(player) {
  if (!player.character) return null;
  const expressions = view.portraits[player.character.id];
  // Only point the kit at portraits that exist, so missing art falls back to initials without a 404.
  return expressions?.includes("neutral") ? player.character : { ...player.character, id: undefined };
}

function expressionFor(player, state) {
  const available = view.portraits[player.character?.id] ?? [];
  let wanted = "neutral";
  const winners = new Set((state.lastShowdown?.pots ?? []).flatMap((pot) => pot.winners));
  if (state.aiThinking?.seat === player.seat) wanted = "thinking";
  else if (["hand_over", "game_over", "showdown"].includes(state.phase) && winners.has(player.seat)) wanted = "triumphant";
  else if (player.folded || (!player.inHand && player.stack <= 0)) wanted = "defeated";
  return available.includes(wanted) ? wanted : "neutral";
}

function buildSeats(state) {
  const seatsHost = $("seats");
  seatsHost.replaceChildren();
  view.seatEls.clear();
  const count = state.players.length;
  $("table").dataset.players = String(count);
  for (const player of state.players) {
    const { x, y } = seatPosition(player.seat, count);
    const root = el("article", "seat");
    root.dataset.seat = String(player.seat);
    root.dataset.side = y > 0.35 ? "bottom" : y < -0.35 ? "top" : x < 0 ? "left" : "right";
    if (player.isHuman) root.classList.add("is-human");
    root.style.setProperty("--x", x.toFixed(3));
    root.style.setProperty("--y", y.toFixed(3));
    root.style.setProperty("--seat-color", player.character?.color ?? "var(--brass)");
    const cards = el("div", "hole-cards");
    const portrait = kitSeat({
      character: characterForSeat(player) ?? undefined,
      name: player.name,
      caption: player.isHuman ? "You" : player.character?.title ?? "",
      size: player.isHuman ? "sm" : "sm",
    });
    portrait.classList.add("seat-portrait");
    const plate = el("div", "seat-plate");
    const stack = el("span", "seat-stack");
    const tag = el("span", "seat-tag");
    plate.append(stack, tag);
    const dealer = el("span", "dealer-button", "D");
    dealer.setAttribute("aria-label", "Dealer button");
    const model = el("span", "seat-model", player.aiConfig ? `${player.aiConfig.model} · ${player.aiConfig.reasoningEffort}` : "");
    root.append(cards, portrait, plate, dealer);
    if (player.aiConfig) root.append(model);
    seatsHost.append(root);
    view.seatEls.set(player.seat, root);
  }
}

function dealOrigin(seatEl) {
  const table = $("table").getBoundingClientRect();
  const rect = seatEl.getBoundingClientRect();
  return {
    dx: table.left + table.width / 2 - (rect.left + rect.width / 2),
    dy: table.top + table.height * 0.18 - (rect.top + rect.height / 2),
  };
}

function renderSeat(player, state, { newHand }) {
  const root = view.seatEls.get(player.seat);
  if (!root) return;
  const isActor = state.currentActorSeat === player.seat;
  const winners = new Set((state.lastShowdown?.pots ?? []).flatMap((pot) => pot.winners));
  root.dataset.active = String(isActor);
  root.dataset.thinking = String(state.aiThinking?.seat === player.seat);
  root.classList.toggle("is-folded", player.folded);
  root.classList.toggle("is-out", !player.inHand && player.stack <= 0);
  root.classList.toggle("is-winner", ["hand_over", "game_over"].includes(state.phase) && winners.has(player.seat));
  root.classList.toggle("is-all-in", player.allIn);
  root.querySelector(".dealer-button").hidden = state.dealerSeat !== player.seat;
  root.querySelector(".seat-stack").textContent = player.stack > 0 || player.inHand ? fmt(player.stack) : "Out";
  const evaluation = state.lastShowdown?.evaluations?.[player.seat];
  const tag = root.querySelector(".seat-tag");
  tag.textContent = ["hand_over", "game_over"].includes(state.phase) && evaluation ? evaluation : player.lastAction || "";
  const portrait = root.querySelector(".seat-portrait");
  setSeatExpression(portrait, expressionFor(player, state));
  portrait.dataset.active = String(isActor);
  if (!player.isHuman) setSeatCaption(portrait, player.character?.title ?? "");

  const host = root.querySelector(".hole-cards");
  const codes = player.holeCards ?? [];
  const current = [...host.children];
  if (newHand || current.length !== codes.length) {
    host.replaceChildren();
    const origin = newHand && motion() ? dealOrigin(root) : null;
    codes.forEach((code, index) => {
      const card = cardElement(code);
      if (origin) {
        card.classList.add("is-dealing");
        card.style.setProperty("--from-x", `${origin.dx}px`);
        card.style.setProperty("--from-y", `${origin.dy}px`);
        card.style.setProperty("--deal-delay", `${(index * state.players.length + player.seat) * 70}ms`);
        card.addEventListener("animationend", () => card.classList.remove("is-dealing"), { once: true });
      }
      host.append(card);
    });
  } else {
    codes.forEach((code, index) => {
      const card = current[index];
      if (card.dataset.code === code) return;
      const wasDown = card.dataset.code === "BACK";
      setCardFace(card, code);
      if (wasDown && motion()) {
        card.classList.add("is-down");
        requestAnimationFrame(() => requestAnimationFrame(() => card.classList.remove("is-down")));
      }
    });
  }
}

// ---------------------------------------------------------------- bets, pot, board

function renderBets(state, previous) {
  const host = $("bets");
  const count = state.players.length;
  const live = new Set();
  for (const player of state.players) {
    if (player.streetBet <= 0) continue;
    live.add(String(player.seat));
    let bet = host.querySelector(`[data-seat="${player.seat}"]`);
    const before = previous?.handNumber === state.handNumber ? previous.players[player.seat]?.streetBet ?? 0 : 0;
    if (!bet) {
      bet = el("div", "bet");
      bet.dataset.seat = String(player.seat);
      const { x, y } = seatPosition(player.seat, count);
      bet.style.setProperty("--x", x.toFixed(3));
      bet.style.setProperty("--y", y.toFixed(3));
      // Phone layout: chips sit just under each seat's plate (beside the cards for the bottom seat),
      // because the narrow felt has no room between the seats and the board.
      const bottom = y > 0.9;
      bet.style.setProperty("--pbx", (bottom ? 76 : 50 + x * PHONE_RX).toFixed(2));
      bet.style.setProperty("--pby", (bottom ? 50 + y * PHONE_RY - 8 : 50 + y * PHONE_RY + 22).toFixed(2));
      host.append(bet);
    }
    if (Number(bet.dataset.amount) !== player.streetBet) {
      bet.dataset.amount = String(player.streetBet);
      bet.replaceChildren(chipStack(player.streetBet, { max: 5 }), el("span", "bet-amount", fmt(player.streetBet)));
      if (player.streetBet > before && motion()) {
        const seatEl = view.seatEls.get(player.seat);
        if (seatEl) {
          const from = seatEl.getBoundingClientRect();
          const to = bet.getBoundingClientRect();
          bet.animate(
            [
              { transform: `translate(${from.left + from.width / 2 - (to.left + to.width / 2)}px, ${from.top + from.height / 2 - (to.top + to.height / 2)}px) scale(.7)`, opacity: 0.2 },
              { transform: "translate(0, 0) scale(1)", opacity: 1 },
            ],
            { duration: 420, easing: "cubic-bezier(.2,.7,.2,1)" },
          );
        }
      }
    }
  }
  for (const bet of [...host.children]) {
    if (live.has(bet.dataset.seat)) continue;
    // Street over: chips slide into the pot.
    if (motion() && previous && state.handNumber === previous.handNumber) {
      const pot = $("pot-plaque").getBoundingClientRect();
      const rect = bet.getBoundingClientRect();
      const animation = bet.animate(
        [
          { transform: "translate(0,0)", opacity: 1 },
          { transform: `translate(${pot.left + pot.width / 2 - (rect.left + rect.width / 2)}px, ${pot.top + pot.height / 2 - (rect.top + rect.height / 2)}px) scale(.6)`, opacity: 0 },
        ],
        { duration: 460, easing: "cubic-bezier(.4,0,.2,1)" },
      );
      animation.onfinish = () => bet.remove();
    } else {
      bet.remove();
    }
  }
}

function renderBoard(state, { newHand }) {
  const host = $("community");
  if (newHand) host.replaceChildren();
  const slots = [...host.querySelectorAll(".card")];
  const codes = state.communityCards;
  if (slots.length > codes.length) host.replaceChildren();
  const existing = host.querySelectorAll(".card").length;
  codes.slice(existing).forEach((code, offset) => {
    const card = cardElement(code);
    if (motion()) {
      card.classList.add("is-down", "is-arriving");
      card.style.setProperty("--deal-delay", `${offset * 140}ms`);
      setTimeout(() => {
        card.classList.remove("is-down");
        sfx.play("cardFlick");
      }, 260 + offset * 140);
    } else if (offset === 0) {
      sfx.play("cardFlick");
    }
    host.append(card);
  });
  // Placeholders keep the board steady while the streets arrive.
  host.querySelectorAll(".card-slot").forEach((slot) => slot.remove());
  for (let index = codes.length; index < 5; index += 1) host.append(el("span", "card-slot"));

  const potShown = state.pot || (state.lastShowdown?.pots ?? []).reduce((sum, pot) => sum + pot.amount, 0);
  countTo($("pot-value"), potShown);
  $("street-label").textContent = streetLine(state);
}

function countTo(node, target) {
  const start = Number(node.dataset.value ?? 0);
  node.dataset.value = String(target);
  if (!motion() || start === target) {
    node.textContent = fmt(target);
    return;
  }
  const began = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - began) / 520);
    node.textContent = fmt(Math.round(start + (target - start) * (1 - (1 - t) ** 3)));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function streetLine(state) {
  if (["hand_over", "game_over"].includes(state.phase) && state.lastShowdown) {
    // Side pots with the same winners read as one line.
    const merged = new Map();
    for (const pot of state.lastShowdown.pots) {
      const key = `${pot.winners.join(",")}|${pot.description}`;
      const entry = merged.get(key) ?? { ...pot, amount: 0 };
      entry.amount += pot.amount;
      merged.set(key, entry);
    }
    return [...merged.values()]
      .map((pot) => `${pot.winners.map((seat) => state.players[seat].name).join(" & ")} win${pot.winners.length === 1 ? "s" : ""} ${fmt(pot.amount)}${pot.description === "Uncontested" ? "" : ` with ${pot.description.toLowerCase()}`}`)
      .join("\n");
  }
  return PHASE_LABELS[state.phase] ?? state.phase;
}

function sweepPot(state) {
  if (!motion()) return;
  const pot = $("pot-plaque").getBoundingClientRect();
  for (const potResult of state.lastShowdown?.pots ?? []) {
    for (const seat of potResult.winners) {
      const seatEl = view.seatEls.get(seat);
      if (!seatEl) continue;
      const target = seatEl.getBoundingClientRect();
      const flyer = chipStack(Math.max(1, Math.round(potResult.amount / potResult.winners.length)), { max: 6 });
      flyer.classList.add("chip-flyer");
      flyer.style.left = `${pot.left + pot.width / 2}px`;
      flyer.style.top = `${pot.top + pot.height / 2}px`;
      document.body.append(flyer);
      const dx = target.left + target.width / 2 - (pot.left + pot.width / 2);
      const dy = target.top + target.height / 2 - (pot.top + pot.height / 2);
      // A curved rake stroke: out along the felt, then in to the winner.
      flyer
        .animate(
          [
            { transform: "translate(-50%, -50%) scale(1)", opacity: 1 },
            { transform: `translate(calc(-50% + ${dx * 0.45 + dy * 0.18}px), calc(-50% + ${dy * 0.45 - dx * 0.12}px)) scale(1.05)`, opacity: 1, offset: 0.5 },
            { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.7)`, opacity: 0 },
          ],
          { duration: 900, delay: 350, easing: "cubic-bezier(.3,.6,.2,1)", fill: "both" },
        )
        .finished.then(() => flyer.remove(), () => flyer.remove());
    }
  }
}

// ---------------------------------------------------------------- action bar

function humanPlayer(state) {
  return state?.players.find((player) => player.isHuman) ?? null;
}

function setContext(eyebrow, title, copy = "") {
  $("context-eyebrow").textContent = eyebrow;
  $("context-title").textContent = title;
  $("context-copy").textContent = copy;
}

function button(label, className, onClick, { key, disabled = false } = {}) {
  const node = el("button", `brass-button ${className}`);
  node.type = "button";
  node.append(el("span", null, label));
  if (key) {
    node.append(el("kbd", null, key));
    node.dataset.key = key.toLowerCase();
  }
  node.disabled = disabled || view.pendingAction;
  node.addEventListener("click", onClick);
  return node;
}

function renderActions() {
  const state = view.state;
  const panel = $("action-panel");
  panel.replaceChildren();
  panel.dataset.mode = "idle";
  if (!state) {
    setContext("Welcome", "Open the setup to take a seat", "The house seats a random set of guests at every new table.");
    panel.append(button("Open setup", "primary", () => setup.open()));
    return;
  }
  const actor = state.players.find((player) => player.seat === state.currentActorSeat);
  const human = humanPlayer(state);

  if (state.aiError) {
    panel.dataset.mode = "error";
    setContext("Request paused", `${state.aiError.playerName}'s model did not answer`, state.aiError.message);
    panel.append(button("Retry the request", "primary", () => act("/api/retry-ai")));
    if (state.arena) panel.append(button("New table", "ghost", () => setup.open()));
    return;
  }

  if (state.arena) {
    panel.dataset.mode = "arena";
    const { handsPlayed, handTarget, paused, finished } = state.arena;
    const progress = handTarget ? `${handsPlayed} / ${handTarget} hands` : `${handsPlayed} hands`;
    if (finished) setContext("Arena complete", `${leader(state).name} leads the salon`, `${progress}. Results are on the ladder.`);
    else if (state.aiThinking) setContext(`Arena · ${progress}`, `${state.aiThinking.playerName} is deciding`, state.aiThinking.status ?? "");
    else setContext(`Arena · ${progress}`, paused ? "The arena is paused" : PHASE_LABELS[state.phase] ?? "", "");
    const meter = el("span", "arena-meter");
    meter.style.setProperty("--progress", handTarget ? Math.min(1, handsPlayed / handTarget) : 0);
    panel.append(meter);
    if (!finished) {
      panel.append(button(paused ? "Resume arena" : "Pause arena", "primary", () => act(paused ? "/api/arena/resume" : "/api/arena/pause")));
    }
    if ((paused || finished) && ["hand_over", "game_over"].includes(state.phase)) panel.append(reviewControl(state));
    panel.append(button("New table", "ghost", () => setup.open()));
    return;
  }

  if (state.phase === "game_over") {
    panel.dataset.mode = "over";
    const best = leader(state);
    setContext("Table closed", best.isHuman ? "You leave with the most chips" : `${best.name} leaves with the most chips`, "The session is on the ladder.");
    panel.append(reviewControl(state), button("New table", "primary", () => setup.open()));
    return;
  }

  if (state.canStartNextHand) {
    panel.dataset.mode = "between";
    const pots = state.lastShowdown?.pots ?? [];
    const humanWon = pots.some((pot) => pot.winners.includes(human?.seat));
    setContext("Hand complete", humanWon ? "The pot is yours" : streetLine(state).split("\n")[0] || "The pot is settled", "Deal on when you are ready, or cash out to close the table.");
    panel.append(
      reviewControl(state),
      button("Deal next hand", "primary", () => act("/api/next-hand"), { key: "N" }),
      button("Cash out", "ghost", () => act("/api/cash-out")),
    );
    return;
  }

  if (!actor) {
    setContext(PHASE_LABELS[state.phase] ?? "", "The croupier is dealing", "");
    return;
  }

  if (!actor.isHuman) {
    panel.dataset.mode = "waiting";
    setContext(PHASE_LABELS[state.phase] ?? "", `${actor.name} is deciding`, state.aiThinking?.status ?? "The table waits for the model; there is no turn clock.");
    return;
  }

  const legal = state.legalActions;
  if (!legal) return;
  panel.dataset.mode = "turn";
  const toCall = legal.toCall;
  setContext("Your decision", toCall > 0 ? `${fmt(legal.callAmount)} to call` : "Action is on you", `Pot ${fmt(state.pot)} · your stack ${fmt(actor.stack)}`);

  const row = el("div", "action-row");
  if (legal.actions.includes("fold")) row.append(button("Fold", "danger", () => send("fold"), { key: "F" }));
  if (legal.actions.includes("check")) row.append(button("Check", "", () => send("check"), { key: "C" }));
  if (legal.actions.includes("call")) row.append(button(`Call ${fmt(legal.callAmount)}`, "", () => send("call"), { key: "C" }));
  if (legal.actions.includes("all_in")) row.append(button(`All in ${fmt(legal.allInTotal)}`, "rouge", () => send("all_in"), { key: "A" }));
  panel.append(row);

  if (legal.aggressiveAction) {
    const raise = el("div", "raise");
    const label = legal.aggressiveAction === "bet" ? "Bet" : "Raise to";
    const slider = el("input", "raise-slider");
    slider.type = "range";
    slider.min = String(legal.minimumTotal);
    slider.max = String(legal.maximumTotal);
    slider.step = String(Math.max(1, Math.round(state.bigBlind / 2)));
    slider.value = String(legal.minimumTotal);
    slider.setAttribute("aria-label", `${label} amount`);
    const amount = el("output", "raise-amount", fmt(legal.minimumTotal));
    const sync = () => {
      amount.textContent = fmt(slider.value);
      slider.style.setProperty("--fill", `${((slider.value - slider.min) / Math.max(1, slider.max - slider.min)) * 100}%`);
    };
    slider.addEventListener("input", sync);
    sync();
    const presets = el("div", "raise-presets");
    const potAfterCall = state.pot + toCall;
    for (const [text, fraction] of [["Min", 0], ["½ pot", 0.5], ["¾ pot", 0.75], ["Pot", 1]]) {
      const target = fraction === 0 ? legal.minimumTotal : Math.round(state.currentBet + potAfterCall * fraction);
      const clamped = Math.min(legal.maximumTotal, Math.max(legal.minimumTotal, target));
      const preset = el("button", "preset", text);
      preset.type = "button";
      preset.addEventListener("click", () => {
        slider.value = String(clamped);
        sync();
      });
      presets.append(preset);
    }
    const go = button(label, "primary", () => send(legal.aggressiveAction, Number(slider.value)), { key: "R" });
    raise.append(presets, el("span", "raise-label", label), slider, amount, go);
    panel.append(raise);
  }
}

/** "Ask <guest> to review this hand": a select of AI guests and a button. */
function reviewControl(state) {
  const guests = state.players.filter((player) => !player.isHuman);
  const wrap = el("div", "review-control");
  const choice = el("select", "kit-select review-select");
  choice.setAttribute("aria-label", "Guest to review the hand");
  for (const guest of guests) choice.add(new Option(guest.character?.shortName ?? guest.name, String(guest.seat)));
  const winners = (state.lastShowdown?.pots ?? []).flatMap((pot) => pot.winners).filter((seat) => !state.players[seat].isHuman);
  if (winners.length) choice.value = String(winners[0]);
  const ask = button("Ask for a review", "ghost", () => requestReview(Number(choice.value)));
  ask.classList.add("review-button");
  wrap.append(choice, ask);
  return wrap;
}

async function requestReview(seatNumber) {
  const player = view.state?.players[seatNumber];
  if (!player || view.reviewing) return;
  view.reviewing = true;
  $("lens").dataset.state = "thinking";
  $("lens-state").textContent = "Reviewing";
  $("lens-status").textContent = `${player.name} is looking back over hand ${view.state.handNumber}…`;
  $("lens-text").textContent = "";
  try {
    const result = await api("/api/review", { seat: seatNumber });
    $("lens-status").textContent = `${result.playerName} on hand ${result.handNumber}`;
    $("lens-text").textContent = result.review;
    view.lensText = result.review;
    ledger.add({ who: `${result.playerName} reviews hand ${result.handNumber}`, text: result.review, kind: "talk" });
    const firstSentence = result.review.match(/^.{20,140}?[.!?](\s|$)/)?.[0] ?? result.review.slice(0, 120);
    speak(view.seatEls.get(seatNumber)?.querySelector(".seat-portrait"), firstSentence.trim(), { placement: "top" });
  } catch (error) {
    sfx.play("error");
    toast(`Review failed: ${error.message}`, { tone: "error" });
    $("lens-status").textContent = "The review request failed; you can ask again.";
  } finally {
    view.reviewing = false;
    $("lens").dataset.state = "idle";
    $("lens-state").textContent = "Idle";
  }
}

function leader(state) {
  return state.players.reduce((best, player) => (player.stack > best.stack ? player : best), state.players[0]);
}

function send(action, targetTotal = null) {
  sfx.play(action === "fold" ? "cardFlick" : action === "check" ? "stoneClick" : "chipClack");
  return act("/api/action", { action, targetTotal });
}

document.addEventListener("keydown", (event) => {
  if (event.target.closest("input, select, textarea, .kit-drawer") || event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();
  const target = $("action-panel").querySelector(`button[data-key="${key}"]:not(:disabled)`);
  if (target) {
    event.preventDefault();
    target.click();
  }
});

// ---------------------------------------------------------------- ledger and lens

function renderLens(state) {
  const thinking = state?.aiThinking;
  const who = $("lens-who");
  $("lens-state").textContent = thinking ? "Thinking" : state?.aiError ? "Paused" : "Idle";
  $("lens").dataset.state = thinking ? "thinking" : state?.aiError ? "error" : "idle";
  const seatNumber = thinking?.seat ?? (state?.aiInsights?.[0]?.seat ?? null);
  const player = seatNumber !== null && state ? state.players[seatNumber] : null;
  if (view.lensSeat !== seatNumber) {
    view.lensSeat = seatNumber;
    who.replaceChildren();
    if (player) {
      const portrait = kitSeat({ character: characterForSeat(player) ?? undefined, name: player.name, caption: player.aiConfig ? `${player.aiConfig.model} · ${player.aiConfig.reasoningEffort}` : "", size: "xs" });
      who.append(portrait);
    }
  }
  if (thinking) {
    $("lens-status").textContent = thinking.status ?? "Thinking…";
  } else if (state?.aiInsights?.[0]) {
    const last = state.aiInsights[0];
    $("lens-status").textContent = `${last.playerName} chose ${last.action.replace("_", "-")}${last.latencyMs ? ` in ${(last.latencyMs / 1000).toFixed(1)} s` : ""}`;
    if (!view.lensText) $("lens-text").textContent = last.explanation || last.summary || "";
  } else {
    $("lens-status").textContent = "No guest is deciding.";
  }
}

const ledger = kitTranscript({ title: "Croupier's ledger" });
$("transcript-slot").append(ledger.el);

function syncLogs(state) {
  const fresh = [...state.logs].reverse().filter((entry) => !view.seenLogs.has(entry.id));
  // The engine logs the blinds before "Hand N begins"; the ledger opens each hand with its header.
  fresh.sort((a, b) => (a.handNumber - b.handNumber) || ((b.kind === "hand") - (a.kind === "hand")));
  for (const entry of fresh) {
    view.seenLogs.add(entry.id);
    const kind = entry.kind === "error" ? "system" : entry.kind === "hand" || entry.kind === "street" || entry.kind === "result" ? "system" : "move";
    // The engine still calls the room by its old name; the ledger speaks for this salon.
    const text = entry.text
      .replace(/the Luna Room/g, "Salon Riviera")
      .replace(/\b([2-9TJQKA])([CDHS])\b/g, (_, rank, suit) => `${RANK_LABELS[rank] ?? rank}${{ C: "♣", D: "♦", H: "♥", S: "♠" }[suit]}`);
    const item = ledger.add({ text, kind });
    item.dataset.logKind = entry.kind;
  }
}

// ---------------------------------------------------------------- state

function tableKeyOf(state) {
  return state.players.map((player) => `${player.seat}:${player.name}:${player.character?.id ?? "human"}`).join("|") + `|${state.gameMode}`;
}

function applyState(state) {
  if (!state) return;
  const previous = view.state;
  view.previous = previous;
  view.state = state;
  const key = tableKeyOf(state);
  const newTable = key !== view.tableKey;
  if (newTable) {
    view.tableKey = key;
    view.seenLogs.clear();
    ledger.clear();
    view.lensSeat = undefined;
    buildSeats(state);
  }
  const newHand = newTable || previous?.handNumber !== state.handNumber;

  $("hand-number").textContent = state.handNumber ? String(state.handNumber) : "—";
  $("blind-label").textContent = `${fmt(state.smallBlind)} / ${fmt(state.bigBlind)}`;
  $("mode-label").textContent = state.arena ? "AI arena" : "Play vs AI";
  document.body.dataset.phase = state.phase;
  document.body.dataset.mode = state.arena ? "arena" : "human";

  for (const player of state.players) renderSeat(player, state, { newHand });
  renderBoard(state, { newHand });
  renderBets(state, newTable ? null : previous);
  renderActions();
  renderLens(state);
  syncLogs(state);

  if (!previous || newTable) return;
  // Sounds and set pieces for what just changed.
  if (newHand) {
    if (motion()) state.players.forEach((_, index) => setTimeout(() => sfx.play("cardFlick"), index * 90));
  } else {
    for (const player of state.players) {
      const before = previous.players[player.seat];
      if (!before) continue;
      if (player.streetBet > before.streetBet) sfx.play("chipClack");
      else if (player.lastAction === "Check" && before.lastAction !== "Check") sfx.play("stoneClick");
    }
  }
  const finished = ["hand_over", "game_over"].includes(state.phase) && !["hand_over", "game_over"].includes(previous.phase);
  if (finished) {
    sweepPot(state);
    const human = humanPlayer(state);
    const humanWon = human && (state.lastShowdown?.pots ?? []).some((pot) => pot.winners.includes(human.seat));
    setTimeout(() => sfx.play(humanWon || !human ? "win" : "chipClack"), 500);
  }
  if (state.aiError && !previous.aiError) sfx.play("error");
  const human = humanPlayer(state);
  if (human && state.currentActorSeat === human.seat && previous.currentActorSeat !== human.seat) sfx.play("tileClack");
}

function connect() {
  const events = new EventSource("/api/events");
  events.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "state") applyState(message.payload);
    else if (message.type === "ai_stream") onStream(message.payload);
    else if (message.type === "table_talk") {
      const speaker = view.state?.players[message.payload.speaker];
      ledger.add({ who: speaker?.name ?? message.payload.playerName, text: `“${message.payload.text}”`, kind: "talk" });
    }
  });
  bindTableTalk(events, (speaker) => view.seatEls.get(speaker)?.querySelector(".seat-portrait"), { placement: "top" });
  return events;
}

/** Reasoning summaries arrive as Markdown; the ledger shows them as plain prose. */
function plain(text) {
  return String(text).replace(/\*\*(.+?)\*\*\s*/g, "$1. ").replace(/[*_`#]+/g, "").replace(/\s+/g, " ").trim();
}

function onStream(payload) {
  if (payload.phase === "started") {
    view.lensText = "";
    $("lens-text").textContent = "";
  } else if (payload.phase === "summary_delta") {
    view.lensText += payload.delta;
    $("lens-text").textContent = plain(view.lensText).slice(-900);
  } else if (payload.phase === "completed") {
    view.lensText = "";
    $("lens-text").textContent = plain(payload.summary || payload.explanation || "").slice(0, 900);
    // The ledger keeps the short public rationale; the longer reasoning summary stays in the lens.
    if (payload.explanation) ledger.add({ who: payload.playerName, text: plain(payload.explanation), kind: "reasoning" });
  } else if (payload.phase === "retry") {
    toast(`${payload.playerName}: ${payload.status}`, { tone: "info" });
  }
}

// ---------------------------------------------------------------- setup drawer

const setup = drawer({ title: "Table setup", open: false });
setup.toggleButton.textContent = "Setup";
setup.toggleButton.classList.add("brass-button", "primary");
$("tools").prepend(setup.toggleButton);
$("tools").append(sfx.muteButton());
$("back-slot").append(backToLobby({ label: "Lobby" }));

$("ledger-toggle").addEventListener("click", () => {
  const open = document.body.toggleAttribute("data-ledger-open");
  $("ledger-toggle").setAttribute("aria-expanded", String(open));
  if (open) $("ledger").scrollIntoView({ behavior: motion() ? "smooth" : "auto", block: "start" });
});

function field(labelText, control) {
  const label = el("label", "setup-field");
  label.append(el("span", null, labelText), control);
  return label;
}

function select(name, options, value) {
  const node = el("select", "kit-select");
  node.name = name;
  for (const [optionValue, text] of options) node.add(new Option(text, optionValue));
  node.value = value;
  return node;
}

function buildSetup(characters, registry) {
  const form = el("form", "setup-form");
  form.noValidate = true;
  const defaults = registry.defaults?.holdem ?? registry.defaultConfig;

  const modes = el("fieldset", "mode-switch");
  modes.append(el("legend", null, "How do you want to play?"));
  for (const [value, title, copy] of [
    ["human", "Play vs AI", "Take a seat against the guests"],
    ["arena", "AI arena", "Watch the guests play each other"],
  ]) {
    const option = el("label", "mode-option");
    const input = el("input");
    input.type = "radio";
    input.name = "gameMode";
    input.value = value;
    input.checked = value === "human";
    option.append(input, el("strong", null, title), el("small", null, copy));
    modes.append(option);
  }

  const nameInput = el("input", "kit-input");
  nameInput.name = "humanName";
  nameInput.maxLength = 18;
  nameInput.value = "Player";
  nameInput.autocomplete = "nickname";
  const nameField = field("Your name at the table", nameInput);

  const count = select("opponentCount", [["2", "2"], ["3", "3"], ["4", "4"], ["5", "5"]], "3");
  const countField = field("Guests", count);
  const stack = select("startingStack", [["500", "500"], ["1000", "1,000"], ["2000", "2,000"], ["5000", "5,000"]], "1000");
  const blinds = select("blinds", [["5,10", "5 / 10"], ["10,20", "10 / 20"], ["25,50", "25 / 50"], ["50,100", "50 / 100"]], "10,20");
  const target = select("arenaHandTarget", [["5", "5 hands"], ["10", "10 hands"], ["25", "25 hands"], ["unlimited", "Unlimited"]], "10");
  const targetField = field("Session length", target);
  const grid = el("div", "setup-grid");
  grid.append(countField, field("Starting chips", stack), field("Blinds", blinds), targetField);

  const castTitle = el("div", "setup-section-title");
  castTitle.append(el("strong", null, "Tonight's guests"), el("small", null, "Seated at random. Reroll a seat or choose a guest."));
  const modelsTitle = el("div", "setup-section-title");
  const applyAll = el("button", "text-button", "Use seat 1 for all");
  applyAll.type = "button";
  modelsTitle.append(el("strong", null, "Model at each seat"), applyAll);
  const modelsHost = el("div", "seat-models");

  let configs = [];
  const renderModels = () => {
    modelsHost.replaceChildren();
    picker.characters.forEach((character, index) => {
      configs[index] ??= { ...defaults };
      const row = el("div", "seat-model-row");
      row.append(el("span", "seat-model-name", `${index + 1}. ${character.shortName ?? character.name}`));
      const model = modelPicker({ registry, value: configs[index], label: `Seat ${index + 1}`, onChange: (value) => (configs[index] = value) });
      row.append(model.el);
      modelsHost.append(row);
    });
  };
  const picker = characterPicker({
    characters,
    seats: 3,
    onChange: () => {
      renderModels();
      previewCast();
    },
  });
  // Before the first table, the empty felt shows exactly who the setup will seat.
  const previewCast = () => {
    if (view.state) return;
    const arena = form.elements.gameMode.value === "arena";
    const guests = picker.characters.map((character, index) => ({ seat: index, name: character.name, character, aiConfig: null }));
    const players = arena ? guests : [{ seat: 0, name: nameInput.value.trim() || "Player", isHuman: true, character: null }, ...guests.map((guest) => ({ ...guest, seat: guest.seat + 1 }))];
    buildSeats({ players });
    for (const seatEl of view.seatEls.values()) seatEl.classList.add("is-preview");
  };
  nameInput.addEventListener("input", previewCast);
  applyAll.addEventListener("click", () => {
    configs = configs.map(() => ({ ...configs[0] }));
    renderModels();
  });

  const submit = el("button", "brass-button primary setup-submit", "Take your seat");
  submit.type = "submit";

  const sync = () => {
    const arena = form.elements.gameMode.value === "arena";
    nameField.hidden = arena;
    targetField.hidden = !arena;
    countField.querySelector("span").textContent = arena ? "Players" : "Guests";
    submit.textContent = arena ? "Open the arena" : "Take your seat";
    picker.setSeats(Number(count.value));
    previewCast();
  };
  modes.addEventListener("change", sync);
  count.addEventListener("change", sync);

  form.append(modes, nameField, grid, castTitle, picker.el, modelsTitle, modelsHost, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const [smallBlind, bigBlind] = blinds.value.split(",").map(Number);
    const ids = picker.value;
    const body = {
      gameMode: form.elements.gameMode.value,
      humanName: nameInput.value.trim() || "Player",
      opponentCount: Number(count.value),
      startingStack: Number(stack.value),
      smallBlind,
      bigBlind,
      arenaHandTarget: target.value,
      aiPlayers: ids.map((characterId, index) => ({ ...(configs[index] ?? defaults), characterId })),
    };
    submit.disabled = true;
    try {
      const state = await api("/api/game", body);
      setup.close();
      applyState(state);
      sfx.play("cardFlick");
    } catch (error) {
      sfx.play("error");
      toast(error.message, { tone: "error" });
    } finally {
      submit.disabled = false;
    }
  });
  setup.body.append(form);
  sync();
  renderModels();
}

// ---------------------------------------------------------------- boot

async function boot() {
  const [characters, registry, portraits, state] = await Promise.all([
    loadCharacters(),
    loadModels(),
    api("/api/holdem/portraits").catch(() => ({})),
    api("/api/state").catch(() => null),
  ]);
  view.characters = characters;
  view.registry = registry;
  view.portraits = portraits;
  buildSetup(characters, registry);
  if (state) applyState(state);
  else {
    renderActions();
    $("community").append(...Array.from({ length: 5 }, () => el("span", "card-slot")));
    setup.open();
  }
  connect();
}

boot().catch((error) => toast(`The salon could not open: ${error.message}`, { tone: "error", duration: 10_000 }));
