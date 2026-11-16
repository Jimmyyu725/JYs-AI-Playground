import {
  backToLobby, characterPicker, drawer, loadCharacters, loadModels, modelPicker, portraitUrl,
  prefersReducedMotion, seat as kitSeat, toast, transcript,
} from "/shared/kit.js";
import { sfx } from "/shared/sfx.js";
import { bindTableTalk, speak } from "/shared/speech.js";
import { laneSfx } from "/games/doudizhu/lane-sfx.js";

const ART = "/assets/rooms/doudizhu";
const SUITS = {
  S: { glyph: "♠", name: "spades" },
  H: { glyph: "♥", name: "hearts" },
  C: { glyph: "♣", name: "clubs" },
  D: { glyph: "♦", name: "diamonds" },
};
const RANK_LABEL = { T: "10" };
const COURT = { J: "j", Q: "q", K: "k" };
const COMBO_ZH = {
  single: "单张", pair: "对子", triple: "三张", triple_single: "三带一", triple_pair: "三带二",
  straight: "顺子", pair_straight: "连对", airplane: "飞机", airplane_single: "飞机带翅膀",
  airplane_pair: "飞机带对", four_two_single: "四带二", four_two_pair: "四带两对",
  bomb: "炸弹", rocket: "王炸",
};

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const dom = {
  table: $("table"),
  seats: [$("seat-0"), $("seat-1"), $("seat-2")],
  phaseMark: $("phase-mark"), phaseText: $("phase-text"), phaseDetail: $("phase-detail"),
  elapsed: $("elapsed"), arenaToggle: $("arena-toggle"),
  bottomCards: $("bottom-cards"), trick: $("trick"), notice: $("table-notice"),
  handDock: $("hand-dock"), hand: $("hand"), handTitle: $("hand-title"), handRole: $("hand-role"), handMug: $("hand-mug"),
  bidStrips: $("bid-strips"), playButtons: $("play-buttons"),
  passButton: $("pass-button"), clearButton: $("clear-button"), playButton: $("play-button"), hint: $("hint"),
  bidValue: $("bid-value"), bombValue: $("bomb-value"), multiplierValue: $("multiplier-value"), stakeMultiplier: $("stake-multiplier"),
  liveIndicator: $("live-indicator"), lensWho: $("lens-who"), lensStatus: $("lens-status"), lensSummary: $("lens-summary"), insights: $("insights"),
  bulb: $("bulb-pool"), drift: $("paper-drift"), flash: $("flash"),
};

let state = null;
let selected = new Set();
let liveSummary = "";
let busy = false;
let requestsInFlight = 0;
let lastPayload = null;
const seen = { hand: null, trickKey: null, bombs: 0, revealed: false, resultKey: null, recordKey: null };
const seatViews = [null, null, null];

/* ---------- Cards ---------- */

function cardFace(code, { size = "md", tag = "div" } = {}) {
  const card = el(tag, "card");
  card.dataset.size = size;
  card.dataset.code = code;
  if (code === "BACK") {
    card.classList.add("is-back");
    card.setAttribute("aria-label", "Face-down card");
    return card;
  }
  if (code === "SJ" || code === "BJ") {
    const big = code === "BJ";
    card.classList.add("is-joker", big ? "joker-big" : "joker-small");
    card.style.setProperty("--art", `url("${ART}/joker-${big ? "big" : "small"}.webp")`);
    const index = el("span", "index joker-index", "JOKER");
    card.append(index);
    card.setAttribute("aria-label", big ? "Big joker" : "Small joker");
    return card;
  }
  const rank = code[0];
  const suit = SUITS[code[1]];
  const label = RANK_LABEL[rank] ?? rank;
  card.dataset.suit = suit.name;
  card.setAttribute("aria-label", `${label} of ${suit.name}`);
  const index = el("span", "index");
  index.append(el("b", null, label), el("i", null, suit.glyph));
  card.append(index);
  if (COURT[rank]) {
    card.classList.add("is-court");
    card.style.setProperty("--art", `url("${ART}/court-${COURT[rank]}-${suit.name}.webp")`);
    const corner = index.cloneNode(true);
    corner.classList.add("index-end");
    card.append(corner);
  } else {
    card.append(el("span", "pip", suit.glyph));
    const corner = index.cloneNode(true);
    corner.classList.add("index-end");
    card.append(corner);
  }
  return card;
}

function rankWord(code) {
  if (code === "SJ") return "small joker";
  if (code === "BJ") return "big joker";
  return RANK_LABEL[code[0]] ?? code[0];
}

/** Reasoning summaries arrive as Markdown; the lens shows plain text. */
function plainText(text) {
  return String(text ?? "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#+\s*/gm, "").trim();
}

/* ---------- Requests ---------- */

async function api(path, body) {
  requestsInFlight += 1;
  try {
    const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let payload = null;
    try { payload = await response.json(); } catch { /* empty body */ }
    if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
    return payload;
  } finally {
    requestsInFlight -= 1;
  }
}

async function act(path, body) {
  if (busy) return;
  busy = true;
  renderControls();
  try {
    const next = await api(path, body);
    selected.clear();
    liveSummary = "";
    applyState(next);
  } catch (error) {
    sfx.play("error");
    toast(error.message, { tone: "error" });
  } finally {
    busy = false;
    if (state) renderControls();
  }
}

/* ---------- Seats ---------- */

function preloadThen(url, callback) {
  const probe = new Image();
  probe.onload = () => callback(url);
  probe.src = url;
}

function setExpression(view, expression) {
  if (view.expression === expression) return;
  view.expression = expression;
  view.seat.dataset.expression = expression;
  const image = view.seat.querySelector(".kit-portrait img");
  const characterId = view.player.character?.id;
  if (!image || !characterId) return;
  // Not every expression is painted yet: switch only once the image has actually loaded.
  preloadThen(portraitUrl(characterId, expression), (url) => {
    if (view.expression === expression) image.src = url;
  });
}

function buildSeat(index, player) {
  const zone = dom.seats[index];
  zone.replaceChildren();
  zone.dataset.speaker = String(index);
  const view = { key: `${player.name}|${player.character?.id ?? "human"}`, player, expression: "neutral" };
  const card = el("div", "seat-card");
  const portrait = player.isHuman
    ? kitSeat({ name: player.name, caption: "You", size: "md" })
    : kitSeat({ character: player.character, name: player.character?.shortName ?? player.name, caption: player.character?.title ?? "", size: "md" });
  const cap = el("img", "landlord-cap");
  cap.src = `${ART}/landlord-badge.webp`;
  cap.alt = "Landlord";
  portrait.querySelector(".kit-portrait").after(cap);
  const mug = el("span", "mug");
  mug.append(el("b", null, "0"));
  mug.title = "Cards left";
  const meta = el("div", "seat-meta");
  const role = el("span", "seat-role");
  const model = el("span", "seat-model", player.isHuman ? "Human seat" : modelLabel(player.aiConfig));
  meta.append(role, model);
  const action = el("span", "seat-action");
  const cards = el("div", "seat-cards");
  card.append(portrait, mug, meta, action);
  zone.append(card, cards);
  Object.assign(view, { seat: portrait, mug, role, action, cards, model });
  seatViews[index] = view;
  return view;
}

let registry = null;
function modelLabel(config) {
  if (!config) return "";
  const entry = registry?.models.find((model) => model.id === config.model);
  return `${entry?.shortLabel ?? entry?.label ?? config.model} · ${config.reasoningEffort}`;
}

function renderSeat(index) {
  const player = state.players[index];
  const showInZone = !(player.isHuman && state.gameMode !== "arena");
  const zone = dom.seats[index];
  zone.hidden = !showInZone;
  if (!showInZone) return;
  const key = `${player.name}|${player.character?.id ?? "human"}`;
  const view = seatViews[index]?.key === key ? seatViews[index] : buildSeat(index, player);
  view.player = player;
  const active = state.currentActorSeat === index && state.phase !== "complete";
  zone.dataset.active = String(active);
  zone.dataset.landlord = String(player.isLandlord);
  zone.dataset.team = state.landlordSeat === null ? "" : player.isLandlord ? "landlord" : "farmer";
  view.seat.dataset.active = String(active);
  view.mug.querySelector("b").textContent = String(player.cardCount);
  view.mug.dataset.low = String(player.cardCount > 0 && player.cardCount <= 2 && state.phase === "playing");
  view.role.textContent = state.landlordSeat === null ? "" : player.isLandlord ? "地主 Landlord" : "农民 Farmer";
  const thinking = state.aiThinking?.seat === index;
  let expression = thinking ? "thinking" : "neutral";
  if (state.result) expression = state.result.winningSeats.includes(index) ? "triumphant" : "defeated";
  if (!player.isHuman) setExpression(view, expression);
  view.action.textContent = actionText(player, index);
  view.action.dataset.kind = /pass|不/i.test(view.action.textContent) ? "pass" : view.action.textContent ? "move" : "";

  // Arena reveals every hand, in rows of ten so the corners stay readable; otherwise AI hands are a fan of backs.
  const arena = state.gameMode === "arena";
  const faces = arena ? player.hand : Array.from({ length: Math.min(player.cardCount, 20) }, () => "BACK");
  const signature = faces.join(",");
  if (view.cards.dataset.signature !== signature) {
    view.cards.dataset.signature = signature;
    view.cards.dataset.layout = arena ? "faces" : "backs";
    const rowSize = arena ? 10 : 20;
    const rows = [];
    for (let start = 0; start < faces.length; start += rowSize) rows.push(faces.slice(start, start + rowSize));
    view.cards.replaceChildren(...rows.map((row) => {
      const line = el("div", "fan-row");
      line.style.setProperty("--n", row.length);
      line.append(...row.map((code, cardIndex) => {
        const card = cardFace(code, { size: arena ? "sm" : "xs" });
        card.style.setProperty("--i", cardIndex);
        card.style.setProperty("--n", row.length);
        return card;
      }));
      return line;
    }));
  }
}

function actionText(player, index) {
  if (state.phase === "bidding") {
    if (player.bid === 0) return "不叫 Pass";
    if (player.bid) return `叫 ${player.bid}`;
    return "";
  }
  // A pass only matters while the trick it passed on is still on the table.
  if (state.phase === "playing" && player.lastAction === "Passed" && state.lastPlay) return "不出 Pass";
  return "";
}

/* ---------- Center of the table ---------- */

function renderPhase() {
  const actor = state.players[state.currentActorSeat] ?? null;
  const marks = { bidding: "叫", playing: "出", complete: "胜" };
  dom.phaseMark.textContent = marks[state.phase] ?? "斗";
  if (state.phase === "bidding") {
    dom.phaseText.textContent = state.highestBidderSeat !== null ? `High bid ${state.highestBid} · ${state.players[state.highestBidderSeat].name}` : "Bidding for the landlord seat";
    dom.phaseDetail.textContent = actor ? `${actor.isHuman ? "Your" : `${actor.name}'s`} turn to bid · three passes redeal` : "";
  } else if (state.phase === "playing") {
    const leading = !state.lastPlay || state.leaderSeat === state.currentActorSeat;
    dom.phaseText.textContent = `地主 ${state.players[state.landlordSeat].name} · bid ${state.highestBid}`;
    dom.phaseDetail.textContent = actor ? `${actor.isHuman ? "You" : actor.name} ${leading ? "lead" + (actor.isHuman ? "" : "s") : "to follow"}` : "";
  } else {
    dom.phaseText.textContent = state.result?.winner === "landlord" ? "The landlord takes the hand" : "The farmers take the hand";
    dom.phaseDetail.textContent = `Hand ${state.handNumber} settled`;
  }
  dom.arenaToggle.hidden = state.gameMode !== "arena" || state.phase === "complete";
  dom.arenaToggle.textContent = state.arena?.paused ? "Resume arena" : "Pause arena";
}

function renderBottomCards() {
  const revealed = Boolean(state.bottomRevealed && state.bottomCards.length);
  const signature = `${state.handNumber}:${revealed ? state.bottomCards.join(",") : "hidden"}`;
  if (dom.bottomCards.dataset.signature === signature) return;
  dom.bottomCards.dataset.signature = signature;
  const flip = revealed && !seen.revealed && seen.hand === state.handNumber;
  dom.bottomCards.replaceChildren(...[0, 1, 2].map((index) => {
    const card = cardFace(revealed ? state.bottomCards[index] : "BACK", { size: "sm" });
    card.style.setProperty("--i", index);
    if (flip) card.classList.add("flip-in");
    return card;
  }));
  if (flip) setTimeout(() => sfx.play("cardFlick"), 120);
  seen.revealed = revealed;
}

function trickKeyOf(play) {
  return play ? `${state.handNumber}:${play.seat}:${play.cards.join(",")}` : `${state.handNumber}:none`;
}

function renderTrick() {
  const key = trickKeyOf(state.lastPlay);
  if (dom.trick.dataset.key === key) return;
  const fresh = seen.trickKey !== null && seen.trickKey !== key && Boolean(state.lastPlay);
  dom.trick.dataset.key = key;
  seen.trickKey = key;
  dom.trick.replaceChildren();
  if (!state.lastPlay) {
    dom.trick.dataset.empty = "true";
    dom.trick.append(el("span", "trick-empty", state.phase === "bidding" ? "The bottom three go to whoever wins the bid" : "The table is clear"));
    return;
  }
  dom.trick.dataset.empty = "false";
  const play = state.lastPlay;
  const comboType = play.combo?.type ?? "";
  dom.trick.dataset.combo = comboType;
  const cards = el("div", "trick-cards");
  play.cards.forEach((code, index) => {
    const card = cardFace(code, { size: "md" });
    card.style.setProperty("--i", index);
    card.style.setProperty("--n", play.cards.length);
    if (fresh) card.classList.add("slap");
    cards.append(card);
  });
  const caption = el("p", "trick-caption");
  const who = state.players[play.seat];
  caption.append(el("strong", null, who.isHuman ? "You" : who.name), el("span", "combo-zh", COMBO_ZH[comboType] ?? ""), el("span", null, describe(play)));
  dom.trick.append(cards, caption);
  if (fresh) celebrateCombo(comboType, play.cards.length);
}

function describe(play) {
  return String(play.description ?? "").replace(/\s+(?:[2-9TJQKA][CDHS]|SJ|BJ)(?=\s|$)/g, "").trim();
}

/* ---------- Effects: slap, bombs, rocket, firecracker paper ---------- */

function shake(strength) {
  if (prefersReducedMotion()) return;
  dom.table.classList.remove("shake-soft", "shake-hard");
  void dom.table.offsetWidth;
  dom.table.classList.add(strength === "hard" ? "shake-hard" : "shake-soft");
}

function celebrateCombo(type, count) {
  if (type === "rocket") {
    laneSfx.rocket();
    shake("hard");
    flash();
    burstPaper(PAPER_PER_BOMB);
    burstPaper(24, { ephemeral: true });
    callout("王炸", "Rocket · the stake doubles");
  } else if (type === "bomb") {
    laneSfx.firecrackers(16);
    shake("hard");
    burstPaper(PAPER_PER_BOMB);
    callout("炸弹", "Bomb · the stake doubles");
  } else {
    sfx.play(count > 1 ? "cupSlam" : "cardFlick");
    shake("soft");
  }
}

/** A poster-lettered stamp over the trick that bursts in and fades. */
function callout(zh, en) {
  const stamp = el("div", "callout");
  stamp.setAttribute("role", "status");
  stamp.append(el("strong", null, zh), el("small", null, en));
  dom.trick.parentElement.append(stamp);
  setTimeout(() => stamp.remove(), prefersReducedMotion() ? 1800 : 2200);
}

function flash() {
  if (prefersReducedMotion()) return;
  dom.flash.classList.remove("on");
  void dom.flash.offsetWidth;
  dom.flash.classList.add("on");
}

const PAPER_COLORS = ["#B9120B", "#d4241a", "#9c0f0a", "#e0a43c", "#f05a2a"];
function paperPiece(restX, restY, rotate) {
  const piece = el("i", "paper");
  piece.style.setProperty("--x", `${restX}px`);
  piece.style.setProperty("--y", `${restY}px`);
  piece.style.setProperty("--r", `${rotate}deg`);
  piece.style.background = PAPER_COLORS[Math.floor(Math.random() * PAPER_COLORS.length)];
  return piece;
}

const PAPER_PER_BOMB = 20;

/** Sprays paper from the stake badge; each piece settles on the paving and stays for the hand. */
function burstPaper(count, { ephemeral = false } = {}) {
  const origin = dom.stakeMultiplier.getBoundingClientRect();
  const width = document.documentElement.clientWidth;
  for (let index = 0; index < count; index += 1) {
    const restX = 8 + Math.random() * (width - 24);
    const restY = Math.random() * 18;
    const rotate = Math.round(Math.random() * 360);
    const piece = paperPiece(restX, restY, rotate);
    if (ephemeral) piece.classList.add("spark");
    dom.drift.append(piece);
    if (prefersReducedMotion()) {
      if (ephemeral) piece.remove();
      continue;
    }
    const startX = origin.left + origin.width / 2;
    const startY = origin.top + origin.height / 2;
    const floorY = window.innerHeight - 12 - restY;
    const midX = startX + (Math.random() - 0.5) * 360;
    const midY = startY + 30 + Math.random() * 120;
    piece.animate([
      { transform: `translate(${startX}px, ${startY}px) rotate(0deg) scale(0.4)`, opacity: 0 },
      { transform: `translate(${midX}px, ${midY}px) rotate(${rotate / 2}deg) scale(1.1)`, opacity: 1, offset: 0.25 },
      { transform: `translate(${restX}px, ${floorY}px) rotate(${rotate}deg) scale(1)`, opacity: 1 },
    ], { duration: 1200 + Math.random() * 900, easing: "cubic-bezier(.2,.7,.3,1)", fill: "backwards" }).finished.then(() => {
      if (ephemeral) piece.remove();
    }, () => {});
  }
  dom.stakeMultiplier.classList.remove("pop");
  void dom.stakeMultiplier.offsetWidth;
  dom.stakeMultiplier.classList.add("pop");
}

function syncPaperDrift() {
  // Late joiners and reloads see the paper the hand has already earned.
  const wanted = (state.bombsPlayed ?? 0) * PAPER_PER_BOMB;
  if (dom.drift.querySelectorAll(".paper:not(.spark)").length > wanted) dom.drift.replaceChildren();
  const width = document.documentElement.clientWidth;
  for (let index = dom.drift.querySelectorAll(".paper:not(.spark)").length; index < wanted; index += 1) {
    dom.drift.append(paperPiece(8 + Math.random() * (width - 24), Math.random() * 18, Math.round(Math.random() * 360)));
  }
}

/* ---------- Bulb-light turn indicator ---------- */

function moveBulb() {
  const seatIndex = state?.phase === "complete" ? state.result?.winningSeats?.[0] : state?.currentActorSeat;
  let target = null;
  if (seatIndex != null) {
    const player = state.players[seatIndex];
    target = player.isHuman && state.gameMode !== "arena" ? dom.handDock : dom.seats[seatIndex].querySelector(".seat-card");
  }
  if (!target || target.closest("[hidden]")) {
    dom.bulb.dataset.on = "false";
    return;
  }
  const rect = target.getBoundingClientRect();
  dom.bulb.style.setProperty("--pool-x", `${Math.round(rect.left + rect.width / 2)}px`);
  dom.bulb.style.setProperty("--pool-y", `${Math.round(rect.top + rect.height / 2)}px`);
  dom.bulb.dataset.on = "true";
}

/* ---------- Human hand ---------- */

function human() {
  return state.players.find((player) => player.isHuman) ?? null;
}

function renderHand() {
  const me = human();
  const show = Boolean(me) && state.gameMode !== "arena";
  dom.handDock.hidden = !show;
  if (!show) return;
  dom.handTitle.textContent = me.name;
  dom.handRole.textContent = state.landlordSeat === null ? "" : me.isLandlord ? "地主 Landlord" : "农民 Farmer";
  dom.handDock.dataset.team = state.landlordSeat === null ? "" : me.isLandlord ? "landlord" : "farmer";
  $("hand-cap").hidden = !me.isLandlord;
  dom.handDock.dataset.active = String(state.currentActorSeat === me.seat && state.phase !== "complete");
  dom.handMug.querySelector("b").textContent = String(me.cardCount);
  const dealing = seen.hand !== state.handNumber;
  const signature = `${state.handNumber}:${me.hand.join(",")}`;
  if (dom.hand.dataset.signature !== signature) {
    dom.hand.dataset.signature = signature;
    dom.hand.style.setProperty("--n", me.hand.length);
    dom.hand.replaceChildren(...me.hand.map((code, index) => {
      const card = cardFace(code, { size: "lg", tag: "button" });
      card.type = "button";
      card.style.setProperty("--i", index);
      if (dealing) card.classList.add("deal-in");
      card.addEventListener("click", () => toggleCard(code, card));
      return card;
    }));
    if (dealing && !prefersReducedMotion()) {
      for (let index = 0; index < 8; index += 1) setTimeout(() => sfx.play("cardFlick"), index * 90);
    }
  }
  for (const card of dom.hand.children) {
    const isSelected = selected.has(card.dataset.code);
    card.classList.toggle("is-selected", isSelected);
    card.setAttribute("aria-pressed", String(isSelected));
  }
}

function toggleCard(code) {
  if (!state?.humanCanAct || state.phase !== "playing" || busy) return;
  if (selected.has(code)) selected.delete(code);
  else selected.add(code);
  sfx.play("cardFlick");
  renderHand();
  renderControls();
}

function renderControls() {
  const me = human();
  const humanTable = Boolean(me) && state.gameMode !== "arena";
  const myTurn = humanTable && state.humanCanAct && state.currentActorSeat === me.seat && !busy;
  dom.bidStrips.hidden = !(humanTable && state.phase === "bidding");
  dom.playButtons.hidden = !(humanTable && state.phase === "playing");
  for (const button of dom.bidStrips.querySelectorAll("button")) {
    const score = Number(button.dataset.score);
    button.disabled = !myTurn || (score > 0 && score <= state.highestBid);
  }
  const leading = !state.lastPlay || state.leaderSeat === me?.seat;
  dom.playButton.disabled = !myTurn || selected.size === 0;
  dom.passButton.disabled = !myTurn || leading;
  dom.clearButton.disabled = selected.size === 0;
  let hint = "";
  if (state.aiError) hint = "A model request is paused. Retry it on the table.";
  else if (state.phase === "complete") hint = "The hand is settled.";
  else if (myTurn && state.phase === "bidding") hint = state.highestBid ? `Beat ${state.highestBid} or pass. A bid of 3 takes the seat at once.` : "Bid for the landlord seat, or pass. A bid of 3 takes it at once.";
  else if (myTurn) hint = leading ? "You lead: tap cards for any legal combo." : `Beat ${state.lastPlay ? state.lastPlay.description : "the play"}, or pass.`;
  else if (state.aiThinking) hint = `${state.aiThinking.playerName} is ${state.phase === "bidding" ? "weighing a bid" : "choosing cards"}…`;
  else if (humanTable) hint = "Waiting for the next player.";
  if (myTurn && selected.size) hint = `${selected.size} selected: ${[...selected].map(rankWord).join(" ")}`;
  dom.hint.textContent = hint;
}

/* ---------- Notices: AI pause and the settled hand ---------- */

function renderNotice() {
  dom.notice.replaceChildren();
  dom.notice.hidden = true;
  dom.notice.dataset.kind = "";
  if (state.aiError) {
    dom.notice.hidden = false;
    dom.notice.dataset.kind = "error";
    const retry = el("button", "lane-button primary", "Retry the model");
    retry.type = "button";
    retry.addEventListener("click", () => act("/api/doudizhu/retry-ai", {}));
    dom.notice.append(
      el("span", "notice-mark", "停"),
      el("strong", null, `${state.aiError.playerName}'s request is paused`),
      el("p", null, state.aiError.message),
      retry,
    );
    return;
  }
  if (state.phase !== "complete" || !state.result) return;
  const result = state.result;
  dom.notice.hidden = false;
  dom.notice.dataset.kind = result.winner;
  const me = human();
  const iWon = me && result.winningSeats.includes(me.seat);
  const headline = result.winner === "landlord" ? "地主胜" : "农民胜";
  const sub = me && state.gameMode !== "arena" ? (iWon ? "You win the hand" : "You lose the hand") : result.winner === "landlord" ? "The landlord takes it" : "The farmers take it";
  const breakdown = `Bid ${result.bid} × ${result.multiplier} = ${result.score}` + (result.bombsPlayed ? ` · ${result.bombsPlayed} bomb${result.bombsPlayed === 1 ? "" : "s"}` : "");
  const again = el("button", "lane-button primary", "再来一局 Deal again");
  again.type = "button";
  again.addEventListener("click", dealAgain);
  const change = el("button", "lane-button ghost", "Change the table");
  change.type = "button";
  change.addEventListener("click", () => setup.open());
  const buttons = el("div", "notice-buttons");
  buttons.append(again, change);
  dom.notice.append(el("span", "notice-headline", headline), el("strong", null, sub), el("p", null, breakdown));
  if (result.spring !== "none") dom.notice.append(el("span", "spring-stamp", result.spring === "spring" ? "春天" : "反春"));
  dom.notice.append(buttons, reviewPanel());
  const resultKey = `${state.handNumber}:${result.winner}:${result.score}`;
  if (seen.resultKey !== null && seen.resultKey !== resultKey) {
    sfx.play(iWon || !me || state.gameMode === "arena" ? "win" : "error");
    if (result.spring !== "none") laneSfx.firecrackers(22);
  }
  seen.resultKey = resultKey;
}

/* ---------- Post-game review by a character ---------- */

const reviews = new Map(); // `${handNumber}:${seat}` -> { status: "loading" | "done", text }

function reviewPanel() {
  const panel = el("div", "reviews");
  const asks = el("div", "review-asks");
  for (const player of state.players.filter((candidate) => !candidate.isHuman)) {
    const key = `${state.handNumber}:${player.seat}`;
    const entry = reviews.get(key);
    const ask = el("button", "review-ask", entry?.status === "loading" ? `${player.character?.shortName ?? player.name} is thinking…` : `Ask ${player.character?.shortName ?? player.name} to review this game`);
    ask.type = "button";
    ask.disabled = Boolean(entry);
    ask.style.setProperty("--seat-color", player.character?.color ?? "#e0a43c");
    ask.addEventListener("click", () => askReview(player.seat));
    asks.append(ask);
    if (entry?.status === "done") {
      const note = el("blockquote", "review");
      note.style.setProperty("--seat-color", player.character?.color ?? "#e0a43c");
      note.append(el("strong", null, player.name), el("p", null, entry.text));
      panel.append(note);
    }
  }
  panel.prepend(asks);
  return panel;
}

async function askReview(seat) {
  const key = `${state.handNumber}:${seat}`;
  reviews.set(key, { status: "loading" });
  renderNotice();
  try {
    const result = await api("/api/doudizhu/review", { seat });
    reviews.set(key, { status: "done", text: result.review });
    record.add({ who: `${result.playerName} reviews`, text: result.review, kind: "reasoning" });
  } catch (error) {
    reviews.delete(key);
    sfx.play("error");
    toast(error.message, { tone: "error" });
  }
  if (state?.phase === "complete") renderNotice();
}

/* ---------- Stakes, elapsed time, ledger ---------- */

function renderStakes() {
  dom.bidValue.textContent = state.highestBid ? String(state.highestBid) : "—";
  dom.bombValue.textContent = String(state.bombsPlayed ?? 0);
  const multiplier = state.result?.multiplier ?? state.multiplier ?? 1;
  dom.multiplierValue.replaceChildren(el("span", "times", "×"), String(multiplier));
  dom.stakeMultiplier.dataset.hot = String(multiplier > 1);
}

function updateElapsed() {
  const thinking = state?.aiThinking;
  dom.elapsed.hidden = !thinking;
  document.body.dataset.strain = "0";
  if (!thinking) return;
  const seconds = Math.max(0, Math.round((Date.now() - thinking.startedAt) / 1000));
  dom.elapsed.textContent = `${seconds}s`;
  // The bulb strains harder the longer a model thinks: the room's turn timer.
  document.body.dataset.strain = seconds > 45 ? "2" : seconds > 15 ? "1" : "0";
}
setInterval(updateElapsed, 1000);

function renderLens() {
  const thinking = state.aiThinking;
  dom.liveIndicator.dataset.live = String(Boolean(thinking));
  dom.liveIndicator.lastChild.textContent = thinking ? " Live" : " Idle";
  if (thinking) {
    const player = state.players[thinking.seat];
    dom.lensWho.textContent = `${player.name} · ${modelLabel(player.aiConfig)}`;
    dom.lensStatus.textContent = thinking.status ?? "Thinking…";
    dom.lensSummary.textContent = plainText(liveSummary) || "Waiting for a reasoning summary…";
  } else {
    dom.lensWho.textContent = state.aiError ? `${state.aiError.playerName} is paused` : "No one is thinking";
    dom.lensStatus.textContent = state.aiError ? state.aiError.message : "The room waits for the selected model. Illegal plays retry twice; API errors pause for an explicit retry.";
    dom.lensSummary.textContent = "";
  }
  const signature = state.aiInsights.map((insight) => insight.id).slice(0, 14).join(",");
  if (dom.insights.dataset.signature === signature) return;
  dom.insights.dataset.signature = signature;
  dom.insights.replaceChildren(...state.aiInsights.slice(0, 14).map((insight) => {
    const item = el("li", "insight");
    item.style.setProperty("--who", insight.characterColor ?? "#e0a43c");
    const head = el("div", "insight-head");
    head.append(el("strong", null, insight.playerName), el("span", null, `${insight.action} · ${(insight.latencyMs / 1000).toFixed(1)}s`));
    item.append(head, el("p", null, plainText(insight.summary || insight.explanation)));
    return item;
  }));
}

const record = transcript({ title: "Lane record 牌局记录", limit: 160 });
$("record").append(record.el);

function renderRecord() {
  const entries = [
    ...[...state.logs].reverse().map((entry) => ({ at: Date.parse(entry.at), kind: entry.kind === "play" || entry.kind === "bid" || entry.kind === "pass" ? "move" : "system", text: entry.text, who: "" })),
    ...(state.tableTalk ?? []).map((talk) => ({ at: talk.at, kind: "talk", text: talk.text, who: talk.playerName })),
  ].sort((left, right) => left.at - right.at).slice(-120);
  const key = `${entries.length}:${entries.at(-1)?.at}:${entries.at(-1)?.text}`;
  if (seen.recordKey === key) return;
  seen.recordKey = key;
  record.clear();
  for (const entry of entries) record.add(entry);
}

/* ---------- Render ---------- */

function applyState(next) {
  state = next;
  if (!state) return;
  if (state.phase !== "playing") selected.clear();
  const me = human();
  if (me) selected = new Set([...selected].filter((code) => me.hand.includes(code)));
  if (!state.aiThinking) liveSummary = "";
  render();
}

function render() {
  if (!state) return;
  document.body.dataset.mode = state.gameMode;
  document.body.dataset.phase = state.phase;
  if (seen.hand !== state.handNumber) {
    dom.drift.replaceChildren();
    seen.revealed = Boolean(state.bottomRevealed);
  }
  renderPhase();
  state.players.forEach((_player, index) => renderSeat(index));
  renderBottomCards();
  renderHand();
  renderTrick();
  syncPaperDrift();
  seen.bombs = state.bombsPlayed ?? 0;
  seen.hand = state.handNumber;
  renderControls();
  renderStakes();
  renderNotice();
  renderLens();
  renderRecord();
  updateElapsed();
  requestAnimationFrame(moveBulb);
}

/* ---------- Setup drawer ---------- */

const setup = drawer({ title: "Set the table 摆桌", open: false });
setup.toggleButton.textContent = "Set the table";
setup.toggleButton.classList.add("couplet-toggle");
$("bar-left").prepend(backToLobby({ label: "Lobby" }));
$("bar-right").append(sfx.muteButton(), setup.toggleButton);

let cast = null;
let seatModels = [];
const form = el("form", "lane-setup");
form.noValidate = true;

function buildSetup(characters) {
  form.innerHTML = `
    <fieldset class="mode-pick">
      <legend>Who plays</legend>
      <label><input type="radio" name="mode" value="human" checked /><span><b lang="zh">人机</b><strong>Play vs AI</strong><small>You and two neighbours</small></span></label>
      <label><input type="radio" name="mode" value="arena" /><span><b lang="zh">观战</b><strong>AI arena</strong><small>Three AI seats, all hands shown</small></span></label>
    </fieldset>
    <label class="field" data-human-only><span>Your name</span><input class="kit-input" name="humanName" maxlength="18" value="Player" autocomplete="nickname" /></label>
    <section class="setup-section"><h3>Who sits down <small>Random by default: reroll a seat or choose anyone</small></h3><div data-cast></div></section>
    <section class="setup-section"><h3>Models <small>Each seat picks its own model and reasoning depth</small></h3><div class="seat-models" data-models></div>
      <button class="lane-button ghost small" type="button" data-same>Use the first seat's model everywhere</button></section>
    <button class="lane-button primary deal" type="submit"><span lang="zh">发牌</span> Deal the cards</button>`;
  setup.body.append(form);
  cast = characterPicker({ characters, seats: 2, onChange: renderSeatModels });
  form.querySelector("[data-cast]").append(cast.el);
  form.addEventListener("change", (event) => {
    if (event.target.name !== "mode") return;
    const arena = event.target.value === "arena";
    form.querySelector("[data-human-only]").hidden = arena;
    cast.setSeats(arena ? 3 : 2);
  });
  form.querySelector("[data-same]").addEventListener("click", () => {
    const first = seatModels[0]?.value;
    if (!first) return;
    renderSeatModels(cast.value, Array(seatModels.length).fill(first));
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    deal(collectSetup());
  });
  renderSeatModels(cast.value);
}

function renderSeatModels(ids, values = seatModels.map((picker) => picker.value)) {
  const host = form.querySelector("[data-models]");
  const characters = cast.characters;
  seatModels = ids.map((_id, index) => modelPicker({ registry, value: values[index] ?? registry.defaultConfig, label: characters[index]?.name ?? `Seat ${index + 1}` }));
  host.replaceChildren(...seatModels.map((picker, index) => {
    const row = el("div", "seat-model-row");
    row.style.setProperty("--seat-color", characters[index]?.color ?? "#e0a43c");
    row.append(el("span", "seat-model-name", characters[index]?.shortName ?? characters[index]?.name ?? `Seat ${index + 1}`), picker.el);
    return row;
  }));
}

function collectSetup() {
  const data = new FormData(form);
  const gameMode = data.get("mode") === "arena" ? "arena" : "human";
  return {
    gameMode,
    humanName: String(data.get("humanName") ?? "Player"),
    aiPlayers: cast.value.map((characterId, index) => ({ ...seatModels[index].value, characterId })),
  };
}

async function deal(payload) {
  const submit = form.querySelector("button[type=submit]");
  if (submit) submit.disabled = true;
  try {
    const next = await api("/api/doudizhu/game", payload);
    lastPayload = payload;
    selected.clear();
    liveSummary = "";
    setup.close();
    applyState(next);
  } catch (error) {
    sfx.play("error");
    toast(error.message, { tone: "error" });
  } finally {
    if (submit) submit.disabled = false;
  }
}

function dealAgain() {
  if (lastPayload) return deal(lastPayload);
  // After a reload: keep the same cast and models that are sitting at the table.
  const ai = state.players.filter((player) => !player.isHuman);
  deal({
    gameMode: state.gameMode,
    humanName: human()?.name ?? "Player",
    aiPlayers: ai.map((player) => ({ ...player.aiConfig, characterId: player.character?.id })),
  });
}

setup.toggleButton.addEventListener("click", async () => {
  // Opening the setup in the middle of an arena hand pauses it, as before the redesign.
  if (setup.el.dataset.open === "true" && state?.gameMode === "arena" && state.phase !== "complete" && !state.arena?.paused) {
    try { applyState(await api("/api/doudizhu/arena/pause", {})); } catch (error) { toast(error.message, { tone: "error" }); }
  }
});

/* ---------- Wiring ---------- */

for (const button of dom.bidStrips.querySelectorAll("button")) {
  button.addEventListener("click", () => {
    sfx.play("chipClack");
    act("/api/doudizhu/bid", { score: Number(button.dataset.score) });
  });
}
dom.playButton.addEventListener("click", () => act("/api/doudizhu/action", { action: "play", cards: [...selected] }));
dom.passButton.addEventListener("click", () => act("/api/doudizhu/action", { action: "pass", cards: null }));
dom.clearButton.addEventListener("click", () => {
  selected.clear();
  renderHand();
  renderControls();
});
dom.arenaToggle.addEventListener("click", () => act(state.arena?.paused ? "/api/doudizhu/arena/resume" : "/api/doudizhu/arena/pause", {}));
addEventListener("resize", () => requestAnimationFrame(moveBulb));
addEventListener("scroll", () => requestAnimationFrame(moveBulb), { passive: true });

const events = new EventSource("/api/doudizhu/events");
events.addEventListener("message", (event) => {
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
  if (message.type === "state") {
    if (requestsInFlight === 0) applyState(message.payload);
  } else if (message.type === "ai_stream") {
    const payload = message.payload;
    if (payload.phase === "started") liveSummary = "";
    if (payload.phase === "summary_delta") liveSummary += payload.delta;
    if (payload.phase === "completed") liveSummary = payload.summary || liveSummary;
    if (payload.phase === "error") sfx.play("error");
    if (state) renderLens();
  }
});
events.addEventListener("error", () => toast("Live updates dropped. Reconnecting…", { tone: "error", duration: 2500 }));
// Table talk rises from the seat like steam: below the top seats, above the bottom one.
bindTableTalk(events, () => null, {
  onTalk(talk) {
    const anchor = dom.seats[talk.speaker]?.querySelector(".seat-card");
    if (!anchor || anchor.closest("[hidden]")) return;
    speak(anchor, talk.text, { placement: talk.speaker === 0 ? "top" : "bottom" });
  },
});

async function bootstrap() {
  try {
    const [characters, models, current] = await Promise.all([loadCharacters(), loadModels(), api("/api/doudizhu/state")]);
    registry = models;
    buildSetup(characters);
    if (current) applyState(current);
    else setup.open();
  } catch (error) {
    toast(error.message, { tone: "error" });
  }
}

bootstrap();

// Effect preview for visual checks: /games/doudizhu/?fx-preview exposes the bomb and rocket effects.
if (new URLSearchParams(location.search).has("fx-preview")) {
  globalThis.laneFx = { bomb: () => celebrateCombo("bomb", 4), rocket: () => celebrateCombo("rocket", 2) };
}
