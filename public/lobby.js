// The corridor: one door per room from /api/games, a random trio of regulars, and the top of the ladder.
import { entrantLabel, isOpen, numberWord, pickTrio, playersLabel, roomLight } from "/assets/lobby/house-data.js";
import { el, getJSON, loadCast, mountHouseBar, portrait, probeOptIn, reducedMotion, sfx, swap } from "/assets/lobby/house-ui.js";

const doorRow = document.querySelector("#door-row");
const trioList = document.querySelector("#trio-list");
const ledgerList = document.querySelector("#ledger-list");

function door(game, index) {
  const open = isOpen(game);
  const light = roomLight(game.id);
  const slot = el("li", "door-slot");
  slot.style.setProperty("--glow", light.glow);
  slot.style.setProperty("--tint", light.tint);
  slot.style.setProperty("--i", index);

  const node = el(open ? "a" : "div", "door");
  node.dataset.state = open ? "open" : "soon";
  node.dataset.room = game.id;
  if (open) node.href = game.route;
  else node.setAttribute("aria-disabled", "true");

  const frame = el("span", "door-frame");
  const art = el("img", "door-art");
  art.src = `/assets/lobby/door-${game.id}.webp`;
  art.alt = "";
  art.width = 640;
  art.height = 960;
  art.loading = index < 5 ? "eager" : "lazy";
  art.decoding = "async";
  art.addEventListener("error", () => art.remove());
  frame.append(art, el("span", "door-light"));

  const plaque = el("span", "door-plaque");
  plaque.append(el("span", "door-number", `No. ${String(index + 1).padStart(2, "0")}`), el("strong", "door-name", game.name));
  if (game.nameZh) {
    const zh = el("span", "door-zh", game.nameZh);
    zh.lang = "zh";
    plaque.append(zh);
  }
  const meta = [playersLabel(game.players), game.modes?.includes("arena") ? "Arena" : null].filter(Boolean).join(" · ");
  const pitch = el("span", "door-pitch", game.pitch ?? "");
  const foot = el("span", "door-foot");
  foot.append(el("span", "door-meta", meta), el("span", "door-state", open ? "Enter" : "Opening soon"));

  node.append(frame, el("span", "door-spill"), plaque, pitch, foot);
  node.setAttribute("aria-label", `${game.name}${game.nameZh ? ` ${game.nameZh}` : ""}: ${open ? "enter the room" : "opening soon"}. ${game.pitch ?? ""}`);
  if (open) {
    node.addEventListener("click", (event) => walkThrough(event, node));
    for (const type of ["pointerenter", "focus", "touchstart"]) node.addEventListener(type, () => probeOptIn(game.route), { once: true, passive: true });
  }
  slot.append(node);
  return slot;
}

/** Push the door toward the viewer, then navigate; the cross-document View Transition carries the rest. */
function walkThrough(event, node) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  sfx.play("cardFlick");
  if (reducedMotion()) return;
  event.preventDefault();
  node.querySelector(".door-frame").style.viewTransitionName = "portal";
  document.body.classList.add("is-entering");
  node.classList.add("is-chosen");
  setTimeout(() => location.assign(node.href), 320);
}

// Coming back through bfcache must not leave the corridor mid-step.
addEventListener("pageshow", () => {
  document.body.classList.remove("is-entering");
  for (const chosen of document.querySelectorAll(".door.is-chosen")) {
    chosen.classList.remove("is-chosen");
    chosen.querySelector(".door-frame").style.viewTransitionName = "";
  }
});

async function renderDoors() {
  try {
    const { games } = await getJSON("/api/games");
    doorRow.replaceChildren(...games.map(door));
    const live = games.filter(isOpen).length;
    document.querySelector("#room-count").textContent = numberWord(games.length);
    document.querySelector("#doors-note").textContent =
      live === games.length
        ? "Every door is lit tonight."
        : `${numberWord(live)} of ${numberWord(games.length).toLowerCase()} doors are lit tonight. The rest are still being dressed.`;
  } catch {
    doorRow.replaceChildren(el("li", "doors-error", "The corridor could not load its rooms. Refresh to try again."));
  }
}

let cast = [];
let shown = [];

function trioCard(character, index) {
  const item = el("li", "regular");
  item.style.setProperty("--who", character.color);
  item.style.viewTransitionName = `regular-${index}`;
  const link = el("a", "regular-link");
  link.href = `/characters/#${character.id}`;
  const words = el("span", "regular-words");
  words.append(el("span", "regular-title", character.title), el("strong", "regular-name", character.name));
  if (character.voice) words.append(el("q", "regular-voice", character.voice));
  link.append(portrait(character, { eager: true }), words);
  item.append(link);
  return item;
}

function renderTrio() {
  shown = pickTrio(cast, { exclude: shown.map((character) => character.id) });
  trioList.replaceChildren(...shown.map(trioCard));
}

async function setUpTrio() {
  try {
    cast = await loadCast();
    renderTrio();
    document.querySelector("#shuffle-trio").addEventListener("click", () => {
      sfx.play("cardFlick");
      swap(renderTrio);
    });
  } catch {
    trioList.replaceChildren(el("li", "regular-empty", "The regulars are running late."));
  }
}

async function renderLedger() {
  try {
    const [ladder, registry] = await Promise.all([getJSON("/api/ladder"), getJSON("/api/models")]);
    const top = ladder.overall.slice(0, 5);
    if (!top.length) {
      ledgerList.replaceChildren(el("li", "ledger-empty", "No finished games yet. The first result lands here."));
      return;
    }
    ledgerList.replaceChildren(
      ...top.map((entry, index) => {
        const row = el("li", "ledger-row");
        row.append(
          el("span", "ledger-rank", String(index + 1)),
          el("span", "ledger-who", entrantLabel(entry, registry)),
          el("span", "ledger-record", `${entry.wins}–${entry.losses}${entry.draws ? `–${entry.draws}` : ""}`),
          el("span", "ledger-rating", String(entry.rating)),
        );
        return row;
      }),
    );
  } catch {
    ledgerList.replaceChildren(el("li", "ledger-empty", "The ladder is unavailable right now."));
  }
}

mountHouseBar();
renderDoors();
setUpTrio();
renderLedger();
