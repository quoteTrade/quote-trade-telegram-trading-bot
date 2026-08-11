"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync } = require("node:fs");

const { makeTempDir, tempFile, cleanupTempDirs } = require("./helpers/tmp");
const { stubRequire } = require("./helpers/module-stub");

/**
 * Owners the stubbed Codex OAuth module reports as signed in.
 *
 * The real `hasCodexOAuthSession` probes `~/.quote-trade/<owner>/codex/auth.json`
 * and creates that directory as a side effect, so the codex branches are only
 * reachable deterministically through a stub.
 */
const codexSessions = new Set();
/** Every `completeCodexOAuthPlan` call the provider client forwards. */
const codexPlanCalls = [];
let codexPlanResult = { summary: "codex plan", commands: [], riskNotes: [] };
/** Every `axios.post` the default (uninjected) transport performs. */
const axiosCalls = [];
let axiosResult = { data: {} };

const restoreRequire = stubRequire({
  "./codex-oauth": {
    hasCodexOAuthSession: (ownerId) => codexSessions.has(String(ownerId)),
    completeCodexOAuthPlan: async (ownerId, model, request) => {
      codexPlanCalls.push({ ownerId, model, request });
      return codexPlanResult;
    },
  },
  // `postJson` lazily requires axios, so the default transport is only
  // observable through the module loader.
  axios: {
    post: async (url, body, options) => {
      axiosCalls.push({ url, body, options });
      return axiosResult;
    },
  },
});

const {
  FREE_FALLBACK_ORDER,
  LLM_PROVIDER_DEFAULTS,
  LlmConfigStore,
  LlmDraftStore,
  LlmProviderClient,
  LlmStrategyPlanner,
  escapeTelegramHtml,
  formatDraft,
  formatDraftButtonLabel,
  formatDraftForTelegramHtml,
  formatLlmProviderRows,
  isLlmDraftExpired,
  normalizeLlmProvider,
  parsePlanCommand,
  parsePlanCommands,
  redactedSecret,
} = require("../dist/llm");

/**
 * Every env var that can change how a provider resolves, plus the encryption
 * key the stored-secret path needs. The whole list is cleared at file scope so
 * no case silently depends on the developer's shell, and restored afterwards.
 */
const MANAGED_ENV = [
  "TELEGRAM_SESSION_ENCRYPTION_KEY",
  "QUOTE_TRADE_SESSION_KEY",
  "SESSION_ENCRYPTION_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "XAI_API_KEY",
  "OVHCLOUD_API_KEY",
  "AI_ENDPOINT_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "HF_TOKEN",
  "HUGGINGFACE_API_KEY",
  "POLLINATIONS_API_KEY",
  "CUSTOM_LLM_API_KEY",
  "LLM_API_KEY",
  "MY_OPENAI_KEY_ALIAS",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "GROQ_BASE_URL",
  "GROQ_MODEL",
  "CUSTOM_OPENAI_BASE_URL",
  "CUSTOM_OPENAI_MODEL",
  "CUSTOM_LLM_BASE_URL",
  "LLM_BASE_URL",
  "CODEX_MODEL",
  "DEFAULT_PAYMENT_CURRENCY",
  "LLM_DEBUG",
];

/** Snapshot `names`, returning a function that puts every value back. */
function snapshotEnv(names) {
  const saved = names.map((name) => [name, process.env[name]]);
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/** Clear `names` for the duration of a case; returns the restore function. */
function clearEnv(names) {
  const restore = snapshotEnv(names);
  for (const name of names) delete process.env[name];
  return restore;
}

const restoreManagedEnv = clearEnv(MANAGED_ENV);
// Stored API keys are AES-GCM encrypted with a key derived from this env var.
process.env.TELEGRAM_SESSION_ENCRYPTION_KEY = "llm-index-test-encryption-key";

after(restoreRequire);
after(restoreManagedEnv);
after(cleanupTempDirs);

/** A config store backed by its own temp file, so cases stay independent. */
function newConfigStore() {
  return new LlmConfigStore(tempFile("llm-config.json", "tg-llm-index-config-"));
}

/** A config store plus the path it persists to, for on-disk assertions. */
function newConfigStoreWithFile() {
  const file = tempFile("llm-config.json", "tg-llm-index-config-");
  return { file, store: new LlmConfigStore(file) };
}

/** A draft store plus the path it persists to, for backdating drafts. */
function newDraftStoreWithFile() {
  const file = tempFile("llm-drafts.json", "tg-llm-index-drafts-");
  return { file, store: new LlmDraftStore(file) };
}

/** Seed a config file directly, bypassing `setConnection` validation. */
function writeConfigFile(file, config) {
  writeFileSync(
    file,
    JSON.stringify(
      { version: 1, defaultsByOwner: {}, fallbackOrder: FREE_FALLBACK_ORDER, connections: [], ...config },
      null,
      2,
    ),
  );
}

/** A fully resolved connection row, as `LlmConfigStore` hands to the client. */
function connection(overrides = {}) {
  const provider = overrides.provider ?? "openai";
  const defaults = LLM_PROVIDER_DEFAULTS[provider];
  return {
    ownerId: "u1",
    provider,
    model: defaults.defaultModel || "test-model",
    enabled: true,
    useAsFallback: true,
    createdAt: 0,
    updatedAt: 0,
    displayName: defaults.displayName,
    protocol: defaults.protocol,
    effectiveApiKey: "secret-key",
    effectiveBaseUrl: "https://example.test/v1",
    keySource: "env",
    freeFallbackCandidate: !!defaults.freeFallbackCandidate,
    source: "env",
    ...overrides,
  };
}

/** A chat-completions body wrapped like an axios response. */
function chatResponse(content) {
  return { data: { choices: [{ message: { content } }] } };
}

/** A valid plan object the parser accepts. */
function planPayload(commands = ["trigger:limit --symbol BTC --side BUY --price 60000 --quantity 0.01"]) {
  return { summary: "ok", commands, riskNotes: [] };
}

/** Parse a single CLI trigger command and return its first trigger input. */
function cliInput(line, ctx = {}) {
  return parsePlanCommand(line, { format: "cli", ...ctx }).inputs[0];
}

/** Parse a single Telegram slash command and return its first trigger input. */
function slashInput(line, ctx = {}) {
  return parsePlanCommand(line, { format: "telegram", ...ctx }).inputs[0];
}

describe("redactedSecret", () => {
  it("reports a missing secret without inventing a mask", () => {
    assert.equal(redactedSecret(), "not set");
    assert.equal(redactedSecret(""), "not set");
  });

  it("never leaks a short secret it cannot partially mask", () => {
    const secret = "sk-12345";

    const redacted = redactedSecret(secret);

    assert.equal(redacted, "••••");
    assert.equal(redacted.includes(secret), false, "a short key must not be echoed back");
  });

  it("keeps only the first and last four characters of a long secret", () => {
    const secret = "sk-proj-abcdefghijklmnop-9999";

    const redacted = redactedSecret(secret);

    assert.equal(redacted, "sk-p…9999");
    assert.equal(redacted.includes("abcdefghijklmnop"), false, "the secret body must never survive redaction");
  });
});

describe("normalizeLlmProvider", () => {
  const aliases = [
    ["chatgpt", "openai"],
    ["GPT", "openai"],
    ["claude", "anthropic"],
    ["grok", "xai"],
    ["google", "gemini"],
    ["ovh", "ovhcloud"],
    ["ovh-cloud", "ovhcloud"],
    ["ovhcloud-ai", "ovhcloud"],
    ["hf", "huggingface"],
    ["pollinations-ai", "pollinations"],
    ["custom", "custom-openai"],
    ["openai-compatible", "custom-openai"],
    ["codex", "codex-oauth"],
    ["openai-codex", "codex-oauth"],
    ["chatgpt-pro", "codex-oauth"],
    ["chatgpt-codex", "codex-oauth"],
    ["gpt-pro", "codex-oauth"],
  ];

  for (const [alias, expected] of aliases) {
    it(`maps the ${alias} alias onto ${expected}`, () => {
      assert.equal(normalizeLlmProvider(alias), expected);
    });
  }

  it("accepts a canonical provider id unchanged", () => {
    assert.equal(normalizeLlmProvider(" OpenRouter "), "openrouter");
  });

  it("rejects a provider the bot cannot talk to", () => {
    assert.throws(() => normalizeLlmProvider("llama-farm"), /Unsupported LLM provider: llama-farm/);
  });
});

describe("parsePlanCommands input validation", () => {
  it("rejects a plan with no commands at all", () => {
    assert.throws(() => parsePlanCommands([], { format: "cli" }), /at least one command/);
  });

  it("rejects a non-array commands payload", () => {
    assert.throws(() => parsePlanCommands("trigger:limit", { format: "cli" }), /at least one command/);
  });

  it("rejects a plan longer than the twelve-command cap", () => {
    const line = "trigger:limit --symbol BTC --side BUY --price 60000 --quantity 0.01";
    // The cap is inclusive: twelve must parse, so thirteen is genuinely the limit.
    assert.equal(parsePlanCommands(Array(12).fill(line), { format: "cli" }).length, 12);

    assert.throws(() => parsePlanCommands(Array(13).fill(line), { format: "cli" }), /maximum is 12 commands/);
  });

  it("rejects a blank command line", () => {
    assert.throws(() => parsePlanCommands(["   "], { format: "cli" }), /Empty command line/);
  });

  it("rejects a command line that tokenizes to nothing", () => {
    assert.throws(() => parsePlanCommands(["''"], { format: "cli" }), /Empty command line/);
  });

  it("rejects a mark-priced command the way it rejects last and mid", () => {
    assert.throws(
      () => parsePlanCommands(["/limit BTC BUY mark 0.01"], { format: "telegram" }),
      /must not select last\/mid\/mark trigger sources/,
    );
  });

  it("rejects an unterminated quote instead of silently dropping the tail", () => {
    assert.throws(
      () => parsePlanCommands(['trigger:limit --symbol "BTC --side BUY --price 1 --quantity 1'], { format: "cli" }),
      /Unterminated quote in command/,
    );
  });
});

describe("parsePlanCommand line cleaning and routing", () => {
  it("strips a fenced code block around a CLI command", () => {
    const input = cliInput("```bash\ntrigger:limit --symbol BTC --side BUY --price 60000 --quantity 0.01");

    assert.equal(input.kind, "LIMIT");
    assert.equal(input.triggerPrice, 60000);
  });

  it("strips a markdown bullet prefix", () => {
    assert.equal(cliInput("- trigger:limit --symbol BTC --side BUY --price 60000 --quantity 0.01").quantity, 0.01);
  });

  it("skips prose before the trigger token", () => {
    assert.equal(
      cliInput("Then run trigger:limit --symbol BTC --side BUY --price 60000 --quantity 0.01").symbol,
      "BTC",
    );
  });

  it("routes a slash command to the Telegram parser even in cli format", () => {
    const action = parsePlanCommand("/limit BTC BUY 60000 0.01", { format: "cli" });

    assert.equal(action.inputs[0].kind, "LIMIT");
    assert.equal(action.inputs[0].quantity, 0.01);
  });

  it("routes a trigger command to the CLI parser in mixed format", () => {
    const action = parsePlanCommand("trigger:limit --symbol BTC --side BUY --price 60000 --quantity 0.01", {
      format: "mixed",
    });

    assert.equal(action.description, "limit trigger");
  });

  it("honours quoted and escaped tokens", () => {
    const input = cliInput('trigger:cancel-after --id "trg abc" --after 30m', { now: 1_000_000 });

    assert.equal(input.cancelTriggerId, "trg abc");
    assert.equal(input.triggerAt, 1_000_000 + 1_800_000);
  });

  it("keeps a trailing backslash rather than dropping it", () => {
    assert.equal(cliInput("trigger:cancel-after --after 30m --id abc\\", { now: 0 }).cancelTriggerId, "abc\\");
  });

  it("keeps a backslash-escaped space inside a single token", () => {
    assert.equal(cliInput("trigger:cancel-after --after 30m --id trg\\ 42", { now: 0 }).cancelTriggerId, "trg 42");
  });
});

describe("parsePlanCommands CLI option handling", () => {
  it("rejects an option the command does not support", () => {
    assert.throws(
      () => cliInput("trigger:limit --symbol BTC --side BUY --price 60000 --quantity 1 --leverage 10"),
      /Unsupported option for trigger:limit: --leverage/,
    );
  });

  it("rejects a stray positional token", () => {
    assert.throws(
      () => cliInput("trigger:limit --symbol BTC --side BUY --price 60000 --quantity 1 oops"),
      /Unexpected positional token in trigger:limit: oops/,
    );
  });

  it("rejects an unknown trigger command", () => {
    assert.throws(() => cliInput("trigger:teleport --symbol BTC"), /Unsupported CLI command: trigger:teleport/);
  });

  it("rejects a line whose first token is not a command at all", () => {
    assert.throws(() => cliInput("halt --symbol BTC"), /Unsupported CLI command: halt/);
  });

  it("accepts --option=value syntax", () => {
    const input = cliInput("trigger:limit --symbol=BTC --side=BUY --price=60000 --quantity=0.5");

    assert.equal(input.symbol, "BTC");
    assert.equal(input.quantity, 0.5);
  });

  it("reports the missing option by name", () => {
    assert.throws(() => cliInput("trigger:limit --side BUY --price 60000 --quantity 1"), /Missing --symbol/);
    assert.throws(() => cliInput("trigger:limit --symbol BTC --side BUY --quantity 1"), /Missing --price/);
  });

  it("treats a valueless option as absent for string options", () => {
    assert.throws(() => cliInput("trigger:limit --symbol BTC --side BUY --price --quantity 1"), /Missing --price/);
  });

  it("rejects a non-numeric price", () => {
    assert.throws(
      () => cliInput("trigger:limit --symbol BTC --side BUY --price abc --quantity 1"),
      /price must be a positive number/,
    );
  });

  it("rejects a zero or negative price", () => {
    assert.throws(
      () => cliInput("trigger:limit --symbol BTC --side BUY --price 0 --quantity 1"),
      /price must be a positive number/,
    );
    assert.throws(
      () => cliInput("trigger:limit --symbol BTC --side BUY --price -5 --quantity 1"),
      /price must be a positive number/,
    );
  });

  it("rejects a close percentage above one hundred", () => {
    assert.throws(
      () => cliInput("trigger:limit --symbol BTC --side BUY --price 60000 --close-percentage 150"),
      /close-percentage must be <= 100/,
    );
  });

  it("accepts a close percentage written with a percent sign", () => {
    assert.equal(
      cliInput("trigger:limit --symbol BTC --side BUY --price 60000 --close-percentage 25%").closePercentage,
      25,
    );
  });

  it("carries the reduce-only flag through to the trigger input", () => {
    const input = cliInput("trigger:limit --symbol BTC --side BUY --price 60000 --quantity 1 --reduce-only");

    assert.equal(input.reduceOnly, true);
  });

  it("treats an explicit --close-position false as not closing the position", () => {
    const input = cliInput("trigger:limit --symbol BTC --side BUY --price 60000 --quantity 1 --close-position false");

    assert.equal(input.closePosition, undefined);
    assert.equal(input.quantity, 1, "the explicit quantity must still satisfy the size requirement");
  });

  it("treats --reduce-only true as the flag being set", () => {
    assert.equal(
      cliInput("trigger:limit --symbol BTC --side BUY --price 60000 --quantity 1 --reduce-only true").reduceOnly,
      true,
    );
  });

  it("rejects a side the exchange does not accept", () => {
    assert.throws(
      () => cliInput("trigger:limit --symbol BTC --side SIDEWAYS --price 60000 --quantity 1"),
      /side must be BUY or SELL/,
    );
  });
});

describe("parsePlanCommands payment currency resolution", () => {
  let restoreEnv;

  before(() => {
    restoreEnv = clearEnv(["DEFAULT_PAYMENT_CURRENCY"]);
  });

  after(() => restoreEnv());

  const line = "trigger:limit --symbol BTC --side BUY --price 60000 --quantity 1";

  it("prefers an explicit --payment-currency over every default", () => {
    process.env.DEFAULT_PAYMENT_CURRENCY = "JPY";

    assert.equal(cliInput(`${line} --payment-currency EUR`, { defaultPaymentCurrency: "GBP" }).paymentCurrency, "EUR");
  });

  it("falls back to the caller-supplied default currency", () => {
    process.env.DEFAULT_PAYMENT_CURRENCY = "JPY";

    assert.equal(cliInput(line, { defaultPaymentCurrency: "GBP" }).paymentCurrency, "GBP");
  });

  it("falls back to DEFAULT_PAYMENT_CURRENCY when the caller supplies none", () => {
    process.env.DEFAULT_PAYMENT_CURRENCY = "JPY";

    assert.equal(cliInput(line).paymentCurrency, "JPY");
  });

  it("falls back to USD when nothing else is configured", () => {
    delete process.env.DEFAULT_PAYMENT_CURRENCY;

    assert.equal(cliInput(line).paymentCurrency, "USD");
  });
});

describe("parsePlanCommands CLI close-side resolution", () => {
  it("uses the explicit side when the command names one", () => {
    assert.equal(cliInput("trigger:take-profit --symbol BTC --side BUY --price 65000 --close-position").side, "BUY");
  });

  it("uses the remembered position side when no side is given", () => {
    const input = cliInput("trigger:take-profit --symbol BTC --price 65000 --close-position", {
      resolveCloseSide: (symbol) => (symbol === "BTC" ? "BUY" : undefined),
    });

    assert.equal(input.side, "BUY");
  });

  it("defaults to SELL when the position side is unknown", () => {
    const input = cliInput("trigger:take-profit --symbol BTC --price 65000 --close-position", {
      resolveCloseSide: () => undefined,
    });

    assert.equal(input.side, "SELL");
  });
});

describe("parsePlanCommands CLI command forms", () => {
  it("parses trigger:stop-limit with both stop and limit prices", () => {
    const input = cliInput("trigger:stop-limit --symbol BTC --side SELL --stop 58000 --limit 57950 --close-position");

    assert.equal(input.kind, "STOP_LIMIT");
    assert.equal(input.triggerPrice, 58000);
    assert.equal(input.limitPrice, 57950);
    assert.equal(input.closePosition, true);
  });

  it("parses trigger:stop-loss without an optional limit price", () => {
    const input = cliInput("trigger:stop-loss --symbol BTC --price 58000 --close-position");

    assert.equal(input.kind, "STOP_LOSS");
    assert.equal(input.limitPrice, undefined);
  });

  it("parses trigger:take-profit with an optional limit price", () => {
    const input = cliInput("trigger:take-profit --symbol BTC --price 65000 --limit 64900 --close-position");

    assert.equal(input.kind, "TAKE_PROFIT");
    assert.equal(input.limitPrice, 64900);
  });

  it("parses a percentage trail for trigger:trailing-stop", () => {
    const input = cliInput("trigger:trailing-stop --symbol BTC --trail 5% --close-position");

    assert.equal(input.kind, "TRAILING_STOP");
    assert.equal(input.trailMode, "PERCENT");
    assert.equal(input.trailValue, 5);
    assert.equal(input.limitOffset, undefined);
  });

  it("parses an absolute trail plus limit offset for trigger:trailing-stop-limit", () => {
    const input = cliInput("trigger:trailing-stop-limit --symbol BTC --trail 250 --limit-offset 50 --close-position");

    assert.equal(input.kind, "TRAILING_STOP_LIMIT");
    assert.equal(input.trailMode, "AMOUNT");
    assert.equal(input.trailValue, 250);
    assert.equal(input.limitOffset, 50);
  });

  it("pairs trigger:oco with a plain stop-loss when no stop limit is given", () => {
    const action = parsePlanCommand("trigger:oco --symbol BTC --take-profit 65000 --stop-loss 58000 --close-position", {
      format: "cli",
    });

    assert.equal(action.action, "oco");
    assert.equal(action.inputs[0].kind, "TAKE_PROFIT");
    assert.equal(action.inputs[1].kind, "STOP_LOSS");
    assert.equal(action.inputs[1].limitPrice, undefined);
  });

  it("parses trigger:bracket into a limit entry carrying bracket metadata", () => {
    const input = cliInput(
      "trigger:bracket --symbol BTC --side BUY --entry 60000 --quantity 0.01 --take-profit 65000 --stop-loss 58000 --stop-limit 57950 --exits-close-position",
    );

    assert.equal(input.kind, "LIMIT");
    assert.equal(input.triggerPrice, 60000);
    assert.deepEqual(input.meta.bracket, {
      takeProfitPrice: 65000,
      stopLossPrice: 58000,
      stopLimitPrice: 57950,
      useClosePosition: true,
    });
  });

  it("leaves the bracket stop-limit unset when the command omits it", () => {
    const input = cliInput(
      "trigger:bracket --symbol BTC --side BUY --entry 60000 --quantity 0.01 --take-profit 65000 --stop-loss 58000",
    );

    assert.equal(input.meta.bracket.stopLimitPrice, undefined);
    assert.equal(input.meta.bracket.useClosePosition, false);
  });

  it("marks trigger:scale-out as a reduce-only partial take-profit", () => {
    const input = cliInput("trigger:scale-out --symbol BTC --price 63000 --percent 25 --limit 62900");

    assert.equal(input.kind, "TAKE_PROFIT");
    assert.equal(input.closePercentage, 25);
    assert.equal(input.reduceOnly, true);
    assert.equal(input.limitPrice, 62900);
    assert.equal(input.meta.strategy, "SCALE_OUT");
  });

  it("parses trigger:break-even with an explicit lock-in offset", () => {
    const input = cliInput("trigger:break-even --symbol BTC --after 3% --plus 0.5% --close-position");

    assert.equal(input.kind, "BREAK_EVEN_STOP");
    assert.equal(input.activationMode, "PERCENT");
    assert.equal(input.activationValue, 3);
    assert.equal(input.lockMode, "PERCENT");
    assert.equal(input.lockValue, 0.5);
  });

  it("locks break-even at entry when --plus is omitted", () => {
    const input = cliInput("trigger:break-even --symbol BTC --after 3% --close-position");

    assert.equal(input.lockMode, "AMOUNT");
    assert.equal(input.lockValue, 0);
  });

  it("turns trigger:close-after into a reduce-only timed close", () => {
    const input = cliInput("trigger:close-after --symbol BTC --after 4h", { now: 1_000_000 });

    assert.equal(input.kind, "TIME_CLOSE");
    assert.equal(input.triggerAt, 1_000_000 + 4 * 3_600_000);
    assert.equal(input.closePosition, true);
    assert.equal(input.reduceOnly, true);
  });

  it("accepts an absolute timestamp for trigger:close-at", () => {
    const input = cliInput("trigger:close-at --symbol BTC --at 2099-01-01T00:00:00Z --limit 59000");

    assert.equal(input.triggerAt, Date.parse("2099-01-01T00:00:00Z"));
    assert.equal(input.limitPrice, 59000);
  });

  it("rejects a close-at timestamp in the past", () => {
    assert.throws(
      () => cliInput("trigger:close-at --symbol BTC --at 2000-01-01T00:00:00Z"),
      /time must be in the future/,
    );
  });

  it("builds trigger:cancel-after against the global pseudo-symbol", () => {
    const action = parsePlanCommand("trigger:cancel-after --id trg_42 --after 15m", { format: "cli", now: 0 });

    assert.deepEqual(action.symbols, []);
    assert.equal(action.inputs[0].kind, "TIME_CANCEL");
    assert.equal(action.inputs[0].symbol, "GLOBAL");
    assert.equal(action.inputs[0].cancelTriggerId, "trg_42");
    assert.equal(action.inputs[0].triggerAt, 900_000);
  });

  it("parses a breakout price band with an upper bound", () => {
    const input = cliInput("trigger:price-band --symbol BTC --side BUY --mode BREAKOUT --upper 65000 --quantity 0.01");

    assert.equal(input.kind, "PRICE_BAND");
    assert.equal(input.priceBandMode, "BREAKOUT");
    assert.equal(input.upperPrice, 65000);
    assert.equal(input.lowerPrice, undefined);
  });

  it("parses a reversion price band written with a hyphen", () => {
    const input = cliInput(
      "trigger:price-band --symbol BTC --side SELL --mode reversion --lower 55000 --quantity 0.01",
    );

    assert.equal(input.priceBandMode, "REVERSION");
    assert.equal(input.lowerPrice, 55000);
  });

  it("rejects a price-band mode the engine cannot evaluate", () => {
    assert.throws(
      () => cliInput("trigger:price-band --symbol BTC --side BUY --mode SIDEWAYS --upper 65000 --quantity 1"),
      /--mode must be BREAKOUT or REVERSION/,
    );
  });

  it("rejects a price band with neither bound", () => {
    assert.throws(
      () => cliInput("trigger:price-band --symbol BTC --side BUY --mode BREAKOUT --quantity 1"),
      /price-band requires --upper or --lower/,
    );
  });

  it("defaults trigger:risk-guard to an alert that does not size an order", () => {
    const input = cliInput("trigger:risk-guard --symbol BTC --metric MAX_RISK_USD --threshold 500");

    assert.equal(input.kind, "RISK_GUARD");
    assert.equal(input.riskAction, "ALERT");
    assert.equal(input.riskMetric, "MAX_RISK_USD");
    assert.equal(input.riskThreshold, 500);
    assert.equal(input.closePosition, undefined);
  });

  it("makes a close-position risk guard reduce-only", () => {
    const input = cliInput(
      "trigger:risk-guard --symbol BTC --metric max-drawdown-pct --threshold 10 --action close-position",
    );

    assert.equal(input.riskMetric, "MAX_DRAWDOWN_PCT");
    assert.equal(input.riskAction, "CLOSE_POSITION");
    assert.equal(input.closePosition, true);
    assert.equal(input.reduceOnly, true);
  });
});

describe("parsePlanCommands Telegram command forms", () => {
  it("rejects an unknown slash command", () => {
    assert.throws(() => slashInput("/teleport BTC"), /Unsupported Telegram command: teleport/);
  });

  it("rejects /limit with too few arguments", () => {
    assert.throws(
      () => slashInput("/limit BTC BUY 60000"),
      /\/limit requires symbol side price quantity\|close\|percent/,
    );
  });

  it("parses /stoplimit into a stop-limit trigger", () => {
    const input = slashInput("/stoplimit BTC SELL 58000 57950 close");

    assert.equal(input.kind, "STOP_LIMIT");
    assert.equal(input.triggerPrice, 58000);
    assert.equal(input.limitPrice, 57950);
    assert.equal(input.closePosition, true);
  });

  it("rejects /stoplimit with too few arguments", () => {
    assert.throws(() => slashInput("/stoplimit BTC SELL 58000 57950"), /\/stoplimit requires symbol side stop limit/);
  });

  it("parses /takeprofit and /stoploss into their matching kinds", () => {
    assert.equal(slashInput("/takeprofit BTC SELL 65000 close").kind, "TAKE_PROFIT");
    assert.equal(slashInput("/stoploss BTC SELL 58000 close").kind, "STOP_LOSS");
  });

  it("rejects /takeprofit with too few arguments", () => {
    assert.throws(() => slashInput("/takeprofit BTC SELL 65000"), /\/takeprofit requires symbol side price/);
  });

  it("parses /trailingstop with a percentage trail", () => {
    const input = slashInput("/trailingstop BTC SELL 5% close");

    assert.equal(input.kind, "TRAILING_STOP");
    assert.equal(input.trailMode, "PERCENT");
    assert.equal(input.trailValue, 5);
    assert.equal(input.limitOffset, undefined);
    assert.equal(input.closePosition, true);
  });

  it("parses /trailingstoplimit with a trail and a limit offset", () => {
    const input = slashInput("/trailingstoplimit BTC SELL 5% 50 0.25");

    assert.equal(input.kind, "TRAILING_STOP_LIMIT");
    assert.equal(input.limitOffset, 50);
    assert.equal(input.quantity, 0.25);
  });

  it("rejects /trailingstoplimit missing its offset argument", () => {
    assert.throws(
      () => slashInput("/trailingstoplimit BTC SELL 5% 50"),
      /\/trailingstoplimit requires symbol side trail offset/,
    );
  });

  it("pairs /oco with a plain stop-loss when no stop limit is supplied", () => {
    const action = parsePlanCommand("/oco BTC SELL 65000 58000 close", { format: "telegram" });

    assert.equal(action.inputs[1].kind, "STOP_LOSS");
    assert.equal(action.inputs[1].limitPrice, undefined);
  });

  it("rejects /oco with too few arguments", () => {
    assert.throws(() => slashInput("/oco BTC SELL 65000 58000"), /\/oco requires symbol side takeProfit stopLoss/);
  });

  it("parses /bracket with an optional stop limit", () => {
    const input = slashInput("/bracket BTC BUY 60000 0.01 65000 58000 57950");

    assert.equal(input.quantity, 0.01);
    assert.deepEqual(input.meta.bracket, { takeProfitPrice: 65000, stopLossPrice: 58000, stopLimitPrice: 57950 });
  });

  it("leaves the /bracket stop limit unset when omitted", () => {
    assert.equal(slashInput("/bracket BTC BUY 60000 0.01 65000 58000").meta.bracket.stopLimitPrice, undefined);
  });

  it("rejects /bracket with too few arguments", () => {
    assert.throws(
      () => slashInput("/bracket BTC BUY 60000 0.01 65000"),
      /\/bracket requires symbol side entry quantity/,
    );
  });

  it("parses /scaleout as a reduce-only partial exit", () => {
    const input = slashInput("/scaleout BTC SELL 63000 25%");

    assert.equal(input.closePercentage, 25);
    assert.equal(input.reduceOnly, true);
    assert.equal(input.meta.strategy, "SCALE_OUT");
  });

  it("rejects /scaleout with too few arguments", () => {
    assert.throws(() => slashInput("/scaleout BTC SELL 63000"), /\/scaleout requires symbol side price percent/);
  });

  it("parses /breakeven with and without a lock-in offset", () => {
    const withPlus = slashInput("/breakeven BTC SELL 3% 0.5%");
    const withoutPlus = slashInput("/breakeven BTC SELL 3%");

    assert.equal(withPlus.lockMode, "PERCENT");
    assert.equal(withPlus.lockValue, 0.5);
    assert.equal(withoutPlus.lockMode, "AMOUNT");
    assert.equal(withoutPlus.lockValue, 0);
    assert.equal(withoutPlus.closePosition, true);
  });

  it("rejects /breakeven with too few arguments", () => {
    assert.throws(() => slashInput("/breakeven BTC"), /\/breakeven requires symbol side after/);
  });

  it("parses /closeafter as a reduce-only timed close", () => {
    const input = slashInput("/closeafter BTC 4h", { now: 2_000_000 });

    assert.equal(input.kind, "TIME_CLOSE");
    assert.equal(input.triggerAt, 2_000_000 + 4 * 3_600_000);
    assert.equal(input.reduceOnly, true);
  });

  it("parses /closeat with an absolute timestamp", () => {
    assert.equal(slashInput("/closeat BTC 2099-06-01T12:00:00Z").triggerAt, Date.parse("2099-06-01T12:00:00Z"));
  });

  it("rejects /closeafter without a time argument", () => {
    assert.throws(() => slashInput("/closeafter BTC"), /\/closeafter requires symbol time/);
  });

  it("parses /cancelafter into a global time-cancel trigger", () => {
    const action = parsePlanCommand("/cancelafter trg_7 15m", { format: "telegram", now: 0 });

    assert.deepEqual(action.symbols, []);
    assert.equal(action.inputs[0].cancelTriggerId, "trg_7");
    assert.equal(action.inputs[0].triggerAt, 900_000);
  });

  it("rejects /cancelafter without a duration", () => {
    assert.throws(() => slashInput("/cancelafter trg_7"), /\/cancelafter requires trigger-id duration/);
  });

  it("assigns a BUY breakout band to the upper bound", () => {
    const input = slashInput("/priceband BTC BUY BREAKOUT 65000 0.01");

    assert.equal(input.upperPrice, 65000);
    assert.equal(input.lowerPrice, undefined);
  });

  it("assigns a SELL breakout band to the lower bound", () => {
    const input = slashInput("/priceband BTC SELL BREAKOUT 55000 0.01");

    assert.equal(input.lowerPrice, 55000);
    assert.equal(input.upperPrice, undefined);
  });

  it("assigns a SELL reversion band to the upper bound", () => {
    const input = slashInput("/priceband BTC SELL REVERSION 65000 0.01");

    assert.equal(input.upperPrice, 65000);
    assert.equal(input.lowerPrice, undefined);
  });

  it("rejects /priceband with too few arguments", () => {
    assert.throws(
      () => slashInput("/priceband BTC BUY BREAKOUT 65000"),
      /\/priceband requires symbol side mode bandPrice/,
    );
  });

  it("defaults /riskguard to an alert that does not close the position", () => {
    const input = slashInput("/riskguard BTC MAX_RISK_USD 500");

    assert.equal(input.riskAction, "ALERT");
    assert.equal(input.closePosition, false);
    assert.equal(input.reduceOnly, false);
  });

  it("makes a /riskguard close-position action reduce-only", () => {
    const input = slashInput("/riskguard BTC max-drawdown-pct 10 close-position");

    assert.equal(input.riskMetric, "MAX_DRAWDOWN_PCT");
    assert.equal(input.riskAction, "CLOSE_POSITION");
    assert.equal(input.closePosition, true);
    assert.equal(input.reduceOnly, true);
  });

  it("rejects /riskguard with too few arguments", () => {
    assert.throws(() => slashInput("/riskguard BTC MAX_RISK_USD"), /\/riskguard requires symbol metric threshold/);
  });

  it("parses /closelimit into a reduce-only closing limit", () => {
    const input = slashInput("/closelimit BTC 65000", { resolveCloseSide: () => "BUY" });

    assert.equal(input.kind, "LIMIT");
    assert.equal(input.side, "BUY");
    assert.equal(input.triggerPrice, 65000);
    assert.equal(input.closePosition, true);
    assert.equal(input.reduceOnly, true);
  });

  it("rejects /closelimit without a price", () => {
    assert.throws(() => slashInput("/closelimit BTC"), /\/closelimit requires symbol price/);
  });

  it("parses /closestoplimit into a reduce-only closing stop-limit", () => {
    const input = slashInput("/closestoplimit BTC 58000 57950");

    assert.equal(input.kind, "STOP_LIMIT");
    assert.equal(input.triggerPrice, 58000);
    assert.equal(input.limitPrice, 57950);
    assert.equal(input.closePosition, true);
  });

  it("rejects /closestoplimit without a limit price", () => {
    assert.throws(() => slashInput("/closestoplimit BTC 58000"), /\/closestoplimit requires symbol stop limit/);
  });
});

describe("parsePlanCommands Telegram sizing words", () => {
  const line = (size) => `/limit BTC BUY 60000 ${size}`;

  it("treats close, all and position as a full-position exit", () => {
    for (const word of ["close", "all", "position", "close-position"]) {
      assert.equal(slashInput(line(word)).closePosition, true, `${word} should close the position`);
    }
  });

  it("treats a percent suffix as a partial exit", () => {
    assert.equal(slashInput(line("25%")).closePercentage, 25);
  });

  it("rejects a percent above one hundred", () => {
    assert.throws(() => slashInput(line("150%")), /percent must be <= 100/);
  });

  it("treats a bare number as an explicit quantity", () => {
    assert.equal(slashInput(line("0.75")).quantity, 0.75);
  });

  it("rejects a size that is neither a keyword nor a number", () => {
    assert.throws(() => slashInput(line("some")), /quantity must be a positive number/);
  });
});

describe("LlmConfigStore and LlmDraftStore default locations", () => {
  let restoreEnv;

  before(() => {
    restoreEnv = snapshotEnv(["QUOTE_TRADE_STATE_DIR"]);
  });

  after(() => restoreEnv());

  it("persists both stores under QUOTE_TRADE_STATE_DIR when no path is given", () => {
    const dir = makeTempDir("tg-llm-index-state-");
    process.env.QUOTE_TRADE_STATE_DIR = dir;

    new LlmConfigStore().setConnection({ ownerId: "u1", provider: "groq", apiKey: "gsk-1234567890" });
    const draft = new LlmDraftStore().add({
      ownerId: "u1",
      prompt: "p",
      provider: "groq",
      model: "m",
      format: "cli",
      summary: "s",
      commands: ["x"],
      riskNotes: [],
    });

    assert.match(readFileSync(`${dir}/llm-config.json`, "utf8"), /"provider": "groq"/);
    assert.equal(new LlmDraftStore(`${dir}/llm-drafts.json`).get(draft.id, "u1").status, "PENDING");
  });
});

describe("LlmConfigStore setConnection", () => {
  it("stores every supported provider with its documented defaults", () => {
    const store = newConfigStore();

    for (const provider of Object.keys(LLM_PROVIDER_DEFAULTS)) {
      const defaults = LLM_PROVIDER_DEFAULTS[provider];
      store.setConnection({
        ownerId: "u1",
        provider,
        model: defaults.defaultModel || "custom-model",
        baseUrl: defaults.defaultBaseUrl || "https://custom.test/v1",
      });
    }

    const stored = store.listRows("u1").filter((row) => row.source !== "missing" || row.model !== "(set model)");
    for (const provider of Object.keys(LLM_PROVIDER_DEFAULTS)) {
      const row = stored.find((item) => item.provider === provider);
      assert.ok(row, `${provider} should be stored`);
      assert.equal(row.model, LLM_PROVIDER_DEFAULTS[provider].defaultModel || "custom-model");
    }
  });

  it("normalizes a provider alias before storing it", () => {
    const store = newConfigStore();

    const saved = store.setConnection({ ownerId: "u1", provider: "claude", apiKey: "sk-claude-abcdefgh" });

    assert.equal(saved.provider, "anthropic");
    assert.equal(saved.model, LLM_PROVIDER_DEFAULTS.anthropic.defaultModel);
    assert.equal(store.listRows("u1").filter((row) => row.provider === "anthropic").length, 1);
  });

  it("refuses a custom OpenAI-compatible endpoint without a base URL", () => {
    assert.throws(
      () => newConfigStore().setConnection({ ownerId: "u1", provider: "custom-openai", model: "my-model" }),
      /custom-openai requires --base-url/,
    );
  });

  it("refuses a connection with a blank model", () => {
    assert.throws(
      () => newConfigStore().setConnection({ ownerId: "u1", provider: "openai", model: "   " }),
      /openai requires a model/,
    );
  });

  it("strips a trailing slash from the base URL", () => {
    const store = newConfigStore();

    store.setConnection({
      ownerId: "u1",
      provider: "custom-openai",
      model: "m",
      baseUrl: "https://llm.test/v1/",
      apiKey: "k-1234567890",
    });

    assert.equal(store.resolveByProvider("u1", "custom-openai").effectiveBaseUrl, "https://llm.test/v1");
  });

  it("keeps the previous model when an update omits it", () => {
    const store = newConfigStore();
    store.setConnection({ ownerId: "u1", provider: "openai", model: "gpt-custom", apiKey: "k-1234567890" });

    store.setConnection({ ownerId: "u1", provider: "openai", enabled: false });

    const row = store.listRows("u1").find((item) => item.provider === "openai");
    assert.equal(row.model, "gpt-custom");
    assert.equal(row.enabled, false);
  });

  it("makes the first stored provider the owner default", () => {
    const store = newConfigStore();

    store.setConnection({ ownerId: "u1", provider: "groq", apiKey: "gsk-1234567890" });

    assert.equal(store.listRows("u1").find((row) => row.provider === "groq").default, true);
  });

  it("moves the default when a later connection asks for it", () => {
    const store = newConfigStore();
    store.setConnection({ ownerId: "u1", provider: "groq", apiKey: "gsk-1234567890" });
    assert.equal(
      store.listRows("u1").find((row) => row.provider === "groq").default,
      true,
      "groq must start as the default",
    );

    store.setConnection({ ownerId: "u1", provider: "openai", apiKey: "sk-1234567890", makeDefault: true });

    const rows = store.listRows("u1");
    assert.equal(rows.find((row) => row.provider === "openai").default, true);
    assert.equal(rows.find((row) => row.provider === "groq").default, false);
  });

  it("leaves the existing default alone when makeDefault is not set", () => {
    const store = newConfigStore();
    store.setConnection({ ownerId: "u1", provider: "groq", apiKey: "gsk-1234567890" });

    store.setConnection({ ownerId: "u1", provider: "openai", apiKey: "sk-1234567890" });

    assert.equal(store.listRows("u1").find((row) => row.provider === "groq").default, true);
  });

  it("marks free-tier providers as fallback candidates and paid ones not", () => {
    const store = newConfigStore();

    store.setConnection({ ownerId: "u1", provider: "gemini", apiKey: "gm-1234567890" });
    store.setConnection({ ownerId: "u1", provider: "openai", apiKey: "sk-1234567890" });

    const rows = store.listRows("u1");
    assert.equal(rows.find((row) => row.provider === "gemini").fallback, true);
    assert.equal(rows.find((row) => row.provider === "openai").fallback, false);
  });
});

describe("LlmConfigStore key resolution", () => {
  let restoreEnv;

  before(() => {
    restoreEnv = clearEnv(["OPENAI_API_KEY", "MY_OPENAI_KEY_ALIAS", "GEMINI_API_KEY", "GOOGLE_API_KEY"]);
  });

  after(() => restoreEnv());

  it("prefers a stored key over the provider env var", () => {
    process.env.OPENAI_API_KEY = "env-key-should-lose";
    const store = newConfigStore();
    store.setConnection({ ownerId: "u1", provider: "openai", apiKey: "sk-stored-1234567890" });

    const resolved = store.resolveByProvider("u1", "openai");

    assert.equal(resolved.effectiveApiKey, "sk-stored-1234567890");
    assert.equal(resolved.keySource, "stored");
  });

  it("drops the stored key when the connection is switched to an env var", () => {
    process.env.OPENAI_API_KEY = "env-default-key";
    process.env.MY_OPENAI_KEY_ALIAS = "aliased-env-key";
    const store = newConfigStore();
    store.setConnection({ ownerId: "u1", provider: "openai", apiKey: "sk-stored-1234567890" });
    assert.equal(
      store.resolveByProvider("u1", "openai").keySource,
      "stored",
      "the stored key must exist before it is replaced",
    );

    store.setConnection({ ownerId: "u1", provider: "openai", apiKeyEnv: "MY_OPENAI_KEY_ALIAS" });

    const resolved = store.resolveByProvider("u1", "openai");
    assert.equal(resolved.effectiveApiKey, "aliased-env-key");
    assert.equal(resolved.keySource, "env");
  });

  it("falls back to the alternate env var when the primary one is unset", () => {
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_API_KEY = "google-alternate-key";

    const resolved = newConfigStore().resolveByProvider("u1", "gemini");

    assert.equal(resolved.effectiveApiKey, "google-alternate-key");
    assert.equal(resolved.source, "env");
  });

  it("ignores a whitespace-only env key", () => {
    process.env.OPENAI_API_KEY = "   ";

    assert.equal(newConfigStore().resolveByProvider("u1", "openai"), undefined);
  });

  it("falls back to the env key when the stored ciphertext cannot be decrypted", () => {
    process.env.OPENAI_API_KEY = "env-rescue-key";
    const { file, store } = newConfigStoreWithFile();
    writeConfigFile(file, {
      connections: [
        { ownerId: "u1", provider: "openai", model: "gpt-4o-mini", apiKeyEncrypted: "v1:bad:bad:bad", enabled: true },
      ],
    });

    const resolved = store.resolveByProvider("u1", "openai");

    assert.equal(resolved.effectiveApiKey, "env-rescue-key", "a rotated encryption key must not lock the owner out");
    assert.equal(resolved.keySource, "env");
  });

  it("re-encrypts a legacy plaintext key on load", () => {
    const { file, store } = newConfigStoreWithFile();
    writeConfigFile(file, {
      connections: [
        { ownerId: "u1", provider: "openai", model: "gpt-4o-mini", apiKey: "sk-plaintext-secret-9999", enabled: true },
      ],
    });

    const resolved = store.resolveByProvider("u1", "openai");

    assert.equal(resolved.effectiveApiKey, "sk-plaintext-secret-9999");
    assert.equal(resolved.keySource, "stored");
    assert.equal(
      readFileSync(file, "utf8").includes("sk-plaintext-secret-9999"),
      false,
      "a plaintext key must be re-encrypted on disk",
    );
  });

  it("drops a stored connection whose provider is no longer supported", () => {
    const { file, store } = newConfigStoreWithFile();
    writeConfigFile(file, {
      connections: [
        { ownerId: "u1", provider: "llama-farm", model: "x", enabled: true },
        { ownerId: "u1", provider: "openai", model: "gpt-4o-mini", apiKey: "sk-good-1234567890", enabled: true },
      ],
    });

    const stored = store.listRows("u1").filter((row) => row.source === "stored");

    assert.deepEqual(
      stored.map((row) => row.provider),
      ["openai"],
    );
  });
});

describe("LlmConfigStore env-only connections", () => {
  let restoreEnv;

  before(() => {
    restoreEnv = clearEnv([
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_MODEL",
      "CUSTOM_LLM_API_KEY",
      "LLM_API_KEY",
      "CUSTOM_OPENAI_BASE_URL",
      "CUSTOM_OPENAI_MODEL",
      "CUSTOM_LLM_BASE_URL",
      "LLM_BASE_URL",
    ]);
  });

  after(() => restoreEnv());

  it("honours the provider-specific base URL and model env overrides", () => {
    process.env.OPENAI_API_KEY = "sk-env-1234567890";
    process.env.OPENAI_BASE_URL = "https://proxy.test/v1/";
    process.env.OPENAI_MODEL = "gpt-proxy";

    const resolved = newConfigStore().resolveByProvider("u1", "openai");

    assert.equal(resolved.effectiveBaseUrl, "https://proxy.test/v1");
    assert.equal(resolved.model, "gpt-proxy");
    assert.equal(resolved.source, "env");
  });

  it("accepts a generic LLM base URL for the custom provider", () => {
    process.env.CUSTOM_LLM_API_KEY = "custom-key-1234";
    process.env.LLM_BASE_URL = "https://generic.test/v1";
    process.env.CUSTOM_OPENAI_MODEL = "generic-model";

    const resolved = newConfigStore().resolveByProvider("u1", "custom-openai");

    assert.equal(resolved.effectiveBaseUrl, "https://generic.test/v1");
    assert.equal(resolved.model, "generic-model");
  });

  it("refuses to invent a custom endpoint that has no model or base URL", () => {
    process.env.CUSTOM_LLM_API_KEY = "custom-key-1234";
    // Positive control: the same provider resolves once a base URL and model exist.
    process.env.LLM_BASE_URL = "https://generic.test/v1";
    process.env.CUSTOM_OPENAI_MODEL = "generic-model";
    assert.ok(
      newConfigStore().resolveByProvider("u1", "custom-openai"),
      "a fully configured custom endpoint must resolve",
    );

    delete process.env.CUSTOM_OPENAI_MODEL;

    assert.equal(newConfigStore().resolveByProvider("u1", "custom-openai"), undefined);
  });
});

describe("LlmConfigStore owner isolation", () => {
  let restoreEnv;
  let store;

  before(() => {
    restoreEnv = clearEnv(["OPENAI_API_KEY", "GROQ_API_KEY"]);
    store = newConfigStore();
    store.setConnection({ ownerId: "ownerA", provider: "openai", apiKey: "sk-owner-a-1234567890", makeDefault: true });
    store.setConnection({ ownerId: "ownerB", provider: "groq", apiKey: "gsk-owner-b-1234567890", makeDefault: true });
  });

  after(() => restoreEnv());

  it("shows each owner only their own stored connection", () => {
    const a = store.listRows("ownerA").filter((row) => row.source === "stored");
    const b = store.listRows("ownerB").filter((row) => row.source === "stored");

    assert.deepEqual(
      a.map((row) => row.provider),
      ["openai"],
    );
    assert.deepEqual(
      b.map((row) => row.provider),
      ["groq"],
    );
  });

  it("keeps each owner default private to that owner", () => {
    assert.equal(store.listRows("ownerA").find((row) => row.provider === "openai").default, true);
    assert.equal(store.listRows("ownerB").find((row) => row.provider === "openai").default, false);
  });

  it("does not let one owner resolve another owner key", () => {
    assert.ok(store.resolveByProvider("ownerB", "groq"), "owner B's own groq key must resolve");

    assert.equal(store.resolveByProvider("ownerA", "groq"), undefined, "owner A must not inherit owner B's groq key");
  });

  it("plans for an unknown owner without borrowing a configured key", () => {
    const providers = store.resolvePlanConnections("ownerC").map((item) => item.provider);

    assert.equal(providers.includes("openai"), false);
    assert.equal(providers.includes("groq"), false);
    assert.deepEqual(providers, ["ovhcloud"], "only the keyless free tier is available to a brand new owner");
  });
});

describe("LlmConfigStore resolvePlanConnections ordering", () => {
  let restoreEnv;

  before(() => {
    restoreEnv = clearEnv([
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "XAI_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GROQ_API_KEY",
      "OVHCLOUD_API_KEY",
      "AI_ENDPOINT_API_KEY",
    ]);
  });

  after(() => restoreEnv());

  it("puts the owner default first and the free tier behind it", () => {
    const store = newConfigStore();
    store.setConnection({ ownerId: "u1", provider: "openai", apiKey: "sk-1234567890", makeDefault: true });

    const providers = store.resolvePlanConnections("u1").map((item) => item.provider);

    assert.equal(providers[0], "openai");
    assert.equal(providers.includes("ovhcloud"), true);
    assert.ok(providers.indexOf("ovhcloud") > 0);
  });

  it("restricts planning to the default when fallback is disabled", () => {
    const store = newConfigStore();
    store.setConnection({ ownerId: "u1", provider: "openai", apiKey: "sk-1234567890", makeDefault: true });
    assert.ok(store.resolvePlanConnections("u1").length > 1, "fallback must widen the list before it is disabled");

    assert.deepEqual(
      store.resolvePlanConnections("u1", undefined, false).map((item) => item.provider),
      ["openai"],
    );
  });

  it("honours an explicitly requested provider alias", () => {
    const store = newConfigStore();
    store.setConnection({ ownerId: "u1", provider: "openai", apiKey: "sk-1234567890", makeDefault: true });
    store.setConnection({ ownerId: "u1", provider: "anthropic", apiKey: "sk-ant-1234567890" });

    assert.deepEqual(
      store.resolvePlanConnections("u1", "claude", false).map((item) => item.provider),
      ["anthropic"],
    );
  });

  it("appends owner connections that opted into fallback after the free tier", () => {
    const store = newConfigStore();
    store.setConnection({ ownerId: "u1", provider: "ovhcloud", apiKey: "ovh-1234567890", makeDefault: true });
    store.setConnection({ ownerId: "u1", provider: "xai", apiKey: "xai-1234567890", useAsFallback: true });

    const providers = store.resolvePlanConnections("u1").map((item) => item.provider);

    assert.equal(providers[0], "ovhcloud");
    assert.equal(providers[providers.length - 1], "xai", "an opted-in paid provider is tried last");
  });

  it("skips a disabled connection but keeps planning with the rest", () => {
    const store = newConfigStore();
    store.setConnection({ ownerId: "u1", provider: "groq", apiKey: "gsk-1234567890", makeDefault: true });
    assert.equal(store.resolvePlanConnections("u1")[0].provider, "groq", "groq must be usable before it is disabled");

    store.setConnection({ ownerId: "u1", provider: "groq", enabled: false });

    assert.equal(
      store.resolvePlanConnections("u1").some((item) => item.provider === "groq"),
      false,
    );
  });

  it("uses a custom fallback order stored in the config file", () => {
    const restore = snapshotEnv(["GEMINI_API_KEY"]);
    process.env.GEMINI_API_KEY = "gm-1234567890";
    const { file, store } = newConfigStoreWithFile();
    writeConfigFile(file, { fallbackOrder: ["gemini", "ovhcloud"] });

    try {
      assert.deepEqual(
        store.resolvePlanConnections("u1").map((item) => item.provider),
        ["gemini", "ovhcloud"],
      );
    } finally {
      restore();
    }
  });

  it("falls back to the built-in provider order when nothing is configured", () => {
    // No default and no fallback pass leaves the order empty, so the built-in
    // list is the only thing that can produce a usable connection.
    const providers = newConfigStore()
      .resolvePlanConnections("u1", undefined, false)
      .map((item) => item.provider);

    assert.deepEqual(providers, ["ovhcloud"]);
  });
});

describe("LlmConfigStore Codex OAuth rows", () => {
  after(() => codexSessions.clear());

  it("reports a disconnected Codex provider as needing /codexconnect", () => {
    codexSessions.clear();

    const row = newConfigStore()
      .listRows("u1")
      .find((item) => item.provider === "codex-oauth");

    assert.equal(row.key, "run /codexconnect");
    assert.equal(row.source, "missing");
    assert.equal(row.enabled, false);
  });

  it("reports a connected Codex provider as an OAuth source", () => {
    codexSessions.add("u1");

    const row = newConfigStore()
      .listRows("u1")
      .find((item) => item.provider === "codex-oauth");

    assert.equal(row.key, "oauth:connected");
    assert.equal(row.source, "oauth");
    assert.equal(row.enabled, true);
  });

  it("reports a stored Codex connection through the same OAuth status", () => {
    codexSessions.add("u1");
    const store = newConfigStore();
    store.setConnection({ ownerId: "u1", provider: "codex" });

    const row = store.listRows("u1").find((item) => item.provider === "codex-oauth");

    assert.equal(row.source, "oauth");
    assert.equal(store.resolveByProvider("u1", "codex-oauth").source, "oauth");
  });

  it("only plans with Codex once the owner has signed in", () => {
    codexSessions.clear();
    const store = newConfigStore();
    assert.deepEqual(store.resolvePlanConnections("u1", "codex-oauth", false), []);

    codexSessions.add("u1");

    const resolved = store.resolvePlanConnections("u1", "codex-oauth", false);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].protocol, "codex-exec");
  });

  it("takes the Codex model from CODEX_MODEL when set", () => {
    codexSessions.add("u1");
    const restore = snapshotEnv(["CODEX_MODEL"]);
    process.env.CODEX_MODEL = "gpt-5-codex";

    try {
      assert.equal(newConfigStore().resolvePlanConnections("u1", "codex-oauth", false)[0].model, "gpt-5-codex");
    } finally {
      restore();
    }
  });

  it("keeps another owner signed out when one owner connects Codex", () => {
    codexSessions.clear();
    codexSessions.add("ownerA");
    const store = newConfigStore();
    assert.equal(store.resolvePlanConnections("ownerA", "codex-oauth", false).length, 1, "owner A is signed in");

    assert.deepEqual(store.resolvePlanConnections("ownerB", "codex-oauth", false), []);
  });
});

describe("LlmConfigStore listRows shapes", () => {
  let restoreEnv;

  before(() => {
    restoreEnv = clearEnv(["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OVHCLOUD_API_KEY", "AI_ENDPOINT_API_KEY"]);
  });

  after(() => restoreEnv());

  it("redacts a stored key and names its source", () => {
    const store = newConfigStore();
    store.setConnection({ ownerId: "u1", provider: "openai", apiKey: "sk-abcd-secret-body-wxyz" });

    const row = store.listRows("u1").find((item) => item.provider === "openai");

    assert.equal(row.key, "stored:sk-a…wxyz");
    assert.equal(row.source, "stored");
    assert.equal(row.enabled, true);
    assert.equal(row.key.includes("secret-body"), false);
  });

  it("redacts an env key discovered without any stored connection", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret-body-1234";

    const row = newConfigStore()
      .listRows("u1")
      .find((item) => item.provider === "anthropic");

    assert.equal(row.key, "env:sk-a…1234");
    assert.equal(row.source, "env");
  });

  it("names the env vars a missing provider could use", () => {
    const row = newConfigStore()
      .listRows("u1")
      .find((item) => item.provider === "huggingface");

    assert.equal(row.key, "env:HF_TOKEN|HUGGINGFACE_API_KEY not set");
    assert.equal(row.source, "missing");
    assert.equal(row.enabled, false);
  });

  it("shows the custom provider placeholders until it is configured", () => {
    const row = newConfigStore()
      .listRows("u1")
      .find((item) => item.provider === "custom-openai");

    assert.equal(row.model, "(set model)");
    assert.equal(row.baseUrl, "(set base URL)");
  });

  it("keeps a keyless stored provider that needs no key enabled", () => {
    const store = newConfigStore();
    store.setConnection({ ownerId: "u1", provider: "ovhcloud" });

    const row = store.listRows("u1").find((item) => item.provider === "ovhcloud");

    assert.equal(row.key, "anonymous/free-tier");
    assert.equal(row.source, "anonymous");
    assert.equal(row.enabled, true);
  });

  it("shows a keyed OVHcloud connection as an env source rather than anonymous", () => {
    process.env.OVHCLOUD_API_KEY = "ovh-secret-body-4321";

    const row = newConfigStore()
      .listRows("u1")
      .find((item) => item.provider === "ovhcloud");

    assert.equal(row.source, "env");
    assert.equal(row.key, "env:ovh-…4321");
  });

  it("marks a stored provider missing when its key disappears", () => {
    const store = newConfigStore();
    store.setConnection({ ownerId: "u1", provider: "openai", apiKeyEnv: "OPENAI_API_KEY" });

    const row = store.listRows("u1").find((item) => item.provider === "openai");

    assert.equal(row.key, "missing");
    assert.equal(row.source, "missing");
    assert.equal(row.enabled, false);
  });
});

describe("formatLlmProviderRows", () => {
  it("explains that nothing is configured when there are no rows", () => {
    assert.equal(formatLlmProviderRows([]), "No LLM providers configured.");
  });

  it("marks the default row and flags fallback candidates", () => {
    const text = formatLlmProviderRows([
      {
        provider: "openai",
        displayName: "OpenAI",
        model: "gpt-4o-mini",
        baseUrl: "u",
        key: "stored:ab…cd",
        source: "stored",
        enabled: true,
        default: true,
        fallback: false,
      },
      {
        provider: "ovhcloud",
        displayName: "OVH",
        model: "llama",
        baseUrl: "u",
        key: "anonymous/free-tier",
        source: "anonymous",
        enabled: false,
        default: false,
        fallback: true,
      },
    ]);

    const [first, second] = text.split("\n");
    assert.match(first, /^\* openai {8}enabled model=gpt-4o-mini key=stored:ab…cd$/);
    assert.match(second, /^ {2}ovhcloud {6}missing model=llama key=anonymous\/free-tier fallback$/);
  });
});

describe("LlmProviderClient protocols", () => {
  it("asks OpenAI for a strict JSON schema response", async () => {
    let captured;
    const client = new LlmProviderClient(async (url, body, options) => {
      captured = { url, body, options };
      return chatResponse(JSON.stringify(planPayload()));
    });

    await client.completePlan(connection({ provider: "openai" }), { systemPrompt: "s", userPrompt: "u" });

    assert.equal(captured.url, "https://example.test/v1/chat/completions");
    assert.equal(captured.body.response_format.type, "json_schema");
    assert.equal(captured.body.response_format.json_schema.strict, true);
    assert.equal(captured.body.temperature, 0.1);
    assert.equal(captured.body.max_tokens, 1400);
    assert.equal(captured.options.headers["X-Title"], undefined);
  });

  it("falls back to plain JSON mode for providers without schema support", async () => {
    let captured;
    const client = new LlmProviderClient(async (_url, body) => {
      captured = body;
      return chatResponse(JSON.stringify(planPayload()));
    });

    await client.completePlan(connection({ provider: "groq" }), { systemPrompt: "s", userPrompt: "u" });

    assert.deepEqual(captured.response_format, { type: "json_object" });
  });

  it("identifies the bot to OpenRouter", async () => {
    let captured;
    const client = new LlmProviderClient(async (_url, _body, options) => {
      captured = options;
      return chatResponse(JSON.stringify(planPayload()));
    });

    await client.completePlan(connection({ provider: "openrouter" }), { systemPrompt: "s", userPrompt: "u" });

    assert.equal(captured.headers["X-Title"], "Quote.Trade local strategy planner");
  });

  it("forwards an explicit temperature and token budget", async () => {
    let captured;
    const client = new LlmProviderClient(async (_url, body) => {
      captured = body;
      return chatResponse(JSON.stringify(planPayload()));
    });

    await client.completePlan(connection(), { systemPrompt: "s", userPrompt: "u", temperature: 0.7, maxTokens: 200 });

    assert.equal(captured.temperature, 0.7);
    assert.equal(captured.max_tokens, 200);
  });

  it("reads an Anthropic plan out of the tool-use block", async () => {
    let captured;
    const client = new LlmProviderClient(async (url, body, options) => {
      captured = { url, body, options };
      return {
        data: {
          content: [
            { type: "tool_use", name: "propose_order_plan", input: planPayload(["/limit BTC BUY 60000 0.01"]) },
          ],
        },
      };
    });

    const plan = await client.completePlan(connection({ provider: "anthropic" }), {
      systemPrompt: "s",
      userPrompt: "u",
    });

    assert.equal(captured.url, "https://example.test/v1/messages");
    assert.equal(captured.options.headers["x-api-key"], "secret-key");
    assert.equal(captured.options.headers["anthropic-version"], "2023-06-01");
    assert.equal(captured.body.tool_choice.name, "propose_order_plan");
    assert.deepEqual(plan.commands, ["/limit BTC BUY 60000 0.01"]);
  });

  it("reads an Anthropic plan out of plain text when no tool was used", async () => {
    const client = new LlmProviderClient(async () => ({
      data: { content: [{ type: "text", text: JSON.stringify(planPayload(["/closelimit BTC 65000"])) }] },
    }));

    const plan = await client.completePlan(connection({ provider: "anthropic" }), {
      systemPrompt: "s",
      userPrompt: "u",
    });

    assert.deepEqual(plan.commands, ["/closelimit BTC 65000"]);
  });

  it("passes an Anthropic body through untouched when content is not a block list", async () => {
    const body = { content: { note: "unexpected shape" }, summary: "ok" };
    const client = new LlmProviderClient(async () => ({ data: body }));

    const plan = await client.completePlan(connection({ provider: "anthropic" }), {
      systemPrompt: "s",
      userPrompt: "u",
    });

    assert.deepEqual(plan, body, "an unrecognised Anthropic shape is surfaced rather than thrown away");
  });

  it("passes the Gemini key in the query string and joins the response parts", async () => {
    let captured;
    const client = new LlmProviderClient(async (url, body) => {
      captured = { url, body };
      return {
        data: {
          candidates: [
            { content: { parts: [{ text: '{"summary":"ok",' }, { text: '"commands":[],"riskNotes":[]}' }] } },
          ],
        },
      };
    });

    const plan = await client.completePlan(
      connection({ provider: "gemini", model: "gemini-2.5-flash", effectiveApiKey: "gm key/1" }),
      { systemPrompt: "s", userPrompt: "u" },
    );

    assert.equal(captured.url, "https://example.test/v1/models/gemini-2.5-flash:generateContent?key=gm%20key%2F1");
    assert.equal(captured.body.generationConfig.responseMimeType, "application/json");
    assert.deepEqual(plan.commands, []);
  });

  it("delegates a Codex connection to the OAuth planner instead of HTTP", async () => {
    codexPlanCalls.length = 0;
    codexPlanResult = planPayload(["/closelimit BTC 65000"]);
    const client = new LlmProviderClient(async () => {
      throw new Error("codex must not use the HTTP transport");
    });

    const plan = await client.completePlan(
      connection({ provider: "codex-oauth", ownerId: "u9", model: "gpt-5-codex", effectiveApiKey: undefined }),
      { systemPrompt: "s", userPrompt: "u" },
    );

    assert.equal(codexPlanCalls.length, 1);
    assert.equal(codexPlanCalls[0].ownerId, "u9");
    assert.equal(codexPlanCalls[0].model, "gpt-5-codex");
    assert.deepEqual(plan.commands, ["/closelimit BTC 65000"]);
  });
});

describe("LlmProviderClient default transport", () => {
  it("posts through axios when no transport is injected", async () => {
    axiosCalls.length = 0;
    axiosResult = chatResponse(JSON.stringify(planPayload(["/closelimit BTC 65000"])));

    const plan = await new LlmProviderClient().completePlan(connection({ provider: "groq" }), {
      systemPrompt: "s",
      userPrompt: "u",
    });

    assert.equal(axiosCalls.length, 1, "the default client must reach the HTTP layer");
    assert.equal(axiosCalls[0].url, "https://example.test/v1/chat/completions");
    assert.equal(axiosCalls[0].options.timeout, 45_000);
    assert.deepEqual(plan.commands, ["/closelimit BTC 65000"]);
  });
});

describe("LlmProviderClient error handling", () => {
  it("refuses to call a provider that still needs an API key", async () => {
    const client = new LlmProviderClient(async () => {
      throw new Error("transport must not be reached");
    });

    await assert.rejects(
      () =>
        client.completePlan(connection({ provider: "openai", effectiveApiKey: undefined }), {
          systemPrompt: "s",
          userPrompt: "u",
        }),
      /openai API key is not configured/,
    );
  });

  it("propagates a non-2xx transport failure", async () => {
    const failure = Object.assign(new Error("Request failed with status code 429"), {
      response: { status: 429, data: { error: "rate limited" } },
    });
    const client = new LlmProviderClient(async () => {
      throw failure;
    });

    await assert.rejects(
      () => client.completePlan(connection(), { systemPrompt: "s", userPrompt: "u" }),
      /status code 429/,
    );
  });

  it("rejects a response with no choices at all", async () => {
    const client = new LlmProviderClient(async () => ({ data: {} }));

    await assert.rejects(
      () => client.completePlan(connection(), { systemPrompt: "s", userPrompt: "u" }),
      /LLM returned an empty response/,
    );
  });

  it("rejects a response whose content is not JSON", async () => {
    const client = new LlmProviderClient(async () => chatResponse("I refuse to answer."));

    await assert.rejects(
      () => client.completePlan(connection(), { systemPrompt: "s", userPrompt: "u" }),
      /LLM did not return a JSON object/,
    );
  });

  it("unwraps a fenced JSON block", async () => {
    const client = new LlmProviderClient(async () =>
      chatResponse('```json\n{"summary":"fenced","commands":[],"riskNotes":[]}\n```'),
    );

    const plan = await client.completePlan(connection(), { systemPrompt: "s", userPrompt: "u" });

    assert.equal(plan.summary, "fenced");
  });

  it("recovers a JSON object embedded in prose", async () => {
    const client = new LlmProviderClient(async () =>
      chatResponse('Sure! {"summary":"embedded","commands":[],"riskNotes":[]} Hope that helps.'),
    );

    const plan = await client.completePlan(connection(), { systemPrompt: "s", userPrompt: "u" });

    assert.equal(plan.summary, "embedded");
  });
});

describe("LlmStrategyPlanner", () => {
  /** A config store stub that records how the planner asked for connections. */
  function recordingStore(connections) {
    const calls = [];
    return {
      calls,
      resolvePlanConnections: (ownerId, provider, allowFallback) => {
        calls.push({ ownerId, provider, allowFallback });
        return connections;
      },
    };
  }

  it("explains that no provider is configured when nothing resolves", async () => {
    const planner = new LlmStrategyPlanner(recordingStore([]), { completePlan: async () => planPayload() });

    await assert.rejects(
      () => planner.plan({ prompt: "buy btc", commandFormat: "cli" }),
      /No LLM provider is configured/,
    );
  });

  it("asks for fallback connections by default and skips them when disabled", async () => {
    const store = recordingStore([connection()]);
    const planner = new LlmStrategyPlanner(store, { completePlan: async () => planPayload() });

    await planner.plan({ ownerId: "u1", prompt: "p", commandFormat: "cli" });
    await planner.plan({ ownerId: "u1", prompt: "p", commandFormat: "cli", provider: "openai", allowFallback: false });

    assert.deepEqual(store.calls[0], { ownerId: "u1", provider: undefined, allowFallback: true });
    assert.deepEqual(store.calls[1], { ownerId: "u1", provider: "openai", allowFallback: false });
  });

  it("reports every attempted provider when they all fail", async () => {
    const planner = new LlmStrategyPlanner(
      recordingStore([connection({ provider: "openai", model: "a" }), connection({ provider: "groq", model: "b" })]),
      {
        completePlan: async () => {
          throw new Error("upstream exploded");
        },
      },
    );

    await assert.rejects(
      () => planner.plan({ prompt: "p", commandFormat: "cli" }),
      (error) => {
        assert.match(error.message, /All configured LLM providers failed/);
        assert.match(error.message, /Attempted: openai:a, groq:b/);
        assert.match(error.message, /Last error: upstream exploded/);
        return true;
      },
    );
  });

  it("rejects a plan whose commands do not validate, even from the only provider", async () => {
    const planner = new LlmStrategyPlanner(recordingStore([connection({ provider: "openai", model: "only" })]), {
      completePlan: async () => planPayload(["trigger:teleport --symbol BTC"]),
    });

    await assert.rejects(
      () => planner.plan({ prompt: "p", commandFormat: "cli" }),
      /Attempted: openai:only.*Unsupported CLI command: trigger:teleport/s,
    );
  });

  it("returns an empty action list when the model declines to propose commands", async () => {
    const planner = new LlmStrategyPlanner(recordingStore([connection()]), {
      completePlan: async () => ({ summary: "too ambiguous", riskNotes: ["need a size"] }),
    });

    const plan = await planner.plan({ prompt: "do something", commandFormat: "cli" });

    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.commands, []);
    assert.deepEqual(plan.riskNotes, ["need a size"]);
    assert.equal(plan.summary, "too ambiguous");
  });

  it("supplies a default summary when the model omits one", async () => {
    const planner = new LlmStrategyPlanner(recordingStore([connection()]), {
      completePlan: async () => ({ commands: [], riskNotes: "not an array" }),
    });

    const plan = await planner.plan({ prompt: "p", commandFormat: "cli" });

    assert.equal(plan.summary, "Proposed local bot commands.");
    assert.deepEqual(plan.riskNotes, []);
  });

  it("prompts with Telegram examples for a Telegram-format plan", async () => {
    let captured;
    const planner = new LlmStrategyPlanner(recordingStore([connection()]), {
      completePlan: async (_connection, request) => {
        captured = request;
        return planPayload(["/limit BTC BUY 60000 0.01"]);
      },
    });

    await planner.plan({
      prompt: "buy the dip",
      commandFormat: "telegram",
      positionsContext: "BTC long 0.5",
      riskContext: "max risk 500",
    });

    assert.match(captured.systemPrompt, /exact Telegram slash-command strings/);
    assert.match(captured.userPrompt, /\/trailingstoplimit BTC SELL 5% 50 close/);
    assert.match(captured.userPrompt, /BTC long 0\.5/);
    assert.match(captured.userPrompt, /max risk 500/);
  });

  it("prompts with CLI examples and a placeholder when no position context exists", async () => {
    let captured;
    const planner = new LlmStrategyPlanner(recordingStore([connection()]), {
      completePlan: async (_connection, request) => {
        captured = request;
        return planPayload();
      },
    });

    await planner.plan({ prompt: "buy the dip", commandFormat: "cli" });

    assert.match(captured.systemPrompt, /exact CLI trigger-command strings/);
    assert.match(captured.userPrompt, /trigger:trailing-stop-limit --symbol BTC/);
    assert.match(captured.userPrompt, /No remembered positions provided\./);
  });

  it("logs the failing provider when LLM_DEBUG is on", async () => {
    const restoreEnv = snapshotEnv(["LLM_DEBUG"]);
    const originalLog = console.log;
    const logged = [];
    console.log = (...args) => logged.push(args);
    process.env.LLM_DEBUG = "true";

    try {
      const planner = new LlmStrategyPlanner(
        recordingStore([
          connection({ provider: "openai", model: "bad" }),
          connection({ provider: "groq", model: "good" }),
        ]),
        {
          completePlan: async (item) => {
            if (item.model === "bad")
              throw Object.assign(new Error("boom"), { response: { status: 500, data: "oops" } });
            return planPayload();
          },
        },
      );

      const plan = await planner.plan({ prompt: "p", commandFormat: "cli" });

      assert.equal(plan.provider, "groq");
      assert.equal(logged.length, 1);
      assert.equal(logged[0][0], "[LLM_PROVIDER_FAILED]");
      assert.deepEqual(logged[0][1], {
        provider: "openai",
        model: "bad",
        message: "boom",
        status: 500,
        responseData: "oops",
      });
    } finally {
      console.log = originalLog;
      restoreEnv();
    }
  });

  it("stays quiet about provider failures when LLM_DEBUG is off", async () => {
    const restoreEnv = snapshotEnv(["LLM_DEBUG"]);
    const originalLog = console.log;
    const logged = [];
    console.log = (...args) => logged.push(args);
    delete process.env.LLM_DEBUG;

    try {
      const planner = new LlmStrategyPlanner(
        recordingStore([
          connection({ provider: "openai", model: "bad" }),
          connection({ provider: "groq", model: "good" }),
        ]),
        {
          completePlan: async (item) => {
            if (item.model === "bad") throw new Error("boom");
            return planPayload();
          },
        },
      );

      // Precondition: the first provider really did fail, so silence is meaningful.
      const plan = await planner.plan({ prompt: "p", commandFormat: "cli" });
      assert.deepEqual(plan.attemptedProviders, ["openai:bad", "groq:good"]);

      assert.deepEqual(logged, []);
    } finally {
      console.log = originalLog;
      restoreEnv();
    }
  });

  it("threads the parse context through to the produced actions", async () => {
    const planner = new LlmStrategyPlanner(recordingStore([connection()]), {
      completePlan: async () => planPayload(["/closeafter BTC 4h"]),
    });

    const plan = await planner.plan({
      ownerId: "u7",
      prompt: "flatten later",
      commandFormat: "telegram",
      defaultPaymentCurrency: "EUR",
      resolveCloseSide: () => "BUY",
      now: 5_000_000,
    });

    const input = plan.actions[0].inputs[0];
    assert.equal(input.ownerId, "u7");
    assert.equal(input.paymentCurrency, "EUR");
    assert.equal(input.side, "BUY");
    assert.equal(input.triggerAt, 5_000_000 + 4 * 3_600_000);
  });
});

describe("LlmDraftStore lifecycle", () => {
  /** Add a simple pending draft for `ownerId`. */
  function addDraft(store, ownerId = "u1", commands = ["/limit BTC BUY 60000 0.01"]) {
    return store.add({
      ownerId,
      prompt: "p",
      provider: "openai",
      model: "m",
      format: "telegram",
      summary: "s",
      commands,
      riskNotes: [],
    });
  }

  /** Rewrite a stored draft's creation time so expiry can be exercised. */
  function backdate(file, id, createdAt) {
    const data = JSON.parse(readFileSync(file, "utf8"));
    data.drafts.find((draft) => draft.id === id).createdAt = createdAt;
    writeFileSync(file, JSON.stringify(data, null, 2));
  }

  it("normalizes commands and risk notes as it stores a draft", () => {
    const { store } = newDraftStoreWithFile();

    const draft = store.add({
      prompt: "p",
      provider: "openai",
      model: "m",
      format: "telegram",
      summary: "s",
      commands: ["  /closelimit BTC 65000  ", "", "   "],
      riskNotes: [42],
    });

    assert.equal(draft.ownerId, "default", "a draft without an owner belongs to the default owner");
    assert.deepEqual(draft.commands, ["/closelimit BTC 65000"]);
    assert.deepEqual(draft.riskNotes, ["42"]);
  });

  it("hides a draft from every owner but its own", () => {
    const { store } = newDraftStoreWithFile();
    const draft = addDraft(store, "ownerA");
    assert.ok(store.get(draft.id, "ownerA"), "owner A must be able to read their own draft");

    assert.equal(store.get(draft.id, "ownerB"), undefined);
  });

  it("refuses to claim another owner draft", () => {
    const { store } = newDraftStoreWithFile();
    const draft = addDraft(store, "ownerA");

    assert.throws(() => store.claimPending(draft.id, "ownerB"), new RegExp(`No LLM draft found: ${draft.id}`));
    assert.equal(store.get(draft.id, "ownerA").status, "PENDING", "owner A's draft must survive the failed claim");
  });

  it("refuses to claim a draft that does not exist", () => {
    assert.throws(
      () => newDraftStoreWithFile().store.claimPending("llm_missing", "u1"),
      /No LLM draft found: llm_missing/,
    );
  });

  it("refuses to claim a cancelled draft", () => {
    const { store } = newDraftStoreWithFile();
    const draft = addDraft(store);
    store.mark(draft.id, "CANCELLED", "u1");

    assert.throws(() => store.claimPending(draft.id, "u1"), new RegExp(`Draft ${draft.id} is CANCELLED, not PENDING`));
  });

  it("rejects an expired draft instead of confirming it late", () => {
    const { file, store } = newDraftStoreWithFile();
    const draft = addDraft(store);
    backdate(file, draft.id, Date.now() - 10_000);

    assert.throws(() => store.claimPending(draft.id, "u1", 1_000), /expired\. Re-run \/llmstrategy/);
    assert.equal(store.get(draft.id, "u1").status, "REJECTED", "an expired draft must be recorded as rejected");
  });

  it("still claims an old draft when no TTL is enforced", () => {
    const { file, store } = newDraftStoreWithFile();
    const draft = addDraft(store);
    backdate(file, draft.id, Date.now() - 10_000);

    assert.equal(store.claimPending(draft.id, "u1", 0).status, "CONFIRMING");
  });

  it("returns a detached copy from claimPending", () => {
    const { store } = newDraftStoreWithFile();
    const draft = addDraft(store);

    const claimed = store.claimPending(draft.id, "u1");
    claimed.commands.push("/closelimit BTC 1");

    assert.deepEqual(store.get(draft.id, "u1").commands, ["/limit BTC BUY 60000 0.01"]);
  });

  it("lists only pending drafts unless every status is requested", () => {
    const { store } = newDraftStoreWithFile();
    const pending = addDraft(store);
    const settled = addDraft(store);
    store.mark(settled.id, "CONFIRMED", "u1");

    assert.deepEqual(
      store.list("u1").map((draft) => draft.id),
      [pending.id],
    );
    assert.deepEqual(
      store
        .list("u1", true)
        .map((draft) => draft.id)
        .sort(),
      [pending.id, settled.id].sort(),
    );
  });

  it("lists drafts per owner", () => {
    const { store } = newDraftStoreWithFile();
    addDraft(store, "ownerA");
    const b = addDraft(store, "ownerB");

    assert.deepEqual(
      store.list("ownerB").map((draft) => draft.id),
      [b.id],
    );
  });

  it("refuses to mark a draft that does not exist", () => {
    assert.throws(
      () => newDraftStoreWithFile().store.mark("llm_missing", "CONFIRMED", "u1"),
      /No LLM draft found: llm_missing/,
    );
  });

  it("lets an already settled draft be re-marked", () => {
    const { store } = newDraftStoreWithFile();
    const draft = addDraft(store);
    store.mark(draft.id, "CONFIRMED", "u1");

    assert.equal(store.mark(draft.id, "CANCELLED", "u1").status, "CANCELLED");
    assert.equal(store.get(draft.id, "u1").status, "CANCELLED");
  });

  it("ignores a corrupt drafts payload rather than throwing", () => {
    const file = tempFile("llm-drafts.json", "tg-llm-index-drafts-");
    writeFileSync(file, JSON.stringify({ version: 1, drafts: "not an array" }));
    const store = new LlmDraftStore(file);

    assert.deepEqual(store.list("u1", true), []);
    assert.equal(
      store.add({
        ownerId: "u1",
        prompt: "p",
        provider: "o",
        model: "m",
        format: "cli",
        summary: "s",
        commands: ["x"],
        riskNotes: [],
      }).status,
      "PENDING",
    );
  });
});

describe("isLlmDraftExpired edge cases", () => {
  it("never expires a draft when no TTL is configured", () => {
    const draft = { createdAt: 1 };

    assert.equal(isLlmDraftExpired(draft, 0, 1_000_000), false);
    assert.equal(isLlmDraftExpired(draft, Number.NaN, 1_000_000), false);
  });

  it("treats a draft with an unusable creation time as expired", () => {
    assert.equal(isLlmDraftExpired({ createdAt: 0 }, 1000, 1000), true);
    assert.equal(isLlmDraftExpired({ createdAt: "nonsense" }, 1000, 1000), true);
  });
});

describe("formatDraft", () => {
  const base = {
    id: "llm_1",
    ownerId: "u1",
    prompt: "p",
    provider: "openai",
    model: "m",
    format: "telegram",
    status: "PENDING",
    createdAt: 0,
    updatedAt: 0,
  };

  it("numbers the proposed commands and lists risk notes", () => {
    const text = formatDraft({
      ...base,
      summary: "s",
      commands: ["/limit BTC BUY 1 1", "/closelimit BTC 2"],
      riskNotes: ["size it down"],
    });

    assert.match(text, /1\. \/limit BTC BUY 1 1\n2\. \/closelimit BTC 2/);
    assert.match(text, /Risk notes:\n- size it down/);
  });

  it("says so when the model proposed nothing executable", () => {
    const text = formatDraft({ ...base, summary: "s", commands: [], riskNotes: [] });

    assert.match(text, /No executable commands proposed\./);
    assert.equal(text.includes("Risk notes"), false);
  });
});

describe("formatDraftForTelegramHtml edge cases", () => {
  const base = {
    id: "llm_1",
    ownerId: "u1",
    prompt: "p",
    provider: "openai",
    model: "m",
    format: "telegram",
    status: "PENDING",
    createdAt: 0,
    updatedAt: 0,
  };

  it("numbers multiple orders and pluralises the header", () => {
    const html = formatDraftForTelegramHtml({
      ...base,
      summary: "s",
      commands: ["/limit BTC BUY 1 1", "/closelimit BTC 2"],
      riskNotes: [],
    });

    assert.match(html, /Proposed orders for review/);
    assert.match(html, /1\. <b>\/limit BTC BUY 1 1<\/b>\n2\. <b>\/closelimit BTC 2<\/b>/);
  });

  it("drops the order safety notes when there is nothing to confirm", () => {
    const html = formatDraftForTelegramHtml({ ...base, summary: "ambiguous", commands: [], riskNotes: [] });

    assert.match(html, /Strategy draft for review/);
    assert.match(html, /No executable commands proposed\./);
    assert.equal(html.includes("Before confirming"), false);
  });
});

describe("escapeTelegramHtml", () => {
  it("escapes the three characters Telegram HTML treats as markup", () => {
    assert.equal(escapeTelegramHtml("<b>a & b</b>"), "&lt;b&gt;a &amp; b&lt;/b&gt;");
  });

  it("renders a missing value as an empty string", () => {
    assert.equal(escapeTelegramHtml(undefined), "");
    assert.equal(escapeTelegramHtml(null), "");
  });
});

describe("formatDraftButtonLabel edge cases", () => {
  const draftStore = () => new LlmDraftStore(tempFile("llm-drafts.json", "tg-llm-index-drafts-"));

  /** Add a draft with the given telegram commands. */
  function draftWith(commands, summary = "summary") {
    return draftStore().add({
      ownerId: "u1",
      prompt: "p",
      provider: "openai",
      model: "m",
      format: "telegram",
      summary,
      commands,
      riskNotes: [],
    });
  }

  it("falls back to the summary when the commands do not parse", () => {
    const draft = draftWith(["/teleport BTC"], "Move BTC to the moon");

    assert.equal(formatDraftButtonLabel(draft), `📝 Move BTC to the moon ID:${draft.id}`);
  });

  it("scales a percentage exit by the cached position size", () => {
    const draft = draftWith(["/scaleout BTC SELL 63000 25%"]);

    assert.match(formatDraftButtonLabel(draft, { resolveCloseQuantity: () => 4 }), /BTC qty=1 ≈\$63k ID:/);
  });

  it("shows the raw percentage when no position size is cached", () => {
    const draft = draftWith(["/scaleout BTC SELL 63000 25%"]);

    assert.match(formatDraftButtonLabel(draft), /BTC qty=25% ID:/);
  });

  it("shows close when a full exit has no cached position size", () => {
    const draft = draftWith(["/takeprofit BTC SELL 65000 close"]);

    assert.match(formatDraftButtonLabel(draft), /BTC qty=close ID:/);
  });

  it("summarises the extra symbols of a multi-leg draft inside the button limit", () => {
    const draft = draftWith(["/limit BTC BUY 60000 0.01", "/limit ETH BUY 3000 0.1", "/limit SOL BUY 150 1"]);

    const label = formatDraftButtonLabel(draft);

    assert.match(label, /^📝 BTC\/ETH\+1 qty=0\.01\/0\.1 ≈\$1\.05k 3 order/);
    assert.ok(label.endsWith(` ID:${draft.id}`), "the draft id must survive truncation");
    assert.ok(label.length <= 64, `Telegram button labels cap at 64 characters, got ${label.length}`);
  });

  it("compacts a million-dollar notional", () => {
    const draft = draftWith(["/limit BTC BUY 1000000 2"]);

    assert.match(formatDraftButtonLabel(draft), /qty=2 ≈\$2m /);
  });

  it("labels a symbol-less trigger without inventing a quantity", () => {
    const draft = draftWith(["/cancelafter trg_1 30m"]);

    assert.equal(formatDraftButtonLabel(draft), `📝 Trigger qty=- ID:${draft.id}`);
  });
});
