// Synthesized table sounds (Web Audio, no files). Usage:
//   import { sfx } from "/shared/sfx.js";
//   sfx.play("chipClack");  sfx.toggleMuted();  document.body.append(sfx.muteButton());
// Names: cardFlick, chipClack, stoneClick, diceRoll, cupSlam, tileClack, win, error.

const STORAGE_KEY = "playground.sfx.muted";
let context = null;
let master = null;
let muted = readMuted();
const listeners = new Set();

function readMuted() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeMuted(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Storage can be unavailable (private mode); muting still works for this page.
  }
}

function audio() {
  if (!context) {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) return null;
    context = new AudioContextClass();
    master = context.createGain();
    master.gain.value = 0.5;
    master.connect(context.destination);
  }
  if (context.state === "suspended") context.resume().catch(() => {});
  return context;
}

function noiseBuffer(ctx, seconds) {
  const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * seconds)), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
  return buffer;
}

/** A filtered noise burst: the building block for paper, wood, stone, and plastic hits. */
function burst(ctx, { at = 0, duration = 0.06, type = "bandpass", frequency = 2000, q = 1, gain = 0.6, attack = 0.002 }) {
  const start = ctx.currentTime + at;
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer(ctx, duration + 0.02);
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(gain, start + attack);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  source.connect(filter).connect(envelope).connect(master);
  source.start(start);
  source.stop(start + duration + 0.02);
}

/** A short pitched ping with an exponential decay. */
function tone(ctx, { at = 0, frequency = 440, endFrequency = frequency, duration = 0.2, type = "sine", gain = 0.3 }) {
  const start = ctx.currentTime + at;
  const oscillator = ctx.createOscillator();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), start + duration);
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(gain, start + 0.005);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(envelope).connect(master);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

const SOUNDS = {
  cardFlick(ctx) {
    burst(ctx, { duration: 0.05, type: "highpass", frequency: 3500, gain: 0.5 });
    burst(ctx, { at: 0.012, duration: 0.03, frequency: 1800, q: 2, gain: 0.25 });
  },
  chipClack(ctx) {
    tone(ctx, { frequency: 3100, endFrequency: 2600, duration: 0.05, type: "triangle", gain: 0.22 });
    burst(ctx, { duration: 0.04, frequency: 4200, q: 6, gain: 0.35 });
    tone(ctx, { at: 0.045, frequency: 2700, endFrequency: 2300, duration: 0.04, type: "triangle", gain: 0.12 });
  },
  stoneClick(ctx) {
    tone(ctx, { frequency: 1900, endFrequency: 1400, duration: 0.07, type: "sine", gain: 0.35 });
    burst(ctx, { duration: 0.025, frequency: 5200, q: 4, gain: 0.3 });
    burst(ctx, { at: 0.01, duration: 0.09, type: "lowpass", frequency: 500, gain: 0.25 });
  },
  diceRoll(ctx) {
    for (let index = 0; index < 9; index += 1) {
      burst(ctx, { at: index * 0.045 + Math.random() * 0.02, duration: 0.03, frequency: 1500 + Math.random() * 1800, q: 5, gain: 0.25 - index * 0.02 });
    }
  },
  cupSlam(ctx) {
    tone(ctx, { frequency: 140, endFrequency: 60, duration: 0.25, type: "sine", gain: 0.6 });
    burst(ctx, { duration: 0.12, type: "lowpass", frequency: 900, gain: 0.5 });
    for (let index = 0; index < 4; index += 1) burst(ctx, { at: 0.03 + index * 0.03, duration: 0.025, frequency: 2600, q: 6, gain: 0.12 });
  },
  tileClack(ctx) {
    tone(ctx, { frequency: 1250, endFrequency: 950, duration: 0.06, type: "square", gain: 0.08 });
    burst(ctx, { duration: 0.05, frequency: 2400, q: 3, gain: 0.45 });
    burst(ctx, { at: 0.035, duration: 0.04, frequency: 2000, q: 3, gain: 0.2 });
  },
  win(ctx) {
    [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => tone(ctx, { at: index * 0.09, frequency, duration: 0.5, type: "triangle", gain: 0.2 }));
    tone(ctx, { at: 0.36, frequency: 1568, duration: 0.7, type: "sine", gain: 0.12 });
  },
  error(ctx) {
    tone(ctx, { frequency: 220, endFrequency: 180, duration: 0.16, type: "sawtooth", gain: 0.12 });
    tone(ctx, { at: 0.12, frequency: 175, endFrequency: 140, duration: 0.2, type: "sawtooth", gain: 0.12 });
  },
};

export const SFX_NAMES = Object.freeze(Object.keys(SOUNDS));

export const sfx = {
  play(name) {
    if (muted || !SOUNDS[name]) return;
    const ctx = audio();
    if (ctx) SOUNDS[name](ctx);
  },
  get muted() {
    return muted;
  },
  setMuted(value) {
    muted = Boolean(value);
    writeMuted(muted);
    for (const listener of listeners) listener(muted);
  },
  toggleMuted() {
    this.setMuted(!muted);
    return muted;
  },
  onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** A ready-made toggle button (class kit-mute) that stays in sync with the stored setting. */
  muteButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "kit-mute";
    const sync = () => {
      button.setAttribute("aria-pressed", String(muted));
      button.setAttribute("aria-label", muted ? "Unmute sound effects" : "Mute sound effects");
      button.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/>${muted ? '<path d="M17 9l5 6M22 9l-5 6"/>' : '<path d="M17 8.5a5 5 0 0 1 0 7M19.5 6a8.5 8.5 0 0 1 0 12"/>'}</svg>`;
    };
    sync();
    button.addEventListener("click", () => {
      this.toggleMuted();
      if (!muted) this.play("chipClack");
    });
    this.onChange(sync);
    return button;
  },
};
