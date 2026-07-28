import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "jys-go-restart-"));

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
    if (processHandle.exitCode !== null) throw new Error("The Go save test server exited early");
    try {
      const response = await fetch(`${baseURL}/api/health`);
      if (response.ok) return;
    } catch {
      // The isolated server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The Go save test server did not become ready");
}

const port = await availablePort();
const baseURL = `http://127.0.0.1:${port}`;
let serverProcess = null;

async function startServer() {
  serverProcess = spawn(process.execPath, ["server.js"], {
    cwd: rootDir,
    env: { ...process.env, PLAYGROUND_DATA_DIR: dataDirectory, PORT: String(port) },
    stdio: "ignore",
  });
  await waitForServer(baseURL, serverProcess);
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  serverProcess.kill("SIGTERM");
  await once(serverProcess, "exit");
}

async function jsonRequest(pathname, options) {
  const response = await fetch(`${baseURL}${pathname}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

process.once("exit", () => {
  if (serverProcess?.exitCode === null) serverProcess.kill("SIGTERM");
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

try {
  await startServer();
  await jsonRequest("/api/go/game", {
    method: "POST",
    body: JSON.stringify({ gameMode: "human", humanName: "Saver", humanColor: "black", boardSize: 9, komi: 7.5 }),
  });
  const moved = await jsonRequest("/api/go/action", {
    method: "POST",
    body: JSON.stringify({ action: "place", row: 0, column: 0 }),
  });
  assert.equal(moved.moveNumber, 1);
  assert.equal(moved.board[0][0], "black");
  assert.ok(moved.save.savedAt);

  const manuallySaved = await jsonRequest("/api/go/save", { method: "POST", body: "{}" });
  assert.ok(manuallySaved.save.savedAt);
  await stopServer();

  await startServer();
  const restored = await jsonRequest("/api/go/state");
  assert.equal(restored.moveNumber, 1);
  assert.equal(restored.board[0][0], "black");
  assert.equal(restored.players[0].name, "Saver");
  assert.equal(restored.logs.some((entry) => entry.text.includes("A9")), true);
  assert.equal(restored.save.restored, true);
  console.log(JSON.stringify({ ok: true, moveNumber: restored.moveNumber, restored: restored.save.restored }));
} finally {
  await stopServer();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
}
