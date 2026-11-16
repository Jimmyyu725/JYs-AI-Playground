// Browser smoke test for the Wuziqi room (no model calls): creates a human game over the API, then
// checks the board, the seats, the setup scroll, and phone layout. Run against a live server:
//   PLAYGROUND_URL=http://127.0.0.1:4173 npm run wuziqi:ui:check
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { resolveChromePath } from "./chrome-path.js";

const baseURL = process.env.PLAYGROUND_URL || "http://127.0.0.1:4173";
const created = await fetch(`${baseURL}/api/wuziqi/game`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ gameMode: "human", humanName: "Player", humanColor: "black", boardSize: 15 }),
});
if (!created.ok) throw new Error(`Could not create Wuziqi smoke game (${created.status})`);
mkdirSync("tmp/browser", { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath: resolveChromePath() });
const errors = [];
const attachErrors = (page) => {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    // Portrait art is still being painted; the kit falls back to initials when one is missing.
    if (message.type() === "error" && !message.location()?.url?.includes("/assets/characters/")) errors.push(message.text());
  });
};

const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
attachErrors(page);
await page.goto(`${baseURL}/games/wuziqi/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelectorAll(".point").length === 225, null, { timeout: 8_000 });
await page.screenshot({ path: "tmp/browser/wuziqi-desktop.png" });
const desktop = await page.evaluate(() => ({
  points: document.querySelectorAll(".point").length,
  enabledPoints: document.querySelectorAll(".point:not(:disabled)").length,
  seats: document.querySelectorAll(".plate .kit-seat").length,
  drawerClosed: document.querySelector(".kit-drawer")?.dataset.open === "false",
  resignVisible: !document.getElementById("resign-button").hidden && !document.getElementById("resign-button").disabled,
  documentWidth: document.documentElement.scrollWidth,
}));
await page.click(".kit-drawer-toggle");
await page.check('input[name="gameMode"][value="arena"]', { force: true });
const setup = await page.evaluate(() => ({
  castRows: document.querySelectorAll(".kit-pick-row").length,
  distinctCast: new Set([...document.querySelectorAll(".kit-pick-row .kit-seat")].map((seat) => seat.dataset.characterId)).size,
  modelPickers: document.querySelectorAll(".setup-model .kit-model-picker").length,
  humanFieldsHidden: document.querySelector("[data-human-only]").hidden,
  submitText: document.getElementById("setup-submit").textContent.trim(),
}));

const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
attachErrors(mobilePage);
await mobilePage.goto(`${baseURL}/games/wuziqi/`, { waitUntil: "domcontentloaded" });
await mobilePage.waitForFunction(() => document.querySelectorAll(".point").length === 225, null, { timeout: 8_000 });
const mobile = await mobilePage.evaluate(() => ({ viewportWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth, points: document.querySelectorAll(".point").length }));
await mobilePage.screenshot({ path: "tmp/browser/wuziqi-mobile.png", fullPage: true });
await browser.close();

if (errors.length) throw new Error(`Wuziqi browser errors: ${errors.join(" | ")}`);
if (desktop.points !== 225 || desktop.enabledPoints !== 225 || desktop.seats !== 2 || !desktop.drawerClosed || !desktop.resignVisible || desktop.documentWidth > 1440) throw new Error(`Wuziqi desktop smoke failed: ${JSON.stringify(desktop)}`);
if (setup.castRows !== 2 || setup.distinctCast !== 2 || setup.modelPickers !== 2 || !setup.humanFieldsHidden || setup.submitText !== "Seat them and watch") throw new Error(`Wuziqi setup smoke failed: ${JSON.stringify(setup)}`);
if (mobile.documentWidth > mobile.viewportWidth || mobile.points !== 225) throw new Error(`Wuziqi mobile smoke failed: ${JSON.stringify(mobile)}`);
console.log(JSON.stringify({ ok: true, desktop, setup, mobile }));
