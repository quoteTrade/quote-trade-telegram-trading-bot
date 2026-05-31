# Telegram per-user account sessions

The Telegram bot is multi-user account isolated. Every trading user has their own local runtime, encrypted Quote.Trade credentials, trigger file, position cache, LLM provider config, and LLM drafts.

```text
Telegram from.id
  -> .quote-trade/users/<sha256(from.id)>/session.json
  -> .quote-trade/users/<sha256(from.id)>/triggers.json
  -> .quote-trade/users/<sha256(from.id)>/positions.json
  -> .quote-trade/users/<sha256(from.id)>/llm-config.json
  -> .quote-trade/users/<sha256(from.id)>/llm-drafts.json
```

The owner is the Telegram **user id** (`from.id`), not the chat id. This matters in groups: two people using commands in the same group are still routed to different local accounts and different state files. Trigger-fired notifications are sent to the owner's private Telegram chat when possible, so each user should start the bot privately before relying on status notifications.

## Connecting a Quote.Trade account

Use this only in a private chat with the bot:

```text
/connectkey <api-key> <api-secret> [sha256|ed25519] [account]
/session
/disconnect
```

`/connectkey` is rejected in group chats so credentials are not intentionally saved from a public message. In private chats, the bot attempts to delete the `/connectkey` message after saving the encrypted session so the raw API key/secret do not remain in the chat history. The session is stored encrypted with AES-256-GCM. Set one of these encryption secrets before running the bot:

```bash
TELEGRAM_SESSION_ENCRYPTION_KEY=replace-with-a-long-random-value
# or
QUOTE_TRADE_SESSION_KEY=replace-with-a-long-random-value
# or
SESSION_ENCRYPTION_KEY=replace-with-a-long-random-value
```

If none of those is set, the bot falls back to `TELEGRAM_BOT_TOKEN` as encryption key material. A dedicated encryption key is recommended because it lets you rotate the bot token independently from stored account sessions.

## Order routing

Fired local triggers include the trigger owner id in the local `SubmitOrderRequest`. `BotService` then resolves that owner id to the corresponding encrypted session and signs the normal Quote.Trade `/order` request with that user's API key and secret.

Local-only fields are not sent to Quote.Trade:

```text
ownerId
triggerId
meta
reduceOnly
clientOrderId
```

The Quote.Trade order format itself remains unchanged.

## Market-data sharing

Market data is public and symbol-scoped, so it is shared for efficiency. A BTC L2 book listener/cache is opened once for BTC and fanned out to every active BTC trigger engine. ETH uses a separate ETH listener/cache.

This does not comingle account state. Each user's trigger engine receives the same public L2 snapshot but resolves close-position quantities from that user's own `positions.json` and submits real orders with that user's encrypted Quote.Trade session.

See `docs/market-data-sharing-audit.md` for the listener lifecycle and tests.

## Position isolation

`/positions`, `/risk`, close-position sizing, scale-out sizing, break-even stops, time-close, and risk guards all use the caller's own position cache only.

A user-data WebSocket is opened per connected user, using that user's request token/API key. Account updates from one user's stream update only that user's `positions.json` file.

## Command freshness

By default, Telegram commands older than 300 seconds are rejected:

```bash
TELEGRAM_MAX_COMMAND_AGE_SECONDS=300
```

This reduces the chance that queued Telegram updates from a previous bot outage replay old order or credential commands after restart. Set the value to `0` only if you intentionally want to process stale queued updates.

## Trigger isolation

Commands such as `/triggers`, `/canceltrigger`, `/cancelafter`, and LLM confirmations operate only on the current Telegram user's trigger file. A trigger id from another user is not visible or cancellable from the caller's runtime.

## LLM planner isolation

LLM provider settings and LLM drafts are now stored per Telegram user. Inline LLM API keys supplied with `key:<api-key>` are encrypted before they are written to `llm-config.json`; using `env:NAME` is still preferred for production. A draft produced for one user cannot be confirmed, cancelled, or listed by another user. Confirmation still creates local triggers only; the LLM never submits a Quote.Trade order directly.

## Audit checks

Run:

```bash
npm test
```

The `tests/session-isolation.test.js` audit verifies:

```text
- per-user state paths are different;
- Quote.Trade API keys/secrets are not stored in plaintext;
- stored inline LLM API keys are not stored in plaintext;
- user A cannot load or cancel user B's trigger id;
- user A and user B position caches resolve different close sides/sizes;
- LLM drafts/config are per-user;
- TriggerEngine passes ownerId into order submission;
- BotService signs real-mode orders with the session owner's API key, not global env keys;
- order request bodies do not contain owner ids or secrets;
- position refresh for one user does not update another user's position store;
- shared market-data subscriptions do not create duplicate WebSockets for the same symbol.
```
