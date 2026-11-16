// Atelier sounds for Draw & Guess, synthesized with Web Audio and muted together with the shared
// kit's sound toggle: pencil scratch, brush swish, easel knock, music-box chord, dusk bell.
import { sfx } from "/shared/sfx.js";

let context = null;
let lastScratch = 0;

function audio() {
  if (sfx.muted) return null;
  if (!context) {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) return null;
    context = new AudioContextClass();
  }
  if (context.state === "suspended") context.resume().catch(() => {});
  return context;
}

function noise(ctx, { duration, gain, filter, frequency, q = 1, at = 0 }) {
  const length = Math.ceil(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < length; index += 1) data[index] = Math.random() * 2 - 1;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const shape = ctx.createBiquadFilter();
  shape.type = filter;
  shape.frequency.value = frequency;
  shape.Q.value = q;
  const level = ctx.createGain();
  const start = ctx.currentTime + at;
  level.gain.setValueAtTime(0.0001, start);
  level.gain.exponentialRampToValueAtTime(gain, start + Math.min(0.03, duration / 3));
  level.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  source.connect(shape).connect(level).connect(ctx.destination);
  source.start(start);
}

function bell(ctx, { frequency, at = 0, duration = 1.6, gain = 0.08, partials = [1, 2.01, 2.76, 4.07] }) {
  const start = ctx.currentTime + at;
  partials.forEach((ratio, index) => {
    const oscillator = ctx.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency * ratio;
    const level = ctx.createGain();
    const peak = gain / (index + 1);
    level.gain.setValueAtTime(0.0001, start);
    level.gain.exponentialRampToValueAtTime(peak, start + 0.008);
    level.gain.exponentialRampToValueAtTime(0.0001, start + duration / (1 + index * 0.6));
    oscillator.connect(level).connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + duration);
  });
}

export const atelier = {
  /** Called while a stroke moves; rate-limited so it reads as graphite on paper. */
  scratch() {
    const now = performance.now();
    if (now - lastScratch < 70) return;
    lastScratch = now;
    const ctx = audio();
    if (ctx) noise(ctx, { duration: 0.07, gain: 0.025, filter: "bandpass", frequency: 3200 + Math.random() * 1600, q: 1.4 });
  },
  swish() {
    const ctx = audio();
    if (ctx) noise(ctx, { duration: 0.28, gain: 0.06, filter: "bandpass", frequency: 900, q: 0.7 });
  },
  knock() {
    const ctx = audio();
    if (!ctx) return;
    noise(ctx, { duration: 0.09, gain: 0.18, filter: "lowpass", frequency: 420 });
    noise(ctx, { duration: 0.09, gain: 0.14, filter: "lowpass", frequency: 380, at: 0.16 });
  },
  chord() {
    const ctx = audio();
    if (!ctx) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => bell(ctx, { frequency, at: index * 0.07, duration: 1.3, gain: 0.05, partials: [1, 3.01] }));
  },
  duskBell() {
    const ctx = audio();
    if (ctx) bell(ctx, { frequency: 196, duration: 3.2, gain: 0.12 });
  },
};
