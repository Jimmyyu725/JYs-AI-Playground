// DOM helpers shared by the corridor (/), The House (/characters/) and the ladder (/ladder/).
import { sfx } from "/shared/sfx.js";
import { providerSummary } from "/assets/lobby/house-data.js";

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

const jsonCache = new Map();
export function getJSON(url) {
  if (!jsonCache.has(url)) {
    const request = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`${url} returned ${response.status}`);
      return response.json();
    });
    request.catch(() => jsonCache.delete(url));
    jsonCache.set(url, request);
  }
  return jsonCache.get(url);
}

/** /api/characters merged with personality and voice from /characters/profiles.json (absent fields stay empty). */
export async function loadCast() {
  const [{ characters }, profiles] = await Promise.all([
    getJSON("/api/characters"),
    getJSON("/characters/profiles.json").catch(() => ({ profiles: {} })),
  ]);
  return characters.map((character) => ({ ...profiles.profiles?.[character.id], ...character }));
}

/** A portrait frame: initials underneath, the painted portrait on top once it loads. */
export function portrait(character, { expression = "neutral", eager = false } = {}) {
  const frame = el("span", "portrait");
  frame.style.setProperty("--who", character.color);
  frame.append(el("span", "portrait-initials", character.initials));
  const image = el("img");
  image.alt = "";
  image.decoding = "async";
  image.loading = eager ? "eager" : "lazy";
  image.width = 512;
  image.height = 512;
  image.addEventListener("load", () => frame.classList.add("has-art"));
  image.addEventListener("error", () => image.remove());
  image.src = `/assets/characters/${encodeURIComponent(character.id)}/${expression}.webp`;
  frame.append(image);
  return frame;
}

/** Fills the house bar's status pill from /api/health and drops the mute toggle into #mute-slot. */
export async function mountHouseBar() {
  const slot = document.querySelector("#mute-slot");
  if (slot) slot.replaceWith(sfx.muteButton());
  const status = document.querySelector("#house-status");
  const summary = document.querySelector("#provider-summary");
  try {
    const health = await getJSON("/api/health");
    const providers = providerSummary(health);
    const rooms = Object.keys(health.games ?? {}).length;
    if (status) {
      status.dataset.state = providers.length ? "open" : "closed";
      status.querySelector(".status-text").textContent = providers.length
        ? `House open · ${rooms} rooms live`
        : "No model keys configured";
    }
    if (summary) summary.textContent = providers.length ? `Models from ${providers.join(" · ")}` : "No provider keys configured";
    return health;
  } catch {
    if (status) {
      status.dataset.state = "closed";
      status.querySelector(".status-text").textContent = "House status unavailable";
    }
    if (summary) summary.textContent = "House status unavailable";
    return null;
  }
}

let latchContext = null;
/** A brass latch and a soft wooden thump as a door swings open; honours the shared mute setting. */
export function doorLatch() {
  if (sfx.muted) return;
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) return;
  latchContext ??= new AudioContextClass();
  const ctx = latchContext;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const now = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.value = 0.45;
  out.connect(ctx.destination);
  // Latch: a short, bright metallic click.
  const click = ctx.createOscillator();
  click.type = "square";
  click.frequency.setValueAtTime(2400, now);
  click.frequency.exponentialRampToValueAtTime(900, now + 0.03);
  const clickGain = ctx.createGain();
  clickGain.gain.setValueAtTime(0.0001, now);
  clickGain.gain.exponentialRampToValueAtTime(0.18, now + 0.003);
  clickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
  click.connect(clickGain).connect(out);
  click.start(now);
  click.stop(now + 0.06);
  // Thump: the heavy door settling on its hinges.
  const thump = ctx.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime(140, now + 0.05);
  thump.frequency.exponentialRampToValueAtTime(55, now + 0.35);
  const thumpGain = ctx.createGain();
  thumpGain.gain.setValueAtTime(0.0001, now + 0.05);
  thumpGain.gain.exponentialRampToValueAtTime(0.5, now + 0.07);
  thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
  thump.connect(thumpGain).connect(out);
  thump.start(now + 0.05);
  thump.stop(now + 0.42);
}

// A cross-document View Transition into a page that has not opted in (@view-transition, which
// /shared/kit.css carries) logs an abort error on that page. Room pages are probed before the
// walk-through (see probeOptIn), and the transition is skipped for any room not known to opt in.
const optIn = new Map();

export function probeOptIn(route) {
  const path = new URL(route, location.href).pathname;
  if (!optIn.has(path)) {
    optIn.set(path, false);
    fetch(path)
      .then((response) => (response.ok ? response.text() : ""))
      .then((html) => optIn.set(path, /\/shared\/kit\.css|@view-transition/.test(html)))
      .catch(() => {});
  }
}

function quietTransition(event) {
  const transition = event.viewTransition;
  if (!transition) return;
  for (const promise of [transition.ready, transition.finished, transition.updateCallbackDone]) promise?.catch(() => {});
  if (event.type !== "pageswap") return;
  const path = new URL(event.activation?.entry?.url ?? location.href).pathname;
  if (path.startsWith("/games/") && optIn.get(path) !== true) transition.skipTransition();
}
addEventListener("pageswap", quietTransition);
addEventListener("pagereveal", quietTransition);

/** Run a DOM swap inside a same-document View Transition when the browser supports it. */
export function swap(update) {
  if (!document.startViewTransition || reducedMotion()) {
    update();
    return;
  }
  document.startViewTransition(update);
}

export { sfx };
