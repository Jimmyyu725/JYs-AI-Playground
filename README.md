# The Luna Room

A new browser-based no-limit Texas Hold'em game with a casino-salon interface and multiple AI characters. Every AI seat uses the OpenAI Responses API with one locked model:

- model: `gpt-5.6-luna`
- reasoning effort: `medium`
- reasoning summary: `auto`
- structured action output: strict JSON Schema
- local poker-policy fallback: **none**

The server owns the cards, chips, turn order, legal actions, hand ranking, and side-pot settlement. Luna only chooses from the legal actions supplied by that server.

## Play

Requires Node.js 22 or newer.

```bash
npm install
npm start
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173).

The API key stays in `.env.local` as `OPENAI_API_KEY`; that file is ignored by Git. Never move the key into browser JavaScript.

## The table

- 1 human against 2–5 AI opponents
- distinct AI characters, names, colors, and poker styles
- configurable starting stacks and blinds
- full pre-flop, flop, turn, river, showdown, and next-hand flow
- folds, checks, calls, bets, raises, and all-ins
- hand evaluation and independent main/side-pot settlement
- hidden opponent cards until showdown
- live hand history and per-character decision latency
- reused card artwork from the earlier desktop game
- original `gpt-image-2` casino-room backdrop

## AI behavior

AI requests use streamed Responses API events without an application turn timer. The server and browser wait for the request rather than replacing it with a local decision.

If OpenAI returns an API failure, malformed result, or illegal poker action, the hand pauses and displays a **Retry Luna** control. No local heuristic acts on the AI's behalf.

The right rail shows OpenAI's supported reasoning summary when returned. When a request does not include a summary, it shows Luna's explicit public decision-rationale field instead. The application does not expose or claim to expose private chain-of-thought.

## Verification

```bash
npm run check       # syntax, hand evaluator, side pots, rules, full checked-down hand
npm run ui:check    # desktop and mobile browser rendering, assets, controls, overflow
npm run api:check   # one live Luna structured decision
npm run flow:check  # live multi-character turn chain through the running server
```

`npm run ui:check` and `npm run flow:check` expect the local server to be running.

## Structure

```text
public/                   Browser UI and bundled image/card assets
src/poker-game.js         Authoritative Hold'em state machine
src/hand-evaluator.js     Five-to-seven-card evaluation and side pots
src/openai-player.js      Luna Responses API stream and validation
server.js                 Local web server, SSE updates, AI turn orchestration
test/                     Deterministic rules tests
scripts/                  Live API and browser smoke checks
```

## Generated visual

The final casino backdrop is saved at `public/assets/casino-ambient.png`. It was generated through the Image API using `gpt-image-2` with this production prompt:

> A luxurious midnight casino interior with deep burgundy velvet walls, emerald shadow tones, brushed brass trim, crystal chandeliers, subtle haze and warm pools of light. Premium cinematic Art Deco realism; extra-wide symmetrical room; low-contrast empty center for an HTML poker table; detail concentrated around the edges. No people, cards, chips, gaming tables, roulette, text, logos, watermark, or interface elements.

## OpenAI references

- [GPT-5.6 Luna model](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [Reasoning models and summaries](https://developers.openai.com/api/docs/guides/reasoning#reasoning-summaries)
- [Streaming Responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

