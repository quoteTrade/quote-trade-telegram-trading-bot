"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { tempFile, cleanupTempDirs } = require("./helpers/tmp");
const {
  parsePlanCommands,
  LlmStrategyPlanner,
  LlmDraftStore,
  LlmConfigStore,
  LlmProviderClient,
  isLlmDraftExpired,
  formatDraftButtonLabel,
  formatDraftForTelegramHtml,
  confirmOrderButtonText,
} = require("../dist/llm");

after(cleanupTempDirs);

/**
 * Env vars that would turn the keyless OVHcloud free tier into a keyed `env`
 * connection. The anonymous cases below only mean something while they are
 * unset, so they clear them explicitly instead of trusting the ambient shell.
 */
const OVH_KEY_ENVS = ["OVHCLOUD_API_KEY", "AI_ENDPOINT_API_KEY"];

/** Clear the OVHcloud key env vars; returns a restore function. */
function clearOvhKeys() {
  const saved = new Map(OVH_KEY_ENVS.map((name) => [name, process.env[name]]));
  for (const name of OVH_KEY_ENVS) delete process.env[name];
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/**
 * Models a fully resolved LLM connection row: the shape `LlmConfigStore`
 * hands to the planner once a provider's key and base URL are known.
 */
function fakeConnection(provider, model) {
  return {
    ownerId: "default",
    provider,
    model,
    apiKeyEnv: "TEST_KEY",
    enabled: true,
    useAsFallback: true,
    createdAt: 0,
    updatedAt: 0,
    displayName: provider,
    protocol: "openai-chat",
    effectiveApiKey: "test",
    effectiveBaseUrl: "https://example.test/v1",
    keySource: "env",
    freeFallbackCandidate: false,
    source: "env",
  };
}

/** A config store backed by its own temp file, so cases stay independent. */
function newConfigStore() {
  return new LlmConfigStore(tempFile("llm-config.json", "tg-llm-config-"));
}

/** A draft store backed by its own temp file. */
function newDraftStore() {
  return new LlmDraftStore(tempFile("llm-drafts.json", "tg-llm-drafts-"));
}

/** The Telegram limit draft the formatting/expiry cases are built around. */
function addLimitDraft(store) {
  return store.add({
    ownerId: "u1",
    prompt: "x",
    provider: "openai",
    model: "m",
    format: "telegram",
    summary: "Use <carefully> & review",
    commands: ["/limit BTC BUY 60000 0.01"],
    riskNotes: ["Review before confirming & sizing"],
  });
}

/** A chat-completions body the planner accepts, wrapped like an HTTP response. */
function planResponse(commands) {
  return {
    data: {
      choices: [{ message: { content: JSON.stringify({ summary: "ok", commands, riskNotes: [] }) } }],
    },
  };
}

describe("parsePlanCommands", () => {
  it("parses CLI trigger:limit and trigger:oco commands into planned actions", () => {
    const cliActions = parsePlanCommands(
      [
        "trigger:limit --symbol BTC --side BUY --price 60000 --quantity 0.01",
        "trigger:oco --symbol BTC --side SELL --take-profit 65000 --stop-loss 58000 --stop-limit 57950 --close-position",
      ],
      { format: "cli", defaultPaymentCurrency: "USD" },
    );

    assert.equal(cliActions.length, 2);
    assert.equal(cliActions[0].inputs[0].kind, "LIMIT");
    assert.equal(cliActions[0].inputs[0].side, "BUY");
    assert.equal(cliActions[0].inputs[0].quantity, 0.01);
    assert.equal(cliActions[1].action, "oco");
    assert.equal(cliActions[1].inputs[1].kind, "STOP_LIMIT");
  });

  it("parses Telegram slash commands including the close-position OCO shorthand", () => {
    const tgActions = parsePlanCommands(["/limit BTC BUY 60000 0.01", "/oco BTC SELL 65000 58000 close 57950"], {
      format: "telegram",
      defaultPaymentCurrency: "USD",
    });

    assert.equal(tgActions[0].inputs[0].quantity, 0.01);
    assert.equal(tgActions[1].inputs[0].closePosition, true);
  });

  it("rejects a limit command that prices off a non-explicit source", () => {
    assert.throws(
      () =>
        parsePlanCommands(["trigger:limit --symbol BTC --side BUY --price 60000 --source last --quantity 0.01"], {
          format: "cli",
        }),
      /last\/mid\/mark|unsupported/i,
    );
  });

  it("rejects a limit command without an explicit size", () => {
    assert.throws(
      () => parsePlanCommands(["trigger:limit --symbol BTC --side BUY --price 60000"], { format: "cli" }),
      /explicit size/i,
    );
  });

  it("rejects an unsupported trigger:market command", () => {
    assert.throws(
      () => parsePlanCommands(["trigger:market --symbol BTC --side BUY --quantity 1"], { format: "cli" }),
      /Unsupported/i,
    );
  });
});

describe("LlmStrategyPlanner", () => {
  it("falls back to the next connection when the first model returns an unusable plan", async () => {
    let calls = 0;
    const planner = new LlmStrategyPlanner(
      {
        resolvePlanConnections: () => [fakeConnection("openai", "bad-model"), fakeConnection("gemini", "good-model")],
      },
      {
        completePlan: async (connection) => {
          calls += 1;
          if (connection.model === "bad-model") {
            // Missing an explicit size, so `parsePlanCommands` rejects it.
            return {
              summary: "bad",
              commands: ["trigger:limit --symbol BTC --side BUY --price 60000"],
              riskNotes: [],
            };
          }
          return {
            summary: "good",
            commands: ["trigger:limit --symbol BTC --side BUY --price 60000 --quantity 0.01"],
            riskNotes: ["review before confirming"],
          };
        },
      },
    );

    const plan = await planner.plan({
      prompt: "buy btc on pullback",
      commandFormat: "cli",
      defaultPaymentCurrency: "USD",
    });

    assert.equal(calls, 2);
    assert.equal(plan.provider, "gemini");
    assert.equal(plan.actions[0].inputs[0].triggerPrice, 60000);
  });
});

describe("LlmConfigStore anonymous free tier", () => {
  let restoreEnv;

  before(() => {
    restoreEnv = clearOvhKeys();
  });

  after(() => restoreEnv());

  it("lists the keyless ovhcloud row as an enabled anonymous provider", () => {
    const rows = newConfigStore().listRows("default");
    const ovhRow = rows.find((row) => row.provider === "ovhcloud");

    assert.equal(ovhRow.enabled, true);
    assert.equal(ovhRow.source, "anonymous");
    assert.match(ovhRow.key, /anonymous/);
  });

  it("resolves the keyless ovhcloud connection as the first planning candidate", () => {
    const connections = newConfigStore().resolvePlanConnections("default");

    assert.equal(connections[0].provider, "ovhcloud");
    assert.equal(connections[0].effectiveApiKey, undefined);
    assert.equal(connections[0].source, "anonymous");
  });
});

describe("LlmProviderClient", () => {
  let restoreEnv;

  before(() => {
    restoreEnv = clearOvhKeys();
  });

  after(() => restoreEnv());

  it("completes an anonymous ovhcloud plan without sending an Authorization header", async () => {
    const connection = newConfigStore().resolvePlanConnections("default")[0];
    assert.equal(connection.effectiveApiKey, undefined, "the anonymous tier must resolve without a key");

    const client = new LlmProviderClient(async (url, body, options) => {
      assert.match(url, /oai\.endpoints\.kepler\.ai\.cloud\.ovh\.net\/v1\/chat\/completions/);
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers["Content-Type"], "application/json");
      assert.equal(body.model, "Meta-Llama-3_3-70B-Instruct");
      assert.equal(body.response_format.type, "json_schema");
      return planResponse(["trigger:limit --symbol BTC --side BUY --price 60000 --quantity 0.01"]);
    });

    const raw = await client.completePlan(connection, { systemPrompt: "system", userPrompt: "user" });

    assert.equal(raw.commands[0], "trigger:limit --symbol BTC --side BUY --price 60000 --quantity 0.01");
  });

  it("sends a bearer Authorization header for a keyed connection", async () => {
    const client = new LlmProviderClient(async (url, _body, options) => {
      assert.equal(url, "https://example.test/v1/chat/completions");
      assert.equal(options.headers.Authorization, "Bearer test");
      return planResponse(["trigger:limit --symbol BTC --side BUY --price 60000 --quantity 0.01"]);
    });

    const raw = await client.completePlan(fakeConnection("openai", "gpt-test"), {
      systemPrompt: "system",
      userPrompt: "user",
    });

    assert.equal(raw.commands[0], "trigger:limit --symbol BTC --side BUY --price 60000 --quantity 0.01");
  });
});

describe("LlmDraftStore claiming flow", () => {
  it("stores a freshly added draft as PENDING", () => {
    const drafts = newDraftStore();
    const draft = addLimitDraft(drafts);

    assert.equal(drafts.get(draft.id, "u1").status, "PENDING");
  });

  it("claims a pending draft before any order is created", () => {
    const drafts = newDraftStore();
    const draft = addLimitDraft(drafts);

    const claimed = drafts.claimPending(draft.id, "u1", 60_000);

    assert.equal(claimed.status, "CONFIRMING", "claimPending should reserve a draft before creating orders");
  });

  it("does not let an already claimed draft be confirmed twice", () => {
    const drafts = newDraftStore();
    const draft = addLimitDraft(drafts);
    // Seed the precondition in this case: the first claim must succeed so the
    // second one is genuinely a double-confirm rather than a missing draft.
    assert.equal(drafts.claimPending(draft.id, "u1", 60_000).status, "CONFIRMING");

    assert.throws(
      () => drafts.claimPending(draft.id, "u1", 60_000),
      /CONFIRMING/,
      "double-confirming the same LLM draft should be rejected",
    );
  });

  it("marks a claimed draft CONFIRMED", () => {
    const drafts = newDraftStore();
    const draft = addLimitDraft(drafts);
    drafts.claimPending(draft.id, "u1", 60_000);

    drafts.mark(draft.id, "CONFIRMED", "u1");

    assert.equal(drafts.get(draft.id, "u1").status, "CONFIRMED");
  });
});

describe("isLlmDraftExpired", () => {
  it("keeps a draft inside its TTL confirmable", () => {
    const draft = addLimitDraft(newDraftStore());

    assert.equal(
      isLlmDraftExpired(draft, 1000, draft.createdAt + 500),
      false,
      "fresh LLM drafts should remain confirmable",
    );
  });

  it("expires a draft once its TTL has elapsed", () => {
    const draft = addLimitDraft(newDraftStore());

    assert.equal(
      isLlmDraftExpired(draft, 1000, draft.createdAt + 1001),
      true,
      "old LLM drafts should expire before order confirmation",
    );
  });
});

describe("formatDraftForTelegramHtml", () => {
  it("bolds the proposed trade command", () => {
    const html = formatDraftForTelegramHtml(addLimitDraft(newDraftStore()));

    assert.match(html, /<b>\/limit BTC BUY 60000 0\.01<\/b>/, "Telegram draft should bold the proposed trade command");
  });

  it("escapes model-authored text", () => {
    const html = formatDraftForTelegramHtml(addLimitDraft(newDraftStore()));

    assert.match(html, /Use &lt;carefully&gt; &amp; review/, "Telegram draft HTML should escape model text");
  });

  it("explains which side of the book the depth check uses", () => {
    const html = formatDraftForTelegramHtml(addLimitDraft(newDraftStore()));

    assert.match(html, /BUY checks executable ASK depth; SELL checks executable BID depth/);
  });
});

describe("formatDraftButtonLabel", () => {
  it("summarises symbol, quantity, notional and draft id", () => {
    const draft = addLimitDraft(newDraftStore());

    assert.match(formatDraftButtonLabel(draft), new RegExp(`BTC qty=0\\.01 ≈\\$600 ID:${draft.id}$`));
  });

  it("uses the resolved position size for a close-position draft", () => {
    const closeDraft = newDraftStore().add({
      ownerId: "u1",
      prompt: "close",
      provider: "openai",
      model: "m",
      format: "telegram",
      summary: "close BTC",
      commands: ["/takeprofit BTC SELL 65000 close"],
      riskNotes: [],
    });

    assert.match(
      formatDraftButtonLabel(closeDraft, { resolveCloseQuantity: () => 2 }),
      new RegExp(`BTC qty=2 ≈\\$130k ID:${closeDraft.id}$`),
    );
  });
});

describe("confirmOrderButtonText", () => {
  it("uses the singular label for a single order", () => {
    assert.equal(confirmOrderButtonText(1), "✅ Confirm Order");
  });

  it("uses the plural label for multiple orders", () => {
    assert.equal(confirmOrderButtonText(2), "✅ Confirm Orders");
  });
});
