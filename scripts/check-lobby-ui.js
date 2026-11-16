// Headless UI check for the corridor (/), The House (/characters/) and the ladder (/ladder/).
// Boots an isolated server with a seeded results file, then checks each page at 1440x900 and 390x844:
// no console errors (missing portrait art aside), no horizontal scroll, and the expected content.
//   node scripts/check-lobby-ui.js            (SHOTS=1 also writes screenshots to tmp/)
//   PLAYGROUND_URL=http://127.0.0.1:4210 node scripts/check-lobby-ui.js
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { resolveChromePath } from "./chrome-path.js";
import { ResultsStore } from "../src/platform/results-store.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function availablePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const { port } = listener.address();
      listener.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForServer(baseURL, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error("The lobby test server exited early");
    try {
      if ((await fetch(`${baseURL}/api/health`)).ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The lobby test server did not become ready");
}

function seed(dataDir) {
  const store = new ResultsStore(path.join(dataDir, "results.json"));
  const ai = (characterId, model, place) => ({ kind: "ai", name: characterId, characterId, model, reasoningEffort: "high", place });
  store.recordMatch({ gameId: "go", mode: "arena", participants: [ai("vesper", "gpt-6-luna", 1), ai("rook", "gpt-6.1-sol", 2)] });
  store.recordMatch({ gameId: "go", mode: "human-vs-ai", participants: [{ kind: "human", name: "You", place: 2 }, ai("selene", "gpt-6-luna", 1)] });
  store.recordMatch({ gameId: "doudizhu", mode: "arena", participants: [ai("moss", "deepseek-flash", 1), ai("iris", "gpt-6-astra", 2), ai("dev", "gpt-6-luna", 2)] });
}

const explicitBaseURL = process.env.PLAYGROUND_URL;
let child = null;
let dataDir = null;
let baseURL = explicitBaseURL;
if (!explicitBaseURL) {
  const port = await availablePort();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jys-lobby-ui-"));
  seed(dataDir);
  baseURL = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.js"], {
    cwd: rootDir,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", PLAYGROUND_DATA_DIR: dataDir },
    stdio: "ignore",
  });
}

const failures = [];
const expect = (condition, message) => condition || failures.push(message);
const browser = await chromium.launch({ executablePath: resolveChromePath(), headless: true });
try {
  if (child) await waitForServer(baseURL, child);
  const { games } = await (await fetch(`${baseURL}/api/games`)).json();
  const viewports = [
    { name: "desktop", viewport: { width: 1440, height: 900 } },
    { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  ];
  for (const { name, ...options } of viewports) {
    const context = await browser.newContext(options);
    for (const route of ["/", "/characters/", "/ladder/"]) {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => message.type() === "error" && !/Failed to load resource/.test(message.text()) && errors.push(message.text()));
      page.on("response", (response) => {
        if (response.status() >= 400 && !response.url().includes("/assets/characters/")) errors.push(`${response.status()} ${response.url()}`);
      });
      await page.goto(baseURL + route, { waitUntil: "networkidle" });
      await page.waitForTimeout(600);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const label = `${name} ${route}`;
      expect(overflow <= 0, `${label}: scrolls sideways by ${overflow}px`);
      expect(errors.length === 0, `${label}: ${errors.join(" | ")}`);
      if (route === "/") {
        expect((await page.locator(".door").count()) === games.length, `${label}: expected ${games.length} doors`);
        expect((await page.locator("a.door").count()) === games.filter((game) => game.status === "live" && game.serverRoom).length, `${label}: open doors do not match live rooms`);
        expect((await page.locator(".regular").count()) === 3, `${label}: expected a trio of regulars`);
        expect((await page.locator(".ledger-row").count()) > 0, `${label}: the ladder teaser is empty`);
      }
      if (route === "/characters/") {
        expect((await page.locator(".cast-card").count()) === 50, `${label}: expected 50 characters`);
        expect((await page.locator(".cast-card .card-voice").count()) === 50, `${label}: voices are missing`);
        expect((await page.locator('.cast-card[data-played="true"]').count()) >= 6, `${label}: recent records are missing`);
        await page.fill("#cast-search", "oracle");
        expect((await page.locator(".cast-card:not([hidden])").count()) === 1, `${label}: search for "oracle" should leave Selene`);
      }
      if (route === "/ladder/") {
        expect((await page.locator(".standing").count()) >= 5, `${label}: overall standings are missing`);
        await page.click('[data-tab="go"]');
        await page.waitForTimeout(400);
        expect((await page.locator(".trend-line").count()) >= 2, `${label}: the Go trend chart is missing`);
        expect((await page.locator(".match").count()) === 2, `${label}: expected two recent Go matches`);
      }
      if (process.env.SHOTS) await page.screenshot({ path: path.join(rootDir, "tmp", `check-lobby-${name}${route.replace(/\//g, "-")}.png`) });
      await page.close();
    }
    await context.close();
  }

  // Walking through a lit door lands in the room.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseURL}/`, { waitUntil: "networkidle" });
  const door = page.locator('a.door[data-room="go"]');
  await door.scrollIntoViewIfNeeded();
  await door.hover();
  await page.waitForTimeout(200);
  await door.click();
  await page.waitForURL("**/games/go/", { timeout: 5000 });
  await page.waitForTimeout(500);
  expect(errors.length === 0, `walk-through: ${errors.join(" | ")}`);
} finally {
  await browser.close();
  child?.kill();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`Lobby UI check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("Lobby UI check passed: corridor, The House and the ladder at 1440x900 and 390x844.");
