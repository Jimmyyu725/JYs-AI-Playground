// Speech bubbles for table talk, anchored to a seat element.
//   import { speak, tableTalkFromEvent } from "/shared/speech.js";
//   speak(seatElement, "Nice try.", { placement: "top" });
// The SSE stream sends { type: "table_talk", payload: { speaker, playerName, characterId, text, at } };
// state.tableTalk holds the last 30 lines for late joiners.

const reduceMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Shows a bubble on `anchor` (which gets position: relative if it is static) and removes it after `duration` ms. */
export function speak(anchor, text, { placement = "top", duration = Math.min(9000, 2600 + String(text).length * 45), tone = "" } = {}) {
  if (!anchor || !text) return null;
  if (getComputedStyle(anchor).position === "static") anchor.style.position = "relative";
  anchor.querySelector(":scope > .kit-speech")?.remove();
  const bubble = document.createElement("div");
  bubble.className = "kit-speech";
  bubble.dataset.placement = placement;
  if (tone) bubble.dataset.tone = tone;
  bubble.setAttribute("role", "status");
  bubble.textContent = text;
  anchor.append(bubble);
  // Keep the bubble on screen at phone widths: nudge it horizontally instead of overflowing.
  bubble.style.animation = "none"; // Measure the settled size, not the first frame of the scale-in.
  const rect = bubble.getBoundingClientRect();
  bubble.style.animation = "";
  const viewport = document.documentElement.clientWidth;
  const shift = rect.right > viewport - 8 ? viewport - 8 - rect.right : rect.left < 8 ? 8 - rect.left : 0;
  if (shift) bubble.style.setProperty("--kit-speech-shift", `${Math.round(shift)}px`);
  const dismiss = () => {
    if (!bubble.isConnected) return;
    if (reduceMotion()) return bubble.remove();
    bubble.classList.add("is-leaving");
    bubble.addEventListener("animationend", () => bubble.remove(), { once: true });
    setTimeout(() => bubble.remove(), 600);
  };
  setTimeout(dismiss, duration);
  bubble.addEventListener("click", dismiss);
  return bubble;
}

/**
 * Wires an EventSource of a room to speech bubbles. `seatFor(speaker, payload)` returns the seat
 * element for a speaker (a seat number or a colour, depending on the room).
 */
export function bindTableTalk(eventSource, seatFor, { placement = "top", onTalk } = {}) {
  const seen = new Set();
  eventSource.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message?.type !== "table_talk" || seen.has(message.payload?.id)) return;
    seen.add(message.payload.id);
    const anchor = seatFor(message.payload.speaker, message.payload);
    speak(anchor, message.payload.text, { placement });
    onTalk?.(message.payload);
  });
}
