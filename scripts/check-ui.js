import { chromium } from "playwright-core";

const baseURL = process.env.LUNA_HOLDEM_URL || "http://127.0.0.1:4173";
await fetch(`${baseURL}/api/game`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ humanName: "Player", opponentCount: 2, startingStack: 1_000, smallBlind: 10, bigBlind: 20 }),
});

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") pageErrors.push(message.text());
});

await page.goto(baseURL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelectorAll(".player-seat").length === 3, null, { timeout: 8_000 });
await page.waitForFunction(() => document.querySelectorAll(".playing-card img").length >= 4, null, { timeout: 8_000 });
await page.screenshot({ path: "tmp/browser/table-desktop.png", fullPage: true });

const result = await page.evaluate(() => ({
  seats: document.querySelectorAll(".player-seat").length,
  setupHidden: document.getElementById("setup-modal").classList.contains("hidden"),
  communitySlots: document.querySelectorAll("#community-cards .playing-card").length,
  enabledActions: [...document.querySelectorAll(".action-button:not(:disabled), #raise-button:not(:disabled)")].map((button) => button.textContent.trim()),
  brokenImages: [...document.images].filter((image) => image.complete && image.naturalWidth === 0).map((image) => image.src),
}));

await page.click("#new-table-button");
await page.check('input[name="gameMode"][value="arena"]');
await page.screenshot({ path: "tmp/browser/setup-arena.png", fullPage: true });
const setupResult = await page.evaluate(() => ({
  humanNameHidden: document.getElementById("human-name-field").classList.contains("hidden"),
  targetVisible: !document.getElementById("arena-target-field").classList.contains("hidden"),
  playerLegend: document.getElementById("player-count-legend").textContent.trim(),
  submitLabel: document.getElementById("setup-submit").textContent.trim(),
}));
await page.click("#cancel-setup");

const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
mobilePage.on("pageerror", (error) => pageErrors.push(error.message));
mobilePage.on("console", (message) => {
  if (message.type() === "error") pageErrors.push(message.text());
});
await mobilePage.goto(baseURL, { waitUntil: "domcontentloaded" });
await mobilePage.waitForFunction(() => document.querySelectorAll(".player-seat").length === 3, null, { timeout: 8_000 });
const mobileResult = await mobilePage.evaluate(() => ({
  viewportWidth: window.innerWidth,
  documentWidth: document.documentElement.scrollWidth,
  seats: document.querySelectorAll(".player-seat").length,
}));
await mobilePage.screenshot({ path: "tmp/browser/table-mobile.png", fullPage: true });

await fetch(`${baseURL}/api/game`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    gameMode: "arena",
    opponentCount: 3,
    arenaHandTarget: 10,
    arenaPaused: true,
    startingStack: 1_000,
    smallBlind: 10,
    bigBlind: 20,
  }),
});
const arenaPage = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
arenaPage.on("pageerror", (error) => pageErrors.push(error.message));
arenaPage.on("console", (message) => {
  if (message.type() === "error") pageErrors.push(message.text());
});
await arenaPage.goto(baseURL, { waitUntil: "domcontentloaded" });
await arenaPage.waitForFunction(() => document.querySelectorAll(".player-seat").length === 3, null, { timeout: 8_000 });
await arenaPage.screenshot({ path: "tmp/browser/table-arena.png", fullPage: true });
const arenaResult = await arenaPage.evaluate(() => ({
  seats: document.querySelectorAll(".player-seat").length,
  faceUpHoleCards: [...document.querySelectorAll(".seat-cards img")].filter((image) => !image.src.endsWith("/BACK.jpg")).length,
  arenaControlsVisible: !document.getElementById("arena-controls").classList.contains("hidden"),
  humanActionsHidden: document.getElementById("primary-actions").classList.contains("hidden"),
  toggleLabel: document.getElementById("arena-toggle").textContent.trim(),
  transcriptVisible: getComputedStyle(document.getElementById("reasoning-feed")).display !== "none",
  bodyFontSize: Number.parseFloat(getComputedStyle(document.body).fontSize),
  reasoningFontSize: Number.parseFloat(getComputedStyle(document.getElementById("reasoning-text")).fontSize),
  historyFontSize: Number.parseFloat(getComputedStyle(document.querySelector(".history-entry")).fontSize),
  truncatedNames: [...document.querySelectorAll(".seat-copy strong")].filter((name) => name.scrollWidth > name.clientWidth + 1).map((name) => name.textContent),
  brokenImages: [...document.images].filter((image) => image.complete && image.naturalWidth === 0).map((image) => image.src),
}));

await browser.close();
if (pageErrors.length) throw new Error(`Browser console errors: ${pageErrors.join(" | ")}`);
if (!result.setupHidden || result.seats !== 3 || result.communitySlots !== 5 || result.brokenImages.length) {
  throw new Error(`UI smoke check failed: ${JSON.stringify(result)}`);
}
if (!setupResult.humanNameHidden || !setupResult.targetVisible || setupResult.playerLegend !== "Choose AI seats" || setupResult.submitLabel !== "Start AI Arena") {
  throw new Error(`Arena setup smoke check failed: ${JSON.stringify(setupResult)}`);
}
if (mobileResult.documentWidth > mobileResult.viewportWidth + 1 || mobileResult.seats !== 3) {
  throw new Error(`Mobile UI smoke check failed: ${JSON.stringify(mobileResult)}`);
}
if (arenaResult.seats !== 3 || arenaResult.faceUpHoleCards !== 6 || !arenaResult.arenaControlsVisible || !arenaResult.humanActionsHidden || arenaResult.toggleLabel !== "Resume arena" || !arenaResult.transcriptVisible || arenaResult.bodyFontSize < 15 || arenaResult.reasoningFontSize < 12 || arenaResult.historyFontSize < 11 || arenaResult.truncatedNames.length || arenaResult.brokenImages.length) {
  throw new Error(`Arena UI smoke check failed: ${JSON.stringify(arenaResult)}`);
}
console.log(JSON.stringify({ ok: true, desktop: result, setup: setupResult, mobile: mobileResult, arena: arenaResult }));
