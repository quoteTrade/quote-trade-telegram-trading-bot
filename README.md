# Quote.Trade Telegram Bot — Local Trigger Orders

This branch adds Telegram-managed local triggers. The bot stores triggers in `.quote-trade/triggers.json`, watches Quote.Trade market/account data locally, and submits ordinary Quote.Trade orders through the existing order submission path when a trigger fires.

The Quote.Trade API order format is unchanged. The bot must be running for local triggers to fire.

## Build and test

```bash
npm install
npm run build
npm test
```

## Commands

```text
/start
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

Quantity arguments can be a fixed quantity, `close`, or a percent such as `25%` where supported. `close` resolves the side and size from cached positions at trigger time.

Direction is side-aware. BUY limits fire at or below the trigger price. SELL limits fire at or above it. BUY stop-style triggers fire upward. SELL stop-style triggers fire downward. OCO sibling cancellation and bracket exits are managed locally.

Positions are cached in `.quote-trade/positions.json` and refreshed from listen-key account events plus optional API refreshes via `POSITIONS_ENDPOINT`.

Set `MODE=paper` to log orders only, or `MODE=real` to post orders to Quote.Trade through the unchanged `/order` flow.
