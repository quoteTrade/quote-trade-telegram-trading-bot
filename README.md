# Quote.Trade Telegram Bot — Local L2 Trigger Orders

This branch adds Telegram-managed local triggers with per-user Quote.Trade account sessions. The bot stores each Telegram user's encrypted credentials, triggers, positions, and LLM drafts under that user's own `.quote-trade/users/<owner-hash>/` directory, watches Quote.Trade market/account data locally, and submits ordinary Quote.Trade orders through the existing order submission path when a trigger fires.

The Quote.Trade API order format is unchanged. The bot must be running for local triggers to fire. In `MODE=real`, users must connect their own Quote.Trade credentials with `/connectkey`; the Telegram bot does not share one global trading account across users.

## Build and test

```bash
npm install
npm run build
npm test
```

## L2 trigger-price rule

Price-based triggers are now side- and quantity-aware:

```text
BUY  -> ask-side L2 depth
SELL -> bid-side L2 depth
```

The engine does not use `last`, `mid`, or `mark` for price-trigger decisions. For each active trigger, it resolves the intended order side and quantity first. Then it accumulates the matching L2 side from best price outward until it can cover the full order quantity:

```text
BUY 0.01 BTC limit @ 60000
  uses asks only
  fires only when cumulative ask depth for 0.01 BTC is available at <= 60000

SELL 0.01 BTC stop @ 58000
  uses bids only
  fires only when cumulative bid depth for 0.01 BTC is available at <= 58000
```

If the book crosses the trigger price but does not have enough quantity for the resolved order size, the trigger stays active and no order is submitted.

For `close` and percentage sizing, the quantity is resolved from cached position memory before the L2 depth check. Long closes use `SELL`/bids. Short closes use `BUY`/asks.

## Per-user account sessions

The Telegram owner is `msg.from.id`, not `chat.id`, so users in the same group are still isolated. Use `/connectkey` only in a private chat with the bot:

```text
/session
/connectkey <api-key> <api-secret> [sha256|ed25519] [account]
/disconnect
```

Session files are encrypted with AES-256-GCM. Set `TELEGRAM_SESSION_ENCRYPTION_KEY` or `QUOTE_TRADE_SESSION_KEY` in production. Private-chat `/connectkey` messages are deleted after saving when Telegram allows it, and stale commands older than `TELEGRAM_MAX_COMMAND_AGE_SECONDS` are rejected by default. See `docs/telegram-user-sessions.md` for the isolation model and audit checks.


## Multiplexed active-symbol market-data listener

Market data now uses one shared multiplexed L2 WebSocket across all Telegram users and active market-data-dependent trigger symbols. Ten BTC triggers across five users and three ETH triggers across two users share the same underlying socket, but the socket subscribes only to BTC and ETH. It does not subscribe to the full Quote.Trade universe or hundreds/thousands of unused tickers. Non-price-only rules, such as `MAX_POSITION_QTY` alerts, do not create L2 subscriptions by themselves. Account data remains fully isolated per Telegram user; only public L2 book snapshots are shared.

The runtime reconciles active market-data-dependent trigger symbols once per second, so fired, cancelled, or OCO-cancelled triggers release unneeded symbol subscriptions. `TIME_CLOSE` is included in the active L2 subscription set because it submits an order and needs executable depth at its due time. Order-submitting triggers ignore stale L2 snapshots older than `TRIGGER_MAX_L2_AGE_MS`, and new subscribers do not replay cached snapshots older than `PRICE_FEED_MAX_SNAPSHOT_AGE_MS`. Trigger subscribers default to no throttling (`PRICE_FEED_MIN_TRIGGER_INTERVAL_MS=0`) so quick crossings are not skipped. See `docs/market-data-sharing-audit.md`.

## Commands

```text
/start
/session
/connectkey <api-key> <api-secret> [sha256|ed25519] [account]
/disconnect
/limit BTC BUY 60000 0.01
/stoplimit BTC SELL 58000 57950 0.01
/takeprofit BTC SELL 65000 close
/stoploss BTC SELL 58000 close
/trailingstop BTC SELL 5% close
/trailingstoplimit BTC SELL 5% 50 close
/oco BTC SELL 65000 58000 close
/bracket BTC BUY 60000 0.01 65000 58000
/scaleout BTC SELL 63000 25%
/breakeven BTC SELL 3% 0.5%
/closeafter BTC 4h
/closeat BTC 2026-05-14T12:00:00+02:00
/cancelafter <trigger-id> 30m
/priceband BTC BUY BREAKOUT 65000 0.01
/riskguard BTC MAX_RISK_USD 500 CLOSE_POSITION
/triggers
/triggers all
/canceltrigger <trigger-id>
/positions
/risk
```

Quantity arguments can be a fixed quantity, `close`, or a percent such as `25%` where supported. `close` resolves the side and size from cached positions at trigger time, then checks matching L2 side depth before order submission.

Direction is side-aware. BUY limits fire at or below the trigger price using asks. SELL limits fire at or above it using bids. BUY stop-style triggers fire upward using asks. SELL stop-style triggers fire downward using bids. OCO sibling cancellation and bracket exits are managed locally.

Positions are cached per Telegram user in `.quote-trade/users/<owner-hash>/positions.json` and refreshed from that user's listen-key account events plus optional API refreshes via `POSITIONS_ENDPOINT`.

Set `MODE=paper` to log orders only, or `MODE=real` to post orders to Quote.Trade through the unchanged `/order` flow using the connected Telegram user's own session keys.

## Optional LLM strategy planner

Users can connect their own LLM provider key, or use the default free/no-subscription fallback chain for testing, and ask for trading strategies in English. The provider response is validated into exact local bot commands and saved as a pending draft. Nothing is submitted until the user confirms the draft. Pending drafts expire after `LLM_DRAFT_MAX_AGE_SECONDS` and are atomically claimed during confirmation to prevent duplicate trigger creation.

Supported providers include OpenAI/ChatGPT, Anthropic/Claude, xAI/Grok, OVHcloud AI Endpoints, Gemini, OpenRouter, GroqCloud, Hugging Face, Pollinations, and custom OpenAI-compatible gateways. Inline `key:<api-key>` provider keys are encrypted in per-user config; env-var based keys are still preferred for production. The default fallback order is `ovhcloud -> gemini -> openrouter -> groq -> huggingface -> pollinations`; OVHcloud can run anonymously with rate limits for quick tests. See `docs/llm-strategy-planner.md` and `docs/free-llm-fallbacks.md` for setup and safety details.


## Account-isolation audit

`npm test` includes `tests/session-isolation.test.js` and `tests/price-feed-shared.test.js`, which verify encrypted per-user sessions and LLM keys, separate trigger/position/LLM files, owner-scoped trigger cancellation, user-specific order signing, no local owner/secrets in Quote.Trade request bodies, direct and timer-driven L2 staleness checks, cached-snapshot age checks, batched/pair-symbol market-data routing, and one multiplexed L2 listener that subscribes only to actively watched symbols. `npm audit` currently reports zero vulnerabilities after replacing the deprecated request-based Telegram library with the internal axios-backed Telegram Bot API client.
