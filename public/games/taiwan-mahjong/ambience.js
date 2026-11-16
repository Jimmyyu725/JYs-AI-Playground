// Optional room ambience: rain on the window (low-passed noise) and the neon tubes' mains
// hum, with a short dropout now and then that matches the sign flicker. Off by default; the
// choice is remembered per browser, and it stays silent while the shared sfx are muted.
import { sfx } from "/shared/sfx.js";

const STORAGE_KEY = "taiwan-mahjong:ambience";
let ctx = null;
let master = null;
let flickerTimer = null;
let humGain = null;

function readOn() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}
function writeOn(on) {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Storage can be blocked; the toggle still works for this visit.
  }
}

function build() {
  const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!AudioContext) return false;
  ctx = new AudioContext();
  master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);

  // Rain: two seconds of brown-ish noise, looped and low-passed.
  const length = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let index = 0; index < length; index += 1) {
    last = (last + 0.04 * (Math.random() * 2 - 1)) / 1.04;
    data[index] = last * 3.2;
  }
  const rain = ctx.createBufferSource();
  rain.buffer = buffer;
  rain.loop = true;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 1500;
  const rainGain = ctx.createGain();
  rainGain.gain.value = 0.22;
  rain.connect(lowpass).connect(rainGain).connect(master);
  rain.start();

  // Neon hum: 120 Hz with a little 240 Hz.
  humGain = ctx.createGain();
  humGain.gain.value = 0.018;
  for (const [frequency, level] of [[120, 1], [240, 0.4]]) {
    const oscillator = ctx.createOscillator();
    oscillator.frequency.value = frequency;
    const gain = ctx.createGain();
    gain.gain.value = level;
    oscillator.connect(gain).connect(humGain);
    oscillator.start();
  }
  humGain.connect(master);
  return true;
}

function scheduleFlicker() {
  clearTimeout(flickerTimer);
  flickerTimer = setTimeout(() => {
    if (ctx && humGain) {
      const now = ctx.currentTime;
      humGain.gain.setValueAtTime(0.018, now);
      humGain.gain.linearRampToValueAtTime(0.002, now + 0.02);
      humGain.gain.linearRampToValueAtTime(0.018, now + 0.14);
    }
    scheduleFlicker();
  }, 8000 + Math.random() * 7000);
}

function apply(on) {
  const audible = on && !sfx.muted;
  if (audible && !ctx && !build()) return;
  if (!ctx) return;
  if (audible) ctx.resume();
  master.gain.setTargetAtTime(audible ? 0.5 : 0, ctx.currentTime, 0.4);
  if (audible) scheduleFlicker();
  else clearTimeout(flickerTimer);
}

/** A toggle button for the ambience. Audio only starts after the click (autoplay rules). */
export function ambienceButton() {
  let on = readOn();
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mj-ghost mj-ambience";
  const sync = () => {
    button.setAttribute("aria-pressed", String(on));
    button.textContent = on ? "Rain 雨 on" : "Rain 雨 off";
    button.title = "Rain on the window and the neon hum";
  };
  sync();
  button.addEventListener("click", () => {
    on = !on;
    writeOn(on);
    sync();
    apply(on);
  });
  // A remembered "on" waits for the first interaction anywhere on the page.
  if (on) document.addEventListener("pointerdown", () => apply(on), { once: true });
  sfx.onChange(() => apply(on));
  return button;
}
