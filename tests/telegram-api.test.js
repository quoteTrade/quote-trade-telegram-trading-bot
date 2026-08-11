"use strict";

const { describe, it, before, beforeEach, after, mock } = require("node:test");
const assert = require("node:assert/strict");

const { stubRequire } = require("./helpers/module-stub");

/**
 * A token shaped like a real one. Every assertion about URL construction and
 * about log hygiene keys off this exact string, so it must be distinctive
 * enough that an accidental substring match is impossible.
 */
const TOKEN = "123456789:AA-telegram-api-test-secret-token";

/** Timers captured before any test can mock them, for the test harness's own use. */
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;

/** Every request the fake axios saw, oldest first. Reset before each case. */
const requests = [];

/** Pending `waitForRequests` waiters: `{ n, resolve }`. */
const waiters = [];

/** What the fake axios answers with. Replaced per case. */
let responder = defaultResponder;

function defaultResponder() {
  return okResponse({ message_id: 1 });
}

/** The success envelope the Telegram Bot API returns: `{ ok, result }`. */
function okResponse(result) {
  return { data: { ok: true, result } };
}

/**
 * An axios rejection as it looks when Telegram answers with a non-2xx status:
 * the description lives on `error.response.data.description`.
 */
function httpError(status, description) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data: { description } };
  return error;
}

/**
 * Stands in for `axios`. Records the outbound POST instead of reaching
 * api.telegram.org and delegates the answer to the current `responder`.
 *
 * The `await null` matters: the poll loop is started from the constructor, so
 * without yielding once, `responder` would run before `new TelegramBot(...)`
 * has even returned and no case could reference the bot it is answering.
 */
const axiosStub = {
  async post(url, body, config) {
    const call = { url, body, config };
    requests.push(call);
    for (const waiter of waiters.splice(0)) {
      if (requests.length >= waiter.n) waiter.resolve();
      else waiters.push(waiter);
    }
    await null;
    return responder(call);
  },
};

// Must run before anything from `../dist/` is required: the Telegram client does
// `const axios = require('axios')` once, at module load time.
const restoreRequire = stubRequire({ axios: axiosStub });

const TelegramBot = require("../dist/utils/telegram-bot").default;
const botUtils = require("../dist/bot.utils");
const { formatTriggers: formatTriggersImpl } = require("../dist/triggers/format");

/** Env vars the client reads; snapshotted so cases cannot leak into each other. */
const ENV_KEYS = ["TELEGRAM_IP_FAMILY", "TELEGRAM_CALLBACK_TIMEOUT_MS", "SLOW_REQUEST_LOG_MS"];
const savedEnv = {};

/** Every bot built by a case, so `after` can guarantee no poll loop outlives the file. */
const bots = [];

function makeBot(options = {}) {
  const bot = new TelegramBot(TOKEN, options);
  bots.push(bot);
  return bot;
}

/**
 * A polling bot whose `getUpdates` answers come from `steps`, one per poll.
 *
 * Each step is `(call, bot) => response` and the *last* step it wants to run
 * must call `bot.stopPolling()`; once the script is exhausted the loop is
 * stopped anyway, because a poll loop that keeps spinning would hang the runner
 * rather than fail it.
 */
function pollingBot(options, steps) {
  let index = 0;
  let bot;
  responder = (call) => {
    const step = steps[index++];
    if (!step) {
      bot.stopPolling();
      return okResponse([]);
    }
    return step(call, bot);
  };
  bot = makeBot({ polling: true, ...options });
  return bot;
}

/** Resolves once the fake axios has seen `n` requests; rejects rather than hanging. */
function waitForRequests(n) {
  if (requests.length >= n) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = realSetTimeout(
      () => reject(new Error(`timed out waiting for ${n} requests, saw ${requests.length}`)),
      2_000,
    );
    timer.unref?.();
    waiters.push({
      n,
      resolve: () => {
        realClearTimeout(timer);
        resolve();
      },
    });
  });
}

/** Let every already-queued microtask and immediate run to completion. */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/** Collect `console.warn` arguments for the duration of one test. */
function captureWarnings(t) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args);
  t.after(() => {
    console.warn = original;
  });
  return warnings;
}

/**
 * Put `Date.now()` under test control so elapsed-time behaviour can be driven
 * without sleeping. Only `Date` is faked here; `setTimeout` stays real unless a
 * case asks for it explicitly.
 */
function mockClock(t, apis = ["Date"]) {
  mock.timers.enable({ apis });
  t.after(() => mock.timers.reset());
}

before(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  requests.length = 0;
  waiters.length = 0;
  responder = defaultResponder;
});

after(() => {
  for (const bot of bots.splice(0)) bot.stopPolling();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

after(restoreRequire);

describe("Telegram API request construction", () => {
  it("refuses to construct without a token", () => {
    assert.throws(() => new TelegramBot(""), { message: "Telegram bot token is required" });
    assert.throws(() => new TelegramBot(undefined), { message: "Telegram bot token is required" });
    assert.equal(requests.length, 0);
  });

  it("addresses api.telegram.org with the bot token in the path segment", async () => {
    await makeBot().sendMessage(42, "hello");

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  });

  it("routes through a custom api base url when one is configured", async () => {
    await makeBot({ apiBaseUrl: "http://127.0.0.1:8081" }).sendMessage(42, "hello");

    assert.equal(requests[0].url, `http://127.0.0.1:8081/bot${TOKEN}/sendMessage`);
  });

  it("pins requests to IPv4 by default and for an unrecognised family", async () => {
    const bot = makeBot();
    await bot.sendMessage(1, "a");
    assert.equal(requests[0].config.family, 4);

    process.env.TELEGRAM_IP_FAMILY = "10";
    await bot.sendMessage(1, "b");
    assert.equal(requests[1].config.family, 4);
  });

  it("switches to IPv6 only when TELEGRAM_IP_FAMILY selects it", async () => {
    const bot = makeBot();

    process.env.TELEGRAM_IP_FAMILY = "6";
    await bot.sendMessage(1, "a");
    assert.equal(requests[0].config.family, 6);

    process.env.TELEGRAM_IP_FAMILY = "  6  ";
    await bot.sendMessage(1, "b");
    assert.equal(requests[1].config.family, 6, "surrounding whitespace must be trimmed");
  });
});

describe("sendMessage", () => {
  it("sends chat id, text, parse mode and inline keyboard as a single payload", async () => {
    const replyMarkup = {
      inline_keyboard: [[{ text: "✅ Confirm", callback_data: "monitor_cancel_confirm:t-1" }]],
    };

    await makeBot().sendMessage("-1001234", "Cancel this trigger?", {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    });

    assert.deepStrictEqual(requests[0].body, {
      chat_id: "-1001234",
      text: "Cancel this trigger?",
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    });
    assert.equal(requests[0].config.timeout, 35_000);
  });

  it("resolves with the result Telegram reports, not the whole envelope", async () => {
    responder = () => okResponse({ message_id: 777, chat: { id: 42 } });

    const sent = await makeBot().sendMessage(42, "hi");

    assert.deepStrictEqual(sent, { message_id: 777, chat: { id: 42 } });
  });

  it("rejects with the description when a 200 response carries ok:false", async () => {
    responder = () => ({ data: { ok: false, description: "Bad Request: chat not found" } });

    await assert.rejects(makeBot().sendMessage(42, "hi"), {
      message: "Bad Request: chat not found",
    });
    assert.equal(requests.length, 1, "the request must actually have been attempted");
  });

  it("names the failing method when an ok:false response has no description", async () => {
    responder = () => ({ data: { ok: false } });

    await assert.rejects(makeBot().sendMessage(42, "hi"), {
      message: "Telegram API sendMessage failed",
    });
  });

  it("rejects rather than returning undefined when the response has no body", async () => {
    responder = () => ({});

    await assert.rejects(makeBot().sendMessage(42, "hi"), {
      message: "Telegram API sendMessage failed",
    });
  });
});

describe("HTTP failure handling", () => {
  it("surfaces status and description for a rejected 4xx request", async () => {
    responder = () => {
      throw httpError(400, "Bad Request: message text is empty");
    };

    await assert.rejects(makeBot().sendMessage(42, ""), {
      message: "Telegram API sendMessage (400): Bad Request: message text is empty",
    });
  });

  it("surfaces a 429 rate limit to the caller and does not retry it", async () => {
    responder = () => {
      throw httpError(429, "Too Many Requests: retry after 5");
    };

    await assert.rejects(makeBot().sendMessage(42, "flood"), {
      message: "Telegram API sendMessage (429): Too Many Requests: retry after 5",
    });
    assert.equal(requests.length, 1, "the client has no retry/backoff: exactly one attempt");
  });

  it("omits the status when a Telegram error carries no status code", async () => {
    responder = () => {
      const error = new Error("boom");
      error.response = { data: { description: "Unauthorized" } };
      throw error;
    };

    await assert.rejects(makeBot().sendMessage(42, "hi"), {
      message: "Telegram API sendMessage: Unauthorized",
    });
  });

  it("rethrows a transport error unchanged instead of swallowing it", async () => {
    const transportError = new Error("socket hang up");
    transportError.code = "ECONNRESET";
    responder = () => {
      throw transportError;
    };

    const surfaced = await makeBot()
      .sendMessage(42, "hi")
      .then(
        () => null,
        (error) => error,
      );

    assert.equal(surfaced, transportError, "the original error object must reach the caller");
    assert.equal(surfaced.code, "ECONNRESET");
  });
});

describe("answerCallbackQuery", () => {
  it("sends the callback id with caller options and a short default timeout", async () => {
    responder = () => okResponse(true);

    const answered = await makeBot().answerCallbackQuery("cbq-1", {
      text: "Cancelled",
      show_alert: true,
    });

    assert.deepStrictEqual(requests[0].body, {
      callback_query_id: "cbq-1",
      text: "Cancelled",
      show_alert: true,
    });
    assert.equal(requests[0].url, `https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`);
    assert.equal(requests[0].config.timeout, 3_000);
    assert.equal(answered, true);
  });

  it("honours a positive TELEGRAM_CALLBACK_TIMEOUT_MS override", async () => {
    process.env.TELEGRAM_CALLBACK_TIMEOUT_MS = "750";
    responder = () => okResponse(true);

    await makeBot().answerCallbackQuery("cbq-2");

    assert.equal(requests[0].config.timeout, 750);
  });

  it("falls back to 3s when the configured callback timeout is not a positive number", async () => {
    responder = () => okResponse(true);
    const bot = makeBot();

    process.env.TELEGRAM_CALLBACK_TIMEOUT_MS = "0";
    await bot.answerCallbackQuery("cbq-3");
    assert.equal(requests[0].config.timeout, 3_000);

    process.env.TELEGRAM_CALLBACK_TIMEOUT_MS = "soon";
    await bot.answerCallbackQuery("cbq-4");
    assert.equal(requests[1].config.timeout, 3_000);

    process.env.TELEGRAM_CALLBACK_TIMEOUT_MS = "-5";
    await bot.answerCallbackQuery("cbq-5");
    assert.equal(requests[2].config.timeout, 3_000);
  });
});

describe("deleteMessage", () => {
  it("deletes with a 3s timeout so cleanup cannot stall the command", async () => {
    responder = () => okResponse(true);

    await makeBot().deleteMessage(-1001234, 55);

    assert.equal(requests[0].url, `https://api.telegram.org/bot${TOKEN}/deleteMessage`);
    assert.deepStrictEqual(requests[0].body, { chat_id: -1001234, message_id: 55 });
    assert.equal(requests[0].config.timeout, 3_000);
  });

  it("reports a failed delete to the caller rather than resolving quietly", async () => {
    responder = () => {
      throw httpError(400, "Bad Request: message can't be deleted");
    };

    await assert.rejects(makeBot().deleteMessage(1, 2), {
      message: "Telegram API deleteMessage (400): Bad Request: message can't be deleted",
    });
  });
});

describe("slow request logging", () => {
  it("warns with method, elapsed time and outcome once a call crosses the threshold", async (t) => {
    const warnings = captureWarnings(t);
    mockClock(t);
    const bot = makeBot();

    responder = () => okResponse({ message_id: 1 });
    await bot.sendMessage(1, "fast");
    assert.deepStrictEqual(warnings, [], "a call inside the threshold must stay quiet");

    responder = () => {
      mock.timers.tick(5_000);
      return okResponse({ message_id: 2 });
    };
    await bot.sendMessage(1, "slow");

    assert.equal(warnings.length, 1);
    assert.deepStrictEqual(warnings[0], [
      "[SLOW_TELEGRAM_REQUEST]",
      { method: "sendMessage", elapsedMs: 5_000, succeeded: true },
    ]);
  });

  it("records succeeded:false when the slow call also failed", async (t) => {
    const warnings = captureWarnings(t);
    mockClock(t);

    responder = () => {
      mock.timers.tick(2_000);
      throw httpError(500, "Internal Server Error");
    };

    await assert.rejects(makeBot().sendMessage(1, "slow failure"));

    assert.deepStrictEqual(warnings[0], [
      "[SLOW_TELEGRAM_REQUEST]",
      { method: "sendMessage", elapsedMs: 2_000, succeeded: false },
    ]);
  });

  it("never puts the bot token in the slow request warning", async (t) => {
    const warnings = captureWarnings(t);
    mockClock(t);

    responder = () => {
      mock.timers.tick(5_000);
      return okResponse({ message_id: 3 });
    };
    await makeBot().sendMessage(1, "slow");

    // Positive control: the token really is in this code path, so a leak was
    // possible and its absence below is a property of the logging, not of the
    // fixture.
    assert.equal(requests[0].url.includes(TOKEN), true);
    assert.equal(warnings.length, 1, "the log line under inspection must have been emitted");
    assert.equal(JSON.stringify(warnings).includes(TOKEN), false);
    assert.equal(JSON.stringify(warnings).includes("123456789"), false);
  });

  it("respects a custom SLOW_REQUEST_LOG_MS threshold and ignores an invalid one", async (t) => {
    const warnings = captureWarnings(t);
    mockClock(t);
    const bot = makeBot();
    responder = () => {
      mock.timers.tick(5_000);
      return okResponse({ message_id: 1 });
    };

    process.env.SLOW_REQUEST_LOG_MS = "10000";
    await bot.sendMessage(1, "under a raised threshold");
    assert.deepStrictEqual(warnings, []);

    process.env.SLOW_REQUEST_LOG_MS = "nope";
    await bot.sendMessage(1, "invalid threshold falls back to 2s");
    assert.equal(warnings.length, 1, "an unparseable threshold must fall back to the 2s default");
    assert.equal(warnings[0][1].elapsedMs, 5_000, "each call times itself from its own start");
  });

  it("stays quiet about a slow getUpdates poll", async (t) => {
    const warnings = captureWarnings(t);
    mockClock(t);

    const bot = pollingBot({}, [
      (_call, self) => {
        mock.timers.tick(5_000);
        self.stopPolling();
        return okResponse([]);
      },
    ]);
    await waitForRequests(1);
    await flush();

    assert.equal(requests[0].body.timeout, 30, "default long-poll timeout");
    assert.deepStrictEqual(warnings, [], "a long poll is expected to be slow");

    // Positive control: the same elapsed time on any other method does warn.
    responder = () => {
      mock.timers.tick(5_000);
      return okResponse(true);
    };
    await bot.sendMessage(1, "slow");
    assert.equal(warnings.length, 1);
  });
});

describe("text and callback handlers", () => {
  it("dispatches UI-generated text through the matching onText handler", () => {
    const bot = makeBot();
    const seen = [];
    bot.onText(/^\/buy (\w+)$/, (msg, match) => seen.push({ msg, symbol: match[1] }));

    bot.dispatchText({ chat: { id: 9 }, from: { id: 7 } }, "/buy BTC");

    assert.equal(seen.length, 1);
    assert.equal(seen[0].symbol, "BTC");
    assert.deepStrictEqual(seen[0].msg, {
      chat: { id: 9 },
      from: { id: 7 },
      text: "/buy BTC",
    });
  });

  it("re-matches a sticky global regex on every dispatch", () => {
    const bot = makeBot();
    let calls = 0;
    bot.onText(/\/ping/g, () => calls++);

    bot.dispatchText({ chat: { id: 1 } }, "/ping");
    bot.dispatchText({ chat: { id: 1 } }, "/ping");

    assert.equal(calls, 2, "lastIndex must be reset between dispatches");
  });

  it("ignores a message whose text is empty or not a string", () => {
    const bot = makeBot();
    const matched = [];
    bot.onText(/.*/, (msg) => matched.push(msg.text));

    bot.dispatchText({ chat: { id: 1 } }, "/ping");
    assert.deepStrictEqual(matched, ["/ping"], "control: a real text message does reach handlers");

    bot.dispatchText({ chat: { id: 1 } }, "");
    bot.dispatchText({ chat: { id: 1 } }, null);
    bot.dispatchText({ chat: { id: 1 } }, 42);

    assert.deepStrictEqual(matched, ["/ping"]);
  });

  it("runs only the handlers whose pattern matches", () => {
    const bot = makeBot();
    const hits = [];
    bot.onText(/^\/buy/, () => hits.push("buy"));
    bot.onText(/^\/sell/, () => hits.push("sell"));

    bot.dispatchText({}, "/sell BTC");

    assert.deepStrictEqual(hits, ["sell"]);
  });
});

describe("long polling", () => {
  it("polls getUpdates with the configured timeout and allowed update types", async () => {
    pollingBot({ pollTimeoutSeconds: 7 }, [
      (_call, self) => {
        self.stopPolling();
        return okResponse([]);
      },
    ]);
    await waitForRequests(1);
    await flush();

    assert.equal(requests[0].url, `https://api.telegram.org/bot${TOKEN}/getUpdates`);
    assert.deepStrictEqual(requests[0].body, {
      offset: 0,
      timeout: 7,
      allowed_updates: ["message", "callback_query"],
    });
  });

  it("delivers a polled message to onText and a polled callback to its listeners", async () => {
    const texts = [];
    const callbacks = [];
    const alsoCallbacks = [];
    const bot = pollingBot({}, [
      () =>
        okResponse([
          { update_id: 10, message: { chat: { id: 3 }, text: "/positions" } },
          { update_id: 11, callback_query: { id: "cbq-9", data: "monitor_cancel:t-1" } },
        ]),
      (_call, self) => {
        self.stopPolling();
        return okResponse([]);
      },
    ]);
    bot.onText(/^\/positions$/, (msg) => texts.push(msg));
    bot.on("callback_query", (query) => callbacks.push(query));
    bot.on("callback_query", (query) => alsoCallbacks.push(query.id));

    await waitForRequests(2);
    await flush();

    assert.deepStrictEqual(texts, [{ chat: { id: 3 }, text: "/positions" }]);
    assert.deepStrictEqual(callbacks, [{ id: "cbq-9", data: "monitor_cancel:t-1" }]);
    assert.deepStrictEqual(alsoCallbacks, ["cbq-9"], "every listener for the event must be run");
  });

  it("advances the offset past the highest update id it has acknowledged", async () => {
    pollingBot({}, [
      () => okResponse([{ update_id: 41, message: { text: "a" } }, { update_id: 20 }]),
      () => okResponse([]),
      (_call, self) => {
        self.stopPolling();
        return okResponse([]);
      },
    ]);
    await waitForRequests(3);
    await flush();

    assert.equal(requests[0].body.offset, 0);
    assert.equal(requests[1].body.offset, 42, "offset must clear the highest id, not the last one");
    assert.equal(requests[2].body.offset, 42);
  });

  it("keeps the offset when an update has no numeric update id", async () => {
    pollingBot({}, [
      () => okResponse([{ update_id: 41 }]),
      () => okResponse([{ update_id: "nope" }, {}]),
      (_call, self) => {
        self.stopPolling();
        return okResponse([]);
      },
    ]);
    await waitForRequests(3);
    await flush();

    assert.equal(requests[1].body.offset, 42, "control: a numeric id did move the offset");
    assert.equal(requests[2].body.offset, 42);
  });

  it("survives a getUpdates result that is not an array", async () => {
    const texts = [];
    const bot = pollingBot({}, [
      () => okResponse(null),
      () => okResponse({ not: "an array" }),
      () => okResponse([{ update_id: 5, message: { text: "/ping" } }]),
      (_call, self) => {
        self.stopPolling();
        return okResponse([]);
      },
    ]);
    bot.onText(/^\/ping$/, (msg) => texts.push(msg.text));

    await waitForRequests(4);
    await flush();

    assert.deepStrictEqual(texts, ["/ping"], "the loop must still be alive and dispatching");
  });

  it("emits polling_error and resumes polling after a failed poll", async () => {
    const errors = [];
    const failure = httpError(502, "Bad Gateway");

    const bot = pollingBot({ pollErrorDelayMs: 1 }, [
      () => {
        throw failure;
      },
      (_call, self) => {
        self.stopPolling();
        return okResponse([]);
      },
    ]);
    bot.on("polling_error", (error) => errors.push(error));

    await waitForRequests(2);
    await flush();

    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, "Telegram API getUpdates (502): Bad Gateway");
    assert.equal(requests.length, 2, "a failed poll must not end the loop");
  });

  it("waits the default second before retrying a failed poll", async (t) => {
    mockClock(t, ["setTimeout", "Date"]);

    pollingBot({}, [
      () => {
        throw new Error("network down");
      },
      (_call, self) => {
        self.stopPolling();
        return okResponse([]);
      },
    ]);
    await waitForRequests(1);
    await flush();
    assert.equal(requests.length, 1, "the loop is parked in its error backoff");

    mock.timers.tick(999);
    await flush();
    assert.equal(requests.length, 1, "it must not retry before the full delay has elapsed");

    mock.timers.tick(1);
    await flush();
    assert.equal(requests.length, 2, "and must retry once it has");
  });

  it("does not start a second poll loop while one is already running", async () => {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const bot = pollingBot({}, [() => held]);
    await waitForRequests(1);

    // `startPolling` is TS-private; reached deliberately, because the guard it
    // implements is what keeps a re-entrant caller from doubling the poll loop.
    bot.startPolling();
    await flush();

    assert.equal(requests.length, 1, "a concurrent second poll loop must not be started");

    bot.stopPolling();
    release(okResponse([]));
    await flush();
    assert.equal(requests.length, 1);
  });

  it("stops issuing polls after stopPolling", async () => {
    const bot = pollingBot({}, [() => okResponse([]), () => okResponse([])]);
    await waitForRequests(2);
    bot.stopPolling();
    await flush();

    const afterStop = requests.length;
    await flush();
    await flush();

    assert.equal(requests.length, afterStop);
    assert.ok(afterStop >= 2, "control: polling really was running before it was stopped");
  });

  it("does not poll at all unless polling is enabled", async () => {
    makeBot();
    await flush();

    assert.deepStrictEqual(requests, []);
  });
});

describe("bot.utils", () => {
  it("splits a command line into words on any run of whitespace", () => {
    assert.deepStrictEqual(botUtils.parseWords("  /buy   BTC\t0.5\n"), ["/buy", "BTC", "0.5"]);
  });

  it("returns no words for blank or missing text", () => {
    assert.deepStrictEqual(botUtils.parseWords("/buy"), ["/buy"], "control: real text yields words");
    assert.deepStrictEqual(botUtils.parseWords("   "), []);
    assert.deepStrictEqual(botUtils.parseWords(""), []);
    assert.deepStrictEqual(botUtils.parseWords(undefined), []);
    assert.deepStrictEqual(botUtils.parseWords(null), []);
  });

  it("parses a positive numeric argument", () => {
    assert.equal(botUtils.asNumber("2.5", "amount"), 2.5);
    assert.equal(botUtils.asNumber("1e3", "amount"), 1000);
  });

  it("rejects a non-positive or unparseable numeric argument by name", () => {
    for (const bad of ["0", "-1", "abc", "", "Infinity"]) {
      assert.throws(() => botUtils.asNumber(bad, "amount"), {
        message: "amount must be a positive number",
      });
    }
    assert.throws(() => botUtils.asNumber("-1", "price"), {
      message: "price must be a positive number",
    });
  });

  it("leaves text at or under the Telegram length budget untouched", () => {
    assert.equal(botUtils.escapeLong("short"), "short");
    const exact = "a".repeat(3900);
    assert.equal(botUtils.escapeLong(exact), exact);
  });

  it("truncates over-long text and marks it as elided", () => {
    const long = `${"a".repeat(3900)}TAIL`;

    const escaped = botUtils.escapeLong(long);

    assert.equal(escaped.length, 3901);
    assert.equal(escaped, `${"a".repeat(3900)}…`);
    assert.equal(escaped.includes("TAIL"), false);
  });

  it("re-exports the trigger formatter the command layer imports", () => {
    assert.equal(botUtils.formatTriggers, formatTriggersImpl);
    assert.equal(botUtils.formatTriggers([]), "No triggers found.");
  });
});
