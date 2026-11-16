// Room-only sounds for the lane: firecracker strings for bombs and a crackle with a gong for the
// rocket. They follow the shared mute switch in /shared/sfx.js.
import { sfx } from "/shared/sfx.js";

let context = null;
let output = null;

function audio() {
  if (sfx.muted) return null;
  if (!context) {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) return null;
    context = new AudioContextClass();
    output = context.createGain();
    output.gain.value = 0.45;
    output.connect(context.destination);
  }
  if (context.state === "suspended") context.resume().catch(() => {});
  return context;
}

function pop(ctx, at, { frequency = 1800, duration = 0.045, gain = 0.5 } = {}) {
  const start = ctx.currentTime + at;
  const length = Math.max(1, Math.floor(ctx.sampleRate * (duration + 0.02)));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < length; index += 1) data[index] = Math.random() * 2 - 1;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = frequency;
  filter.Q.value = 0.8;
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(gain, start + 0.002);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  source.connect(filter).connect(envelope).connect(output);
  source.start(start);
  source.stop(start + duration + 0.03);
}

function gong(ctx, at = 0) {
  const start = ctx.currentTime + at;
  for (const [ratio, level] of [[1, 0.32], [2.76, 0.12], [5.4, 0.05]]) {
    const oscillator = ctx.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(92 * ratio, start);
    oscillator.frequency.exponentialRampToValueAtTime(86 * ratio, start + 2.6);
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(level, start + 0.02);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + 2.8);
    oscillator.connect(envelope).connect(output);
    oscillator.start(start);
    oscillator.stop(start + 2.9);
  }
}

let ambienceTimer = null;

export const laneSfx = {
  /** Distant festive noise: a few muffled pops every 10–20 s while on. */
  setAmbience(on) {
    clearTimeout(ambienceTimer);
    ambienceTimer = null;
    if (!on) return;
    const next = () => {
      ambienceTimer = setTimeout(() => {
        const ctx = audio();
        if (ctx) {
          let at = 0;
          const count = 3 + Math.floor(Math.random() * 6);
          for (let index = 0; index < count; index += 1) {
            at += 0.05 + Math.random() * 0.12;
            pop(ctx, at, { frequency: 500 + Math.random() * 700, duration: 0.06, gain: 0.06 + Math.random() * 0.06 });
          }
        }
        next();
      }, 10_000 + Math.random() * 10_000);
    };
    next();
  },
  /** A short string of firecrackers: the bomb. */
  firecrackers(count = 14) {
    const ctx = audio();
    if (!ctx) return;
    let at = 0;
    for (let index = 0; index < count; index += 1) {
      at += 0.035 + Math.random() * 0.07;
      pop(ctx, at, { frequency: 1200 + Math.random() * 2400, gain: 0.35 + Math.random() * 0.35 });
    }
  },
  /** A long crackle that ends on a low gong: the rocket. */
  rocket() {
    const ctx = audio();
    if (!ctx) return;
    let at = 0;
    for (let index = 0; index < 34; index += 1) {
      at += 0.02 + Math.random() * 0.045;
      pop(ctx, at, { frequency: 900 + Math.random() * 3600, duration: 0.03 + Math.random() * 0.04, gain: 0.25 + Math.random() * 0.4 });
    }
    gong(ctx, at + 0.05);
  },
};
