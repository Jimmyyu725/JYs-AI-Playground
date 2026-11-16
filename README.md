# JYs AI Playground

A browser game hall where people play against LLM characters, or sit back and watch the
characters play each other in an AI arena. The Node server is authoritative for every rule; the
browser only renders state and sends intents. There is no build step: plain ES modules in
`public/`, served by Express 5.

## The hall

Nine rooms, each its own world with its own art, palette, type and sound. Every room offers
**human vs AI** and an **AI arena**.

| Room | Seats | What it is |
| --- | --- | --- |
| [Texas Hold'em 德州扑克](http://127.0.0.1:4173/games/holdem/) | 2–6 | No-limit Hold'em with side pots, in the Salon Riviera. |
| [Go 围棋](http://127.0.0.1:4173/games/go/) | 2 | Chinese area scoring on 9×9, 13×13 or 19×19, positional superko, auto-saved games. |
| [Wuziqi 五子棋](http://127.0.0.1:4173/games/wuziqi/) | 2 | Freestyle five-in-a-row on 13×13, 15×15 or 19×19. |
| [Dou Dizhu 斗地主](http://127.0.0.1:4173/games/doudizhu/) | 3 | One round of 叫分 bidding, then the landlord against two farmers. |
| [Liar's Dice 大话骰](http://127.0.0.1:4173/games/liars-dice/) | 2–6 | Perudo rules: wild ones, Calza, Palifico. |
| [Xiangqi 象棋](http://127.0.0.1:4173/games/xiangqi/) | 2 | Chinese chess with flying general, perpetual-check loss and traditional notation. |
| [Coup 政变](http://127.0.0.1:4173/games/coup/) | 2–6 | Bluff, block and challenge for influence. |
| [Draw & Guess 你画我猜](http://127.0.0.1:4173/games/draw-guess/) | 2–6 | Vision models guess your sketch, or you guess what an image model paints for them. |
| [Taiwan Mahjong 台灣麻將](http://127.0.0.1:4173/games/taiwan-mahjong/) | 4 | Sixteen-tile Taiwanese mahjong with flowers, claims and a tai table. |

Around the rooms:

- **Lobby** (`/`): a corridor of lit doors, a ladder teaser and a trio of house regulars.
- **The House** (`/characters/`): the 50 resident AI characters, each with a profile and a record.
- **Ladder** (`/ladder/`): Elo ratings per game and overall. AI entrants are rated by
  `model@reasoningEffort`; every human shares one `human` entrant. Results live in
  `.playground-data/results.json`.

### The 50-character house

`src/platform/characters.js` holds 50 characters, each with a personality, a speaking voice, a
look and four portraits (`neutral`, `thinking`, `triumphant`, `defeated`) in
`public/assets/characters/<id>/`. Every new table seats a **random distinct set** of them
(`pickCharacters`). The setup drawer lets the player reroll any seat or pick a specific character
from a searchable grid. Characters see each other's public profiles and may speak one short
in-character line of table talk per decision, shown as a speech bubble and in the room's log.

## Adding a room

Every room follows one contract: a server module in `src/rooms/<id>.js` that is mounted
automatically, a page in `public/games/<id>/`, an entry in `public/games/manifest.json`, and the
shared client kit in `public/shared/` (setup drawer, character and model pickers, seats, speech
bubbles, sound). See **[docs/ROOMS.md](docs/ROOMS.md)**.

## Models

Every AI seat picks its own model and reasoning effort:

| Model | Provider | API |
| --- | --- | --- |
| `gpt-6.1-sol` | OpenAI | Responses API, strict `json_schema`, vision |
| `gpt-6.1-terra` | OpenAI | Responses API, strict `json_schema`, vision |
| `gpt-6-luna` | OpenAI | Responses API, strict `json_schema`, vision (the default, at `low` effort) |
| `gpt-6-astra` | OpenAI | Responses API, strict `json_schema`, vision |
| `deepseek-v4-pro` | DeepSeek | Chat Completions, `json_object` |
| `deepseek-flash` | DeepSeek | Chat Completions, `json_object` |

Reasoning efforts: `none`, `low`, `medium`, `high`, `xhigh`, `max`. The server checks the model and
effort against this allowlist (`src/platform/model-registry.js`) before any request leaves the
machine. Draw & Guess also paints pictures with `gpt-image-2.6-flare`.

Provider differences the code handles:

- **DeepSeek has no strict `json_schema` mode.** The schema goes into the system prompt and is
  requested as `json_object`; the gateway unwraps stray single-key envelopes, and every decision
  is still validated against the live rules before it is applied.
- **DeepSeek has no vision.** Image input is dropped for text-only models.
- **Reasoning text is labelled by source.** OpenAI seats show only the API's reasoning *summary*;
  DeepSeek seats show the `reasoning_content` the API returns, labelled `DeepSeek raw reasoning`;
  a seat with neither falls back to its own public rationale.

## Configuration

The server reads `.env.local` (ignored by git). Start from `.env.example`.

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Shared OpenAI key for every room. |
| `OPENAI_<ROOM>_API_KEY` | Optional per-room OpenAI key, e.g. `OPENAI_GO_API_KEY`, `OPENAI_LIARS_DICE_API_KEY`. |
| `DEEPSEEK_API_KEY` | Shared DeepSeek key (only needed for DeepSeek seats). |
| `DEEPSEEK_<ROOM>_API_KEY` | Optional per-room DeepSeek key. |
| `PORT` | Listen port, default `4173`. |
| `HOST` | Bind address, default `127.0.0.1` (loopback only). |
| `PLAYGROUND_DATA_DIR` | Where saves and results go, default `.playground-data`. |
| `LIARS_DICE_REVEAL_MS` | How long Liar's Dice keeps the cups up after a call, default `4200`. |

**Key fallback.** `<ROOM>` is the room id upper-cased with `-` turned into `_`. A room uses its own
`OPENAI_<ROOM>_API_KEY` / `DEEPSEEK_<ROOM>_API_KEY` when it is set and non-empty, otherwise the
shared `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`. If neither is set, that provider's seats in that room
fail with a `missing_api_key` error and the game pauses for a retry. `/api/health` reports which
keys are present (never their values). Keys are read only by the server: they never reach the
browser and are never committed.

## Run

Requires Node.js 22 or newer.

```bash
npm install
npm start            # http://127.0.0.1:4173
HOST=0.0.0.0 npm start   # reachable from the LAN
```

The hall has no authentication and every AI seat spends real API credit, so keep it on a trusted
network and never expose it to the public internet. Jimmy's hosted copy at
<https://play.jimmyyu888.com> is reachable only from his LAN and tailnet.

## House guarantees

- The server owns all rules, legal actions, cards, boards, scoring, captures, wins and turn order.
- A model receives only its own seat's private information plus the public state. No seat ever
  sees another seat's hidden cards, dice or tiles.
- Model requests stream with no application turn timer.
- Every model move is validated against the rules before it is applied. Illegal or malformed
  moves and API failures never become a guessed move: the room asks again or pauses with an
  explicit retry.
- There is no local LLM, heuristic player or silent model fallback.

## Checks

```bash
npm test                       # deterministic rules, privacy and room tests
npm run check                  # node --check on the server and all public JS, then the tests
npm run lobby:ui:check         # browser checks: lobby, The House, ladder
npm run ui:check               # Hold'em (likewise go:, wuziqi:, doudizhu:, liars-dice:,
                               # xiangqi:, coup:, draw-guess:, taiwan-mahjong: ui:check)
npm run go:save:check          # Go save, restart and restore
npm run api:check              # one live Hold'em decision (spends API credit)
npm run ds:api:check           # one live DeepSeek decision per board game
```

Browser checks drive headless Chrome through `playwright-core`; set `CHROME_PATH` to override the
per-platform lookup (`CHROME_PATH=/usr/bin/google-chrome`). Live checks spend API credit.

## Structure

```text
server.js                  Express app: mounts every src/rooms/*.js, plus the shared APIs
src/rooms/                 One server module per room (routes, SSE, AI turn loop)
src/games/                 Rules engines and AI prompts/schemas
src/poker-game.js          Hold'em state machine (with hand-evaluator.js, openai-player.js)
src/platform/              Model registry, OpenAI/DeepSeek gateways, characters, seating,
                           table talk, results store (ladder), room kit
public/                    Lobby, The House (characters/), ladder/
public/games/<id>/         Each room's page, styles, art and sound
public/shared/             Client kit: drawer, pickers, seats, speech, sfx
public/assets/characters/  50 characters × 4 portraits
docs/ROOMS.md              The room contract
test/                      node:test suites
scripts/                   Browser, save, live API and art-generation scripts
```

## References

- [OpenAI models](https://developers.openai.com/api/docs/models)
- [Reasoning summaries](https://developers.openai.com/api/docs/guides/reasoning#reasoning-summaries)
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [DeepSeek API docs](https://api-docs.deepseek.com/) and [JSON output](https://api-docs.deepseek.com/guides/json_mode)
