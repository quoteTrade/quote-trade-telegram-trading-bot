# Free LLM fallback testing

The strategy planner can be tested without a paid LLM subscription. When fallback is enabled, the bot tries providers in this order:

```text
ovhcloud -> gemini -> openrouter -> groq -> huggingface -> pollinations
```

## Zero-key default

`ovhcloud` is the first fallback. It uses the OpenAI-compatible OVHcloud AI Endpoints URL and can run anonymously with rate limits:

```text
provider: ovhcloud
model:    Meta-Llama-3_3-70B-Instruct
base URL: https://oai.endpoints.kepler.ai.cloud.ovh.net/v1
key:      optional
```

That means this works for quick tests without running `/llmconnect` first:

```text
/llmstrategy protect my BTC long with a 5% trailing stop using close-position
```

The returned draft still must be confirmed manually:

```text
/llmconfirm <draft-id>
```

## Free-key fallbacks

These providers can be used without a paid subscription, but they require a free account/API key:

```bash
export GEMINI_API_KEY=...
export OPENROUTER_API_KEY=...
export GROQ_API_KEY=...
export HF_TOKEN=...
export POLLINATIONS_API_KEY=...
```

Then check the provider status in Telegram:

```text
/llmproviders
/llmfallbacks
```

## Privacy and safety

The LLM sees the strategy prompt plus the local position/risk summary the bot sends for planning. Do not include private keys, wallet secrets, seed phrases, or unrelated sensitive data in strategy prompts.

The LLM never submits orders. It can only return exact local bot commands. The user must confirm the draft, and triggered orders still go through the existing Quote.Trade order-sending code.
