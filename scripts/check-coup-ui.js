// Headless UI check for the Coup room. Needs a running server (PLAYGROUND_URL, default :4173).
// Note: creating the table starts real AI requests for the AI seats.
import fs from "node:fs";
import { chromium } from "playwright-core";
import { resolveChromePath } from "./chrome-path.js";

const baseURL = process.env.PLAYGROUND_URL || "http://127.0.0.1:4173";
const created = await fetch(`${baseURL}/api/coup/game`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ mode: "human-vs-ai", playerCount: 4, humanName: "Player", aiPlayers: [{ model: "gpt-6-luna", reasoningEffort: "high" }] }),
});
if (!created.ok) throw new Error(`Could not create a Coup table (${created.status})`);
const table = await created.json();

fs.mkdirSync("tmp/browser", { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: resolveChromePath() });
const errors = [];
const results = {};

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
]) {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
  page.on("response", (response) => {
    // Portrait art is still being painted; the kit falls back to initials.
    if (response.status() >= 400 && !response.url().includes("/assets/characters/")) errors.push(`${name}: HTTP ${response.status()} ${response.url()}`);
  });
  await page.goto(`${baseURL}/games/coup/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll(".mask-seat").length > 0, null, { timeout: 10_000 });
  await page.screenshot({ path: `tmp/browser/coup-${name}.png`, fullPage: name === "phone" });
  results[name] = await page.evaluate(() => ({
    seats: document.querySelectorAll(".mask-seat").length,
    handCards: document.querySelectorAll(".hand-card").length,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    drawerCharacters: document.querySelectorAll(".kit-drawer .kit-pick-row").length,
    modelPickers: document.querySelectorAll(".kit-drawer .kit-model-picker").length,
  }));
  await page.close();
}
await browser.close();

const problems = [...errors];
for (const [name, result] of Object.entries(results)) {
  if (result.seats !== table.seats.length - 1) problems.push(`${name}: expected ${table.seats.length - 1} opponent seats, saw ${result.seats}`);
  if (result.handCards !== 2) problems.push(`${name}: expected 2 hand cards, saw ${result.handCards}`);
  if (result.overflow > 0) problems.push(`${name}: horizontal overflow of ${result.overflow}px`);
  if (result.drawerCharacters < 1 || result.modelPickers < 1) problems.push(`${name}: the setup drawer lacks the character or model picker`);
}
console.log(JSON.stringify(results, null, 2));
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("Coup UI check passed");
