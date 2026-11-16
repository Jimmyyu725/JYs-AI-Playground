// Headless check of the Salon Riviera Hold'em room.
//   node scripts/check-holdem-ui.js            layout + console check at 1440x900 and 390x844
//   node scripts/check-holdem-ui.js --play     also plays human turns in the browser until a hand ends
//   node scripts/check-holdem-ui.js --arena    also opens a short AI arena from the setup drawer
// Point HOLDEM_URL at a running server (default http://127.0.0.1:4201). Real AI turns use
// HOLDEM_MODEL / HOLDEM_EFFORT (default gpt-6-luna, high). Screenshots go to tmp/holdem/.
import fs from "node:fs";
import { chromium } from "playwright-core";
import { resolveChromePath } from "./chrome-path.js";

const baseURL = process.env.HOLDEM_URL || "http://127.0.0.1:4201";
const model = process.env.HOLDEM_MODEL || "gpt-6-luna";
const reasoningEffort = process.env.HOLDEM_EFFORT || "high";
const play = process.argv.includes("--play");
const arena = process.argv.includes("--arena");
const shots = "tmp/holdem";
fs.mkdirSync(shots, { recursive: true });

async function post(path, body) {
  const response = await fetch(`${baseURL}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

const ai = { model, reasoningEffort };
await post("/api/game", { humanName: "Check", opponentCount: 3, startingStack: 1000, smallBlind: 10, bigBlind: 20, aiPlayers: [ai, ai, ai] });

const browser = await chromium.launch({ headless: true, executablePath: resolveChromePath() });
const problems = [];
const results = {};

async function open(name, viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => problems.push(`${name}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`${name}: ${message.text()} ${message.location()?.url ?? ""}`);
  });
  page.on("requestfailed", (request) => {
    if (!request.url().includes("/api/events")) problems.push(`${name}: request failed ${request.url()}`);
  });
  await page.goto(`${baseURL}/games/holdem/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll(".seat").length === 4, null, { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelectorAll(".hole-cards .card").length === 8, null, { timeout: 10_000 });
  await page.waitForTimeout(1500);
  return page;
}

async function measure(page) {
  return page.evaluate(() => ({
    viewport: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    seats: document.querySelectorAll(".seat").length,
    humanFaceUp: document.querySelectorAll(".seat.is-human .card:not(.is-down)").length,
    hiddenOpponentCards: document.querySelectorAll(".seat:not(.is-human) .card.is-down").length,
    brokenImages: [...document.images].filter((image) => image.complete && image.naturalWidth === 0).map((image) => image.src),
    drawerOpen: document.querySelector(".kit-drawer")?.dataset.open,
  }));
}

const desktop = await open("desktop", { width: 1440, height: 900 });
results.desktop = await measure(desktop);
await desktop.screenshot({ path: `${shots}/desktop-table.png` });

const phone = await open("phone", { width: 390, height: 844 });
results.phone = await measure(phone);
await phone.screenshot({ path: `${shots}/phone-table.png` });
await phone.screenshot({ path: `${shots}/phone-full.png`, fullPage: true });

await desktop.click(".kit-drawer-toggle");
await desktop.waitForTimeout(500);
results.setup = await desktop.evaluate(() => ({
  pickRows: document.querySelectorAll(".kit-pick-row").length,
  modelRows: document.querySelectorAll(".seat-model-row").length,
  modelOptions: document.querySelector(".seat-model-row select")?.options.length,
}));
await desktop.screenshot({ path: `${shots}/desktop-setup.png` });
await desktop.click(".kit-drawer .kit-icon-button");

if (play) {
  // Play human turns (check or call) until a hand completes, with real model turns in between.
  const deadline = Date.now() + 8 * 60_000;
  let turns = 0;
  while (Date.now() < deadline) {
    const status = await desktop.evaluate(() => ({
      mode: document.getElementById("action-panel").dataset.mode,
      buttons: [...document.querySelectorAll("#action-panel button")].map((button) => button.textContent),
    }));
    if (status.mode === "error") throw new Error(`AI paused: ${await desktop.textContent("#context-copy")}`);
    if (status.mode === "between" || status.mode === "over") break;
    if (status.mode === "turn") {
      const button = desktop.locator("#action-panel .action-row button", { hasText: /^(Check|Call)/ }).first();
      await button.click();
      turns += 1;
      if (turns === 1) await desktop.screenshot({ path: `${shots}/desktop-after-first-action.png` });
    }
    await desktop.waitForTimeout(1000);
  }
  await desktop.waitForTimeout(1600);
  results.play = {
    humanTurns: turns,
    mode: await desktop.evaluate(() => document.getElementById("action-panel").dataset.mode),
    street: await desktop.textContent("#street-label"),
    talk: await desktop.evaluate(() => document.querySelectorAll('.kit-transcript-item[data-kind="talk"]').length),
  };
  await desktop.screenshot({ path: `${shots}/desktop-hand-over.png` });
  await phone.reload();
  await phone.waitForTimeout(2000);
  await phone.screenshot({ path: `${shots}/phone-hand-over.png` });
}

if (arena) {
  await desktop.click(".kit-drawer-toggle");
  await desktop.check('input[name="gameMode"][value="arena"]', { force: true });
  await desktop.selectOption('select[name="opponentCount"]', "3");
  await desktop.selectOption('select[name="arenaHandTarget"]', "5");
  for (const select of await desktop.locator(".seat-model-row select").all()) {
    const options = await select.evaluate((node) => [...node.options].map((option) => option.value));
    await select.selectOption(options.includes(model) ? model : reasoningEffort);
  }
  await desktop.click(".setup-submit");
  await desktop.waitForFunction(() => document.body.dataset.mode === "arena", null, { timeout: 10_000 });
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const count = await desktop.evaluate(() => document.querySelectorAll('.kit-transcript-item[data-log-kind="action"], .kit-transcript-item[data-kind="move"]').length);
    const mode = await desktop.evaluate(() => document.getElementById("action-panel").dataset.mode);
    if (mode === "error") throw new Error(`Arena paused: ${await desktop.textContent("#context-copy")}`);
    if (count >= 8) break;
    await desktop.waitForTimeout(1500);
  }
  await desktop.screenshot({ path: `${shots}/desktop-arena.png` });
  results.arena = await desktop.evaluate(() => ({
    seats: document.querySelectorAll(".seat").length,
    faceUp: document.querySelectorAll(".hole-cards .card:not(.is-down)").length,
    context: document.getElementById("context-eyebrow").textContent,
  }));
  await post("/api/arena/pause", {}).catch(() => null);
}

await browser.close();

const failures = [...problems];
for (const [name, value] of Object.entries({ desktop: results.desktop, phone: results.phone })) {
  if (value.scrollWidth > value.viewport) failures.push(`${name}: horizontal scroll (${value.scrollWidth} > ${value.viewport})`);
  if (value.seats !== 4) failures.push(`${name}: expected 4 seats`);
  if (value.humanFaceUp !== 2) failures.push(`${name}: the human hole cards are not face up`);
  if (value.hiddenOpponentCards !== 6) failures.push(`${name}: opponent cards should be face down`);
  if (value.brokenImages.length) failures.push(`${name}: broken images ${value.brokenImages.join(", ")}`);
}
console.log(JSON.stringify({ ok: failures.length === 0, results, failures }, null, 2));
process.exit(failures.length ? 1 : 0);
