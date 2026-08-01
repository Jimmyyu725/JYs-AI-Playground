import { chromium } from "playwright-core";
import { resolveChromePath } from "./chrome-path.js";

const baseURL = process.env.PLAYGROUND_URL || "http://127.0.0.1:4173";
const created = await fetch(`${baseURL}/api/wuziqi/game`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ gameMode: "human", humanName: "Player", humanColor: "black", boardSize: 15 }),
});
if (!created.ok) throw new Error(`Could not create Wuziqi smoke game (${created.status})`);

const browser = await chromium.launch({ headless: true, executablePath: resolveChromePath() });
const errors = [];
const attachErrors = (page) => {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
};

const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
attachErrors(page);
await page.goto(`${baseURL}/games/wuziqi/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelectorAll(".intersection").length === 225, null, { timeout: 8_000 });
await page.screenshot({ path: "tmp/browser/wuziqi-desktop.png", fullPage: true });
const desktop = await page.evaluate(() => ({
  intersections: document.querySelectorAll(".intersection").length,
  enabledIntersections: document.querySelectorAll(".intersection:not(:disabled)").length,
  players: document.querySelectorAll(".player-card .player-avatar").length,
  setupHidden: document.getElementById("setup-modal").classList.contains("hidden"),
  resignEnabled: !document.getElementById("resign-button").disabled,
  bodyFontSize: Number.parseFloat(getComputedStyle(document.body).fontSize),
}));
await page.click("#new-game-button");
await page.check('input[name="gameMode"][value="arena"]');
const setup = await page.evaluate(() => ({
  rosterRows: document.querySelectorAll(".ai-roster-row").length,
  modelOptions: document.querySelector(".seat-model")?.options.length,
  reasoningOptions: document.querySelector(".seat-reasoning")?.options.length,
  humanFieldsHidden: document.getElementById("human-name-field").classList.contains("hidden") && document.getElementById("human-color-field").classList.contains("hidden"),
  submitText: document.getElementById("setup-submit").textContent.trim(),
}));

const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
attachErrors(mobilePage);
await mobilePage.goto(`${baseURL}/games/wuziqi/`, { waitUntil: "domcontentloaded" });
await mobilePage.waitForFunction(() => document.querySelectorAll(".intersection").length === 225, null, { timeout: 8_000 });
const mobile = await mobilePage.evaluate(() => ({ viewportWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth, intersections: document.querySelectorAll(".intersection").length }));
await mobilePage.screenshot({ path: "tmp/browser/wuziqi-mobile.png", fullPage: true });
await browser.close();

if (errors.length) throw new Error(`Wuziqi browser errors: ${errors.join(" | ")}`);
if (desktop.intersections !== 225 || desktop.enabledIntersections !== 225 || desktop.players !== 2 || !desktop.setupHidden || !desktop.resignEnabled || desktop.bodyFontSize < 15) throw new Error(`Wuziqi desktop smoke failed: ${JSON.stringify(desktop)}`);
if (setup.rosterRows !== 2 || setup.modelOptions !== 4 || setup.reasoningOptions !== 6 || !setup.humanFieldsHidden || setup.submitText !== "Start AI Arena") throw new Error(`Wuziqi setup smoke failed: ${JSON.stringify(setup)}`);
if (mobile.documentWidth > mobile.viewportWidth + 1 || mobile.intersections !== 225) throw new Error(`Wuziqi mobile smoke failed: ${JSON.stringify(mobile)}`);
console.log(JSON.stringify({ ok: true, desktop, setup, mobile }));
