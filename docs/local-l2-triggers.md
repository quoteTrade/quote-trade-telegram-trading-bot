# Local L2 trigger behavior

All price-based trigger decisions are made locally from the streaming L2 order book.

## Side selection

```text
Order side  Book side used for trigger checks
BUY         asks
SELL        bids
```

The trigger engine does not use `last`, `mid`, or `mark` for price-trigger decisions.

## Quantity check

Before checking the trigger condition, the engine resolves the order quantity from the current Telegram user's own position cache:

1. fixed quantity, or
2. cached full position size for `close`, or
3. cached position percentage such as `25%`.

It then walks the matching L2 side until cumulative quantity is at least the resolved order quantity. The price compared to the trigger is the worst price required to fill that full quantity.

Example:

```text
BUY 3 @ 100
asks:
  99 x 1
  100 x 2

Cumulative ask depth reaches 3 at 100, so the trigger can fire.
```

```text
SELL 3 @ 120
bids:
  121 x 1
  120 x 2

Cumulative bid depth reaches 3 at 120, so the trigger can fire.
```

If cumulative depth is insufficient, the trigger remains active.

## Time and risk triggers

Time-cancel triggers do not submit orders and can fire without L2 depth. Time-close and risk-guard close-position triggers submit orders, so they wait for a recent L2 tick with enough side depth before sending the order. By default, all order-trigger decisions ignore L2 ticks older than `TRIGGER_MAX_L2_AGE_MS`.

## API behavior

When a trigger fires, the bot submits the same ordinary Quote.Trade order payload used by manual orders. Trigger metadata is local only and is not added to the Quote.Trade `/order` request. In the Telegram bot, the fired trigger's owner id routes submission to that Telegram user's encrypted Quote.Trade session; one user's credentials and positions are never used for another user's trigger.

## Multiplexed active-symbol feed

The Telegram runtime shares one multiplexed L2 WebSocket across all active market-data-dependent trigger symbols. It subscribes only to symbols that currently have market-data-dependent trigger work. For example, active BTC and ETH triggers share one socket that subscribes to BTC and ETH only; the bot does not subscribe to every available ticker.

When the final trigger subscriber for a symbol leaves, the feed sends an unsubscribe frame for that symbol. When no active market-data-dependent trigger symbols remain, the socket closes after a short idle delay. The shared cache contains public order-book snapshots only and does not replay snapshots older than `PRICE_FEED_MAX_SNAPSHOT_AGE_MS` to new subscribers. Per-user positions, credentials, triggers, and order submissions remain isolated.

