// Draw & Guess UI smoke check (no model calls): the human draws first, so the table waits on the
// human and no AI request is made. Checks the setup drawer, word cards, hand-painting tools and
// layout at desktop and phone widths, with zero page errors and no horizontal scroll.
//   PLAYGROUND_URL=http://127.0.0.1:4208 node scripts/check-draw-guess-ui.js
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { resolveChromePath } from "./chrome-path.js";

const baseURL = process.env.PLAYGROUND_URL || "http://127.0.0.1:4173";
mkdirSync("tmp/browser", { recursive: true });

async function post(path, body) {
  const response = await fetch(`${baseURL}/api/draw-guess${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${path}: ${payload.error}`);
  return payload;
}

const created = await post("/game", { mode: "human-vs-ai", humanName: "Player", aiCount: 2, firstDrawerSeat: 0 });
const cast = created.players.filter((player) => !player.isHuman).map((player) => player.character.id);
if (new Set(cast).size !== 2) throw new Error("The house did not seat two distinct characters");

const browser = await chromium.launch({ headless: true, executablePath: resolveChromePath() });
const errors = [];
const results = {};
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", (error) => errors.push(`${viewport.width}: ${error.message}`));
  page.on("console", (message) => {
    // Missing character portraits fall back to initials by design.
    if (message.type() === "error" && !message.text().includes("404")) errors.push(`${viewport.width}: ${message.text()}`);
  });
  await page.goto(`${baseURL}/games/draw-guess/`, { waitUntil: "load" });
  await page.waitForSelector(".word-card", { timeout: 8000 });
  const cards = await page.locator(".word-card").count();
  const seats = await page.locator(".sitter").count();
  await page.screenshot({ path: `tmp/browser/draw-guess-choose-${viewport.width}.png` });
  results[viewport.width] = { cards, seats, overflow: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) };
  await page.close();
}

await post("/action", { type: "choose_word", optionIndex: 0 });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (error) => errors.push(`paint: ${error.message}`));
await page.goto(`${baseURL}/games/draw-guess/`, { waitUntil: "load" });
await page.waitForSelector("#sketch:not([hidden])", { timeout: 8000 });
const box = await page.locator("#sketch").boundingBox();
await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5, { steps: 8 });
await page.mouse.up();
const inked = await page.evaluate(() => {
  const canvas = document.getElementById("sketch");
  const pixel = canvas.getContext("2d").getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
  return pixel[3] > 0;
});
results.paint = { blobs: await page.locator(".blob").count(), inked };
await page.screenshot({ path: "tmp/browser/draw-guess-paint-1440.png" });
await browser.close();

console.log(JSON.stringify({ results, errors }, null, 2));
const failed = errors.length
  || Object.values(results).some((entry) => entry.overflow > 0)
  || results[1440].cards < 1 || results[1440].seats !== 3
  || results.paint.blobs !== 8 || !results.paint.inked;
if (failed) {
  console.error("Draw & Guess UI check failed");
  process.exit(1);
}
console.log("Draw & Guess UI check passed");
