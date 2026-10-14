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

Quote.Trade REST and WebSocket levels already contain cumulative base quantities. The feed marks these snapshots with `depthQuantityMode: "cumulative"`; the engine compares each level directly to the resolved order quantity without summing levels again. Direct callers with per-level sizes can use `depthQuantityMode: "per-level"` (also the legacy default when omitted). The price compared to the trigger is the worst price required to fill that full quantity.

Example:

```text
BUY 3 @ 100
asks:
  99 x 1
  100 x 3

Cumulative ask depth reaches 3 at 100, so the trigger can fire.
```

```text
SELL 3 @ 120
bids:
  121 x 1
  120 x 3

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



OCO siblings are cancelled after a successful submission acknowledgement, not after a fill. Definite application rejections leave siblings active. Submission exceptions stop that trigger from automatically retrying, including after restart. A transport timeout may hide an accepted order: reconcile authoritative order/account state before manually resubmitting. The existing `REJECTED` trigger label does not prove exchange rejection after a transport failure.

Supported `clientOrderId`, `reduceOnly`, `account`, and `disableLeverage` options are forwarded; `disableLeverage` is sent as 0 or 1 only when supplied. Trigger ids and metadata remain local. A client order id alone is not a guarantee of idempotency.

## REST acknowledgement and WebSocket fills

The REST order response is a snapshot of the order state at response time. An acknowledgement such as `NEW` with `executedQty=0` does not establish a final fill outcome. The authenticated `/ws/listenKey` stream continues to deliver `ORDER_TRADE_UPDATE` fill and status updates even after the REST response. Keep the subscription active, correlate updates by order ID and client order ID, and reconcile order/account state after reconnects or ambiguous timeouts before retrying.

In private order events, `o.q` is the original order quantity, `o.l` is the last filled quantity, and `o.z` is the cumulative filled quantity for that order. Do not sum `o.z` across updates or add it to the REST `executedQty` snapshot; both describe cumulative execution. Public depth `q` describes available liquidity, not a fill.

## FIX-compatible order and execution codes

Order and execution response codes are designed to match FIX semantics. The private WebSocket uses FIX-style codes in `o.X` (OrdStatus) and `o.x` (ExecType); the REST order response can use status names such as `NEW` and `FILLED`. Decode each field according to its documented representation. HTTP status codes and negative application error codes are separate from FIX order/execution codes.
