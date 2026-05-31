# Multiplexed active-symbol market-data audit

The Telegram bot keeps account data isolated per Telegram user, but market data is public and symbol-scoped. The bot now uses one shared multiplexed L2 WebSocket for all active market-data-dependent trigger symbols instead of one socket per symbol or per user.

```text
BTC triggers for user A
BTC triggers for user B
ETH trigger for user C
        ↓
one multiplexed L2 WebSocket
        ↓
subscribe BTC and ETH only
        ↓
per-symbol L2 caches fan out to each user's isolated trigger engine
```

The feed does **not** subscribe to every Quote.Trade symbol. It subscribes only to symbols that currently have active local market-data-dependent work, then unsubscribes a symbol when its final subscriber leaves. A `MAX_POSITION_QTY` alert risk guard, for example, does not need L2 prices and does not create a feed subscription by itself.

```text
Active BTC triggers only        -> socket subscribes BTC
Active BTC + ETH triggers       -> same socket subscribes BTC and ETH
All BTC triggers cancelled      -> same socket unsubscribes BTC immediately
No active market-data-dependent trigger symbols left  -> socket has zero subscriptions and closes after idle delay
```

## Trigger price rule

The shared feed only supplies L2 book snapshots. Trigger decisions still happen inside each user's isolated trigger engine and position store.

```text
BUY  -> cumulative ask-side depth for the resolved quantity
SELL -> cumulative bid-side depth for the resolved quantity
```

The engine does not use `last`, `mid`, or `mark` for order-trigger decisions. A trigger fires only when the current matching-side book can cover the resolved order quantity through the trigger price.

## Cache and fanout behavior

The feed accepts full-book snapshots and side-only L2 frames. BUY decisions still require ask-side depth for the resolved quantity, and SELL decisions still require bid-side depth. The opposite side is not required just to process a valid matching-side update.


`PriceFeedService` maintains one socket and per-symbol state:

```text
one underlying WebSocket
active subscribed symbols set
per-symbol subscribers
per-symbol last L2 snapshot
per-symbol last update timestamp
```

When a new trigger subscribes to a symbol that already has a recent cached book snapshot, the subscriber receives that snapshot immediately. Snapshots older than `PRICE_FEED_MAX_SNAPSHOT_AGE_MS` are not replayed, which prevents newly-created triggers from firing against stale public book data after a feed outage or long idle period. The next live book update then continues normal processing. Each subscriber has its own throttle interval, so one slow subscriber does not slow down other subscribers. Trigger runtimes default to no throttling (`PRICE_FEED_MIN_TRIGGER_INTERVAL_MS=0`) so short-lived bid/ask crossings are not skipped; set the value above zero only if you intentionally want per-subscriber rate limiting.

## Time-close triggers

`TIME_CLOSE` triggers are order-submitting triggers, so they are included in the active symbol subscription set. This ensures a time-close trigger has a recent executable bid/ask depth snapshot available when its due time arrives. L2 snapshots older than `TRIGGER_MAX_L2_AGE_MS` are ignored for order-submitting trigger decisions by default, including both regular price triggers and timer-driven close triggers. `TIME_CANCEL` does not submit an order and therefore does not need an L2 subscription.

## Lifecycle behavior

`TriggerRuntime.reconcileSymbols()` compares the user's active watchable trigger symbols against current subscriptions. It subscribes newly needed symbols and unsubscribes symbols that no longer have active price-based/risk triggers for that user. The runtime also reconciles once per second so fired, cancelled, or OCO-cancelled triggers release market-data subscriptions without requiring a process restart.

`PriceFeedService` then multiplexes those user-level requests into one socket-level subscription set:

```text
first subscriber for BTC   -> send { symbol: "BTC", unsubscribe: 0 }
second BTC subscriber      -> no duplicate subscribe frame
first ETH subscriber       -> send { symbol: "ETH", unsubscribe: 0 }
last BTC subscriber leaves -> send { symbol: "BTC", unsubscribe: 1 }
last active symbol leaves  -> unsubscribe that symbol immediately, then close the idle socket after delay
```

The default idle period is 5 seconds to avoid reconnect churn when triggers are cancelled and recreated quickly. The runtime also calls `ensureActive()` during reconciliation, so a trigger subscriber can recover if `LIQUIDITY_WS_URL` is configured after the trigger was already created, without recreating the trigger.

## Security boundary

Market data is shared because it is not account-specific. Account data is not shared:

```text
Quote.Trade API keys       per Telegram user
account user-data stream   per Telegram user
positions cache            per Telegram user
triggers file              per Telegram user
LLM config/drafts          per Telegram user
```

A shared BTC book snapshot can be read by every user's local trigger engine, but only that user's own position cache and encrypted Quote.Trade session are used to resolve close sizes and sign real orders.

## Dependency audit

The bot uses a small internal Telegram Bot API polling client backed by `axios` instead of `node-telegram-bot-api`. This removes the deprecated `request`/`request-promise` dependency chain and its transitive advisories from the runtime dependency tree.

Run:

```bash
npm test
npm audit --package-lock-only
```

Expected audit result after this pass:

```text
found 0 vulnerabilities
```

## Tests

`tests/price-feed-shared.test.js` verifies:

```text
- multiple BTC subscribers share one multiplexed WebSocket;
- BTC and ETH share the same underlying WebSocket;
- only actively requested symbols are subscribed;
- removing one BTC subscriber keeps BTC subscribed while another BTC subscriber remains;
- removing the final BTC subscriber sends a BTC unsubscribe frame while ETH remains active;
- unsubscribed BTC messages are not delivered;
- the final symbol subscriber sends an immediate unsubscribe even if socket close is delayed;
- the socket closes only after the final active symbol leaves;
- reconnect resubscribes all currently active symbols on one socket;
- new subscribers receive only recent cached symbol snapshots;
- stale cached snapshots are not replayed;
- batched L2 frames and pair symbols such as BTC/USD route to the requested base ticker;
- missing LIQUIDITY_WS_URL warns once instead of crashing.
```
