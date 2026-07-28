# JYs AI Playground

A private, casino-inspired browser playground with three authoritative games and distinct OpenAI-powered characters:

- **Texas Hold’em** — human vs AI or a 2–5 seat AI Arena
- **Go / 围棋** — human vs AI or AI vs AI on 9×9, 13×13, and 19×19 boards
- **Wuziqi / 五子棋** — human vs AI or AI vs AI on 13×13, 15×15, and 19×19 boards

Open [http://127.0.0.1:4173](http://127.0.0.1:4173) to enter the central casino lobby.

## OpenAI configuration

Every AI seat can independently select one of the real GPT-5.6 model variants:

- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`

Available reasoning efforts are `none`, `low`, `medium`, `high`, `xhigh`, and `max`. The server validates both fields against an allowlist.

Create an ignored `.env.local` from `.env.example` and keep the three game credentials separate:

```dotenv
OPENAI_API_KEY=your_holdem_key
OPENAI_GO_API_KEY=your_go_key
OPENAI_WUZIQI_API_KEY=your_wuziqi_key
PORT=4173
```

Keys are read only by the local Express server. They are never returned by `/api/health`, included in browser JavaScript, or committed to Git.

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

## House guarantees

- The server owns all rules, legal actions, cards, boards, scoring, captures, wins, and turn order.
- OpenAI receives only the acting character’s private information plus public game state. Hold’em opponents never receive one another’s hole cards.
- AI characters do receive their opponents’ public character profiles and visible move/action history, making the displayed personas strategically relevant.
- Responses API requests stream without an application turn timer.
- API failures pause the game for an explicit retry.
- Go automatically retries malformed or illegal model moves twice before pausing.
- There is no local LLM, heuristic player, or silent model fallback.
- The UI retains public rationales and supported OpenAI reasoning summaries in a persistent transcript. It does not expose or claim to expose private chain-of-thought.

## Rules

### Texas Hold’em

No-limit Hold’em with configurable stacks and blinds, full betting streets, all-ins, hand evaluation, and independent main/side-pot settlement. Every hole card is visible to the spectator in AI Arena mode, but not to the other AI players.

### Go

Chinese area scoring with configurable komi (7.5 default), capture, suicide prohibition, positional superko, pass, resignation, and two-pass game completion. Territory and stones are scored by the server. The current Go game auto-saves after every committed change to the ignored `.playground-data/go-current.json` slot and restores when the server starts again. The Save Game button forces an immediate write.

### Wuziqi

Freestyle Gomoku: five or more contiguous stones horizontally, vertically, or diagonally win. Overlines count as wins. Renju forbidden-move rules are intentionally not enabled in this version.

## Verification

```bash
npm run check             # syntax plus every deterministic game/rules test
npm run ui:check          # lobby and Hold’em desktop/mobile browser checks
npm run go:ui:check       # Go desktop/mobile board and setup checks
npm run go:save:check     # isolated save, server restart, and restore check
npm run wuziqi:ui:check   # Wuziqi desktop/mobile board and setup checks
npm run api:check         # one live Hold’em structured decision
npm run go:api:check      # one live Go decision using the Go key
npm run wuziqi:api:check  # one live Wuziqi decision using the Wuziqi key
npm run flow:check        # live multi-character Hold’em turn chain
npm run arena:check       # one complete live Hold’em AI Arena hand
```

Browser and flow checks expect the local server to be running. Live API checks consume API usage.

## Structure

```text
public/                         Casino lobby and all browser interfaces
public/games/holdem/            Hold’em entry page
public/games/go/                Go interface
public/games/wuziqi/            Wuziqi interface
src/poker-game.js               Authoritative Hold’em state machine
src/games/go-game.js            Authoritative Go engine and scoring
src/games/go-save-store.js      Atomic local Go save-slot storage
src/games/wuziqi-game.js        Authoritative Wuziqi engine
src/platform/model-registry.js  Model, reasoning, and credential allowlists
src/platform/openai-gateway.js  Shared Responses API streaming and schemas
src/platform/characters.js      Public AI character registry
server.js                       APIs, SSE streams, and AI turn orchestration
test/                           Deterministic rules and privacy tests
scripts/                        Browser, live API, and flow checks
```

## Visual asset

The shared casino backdrop at `public/assets/casino-ambient.png` was generated with `gpt-image-2`. All table, board, stone, chip, and lobby components are original HTML/CSS interfaces; the Hold’em room reuses the card artwork from the earlier desktop game.

## OpenAI references

- [Using GPT-5.6](https://developers.openai.com/api/docs/guides/model-guidance?model=gpt-5.6)
- [GPT-5.6 models](https://developers.openai.com/api/docs/models)
- [Reasoning summaries](https://developers.openai.com/api/docs/guides/reasoning#reasoning-summaries)
- [Streaming Responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
