import {
  backToLobby,
  characterPicker,
  drawer,
  loadCharacters,
  loadModels,
  modelPicker,
  prefersReducedMotion,
  seat as kitSeat,
  setSeatExpression,
  toast,
  transcript,
} from "/shared/kit.js";
import { sfx } from "/shared/sfx.js";
import { speak } from "/shared/speech.js";

const ART = "/assets/rooms/coup/";
const ROLES = {
  Duke: { italian: "Il Duca", art: "card-duke.webp", pitch: 1 },
  Assassin: { italian: "L'Assassino", art: "card-assassin.webp", pitch: 2 },
  Captain: { italian: "Il Capitano", art: "card-captain.webp", pitch: 3 },
  Ambassador: { italian: "L'Ambasciatore", art: "card-ambassador.webp", pitch: 4 },
  Contessa: { italian: "La Contessa", art: "card-contessa.webp", pitch: 5 },
};
const ACTIONS = {
  income: { label: "Income", note: "+1 coin, safe", glyph: "+1" },
  foreign_aid: { label: "Foreign Aid", note: "+2 · Duke blocks", glyph: "+2" },
  tax: { label: "Tax", note: "+3 · as Duke", role: "Duke" },
  exchange: { label: "Exchange", note: "Swap · as Ambassador", role: "Ambassador" },
  steal: { label: "Steal", note: "Take 2 · as Captain", role: "Captain", targeted: true },
  assassinate: { label: "Assassinate", note: "Pay 3 · as Assassin", role: "Assassin", targeted: true },
  coup: { label: "Coup", note: "Pay 7 · unstoppable", glyph: "VII", targeted: true },
};
const ACTION_ORDER = ["income", "foreign_aid", "tax", "exchange", "steal", "assassinate", "coup"];
const VERB = { income: "takes Income", foreign_aid: "asks for Foreign Aid", tax: "levies Tax", exchange: "calls for an Exchange", steal: "moves to Steal", assassinate: "orders an assassination", coup: "launches a Coup" };

const VERB_YOU = { income: "take Income", foreign_aid: "ask for Foreign Aid", tax: "levy Tax", exchange: "call for an Exchange", steal: "move to Steal", assassinate: "order an assassination", coup: "launch a Coup" };
const verbFor = (seat, type) => (state?.humanSeat === seat ? VERB_YOU : VERB)[type] ?? type;

const $ = (selector) => document.querySelector(selector);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const artUrl = (card) => `url("${ART}${ROLES[card]?.art ?? "card-back.webp"}")`;

let state = null;
let characters = [];
let registry = null;
let pickedTarget = null;
let busy = false;
const seen = { tableId: null, log: 0, coins: new Map(), lost: new Map(), talk: new Set(), insights: new Set() };
const seatNodes = new Map();
const revealQueue = [];
let revealing = false;

// ------------------------------------------------------------------ network

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data;
}

async function send(path, body) {
  if (busy) return;
  busy = true;
  try {
    const next = await api(path, body);
    if (next) applyState(next);
  } catch (error) {
    sfx.play("error");
    toast(error.message, { tone: "error" });
  } finally {
    busy = false;
  }
}

function act(action) {
  pickedTarget = null;
  sfx.play(action.type === "challenge" ? "cupSlam" : "cardFlick");
  send("/api/coup/action", { action });
}

// ------------------------------------------------------------------ helpers

const nameOf = (seat) => (state?.seats[seat]?.isHuman ? "You" : state?.seats[seat]?.name ?? `Seat ${seat}`);
const isHumanSeat = (seat) => state && state.humanSeat === seat;
const youAwaited = () => state && state.humanSeat !== null && state.awaitingSeats.includes(state.humanSeat);

function roleCard(card, { className = "role-card", italian = true } = {}) {
  const node = el("div", className);
  node.style.setProperty("--art", artUrl(card));
  if (italian && card) node.dataset.italian = `${ROLES[card].italian}`;
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", card ? `${card} card` : "Face-down card");
  return node;
}

function lightTone(text) {
  return text.replace("_", " ");
}

// ------------------------------------------------------------------ court

function seatNodeFor(entry) {
  let node = seatNodes.get(entry.seat);
  if (node) return node;
  node = el("article", "mask-seat");
  node.dataset.seat = entry.seat;
  const mirror = el("div", "mirror");
  const figure = kitSeat({ character: entry.character, name: entry.name, size: "md" });
  mirror.append(figure);
  node.append(mirror, el("div", "seat-name", entry.name), el("div", "seat-title", entry.character?.title ?? ""));
  const model = el("div", "seat-model", entry.model ? `${entry.model} · ${entry.reasoningEffort}` : "");
  const row = el("div", "seat-row");
  const purse = el("div", "purse");
  purse.innerHTML = `<img src="${ART}coin.webp" alt="" /><b>0</b>`;
  const cards = el("div", "mini-cards");
  row.append(purse, cards);
  node.append(model, row, el("div", "seat-status"));
  node.parts = { figure, purse, cards, status: node.querySelector(".seat-status") };
  seatNodes.set(entry.seat, node);
  return node;
}

function bumpPurse(purse, seat, coins) {
  const before = seen.coins.get(seat);
  purse.querySelector("b").textContent = coins;
  if (before !== undefined && before !== coins) {
    purse.classList.remove("bump");
    void purse.offsetWidth;
    purse.classList.add("bump");
  }
  seen.coins.set(seat, coins);
}

function renderCourt() {
  const court = $("#court");
  const wanted = state.seats.filter((entry) => !isHumanSeat(entry.seat));
  const nodes = wanted.map(seatNodeFor);
  if (court.children.length !== nodes.length || nodes.some((node, index) => court.children[index] !== node)) court.replaceChildren(...nodes);
  const thinking = new Map(state.thinking.map((entry) => [entry.seat, entry]));
  for (const entry of wanted) {
    const node = seatNodes.get(entry.seat);
    const player = state.players[entry.seat];
    node.dataset.alive = String(player.alive);
    node.dataset.active = String(state.activeSeat === entry.seat && !state.over);
    // The gilded mirror: whoever's claim is open to challenge right now.
    const claimant = state.phase === "challenge_action" ? state.pendingAction?.actor : state.phase === "challenge_block" ? state.block?.seat : null;
    node.dataset.claimant = String(claimant === entry.seat);
    const awaited = state.awaitingSeats.includes(entry.seat) && !state.over;
    if (node.dataset.awaited !== String(awaited)) node.dataset.awaited = String(awaited);
    bumpPurse(node.parts.purse, entry.seat, player.coins);
    renderMiniCards(node.parts.cards, entry.seat, player);
    const status = node.parts.status;
    const think = thinking.get(entry.seat);
    let text = "";
    let tone = "";
    if (think) {
      text = "is deciding…";
      tone = "think";
    } else if (state.passed.includes(entry.seat)) {
      text = "passes";
      tone = "pass";
    } else if (state.block?.seat === entry.seat) {
      text = `blocks as ${state.block.card}`;
      tone = "bold";
    } else if (state.pendingAction?.actor === entry.seat && !state.over) {
      text = `claims ${state.pendingAction.claim ?? lightTone(state.pendingAction.type)}`;
      tone = "bold";
    }
    status.textContent = text;
    status.dataset.tone = tone;
    const expression = state.over
      ? state.result?.winner === entry.seat || state.stalemate?.ranking?.[0]?.seat === entry.seat
        ? "triumphant"
        : "defeated"
      : !player.alive
        ? "defeated"
        : think
          ? "thinking"
          : "neutral";
    if (node.parts.figure.dataset.expression !== expression) setSeatExpression(node.parts.figure, expression);
  }
}

function renderMiniCards(container, seat, player) {
  const lostBefore = seen.lost.get(seat) ?? 0;
  const cards = [];
  for (const card of player.revealed) cards.push({ card, lost: true });
  if (player.hidden) for (const card of player.hidden) cards.push({ card, lost: false });
  else for (let index = 0; index < player.influenceCount; index += 1) cards.push({ card: null, lost: false });
  const nodes = cards.map(({ card, lost }, index) => {
    const node = el("span", "mini-card");
    if (card) {
      node.dataset.card = card;
      node.style.setProperty("--art", artUrl(card));
      node.title = lost ? `${card} (lost)` : `${card} (hidden)`;
    }
    node.dataset.lost = String(lost);
    if (lost && index >= lostBefore && seen.tableId === state.id) node.classList.add("unmasking");
    return node;
  });
  container.replaceChildren(...nodes);
  seen.lost.set(seat, player.revealed.length);
}

// ------------------------------------------------------------------ stage

function renderStage() {
  $("#deck-count").textContent = state.deckCount;
  const claim = $("#stage-claim");
  claim.replaceChildren();
  const pending = state.pendingAction;
  if (pending && !state.over) {
    const cards = el("div", "claim-cards");
    if (pending.claim) cards.append(roleCard(pending.claim));
    if (state.block) {
      const block = roleCard(state.block.card);
      block.classList.add("block");
      cards.append(block);
    }
    const text = el("div", "claim-text");
    const heading = el("h2");
    const target = pending.target !== null && pending.target !== undefined ? ` against ${nameOf(pending.target)}` : "";
    heading.innerHTML = "";
    heading.append(`${nameOf(pending.actor)} ${verbFor(pending.actor, pending.type)}${target}`);
    if (pending.claim) {
      heading.append(" as ");
      heading.append(el("em", null, pending.claim));
    }
    text.append(heading);
    const line = el("p");
    if (state.block) line.textContent = `${nameOf(state.block.seat)} ${isHumanSeat(state.block.seat) ? "block" : "blocks"}, claiming the ${state.block.card}.`;
    else if (state.phase === "challenge_action") line.textContent = "The mirror waits: does anyone doubt the claim?";
    else if (state.phase === "block") line.textContent = "The claim stands. Will anyone block?";
    else if (state.phase === "lose_influence") line.textContent = `${nameOf(state.lossPending.seat)} must give up a mask.`;
    else if (state.phase === "exchange") line.textContent = `${nameOf(state.exchange.seat)} ${isHumanSeat(state.exchange.seat) ? "are" : "is"} choosing cards from the court deck.`;
    text.append(line);
    if (state.thinking.length) text.append(el("p", "claim-note", `Waiting on ${state.thinking.map((entry) => nameOf(entry.seat)).join(", ")}…`));
    if (cards.children.length) claim.append(cards);
    claim.append(text);
  } else if (!state.over && state.phase === "action") {
    const text = el("div", "claim-text");
    text.append(el("h2", null, `${nameOf(state.activeSeat)} ${isHumanSeat(state.activeSeat) ? "hold" : "holds"} the floor`));
    text.append(el("p", null, isHumanSeat(state.activeSeat) ? "Choose an action from the fan below." : "The table watches the mask for a tell."));
    if (state.thinking.length) text.append(el("p", "claim-note", `${nameOf(state.thinking[0].seat)} is deciding…`));
    claim.append(text);
  }

  const banner = $("#stage-banner");
  banner.replaceChildren();
  if (state.aiError) {
    const box = el("div", "banner");
    box.append(el("p", null, `${state.aiError.name} could not answer: ${state.aiError.message}`));
    const retry = el("button", "ornate-button teal", "Retry");
    retry.type = "button";
    retry.addEventListener("click", () => send("/api/coup/retry-ai", {}));
    box.append(retry);
    banner.append(box);
  }
  if (state.over) banner.append(resultCard());
}

function resultCard() {
  const box = el("div", "result-card");
  const ranking = state.result?.ranking ?? state.stalemate?.ranking ?? [];
  const winnerSeat = ranking[0]?.seat;
  const winner = state.seats[winnerSeat];
  if (winner && !winner.isHuman) box.append(kitSeat({ character: winner.character, name: winner.name, expression: "triumphant", size: "lg" }));
  const text = el("div");
  const youWon = isHumanSeat(winnerSeat);
  text.append(el("h2", null, state.stalemate ? "The night ends undecided" : youWon ? "The palazzo is yours" : `${nameOf(winnerSeat)} takes the palazzo`));
  if (state.stalemate) text.append(el("p", null, state.stalemate.text));
  const list = el("ol");
  for (const entry of ranking) list.append(el("li", null, `${nameOf(entry.seat)}${state.seats[entry.seat].model ? ` · ${state.seats[entry.seat].model}` : ""}`));
  text.append(list);
  const again = el("button", "ornate-button primary", "Set a new table");
  again.type = "button";
  again.addEventListener("click", () => setup.open());
  const reviewers = el("div", "reviewers");
  for (const entry of state.seats.filter((candidate) => !candidate.isHuman)) {
    const ask = el("button", "ornate-button ghost", `Ask ${entry.name} to review`);
    ask.type = "button";
    ask.addEventListener("click", () => requestReview(entry.seat));
    reviewers.append(ask);
  }
  text.append(again, reviewers);
  for (const [key, review] of reviews) {
    if (!key.startsWith(`${state.id}:`)) continue;
    const quote = el("blockquote", "review");
    quote.append(el("cite", null, review.name), el("p", null, review.text));
    text.append(quote);
  }
  box.append(text);
  return box;
}

const reviews = new Map();

async function requestReview(seat) {
  const key = `${state.id}:${seat}`;
  if (reviews.has(key)) return;
  const tableId = state.id;
  reviews.set(key, { name: state.seats[seat].name, text: "is gathering their thoughts behind the mask…" });
  renderStage();
  try {
    const result = await api("/api/coup/review", { seat });
    reviews.set(key, { name: result.name, text: result.review });
  } catch (error) {
    reviews.delete(key);
    toast(error.message, { tone: "error" });
  }
  if (state.id === tableId) renderStage();
}

// ------------------------------------------------------------------ your hand

function renderYou() {
  if (state.humanSeat === null) return;
  const me = state.players[state.humanSeat];
  const hand = $("#hand");
  const lostBefore = seen.lost.get(state.humanSeat) ?? 0;
  const cards = [...me.revealed.map((card) => ({ card, lost: true })), ...(me.hidden ?? []).map((card) => ({ card, lost: false }))];
  const choosing = youAwaited() && state.phase === "lose_influence";
  hand.replaceChildren(
    ...cards.map(({ card, lost }, index) => {
      const node = el("button", "hand-card");
      node.type = "button";
      node.style.setProperty("--art", artUrl(card));
      node.dataset.italian = ROLES[card].italian;
      node.dataset.lost = String(lost);
      node.setAttribute("aria-label", lost ? `${card}, lost` : choosing ? `Give up your ${card}` : `Your ${card}`);
      if (lost && index >= lostBefore && seen.tableId === state.id) node.classList.add("unmasking");
      if (choosing && !lost) {
        node.dataset.choosable = "true";
        node.addEventListener("click", () => act({ type: "reveal", card }));
      } else {
        node.tabIndex = lost ? -1 : 0;
      }
      return node;
    }),
  );
  seen.lost.set(state.humanSeat, me.revealed.length);
  const purse = $("#your-purse");
  if (!purse.firstChild) purse.innerHTML = `<img src="${ART}coin.webp" alt="" /><b>0</b><small>your purse</small>`;
  bumpPurse(purse, state.humanSeat, me.coins);
  renderFan();
}

function unavailableReason(type, me) {
  if (me.coins >= 10 && type !== "coup") return "At 10 coins you must Coup";
  if (type === "coup") return "Needs 7 coins";
  if (type === "assassinate") return "Needs 3 coins";
  if (type === "steal") return "Nobody has coins to steal";
  return "Not available now";
}

function blade({ className = "", art = null, glyph = "", title, note, disabled = false, onClick, index = 0, count = 1, hint = "" }) {
  const node = el("button", `blade ${className}`.trim());
  node.type = "button";
  const offset = index - (count - 1) / 2;
  node.style.setProperty("--i", index);
  node.style.setProperty("--tilt", `${offset * 1.5}deg`);
  node.style.setProperty("--lift", `${offset * offset * 2}px`);
  const icon = el("span", "glyph", glyph);
  if (art) icon.style.setProperty("--art", artUrl(art));
  const label = el("span");
  label.append(el("b", null, title), el("small", null, note));
  node.append(icon, label);
  node.disabled = disabled;
  if (hint) node.title = hint;
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

function renderFan() {
  const fan = $("#fan");
  const prompt = $("#prompt");
  fan.replaceChildren();
  prompt.replaceChildren();
  const me = state.players[state.humanSeat];
  if (state.over) return;
  if (!me.alive) {
    prompt.textContent = "Your masks are gone. Watch the rest of the night unfold.";
    return;
  }
  const legal = state.legalActions;
  if (!youAwaited()) {
    prompt.textContent = state.aiError ? "The table is paused." : "The others are deciding…";
    return;
  }
  const pending = state.pendingAction;
  switch (state.phase) {
    case "action": {
      prompt.innerHTML = me.coins >= 10 ? "You hold <strong>10 coins</strong>: you must launch a Coup." : "Your turn. <strong>Claim any role</strong>: nobody knows your masks.";
      ACTION_ORDER.forEach((type, index) => {
        const options = legal.filter((entry) => entry.action.type === type);
        const info = ACTIONS[type];
        fan.append(
          blade({
            index,
            count: ACTION_ORDER.length,
            art: info.role,
            glyph: info.glyph ?? "",
            title: info.label,
            note: info.note,
            disabled: options.length === 0,
            className: pickedTarget === type ? "picked" : "",
            hint: options.length ? "" : unavailableReason(type, me),
            onClick: () => {
              if (!info.targeted) return act(options[0].action);
              pickedTarget = pickedTarget === type ? null : type;
              sfx.play("cardFlick");
              renderFan();
            },
          }),
        );
      });
      if (pickedTarget) {
        const targets = el("div", "targets");
        targets.append(el("span", null, `${ACTIONS[pickedTarget].label}: choose a target`));
        legal
          .filter((entry) => entry.action.type === pickedTarget)
          .forEach((entry, index) => {
            const target = state.seats[entry.action.target];
            targets.append(blade({ index, glyph: target.character?.initials ?? "", title: target.name, note: `${state.players[target.seat].coins} coins · ${state.players[target.seat].influenceCount} masks`, onClick: () => act(entry.action) }));
          });
        fan.append(targets);
      }
      break;
    }
    case "challenge_action":
    case "challenge_block": {
      const claimant = state.phase === "challenge_block" ? state.block.seat : pending.actor;
      const card = state.phase === "challenge_block" ? state.block.card : pending.claim;
      prompt.innerHTML = "";
      prompt.append(`${nameOf(claimant)} claims the `, el("strong", null, card), ". Do you believe it?");
      legal.forEach((entry, index) => {
        if (entry.action.type === "challenge") fan.append(blade({ index, className: "challenge", art: card, title: "Challenge", note: `Call ${nameOf(claimant)} a liar`, onClick: () => act(entry.action) }));
        else fan.append(blade({ index, className: "pass", glyph: "~", title: "Let it pass", note: "Accept the claim", onClick: () => act(entry.action) }));
      });
      break;
    }
    case "block": {
      const against = pending.target === state.humanSeat ? "you" : "the table";
      prompt.innerHTML = "";
      prompt.append(`${nameOf(pending.actor)} ${verbFor(pending.actor, pending.type)}${pending.target !== null ? ` against ${against}` : ""}. `, el("strong", null, "Block it?"));
      legal.forEach((entry, index) => {
        if (entry.action.type === "block") fan.append(blade({ index, className: "block", art: entry.action.card, title: `Block as ${entry.action.card}`, note: ROLES[entry.action.card].italian, onClick: () => act(entry.action) }));
        else fan.append(blade({ index, className: "pass", glyph: "~", title: "Allow it", note: "Do not block", onClick: () => act(entry.action) }));
      });
      break;
    }
    case "lose_influence":
      prompt.innerHTML = "You must <strong>give up a mask</strong>. Choose a card to turn face up.";
      break;
    case "exchange":
      prompt.innerHTML = `The court deck offers you new masks. <strong>Keep ${state.exchange.keepCount}</strong>.`;
      legal.forEach((entry, index) => {
        fan.append(blade({ index, art: entry.action.keep[0], title: `Keep ${entry.action.keep.join(" + ")}`, note: "Return the rest", onClick: () => act(entry.action) }));
      });
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------ dramatic reveals

function queueReveal(entry) {
  revealQueue.push(entry);
  if (!revealing) nextReveal();
}

function nextReveal() {
  const entry = revealQueue.shift();
  if (!entry) {
    revealing = false;
    return;
  }
  revealing = true;
  const layer = $("#reveal-layer");
  const bluff = entry.success;
  const box = el("div", "reveal");
  box.dataset.outcome = bluff ? "bluff" : "truth";
  const mirror = el("div", "reveal-mirror");
  const card = el("div", "reveal-card");
  const face = el("div", "face");
  face.style.setProperty("--art", bluff ? `url("${ART}card-back.webp")` : artUrl(entry.claim));
  card.append(face);
  if (bluff) {
    card.insertAdjacentHTML(
      "beforeend",
      `<svg class="crack" viewBox="0 0 100 150" preserveAspectRatio="none" aria-hidden="true"><g fill="none" stroke="#fff6e6" stroke-width="1.1" stroke-linecap="round" opacity=".9"><path d="M52 60 L40 20 L44 0 M52 60 L74 38 L96 30 M52 60 L80 82 L100 96 M52 60 L60 104 L54 150 M52 60 L22 86 L0 92 M52 60 L18 48 L0 40 M40 20 L28 12 M74 38 L82 16 M60 104 L76 122 M22 86 L20 110"/></g><circle cx="52" cy="60" r="3" fill="#fff6e6"/></svg>`,
    );
  }
  mirror.append(card);
  const caption = el("div", "reveal-caption");
  caption.append(
    el("h2", null, bluff ? `Bluff! No ${entry.claim}.` : `A true ${entry.claim}.`),
    el("p", null, bluff ? `${nameOf(entry.seat)} caught ${nameOf(entry.claimant)} lying, and a mask must fall.` : `${nameOf(entry.claimant)} shows the card. ${nameOf(entry.seat)} doubted wrongly and pays with a mask.`),
  );
  box.append(mirror, caption);
  layer.replaceChildren(box);
  sfx.play("cupSlam");
  setTimeout(() => sfx.play(bluff ? "error" : "cardFlick"), 900);
  const hold = prefersReducedMotion() ? 1600 : 2600;
  setTimeout(() => {
    box.classList.add("leaving");
    setTimeout(() => {
      box.remove();
      nextReveal();
    }, 450);
  }, hold);
}

// ------------------------------------------------------------------ room sounds

let audioContext = null;
function pluck(card) {
  if (sfx.muted || !ROLES[card]) return;
  try {
    audioContext ??= new AudioContext();
    const now = audioContext.currentTime;
    // A harpsichord-like pluck: Duke lowest, Contessa highest.
    const frequency = 196 * 2 ** ((ROLES[card].pitch * 2) / 12);
    for (const [ratio, level] of [[1, 0.16], [2, 0.06], [3, 0.03]]) {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = "sawtooth";
      osc.frequency.value = frequency * ratio;
      gain.gain.setValueAtTime(level, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
      const filter = audioContext.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(4200, now);
      filter.frequency.exponentialRampToValueAtTime(600, now + 0.5);
      osc.connect(filter).connect(gain).connect(audioContext.destination);
      osc.start(now);
      osc.stop(now + 0.75);
    }
  } catch {
    // Audio is optional.
  }
}

function clink(count) {
  for (let index = 0; index < Math.min(count, 4); index += 1) setTimeout(() => sfx.play("chipClack"), index * 110);
}

// ------------------------------------------------------------------ log + effects

function handleNewLog(entries, fresh) {
  for (const entry of entries) {
    const kind = entry.kind === "start" || entry.kind === "game_over" || entry.kind === "eliminated" ? "system" : "move";
    log.add({ text: entry.text, kind });
    if (fresh) continue;
    if (entry.kind === "challenge") queueReveal(entry);
    else if (entry.kind === "resolve" && ["income", "foreign_aid", "tax", "steal"].includes(entry.action)) clink({ income: 1, foreign_aid: 2, tax: 3, steal: entry.amount ?? 2 }[entry.action]);
    else if ((entry.kind === "action" || entry.kind === "block") && entry.claim) pluck(entry.claim);
    else if (entry.kind === "lose_influence") sfx.play("stoneClick");
    else if (entry.kind === "action") sfx.play("cardFlick");
    else if (entry.kind === "game_over") sfx.play("win");
  }
}

function applyState(next) {
  if (!next) return;
  if (state && next.id === state.id && next.step < state.step) return;
  const freshTable = seen.tableId !== next.id;
  if (freshTable) {
    seatNodes.clear();
    $("#court").replaceChildren();
    seen.coins.clear();
    seen.lost.clear();
    seen.log = 0;
    log.clear();
    pickedTarget = null;
  }
  const firstLoad = state === null;
  state = next;
  document.body.dataset.mode = state.mode;
  document.body.dataset.phase = state.phase;
  $("#turn-label").textContent = state.over ? `Final · ${state.turn} turns` : `Turn ${state.turn}`;
  const pause = $("#pause-button");
  pause.hidden = state.mode !== "arena" || state.over;
  pause.textContent = state.paused ? "Resume" : "Pause";
  if (freshTable) for (const talk of state.tableTalk ?? []) addTalk(talk, false);
  const newEntries = state.log.slice(seen.log);
  seen.log = state.log.length;
  if (!freshTable) seen.tableId = state.id;
  renderCourt();
  renderStage();
  renderYou();
  handleNewLog(newEntries, freshTable && firstLoad);
  for (const [seat, insight] of Object.entries(state.insights ?? {})) {
    const key = `${state.id}:${seat}:${insight.step}`;
    if (!insight.summary || seen.insights.has(key)) continue;
    seen.insights.add(key);
    const summary = insight.summary.replace(/\*\*(.+?)\*\*/g, "$1:").replace(/\s+/g, " ");
    log.add({ who: `${nameOf(Number(seat))} thinks`, text: summary.length > 260 ? `${summary.slice(0, 257)}…` : summary, kind: "reasoning" });
  }
  seen.tableId = state.id;
}

function addTalk(talk, live = true) {
  if (!talk || seen.talk.has(talk.id)) return;
  seen.talk.add(talk.id);
  log.add({ who: talk.playerName, text: talk.text, kind: "talk" });
  if (live) {
    const anchor = seatNodes.get(talk.speaker);
    if (anchor) speak(anchor, talk.text, { placement: "bottom" });
  }
}

// ------------------------------------------------------------------ setup drawer

const log = transcript({ title: "The night's ledger" });
let setup;

function buildSetup() {
  setup = drawer({ title: "Seat the masquerade", open: false });
  const body = setup.body;
  let mode = "human-vs-ai";
  let count = 4;

  const modeSection = el("section", "setup-section");
  modeSection.append(el("h3", null, "Who plays"));
  const modeButtons = el("div", "segmented");
  const modeOptions = [
    ["human-vs-ai", "Play the table"],
    ["arena", "Watch an AI arena"],
  ];
  for (const [value, label] of modeOptions) {
    const button = el("button", null, label);
    button.type = "button";
    button.dataset.value = value;
    button.addEventListener("click", () => {
      mode = value;
      sync();
    });
    modeButtons.append(button);
  }
  modeSection.append(modeButtons);

  const countSection = el("section", "setup-section");
  countSection.append(el("h3", null, "Seats at the table"));
  const countButtons = el("div", "segmented");
  for (let value = 2; value <= 6; value += 1) {
    const button = el("button", null, String(value));
    button.type = "button";
    button.dataset.value = String(value);
    button.addEventListener("click", () => {
      count = value;
      sync();
    });
    countButtons.append(button);
  }
  countSection.append(countButtons);

  const nameSection = el("section", "setup-section");
  nameSection.append(el("h3", null, "Your name"));
  const nameInput = el("input", "setup-input");
  nameInput.maxLength = 24;
  nameInput.placeholder = "You";
  nameInput.setAttribute("aria-label", "Your name");
  nameSection.append(nameInput);

  const castSection = el("section", "setup-section");
  castSection.append(el("h3", null, "The masked guests"));
  const modelsWrap = el("div", "seat-models");
  const cast = characterPicker({ characters, seats: 3, onChange: () => buildModelRows() });
  castSection.append(cast.el);

  const modelSection = el("section", "setup-section");
  modelSection.append(el("h3", null, "Minds behind the masks"));
  const shared = modelPicker({ registry, label: "Every seat", onChange: () => buildModelRows(true) });
  const perSeat = el("details");
  perSeat.append(el("summary", null, "Choose a model per seat"), modelsWrap);
  modelSection.append(shared.el, perSeat);
  let seatPickers = [];

  function buildModelRows(reset = false) {
    const previous = seatPickers.map((picker) => picker.value);
    seatPickers = cast.characters.map((character, index) => {
      const value = !reset && previous[index] ? previous[index] : shared.value;
      const picker = modelPicker({ registry, value, label: character.shortName ?? character.name });
      return picker;
    });
    modelsWrap.replaceChildren(
      ...seatPickers.map((picker, index) => {
        const label = el("label");
        label.append(cast.characters[index].shortName ?? cast.characters[index].name, picker.el);
        return label;
      }),
    );
  }

  const start = el("button", "ornate-button primary", "Raise the curtain");
  start.type = "button";
  start.addEventListener("click", async () => {
    const aiPlayers = cast.value.map((characterId, index) => ({ ...(perSeat.open ? seatPickers[index].value : shared.value), characterId }));
    seen.talk.clear();
    await send("/api/coup/game", { mode, playerCount: count, humanName: nameInput.value, aiPlayers });
    if (state) {
      setup.close();
      sfx.play("win");
    }
  });

  function sync() {
    for (const button of modeButtons.children) button.setAttribute("aria-pressed", String(button.dataset.value === mode));
    for (const button of countButtons.children) button.setAttribute("aria-pressed", String(Number(button.dataset.value) === count));
    nameSection.hidden = mode === "arena";
    cast.setSeats(mode === "arena" ? count : count - 1);
    buildModelRows();
    start.textContent = mode === "arena" ? "Begin the arena" : "Raise the curtain";
  }

  body.append(modeSection, countSection, nameSection, castSection, modelSection, start, $("#rules-template").content.cloneNode(true));
  sync();
}

// ------------------------------------------------------------------ boot

async function boot() {
  [characters, registry] = await Promise.all([loadCharacters(), loadModels()]);
  $("#topbar-start").append(backToLobby());
  buildSetup();
  $("#topbar-end").append(sfx.muteButton(), setup.toggleButton);
  setup.toggleButton.textContent = "Table";
  $("#pause-button").addEventListener("click", () => send(state?.paused ? "/api/coup/arena/resume" : "/api/coup/arena/pause", {}));
  $("#ledger").append(log.el);

  const initial = await api("/api/coup/state").catch(() => null);
  if (initial) applyState(initial);
  else {
    document.body.dataset.phase = "idle";
    $("#stage-claim").append(idleCard());
    setup.open();
  }

  const events = new EventSource("/api/coup/events");
  events.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "state") applyState(message.payload);
    else if (message.type === "table_talk") addTalk(message.payload);
    else if (message.type === "ai_error") {
      sfx.play("error");
      toast(`${message.payload.name}'s request failed. Press Retry to ask again.`, { tone: "error" });
    }
  });
}

function idleCard() {
  const text = el("div", "claim-text");
  text.append(el("h2", null, "The palazzo is lit, the masks are waiting"));
  text.append(el("p", null, "Open the table setup to seat the guests. Claim any role, bluff boldly, and call out the characters who lie."));
  return text;
}

boot().catch((error) => toast(`Could not open the room: ${error.message}`, { tone: "error" }));
