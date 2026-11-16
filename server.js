import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";
import express from "express";
import { apiKeyFor, configuredProviderKeys, publicModelRegistry, registerGameDefaults } from "./src/platform/model-registry.js";
import { ResultsStore } from "./src/platform/results-store.js";
import { publicError } from "./src/platform/room-kit.js";
import { publicCharacters } from "./src/platform/seating.js";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(rootDir, ".env.local") });
const dataDir = path.resolve(rootDir, process.env.PLAYGROUND_DATA_DIR || ".playground-data");
const results = new ResultsStore(path.join(dataDir, "results.json"));

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(rootDir, "public"), { extensions: ["html"] }));

/** Every src/rooms/<id>.js exporting { id, defaults, register(app, ctx) } is mounted at startup. */
async function loadRooms() {
  const roomsDir = path.join(rootDir, "src", "rooms");
  const files = fs.readdirSync(roomsDir).filter((file) => file.endsWith(".js")).sort();
  const rooms = [];
  for (const file of files) {
    const room = await import(pathToFileURL(path.join(roomsDir, file)).href);
    if (typeof room.id !== "string" || typeof room.register !== "function") {
      console.warn(`Skipping src/rooms/${file}: it must export id and register(app, ctx)`);
      continue;
    }
    if (`${room.id}.js` !== file) throw new Error(`src/rooms/${file} exports id "${room.id}"; the file name must match`);
    registerGameDefaults(room.id, room.defaults);
    rooms.push(room);
  }
  return rooms;
}

const rooms = await loadRooms();
const roomHooks = rooms.map((room) => room.register(app, { rootDir, dataDir, results }) ?? {});
const roomIds = rooms.map((room) => room.id);

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") console.error(`Ignoring ${path.relative(rootDir, filePath)}: ${error.message}`);
    return null;
  }
}

/** public/games/manifest.json merged with each room's public/games/<id>/room.json overrides. */
function gameCatalog() {
  const manifest = readJSON(path.join(rootDir, "public", "games", "manifest.json"));
  const games = Array.isArray(manifest?.games) ? manifest.games : [];
  return games.map((game) => {
    const overrides = /^[a-z][a-z0-9-]{0,39}$/.test(game.id) ? readJSON(path.join(rootDir, "public", "games", game.id, "room.json")) : null;
    return { ...game, ...(overrides ?? {}), id: game.id, serverRoom: roomIds.includes(game.id) };
  });
}

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    apiKeys: Object.fromEntries(
      roomIds.map((id) => [id, { openai: Boolean(apiKeyFor("openai", id).value), deepseek: Boolean(apiKeyFor("deepseek", id).value) }]),
    ),
    providerKeys: configuredProviderKeys(),
    models: publicModelRegistry(),
    games: Object.fromEntries(roomIds.map((id) => [id, true])),
    noLocalFallback: true,
  });
});

app.get("/api/models", (_request, response) => {
  response.json(publicModelRegistry());
});

app.get("/api/games", (_request, response) => {
  response.json({ games: gameCatalog() });
});

app.get("/api/characters", (_request, response) => {
  response.json({ characters: publicCharacters() });
});

app.get("/api/ladder", (_request, response) => {
  response.json(results.overview());
});

app.get("/api/ladder/:gameId", (request, response) => {
  response.json(results.ladder(request.params.gameId));
});

app.use((error, _request, response, _next) => {
  const status = Number.isInteger(error.status) ? error.status : 400;
  response.status(status).json({ error: publicError(error) });
});

const port = Number.parseInt(process.env.PORT, 10) || 4173;
// Loopback by default. Set HOST=0.0.0.0 to reach the playground from the LAN;
// the app has no authentication, so never expose it to the public internet.
const host = process.env.HOST || "127.0.0.1";
const server = app.listen(port, host, () => {
  console.log(`JYs AI Playground is ready at http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`);
  for (const hooks of roomHooks) hooks.onListen?.();
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
