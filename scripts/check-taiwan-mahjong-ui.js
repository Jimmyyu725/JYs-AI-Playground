// Headless UI check for the Taiwan Mahjong room. It needs a running server and makes no
// model calls: it deals a human-vs-AI table (the human deals first, so no AI seat is asked),
// selects a tile, and checks both viewports for console errors and horizontal overflow.
//
//   PORT=4209 node server.js &
//   BASE_URL=http://127.0.0.1:4209 CHROME_PATH=/usr/bin/google-chrome node scripts/check-taiwan-mahjong-ui.js
//
// Screenshots go to tmp/ (gitignored). Missing character portraits (404 under
// /assets/characters/) are reported as warnings, not failures: the initials fallback covers them.
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:4209";
const outDir = new URL("../tmp/", import.meta.url).pathname;
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const failures = [];
const warnings = [];

for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", (error) => failures.push(`[${label}] ${error.message}`));
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const line = `[${label}] ${response.status()} ${response.url()}`;
    (response.url().includes("/assets/characters/") ? warnings : failures).push(line);
  });
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("status of 404")) failures.push(`[${label}] console: ${message.text()}`);
  });
  await page.goto(`${BASE}/games/taiwan-mahjong/`, { waitUntil: "networkidle" });
  if ((await page.locator(".kit-drawer[data-open='true']").count()) === 0) await page.locator(".kit-drawer-toggle").click();
  await page.locator(".mj-segment-button[data-value='human-vs-ai']").click();
  await page.locator(".mj-primary", { hasText: "Deal" }).click();
  await page.waitForSelector(".mj-hand button.mj-tile:not(:disabled)");
  const tiles = await page.locator(".mj-hand button.mj-tile").count();
  if (tiles !== 17) failures.push(`[${label}] the dealer should hold 17 tiles, saw ${tiles}`);
  const seats = await page.locator(".mj-seat .kit-seat").count();
  if (seats !== 4) failures.push(`[${label}] expected 4 seats, saw ${seats}`);
  await page.locator(".mj-hand button.mj-tile:not(:disabled)").first().click();
  if ((await page.locator(".mj-hand .is-selected").count()) !== 1) failures.push(`[${label}] clicking a tile should select it`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) failures.push(`[${label}] horizontal overflow of ${overflow}px`);
  await page.screenshot({ path: `${outDir}taiwan-mahjong-${label}.png`, fullPage: label === "phone" });
  await page.close();
}

await browser.close();
for (const warning of warnings) console.warn(`warning: ${warning}`);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Taiwan Mahjong UI check passed (screenshots in tmp/).");
