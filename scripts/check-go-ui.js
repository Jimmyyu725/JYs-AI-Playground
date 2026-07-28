import { chromium } from "playwright-core";

const baseURL = process.env.PLAYGROUND_URL || "http://127.0.0.1:4173";
const created = await fetch(`${baseURL}/api/go/game`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ gameMode: "human", humanName: "Player", humanColor: "black", boardSize: 9, komi: 7.5 }),
});
if (!created.ok) throw new Error(`Could not create Go smoke game (${created.status})`);

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const errors = [];
const attachErrors = (page) => {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
};

const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
attachErrors(page);
await page.goto(`${baseURL}/games/go/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelectorAll(".intersection").length === 81, null, { timeout: 8_000 });
await page.screenshot({ path: "tmp/browser/go-desktop.png", fullPage: true });
const desktop = await page.evaluate(() => ({
  intersections: document.querySelectorAll(".intersection").length,
  enabledIntersections: document.querySelectorAll(".intersection:not(:disabled)").length,
  players: document.querySelectorAll(".player-card .player-avatar").length,
  setupHidden: document.getElementById("setup-modal").classList.contains("hidden"),
  passEnabled: !document.getElementById("pass-button").disabled,
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
await mobilePage.goto(`${baseURL}/games/go/`, { waitUntil: "domcontentloaded" });
await mobilePage.waitForFunction(() => document.querySelectorAll(".intersection").length === 81, null, { timeout: 8_000 });
const mobile = await mobilePage.evaluate(() => ({
  viewportWidth: window.innerWidth,
  documentWidth: document.documentElement.scrollWidth,
  intersections: document.querySelectorAll(".intersection").length,
}));
await mobilePage.screenshot({ path: "tmp/browser/go-mobile.png", fullPage: true });

await browser.close();
if (errors.length) throw new Error(`Go browser errors: ${errors.join(" | ")}`);
if (desktop.intersections !== 81 || desktop.enabledIntersections !== 81 || desktop.players !== 2 || !desktop.setupHidden || !desktop.passEnabled || desktop.bodyFontSize < 15) {
  throw new Error(`Go desktop smoke failed: ${JSON.stringify(desktop)}`);
}
if (setup.rosterRows !== 2 || setup.modelOptions !== 3 || setup.reasoningOptions !== 6 || !setup.humanFieldsHidden || setup.submitText !== "Start AI Arena") {
  throw new Error(`Go setup smoke failed: ${JSON.stringify(setup)}`);
}
if (mobile.documentWidth > mobile.viewportWidth + 1 || mobile.intersections !== 81) {
  throw new Error(`Go mobile smoke failed: ${JSON.stringify(mobile)}`);
}
console.log(JSON.stringify({ ok: true, desktop, setup, mobile }));
