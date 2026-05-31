# LLM strategy planner

The LLM planner is optional. It lets a user connect their own provider key, ask for a strategy in English, and receive a pending draft containing only exact bot commands. Confirming a draft creates local triggers through the same command/trigger path as manual input. The LLM never sends a Quote.Trade order directly.

## Safety model

- Draft first, confirm second. A provider response is never executed automatically. Pending drafts expire after `LLM_DRAFT_MAX_AGE_SECONDS` seconds by default and are atomically claimed before confirmation, so double-clicking a Confirm button cannot create duplicate trigger sets.
- Only whitelisted command formats are accepted. Unknown commands, raw API JSON, missing size, unsupported options, and `last`/`mid`/`mark` trigger-source requests are rejected.
- Trigger execution remains local and L2-depth based: BUY uses executable ask depth for the requested quantity; SELL uses executable bid depth for the requested quantity.
- API keys can be read from environment variables or stored locally in `.quote-trade/llm-config.json`; environment variables are preferred. Codex OAuth does not use an OpenAI Platform API key; each Telegram user signs into their own ChatGPT/Codex session with `/codexconnect`.

## Providers and default free fallback

Supported presets: OpenAI/ChatGPT API, Codex OAuth for ChatGPT Pro/Codex accounts, Anthropic/Claude, xAI/Grok, OVHcloud AI Endpoints, Google Gemini, OpenRouter, GroqCloud, Hugging Face Inference Providers, Pollinations, and custom OpenAI-compatible gateways.

By default, `/llmstrategy` tries the free/no-subscription fallback chain before failing:

```text
ovhcloud -> gemini -> openrouter -> groq -> huggingface -> pollinations
```

`ovhcloud` can run as an anonymous, rate-limited OpenAI-compatible fallback, so a developer can test the planner without adding a paid subscription or provider key. The other providers are still free-tier candidates, but they require the user's own free API key in the matching environment variable.

See `docs/free-llm-fallbacks.md` for provider details.

## Telegram commands

```text
/codexconnect
/codexstatus
/llmstrategy create a BTC stop loss for 0.01 BTC at 58000
/llmconnect openai gpt-4o-mini env:OPENAI_API_KEY default
/llmfallbacks
/llmproviders
/llmconnect openrouter openrouter/free env:OPENROUTER_API_KEY fallback
/llmstrategy protect my BTC long with a trailing stop and take profit
/llmconfirm <draft-id>
/llmcancel <draft-id>
/llmdrafts
/codexlogout
```

Telegram draft messages include Confirm and Cancel buttons when the bot receives at least one valid command from the provider. The primary button now says `Confirm Order` or `Confirm Orders`, and the proposed command line is bolded in the draft message so the user can quickly identify exactly what will be created. The message also repeats the L2 execution rule: BUY checks executable ask depth and SELL checks executable bid depth.


## Codex OAuth for ChatGPT Pro/Codex users

Use this when a Telegram user has ChatGPT Pro/Codex access but does not want to configure OpenAI Platform API billing. The bot host must have the Codex CLI installed and available as `CODEX_BIN` or on `PATH`. Each Telegram user runs `/codexconnect` in a private chat; the bot starts Codex's device-code OAuth flow, shows the verification URL and code, and stores that user's Codex auth cache under their own `.quote-trade/users/<owner-hash>/codex/` directory.

After approval, the user's LLM provider is saved as `codex-oauth` and `/llmstrategy` uses `codex exec` with a read-only sandbox and JSON output schema. The strategy prompt is sent over stdin, not command-line arguments. The Codex process receives a sanitized environment and does not receive Telegram, Quote.Trade, or OpenAI Platform API secrets.

Codex still only proposes draft commands. It cannot submit Quote.Trade orders; the user must confirm the validated draft.
