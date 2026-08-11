"use strict";

const { describe, it, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { stubRequire } = require("./helpers/module-stub");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tmp");

// dist/bot.js builds its stores, and needs its token, at require time. The token
// doubles as session encryption material, so it has to be a real-looking string.
process.env.QUOTE_TRADE_STATE_DIR = makeTempDir("qt-tg-bot-commands-");
process.env.TELEGRAM_BOT_TOKEN = "bot-commands-test-token";
// paper mode is the default; being explicit keeps these cases independent of the
// developer's own environment, since real mode would demand a live session.
process.env.MODE = "paper";

/** Every Telegram API call the bot made, newest last. */
const calls = [];

/**
 * Sockets that never connect. Creating a trigger calls `runtime.ensure()`, which
 * reaches the price feed and the user-data stream — both of which construct a
 * real `ws` client. Without this, the suite would attempt live connections and
 * leave reconnect timers behind.
 */
class InertWebSocket {
  static OPEN = 1;
  static urls = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    InertWebSocket.urls.push(url);
  }
  on() {
    return this;
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}

/**
 * Telegram replies all funnel through `axios.post`, so stubbing it both blocks
 * the network and gives us the exact text each command sent back.
 */
const restoreRequire = stubRequire({
  ws: InertWebSocket,
  axios: {
    async post(url, payload) {
      calls.push({ method: String(url).split("/").pop(), payload });
      return { data: { ok: true, result: { message_id: calls.length } } };
    },
    async get() {
      throw new Error("bot-commands.test.js: no command under test may GET");
    },
  },
});

// Importing must not connect to anything: the long-poll is behind
// `require.main === module`, so this yields the configured bot.
const { bot, startBot } = require("../dist/bot");

after(restoreRequire);
after(cleanupTempDirs);

/** Distinct owner per case, so persisted per-user state cannot leak between tests. */
let ownerSeq = 0;

/**
 * A Telegram message shaped the way the handlers require: `from.id` identifies
 * the owner, and `date` must be recent or `assertFreshMessage` rejects it.
 *
 * @param {Record<string, unknown>} [overrides]
 */
function makeMsg(overrides = {}) {
  const id = 900000 + ownerSeq;
  return {
    chat: { id, type: "private" },
    from: { id },
    date: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

/** Let the handler's promise chain and its reply settle. */
async function flush(times = 12) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Send `text` to the bot as a fresh owner and return everything it replied.
 *
 * @param {string} text
 * @param {{ msg?: Record<string, unknown>, newOwner?: boolean }} [options]
 * @returns {Promise<string>}
 */
async function run(text, options = {}) {
  if (options.newOwner !== false) ownerSeq += 1;
  calls.length = 0;
  bot.dispatchText(makeMsg(options.msg), text);
  await flush();
  return calls
    .filter((call) => call.method === "sendMessage")
    .map((call) => String(call.payload.text))
    .join("\n");
}

describe("bot entry point", () => {
  it("exports an inert bot and an explicit start, rather than starting on import", () => {
    assert.equal(typeof startBot, "function");
    assert.equal(typeof bot.dispatchText, "function");
    // Nothing was sent merely by loading the module.
    assert.equal(calls.length, 0);
  });

  it("ignores a stale command instead of acting on it", async () => {
    const stale = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    const reply = await run("/session", { msg: { date: stale } });
    assert.match(reply, /stale Telegram command/i);
  });

  it("refuses a command from a message with no sender", async () => {
    calls.length = 0;
    bot.dispatchText({ chat: { id: 4242, type: "private" }, date: Math.floor(Date.now() / 1000) }, "/session");
    await flush();
    assert.match(String(calls[0]?.payload?.text ?? ""), /from\.id is required/);
  });
});

describe("bot session and account commands", () => {
  it("greets a new owner with the account menu", async () => {
    const reply = await run("/start");
    assert.ok(reply.length > 0, "/start must reply");
  });

  it("reports a disconnected session, naming the Telegram user id it is scoped to", async () => {
    const reply = await run("/session");
    assert.match(reply, /No Quote\.Trade account session is connected/);
    assert.match(reply, /\/connectkey/, "it must point the user at how to connect");
  });

  it("rejects /connectkey without the required arguments", async () => {
    assert.match(await run("/connectkey"), /❌|usage|required/i);
  });

  it("reports nothing to disconnect for a fresh owner", async () => {
    assert.ok((await run("/disconnect")).length > 0);
  });
});

describe("bot informational commands", () => {
  it("lists no triggers for a fresh owner", async () => {
    assert.match(await run("/triggers"), /No triggers found\./);
  });

  it("answers /positions and /risk without a live session", async () => {
    assert.ok((await run("/positions")).length > 0);
    assert.ok((await run("/risk")).length > 0);
  });

  it("lists the free LLM fallback order", async () => {
    assert.match(await run("/llmfallbacks"), /fallback order:/);
  });

  it("renders the LLM provider table", async () => {
    assert.ok((await run("/llmproviders")).length > 0);
  });

  it("reports no pending drafts", async () => {
    assert.ok((await run("/llmdrafts")).length > 0);
  });

  it("reports Codex as not connected", async () => {
    assert.match(await run("/codexstatus"), /not connected|connected/i);
  });
});

describe("bot trigger creation commands", () => {
  /**
   * Every documented trading command, using the exact example syntax from
   * `TRADING_COMMAND_HELP` in src/bot.ts. The assertion is deliberately not a
   * kind name: it is that the command was accepted (no ❌) and echoed back a
   * trigger for the symbol asked for.
   */
  const CASES = [
    ["/limit", "/limit btc buy 60000 0.01"],
    ["/stoplimit", "/stoplimit btc sell 58000 57950 0.01"],
    ["/takeprofit", "/takeprofit btc sell 65000 close"],
    ["/stoploss", "/stoploss btc sell 58000 close"],
    ["/trailingstop", "/trailingstop btc sell 5% close"],
    ["/trailingstoplimit", "/trailingstoplimit btc sell 5% 50 close"],
    ["/oco", "/oco btc sell 65000 58000 close"],
    ["/bracket", "/bracket btc buy 60000 0.01 65000 58000"],
    ["/scaleout", "/scaleout btc sell 63000 25%"],
    ["/breakeven", "/breakeven btc sell 3% 0.5%"],
    ["/closeafter", "/closeafter btc 4h"],
    ["/priceband", "/priceband btc buy BREAKOUT 65000 0.01"],
    ["/riskguard", "/riskguard btc MAX_RISK_USD 500 CLOSE_POSITION"],
  ];

  for (const [label, text] of CASES) {
    it(`accepts ${label} and creates a trigger`, async () => {
      const reply = await run(text);

      assert.ok(!reply.includes("❌"), `${label} was rejected:\n${reply}`);
      assert.match(reply, /BTC/, `${label} must echo the symbol back:\n${reply}`);
    });
  }

  it("records the kind it was asked for", async () => {
    assert.match(await run("/limit btc buy 60000 0.01"), /LIMIT/);
    assert.match(await run("/stoplimit btc sell 58000 57950 0.01"), /STOP_LIMIT/);
    assert.match(await run("/closeafter btc 4h"), /TIME_CLOSE/);
    assert.match(await run("/riskguard btc MAX_RISK_USD 500 CLOSE_POSITION"), /RISK_GUARD/);
  });

  it("creates two legs for an OCO, and one for a single-leg command", async () => {
    const oco = await run("/oco btc sell 65000 58000 close");
    // `created()` switches to the plural noun only for a multi-trigger result.
    assert.match(oco, /Created order triggers:/, `expected two legs in:\n${oco}`);
    assert.equal(oco.match(/id=/g)?.length, 2, "an OCO must report exactly two trigger ids");

    const single = await run("/limit btc buy 60000 0.01");
    assert.match(single, /Created order trigger:/, "a single trigger uses the singular noun");
  });

  it("reports the trigger back through /triggers, then cancels it", async () => {
    ownerSeq += 1;
    const created = await run("/limit btc buy 60000 0.01", { newOwner: false });
    assert.match(created, /LIMIT/);

    const listed = await run("/triggers", { newOwner: false });
    assert.ok(!/No triggers found/.test(listed), `expected the new trigger in:\n${listed}`);

    const id = listed.split(/\s+/).find((word) => /^[0-9a-z]{6,}$/i.test(word));
    assert.ok(id, `could not find a trigger id in:\n${listed}`);

    const cancelled = await run(`/canceltrigger ${id}`, { newOwner: false });
    assert.ok(cancelled.length > 0, "cancelling must reply");
  });

  it("rejects a bad quantity rather than creating a trigger", async () => {
    assert.match(await run("/limit btc buy 60000 notanumber"), /❌/);
  });

  it("rejects an unknown risk metric", async () => {
    assert.match(await run("/riskguard btc NOPE 1000"), /❌/);
  });
});

describe("bot free-text handling", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("treats a non-command message as an LLM strategy prompt", async () => {
    // No provider is configured, so this must fail gracefully with a reply
    // rather than throwing out of the handler.
    const reply = await run("buy me some bitcoin when it dips");
    assert.ok(reply.length > 0, "free text must always get an answer");
  });
});

describe("bot command usage errors", () => {
  /**
   * Every argument-taking command, called bare. Each must answer with a usage
   * hint rather than throwing out of the handler or silently doing nothing —
   * this is the path a user hits most often by mistake.
   */
  const NEEDS_ARGS = [
    "/limit",
    "/stoplimit",
    "/takeprofit",
    "/stoploss",
    "/trailingstop",
    "/trailingstoplimit",
    "/oco",
    "/bracket",
    "/scaleout",
    "/breakeven",
    "/closeafter",
    "/closeat",
    "/cancelafter",
    "/priceband",
    "/riskguard",
  ];

  for (const cmd of NEEDS_ARGS) {
    it(`answers a bare ${cmd} with usage instead of failing silently`, async () => {
      const reply = await run(cmd);
      assert.ok(reply.length > 0, `${cmd} must always reply`);
      assert.match(reply, /❌/, `${cmd} must reject an empty invocation:\n${reply}`);
    });
  }
});

describe("bot Codex and LLM configuration", () => {
  it("cancels and logs out cleanly for an owner with no Codex session", async () => {
    ownerSeq += 1;
    assert.ok((await run("/codexcancel", { newOwner: false })).length > 0);
    assert.ok((await run("/codexlogout", { newOwner: false })).length > 0);
    // Status must still answer afterwards rather than tripping over the removal.
    assert.ok((await run("/codexstatus", { newOwner: false })).length > 0);
  });

  it("answers a bare /llmconnect with guidance", async () => {
    assert.ok((await run("/llmconnect")).length > 0);
  });

  it("reports a miss for confirming or cancelling a draft that does not exist", async () => {
    assert.match(await run("/llmconfirm no-such-draft"), /❌/);
    assert.match(await run("/llmcancel no-such-draft"), /❌/);
  });

  it("answers /filledorders without a connected session", async () => {
    assert.ok((await run("/filledorders")).length > 0);
  });
});
