"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const { stubRequire } = require("./helpers/module-stub");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tmp");

// Every exchange call the bot makes, in the order it made them. The captured
// headers and bodies are the evidence for "one user's credentials never travel
// on another user's request".
const posts = [];
const gets = [];

// Minimal `axios` stand-in: records the request, then answers with the shape the
// exchange client expects. Installed before any `../dist/` require, because the
// modules under test capture `axios` at load time.
const restoreRequire = stubRequire({
  axios: {
    post: async (url, body, options) => {
      posts.push({ url, body, headers: options?.headers });
      return { data: { orderId: `mock-${posts.length}` } };
    },
    get: async (url, options) => {
      gets.push({ url, headers: options?.headers });
      return { data: { positions: [{ symbol: "ETH", positionAmt: 2, availableQuantity: 2, markPrice: 100 }] } };
    },
  },
});

const SESSION_ENCRYPTION_KEY = "test-only-session-encryption-key";
const ROTATED_SESSION_ENCRYPTION_KEY = "rotated-key-cannot-decrypt-existing-sessions";

// Every process-global this file writes, snapshotted so the file cannot leak
// state into a sibling suite sharing the runner process.
const touchedEnvKeys = [
  "MODE",
  "TRADE_API_KEY",
  "TRADE_API_SECRET",
  "TELEGRAM_SESSION_ENCRYPTION_KEY",
  "QUOTE_TRADE_STATE_DIR",
  "ALICE_OPENAI_ENV",
];
const originalEnv = new Map(touchedEnvKeys.map((key) => [key, process.env[key]]));

// `real` mode is the interesting one: it is the only mode that reaches for
// credentials. The two global TRADE_* values are decoys — no session-backed
// order may ever fall back to them.
process.env.MODE = "real";
process.env.TRADE_API_KEY = "GLOBAL_KEY_SHOULD_NOT_BE_USED";
process.env.TRADE_API_SECRET = "GLOBAL_SECRET_SHOULD_NOT_BE_USED";
process.env.TELEGRAM_SESSION_ENCRYPTION_KEY = SESSION_ENCRYPTION_KEY;
process.env.QUOTE_TRADE_STATE_DIR = makeTempDir("qt-account-isolation-");

const { TradingSessionStore } = require("../dist/sessions/trading-session-store");
const { userStateFile, safeOwnerKey } = require("../dist/sessions/user-state");
const { TriggerStore } = require("../dist/triggers/trigger-store");
const { PositionStore } = require("../dist/triggers/position-store");
const { TriggerEngine } = require("../dist/triggers/trigger-engine");
const { BotService } = require("../dist/bot.service");
const { LlmDraftStore, LlmConfigStore } = require("../dist/llm");

after(restoreRequire);
after(cleanupTempDirs);
after(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** One level-2 book snapshot, the shape `TriggerEngine.processTick` consumes. */
function l2(symbol, bid, ask, qty = 10) {
  return {
    symbol,
    bid,
    ask,
    bidQty: qty,
    askQty: qty,
    orderBook: { bids: [{ p: bid, q: qty }], asks: [{ p: ask, q: qty }] },
  };
}

/**
 * Run `fn` while `TELEGRAM_SESSION_ENCRYPTION_KEY` holds a value the stored
 * sessions were *not* encrypted with, then put the real key back.
 */
function withRotatedSessionKey(fn) {
  const original = process.env.TELEGRAM_SESSION_ENCRYPTION_KEY;
  process.env.TELEGRAM_SESSION_ENCRYPTION_KEY = ROTATED_SESSION_ENCRYPTION_KEY;
  try {
    return fn();
  } finally {
    process.env.TELEGRAM_SESSION_ENCRYPTION_KEY = original;
  }
}

/** A limit trigger for `ownerId`, the shape `TriggerStore.add` accepts. */
function limitTrigger(ownerId, overrides = {}) {
  return { ownerId, kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 1, ...overrides };
}

// This file is one audit against a single shared state root: the stores persist
// to disk under QUOTE_TRADE_STATE_DIR, and a few guarantees genuinely depend on
// what an earlier one wrote (alice's ACTIVE trigger, the two submitted orders,
// charlie's state directory). Those fixtures are built once here and the suites
// below run in declaration order; every cross-suite dependency is called out in
// a comment where it is relied on.
let sessions;
let aliceTriggers;
let bobTriggers;
let alicePositions;
let bobPositions;
let aliceLlmDrafts;
let bobLlmDrafts;
let aliceLlmConfig;
let bobLlmConfig;
let aliceService;
let bobService;
let charlieService;

before(() => {
  sessions = new TradingSessionStore();
  sessions.set("alice", { apiKey: "ALICE_API_KEY", apiSecret: "ALICE_SECRET" });
  sessions.set("bob", { apiKey: "BOB_API_KEY", apiSecret: "BOB_SECRET", account: "bob-account" });

  aliceTriggers = new TriggerStore(userStateFile("alice", "triggers.json"));
  bobTriggers = new TriggerStore(userStateFile("bob", "triggers.json"));
  alicePositions = new PositionStore(userStateFile("alice", "positions.json"));
  bobPositions = new PositionStore(userStateFile("bob", "positions.json"));
  aliceLlmDrafts = new LlmDraftStore(userStateFile("alice", "llm-drafts.json"));
  bobLlmDrafts = new LlmDraftStore(userStateFile("bob", "llm-drafts.json"));
  aliceLlmConfig = new LlmConfigStore(userStateFile("alice", "llm-config.json"));
  bobLlmConfig = new LlmConfigStore(userStateFile("bob", "llm-config.json"));

  aliceService = new BotService(alicePositions, sessions, "alice");
  bobService = new BotService(bobPositions, sessions, "bob");
  // charlie has state on disk but never connects a session. Constructing this
  // store is what creates his state directory, which the session-inventory
  // guarantee at the bottom of the file depends on.
  charlieService = new BotService(new PositionStore(userStateFile("charlie", "positions.json")), sessions, "charlie");
});

describe("per-user state paths", () => {
  it("derives a different opaque state key for each Telegram user", () => {
    assert.notStrictEqual(safeOwnerKey("alice"), safeOwnerKey("bob"));
  });

  it("puts each user's trigger file in a different location", () => {
    assert.notStrictEqual(userStateFile("alice", "triggers.json"), userStateFile("bob", "triggers.json"));
  });
});

describe("stored exchange credentials", () => {
  it("never writes a user's api key to disk in plaintext", () => {
    const aliceSessionFile = fs.readFileSync(sessions.filePath("alice"), "utf8");
    assert.strictEqual(aliceSessionFile.includes("ALICE_API_KEY"), false, "api key must not be stored in plaintext");
  });

  it("never writes a user's api secret to disk in plaintext", () => {
    const aliceSessionFile = fs.readFileSync(sessions.filePath("alice"), "utf8");
    assert.strictEqual(aliceSessionFile.includes("ALICE_SECRET"), false, "api secret must not be stored in plaintext");
  });

  it("hands each user back their own api key and not another user's", () => {
    assert.strictEqual(sessions.get("alice").apiKey, "ALICE_API_KEY");
    assert.strictEqual(sessions.get("bob").apiKey, "BOB_API_KEY");
  });
});

describe("session encryption key rotation", () => {
  it("treats a session it can no longer decrypt as absent instead of throwing", () => {
    assert.ok(sessions.get("alice"), "precondition: the session is readable under the real key");
    withRotatedSessionKey(() => {
      assert.strictEqual(
        sessions.get("alice"),
        undefined,
        "rotated encryption key should make stored sessions unusable instead of throwing",
      );
    });
  });

  it("does not report a session it cannot decrypt as connected", () => {
    assert.strictEqual(
      sessions.summary("alice").connected,
      true,
      "precondition: the session reports connected under the real key",
    );
    withRotatedSessionKey(() => {
      assert.strictEqual(
        sessions.summary("alice").connected,
        false,
        "unreadable sessions should not be treated as connected",
      );
    });
  });

  it("reports an undecryptable api key as unreadable rather than leaking ciphertext", () => {
    withRotatedSessionKey(() => {
      const { apiKey } = sessions.summary("alice");
      assert.match(apiKey, /unreadable/);
      assert.strictEqual(apiKey.includes("ALICE"), false, "an unreadable summary must not leak the stored value");
    });
  });

  it("refuses to supply credentials for a session it cannot decrypt", () => {
    assert.ok(sessions.require("alice"), "precondition: require() succeeds under the real key");
    withRotatedSessionKey(() => {
      assert.throws(() => sessions.require("alice"), /No Quote\.Trade session connected/);
    });
  });

  it("restores access to the stored session once the original key is back", () => {
    assert.strictEqual(
      sessions.get("alice").apiKey,
      "ALICE_API_KEY",
      "restoring the encryption key should restore access",
    );
  });
});

describe("trigger store isolation", () => {
  // alice's trigger is deliberately left ACTIVE by this suite: the
  // trigger-engine guarantee below is what fires it.
  let aliceTrigger;

  before(() => {
    aliceTrigger = aliceTriggers.add(limitTrigger("alice"));
  });

  it("does not expose one user's trigger to another user's store", () => {
    // Positive controls first: both stores must really be holding a trigger,
    // otherwise the `undefined` below would also hold with persistence broken.
    const bobTrigger = bobTriggers.add(limitTrigger("bob", { side: "SELL", triggerPrice: 200 }));
    assert.ok(aliceTriggers.get(aliceTrigger.id), "precondition: alice can load her own trigger");
    assert.ok(bobTriggers.get(bobTrigger.id), "precondition: bob can load his own trigger");

    assert.strictEqual(
      bobTriggers.get(aliceTrigger.id),
      undefined,
      "bob must not be able to load alice trigger id from his store",
    );
  });

  it("does not let one user cancel another user's trigger by id", () => {
    const bobTrigger = bobTriggers.add(limitTrigger("bob", { side: "SELL", triggerPrice: 201 }));
    assert.ok(bobTriggers.cancel(bobTrigger.id), "precondition: bob can cancel his own trigger");

    assert.strictEqual(
      bobTriggers.cancel(aliceTrigger.id),
      undefined,
      "bob must not be able to cancel alice trigger id from his store",
    );
    assert.strictEqual(
      aliceTriggers.get(aliceTrigger.id).status,
      "ACTIVE",
      "alice trigger must survive bob cancel attempt",
    );
  });
});

describe("position store isolation", () => {
  before(() => {
    // Opposite-signed positions in the same symbol: any bleed between the two
    // stores shows up as the wrong close side or the wrong close quantity.
    alicePositions.upsert({ symbol: "BTC", positionAmt: 1, availableQuantity: 1, markPrice: 100 });
    bobPositions.upsert({ symbol: "BTC", positionAmt: -3, availableQuantity: -3, markPrice: 100 });
  });

  it("derives the close side from each user's own position", () => {
    assert.strictEqual(alicePositions.getCloseSide("BTC"), "SELL");
    assert.strictEqual(bobPositions.getCloseSide("BTC"), "BUY");
  });

  it("derives the close quantity from each user's own position", () => {
    assert.strictEqual(alicePositions.getCloseQuantity("BTC"), 1);
    assert.strictEqual(bobPositions.getCloseQuantity("BTC"), 3);
  });
});

describe("LLM draft isolation", () => {
  it("does not expose one user's LLM draft to another user", () => {
    const aliceDraft = aliceLlmDrafts.add({
      ownerId: "alice",
      prompt: "x",
      provider: "ovhcloud",
      model: "m",
      format: "telegram",
      summary: "s",
      commands: ["/limit BTC BUY 100 1"],
      riskNotes: [],
    });
    assert.ok(aliceLlmDrafts.get(aliceDraft.id, "alice"), "precondition: alice can load her own draft");

    assert.strictEqual(bobLlmDrafts.get(aliceDraft.id, "bob"), undefined, "bob must not load alice LLM drafts");
    // The owner check must hold even against alice's own draft file, not just
    // because bob reads a different path.
    assert.strictEqual(
      aliceLlmDrafts.get(aliceDraft.id, "bob"),
      undefined,
      "draft lookup must reject a non-owner even in the owner file",
    );
  });
});

describe("LLM connection isolation", () => {
  // Sequential by design: the first two cases assert on the inline key that the
  // hook stores, and the third replaces it with an env-backed connection.
  before(() => {
    aliceLlmConfig.setConnection({
      ownerId: "alice",
      provider: "openai",
      model: "alice-model",
      apiKey: "ALICE_LLM_KEY",
    });
    bobLlmConfig.setConnection({ ownerId: "bob", provider: "openai", model: "bob-model", apiKey: "BOB_LLM_KEY" });
  });

  it("never writes a stored LLM api key to disk in plaintext", () => {
    const aliceLlmConfigFile = fs.readFileSync(userStateFile("alice", "llm-config.json"), "utf8");
    assert.strictEqual(aliceLlmConfigFile.includes("ALICE_LLM_KEY"), false, "stored LLM API key must not be plaintext");
  });

  it("resolves the stored LLM api key for its own owner", () => {
    assert.strictEqual(
      aliceLlmConfig.resolvePlanConnections("alice", "openai", false)[0].effectiveApiKey,
      "ALICE_LLM_KEY",
    );
  });

  it("drops the previously stored inline LLM key when the owner switches to an env-backed key", () => {
    process.env.ALICE_OPENAI_ENV = "ALICE_ENV_LLM_KEY";
    aliceLlmConfig.setConnection({
      ownerId: "alice",
      provider: "openai",
      model: "alice-model",
      apiKeyEnv: "ALICE_OPENAI_ENV",
    });
    assert.strictEqual(
      aliceLlmConfig.resolvePlanConnections("alice", "openai", false)[0].effectiveApiKey,
      "ALICE_ENV_LLM_KEY",
      "env config should replace a previously stored inline LLM key",
    );
    assert.strictEqual(
      fs.readFileSync(userStateFile("alice", "llm-config.json"), "utf8").includes("ALICE_LLM_KEY"),
      false,
    );
  });

  it("does not list one user's LLM connection to another user", () => {
    // Positive control: bob's own configured connection is listed, so an
    // absent 'alice-model' cannot be explained by listRows surfacing nothing.
    assert.ok(
      bobLlmConfig.listRows("bob").some((row) => row.model === "bob-model"),
      "precondition: bob lists his own LLM connection",
    );

    assert.strictEqual(
      bobLlmConfig.listRows("bob").some((row) => row.model === "alice-model"),
      false,
      "bob must not list alice LLM config",
    );
    // And the owner filter must hold inside alice's own config file too.
    assert.strictEqual(
      aliceLlmConfig.listRows("bob").some((row) => row.model === "alice-model"),
      false,
      "config listing must filter by owner even in the owner file",
    );
  });
});

describe("trigger engine ownership", () => {
  it("passes the owning user id into every order it submits", async () => {
    const fakeExecutorOrders = [];
    const engine = new TriggerEngine(aliceTriggers, alicePositions, {
      submitOrder: async (req) => {
        fakeExecutorOrders.push(req);
        return {};
      },
    });
    // Fires the ACTIVE trigger left behind by the trigger-store suite.
    await engine.processTick(l2("BTC", 99, 100));
    assert.ok(fakeExecutorOrders.length > 0, "precondition: the tick fired at least one trigger");
    assert.strictEqual(fakeExecutorOrders[0].ownerId, "alice", "trigger engine must pass ownerId into submitOrder");
  });
});

describe("real-mode order submission", () => {
  it("refuses a real order for a user with no connected session", async () => {
    await assert.rejects(
      () =>
        charlieService.submitOrder({
          ownerId: "charlie",
          symbol: "BTC",
          side: "BUY",
          type: "LIMIT",
          quantity: 1,
          price: 1,
        }),
      /No Quote\.Trade session connected/,
    );
  });

  describe("once alice and bob have each submitted one real order", () => {
    before(async () => {
      await aliceService.submitOrder({
        ownerId: "alice",
        symbol: "BTC",
        side: "SELL",
        type: "LIMIT",
        quantity: 1,
        price: 101,
        paymentCurrency: "USD",
      });
      await bobService.submitOrder({
        ownerId: "bob",
        symbol: "BTC",
        side: "BUY",
        type: "LIMIT",
        quantity: 2,
        price: 99,
        paymentCurrency: "USD",
      });
    });

    it("sends one exchange request per session-backed order and none for the sessionless user", () => {
      // charlie's rejected order ran first and must not have reached the wire.
      assert.strictEqual(posts.length, 2);
    });

    it("authenticates each order with its own owner's api key", () => {
      assert.strictEqual(posts[0].headers["X-Mbx-Apikey"], "ALICE_API_KEY");
      assert.strictEqual(posts[1].headers["X-Mbx-Apikey"], "BOB_API_KEY");
    });

    it("applies a session account only to the order of the user who configured it", () => {
      assert.strictEqual(
        posts[1].body.account,
        "bob-account",
        "session account should default onto real orders for that user",
      );
      assert.strictEqual(
        posts[0].body.account,
        undefined,
        "a user without a session account must not inherit another user account",
      );
    });

    it("signs each owner's order with that owner's own secret", () => {
      assert.notStrictEqual(posts[0].headers.signature, posts[1].headers.signature);
    });

    it("keeps the local ownerId out of every order body", () => {
      for (const post of posts) {
        assert.strictEqual(post.body.symbol, "BTC", "precondition: the order body carries the real order fields");
        assert.strictEqual(JSON.stringify(post.body).includes("ownerId"), false, "ownerId is local-only");
      }
    });

    it("keeps every user's credentials out of every order body", () => {
      for (const post of posts) {
        const serialized = JSON.stringify(post.body);
        assert.strictEqual(post.body.symbol, "BTC", "precondition: the order body carries the real order fields");
        assert.strictEqual(serialized.includes("ALICE"), false, "alice secrets must not enter order body");
        assert.strictEqual(serialized.includes("BOB"), false, "bob secrets must not enter order body");
      }
    });

    it("never falls back to the process-global api key for a session-backed order", () => {
      for (const post of posts) {
        assert.strictEqual(
          post.headers["X-Mbx-Apikey"].includes("GLOBAL"),
          false,
          "global env api key must not be used for session-backed order",
        );
      }
    });
  });
});

describe("position refresh isolation", () => {
  before(async () => {
    // Marker position in the *other* user's store, written before the refresh,
    // so "alice was untouched" is a statement about a live, readable store
    // rather than about an empty one.
    alicePositions.upsert({ symbol: "SOL", positionAmt: 5, availableQuantity: 5, markPrice: 10 });
    await bobService.refreshPositions("bob");
  });

  it("authenticates a position refresh with the requesting user's api key", () => {
    assert.strictEqual(gets[0].headers["X-Mbx-Apikey"], "BOB_API_KEY");
  });

  it("writes the refreshed positions into the requesting user's store", () => {
    assert.strictEqual(bobPositions.get("ETH").netQty, 2);
  });

  it("leaves another user's position store untouched by that refresh", () => {
    assert.ok(bobPositions.get("ETH"), "precondition: the refresh really did store ETH for the requesting user");
    assert.strictEqual(
      alicePositions.get("SOL").netQty,
      5,
      "precondition: alice store is readable and still holds her own position",
    );

    assert.strictEqual(
      alicePositions.get("ETH"),
      undefined,
      "bob position refresh must not update alice position store",
    );
  });
});

describe("session inventory", () => {
  it("lists only users with a stored session, not every user with a state directory", () => {
    // charlie has a state directory (constructing his PositionStore created it)
    // but never connected, so he must not be listed.
    assert.deepStrictEqual(sessions.listOwnerIds(), ["alice", "bob"]);
  });
});
