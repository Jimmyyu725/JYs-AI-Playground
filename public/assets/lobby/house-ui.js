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

/** Run a DOM swap inside a same-document View Transition when the browser supports it. */
export function swap(update) {
  if (!document.startViewTransition || reducedMotion()) {
    update();
    return;
  }
  document.startViewTransition(update);
}

export { sfx };
