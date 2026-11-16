// Browser check of the Liar's Dice room against a running server (real model moves).
//   PLAYGROUND_URL=http://127.0.0.1:4205 node scripts/check-liars-dice-ui.js
// Plays one whole two-seat game as the human (calling Liar whenever possible), checks the reveal,
// the result card and a post-game review, then checks the phone layout. Screenshots: tmp/browser/.
import fs from "node:fs";
import { chromium } from "playwright-core";

const baseURL = process.env.PLAYGROUND_URL || "http://127.0.0.1:4205";
const chrome = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const outDir = "tmp/browser";
fs.mkdirSync(outDir, { recursive: true });

const problems = [];
const browser = await chromium.launch({ executablePath: chrome, headless: true });

async function openRoom(width, height) {
  const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
  page.on("pageerror", (error) => problems.push(`${width}px page error: ${error.message}`));
  page.on("response", (response) => {
    // Portraits are still being painted; the kit falls back to initials for missing ones.
    if (response.status() >= 400 && !response.url().includes("/assets/characters/")) problems.push(`${width}px ${response.status()} ${response.url()}`);
  });
  await page.goto(`${baseURL}/games/liars-dice/`, { waitUntil: "networkidle" });
  return page;
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const page = await openRoom(1440, 900);
if (!(await page.locator(".kit-drawer[data-open=true]").count())) await page.click(".kit-drawer-toggle");
await page.click('.segmented input[value="human"] + span');
await page.click('.segmented.seats input[value="2"] + span');
const selects = page.locator(".seat-model-row").first().locator("select");
await selects.nth(0).selectOption(process.env.LIARS_DICE_MODEL || "gpt-6-luna");
await selects.nth(1).selectOption(process.env.LIARS_DICE_EFFORT || "high");
await page.click(".deal");

let reveals = 0;
const started = Date.now();
while (Date.now() - started < 12 * 60_000) {
  await page.waitForFunction(
    () => document.querySelector("#tray")?.dataset.turn === "true" || !document.querySelector("#result-card").hidden || !document.querySelector("#ai-pause").hidden,
    null,
    { timeout: 300_000 },
  );
  if (!(await page.locator("#ai-pause").isHidden())) throw new Error(`AI paused: ${await page.textContent("#ai-pause-text")}`);
  if (!(await page.locator("#result-card").isHidden())) break;
  await page.waitForTimeout(300);
  if (await page.locator("#liar-button:not([disabled])").count()) {
    const box = await page.locator("#liar-button").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(550);
    await page.mouse.up();
    await page.waitForSelector("#reveal:not([hidden])", { timeout: 10_000 });
    if (reveals === 0) await page.screenshot({ path: `${outDir}/liars-dice-reveal.png` });
    reveals += 1;
    await page.waitForSelector("#reveal", { state: "hidden", timeout: 10_000 });
  } else {
    await page.click("#raise-button");
  }
  await page.waitForTimeout(500);
}
await page.waitForSelector("#result-card:not([hidden])", { timeout: 20_000 });
await page.locator("#review-buttons button").first().click();
await page.waitForSelector("#review h3", { timeout: 180_000 });
await page.screenshot({ path: `${outDir}/liars-dice-review.png` });
const desktopOverflow = await overflow(page);

const phone = await openRoom(390, 844);
await phone.waitForTimeout(800);
await phone.screenshot({ path: `${outDir}/liars-dice-phone.png`, fullPage: true });
const phoneOverflow = await overflow(phone);
await browser.close();

if (reveals < 1) problems.push("no reveal was shown");
if (desktopOverflow > 0) problems.push(`desktop scrolls sideways by ${desktopOverflow}px`);
if (phoneOverflow > 0) problems.push(`phone scrolls sideways by ${phoneOverflow}px`);
console.log(JSON.stringify({ reveals, seconds: Math.round((Date.now() - started) / 1000), desktopOverflow, phoneOverflow, problems }, null, 2));
if (problems.length) process.exit(1);
