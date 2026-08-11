export const START_MESSAGE = `Quote.Trade trigger bot

Per-user account sessions:
/session
/connectkey <api-key> <api-secret>
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
/filledorders [page]

LLM strategy drafts:
/llmconnect openai gpt-4o-mini key:<your-openai-api-key> default
/prompt protect my BTC long with a trailing stop and take profit
/llmproviders
/llmfallbacks
/llmconfirm <draft-id>
/llmcancel <draft-id>
/llmdrafts

Account isolation: trading credentials, triggers, positions, and LLM drafts are keyed by Telegram user id, not shared chat id.

LLM setup:
- To use OpenAI, create an API key here:
  https://platform.openai.com/api-keys

Examples:
  /llmconnect openai gpt-4o-mini key:<your-openai-api-key> default
  /llmproviders

Note:
- Use key:<actual-api-key> if you want to save the key for your Telegram user.
- Use env:OPENAI_API_KEY only when the key is already configured as a server environment variable.

Account isolation: trading credentials, triggers, positions, and LLM drafts are stored per Telegram user. 
Use /connectkey in a private chat before real trading. 
Use /codexconnect in private chat to connect ChatGPT Pro/Codex OAuth for LLM planning.

Codex OAuth setup:
  /codexconnect [model]
    Connect your Telegram user to Codex OAuth.
    Example:
      /codexconnect default
  /codexstatus
    Check Codex OAuth connection status.
  /codexcancel
    Cancel pending Codex OAuth login.
  /codexlogout
    Remove Codex OAuth session for this Telegram user.

`;

export const ACCOUNT_DISCONNECTED_KEYBOARD = {
  inline_keyboard: [
    [{ text: "🔐 Connect API Keys", callback_data: "account_connect" }],
    [{ text: "🧠 LLM Strategy", callback_data: "llmui_menu" }],
  ],
};

export const ACCOUNT_CONNECTED_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "📋 Session Status", callback_data: "account_session" },
      { text: "🔌 Disconnect", callback_data: "account_disconnect" },
    ],
    [{ text: "💹 Trading", callback_data: "trade_menu" }],
    [{ text: "🧠 LLM Strategy", callback_data: "llmui_menu" }],
  ],
};

export const TRADING_KEYBOARD = {
  inline_keyboard: [
    [{ text: "➕ Create Trigger", callback_data: "trade_create_menu" }],
    [
      { text: "📈 Positions", callback_data: "monitor_positions" },
      { text: "⚠️ Risk", callback_data: "monitor_risk" },
    ],
    [
      { text: "⚡ Active Triggers", callback_data: "monitor_triggers_active" },
      { text: "📚 All Triggers", callback_data: "monitor_triggers_all" },
    ],
    [{ text: "❌ Cancel Trigger", callback_data: "monitor_cancel_select" }],
    [{ text: "🧾 Filled Orders", callback_data: "monitor_fills:1" }],
    [{ text: "🏠 Home Menu", callback_data: "trade_account_menu" }],
  ],
};

export const TRIGGER_CREATE_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "Limit", callback_data: "trade_select:limit" },
      { text: "Stop Limit", callback_data: "trade_select:stoplimit" },
    ],
    [
      { text: "Take Profit", callback_data: "trade_select:takeprofit" },
      { text: "Stop Loss", callback_data: "trade_select:stoploss" },
    ],
    [
      { text: "Trailing Stop", callback_data: "trade_select:trailingstop" },
      { text: "Trailing Stop Limit", callback_data: "trade_select:trailingstoplimit" },
    ],
    [
      { text: "OCO", callback_data: "trade_select:oco" },
      { text: "Bracket", callback_data: "trade_select:bracket" },
    ],
    [
      { text: "Scale Out", callback_data: "trade_select:scaleout" },
      { text: "Break Even", callback_data: "trade_select:breakeven" },
    ],
    [
      { text: "Close After", callback_data: "trade_select:closeafter" },
      { text: "Cancel After", callback_data: "trade_select:cancelafter" },
    ],
    [
      { text: "Price Band", callback_data: "trade_select:priceband" },
      { text: "Risk Guard", callback_data: "trade_select:riskguard" },
    ],
    [{ text: "⬅️ Trading Menu", callback_data: "trade_menu" }],
  ],
};

export const TRADE_WIZARD_CANCEL_KEYBOARD = {
  inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "trade_cancel" }]],
};

export const ACCOUNT_CONNECT_CANCEL_KEYBOARD = {
  inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "account_connect_cancel" }]],
};

export const ACCOUNT_DISCONNECT_CONFIRM_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "✅ Disconnect", callback_data: "account_disconnect_confirm" },
      { text: "✖️ Cancel", callback_data: "account_disconnect_cancel" },
    ],
  ],
};
