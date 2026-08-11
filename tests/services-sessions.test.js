"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const EventEmitter = require("node:events");
const { createHmac, generateKeyPairSync, verify: verifySignature } = require("node:crypto");

const { stubRequire } = require("./helpers/module-stub");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tmp");

// ---------------------------------------------------------------------------
// Boundary stubs. Both must be installed before anything under `../dist/` is
// required: `http.service` captures `axios` at module load, and `codex-oauth`
// resolves `node:child_process` through `require()` on every spawn.
// ---------------------------------------------------------------------------

/** Every request the fake axios saw, oldest first. */
const requests = [];
/** Per-case overrides; `null` falls back to the benign default response. */
let getResponder = null;
let postResponder = null;

const axiosStub = {
  get: async (url, config) => {
    requests.push({ method: "GET", url, config });
    return getResponder ? getResponder(url, config) : { data: { positions: [] } };
  },
  post: async (url, body, config) => {
    requests.push({ method: "POST", url, body, config });
    return postResponder ? postResponder(url, body, config) : { data: { orderId: "exchange-order-1" } };
  },
};

function resetHttp() {
  requests.length = 0;
  getResponder = null;
  postResponder = null;
}

/** The last request the fake axios saw. */
function lastRequest() {
  assert.ok(requests.length > 0, "precondition: a request must have reached axios");
  return requests[requests.length - 1];
}

/**
 * A child process that never exists. `stdin.write`/`stdin.end` re-emit as
 * `write`/`end` events so a scenario can script the conversation, and `kill()`
 * only records the fact so a case can assert the process was torn down.
 */
function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.written = "";
  proc.stdin.write = (text) => {
    proc.stdin.written += String(text);
    proc.stdin.emit("write", String(text));
    return true;
  };
  proc.stdin.end = () => {
    proc.stdin.ended = true;
    proc.stdin.emit("end");
  };
  proc.kill = () => {
    proc.killed = true;
  };
  return proc;
}

/** Every spawn the code under test asked for, oldest first. */
const spawns = [];
/** Scripts the current case's fake codex; replaced per case via `useScenario`. */
let scenario = () => {};

function useScenario(fn) {
  spawns.length = 0;
  scenario = fn;
}

const restoreRequire = stubRequire({
  axios: axiosStub,
  "node:child_process": {
    spawn: (cmd, args, options) => {
      const record = {
        cmd,
        args,
        options,
        proc: makeFakeProc(),
        kind: args[0] === "app-server" ? "app-server" : "exec",
      };
      spawns.push(record);
      scenario(record);
      return record.proc;
    },
  },
});

// ---------------------------------------------------------------------------
// Process environment. Everything the modules under test read is pinned here
// so no ambient value from the developer's shell can change an assertion.
// ---------------------------------------------------------------------------

const stateDir = makeTempDir("qt-services-sessions-");
const API_BASE_URL = "https://exchange.test/api/";
const ENCRYPTION_KEY = "services-sessions-encryption-key";

const envPatch = {
  MODE: "paper",
  API_BASE_URL,
  QUOTE_TRADE_STATE_DIR: stateDir,
  TELEGRAM_SESSION_ENCRYPTION_KEY: ENCRYPTION_KEY,
  CODEX_BIN: "codex-test-bin",
  CODEX_LOGIN_START_TIMEOUT_MS: "2000",
  CODEX_LOGIN_TIMEOUT_MS: "5000",
  CODEX_EXEC_TIMEOUT_MS: "2000",
  // Cleared so each case opts in explicitly.
  TRADE_API_KEY: undefined,
  TRADE_API_SECRET: undefined,
  SIGNING_ALGORITHM: undefined,
  DEFAULT_PAYMENT_CURRENCY: undefined,
  SESSION_DEBUG: undefined,
  SLOW_REQUEST_LOG_MS: undefined,
  POSITIONS_ENDPOINT: undefined,
  QUOTE_TRADE_GET_TIMEOUT_MS: undefined,
  QUOTE_TRADE_POST_TIMEOUT_MS: undefined,
  QUOTE_TRADE_SESSION_KEY: undefined,
  SESSION_ENCRYPTION_KEY: undefined,
  TELEGRAM_BOT_TOKEN: undefined,
  CODEX_CA_CERTIFICATE: undefined,
  SSL_CERT_FILE: undefined,
};

const savedEnv = new Map();
for (const [key, value] of Object.entries(envPatch)) {
  savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = String(value);
}

const { HttpSvc } = require("../dist/utils/http.service");
const { BotService } = require("../dist/bot.service");
const { PositionStore } = require("../dist/triggers/position-store");
const {
  TradingSessionStore,
  decryptSecret,
  detectSigningAlgorithm,
  encryptSecret,
  redacted,
} = require("../dist/sessions/trading-session-store");
const { quoteTradeStateRoot, safeOwnerKey, userStateDir, userStateFile } = require("../dist/sessions/user-state");
const {
  cancelCodexOAuthLogin,
  codexAuthFile,
  codexHomeForOwner,
  codexOAuthStatus,
  completeCodexOAuthPlan,
  hasCodexOAuthSession,
  logoutCodexOAuth,
  startCodexOAuthLogin,
} = require("../dist/llm/codex-oauth");

const httpModulePath = require.resolve("../dist/utils/http.service");

after(restoreRequire);
after(cleanupTempDirs);
after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

/**
 * Run `fn` with `patch` applied to `process.env`, then put every touched key
 * back. `undefined` deletes the key for the duration of the call.
 */
async function withEnv(patch, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// The modules under test log to `console` on paper orders, on the debug paths
// and on slow requests. Capturing keeps the runner output readable and turns
// those log lines into something a case can assert on.
const consoleLines = [];
const realConsole = { log: console.log, warn: console.warn };

before(() => {
  console.log = (...args) => {
    consoleLines.push(args);
  };
  console.warn = (...args) => {
    consoleLines.push(args);
  };
});

after(() => {
  console.log = realConsole.log;
  console.warn = realConsole.warn;
});

/** Everything logged since the last call, then clears the buffer. */
function takeConsole() {
  return consoleLines.splice(0, consoleLines.length);
}

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const ed25519 = generateKeyPairSync("ed25519");
const ED25519_PEM = ed25519.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ED25519_BASE64_DER = ed25519.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

// ===========================================================================
// utils/http.service
// ===========================================================================

describe("HttpSvc url construction", () => {
  it("joins a relative path onto the configured base url without doubling the slash", async () => {
    resetHttp();
    await HttpSvc.post("/order", { symbol: "BTC" });
    assert.equal(lastRequest().url, "https://exchange.test/api/order");
  });

  it("sends an absolute url untouched instead of prefixing the base url", async () => {
    resetHttp();
    await HttpSvc.get("https://elsewhere.test/v1/ping");
    assert.equal(lastRequest().url, "https://elsewhere.test/v1/ping");
  });

  it("falls back to the bare path when no base url is configured", async () => {
    // The base url is read once, when the module is constructed, so this needs
    // a second instance built with the variable absent.
    const savedModule = require.cache[httpModulePath];
    delete require.cache[httpModulePath];
    let unconfigured;
    try {
      await withEnv({ API_BASE_URL: undefined }, () => {
        unconfigured = require("../dist/utils/http.service").HttpSvc;
      });
    } finally {
      require.cache[httpModulePath] = savedModule;
    }

    resetHttp();
    await unconfigured.get("/positions");
    assert.equal(lastRequest().url, "/positions");
  });
});

describe("HttpSvc authentication headers", () => {
  const credentials = { apiKey: "SESSION_KEY", apiSecret: "SESSION_SECRET" };

  it("signs a GET over the request path with the supplied secret", async () => {
    resetHttp();
    await HttpSvc.get("/positions", { quoteTradeCredentials: credentials });
    assert.deepEqual(lastRequest().config.headers, {
      "X-Mbx-Apikey": "SESSION_KEY",
      signature: createHmac("sha256", "SESSION_SECRET").update("/positions").digest("hex"),
    });
  });

  it("signs a POST over the exact json payload it sends", async () => {
    resetHttp();
    await HttpSvc.post("/order", { symbol: "BTC", quantity: 1 }, { quoteTradeCredentials: credentials });
    const payload = JSON.stringify({ symbol: "BTC", quantity: 1, channel: "LIQUIDITY" });
    assert.equal(
      lastRequest().config.headers.signature,
      createHmac("sha256", "SESSION_SECRET").update(payload).digest("hex"),
    );
  });

  it("keeps a caller-supplied header alongside the generated auth headers", async () => {
    resetHttp();
    await HttpSvc.post("/order", {}, { headers: { "X-Request-Id": "req-42" }, quoteTradeCredentials: credentials });
    const { headers } = lastRequest().config;
    assert.equal(headers["X-Request-Id"], "req-42");
    assert.equal(headers["X-Mbx-Apikey"], "SESSION_KEY");
    assert.ok(headers.signature);
  });

  it("uses the process-global credentials when no session credentials are supplied", async () => {
    await withEnv({ TRADE_API_KEY: "ENV_KEY", TRADE_API_SECRET: "ENV_SECRET" }, async () => {
      resetHttp();
      await HttpSvc.get("/positions");
      assert.deepEqual(lastRequest().config.headers, {
        "X-Mbx-Apikey": "ENV_KEY",
        signature: createHmac("sha256", "ENV_SECRET").update("/positions").digest("hex"),
      });
    });
  });

  it("refuses to fall back to the process-global credentials when the caller forbids it", async () => {
    await withEnv({ TRADE_API_KEY: "ENV_KEY", TRADE_API_SECRET: "ENV_SECRET" }, async () => {
      resetHttp();
      // Positive control: the very same call authenticates when the fallback
      // is permitted, so the empty headers below are a decision, not an accident.
      await HttpSvc.get("/positions", { allowEnvCredentials: true });
      assert.equal(lastRequest().config.headers["X-Mbx-Apikey"], "ENV_KEY");

      await HttpSvc.get("/positions", { allowEnvCredentials: false });
      assert.deepEqual(lastRequest().config.headers, {});
    });
  });

  it("sends an api key with no signature when only the key is known", async () => {
    resetHttp();
    await HttpSvc.get("/positions", { quoteTradeCredentials: { apiKey: "KEY_ONLY" }, allowEnvCredentials: false });
    assert.deepEqual(lastRequest().config.headers, { "X-Mbx-Apikey": "KEY_ONLY" });
  });

  it("sends a signature with no api key when only the secret is known", async () => {
    resetHttp();
    await HttpSvc.get("/positions", {
      quoteTradeCredentials: { apiSecret: "SECRET_ONLY" },
      allowEnvCredentials: false,
    });
    assert.deepEqual(lastRequest().config.headers, {
      signature: createHmac("sha256", "SECRET_ONLY").update("/positions").digest("hex"),
    });
  });

  it("never forwards the credentials themselves to the transport", async () => {
    resetHttp();
    await HttpSvc.post(
      "/order",
      { symbol: "BTC" },
      { quoteTradeCredentials: credentials, allowEnvCredentials: false, maxRedirects: 0 },
    );
    const { config } = lastRequest();
    assert.equal(config.maxRedirects, 0, "precondition: unrelated config keys do reach the transport");
    assert.equal("quoteTradeCredentials" in config, false);
    assert.equal("allowEnvCredentials" in config, false);
    assert.equal(
      JSON.stringify(config).includes("SESSION_SECRET"),
      false,
      "the raw secret must never be handed to the transport",
    );
  });
});

describe("HttpSvc ed25519 signing", () => {
  it("signs with ed25519 when the session declares that algorithm, using a pem secret", async () => {
    resetHttp();
    await HttpSvc.get("/positions", {
      quoteTradeCredentials: { apiKey: "K", apiSecret: ED25519_PEM, signingAlgorithm: "ed25519" },
      allowEnvCredentials: false,
    });
    const { signature } = lastRequest().config.headers;
    assert.ok(signature, "precondition: an ed25519 signature was produced");
    assert.equal(
      verifySignature(null, Buffer.from("/positions"), ed25519.publicKey, Buffer.from(signature, "base64")),
      true,
    );
  });

  it("signs with ed25519 when the secret is a bare base64 pkcs8 key", async () => {
    resetHttp();
    await HttpSvc.get("/positions", {
      quoteTradeCredentials: { apiKey: "K", apiSecret: ED25519_BASE64_DER, signingAlgorithm: "ed25519" },
      allowEnvCredentials: false,
    });
    const { signature } = lastRequest().config.headers;
    assert.equal(
      verifySignature(null, Buffer.from("/positions"), ed25519.publicKey, Buffer.from(signature, "base64")),
      true,
    );
  });

  it("takes the signing algorithm from the environment when the session does not declare one", async () => {
    await withEnv({ SIGNING_ALGORITHM: "ed25519" }, async () => {
      resetHttp();
      await HttpSvc.get("/positions", {
        quoteTradeCredentials: { apiKey: "K", apiSecret: ED25519_PEM },
        allowEnvCredentials: false,
      });
      const { signature } = lastRequest().config.headers;
      assert.equal(
        verifySignature(null, Buffer.from("/positions"), ed25519.publicKey, Buffer.from(signature, "base64")),
        true,
      );
    });
  });

  it("falls back to hmac for any other declared algorithm", async () => {
    resetHttp();
    await HttpSvc.get("/positions", {
      quoteTradeCredentials: { apiKey: "K", apiSecret: "plain-secret", signingAlgorithm: "HMAC-SHA256" },
      allowEnvCredentials: false,
    });
    assert.equal(
      lastRequest().config.headers.signature,
      createHmac("sha256", "plain-secret").update("/positions").digest("hex"),
    );
  });
});

describe("HttpSvc request body", () => {
  it("tags an untagged post body with the liquidity channel", async () => {
    resetHttp();
    await HttpSvc.post("/order", { symbol: "BTC" });
    assert.deepEqual(lastRequest().body, { symbol: "BTC", channel: "LIQUIDITY" });
  });

  it("keeps a channel the caller already chose", async () => {
    resetHttp();
    await HttpSvc.post("/order", { symbol: "BTC", channel: "RFQ" });
    assert.equal(lastRequest().body.channel, "RFQ");
  });

  it("posts a channel-only body when the caller supplies none", async () => {
    resetHttp();
    await HttpSvc.post("/ping");
    assert.deepEqual(lastRequest().body, { channel: "LIQUIDITY" });
  });
});

describe("HttpSvc timeouts", () => {
  it("applies the default read timeout to a get", async () => {
    resetHttp();
    await HttpSvc.get("/positions");
    assert.equal(lastRequest().config.timeout, 15_000);
  });

  it("applies the default write timeout to a post", async () => {
    resetHttp();
    await HttpSvc.post("/order", {});
    assert.equal(lastRequest().config.timeout, 35_000);
  });

  it("honours the configured timeouts", async () => {
    await withEnv({ QUOTE_TRADE_GET_TIMEOUT_MS: "1234", QUOTE_TRADE_POST_TIMEOUT_MS: "4321" }, async () => {
      resetHttp();
      await HttpSvc.get("/positions");
      assert.equal(lastRequest().config.timeout, 1234);
      await HttpSvc.post("/order", {});
      assert.equal(lastRequest().config.timeout, 4321);
    });
  });

  it("ignores a non-positive configured timeout and uses the default", async () => {
    await withEnv({ QUOTE_TRADE_GET_TIMEOUT_MS: "0", QUOTE_TRADE_POST_TIMEOUT_MS: "not-a-number" }, async () => {
      resetHttp();
      await HttpSvc.get("/positions");
      assert.equal(lastRequest().config.timeout, 15_000);
      await HttpSvc.post("/order", {});
      assert.equal(lastRequest().config.timeout, 35_000);
    });
  });

  it("lets the caller override the timeout for a single request", async () => {
    resetHttp();
    await HttpSvc.get("/positions", { timeout: 99 });
    assert.equal(lastRequest().config.timeout, 99);
  });
});

describe("HttpSvc failure and slow-request reporting", () => {
  it("propagates a rejected get to the caller", async () => {
    resetHttp();
    getResponder = async () => {
      throw new Error("socket hang up");
    };
    await assert.rejects(() => HttpSvc.get("/positions"), /socket hang up/);
  });

  it("propagates a rejected post to the caller", async () => {
    resetHttp();
    postResponder = async () => {
      throw new Error("502 Bad Gateway");
    };
    await assert.rejects(() => HttpSvc.post("/order", {}), /502 Bad Gateway/);
  });

  it("warns once a request crosses the configured slow threshold", async () => {
    await withEnv({ SLOW_REQUEST_LOG_MS: "1" }, async () => {
      resetHttp();
      postResponder = async () => {
        await sleep(5);
        return { data: {} };
      };
      takeConsole();
      await HttpSvc.post("/order", {});
      const warned = takeConsole().find(([tag]) => tag === "[SLOW_QUOTE_TRADE_REQUEST]");
      assert.ok(warned, "a slow request must be reported");
      assert.equal(warned[1].method, "POST");
      assert.equal(warned[1].path, "/order");
      assert.ok(warned[1].elapsedMs >= 1);
    });
  });

  it("stays quiet for a request under the slow threshold", async () => {
    resetHttp();
    takeConsole();
    await HttpSvc.get("/positions");
    // Positive control: the request really happened, so the missing warning is
    // the threshold doing its job rather than a request that never ran.
    assert.equal(requests.length, 1);
    assert.equal(
      takeConsole().some(([tag]) => tag === "[SLOW_QUOTE_TRADE_REQUEST]"),
      false,
    );
  });

  it("still reports a slow request that ended in failure", async () => {
    await withEnv({ SLOW_REQUEST_LOG_MS: "1" }, async () => {
      resetHttp();
      getResponder = async () => {
        await sleep(5);
        throw new Error("timeout of 15000ms exceeded");
      };
      takeConsole();
      await assert.rejects(() => HttpSvc.get("/positions"), /timeout of 15000ms exceeded/);
      const warned = takeConsole().find(([tag]) => tag === "[SLOW_QUOTE_TRADE_REQUEST]");
      assert.ok(warned, "the timing report must survive a failed request");
      assert.equal(warned[1].method, "GET");
    });
  });
});

// ===========================================================================
// bot.service
// ===========================================================================

/** A BotService with its own throwaway position file. */
function makeService(sessions, ownerId) {
  const positions = new PositionStore(path.join(makeTempDir("qt-svc-positions-"), "positions.json"));
  return { service: new BotService(positions, sessions, ownerId), positions };
}

function limitOrder(overrides = {}) {
  return { symbol: "BTC", side: "BUY", type: "LIMIT", quantity: 2, price: 100, ...overrides };
}

describe("BotService order validation", () => {
  it("rejects an order with no symbol", async () => {
    const { service } = makeService();
    await assert.rejects(() => service.submitOrder(limitOrder({ symbol: "" })), /^Error: symbol is required$/);
  });

  it("rejects a zero quantity", async () => {
    const { service } = makeService();
    await assert.rejects(
      () => service.submitOrder(limitOrder({ quantity: 0 })),
      /^Error: quantity must be a positive number$/,
    );
  });

  it("rejects a negative quantity", async () => {
    const { service } = makeService();
    await assert.rejects(
      () => service.submitOrder(limitOrder({ quantity: -1 })),
      /^Error: quantity must be a positive number$/,
    );
  });

  it("rejects a quantity that is not a number at all", async () => {
    const { service } = makeService();
    await assert.rejects(
      () => service.submitOrder(limitOrder({ quantity: "lots" })),
      /^Error: quantity must be a positive number$/,
    );
  });

  it("rejects a limit order with no price", async () => {
    const { service } = makeService();
    await assert.rejects(
      () => service.submitOrder(limitOrder({ price: undefined })),
      /^Error: limit price must be a positive number$/,
    );
  });

  it("rejects a limit order priced at zero", async () => {
    const { service } = makeService();
    await assert.rejects(
      () => service.submitOrder(limitOrder({ price: 0 })),
      /^Error: limit price must be a positive number$/,
    );
  });

  it("accepts a market order that carries no price", async () => {
    const { service } = makeService();
    const result = await service.submitOrder({ symbol: "BTC", side: "BUY", type: "MARKET", quantity: 2 });
    assert.equal(result.paper, true);
    assert.equal(result.raw.type, "MARKET");
  });

  it("coerces a numeric string quantity onto the payload as a number", async () => {
    const { service } = makeService();
    const result = await service.submitOrder(limitOrder({ quantity: "2.5" }));
    assert.strictEqual(result.raw.quantity, 2.5);
  });
});

describe("BotService payload shape", () => {
  it("drops the price from a market order even when the caller supplies one", async () => {
    const { service } = makeService();
    const submitted = { symbol: "BTC", side: "SELL", type: "MARKET", quantity: 1, price: 12345 };
    const { raw } = await service.submitOrder(submitted);
    assert.equal("price" in submitted, true, "fixture must carry a price for this check to mean anything");
    assert.equal("price" in raw, false, "a market order must not be priced");
  });

  it("keeps the price on a limit order", async () => {
    const { service } = makeService();
    const { raw } = await service.submitOrder(limitOrder({ price: 101 }));
    assert.equal(raw.price, 101);
  });

  it("translates SELL into the exchange side code", async () => {
    const { service } = makeService();
    const { raw } = await service.submitOrder(limitOrder({ side: "SELL" }));
    assert.equal(raw.side, "SEL");
  });

  it("defaults the payment currency to USD", async () => {
    const { service } = makeService();
    const { raw } = await service.submitOrder(limitOrder());
    assert.equal(raw.paymentCurrency, "USD");
  });

  it("uses the configured default payment currency", async () => {
    await withEnv({ DEFAULT_PAYMENT_CURRENCY: "EUR" }, async () => {
      const { service } = makeService();
      const { raw } = await service.submitOrder(limitOrder());
      assert.equal(raw.paymentCurrency, "EUR");
    });
  });

  it("lets the order override the configured default payment currency", async () => {
    await withEnv({ DEFAULT_PAYMENT_CURRENCY: "EUR" }, async () => {
      const { service } = makeService();
      const { raw } = await service.submitOrder(limitOrder({ paymentCurrency: "GBP" }));
      assert.equal(raw.paymentCurrency, "GBP");
    });
  });

  it("forwards the leverage opt-out the caller asked for", async () => {
    const { service } = makeService();
    const { raw } = await service.submitOrder(limitOrder({ disableLeverage: true }));
    assert.equal(raw.disableLeverage, true);
  });
});

describe("BotService paper mode", () => {
  it("mints a paper client order id when the caller has none", async () => {
    const { service } = makeService();
    const result = await service.submitOrder(limitOrder());
    assert.match(result.clientOrderId, /^paper_\d+$/);
  });

  it("keeps the caller client order id", async () => {
    const { service } = makeService();
    const result = await service.submitOrder(limitOrder({ clientOrderId: "mine-1" }));
    assert.equal(result.clientOrderId, "mine-1");
  });

  it("attributes the withheld order to the constructor owner", async () => {
    const { service } = makeService(undefined, "owner-7");
    takeConsole();
    await service.submitOrder(limitOrder());
    assert.ok(takeConsole().some(([line]) => String(line).startsWith("[PAPER][owner=owner-7]")));
  });

  it("attributes the withheld order to the request owner over the constructor owner", async () => {
    const { service } = makeService(undefined, "owner-7");
    takeConsole();
    await service.submitOrder(limitOrder({ ownerId: "owner-9" }));
    assert.ok(takeConsole().some(([line]) => String(line).startsWith("[PAPER][owner=owner-9]")));
  });

  it("falls back to the default owner when neither the request nor the service names one", async () => {
    const { service } = makeService(undefined, "");
    takeConsole();
    await service.submitOrder(limitOrder());
    assert.ok(takeConsole().some(([line]) => String(line).startsWith("[PAPER][owner=default]")));
  });
});

describe("BotService real mode", () => {
  let sessions;

  before(() => {
    sessions = new TradingSessionStore();
    sessions.set("trader", { apiKey: "TRADER_KEY", apiSecret: "TRADER_SECRET", account: "trader-account" });
  });

  it("authenticates the order with the owner session and not the process globals", async () => {
    await withEnv({ MODE: "real", TRADE_API_KEY: "GLOBAL_KEY", TRADE_API_SECRET: "GLOBAL_SECRET" }, async () => {
      resetHttp();
      const { service } = makeService(sessions, "trader");
      await service.submitOrder(limitOrder());
      assert.equal(lastRequest().config.headers["X-Mbx-Apikey"], "TRADER_KEY");
    });
  });

  it("defaults the order onto the account stored with the session", async () => {
    await withEnv({ MODE: "real" }, async () => {
      resetHttp();
      const { service } = makeService(sessions, "trader");
      await service.submitOrder(limitOrder());
      assert.equal(lastRequest().body.account, "trader-account");
    });
  });

  it("lets the order name an account other than the session account", async () => {
    await withEnv({ MODE: "real" }, async () => {
      resetHttp();
      const { service } = makeService(sessions, "trader");
      await service.submitOrder(limitOrder({ account: "sub-account" }));
      assert.equal(lastRequest().body.account, "sub-account");
    });
  });

  it("refuses to submit for an owner with no connected session", async () => {
    await withEnv({ MODE: "real" }, async () => {
      resetHttp();
      const { service } = makeService(sessions, "stranger");
      await assert.rejects(() => service.submitOrder(limitOrder()), /No Quote\.Trade session connected/);
      assert.equal(requests.length, 0, "a rejected order must not reach the exchange");
    });
  });

  it("uses the process-global credentials when the service has no session store", async () => {
    await withEnv({ MODE: "real", TRADE_API_KEY: "GLOBAL_KEY", TRADE_API_SECRET: "GLOBAL_SECRET" }, async () => {
      resetHttp();
      const { service } = makeService();
      await service.submitOrder(limitOrder());
      assert.equal(lastRequest().config.headers["X-Mbx-Apikey"], "GLOBAL_KEY");
    });
  });

  it("returns the exchange order id as a string", async () => {
    await withEnv({ MODE: "real" }, async () => {
      resetHttp();
      postResponder = async () => ({ data: { orderId: 987654, clientOrderId: 55 } });
      const { service } = makeService(sessions, "trader");
      const result = await service.submitOrder(limitOrder());
      assert.strictEqual(result.orderId, "987654");
      assert.strictEqual(result.clientOrderId, "55");
    });
  });

  it("surfaces a rejection body with no order id and the caller own client order id", async () => {
    await withEnv({ MODE: "real" }, async () => {
      resetHttp();
      postResponder = async () => ({ data: { code: -1013, msg: "Filter failure: MIN_NOTIONAL" } });
      const { service } = makeService(sessions, "trader");
      const result = await service.submitOrder(limitOrder({ clientOrderId: "local-9" }));
      assert.equal(result.orderId, undefined);
      assert.equal(result.clientOrderId, "local-9");
      assert.deepEqual(result.raw, { code: -1013, msg: "Filter failure: MIN_NOTIONAL" });
    });
  });

  it("surfaces an empty exchange response without inventing an order id", async () => {
    await withEnv({ MODE: "real" }, async () => {
      resetHttp();
      postResponder = async () => ({ data: undefined });
      const { service } = makeService(sessions, "trader");
      const result = await service.submitOrder(limitOrder());
      assert.equal(result.orderId, undefined);
      assert.equal(result.clientOrderId, undefined);
      assert.equal(result.raw, undefined);
    });
  });

  it("propagates a transport failure to the caller", async () => {
    await withEnv({ MODE: "real" }, async () => {
      resetHttp();
      postResponder = async () => {
        throw new Error("Request failed with status code 503");
      };
      const { service } = makeService(sessions, "trader");
      await assert.rejects(() => service.submitOrder(limitOrder()), /status code 503/);
    });
  });
});

describe("BotService session debug logging", () => {
  let sessions;

  before(() => {
    sessions = new TradingSessionStore();
    sessions.set("debug-owner", { apiKey: "DEBUG_API_KEY_1234567890", apiSecret: "DEBUG_SECRET" });
  });

  it("masks the api key in the resolved-session line", async () => {
    await withEnv({ MODE: "real", SESSION_DEBUG: "true" }, async () => {
      resetHttp();
      const { service } = makeService(sessions, "debug-owner");
      takeConsole();
      await service.submitOrder(limitOrder());
      const lines = takeConsole();
      const resolved = lines.find(([tag]) => tag === "[ORDER_SESSION_RESOLVED]");
      assert.ok(resolved, "the debug flag must produce the resolved-session line");
      assert.equal(resolved[1].hasSession, true);
      assert.equal(resolved[1].apiKeyMasked, redacted("DEBUG_API_KEY_1234567890"));
      assert.equal(
        JSON.stringify(lines).includes("DEBUG_API_KEY_1234567890"),
        false,
        "the debug log must never print the raw api key",
      );
      assert.ok(lines.some(([tag]) => tag === "[ORDER_SUBMIT_REAL]"));
    });
  });

  it("reports no session on the paper path", async () => {
    await withEnv({ MODE: "paper", SESSION_DEBUG: "true" }, async () => {
      const { service } = makeService(sessions, "debug-owner");
      takeConsole();
      await service.submitOrder(limitOrder());
      const lines = takeConsole();
      const resolved = lines.find(([tag]) => tag === "[ORDER_SESSION_RESOLVED]");
      assert.equal(resolved[1].hasSession, false);
      assert.equal(resolved[1].apiKeyMasked, undefined);
      assert.equal(
        lines.some(([tag]) => tag === "[ORDER_SUBMIT_REAL]"),
        false,
        "a paper order must not log a real submission",
      );
    });
  });

  it("stays silent about sessions when the debug flag is off", async () => {
    await withEnv({ MODE: "real" }, async () => {
      resetHttp();
      const { service } = makeService(sessions, "debug-owner");
      takeConsole();
      await service.submitOrder(limitOrder());
      assert.equal(requests.length, 1, "precondition: the order really was submitted");
      assert.equal(
        takeConsole().some(([tag]) => tag === "[ORDER_SESSION_RESOLVED]"),
        false,
      );
    });
  });
});

describe("BotService position refresh", () => {
  let sessions;

  before(() => {
    sessions = new TradingSessionStore();
    sessions.set("refresher", { apiKey: "REFRESH_KEY", apiSecret: "REFRESH_SECRET" });
  });

  it("stores the positions the exchange reports and returns the count", async () => {
    resetHttp();
    getResponder = async () => ({
      data: { positions: [{ symbol: "ETH", positionAmt: 3, availableQuantity: 3, markPrice: 10 }] },
    });
    const { service, positions } = makeService(sessions, "refresher");
    assert.equal(await service.refreshPositions(), 1);
    assert.equal(positions.get("ETH").netQty, 3);
  });

  it("authenticates the refresh with the owner session", async () => {
    resetHttp();
    const { service } = makeService(sessions, "refresher");
    await service.refreshPositions("refresher");
    assert.equal(lastRequest().config.headers["X-Mbx-Apikey"], "REFRESH_KEY");
  });

  it("records that the session was verified by a successful refresh", async () => {
    resetHttp();
    // A never-refreshed owner of its own: the cases above already verified
    // `refresher`, so the precondition below would be vacuous there.
    sessions.set("first-refresh", { apiKey: "FIRST_KEY", apiSecret: "FIRST_SECRET" });
    const { service } = makeService(sessions, "first-refresh");
    assert.equal(
      sessions.summary("first-refresh").lastVerifiedAt,
      undefined,
      "precondition: the session has never been verified",
    );
    await service.refreshPositions();
    assert.equal(typeof sessions.summary("first-refresh").lastVerifiedAt, "number");
  });

  it("falls back to the process-global credentials when there is no session store", async () => {
    await withEnv({ TRADE_API_KEY: "GLOBAL_KEY", TRADE_API_SECRET: "GLOBAL_SECRET" }, async () => {
      resetHttp();
      const { service } = makeService();
      await service.refreshPositions();
      assert.equal(lastRequest().config.headers["X-Mbx-Apikey"], "GLOBAL_KEY");
    });
  });

  it("propagates an unusable positions response instead of clearing the store", async () => {
    resetHttp();
    getResponder = async () => ({ data: { nonsense: true } });
    const { service } = makeService(sessions, "refresher");
    await assert.rejects(() => service.refreshPositions("refresher"), /unrecognized positions response/);
  });
});

// ===========================================================================
// sessions/user-state
// ===========================================================================

describe("user state paths", () => {
  it("uses the configured state directory as the root", () => {
    assert.equal(quoteTradeStateRoot(), path.resolve(stateDir));
  });

  it("falls back to a project-local root when no state directory is configured", async () => {
    await withEnv({ QUOTE_TRADE_STATE_DIR: undefined }, () => {
      assert.equal(quoteTradeStateRoot(), path.resolve(".quote-trade"));
    });
  });

  it("derives a stable opaque key per owner", () => {
    assert.equal(safeOwnerKey("alice"), safeOwnerKey("alice"));
    assert.notEqual(safeOwnerKey("alice"), safeOwnerKey("bob"));
    assert.match(safeOwnerKey("alice"), /^[0-9a-f]{32}$/);
  });

  it("does not put the raw owner id in the path key", () => {
    assert.equal(safeOwnerKey("alice").includes("alice"), false);
  });

  it("refuses a missing owner id", () => {
    assert.throws(() => safeOwnerKey(undefined), /^Error: ownerId is required$/);
  });

  it("refuses a null owner id", () => {
    assert.throws(() => safeOwnerKey(null), /^Error: ownerId is required$/);
  });

  it("refuses a blank owner id", () => {
    assert.throws(() => safeOwnerKey("   "), /^Error: ownerId is required$/);
  });

  it("ignores surrounding whitespace when deriving the key", () => {
    assert.equal(safeOwnerKey("  alice  "), safeOwnerKey("alice"));
  });

  it("creates the owner directory private to its owner", () => {
    const dir = userStateDir("perm-owner");
    assert.equal(fs.existsSync(dir), true);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  });

  it("places a named file inside the owner directory", () => {
    assert.equal(userStateFile("perm-owner", "session.json"), path.join(userStateDir("perm-owner"), "session.json"));
  });
});

// ===========================================================================
// sessions/trading-session-store
// ===========================================================================

describe("session secret redaction", () => {
  it("reports a missing value as not set", () => {
    assert.equal(redacted(undefined), "not set");
    assert.equal(redacted(""), "not set");
  });

  it("hides a short value entirely", () => {
    assert.equal(redacted("12345678"), "••••");
  });

  it("shows only the ends of a long value", () => {
    assert.equal(redacted("ABCDEFGHIJKLMNOP"), "ABCD…MNOP");
  });
});

describe("signing algorithm detection", () => {
  it("detects an ed25519 pem private key", () => {
    assert.equal(detectSigningAlgorithm(ED25519_PEM), "ed25519");
  });

  it("detects an ed25519 key given as bare base64", () => {
    assert.equal(detectSigningAlgorithm(ED25519_BASE64_DER), "ed25519");
  });

  it("treats an ordinary shared secret as hmac", () => {
    assert.equal(detectSigningAlgorithm("a-plain-hmac-secret"), "sha256");
  });

  it("treats an rsa private key as hmac rather than ed25519", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    assert.equal(detectSigningAlgorithm(rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString()), "sha256");
  });

  it("refuses an empty secret", () => {
    assert.throws(() => detectSigningAlgorithm("   "), /^Error: api secret is required$/);
  });
});

describe("session secret encryption", () => {
  it("round-trips a secret through the configured key", () => {
    const sealed = encryptSecret("top-secret");
    assert.equal(sealed.includes("top-secret"), false, "the ciphertext must not contain the plaintext");
    assert.equal(decryptSecret(sealed), "top-secret");
  });

  it("produces a different ciphertext every time", () => {
    assert.notEqual(encryptSecret("top-secret"), encryptSecret("top-secret"));
  });

  it("refuses a payload that is not in the versioned envelope format", () => {
    assert.throws(() => decryptSecret("not-an-envelope"), /Unsupported encrypted session payload/);
    assert.throws(() => decryptSecret("v1:only:two"), /Unsupported encrypted session payload/);
    assert.throws(() => decryptSecret(undefined), /Unsupported encrypted session payload/);
  });

  it("refuses a payload sealed under a different key", async () => {
    const sealed = encryptSecret("top-secret");
    await withEnv({ TELEGRAM_SESSION_ENCRYPTION_KEY: "a-completely-different-key" }, () => {
      assert.throws(() => decryptSecret(sealed));
    });
  });

  it("accepts any of the supported key variables as the same key material", async () => {
    const sealed = await withEnv(
      { TELEGRAM_SESSION_ENCRYPTION_KEY: undefined, QUOTE_TRADE_SESSION_KEY: "shared-material" },
      () => encryptSecret("top-secret"),
    );
    await withEnv({ TELEGRAM_SESSION_ENCRYPTION_KEY: undefined, SESSION_ENCRYPTION_KEY: "shared-material" }, () => {
      assert.equal(decryptSecret(sealed), "top-secret");
    });
    await withEnv({ TELEGRAM_SESSION_ENCRYPTION_KEY: undefined, TELEGRAM_BOT_TOKEN: "shared-material" }, () => {
      assert.equal(decryptSecret(sealed), "top-secret");
    });
  });

  it("refuses to encrypt when no key material is configured at all", async () => {
    await withEnv(
      {
        TELEGRAM_SESSION_ENCRYPTION_KEY: "  ",
        QUOTE_TRADE_SESSION_KEY: undefined,
        SESSION_ENCRYPTION_KEY: undefined,
        TELEGRAM_BOT_TOKEN: undefined,
      },
      () => {
        assert.throws(() => encryptSecret("top-secret"), /is required to encrypt trading sessions/);
      },
    );
  });
});

describe("TradingSessionStore persistence", () => {
  let store;
  let dir;

  before(() => {
    dir = makeTempDir("qt-session-store-");
    store = new TradingSessionStore((ownerId) => path.join(dir, `${ownerId}.json`));
    store.set("u1", { apiKey: "U1_API_KEY", apiSecret: "U1_API_SECRET", account: "u1-acct", label: "main" });
  });

  it("uses the file naming the caller injected", () => {
    assert.equal(store.filePath("u1"), path.join(dir, "u1.json"));
  });

  it("never writes a credential to disk in plaintext", () => {
    const onDisk = fs.readFileSync(store.filePath("u1"), "utf8");
    assert.ok(onDisk.includes("apiKeyEncrypted"), "precondition: the session really was written");
    assert.ok(onDisk.includes('"v1:'), "precondition: the stored value is a sealed envelope");
    assert.equal(onDisk.includes("U1_API_KEY"), false);
    assert.equal(onDisk.includes("U1_API_SECRET"), false);
  });

  it("writes the session file readable only by its owner", () => {
    assert.equal(fs.statSync(store.filePath("u1")).mode & 0o777, 0o600);
  });

  it("hands the credentials back to the owner", () => {
    const session = store.get("u1");
    assert.equal(session.apiKey, "U1_API_KEY");
    assert.equal(session.apiSecret, "U1_API_SECRET");
    assert.equal(session.account, "u1-acct");
    assert.equal(session.label, "main");
    assert.equal(session.signingAlgorithm, "sha256");
  });

  it("reports an unknown owner as having no session", () => {
    assert.ok(store.get("u1"), "precondition: a known owner does resolve");
    assert.equal(store.get("nobody"), undefined);
    assert.equal(store.getStored("nobody"), undefined);
  });

  it("refuses to supply credentials for an unknown owner", () => {
    assert.throws(() => store.require("nobody"), /No Quote\.Trade session connected/);
  });

  it("supplies credentials for a known owner", () => {
    assert.equal(store.require("u1").apiKey, "U1_API_KEY");
  });
});

describe("TradingSessionStore updates", () => {
  let store;
  let dir;

  before(() => {
    dir = makeTempDir("qt-session-update-");
    store = new TradingSessionStore((ownerId) => path.join(dir, `${ownerId}.json`));
  });

  it("keeps the original creation time when the credentials are replaced", async () => {
    const created = store.set("u2", { apiKey: "K1", apiSecret: "S1" });
    await sleep(2);
    const updated = store.set("u2", { apiKey: "K2", apiSecret: "S2" });
    assert.equal(updated.createdAt, created.createdAt);
    assert.ok(updated.updatedAt >= created.updatedAt);
    assert.equal(store.get("u2").apiKey, "K2");
  });

  it("keeps the stored account and label when an update omits them", () => {
    store.set("u3", { apiKey: "K", apiSecret: "S", account: "acct-1", label: "desk" });
    store.set("u3", { apiKey: "K2", apiSecret: "S2" });
    assert.equal(store.get("u3").account, "acct-1");
    assert.equal(store.get("u3").label, "desk");
  });

  it("clears the stored account when an update blanks it", () => {
    store.set("u4", { apiKey: "K", apiSecret: "S", account: "acct-1", label: "desk" });
    assert.equal(store.get("u4").account, "acct-1", "precondition: the account was stored");
    store.set("u4", { apiKey: "K", apiSecret: "S", account: "  ", label: "" });
    assert.equal(store.get("u4").account, undefined);
    assert.equal(store.get("u4").label, undefined);
  });

  it("keeps the stored signing algorithm when an update omits it", () => {
    store.set("u5", { apiKey: "K", apiSecret: "S", signingAlgorithm: "ed25519" });
    store.set("u5", { apiKey: "K2", apiSecret: "S2" });
    assert.equal(store.get("u5").signingAlgorithm, "ed25519");
  });

  it("accepts every spelling of the two supported signing algorithms", () => {
    for (const spelling of ["sha256", "hmac", "hmac-sha256", "hmac_sha256"]) {
      assert.equal(
        store.set("u6", { apiKey: "K", apiSecret: "S", signingAlgorithm: spelling }).signingAlgorithm,
        "sha256",
      );
    }
    for (const spelling of ["ed25519", "ED-25519"]) {
      assert.equal(
        store.set("u7", { apiKey: "K", apiSecret: "S", signingAlgorithm: spelling }).signingAlgorithm,
        "ed25519",
      );
    }
  });

  it("refuses an unsupported signing algorithm", () => {
    assert.throws(
      () => store.set("u8", { apiKey: "K", apiSecret: "S", signingAlgorithm: "rsa" }),
      /signing algorithm must be sha256/,
    );
  });

  it("refuses a session with no owner id", () => {
    assert.throws(() => store.set("   ", { apiKey: "K", apiSecret: "S" }), /^Error: ownerId is required$/);
  });

  it("refuses a session with no api key", () => {
    assert.throws(() => store.set("u9", { apiKey: "   ", apiSecret: "S" }), /^Error: api key is required$/);
  });

  it("refuses a session with no api secret", () => {
    assert.throws(() => store.set("u9", { apiKey: "K" }), /^Error: api secret is required$/);
  });

  it("stamps the verification time without disturbing the credentials", () => {
    store.set("u10", { apiKey: "K", apiSecret: "S" });
    assert.equal(store.getStored("u10").lastVerifiedAt, undefined, "precondition: never verified yet");
    store.touchVerified("u10");
    assert.equal(typeof store.getStored("u10").lastVerifiedAt, "number");
    assert.equal(store.get("u10").apiKey, "K");
  });

  it("ignores a verification stamp for an owner with no session", () => {
    store.touchVerified("never-connected");
    assert.equal(
      fs.existsSync(store.filePath("never-connected")),
      false,
      "touching an unknown owner must not create a session file",
    );
  });

  it("removes a stored session", () => {
    store.set("u11", { apiKey: "K", apiSecret: "S" });
    assert.ok(store.get("u11"), "precondition: the session exists");
    assert.equal(store.remove("u11"), true);
    assert.equal(store.get("u11"), undefined);
    assert.equal(fs.existsSync(store.filePath("u11")), false);
  });

  it("reports that there was nothing to remove for an unknown owner", () => {
    assert.equal(store.remove("u11"), false);
  });
});

describe("TradingSessionStore damaged and unreadable state", () => {
  let store;
  let dir;

  before(() => {
    dir = makeTempDir("qt-session-damage-");
    store = new TradingSessionStore((ownerId) => path.join(dir, `${ownerId}.json`));
  });

  it("treats a corrupt session file as no session at all", () => {
    fs.writeFileSync(path.join(dir, "corrupt.json"), "{ this is not json");
    assert.equal(store.getStored("corrupt"), undefined);
    assert.equal(store.get("corrupt"), undefined);
    assert.equal(store.summary("corrupt").connected, false);
  });

  it("ignores a session written by an unknown future version", () => {
    fs.writeFileSync(
      path.join(dir, "future.json"),
      JSON.stringify({ version: 2, ownerId: "future", apiKeyEncrypted: "x" }),
    );
    assert.equal(store.getStored("future"), undefined);
    assert.equal(store.get("future"), undefined);
  });

  it("treats a session it can no longer decrypt as absent rather than throwing", async () => {
    store.set("rotated", { apiKey: "ROTATED_KEY", apiSecret: "ROTATED_SECRET" });
    assert.ok(store.get("rotated"), "precondition: readable under the current key");
    await withEnv({ TELEGRAM_SESSION_ENCRYPTION_KEY: "a-rotated-key" }, () => {
      assert.equal(store.get("rotated"), undefined);
      assert.throws(() => store.require("rotated"), /No Quote\.Trade session connected/);
    });
    assert.ok(store.get("rotated"), "the session must come back once the original key returns");
  });

  it("summarises an undecryptable session as unreadable without leaking the ciphertext", async () => {
    await withEnv({ TELEGRAM_SESSION_ENCRYPTION_KEY: "a-rotated-key" }, () => {
      const summary = store.summary("rotated");
      assert.equal(summary.connected, false);
      assert.equal(summary.apiKey, "unreadable; reconnect required");
      assert.equal(summary.signingAlgorithm, "sha256", "the non-secret metadata is still readable");
    });
  });
});

describe("TradingSessionStore summaries", () => {
  let store;
  let dir;

  before(() => {
    dir = makeTempDir("qt-session-summary-");
    store = new TradingSessionStore((ownerId) => path.join(dir, `${ownerId}.json`));
    store.set("s1", { apiKey: "SUMMARY_API_KEY_LONG", apiSecret: "S", account: "acct", label: "lbl" });
  });

  it("redacts the api key it reports", () => {
    const summary = store.summary("s1");
    assert.equal(summary.connected, true);
    assert.equal(summary.apiKey, redacted("SUMMARY_API_KEY_LONG"));
    assert.equal(summary.apiKey.includes("API_KEY_LO"), false);
  });

  it("reports the non-secret metadata alongside the redacted key", () => {
    const summary = store.summary("s1");
    assert.equal(summary.account, "acct");
    assert.equal(summary.label, "lbl");
    assert.equal(summary.signingAlgorithm, "sha256");
    assert.equal(typeof summary.createdAt, "number");
    assert.equal(summary.pathKey, safeOwnerKey("s1"));
  });

  it("reports an owner with no session as disconnected and keyless", () => {
    assert.equal(store.summary("s1").connected, true, "precondition: a connected owner summarises as connected");
    const summary = store.summary("nobody");
    assert.equal(summary.connected, false);
    assert.equal(summary.apiKey, undefined);
    assert.equal(summary.createdAt, undefined);
    assert.equal(summary.pathKey, safeOwnerKey("nobody"));
  });
});

describe("TradingSessionStore owner inventory", () => {
  it("reports nothing when no user state has ever been written", async () => {
    await withEnv({ QUOTE_TRADE_STATE_DIR: makeTempDir("qt-empty-root-") }, () => {
      assert.deepEqual(new TradingSessionStore().listOwnerIds(), []);
    });
  });

  it("lists every owner holding a stored session, sorted, and nothing else", async () => {
    const root = makeTempDir("qt-inventory-root-");
    await withEnv({ QUOTE_TRADE_STATE_DIR: root }, () => {
      const store = new TradingSessionStore();
      store.set("zoe", { apiKey: "K", apiSecret: "S" });
      store.set("adam", { apiKey: "K", apiSecret: "S" });

      const usersDir = path.join(root, "users");
      // A user directory with no session at all, one with an unreadable
      // session, one written by a future version, and a stray file where a
      // user directory would be. None of them is an owner.
      fs.mkdirSync(path.join(usersDir, "no-session-here"), { recursive: true });
      fs.mkdirSync(path.join(usersDir, "broken"), { recursive: true });
      fs.writeFileSync(path.join(usersDir, "broken", "session.json"), "not json");
      fs.mkdirSync(path.join(usersDir, "futuristic"), { recursive: true });
      fs.writeFileSync(
        path.join(usersDir, "futuristic", "session.json"),
        JSON.stringify({ version: 9, ownerId: "futuristic" }),
      );
      fs.writeFileSync(path.join(usersDir, "stray-file"), "ignore me");

      assert.deepEqual(store.listOwnerIds(), ["adam", "zoe"]);
    });
  });
});

// ===========================================================================
// llm/codex-oauth
// ===========================================================================

/** Emit one JSON-RPC line on the fake app-server's stdout. */
function respond(proc, message) {
  proc.stdout.emit("data", `${JSON.stringify(message)}\n`);
}

/**
 * Scripts a fake `codex app-server`. `onMessage(msg, rec)` is invoked for every
 * JSON-RPC message the code under test writes to stdin, on the next tick, so
 * the caller's response handler is registered before any reply arrives.
 */
function appServer(onMessage) {
  return (rec) => {
    if (rec.kind !== "app-server") return;
    rec.proc.stdin.on("write", (text) => {
      for (const line of text.split("\n").filter(Boolean)) {
        const msg = JSON.parse(line);
        setImmediate(() => onMessage(msg, rec));
      }
    });
  };
}

/** The standard device-code challenge a successful `account/login/start` returns. */
function challengeResult(loginId = "login-1") {
  return { type: "chatgptDeviceCode", loginId, verificationUrl: "https://auth.example/device", userCode: "WXYZ-9999" };
}

/**
 * Scripts a fake `codex exec` run: optional stderr/stdout, an optional output
 * file, then either an `error` event or an `exit`.
 */
function execRun({ output, stdout, stderr, exitCode = 0, exit = true, errorMessage } = {}) {
  return (rec) => {
    if (rec.kind !== "exec") return;
    rec.proc.stdin.on("end", () => {
      if (output !== undefined) {
        fs.writeFileSync(rec.args[rec.args.indexOf("--output-last-message") + 1], output, "utf8");
      }
      setImmediate(() => {
        if (stderr) rec.proc.stderr.emit("data", stderr);
        if (stdout) rec.proc.stdout.emit("data", stdout);
        setImmediate(() => {
          if (errorMessage) rec.proc.emit("error", new Error(errorMessage));
          else if (exit) rec.proc.emit("exit", exitCode);
        });
      });
    });
  };
}

/** Give an owner a codex session without going through the login flow. */
function seedCodexSession(ownerId) {
  fs.writeFileSync(codexAuthFile(ownerId), JSON.stringify({ mode: "chatgpt", accessToken: "t" }), { mode: 0o600 });
}

describe("codex OAuth session detection", () => {
  it("reports no session before anything is written", () => {
    assert.equal(hasCodexOAuthSession("codex-fresh"), false);
  });

  it("reports a session once codex has written a chatgpt auth file", () => {
    seedCodexSession("codex-seeded");
    assert.equal(hasCodexOAuthSession("codex-seeded"), true);
  });

  it("rejects an auth file that holds no credential material", () => {
    assert.equal(hasCodexOAuthSession("codex-seeded"), true, "precondition: a real auth file is recognised");
    fs.writeFileSync(codexAuthFile("codex-empty-auth"), JSON.stringify({ note: "nothing useful here" }));
    assert.equal(hasCodexOAuthSession("codex-empty-auth"), false);
  });

  it("reports no session when the auth file cannot be read", () => {
    // A directory where the auth file belongs: it exists, but reading it fails.
    fs.mkdirSync(codexAuthFile("codex-unreadable"), { recursive: true });
    assert.equal(fs.existsSync(codexAuthFile("codex-unreadable")), true, "precondition: something is at the auth path");
    assert.equal(hasCodexOAuthSession("codex-unreadable"), false);
  });

  it("keeps each owner auth file inside that owner private codex home", () => {
    const home = codexHomeForOwner("codex-seeded");
    assert.ok(codexAuthFile("codex-seeded").startsWith(home));
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    assert.notEqual(codexAuthFile("codex-seeded"), codexAuthFile("codex-fresh"));
  });

  it("reports the connection state and paths for an owner", () => {
    const status = codexOAuthStatus("codex-seeded");
    assert.equal(status.connected, true);
    assert.equal(status.pending, false);
    assert.equal(status.loginId, undefined);
    assert.equal(status.authFile, codexAuthFile("codex-seeded"));
    assert.equal(status.codexHome, codexHomeForOwner("codex-seeded"));
  });
});

describe("codex OAuth logout", () => {
  it("reports that there was nothing to remove for an owner who never logged in", () => {
    assert.equal(logoutCodexOAuth("codex-never"), false);
  });

  it("removes the auth file of an owner who did log in", () => {
    seedCodexSession("codex-logout");
    assert.equal(hasCodexOAuthSession("codex-logout"), true, "precondition: the session exists");
    assert.equal(logoutCodexOAuth("codex-logout"), true);
    assert.equal(fs.existsSync(codexAuthFile("codex-logout")), false);
  });

  it("reports failure when the auth file cannot be deleted", () => {
    // Same directory-in-place-of-a-file trick: `existsSync` passes, `unlink` fails.
    fs.mkdirSync(codexAuthFile("codex-stuck"), { recursive: true });
    assert.equal(logoutCodexOAuth("codex-stuck"), false);
    fs.rmSync(codexAuthFile("codex-stuck"), { recursive: true, force: true });
  });
});

describe("codex OAuth login start", () => {
  after(() => {
    useScenario(() => {});
  });

  it("refuses a login with no owner id", async () => {
    await assert.rejects(() => startCodexOAuthLogin("   "), /ownerId is required for Codex OAuth/);
  });

  it("returns the device-code challenge codex produced", async () => {
    useScenario(
      appServer((msg, rec) => {
        if (msg.method === "initialize") respond(rec.proc, { id: msg.id, result: { platformOs: "test" } });
        if (msg.method === "account/login/start")
          respond(rec.proc, { id: msg.id, result: challengeResult("login-start-1") });
      }),
    );

    const challenge = await startCodexOAuthLogin("codex-start");
    try {
      assert.deepEqual(challenge, {
        loginId: "login-start-1",
        verificationUrl: "https://auth.example/device",
        userCode: "WXYZ-9999",
      });
      assert.equal(spawns[0].cmd, "codex-test-bin");
      assert.deepEqual(spawns[0].args, ["app-server"]);
    } finally {
      cancelCodexOAuthLogin("codex-start");
    }
  });

  it("writes a private codex config that forces the chatgpt login method", async () => {
    const configFile = path.join(codexHomeForOwner("codex-start"), "config.toml");
    const contents = fs.readFileSync(configFile, "utf8");
    assert.match(contents, /forced_login_method = "chatgpt"/);
    assert.match(contents, /sandbox_mode = "read-only"/);
    assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
  });

  it("leaves an existing codex config alone on the next login", async () => {
    const configFile = path.join(codexHomeForOwner("codex-start"), "config.toml");
    fs.writeFileSync(configFile, "# hand edited\n", { mode: 0o600 });

    useScenario(
      appServer((msg, rec) => {
        if (msg.method === "initialize") respond(rec.proc, { id: msg.id, result: {} });
        if (msg.method === "account/login/start")
          respond(rec.proc, { id: msg.id, result: challengeResult("login-start-2") });
      }),
    );
    await startCodexOAuthLogin("codex-start");
    cancelCodexOAuthLogin("codex-start");

    assert.equal(fs.readFileSync(configFile, "utf8"), "# hand edited\n");
  });

  it("reports a pending login with its login id while the user is still at the browser", async () => {
    useScenario(
      appServer((msg, rec) => {
        if (msg.method === "initialize") respond(rec.proc, { id: msg.id, result: {} });
        if (msg.method === "account/login/start")
          respond(rec.proc, { id: msg.id, result: challengeResult("login-pending") });
      }),
    );

    await startCodexOAuthLogin("codex-pending");
    try {
      const status = codexOAuthStatus("codex-pending");
      assert.equal(status.pending, true);
      assert.equal(status.loginId, "login-pending");
    } finally {
      cancelCodexOAuthLogin("codex-pending");
    }
  });

  it("refuses a second concurrent login for the same owner", async () => {
    useScenario(
      appServer((msg, rec) => {
        if (msg.method === "initialize") respond(rec.proc, { id: msg.id, result: {} });
        if (msg.method === "account/login/start")
          respond(rec.proc, { id: msg.id, result: challengeResult("login-dup") });
      }),
    );

    await startCodexOAuthLogin("codex-dup");
    try {
      await assert.rejects(() => startCodexOAuthLogin("codex-dup"), /already pending for this Telegram user/);
    } finally {
      cancelCodexOAuthLogin("codex-dup");
    }
  });

  it("allows a different owner to log in while one login is pending", async () => {
    useScenario(
      appServer((msg, rec) => {
        if (msg.method === "initialize") respond(rec.proc, { id: msg.id, result: {} });
        if (msg.method === "account/login/start") respond(rec.proc, { id: msg.id, result: challengeResult("login-a") });
      }),
    );

    await startCodexOAuthLogin("codex-owner-a");
    try {
      assert.equal((await startCodexOAuthLogin("codex-owner-b")).loginId, "login-a");
    } finally {
      cancelCodexOAuthLogin("codex-owner-a");
      cancelCodexOAuthLogin("codex-owner-b");
    }
  });

  it("rejects and shuts the process down when codex answers with something other than a device code", async () => {
    useScenario(
      appServer((msg, rec) => {
        if (msg.method === "initialize") respond(rec.proc, { id: msg.id, result: {} });
        if (msg.method === "account/login/start") respond(rec.proc, { id: msg.id, result: { type: "apiKey" } });
      }),
    );

    await assert.rejects(
      () => startCodexOAuthLogin("codex-wrong-type"),
      /did not return a device-code OAuth challenge/,
    );
    assert.equal(spawns[0].proc.killed, true, "the app-server must be shut down");
    assert.equal(codexOAuthStatus("codex-wrong-type").pending, false);
  });

  it("rejects when codex reports an error for the login request", async () => {
    useScenario(
      appServer((msg, rec) => {
        if (msg.method === "initialize") respond(rec.proc, { id: msg.id, result: {} });
        if (msg.method === "account/login/start")
          respond(rec.proc, { id: msg.id, error: { message: "device flow unavailable" } });
      }),
    );

    await assert.rejects(() => startCodexOAuthLogin("codex-rpc-error"), /device flow unavailable/);
    assert.equal(codexOAuthStatus("codex-rpc-error").pending, false);
  });

  it("rejects with the raw error payload when codex omits an error message", async () => {
    useScenario(
      appServer((msg, rec) => {
        if (msg.method === "initialize") respond(rec.proc, { id: msg.id, result: {} });
        if (msg.method === "account/login/start") respond(rec.proc, { id: msg.id, error: { code: -32000 } });
      }),
    );

    await assert.rejects(() => startCodexOAuthLogin("codex-rpc-code"), /-32000/);
  });

  it("rejects when the app-server dies before answering", async () => {
    useScenario(
      appServer((msg, rec) => {
        if (msg.method !== "initialize") return;
        rec.proc.stderr.emit("data", "codex: command not found");
        rec.proc.emit("exit", 127);
      }),
    );

    await assert.rejects(
      () => startCodexOAuthLogin("codex-dead"),
      /exited before request \d+ completed: codex: command not found/,
    );
  });

  it("rejects when codex never answers within the configured start timeout", async () => {
    useScenario(() => {});
    await withEnv({ CODEX_LOGIN_START_TIMEOUT_MS: "20" }, async () => {
      await assert.rejects(() => startCodexOAuthLogin("codex-silent"), /Codex app-server request \d+ timed out/);
    });

    // The initialize await used to sit outside the try that owns the cleanup, so a
    // timeout here left the app-server running with no handle to it anywhere. This
    // assertion is the guard for that: without it the leak is invisible.
    assert.equal(spawns[0].proc.killed, true, "a codex that never answers initialize must still be shut down");
  });

  it("parses replies that arrive split across chunks and ignores non-json log noise", async () => {
    useScenario(
      appServer((msg, rec) => {
        if (msg.method === "initialize") {
          const line = JSON.stringify({ id: msg.id, result: { platformOs: "test" } });
          rec.proc.stdout.emit("data", "codex: starting up\n\n");
          rec.proc.stdout.emit("data", line.slice(0, 10));
          rec.proc.stdout.emit("data", `${line.slice(10)}\n`);
        }
        if (msg.method === "account/login/start")
          respond(rec.proc, { id: msg.id, result: challengeResult("login-chunked") });
      }),
    );

    const challenge = await startCodexOAuthLogin("codex-chunked");
    try {
      assert.equal(challenge.loginId, "login-chunked");
    } finally {
      cancelCodexOAuthLogin("codex-chunked");
    }
  });
});

describe("codex OAuth login completion", () => {
  after(() => {
    useScenario(() => {});
  });

  it("reports success and records the session once codex writes the auth file", async () => {
    useScenario(
      appServer((msg, rec) => {
        if (msg.method === "initialize") respond(rec.proc, { id: msg.id, result: {} });
        if (msg.method === "account/login/start") {
          respond(rec.proc, { id: msg.id, result: challengeResult("login-ok") });
          setImmediate(() => {
            fs.writeFileSync(
              path.join(rec.options.env.CODEX_HOME, "auth.json"),
              JSON.stringify({ mode: "chatgpt", accessToken: "granted" }),
            );
            respond(rec.proc, {
              method: "account/login/completed",
              params: { loginId: "login-ok", success: true, error: null },
            });
          });
        }
      }),
    );

    let completion;
    await startCodexOAuthLogin("codex-complete", (result) => {
      completion = result;
    });
    await sleep(30);

    assert.deepEqual(completion, { success: true, error: undefined });
    assert.equal(hasCodexOAuthSession("codex-complete"), true);
    assert.equal(codexOAuthStatus("codex-complete").pending, false);
    assert.equal(spawns[0].proc.killed, true, "the app-server must be shut down once the login resolves");
    assert.equal(fs.statSync(codexAuthFile("codex-complete")).mode & 0o777, 0o600, "the auth file must be locked down");
  });

  it("reports the failure codex sent when the user declines, leaving no session behind", async () => {
    useScenario(
      appServer((msg, rec) => {
        if (msg.method === "initialize") respond(rec.proc, { id: msg.id, result: {} });
        if (msg.method === "account/login/start") {
          respond(rec.proc, { id: msg.id, result: challengeResult("login-denied") });
          setImmediate(() =>
            respond(rec.proc, {
              method: "account/login/completed",
              params: { loginId: "login-denied", success: false, error: "user cancelled" },
            }),
          );
        }
      }),
    );

    let completion;
    await startCodexOAuthLogin("codex-denied", (result) => {
      completion = result;
    });
    await sleep(30);

    assert.deepEqual(completion, { success: false, error: "user cancelled" });
    assert.equal(hasCodexOAuthSession("codex-denied"), false);
    assert.equal(codexOAuthStatus("codex-denied").pending, false);
  });

  it("ignores a completion belonging to a different login attempt", async () => {
    let seen = 0;
    useScenario(
      appServer((msg, rec) => {
        if (msg.method === "initialize") respond(rec.proc, { id: msg.id, result: {} });
        if (msg.method === "account/login/start") {
          respond(rec.proc, { id: msg.id, result: challengeResult("login-mine") });
          setImmediate(() =>
            respond(rec.proc, {
              method: "account/login/completed",
              params: { loginId: "someone-elses-login", success: true },
            }),
          );
        }
      }),
    );

    await startCodexOAuthLogin("codex-crossed", () => {
      seen += 1;
    });
    await sleep(30);
    assert.equal(seen, 0, "a completion for another login must not resolve this one");
    assert.equal(codexOAuthStatus("codex-crossed").pending, true, "this login must still be waiting");

    // Positive control: the matching notification does resolve it, so the
    // check above is the login id filter working rather than a dead channel.
    respond(spawns[0].proc, { method: "account/login/completed", params: { loginId: "login-mine", success: true } });
    await sleep(10);
    assert.equal(seen, 1);
    assert.equal(codexOAuthStatus("codex-crossed").pending, false);
  });

  it("gives up on a login the user never finishes, once the configured window closes", async () => {
    useScenario(
      appServer((msg, rec) => {
        if (msg.method === "initialize") respond(rec.proc, { id: msg.id, result: {} });
        if (msg.method === "account/login/start")
          respond(rec.proc, { id: msg.id, result: challengeResult("login-slow") });
      }),
    );

    let completion;
    await withEnv({ CODEX_LOGIN_TIMEOUT_MS: "25" }, async () => {
      await startCodexOAuthLogin("codex-abandoned", (result) => {
        completion = result;
      });
      await sleep(80);
    });

    assert.deepEqual(completion, { success: false, error: "Codex OAuth login timed out" });
    assert.equal(codexOAuthStatus("codex-abandoned").pending, false);
    assert.equal(spawns[0].proc.killed, true);
  });

  it("does not fire the abandonment timer for a login that already finished", async () => {
    useScenario(
      appServer((msg, rec) => {
        if (msg.method === "initialize") respond(rec.proc, { id: msg.id, result: {} });
        if (msg.method === "account/login/start") {
          respond(rec.proc, { id: msg.id, result: challengeResult("login-quick") });
          setImmediate(() => {
            fs.writeFileSync(path.join(rec.options.env.CODEX_HOME, "auth.json"), JSON.stringify({ mode: "chatgpt" }));
            respond(rec.proc, { method: "account/login/completed", params: { loginId: "login-quick", success: true } });
          });
        }
      }),
    );

    const results = [];
    await withEnv({ CODEX_LOGIN_TIMEOUT_MS: "25" }, async () => {
      await startCodexOAuthLogin("codex-quick", (result) => {
        results.push(result);
      });
      await sleep(80);
    });

    assert.deepEqual(
      results,
      [{ success: true, error: undefined }],
      "the timeout must not report a second, contradictory outcome",
    );
  });
});

describe("codex OAuth login cancellation", () => {
  after(() => {
    useScenario(() => {});
  });

  it("reports that there is nothing to cancel for an owner with no pending login", () => {
    assert.equal(cancelCodexOAuthLogin("codex-nothing-pending"), false);
  });

  it("tells codex to cancel the login and shuts the process down", async () => {
    useScenario(
      appServer((msg, rec) => {
        if (msg.method === "initialize") respond(rec.proc, { id: msg.id, result: {} });
        if (msg.method === "account/login/start")
          respond(rec.proc, { id: msg.id, result: challengeResult("login-cancel-me") });
      }),
    );

    await startCodexOAuthLogin("codex-cancel");
    assert.equal(cancelCodexOAuthLogin("codex-cancel"), true);

    const written = spawns[0].proc.stdin.written;
    assert.match(written, /"account\/login\/cancel"/);
    assert.match(written, /login-cancel-me/);
    assert.equal(spawns[0].proc.killed, true);
    assert.equal(codexOAuthStatus("codex-cancel").pending, false);
  });

  it("shuts down a login cancelled before codex issued a login id", async () => {
    // Cancelled from inside the `account/login/start` handler, which is the
    // one moment the pending record exists without a login id yet. The result
    // is recorded rather than asserted, because the handler runs on a timer
    // callback where a throw would escape the test.
    let cancelledEarly;
    let completions = 0;
    useScenario(
      appServer((msg, rec) => {
        if (msg.method === "initialize") respond(rec.proc, { id: msg.id, result: {} });
        if (msg.method === "account/login/start") {
          cancelledEarly = cancelCodexOAuthLogin("codex-early-cancel");
          respond(rec.proc, { id: msg.id, result: challengeResult("login-too-late") });
        }
      }),
    );

    await withEnv({ CODEX_LOGIN_TIMEOUT_MS: "20" }, async () => {
      const challenge = await startCodexOAuthLogin("codex-early-cancel", () => {
        completions += 1;
      });
      assert.equal(cancelledEarly, true, "precondition: the login was cancelled while it was still pending");
      assert.equal(challenge.loginId, "login-too-late");
      assert.equal(codexOAuthStatus("codex-early-cancel").pending, false);
      assert.equal(
        spawns[0].proc.stdin.written.includes("account/login/cancel"),
        false,
        "there is no login id to cancel yet",
      );
      await sleep(60);
      assert.equal(completions, 0, "a cancelled login must not report a completion, not even a timeout");
    });
  });

  it("drops the pending login when the owner logs out mid-flow", async () => {
    useScenario(
      appServer((msg, rec) => {
        if (msg.method === "initialize") respond(rec.proc, { id: msg.id, result: {} });
        if (msg.method === "account/login/start")
          respond(rec.proc, { id: msg.id, result: challengeResult("login-logout") });
      }),
    );

    seedCodexSession("codex-logout-midflow");
    await startCodexOAuthLogin("codex-logout-midflow");
    assert.equal(codexOAuthStatus("codex-logout-midflow").pending, true, "precondition: a login is in flight");

    assert.equal(logoutCodexOAuth("codex-logout-midflow"), true);
    assert.equal(codexOAuthStatus("codex-logout-midflow").pending, false);
    assert.equal(hasCodexOAuthSession("codex-logout-midflow"), false);
  });
});

describe("codex plan execution", () => {
  const owner = "codex-planner";

  before(() => {
    seedCodexSession(owner);
  });
  after(() => {
    useScenario(() => {});
  });

  it("refuses to plan for an owner who has not connected codex", async () => {
    useScenario(() => {});
    await assert.rejects(
      () => completeCodexOAuthPlan("codex-unconnected", "gpt-5-codex", { systemPrompt: "s", userPrompt: "u" }),
      /Codex OAuth is not connected for this Telegram user/,
    );
    assert.equal(spawns.length, 0, "nothing should be spawned for a disconnected owner");
  });

  it("returns the plan codex wrote to its output file", async () => {
    useScenario(
      execRun({ output: JSON.stringify({ summary: "s", commands: ["/limit BTC BUY 100 1"], riskNotes: [] }) }),
    );
    const plan = await completeCodexOAuthPlan(owner, "gpt-5-codex", { systemPrompt: "sys", userPrompt: "usr" });
    assert.deepEqual(plan.commands, ["/limit BTC BUY 100 1"]);
  });

  it("runs codex read-only, off the prompt on stdin, against a schema and an output file", async () => {
    const { args, proc } = spawns[0];
    assert.equal(args[0], "exec");
    assert.equal(args[args.length - 1], "-");
    assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
    assert.ok(args.includes("--output-schema"));
    assert.ok(args.includes("--output-last-message"));
    assert.match(proc.stdin.written, /sys\n\nusr/);
    assert.equal(
      args.some((arg) => String(arg).includes("usr")),
      false,
      "the prompt must not be visible in argv",
    );
  });

  it("passes the requested model through and drops the placeholder default", async () => {
    assert.deepEqual(spawns[0].args.slice(spawns[0].args.indexOf("--model"), spawns[0].args.indexOf("--model") + 2), [
      "--model",
      "gpt-5-codex",
    ]);

    useScenario(execRun({ output: JSON.stringify({ summary: "s", commands: [], riskNotes: [] }) }));
    await completeCodexOAuthPlan(owner, "default", { systemPrompt: "s", userPrompt: "u" });
    assert.equal(spawns[0].args.includes("--model"), false, "the placeholder model name must not be forwarded");
  });

  it("deletes the plan output file once it has been read", async () => {
    useScenario(execRun({ output: JSON.stringify({ summary: "s", commands: [], riskNotes: [] }) }));
    await completeCodexOAuthPlan(owner, "default", { systemPrompt: "s", userPrompt: "u" });
    const outputPath = spawns[0].args[spawns[0].args.indexOf("--output-last-message") + 1];
    assert.equal(fs.existsSync(outputPath), false, "the plan must not be left on disk");
  });

  it("writes the response schema codex is asked to honour", async () => {
    const schemaPath = spawns[0].args[spawns[0].args.indexOf("--output-schema") + 1];
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    assert.deepEqual(schema.required, ["summary", "commands", "riskNotes"]);
    assert.equal(schema.additionalProperties, false);
  });

  it("reads the plan off stdout when codex writes no output file", async () => {
    useScenario(execRun({ stdout: JSON.stringify({ summary: "from stdout", commands: [], riskNotes: [] }) }));
    const plan = await completeCodexOAuthPlan(owner, "default", { systemPrompt: "s", userPrompt: "u" });
    assert.equal(plan.summary, "from stdout");
  });

  it("unwraps a fenced json block", async () => {
    useScenario(execRun({ output: '```json\n{"summary":"fenced","commands":[],"riskNotes":[]}\n```' }));
    assert.equal(
      (await completeCodexOAuthPlan(owner, "default", { systemPrompt: "s", userPrompt: "u" })).summary,
      "fenced",
    );
  });

  it("extracts the json object when codex wraps it in prose", async () => {
    useScenario(
      execRun({ output: 'Here is the plan:\n{"summary":"embedded","commands":[],"riskNotes":[]}\nHope that helps.' }),
    );
    assert.equal(
      (await completeCodexOAuthPlan(owner, "default", { systemPrompt: "s", userPrompt: "u" })).summary,
      "embedded",
    );
  });

  it("rejects an empty plan", async () => {
    useScenario(execRun({ output: "   " }));
    await assert.rejects(
      () => completeCodexOAuthPlan(owner, "default", { systemPrompt: "s", userPrompt: "u" }),
      /Codex returned an empty plan/,
    );
  });

  it("rejects output that contains no json object at all", async () => {
    useScenario(execRun({ output: "I refuse to answer." }));
    await assert.rejects(
      () => completeCodexOAuthPlan(owner, "default", { systemPrompt: "s", userPrompt: "u" }),
      /Codex did not return a JSON object/,
    );
  });

  it("rejects output whose json object is malformed", async () => {
    useScenario(execRun({ output: '{"summary": "broken", commands: }' }));
    await assert.rejects(() => completeCodexOAuthPlan(owner, "default", { systemPrompt: "s", userPrompt: "u" }));
  });

  it("reports the codex stderr when the process exits non-zero", async () => {
    useScenario(execRun({ exitCode: 3, stderr: "model quota exhausted" }));
    await assert.rejects(
      () => completeCodexOAuthPlan(owner, "gpt-5-codex", { systemPrompt: "s", userPrompt: "u" }),
      /Codex strategy planning failed: model quota exhausted/,
    );
  });

  it("reports a plain failure when the process exits non-zero silently", async () => {
    useScenario(execRun({ exitCode: 1 }));
    await assert.rejects(
      () => completeCodexOAuthPlan(owner, "default", { systemPrompt: "s", userPrompt: "u" }),
      /^Error: Codex strategy planning failed$/,
    );
  });

  it("treats an exit with no status code as a success", async () => {
    useScenario(
      execRun({ output: JSON.stringify({ summary: "no code", commands: [], riskNotes: [] }), exitCode: null }),
    );
    assert.equal(
      (await completeCodexOAuthPlan(owner, "default", { systemPrompt: "s", userPrompt: "u" })).summary,
      "no code",
    );
  });

  it("propagates a spawn error", async () => {
    useScenario(execRun({ errorMessage: "spawn codex-test-bin ENOENT" }));
    await assert.rejects(
      () => completeCodexOAuthPlan(owner, "default", { systemPrompt: "s", userPrompt: "u" }),
      /ENOENT/,
    );
  });

  it("kills codex and reports a timeout when it never exits", async () => {
    useScenario(execRun({ exit: false }));
    await withEnv({ CODEX_EXEC_TIMEOUT_MS: "25" }, async () => {
      await assert.rejects(
        () => completeCodexOAuthPlan(owner, "default", { systemPrompt: "s", userPrompt: "u" }),
        /Codex strategy planning timed out/,
      );
    });
    assert.equal(spawns[0].proc.killed, true, "a timed-out codex run must be killed");
  });
});

describe("codex child process environment", () => {
  const owner = "codex-env";

  before(() => {
    seedCodexSession(owner);
  });
  after(() => {
    useScenario(() => {});
  });

  const hostSecrets = {
    TELEGRAM_BOT_TOKEN: "telegram-token-must-not-reach-codex",
    TRADE_API_KEY: "trade-key-must-not-reach-codex",
    TRADE_API_SECRET: "trade-secret-must-not-reach-codex",
    TELEGRAM_SESSION_ENCRYPTION_KEY: ENCRYPTION_KEY,
  };

  it("hands codex a scrubbed environment on the success path", async () => {
    useScenario(execRun({ output: JSON.stringify({ summary: "s", commands: [], riskNotes: [] }) }));
    await withEnv(hostSecrets, async () => {
      await completeCodexOAuthPlan(owner, "default", { systemPrompt: "s", userPrompt: "u" });
      assertScrubbed(spawns[0].options.env, owner);
    });
  });

  it("hands codex a scrubbed environment on the failure path too", async () => {
    useScenario(execRun({ exitCode: 2, stderr: "nope" }));
    await withEnv(hostSecrets, async () => {
      await assert.rejects(() => completeCodexOAuthPlan(owner, "default", { systemPrompt: "s", userPrompt: "u" }));
      assertScrubbed(spawns[0].options.env, owner);
    });
  });

  it("hands the login app-server a scrubbed environment when the login fails", async () => {
    useScenario(
      appServer((msg, rec) => {
        if (msg.method === "initialize") respond(rec.proc, { id: msg.id, result: {} });
        if (msg.method === "account/login/start") respond(rec.proc, { id: msg.id, error: { message: "nope" } });
      }),
    );
    await withEnv(hostSecrets, async () => {
      await assert.rejects(() => startCodexOAuthLogin("codex-env-login"), /nope/);
      assertScrubbed(spawns[0].options.env, "codex-env-login");
    });
  });

  it("forwards a configured ca certificate so codex can reach the network", async () => {
    useScenario(execRun({ output: JSON.stringify({ summary: "s", commands: [], riskNotes: [] }) }));
    await withEnv({ CODEX_CA_CERTIFICATE: "/etc/ssl/corp.pem" }, () =>
      completeCodexOAuthPlan(owner, "default", { systemPrompt: "s", userPrompt: "u" }),
    );
    assert.equal(spawns[0].options.env.CODEX_CA_CERTIFICATE, "/etc/ssl/corp.pem");
  });

  it("falls back to the standard ssl certificate variable", async () => {
    useScenario(execRun({ output: JSON.stringify({ summary: "s", commands: [], riskNotes: [] }) }));
    await withEnv({ SSL_CERT_FILE: "/etc/ssl/system.pem" }, () =>
      completeCodexOAuthPlan(owner, "default", { systemPrompt: "s", userPrompt: "u" }),
    );
    assert.equal(spawns[0].options.env.CODEX_CA_CERTIFICATE, "/etc/ssl/system.pem");
  });

  it("sends no ca certificate when none is configured", async () => {
    useScenario(execRun({ output: JSON.stringify({ summary: "s", commands: [], riskNotes: [] }) }));
    await completeCodexOAuthPlan(owner, "default", { systemPrompt: "s", userPrompt: "u" });
    assert.ok(spawns[0].options.env.CODEX_HOME, "precondition: codex did receive an environment");
    assert.equal("CODEX_CA_CERTIFICATE" in spawns[0].options.env, false);
  });

  it("runs the packaged codex binary when none is configured", async () => {
    useScenario(execRun({ output: JSON.stringify({ summary: "s", commands: [], riskNotes: [] }) }));
    await withEnv({ CODEX_BIN: undefined }, () =>
      completeCodexOAuthPlan(owner, "default", { systemPrompt: "s", userPrompt: "u" }),
    );
    assert.equal(spawns[0].cmd, "codex");
  });

  /**
   * Codex must be handed a home of its own and none of the host's secrets.
   * The `PATH`/`CODEX_HOME` checks are the positive control: without them the
   * absence assertions would pass against an empty environment.
   */
  function assertScrubbed(env, ownerId) {
    assert.ok(env.PATH, "codex must still receive a PATH");
    assert.equal(env.CODEX_HOME, codexHomeForOwner(ownerId));
    assert.equal(env.HOME, codexHomeForOwner(ownerId));
    assert.equal(env.USERPROFILE, codexHomeForOwner(ownerId));
    assert.equal(env.NO_COLOR, "1");
    for (const key of [
      "TELEGRAM_BOT_TOKEN",
      "TRADE_API_KEY",
      "TRADE_API_SECRET",
      "TELEGRAM_SESSION_ENCRYPTION_KEY",
      "QUOTE_TRADE_STATE_DIR",
    ]) {
      assert.ok(process.env[key], `precondition: ${key} is set on the host, so its absence below is meaningful`);
      assert.equal(env[key], undefined, `${key} must not reach the codex child process`);
    }
  }
});
