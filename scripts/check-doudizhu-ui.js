import { chromium } from "playwright-core";

const baseURL = process.env.PLAYGROUND_URL || "http://127.0.0.1:4173";
const created = await fetch(`${baseURL}/api/doudizhu/game`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ gameMode: "human", humanName: "Player" }),
});
if (!created.ok) throw new Error(`Could not create Dou Dizhu smoke game (${created.status})`);

const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const errors = [];
const attachErrors = (page) => {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
};

const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
attachErrors(page);
await page.goto(`${baseURL}/games/doudizhu/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelectorAll("#hand-cards .dd-card").length === 17, null, { timeout: 8_000 });
await page.screenshot({ path: "tmp/browser/doudizhu-desktop.png", fullPage: true });
const desktop = await page.evaluate(() => ({
  handCards: document.querySelectorAll("#hand-cards .dd-card").length,
  playerSlots: document.querySelectorAll(".player-slot").length,
  bottomCards: document.querySelectorAll("#bottom-cards .dd-card").length,
  setupHidden: document.getElementById("setup-modal").classList.contains("hidden"),
  bidButtons: document.querySelectorAll("#bid-actions button").length,
  bidButtonsEnabled: [...document.querySelectorAll("#bid-actions button")].filter((button) => !button.disabled).length,
  playActionsHidden: document.getElementById("play-actions").classList.contains("hidden"),
  bodyFontSize: Number.parseFloat(getComputedStyle(document.body).fontSize),
  brokenImages: [...document.querySelectorAll("img")].filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.src),
}));
await page.click("#new-game-button");
await page.click('label:has(input[name="gameMode"][value="arena"])');
const setup = await page.evaluate(() => ({
  rosterRows: document.querySelectorAll(".ai-roster-row").length,
  modelOptions: document.querySelector(".seat-model")?.options.length,
  reasoningOptions: document.querySelector(".seat-reasoning")?.options.length,
  humanNameHidden: document.getElementById("human-name-field").classList.contains("hidden"),
  submitText: document.getElementById("setup-submit").textContent.trim(),
}));

const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
attachErrors(mobilePage);
await mobilePage.goto(`${baseURL}/games/doudizhu/`, { waitUntil: "domcontentloaded" });
await mobilePage.waitForFunction(() => document.querySelectorAll("#hand-cards .dd-card").length === 17, null, { timeout: 8_000 });
const mobile = await mobilePage.evaluate(() => ({
  viewportWidth: window.innerWidth,
  documentWidth: document.documentElement.scrollWidth,
  handCards: document.querySelectorAll("#hand-cards .dd-card").length,
}));
await mobilePage.screenshot({ path: "tmp/browser/doudizhu-mobile.png", fullPage: true });
await browser.close();

if (errors.length) throw new Error(`Dou Dizhu browser errors: ${errors.join(" | ")}`);
if (desktop.handCards !== 17 || desktop.playerSlots !== 3 || desktop.bottomCards !== 3 || !desktop.setupHidden || desktop.bidButtons !== 4 || desktop.bidButtonsEnabled !== 4 || !desktop.playActionsHidden || desktop.bodyFontSize < 15 || desktop.brokenImages.length) throw new Error(`Dou Dizhu desktop smoke failed: ${JSON.stringify(desktop)}`);
if (setup.rosterRows !== 3 || setup.modelOptions !== 5 || setup.reasoningOptions !== 6 || !setup.humanNameHidden || setup.submitText !== "Deal for three AI") throw new Error(`Dou Dizhu setup smoke failed: ${JSON.stringify(setup)}`);
if (mobile.documentWidth > mobile.viewportWidth + 1 || mobile.handCards !== 17) throw new Error(`Dou Dizhu mobile smoke failed: ${JSON.stringify(mobile)}`);
console.log(JSON.stringify({ ok: true, desktop, setup, mobile }));
