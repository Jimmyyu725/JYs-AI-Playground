import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

// Smoke check for the Landlord Room against a running server. The human seat bids first on
// hand 1, so the check never waits on (or pays for) a model call.
const baseURL = process.env.PLAYGROUND_URL || "http://127.0.0.1:4173";
const executablePath = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
  .find((candidate) => candidate && existsSync(candidate));
await mkdir("tmp/browser", { recursive: true });

const created = await fetch(`${baseURL}/api/doudizhu/game`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ gameMode: "human", humanName: "Player" }),
});
if (!created.ok) throw new Error(`Could not create Dou Dizhu smoke game (${created.status})`);
const createdState = await created.json();
if (!createdState.humanCanAct) throw new Error("The smoke game expected the human seat to bid first");

const browser = await chromium.launch({ headless: true, executablePath });
const errors = [];
const attachErrors = (page) => {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
};

const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
attachErrors(page);
await page.goto(`${baseURL}/games/doudizhu/`, { waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelectorAll("#hand .card").length === 17, null, { timeout: 8_000 });
await page.screenshot({ path: "tmp/browser/doudizhu-desktop.png" });
const desktop = await page.evaluate(() => ({
  handCards: document.querySelectorAll("#hand .card").length,
  aiSeats: [...document.querySelectorAll(".seat-zone")].filter((zone) => !zone.hidden).length,
  aiPortraits: document.querySelectorAll(".seat-zone:not([hidden]) .kit-portrait img").length,
  bottomCards: document.querySelectorAll("#bottom-cards .card").length,
  drawerClosed: document.querySelector(".kit-drawer")?.dataset.open !== "true",
  bidButtons: document.querySelectorAll("#bid-strips button").length,
  bidButtonsEnabled: [...document.querySelectorAll("#bid-strips button")].filter((button) => !button.disabled).length,
  playButtonsHidden: document.getElementById("play-buttons").hidden,
  bodyFontSize: Number.parseFloat(getComputedStyle(document.body).fontSize),
  documentWidth: document.documentElement.scrollWidth,
  brokenImages: [...document.images].filter((image) => image.complete && image.naturalWidth === 0).map((image) => image.src),
}));
await page.click(".couplet-toggle");
await page.click('.mode-pick label:has(input[value="arena"])');
const setup = await page.evaluate(() => ({
  open: document.querySelector(".kit-drawer")?.dataset.open === "true",
  castRows: document.querySelectorAll(".lane-setup .kit-pick-row").length,
  rerollButtons: document.querySelectorAll(".lane-setup .kit-reroll").length,
  modelPickers: document.querySelectorAll(".lane-setup .kit-model-picker").length,
  humanNameHidden: document.querySelector(".lane-setup [data-human-only]").hidden,
}));

const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
attachErrors(mobilePage);
await mobilePage.goto(`${baseURL}/games/doudizhu/`, { waitUntil: "networkidle" });
await mobilePage.waitForFunction(() => document.querySelectorAll("#hand .card").length === 17, null, { timeout: 8_000 });
const mobile = await mobilePage.evaluate(() => ({
  viewportWidth: window.innerWidth,
  documentWidth: document.documentElement.scrollWidth,
  handCards: document.querySelectorAll("#hand .card").length,
}));
await mobilePage.screenshot({ path: "tmp/browser/doudizhu-mobile.png", fullPage: true });
await browser.close();

if (errors.length) throw new Error(`Dou Dizhu browser errors: ${errors.join(" | ")}`);
if (desktop.handCards !== 17 || desktop.aiSeats !== 2 || desktop.aiPortraits !== 2 || desktop.bottomCards !== 3 || !desktop.drawerClosed
  || desktop.bidButtons !== 4 || desktop.bidButtonsEnabled !== 4 || !desktop.playButtonsHidden || desktop.bodyFontSize < 15
  || desktop.documentWidth > 1440 || desktop.brokenImages.length) {
  throw new Error(`Dou Dizhu desktop smoke failed: ${JSON.stringify(desktop)}`);
}
if (!setup.open || setup.castRows !== 3 || setup.rerollButtons !== 3 || setup.modelPickers !== 3 || !setup.humanNameHidden) {
  throw new Error(`Dou Dizhu setup smoke failed: ${JSON.stringify(setup)}`);
}
if (mobile.documentWidth > mobile.viewportWidth + 1 || mobile.handCards !== 17) throw new Error(`Dou Dizhu mobile smoke failed: ${JSON.stringify(mobile)}`);
console.log(JSON.stringify({ ok: true, desktop, setup, mobile }));
