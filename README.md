# JYs AI Playground

A private, casino-inspired browser playground with four authoritative games and distinct AI-powered characters:

- **Texas Hold’em** — human vs AI or a 2–5 seat AI Arena
- **Go / 围棋** — human vs AI or AI vs AI on 9×9, 13×13, and 19×19 boards
- **Wuziqi / 五子棋** — human vs AI or AI vs AI on 13×13, 15×15, and 19×19 boards
- **Dou Dizhu / 斗地主** — one landlord against two farmers, human vs AI or a three-seat AI table

Open [http://127.0.0.1:4173](http://127.0.0.1:4173) to enter the central casino lobby.

## Model configuration

Every AI seat independently selects one model from either provider:

| Model | Provider | API |
| --- | --- | --- |
| `gpt-6.1-sol` | OpenAI | Responses API, strict `json_schema`, vision |
| `gpt-6.1-terra` | OpenAI | Responses API, strict `json_schema`, vision |
| `gpt-6-luna` | OpenAI | Responses API, strict `json_schema`, vision (default, low effort) |
| `gpt-6-astra` | OpenAI | Responses API, strict `json_schema`, vision |
| `deepseek-v4-pro` | DeepSeek | Chat Completions, `json_object` |
| `deepseek-flash` | DeepSeek | Chat Completions, `json_object` |

Available reasoning efforts are `none`, `low`, `medium`, `high`, `xhigh`, and `max`. Every model above accepts all six. The server validates the model and the effort against an allowlist before any request leaves the machine.

Create an ignored `.env.local` from `.env.example`:

```dotenv
OPENAI_API_KEY=your_shared_key
OPENAI_GO_API_KEY=your_go_key
OPENAI_WUZIQI_API_KEY=your_wuziqi_key
DEEPSEEK_API_KEY=your_deepseek_key
PORT=4173
```

Each room uses `OPENAI_<ROOM>_API_KEY` / `DEEPSEEK_<ROOM>_API_KEY` (for example `OPENAI_GO_API_KEY`, `OPENAI_LIARS_DICE_API_KEY`) when it is set, and otherwise falls back to the shared `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`.

Keys are read only by the local Express server. They are never returned by `/api/health`, included in browser JavaScript, or committed to Git.

### Provider differences that the code handles

- **DeepSeek has no strict `json_schema` mode.** The decision schema is embedded in the system prompt and requested as `json_object`. Because that guarantees only syntactic validity, the gateway unwraps single-key envelopes the model sometimes emits, and every decision is still validated against the live game rules before it is applied.
- **DeepSeek returns `reasoning_content`, not an abridged summary.** See the guarantees below.
- `deepseek-v4-pro` is not yet reachable over DeepSeek's Responses API endpoint, so its adapter uses Chat Completions.

## Run

Requires Node.js 22 or newer.

```bash
npm install
npm start
```

Game routes:

- [Lobby](http://127.0.0.1:4173/)
- [Texas Hold’em](http://127.0.0.1:4173/games/holdem/)
- [Go / 围棋](http://127.0.0.1:4173/games/go/)
- [Wuziqi / 五子棋](http://127.0.0.1:4173/games/wuziqi/)
- [Dou Dizhu / 斗地主](http://127.0.0.1:4173/games/doudizhu/)

The server binds to loopback by default. To reach it from another machine on the
same LAN, set `HOST`:

```bash
HOST=0.0.0.0 npm start
```

The playground has no authentication and every seat spends real API credit, so
keep it on a trusted network and never expose it to the public internet.

## House guarantees

- The server owns all rules, legal actions, cards, boards, scoring, captures, wins, and turn order.
- The selected model receives only the acting character’s private information plus public game state. Hold’em opponents never receive one another’s hole cards.
- AI characters do receive their opponents’ public character profiles and visible move/action history, making the displayed personas strategically relevant.
- Model requests stream without an application turn timer.
- API failures pause the game for an explicit retry.
- Go automatically retries malformed or illegal model moves twice before pausing.
- Dou Dizhu automatically retries malformed or illegal model plays twice before pausing.
- There is no local LLM, heuristic player, or silent model fallback.
- The UI retains public rationales and whatever reasoning text the provider itself returns, in a persistent transcript labelled by source:
  - **OpenAI seats** show only the API's reasoning *summary*. Private chain-of-thought is neither exposed nor claimed to be exposed.
  - **DeepSeek seats** show the full `reasoning_content` the API returns, because DeepSeek deliberately publishes it. Entries are labelled `DeepSeek raw reasoning` so the two are never conflated.
  - Seats whose response carried no reasoning text fall back to the model's own public rationale, labelled `public rationale`.

## Rules

### Texas Hold’em

No-limit Hold’em with configurable stacks and blinds, full betting streets, all-ins, hand evaluation, and independent main/side-pot settlement. Every hole card is visible to the spectator in AI Arena mode, but not to the other AI players.

### Go

Chinese area scoring with configurable komi (7.5 default), capture, suicide prohibition, positional superko, pass, resignation, and two-pass game completion. Territory and stones are scored by the server. The current Go game auto-saves after every committed change to the ignored `.playground-data/go-current.json` slot and restores when the server starts again. The Save Game button forces an immediate write.

### Wuziqi

Freestyle Gomoku: five or more contiguous stones horizontally, vertically, or diagonally win. Overlines count as wins. Renju forbidden-move rules are intentionally not enabled in this version.

### Dou Dizhu

Three players bid 1–3 to become the landlord (a bid of 3 wins immediately; if everyone passes, the house redeals). The landlord takes the three bottom cards and leads. Legal plays are singles, pairs, triples, triples with one or a pair, straights of 5+ ranks, pair straights of 3+ pairs, airplanes of 2+ consecutive triples (optionally with the same number of wing cards, which may be singles or pairs but never both jokers), four with two singles (6 cards, the singles may share a rank but never both jokers) or two pairs (8 cards), bombs, and the rocket. Followers must match type and length with a higher rank, or play any bomb or the rocket. The first empty hand ends the hand: the landlord wins alone, otherwise both farmers win. Each bomb or rocket doubles the score (base bid × 2ⁿ); a spring (农民一张未出) or anti-spring (地主只出了一手) doubles it once more. Snatching the landlord and doubling options are intentionally not enabled in this version.

## Verification

```bash
npm run check             # syntax plus every deterministic game/rules test
npm run ui:check          # lobby and Hold’em desktop/mobile browser checks
npm run go:ui:check       # Go desktop/mobile board and setup checks
npm run go:save:check     # isolated save, server restart, and restore check
npm run wuziqi:ui:check   # Wuziqi desktop/mobile board and setup checks
npm run doudizhu:ui:check # Dou Dizhu desktop/mobile table and setup checks
npm run api:check         # one live Hold’em structured decision
npm run go:api:check      # one live Go decision using the Go key
npm run wuziqi:api:check  # one live Wuziqi decision using the Wuziqi key
npm run doudizhu:api:check # one live Dou Dizhu bid using the Dou Dizhu key
CHECK_MODEL=deepseek-flash npm run wuziqi:api:check   # one live DeepSeek decision
npm run ds:api:check      # one live DeepSeek V4 Pro decision in Hold'em, Go, and Wuziqi
                          # optional: node scripts/check-deepseek.js <game> <reasoningEffort>
npm run flow:check        # live multi-character Hold’em turn chain
npm run arena:check       # one complete live Hold’em AI Arena hand
```

Browser and flow checks expect the local server to be running. Live API checks consume API usage.

The browser checks drive an installed Chrome, discovered per platform. Set `CHROME_PATH`
to override the lookup:

```bash
CHROME_PATH=/usr/bin/google-chrome npm run ui:check
```

## Structure

```text
public/                         Casino lobby and all browser interfaces
public/games/holdem/            Hold’em entry page
public/games/go/                Go interface
public/games/wuziqi/            Wuziqi interface
public/games/doudizhu/          Dou Dizhu interface
src/poker-game.js               Authoritative Hold’em state machine
src/games/go-game.js            Authoritative Go engine and scoring
src/games/go-save-store.js      Atomic local Go save-slot storage
src/games/wuziqi-game.js        Authoritative Wuziqi engine
src/games/doudizhu-game.js      Authoritative Dou Dizhu engine, bidding, and scoring
src/platform/model-registry.js  Model, provider, reasoning, and credential allowlists
src/platform/decision-gateway.js  Routes a decision to the provider that owns the model
src/platform/openai-gateway.js  OpenAI Responses API streaming and strict schemas
src/platform/deepseek-gateway.js  DeepSeek Chat Completions streaming and JSON recovery
src/platform/ai-decision-error.js  Shared provider-agnostic decision error
src/platform/characters.js      Public AI character registry
server.js                       APIs, SSE streams, and AI turn orchestration
test/                           Deterministic rules and privacy tests
scripts/                        Browser, live API, and flow checks
```

## Visual asset

The shared casino backdrop at `public/assets/casino-ambient.png` was generated with `gpt-image-2`. All table, board, stone, chip, and lobby components are original HTML/CSS interfaces; the Hold’em room reuses the card artwork from the earlier desktop game.

## DeepSeek references

- [DeepSeek API docs](https://api-docs.deepseek.com/)
- [JSON output](https://api-docs.deepseek.com/guides/json_mode)

## OpenAI references

- [OpenAI models](https://developers.openai.com/api/docs/models)
- [Room contract](docs/ROOMS.md)
- [Reasoning summaries](https://developers.openai.com/api/docs/guides/reasoning#reasoning-summaries)
- [Streaming Responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
