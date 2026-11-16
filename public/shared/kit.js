// Shared room kit: setup drawer, seats with portraits, character and model pickers, toast,
// transcript, and back-to-lobby. Pair with /shared/kit.css and theme it with --kit-* variables.
// See docs/ROOMS.md for a full usage example.

const EXPRESSIONS = ["neutral", "thinking", "triumphant", "defeated"];
const cache = new Map();
const REROLL_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

async function getJSON(url) {
  if (!cache.has(url)) {
    cache.set(
      url,
      fetch(url).then((response) => {
        if (!response.ok) throw new Error(`${url} returned ${response.status}`);
        return response.json();
      }),
    );
  }
  try {
    return await cache.get(url);
  } catch (error) {
    cache.delete(url);
    throw error;
  }
}

export const prefersReducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** [{ id, name, shortName, title, color, initials, portrait }] from GET /api/characters. */
export async function loadCharacters() {
  return (await getJSON("/api/characters")).characters;
}

/** { models, providers, reasoningEfforts, defaultConfig, defaults } from GET /api/models. */
export async function loadModels() {
  return getJSON("/api/models");
}

export function portraitUrl(characterId, expression = "neutral") {
  const safeExpression = EXPRESSIONS.includes(expression) ? expression : "neutral";
  return `/assets/characters/${encodeURIComponent(characterId)}/${safeExpression}.webp`;
}

/**
 * A seat: portrait (or initials when the image is missing), name, and a caption line.
 * Returns the .kit-seat element; update it with setSeatExpression / setSeatCaption.
 */
export function seat({ character, name = character?.name ?? "You", caption = character?.title ?? "", expression = "neutral", size = "md" } = {}) {
  const root = element("figure", "kit-seat");
  root.dataset.size = size;
  if (character?.id) root.dataset.characterId = character.id;
  root.style.setProperty("--seat-color", character?.color ?? "var(--kit-accent)");
  const frame = element("div", "kit-portrait");
  const initials = element("span", "kit-initials", character?.initials ?? String(name).slice(0, 2).toUpperCase());
  frame.append(initials);
  if (character?.id) {
    const image = element("img");
    image.alt = "";
    image.decoding = "async";
    image.loading = "lazy";
    image.addEventListener("error", () => image.remove());
    image.src = portraitUrl(character.id, expression);
    frame.append(image);
  }
  const label = element("figcaption", "kit-seat-label");
  label.append(element("strong", "kit-seat-name", name), element("span", "kit-seat-caption", caption));
  root.append(frame, label);
  root.dataset.expression = expression;
  return root;
}

export function setSeatExpression(seatElement, expression) {
  const image = seatElement?.querySelector(".kit-portrait img");
  seatElement.dataset.expression = expression;
  if (!image || !seatElement.dataset.characterId) return;
  const next = portraitUrl(seatElement.dataset.characterId, expression);
  if (image.getAttribute("src") !== next) image.src = next;
}

export function setSeatCaption(seatElement, text) {
  const caption = seatElement?.querySelector(".kit-seat-caption");
  if (caption) caption.textContent = text;
}

/**
 * Non-blocking setup drawer: a side panel on wide screens and a bottom sheet on narrow ones,
 * so the room stays visible. It mounts itself on `mount` (document.body by default); put your form in
 * `drawer.body` and place `drawer.toggleButton` wherever the room wants its "Setup" button.
 */
export function drawer({ title = "Table setup", open = true, closable = true, mount = document.body } = {}) {
  const root = element("aside", "kit-drawer");
  root.setAttribute("aria-label", title);
  const header = element("header", "kit-drawer-header");
  header.append(element("h2", "kit-drawer-title", title));
  const body = element("div", "kit-drawer-body");
  const toggle = element("button", "kit-drawer-toggle", "Setup");
  toggle.type = "button";
  const api = {
    el: root,
    body,
    toggleButton: toggle,
    open() {
      root.dataset.open = "true";
      toggle.setAttribute("aria-expanded", "true");
    },
    close() {
      root.dataset.open = "false";
      toggle.setAttribute("aria-expanded", "false");
    },
    toggle() {
      root.dataset.open === "true" ? api.close() : api.open();
    },
  };
  if (closable) {
    const close = element("button", "kit-icon-button", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close setup");
    close.addEventListener("click", api.close);
    header.append(close);
  }
  toggle.addEventListener("click", api.toggle);
  root.append(header, body);
  open ? api.open() : api.close();
  mount?.append(root);
  return api;
}

function shuffle(list) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

/**
 * Per-seat character picker. Seats start with a random distinct cast; each seat can reroll or open
 * a searchable grid of the whole roster. `picker.value` is the array of character ids, in seat order,
 * to send as aiPlayers[i].characterId.
 */
export function characterPicker({ characters, seats = 1, value = [], onChange = () => {} }) {
  const root = element("div", "kit-character-picker");
  let cast = [];
  const byId = new Map(characters.map((character) => [character.id, character]));

  const randomFor = (index) => {
    const taken = new Set(cast.filter((_, other) => other !== index).map((character) => character?.id));
    return shuffle(characters).find((character) => !taken.has(character.id) && character.id !== cast[index]?.id) ?? cast[index];
  };

  function render() {
    root.replaceChildren();
    cast.forEach((character, index) => {
      const row = element("div", "kit-pick-row");
      const card = seat({ character, size: "sm" });
      const reroll = element("button", "kit-icon-button kit-reroll");
      reroll.innerHTML = REROLL_ICON;
      reroll.type = "button";
      reroll.title = "Seat a different random character";
      reroll.setAttribute("aria-label", `Reroll seat ${index + 1}`);
      reroll.addEventListener("click", () => set(index, randomFor(index)));
      const choose = element("button", "kit-button kit-choose", "Choose");
      choose.type = "button";
      choose.setAttribute("aria-label", `Choose the character for seat ${index + 1}`);
      choose.addEventListener("click", () => openGrid(index, choose));
      row.append(card, reroll, choose);
      root.append(row);
    });
  }

  function set(index, character) {
    if (!character) return;
    const clash = cast.findIndex((other, otherIndex) => otherIndex !== index && other?.id === character.id);
    if (clash >= 0) cast[clash] = cast[index];
    cast[index] = character;
    render();
    onChange(api.value);
  }

  function openGrid(index, opener) {
    root.querySelector(".kit-grid-panel")?.remove();
    const panel = element("div", "kit-grid-panel");
    const search = element("input", "kit-input");
    search.type = "search";
    search.placeholder = "Search characters";
    search.setAttribute("aria-label", "Search characters");
    const grid = element("div", "kit-character-grid");
    const fill = () => {
      const query = search.value.trim().toLowerCase();
      grid.replaceChildren(
        ...characters
          .filter((character) => !query || `${character.name} ${character.title}`.toLowerCase().includes(query))
          .map((character) => {
            const option = element("button", "kit-grid-option");
            option.type = "button";
            option.setAttribute("aria-pressed", String(cast[index]?.id === character.id));
            option.append(seat({ character, size: "xs" }));
            option.addEventListener("click", () => {
              panel.remove();
              set(index, character);
            });
            return option;
          }),
      );
    };
    search.addEventListener("input", fill);
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        panel.remove();
        opener.focus();
      }
    });
    fill();
    panel.append(search, grid);
    opener.closest(".kit-pick-row").after(panel);
    search.focus();
  }

  const api = {
    el: root,
    get value() {
      return cast.map((character) => character.id);
    },
    get characters() {
      return [...cast];
    },
    /** Changes the seat count, keeping existing picks and filling new seats at random. */
    setSeats(count) {
      cast = cast.slice(0, count);
      while (cast.length < count) cast.push(randomFor(cast.length));
      render();
      onChange(api.value);
    },
    reroll(index) {
      set(index, randomFor(index));
    },
  };
  cast = value.map((id) => byId.get(id)).filter(Boolean);
  cast = cast.filter((character, index) => cast.findIndex((other) => other.id === character.id) === index).slice(0, seats);
  while (cast.length < seats) cast.push(randomFor(cast.length));
  render();
  return api;
}

/** Model + reasoning-effort selects. `picker.value` is { model, reasoningEffort }. */
export function modelPicker({ registry, value = registry.defaultConfig, label = "Model", onChange = () => {} }) {
  const root = element("div", "kit-model-picker");
  const model = element("select", "kit-select");
  model.setAttribute("aria-label", `${label}: model`);
  for (const provider of registry.providers) {
    const group = document.createElement("optgroup");
    group.label = provider.label;
    for (const entry of registry.models.filter((candidate) => candidate.provider === provider.id)) {
      const option = new Option(entry.label, entry.id);
      option.title = entry.description;
      group.append(option);
    }
    model.append(group);
  }
  const effort = element("select", "kit-select");
  effort.setAttribute("aria-label", `${label}: reasoning effort`);
  for (const level of registry.reasoningEfforts) effort.add(new Option(`Reasoning ${level}`, level));
  model.value = value?.model ?? registry.defaultConfig.model;
  effort.value = value?.reasoningEffort ?? registry.defaultConfig.reasoningEffort;
  const api = {
    el: root,
    get value() {
      return { model: model.value, reasoningEffort: effort.value };
    },
  };
  model.addEventListener("change", () => onChange(api.value));
  effort.addEventListener("change", () => onChange(api.value));
  root.append(model, effort);
  return api;
}

let toastHost = null;
/** Brief status message. tone: "info" | "error" | "success". */
export function toast(message, { tone = "info", duration = 4200 } = {}) {
  if (!toastHost?.isConnected) {
    toastHost = element("div", "kit-toasts");
    toastHost.setAttribute("aria-live", "polite");
    document.body.append(toastHost);
  }
  const item = element("div", "kit-toast", message);
  item.dataset.tone = tone;
  toastHost.append(item);
  setTimeout(() => {
    item.classList.add("is-leaving");
    setTimeout(() => item.remove(), prefersReducedMotion() ? 0 : 300);
  }, duration);
  return item;
}

/** Scrolling log of moves, reasoning, and table talk. add({ who, text, kind: "move"|"talk"|"system"|"reasoning" }). */
export function transcript({ title = "Transcript", limit = 200 } = {}) {
  const root = element("section", "kit-transcript");
  root.setAttribute("aria-label", title);
  root.append(element("h3", "kit-transcript-title", title));
  const list = element("ol", "kit-transcript-list");
  root.append(list);
  return {
    el: root,
    add({ who = "", text, kind = "move" }) {
      const item = element("li", "kit-transcript-item");
      item.dataset.kind = kind;
      if (who) item.append(element("strong", null, who));
      item.append(element("span", null, text));
      const pinned = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
      list.append(item);
      while (list.children.length > limit) list.firstElementChild.remove();
      if (pinned) list.scrollTop = list.scrollHeight;
      return item;
    },
    clear() {
      list.replaceChildren();
    },
  };
}

/** "Back to lobby" link that uses a View Transition when the browser supports it. */
export function backToLobby({ label = "Lobby" } = {}) {
  const link = element("a", "kit-back", `← ${label}`);
  link.href = "/";
  link.addEventListener("click", (event) => {
    // Cross-document transitions come from @view-transition in kit.css; this covers same-document fallbacks.
    if (!document.startViewTransition || prefersReducedMotion() || "onpagereveal" in globalThis) return;
    event.preventDefault();
    document.startViewTransition(() => {
      location.href = "/";
    });
  });
  return link;
}
