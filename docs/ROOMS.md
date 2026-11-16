# Rooms

A room is one game in the hall. The server is authoritative for every rule; the browser only
renders state and sends intents. This page is the contract a new room follows.

## Files

| Path | Purpose |
| --- | --- |
| `src/rooms/<id>.js` | Server module, auto-mounted at startup. The file name must equal the exported `id`. |
| `src/games/<id>-game.js`, `src/games/<id>-ai.js` | Rules engine and AI prompt/schema (convention, not enforced). |
| `public/games/<id>/index.html` | The room page, served at `/games/<id>/`. |
| `public/games/<id>/room.json` | Optional overrides merged over the room's manifest entry. |
| `public/games/manifest.json` | Every room in the hall, in lobby order. |

Room ids match `^[a-z][a-z0-9-]{0,39}$`.

## Server module

```js
// src/rooms/liars-dice.js
export const id = "liars-dice";
export const defaults = { model: "gpt-6-luna", reasoningEffort: "low" };

export function register(app, ctx) {
  // ctx.rootDir  - repository root
  // ctx.dataDir  - writable data folder (.playground-data, or PLAYGROUND_DATA_DIR)
  // ctx.results  - the shared ResultsStore (see below)
  app.get("/api/liars-dice/state", (request, response) => { /* ... */ });
  return { onListen() { /* optional: runs once the server is listening */ } };
}
```

`server.js` imports every `src/rooms/*.js`, calls `registerGameDefaults(id, defaults)` so the model
registry accepts the room id, then calls `register(app, ctx)`. Room routes live under `/api/<id>/`.
Throw an `Error` with a numeric `status` (or use `httpError(status, message)` from
`src/platform/room-kit.js`) and the shared error handler answers `{ error }`.

Helpers in `src/platform/room-kit.js`: `sendSSE`, `createSSEChannel()` (`{ broadcast, handler(getState) }`),
`publicError`, `httpError`, `createMatchRecorder(results, gameId)`, `participantFrom(player, outcome)`.

### AI decisions

```js
import { requestStructuredDecision } from "../platform/decision-gateway.js";

const response = await requestStructuredDecision({
  gameId: "liars-dice",
  modelConfig: seat.aiConfig,              // { model, reasoningEffort }, normalized by the registry
  instructions, input, schemaName, schema, // strict JSON schema
  tableTalk: { voice: character.voice },   // optional: ask for one public in-character line
  image: "data:image/png;base64,...",      // optional: vision input (OpenAI models only)
}, { onStatus, onSummaryDelta });
// response: { output, reasoningSummary, reasoningSource, responseId, modelConfig, tableTalk }
```

- **Table talk.** With `tableTalk`, the schema gains a required `tableTalk` string (at most 140
  characters, empty for silence) and the prompt tells the model to speak in the character's voice
  without revealing private information. The line is removed from `output` and returned, cleaned,
  as `response.tableTalk` (or `null`). Store it with `pushTableTalk(table, { speaker, playerName,
  characterId, text })` from `src/platform/table-talk.js`, include `table.tableTalk` in the public
  state, and broadcast the returned entry as an SSE `table_talk` event. The four original rooms
  already do this.
- **Vision.** `image` must be a PNG, JPEG, WebP or GIF data URL under 4 MB. It is sent as a
  multimodal Responses API input to models with `vision: true` and silently dropped for text-only
  models (DeepSeek).
- **Keys.** A room uses `OPENAI_<ID>_API_KEY` / `DEEPSEEK_<ID>_API_KEY` (id upper-cased, `-` → `_`)
  when set, otherwise `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`.

### Characters

```js
import { seatCharacters } from "../platform/seating.js";
const cast = seatCharacters(aiSeatCount, config.aiPlayers?.map((seat) => seat?.characterId));
```

Every AI seat gets a distinct character. A valid `aiPlayers[i].characterId` pins seat `i`; anything
else is filled at random from the 50-character roster (`src/platform/characters.js`). Characters
carry `id, name, shortName, title, personality, voice, color, initials`. Put `voice` in the AI
snapshot and expose `player.character` (or at least its `id`) in public state so the client can
draw portraits.

### Results and the ladder

```js
recordOnce(table, "game", () => ({
  mode: "human-vs-ai",                 // or "arena"
  participants: table.players.map((player) => participantFrom(player, { place: 1 })), // or { score }
}));
```

`ResultsStore.recordMatch({ gameId, mode, participants, details })` stores the match in
`.playground-data/results.json` and updates Elo per game and overall. AI entrants are rated by
`model@reasoningEffort`; every human shares one `human` entrant. Places rank lower-is-better; scores
rank higher-is-better; equal ranks draw. `createMatchRecorder` guarantees one record per table and
key. The original rooms record on game end (Hold'em: when the session ends: one player left, or
the arena hand target).

## HTTP API

| Route | Returns |
| --- | --- |
| `GET /api/games` | `{ games: [...] }`: the manifest merged with each `room.json`, plus `serverRoom` (a module is mounted). |
| `GET /api/characters` | `{ characters: [{ id, name, shortName, title, color, initials, portrait }] }`, where `portrait` is `/assets/characters/<id>/`. |
| `GET /api/models` | `{ models: [{ id, provider, label, shortLabel, description, vision }], providers, reasoningEfforts, defaultConfig, defaults }` |
| `GET /api/ladder` | `{ overall, games: { <id>: ratings }, matchCount, recentMatches }` |
| `GET /api/ladder/:gameId` | `{ gameId, ratings, matchCount, recentMatches }` |
| `GET /api/health` | Key presence per room and provider, the model registry, mounted rooms. |

Manifest entry: `{ id, name, nameZh, route, pitch, players: { min, max }, modes: ["human-vs-ai", "arena"], status: "live" | "opening" }`.
`room.json` may override any field except `id` (for example `status`, `pitch`, or extra fields
such as `palette` or `hero`).

## Client kit

Load `/shared/kit.css`, then import the modules you need. `public/shared/kit-demo.html` is a
working gallery of every piece.

```html
<link rel="stylesheet" href="/shared/kit.css" />
<script type="module">
  import { drawer, characterPicker, modelPicker, seat, setSeatExpression, toast, transcript, backToLobby, loadCharacters, loadModels } from "/shared/kit.js";
  import { sfx } from "/shared/sfx.js";
  import { bindTableTalk, speak } from "/shared/speech.js";

  const [characters, registry] = await Promise.all([loadCharacters(), loadModels()]);
  const setup = drawer({ title: "Table setup" });           // mounts itself; non-blocking side panel / bottom sheet
  const cast = characterPicker({ characters, seats: 3 });   // random distinct cast, reroll + searchable grid
  const model = modelPicker({ registry });                   // .value -> { model, reasoningEffort }
  setup.body.append(cast.el, model.el);
  document.querySelector("header").append(backToLobby(), sfx.muteButton(), setup.toggleButton);

  // Starting a game: aiPlayers[i] = { ...model.value, characterId: cast.value[i] }
  const events = new EventSource("/api/<id>/events");
  bindTableTalk(events, (speaker) => document.querySelector(`[data-speaker="${speaker}"]`));
  sfx.play("chipClack");
</script>
```

| Piece | Elements and classes |
| --- | --- |
| `drawer({ title, open, closable, mount })` | `.kit-drawer[data-open]`, `.kit-drawer-header`, `.kit-drawer-body`; returns `{ el, body, toggleButton, open(), close(), toggle() }`. Bottom sheet under 720px. |
| `seat({ character, name, caption, expression, size })` | `figure.kit-seat[data-size=xs|sm|md|lg][data-expression][data-active]` > `.kit-portrait` (img + `.kit-initials` fallback) + `.kit-seat-name` / `.kit-seat-caption`. Portraits: `/assets/characters/<id>/<neutral|thinking|triumphant|defeated>.webp`. Use `setSeatExpression(el, expr)`, `setSeatCaption(el, text)`. `--seat-color` comes from the character. |
| `characterPicker({ characters, seats, value, onChange })` | `.kit-character-picker` > `.kit-pick-row` (+ `.kit-reroll`, `.kit-choose`), `.kit-grid-panel` > `.kit-character-grid` > `.kit-grid-option`. `.value` = ids in seat order; `setSeats(n)`, `reroll(i)`. |
| `modelPicker({ registry, value, label, onChange })` | `.kit-model-picker` with two `.kit-select`. |
| `toast(message, { tone, duration })` | `.kit-toasts` > `.kit-toast[data-tone=info|error|success]`. |
| `transcript({ title, limit })` | `.kit-transcript` > `.kit-transcript-list` > `.kit-transcript-item[data-kind=move|talk|system|reasoning]`; `add({ who, text, kind })`, `clear()`. |
| `backToLobby()` | `a.kit-back`; cross-document View Transition via `@view-transition` in kit.css. |
| `speak(anchor, text, { placement, duration })` | `.kit-speech[data-placement=top|bottom|left|right]`, kept inside the viewport. |
| `sfx.play(name)` | `cardFlick`, `chipClack`, `stoneClick`, `diceRoll`, `cupSlam`, `tileClack`, `win`, `error`; `sfx.muteButton()` (`.kit-mute`), `sfx.setMuted()`, stored in localStorage. |

Theme tokens (override on `:root` or a room wrapper): `--kit-bg`, `--kit-surface`,
`--kit-surface-strong`, `--kit-ink`, `--kit-muted`, `--kit-line`, `--kit-accent`, `--kit-accent-ink`,
`--kit-danger`, `--kit-success`, `--kit-radius`, `--kit-shadow`, `--kit-font-body`,
`--kit-font-display`, `--kit-drawer-width`, `--kit-speech-bg`, `--kit-speech-ink`, `--kit-ease`.
Everything respects `prefers-reduced-motion`.

## Art

```sh
node scripts/gen-art.mjs --prompt "..." --out public/games/<id>/art/hero.webp \
  --size 1536x1024 --quality high --model gpt-image-2.6-sunburst
node scripts/gen-art.mjs --prompt "..." --out public/games/<id>/art/die.png --transparent --quality medium
```

Reads `OPENAI_API_KEY`, writes atomically, and warns when a file is over 600 KB.

## Checks

```sh
npm test          # unit tests
npm run check     # node --check on server and public JS, then the tests
```

UI smoke tests use playwright-core with `/usr/bin/google-chrome` in headless mode. Port 4190 is on
the browser "bad ports" list: launch Chrome with `--explicitly-allowed-ports=4190`, and call the API
from Node with `node:http` rather than `fetch`, which refuses that port.
