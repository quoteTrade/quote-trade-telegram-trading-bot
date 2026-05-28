# Telegram Codex OAuth

This feature lets each Telegram user connect their own ChatGPT/Codex OAuth session for the optional LLM strategy planner.

It is intended for users who have ChatGPT Pro/Codex access but do not have, or do not want to use, an OpenAI Platform API key. ChatGPT/Codex OAuth is separate from Quote.Trade account sessions and separate from OpenAI Platform API billing.

## Install prerequisite

Install the Codex CLI on the host that runs the Telegram bot:

```bash
npm install -g @openai/codex
codex --version
```

Then configure the bot environment:

```bash
CODEX_BIN=codex
CODEX_MODEL=default
CODEX_LOGIN_TIMEOUT_MS=600000
CODEX_EXEC_TIMEOUT_MS=120000
```

`CODEX_MODEL=default` lets Codex use its configured/default model. A user can override it with:

```text
/codexconnect gpt-5-codex
```

## Telegram user flow

Run these in a private chat with the bot:

```text
/codexconnect
```

The bot replies with:

```text
Open: https://auth.openai.com/codex/device
Code: ABCD-1234
```

Open the URL, sign into the user's ChatGPT/Codex account, and enter the code. When Codex reports success, the bot sends a confirmation message to that Telegram user.

Then use:

```text
/llmstrategy create a BTC limit buy at 60000 for quantity 0.01
```

The result is still a pending draft. The user confirms with the inline button or:

```text
/llmconfirm <draft-id>
```

Useful session commands:

```text
/codexstatus
/codexcancel
/codexlogout
```

## Isolation

Each Telegram user gets a separate Codex home:

```text
.quote-trade/users/<sha256(telegram-from.id)>/codex/auth.json
.quote-trade/users/<sha256(telegram-from.id)>/codex/config.toml
.quote-trade/users/<sha256(telegram-from.id)>/codex-workspace/
```

The bot writes `config.toml` with file-backed credentials and ChatGPT-only login:

```toml
cli_auth_credentials_store = "file"
forced_login_method = "chatgpt"
sandbox_mode = "read-only"
```

Treat `auth.json` like a password. It contains Codex access/refresh credentials for that Telegram user. The per-user state directory is created with restrictive best-effort permissions.

## Runtime safety

For strategy planning, the bot runs:

```text
codex exec --ephemeral --ignore-rules --sandbox read-only --skip-git-repo-check --output-schema ... --output-last-message ... -
```

The prompt is sent through stdin. The Codex subprocess gets a sanitized environment containing only path/terminal/Codex-home values, not:

```text
TELEGRAM_BOT_TOKEN
TRADE_API_KEY
TRADE_API_SECRET
OPENAI_API_KEY
```

Codex cannot submit Quote.Trade orders. It only returns JSON containing proposed bot commands. The local validator rejects unknown commands, raw API JSON, missing size, and non-L2 trigger-source requests. The user must confirm before local triggers/orders are created.
