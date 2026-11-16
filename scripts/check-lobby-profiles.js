#!/usr/bin/env node
// Keeps public/characters/profiles.json in step with src/platform/characters.js.
// GET /api/characters omits personality and voice, so "The House" gallery reads them from this file.
//   node scripts/check-lobby-profiles.js          exits 1 when the file is stale
//   node scripts/check-lobby-profiles.js --write  regenerates it
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AI_CHARACTERS } from "../src/platform/characters.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PROFILES_PATH = path.join(rootDir, "public", "characters", "profiles.json");

export function buildProfiles() {
  const profiles = Object.fromEntries(
    AI_CHARACTERS.map((character) => [character.id, { personality: character.personality, voice: character.voice }]),
  );
  return `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const expected = buildProfiles();
  if (process.argv.includes("--write")) {
    const temporary = `${PROFILES_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, expected);
    fs.renameSync(temporary, PROFILES_PATH);
    console.log(`Wrote ${path.relative(rootDir, PROFILES_PATH)} (${AI_CHARACTERS.length} characters)`);
  } else {
    const current = fs.existsSync(PROFILES_PATH) ? fs.readFileSync(PROFILES_PATH, "utf8") : "";
    if (current !== expected) {
      console.error("public/characters/profiles.json is stale; run node scripts/check-lobby-profiles.js --write");
      process.exit(1);
    }
    console.log("profiles.json matches the roster");
  }
}
