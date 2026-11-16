// UI smoke check for the Xiangqi room against a running server, without any model calls:
// it seats a paused arena, renders it at desktop and phone sizes, opens the setup drawer,
// and fails on console errors, a wrong piece count or horizontal scrolling.
//   PLAYGROUND_URL=http://127.0.0.1:4206 node scripts/check-xiangqi-ui.js
import fs from "node:fs";
import { chromium } from "playwright-core";
import { resolveChromePath } from "./chrome-path.js";

const baseURL = process.env.PLAYGROUND_URL || "http://127.0.0.1:4173";
const created = await fetch(`${baseURL}/api/xiangqi/game`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ gameMode: "arena", arenaPaused: true }),
});
if (!created.ok) throw new Error(`Could not create a Xiangqi smoke game (${created.status})`);

fs.mkdirSync("tmp/browser", { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: resolveChromePath() });
const failures = [];
for (const [width, height] of [[1440, 900], [390, 844]]) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => failures.push(`${width}px: ${error.message}`));
  page.on("console", (message) => {
    // Portraits that are still being painted fall back to initials; their 404s are expected.
    if (message.type() === "error" && !/assets\/characters\//.test(message.location()?.url ?? "")) failures.push(`${width}px: ${message.text()}`);
  });
  await page.goto(`${baseURL}/games/xiangqi/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll("#pieces .piece").length === 32, null, { timeout: 8_000 });
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    seats: document.querySelectorAll(".seat-inner").length,
    pauseButton: [...document.querySelectorAll("#status-actions button")].some((button) => /Resume arena/.test(button.textContent)),
  }));
  if (layout.overflow > 0) failures.push(`${width}px: horizontal overflow ${layout.overflow}px`);
  if (layout.seats !== 2) failures.push(`${width}px: expected 2 seats, saw ${layout.seats}`);
  if (!layout.pauseButton) failures.push(`${width}px: the paused arena offers no resume button`);
  await page.screenshot({ path: `tmp/browser/xiangqi-${width}.png` });
  await page.click(".kit-drawer-toggle");
  await page.waitForTimeout(400);
  const drawer = await page.evaluate(() => ({
    open: document.querySelector(".xq-drawer")?.dataset.open,
    pickers: document.querySelectorAll(".xq-drawer .kit-model-picker").length,
    seats: document.querySelectorAll(".xq-drawer .kit-pick-row").length,
  }));
  if (drawer.open !== "true" || drawer.pickers < 1 || drawer.seats < 1) failures.push(`${width}px: setup drawer incomplete ${JSON.stringify(drawer)}`);
  await page.close();
}
await browser.close();
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Xiangqi UI check passed (1440x900 and 390x844).");
