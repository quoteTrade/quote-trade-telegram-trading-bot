# Quote.Trade Telegram Bot — Advanced Orders + AI Prompt Trading

The Quote.Trade Telegram Bot lets users trade Quote.Trade from Telegram with either exact slash commands or plain-English AI prompts. It supports local L2 trigger orders, advanced order workflows, per-user account sessions, and AI-generated order drafts that require explicit user confirmation before anything is created.

Supported workflows include limit orders, stop limits, take profit, stop loss, trailing stops, trailing stop limits, OCO, brackets, scale-outs, breakeven stops, timed closes, cancel-after triggers, price bands, risk guards, close-limit, close-stop-limit, filled-order history, and AI prompt trading.

The Quote.Trade API order format is unchanged. The bot must be running for local triggers to fire. In `MODE=real`, users must connect their own Quote.Trade credentials with `/connectkey`; the Telegram bot does not share one global trading account across users.

## Key safety model

- **Per-user isolation:** credentials, triggers, positions, LLM config, and LLM drafts are stored per Telegram user under `.quote-trade/users/<owner-hash>/`.
- **No shared trading account:** the Telegram owner is `msg.from.id`, not `chat.id`, so users in the same group remain isolated.
- **AI drafts only:** AI prompts generate validated command drafts. The bot does not submit or create triggers until the user confirms with the inline button or `/llmconfirm <draft-id>`.
- **Local trigger execution:** L2 trigger orders are evaluated locally. The bot process must stay online for triggers to fire.
- **Paper mode first:** use `MODE=paper` before real trading.

## Quick start

```bash
cp sample.env .env
# edit .env and set TELEGRAM_BOT_TOKEN plus the Quote.Trade API/WS URLs
npm install
npm run build
npm start
```

For development:

```bash
npm run dev
```

For validation:

```bash
npm test
```

## Required configuration

Start from `sample.env` and set at least:

```env
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
API_BASE_URL=https://app.quote.trade/api
LIQUIDITY_WS_URL=wss://app.quote.trade/ws/liquidity
LISTEN_KEY_WS_URL=wss://app.quote.trade/ws/listenKey
MODE=paper
TELEGRAM_SESSION_ENCRYPTION_KEY=replace-with-a-long-random-value
QUOTE_TRADE_STATE_DIR=.quote-trade
DEFAULT_PAYMENT_CURRENCY=USD
POSITIONS_ENDPOINT=/positions
```

Production notes:

- Set `TELEGRAM_SESSION_ENCRYPTION_KEY` or `QUOTE_TRADE_SESSION_KEY` to a long random value. Do not rely on the bot token as encryption material in production.
- `TRADE_API_KEY` and `TRADE_API_SECRET` are legacy/global values and are not used by the session-backed Telegram runtime. Users connect their own keys with `/connectkey`.
- Private-chat `/connectkey` messages are deleted after saving when Telegram allows it.
- Stale commands older than `TELEGRAM_MAX_COMMAND_AGE_SECONDS` are rejected by default.
- Pending LLM drafts expire after `LLM_DRAFT_MAX_AGE_SECONDS` by default.

## User onboarding flow

1. Start the bot with `/start`.
2. Check session status with `/session`.
3. In a private chat, connect Quote.Trade credentials:

   ```text
   /connectkey <api-key> <api-secret> [sha256|ed25519] [account]
   ```

4. Confirm account state with `/positions` and `/risk`.
5. Create advanced orders with slash commands or use AI prompt trading with `/prompt`, `/llmstrategy`, or plain English in a private chat.
6. Review AI-generated drafts carefully. Nothing is created until the user confirms.

## Trading command reference

### Account and session commands

| Command | Purpose |
|---|---|
| `/start` | Show bot help and examples. |
| `/session` | Show the connected Quote.Trade session for the Telegram user. |
| `/connectkey <api-key> <api-secret> [sha256\|ed25519] [account]` | Connect the Telegram user to their own Quote.Trade account. Private chat only. |
| `/disconnect` | Remove the connected account session and stop the user's local runtime. |

### Advanced order and trigger commands

| Command | Example | Purpose |
|---|---|---|
| `/limit <symbol> <BUY\|SELL> <price> <qty\|close\|percent>` | `/limit BTC BUY 60000 0.01` | Create a side-aware L2 limit trigger. |
| `/stoplimit <symbol> <BUY\|SELL> <stop> <limit> <qty\|close\|percent>` | `/stoplimit BTC SELL 58000 57950 0.01` | Create a stop-limit trigger. |
| `/takeprofit <symbol> <BUY\|SELL> <price> <qty\|close\|percent>` | `/takeprofit BTC SELL 65000 close` | Close or reduce a position when the take-profit price is reached. |
| `/stoploss <symbol> <BUY\|SELL> <price> <qty\|close\|percent>` | `/stoploss BTC SELL 58000 close` | Close or reduce a position when the stop-loss price is reached. |
| `/trailingstop <symbol> <BUY\|SELL> <trail> <qty\|close\|percent>` | `/trailingstop BTC SELL 5% close` | Create a trailing stop using a percent or fixed amount. |
| `/trailingstoplimit <symbol> <BUY\|SELL> <trail> <limitOffset> <qty\|close\|percent>` | `/trailingstoplimit BTC SELL 5% 50 close` | Create a trailing stop-limit with a limit-price offset. |
| `/oco <symbol> <BUY\|SELL> <takeProfit> <stopLoss> <qty\|close\|percent> [stopLimit]` | `/oco BTC SELL 65000 58000 close` | Create one-cancels-the-other exit triggers. |
| `/bracket <symbol> <BUY\|SELL> <entry> <qty> <takeProfit> <stopLoss> [stopLimit]` | `/bracket BTC BUY 60000 0.01 65000 58000` | Create an entry trigger with take-profit and stop-loss exits. |
| `/scaleout <symbol> <BUY\|SELL> <price> <percent>` | `/scaleout BTC SELL 63000 25%` | Reduce a position by a percentage at a target price. |
| `/breakeven <symbol> <BUY\|SELL> <after> [plus]` | `/breakeven BTC SELL 3% 0.5%` | Arm a breakeven stop after a position moves in profit. |
| `/closeafter <symbol> <duration>` | `/closeafter BTC 4h` | Close a position after a duration such as `30m`, `4h`, or `1d`. |
| `/closeat <symbol> <ISO time>` | `/closeat BTC 2026-05-14T12:00:00+02:00` | Close a position at a specific future time. |
| `/cancelafter <trigger-id> <duration>` | `/cancelafter trg_abc123 30m` | Cancel a trigger after a duration. |
| `/priceband <symbol> <BUY\|SELL> <BREAKOUT\|REVERSION> <bandPrice> <qty\|close\|percent>` | `/priceband BTC BUY BREAKOUT 65000 0.01` | Create a breakout or reversion trigger. |
| `/riskguard <symbol> <metric> <threshold> <action>` | `/riskguard BTC MAX_RISK_USD 500 CLOSE_POSITION` | Watch risk and alert, close, or cancel triggers. |
| `/closelimit <symbol> <price>` | `/closelimit BTC 65000` | Create a limit trigger to close the cached position side. |
| `/closestoplimit <symbol> <stop> <limit>` | `/closestoplimit BTC 58000 57950` | Create a stop-limit trigger to close the cached position side. |

Supported risk metrics:

```text
MAX_POSITION_QTY
MAX_RISK_USD
MAX_LOSS_USD
```

Supported risk actions:

```text
ALERT
CLOSE_POSITION
CANCEL_TRIGGERS
```

### Positions, risk, triggers, and fills

| Command | Purpose |
|---|---|
| `/triggers` | Show active triggers for the Telegram user. |
| `/triggers all` | Show active, triggered, cancelled, and rejected triggers. |
| `/canceltrigger <trigger-id>` | Cancel one of the user's triggers. |
| `/positions` | Show cached positions for the connected account session. |
| `/risk` | Show cached gross risk and position details. |
| `/filledorders [page]` | Show cached recent fills and start the private account/order watcher if needed. |

`/orders` is currently disabled in `src/bot.ts`; use `/filledorders [page]` for recent fills.

## Sizing, symbols, and sides

- Symbols are entered as base symbols such as `BTC` or `ETH`. Quote.Trade settlement/payment currency defaults to `DEFAULT_PAYMENT_CURRENCY=USD`.
- Market-data routing normalizes common pair formats such as `BTC/USD`, `BTC-USDT`, and `BTCUSDT` back to the active base symbol.
- `BUY`, `BID`, and `1` normalize to `BUY`. `SELL`, `SEL`, `ASK`, and `2` normalize to `SELL`.
- Quantity arguments can be a fixed quantity, `close`, `all`, `position`, or a percent such as `25%` where supported.
- `close` resolves the side and size from cached positions at trigger time, then checks matching L2 side depth before order submission.
- Bracket entries require a fixed positive quantity.

## AI prompt trading

Users can describe a strategy in English. The bot asks the configured LLM provider for an exact local bot command plan, validates the plan, saves it as a pending draft, and shows the user a review message. The draft can be confirmed with an inline button or manually with `/llmconfirm <draft-id>`.

The LLM never sends a Quote.Trade order directly.

### Prompt examples

```text
/prompt protect my BTC long with a trailing stop and take profit
/llmstrategy create a BTC bracket order around trendlines
/llmstrategy scale out 25% of my ETH position at the next resistance level
/llmstrategy close my BTC position after 4 hours unless take profit hits first
```

In a private chat, users can also send a plain-English prompt without a slash command, for example:

```text
Create a long bracket order on Bitcoin around trendlines
```

### Draft management commands

```text
/llmconfirm <draft-id>
/llmcancel <draft-id>
/llmdrafts
/llmdrafts all
```

Pending drafts expire after `LLM_DRAFT_MAX_AGE_SECONDS` and are atomically claimed during confirmation to prevent duplicate trigger creation.

## LLM provider setup

Users can connect their own LLM provider key, use environment-provided keys, use a default free/no-subscription fallback chain for testing, or connect a per-user Codex OAuth session.

### Provider commands

```text
/llmconnect openai gpt-4o-mini env:OPENAI_API_KEY default
/llmconnect openai gpt-4o-mini key:<your-openai-api-key> default
/llmconnect openrouter openrouter/free env:OPENROUTER_API_KEY fallback
/llmproviders
/llmfallbacks
```

Supported providers and aliases include:

```text
openai / chatgpt / gpt
anthropic / claude
xai / grok
ovhcloud / ovh / ovh-cloud / ovhcloud-ai
gemini / google
openrouter
groq
huggingface / hf
pollinations / pollinations-ai
custom-openai / custom / openai-compatible
codex-oauth / codex / openai-codex / chatgpt-pro / chatgpt-codex / gpt-pro
```

Environment variables from `sample.env`:

```env
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
XAI_API_KEY=
OVHCLOUD_API_KEY=
AI_ENDPOINT_API_KEY=
GEMINI_API_KEY=
OPENROUTER_API_KEY=
GROQ_API_KEY=
HF_TOKEN=
POLLINATIONS_API_KEY=
CUSTOM_LLM_API_KEY=
CUSTOM_LLM_BASE_URL=
```

Inline `key:<api-key>` provider keys are encrypted in per-user config and are only accepted in a private chat. Environment-variable keys are preferred for production.

The default free/no-subscription fallback order is:

```text
ovhcloud -> gemini -> openrouter -> groq -> huggingface -> pollinations
```

`ovhcloud` can run anonymously with rate limits for quick tests. Other free-tier candidates require the user's own free API key in the matching environment variable.

See `docs/llm-strategy-planner.md` and `docs/free-llm-fallbacks.md` for details.

## Codex OAuth setup

Use Codex OAuth when a Telegram user has ChatGPT Pro/Codex access but does not want to configure an OpenAI Platform API key. The bot host must have the Codex CLI installed and available as `CODEX_BIN` or on `PATH`.

Install the prerequisite on the bot host:

```bash
npm install -g @openai/codex
codex --version
```

Set optional environment variables:

```env
CODEX_BIN=codex
CODEX_MODEL=default
CODEX_LOGIN_START_TIMEOUT_MS=30000
CODEX_LOGIN_TIMEOUT_MS=600000
CODEX_EXEC_TIMEOUT_MS=120000
```

Telegram user flow, private chat only:

```text
/codexconnect [model]
/codexstatus
/codexcancel
/codexlogout
```

After `/codexconnect`, the bot sends a device-code verification URL and user code. After approval, `/prompt` and `/llmstrategy` can use that user's Codex OAuth session. Codex is still draft-only; the user must confirm the validated draft before triggers/orders are created.

See `docs/codex-oauth-telegram.md` for the isolation and runtime-safety model.

## L2 trigger-price rule

Price-based triggers are side- and quantity-aware:

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

Session files are encrypted with AES-256-GCM. Set `TELEGRAM_SESSION_ENCRYPTION_KEY` or `QUOTE_TRADE_SESSION_KEY` in production. Private-chat `/connectkey` messages are deleted after saving when Telegram allows it, and stale commands older than `TELEGRAM_MAX_COMMAND_AGE_SECONDS` are rejected by default.

See `docs/telegram-user-sessions.md` for the isolation model and audit checks.

## Multiplexed active-symbol market-data listener

Market data uses one shared multiplexed L2 WebSocket across all Telegram users and active market-data-dependent trigger symbols. Ten BTC triggers across five users and three ETH triggers across two users share the same underlying socket, but the socket subscribes only to BTC and ETH. It does not subscribe to the full Quote.Trade universe or hundreds/thousands of unused tickers.

Non-price-only rules, such as `MAX_POSITION_QTY` alerts, do not create L2 subscriptions by themselves. Account data remains fully isolated per Telegram user; only public L2 book snapshots are shared.

The runtime reconciles active market-data-dependent trigger symbols once per second, so fired, cancelled, or OCO-cancelled triggers release unneeded symbol subscriptions. `TIME_CLOSE` is included in the active L2 subscription set because it submits an order and needs executable depth at its due time. Order-submitting triggers ignore stale L2 snapshots older than `TRIGGER_MAX_L2_AGE_MS`, and new subscribers do not replay cached snapshots older than `PRICE_FEED_MAX_SNAPSHOT_AGE_MS`. Trigger subscribers default to no throttling (`PRICE_FEED_MIN_TRIGGER_INTERVAL_MS=0`) so quick crossings are not skipped.

See `docs/market-data-sharing-audit.md`.

## Positions and real-mode execution

Positions are cached per Telegram user in `.quote-trade/users/<owner-hash>/positions.json` and refreshed from that user's listen-key account events plus optional API refreshes via `POSITIONS_ENDPOINT`.

Set `MODE=paper` to log orders only, or `MODE=real` to post orders to Quote.Trade through the unchanged `/order` flow using the connected Telegram user's own session keys.

## Privacy and prompt safety

The LLM sees the strategy prompt plus the local position/risk summary the bot sends for planning. Do not include private keys, wallet secrets, seed phrases, or unrelated sensitive data in strategy prompts.

The local validator rejects unknown commands, raw API JSON, missing size, unsupported options, and non-side-based trigger-source requests.

## Related docs

- `docs/local-l2-triggers.md`
- `docs/telegram-user-sessions.md`
- `docs/market-data-sharing-audit.md`
- `docs/llm-strategy-planner.md`
- `docs/free-llm-fallbacks.md`
- `docs/codex-oauth-telegram.md`

## Account-isolation audit

`npm test` includes `tests/session-isolation.test.js`, `tests/price-feed-shared.test.js`, and `tests/codex-oauth.test.js`, which verify encrypted per-user sessions and LLM keys, separate trigger/position/LLM files, owner-scoped trigger cancellation, user-specific order signing, no local owner/secrets in Quote.Trade request bodies, direct and timer-driven L2 staleness checks, cached-snapshot age checks, batched/pair-symbol market-data routing, and one multiplexed L2 listener that subscribes only to actively watched symbols.
