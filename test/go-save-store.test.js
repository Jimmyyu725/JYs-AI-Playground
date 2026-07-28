import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GoSaveStore } from "../src/games/go-save-store.js";

test("atomically writes and reads the current Go save slot", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jys-go-save-"));
  try {
    const store = new GoSaveStore(directory);
    assert.equal(store.load(), null);
    const payload = { gameId: "go", version: 1, savedAt: "2026-07-28T22:00:00.000Z", state: { moveNumber: 12 } };
    store.save(payload);
    assert.deepEqual(store.load(), payload);
    assert.deepEqual(fs.readdirSync(directory), ["go-current.json"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
