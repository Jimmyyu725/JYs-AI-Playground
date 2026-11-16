import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveChromePath } from "./chrome-path.js";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

function availablePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const { port } = listener.address();
      listener.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(baseURL, processHandle) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error("The isolated Go UI test server exited early");
    try {
      const response = await fetch(`${baseURL}/api/health`);
      if (response.ok) return;
    } catch {
      // The isolated server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The isolated Go UI test server did not become ready");
}

const explicitBaseURL = process.env.PLAYGROUND_URL;
const testPort = explicitBaseURL ? null : await availablePort();
const testDataDirectory = explicitBaseURL ? null : fs.mkdtempSync(path.join(os.tmpdir(), "jys-go-ui-"));
const baseURL = explicitBaseURL || `http://127.0.0.1:${testPort}`;
const serverProcess = explicitBaseURL
  ? null
  : spawn(process.execPath, ["server.js"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, PLAYGROUND_DATA_DIR: testDataDirectory, PORT: String(testPort) },
      stdio: "ignore",
    });

const stopServer = () => {
  if (serverProcess && serverProcess.exitCode === null) serverProcess.kill("SIGTERM");
};
const cleanTestData = () => {
  if (testDataDirectory) fs.rmSync(testDataDirectory, { recursive: true, force: true });
};
process.once("exit", () => {
  stopServer();
  cleanTestData();
});
if (serverProcess) await waitForServer(baseURL, serverProcess);

// A human game with the human on black: nothing calls a model until the first stone is played.
const created = await fetch(`${baseURL}/api/go/game`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ gameMode: "human", humanName: "Player", humanColor: "black", boardSize: 9, komi: 7.5 }),
});
if (!created.ok) throw new Error(`Could not create Go smoke game (${created.status})`);

fs.mkdirSync("tmp/browser", { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: resolveChromePath() });
const failures = [];
for (const [width, height] of [[1440, 900], [390, 844]]) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => failures.push(`${width}px: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") failures.push(`${width}px: ${message.text()}`); });
  await page.goto(`${baseURL}/games/go/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#turn-text")?.textContent.startsWith("Your move"), null, { timeout: 8_000 });
  const table = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    hits: document.querySelectorAll("#goban-hits .hit").length,
    enabledHits: document.querySelectorAll("#goban-hits .hit:not(:disabled)").length,
    seats: document.querySelectorAll(".seat-card .kit-seat").length,
    aiPortrait: Boolean(document.querySelector('.seat-card[data-human="false"] .kit-seat img')?.naturalWidth),
    passEnabled: !document.getElementById("pass-button").disabled,
    drawerOpen: document.querySelector(".kit-drawer")?.dataset.open,
    brokenImages: [...document.images].filter((image) => image.complete && !image.naturalWidth).length,
  }));
  if (table.overflow > 0) failures.push(`${width}px: horizontal overflow ${table.overflow}px`);
  if (table.hits !== 81 || table.enabledHits !== 81) failures.push(`${width}px: expected 81 open points, saw ${table.enabledHits}/${table.hits}`);
  if (table.seats !== 2 || !table.aiPortrait) failures.push(`${width}px: seats incomplete ${JSON.stringify(table)}`);
  if (!table.passEnabled) failures.push(`${width}px: Pass is disabled on the human's turn`);
  if (table.drawerOpen === "true") failures.push(`${width}px: the setup drawer covers a game in progress`);
  if (table.brokenImages) failures.push(`${width}px: ${table.brokenImages} broken images`);
  await page.screenshot({ path: `tmp/browser/go-${width}.png` });

  await page.click(".new-game");
  await page.waitForTimeout(400);
  const firstSeat = () => page.$eval(".setup .kit-pick-row .kit-seat", (node) => node.dataset.characterId);
  const before = await firstSeat();
  await page.click(".setup .kit-reroll");
  const rerolled = await firstSeat();
  await page.click('.setup label:has(input[name="gameMode"][value="arena"])');
  const drawer = await page.evaluate(() => ({
    open: document.querySelector(".kit-drawer")?.dataset.open,
    pickRows: document.querySelectorAll(".setup .kit-pick-row").length,
    modelPickers: document.querySelectorAll(".setup .kit-model-picker").length,
    humanHidden: document.querySelector(".setup .human-only").hidden,
    submit: document.querySelector(".setup .start").textContent.trim(),
    distinctCast: new Set([...document.querySelectorAll(".setup .kit-pick-row .kit-seat")].map((node) => node.dataset.characterId)).size,
  }));
  if (!before || before === rerolled) failures.push(`${width}px: reroll did not change the seat (${before} -> ${rerolled})`);
  if (drawer.open !== "true" || drawer.pickRows !== 2 || drawer.modelPickers !== 2 || drawer.distinctCast !== 2 || !drawer.humanHidden || drawer.submit !== "Open the arena") {
    failures.push(`${width}px: arena setup incomplete ${JSON.stringify(drawer)}`);
  }
  await page.close();
}
await browser.close();
stopServer();
if (serverProcess?.exitCode === null) await once(serverProcess, "exit");
cleanTestData();
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Go UI check passed (1440x900 and 390x844).");
