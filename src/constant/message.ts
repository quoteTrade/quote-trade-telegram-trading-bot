export const START_MESSAGE = `Quote.Trade trigger bot

Per-user account sessions:
/session
/connectkey <api-key> <api-secret> [sha256|ed25519] [account]
/disconnect

Trading commands:
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
/cancelafter <id> 30m
/priceband BTC BUY BREAKOUT 65000 0.01
/riskguard BTC MAX_RISK_USD 500 CLOSE_POSITION
/triggers [all]
/canceltrigger <id>
/positions
/risk

LLM strategy drafts:
/llmconnect openai gpt-4o-mini env:OPENAI_API_KEY default
/prompt protect my BTC long with a trailing stop and take profit
/llmproviders
/llmfallbacks
/llmconfirm <draft-id>
/llmcancel <draft-id>
/llmdrafts

Account isolation: trading credentials, triggers, positions, and LLM drafts are keyed by Telegram user id, not shared chat id.`;
