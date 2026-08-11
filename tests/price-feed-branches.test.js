"use strict";

const { describe, it, before, beforeEach, afterEach, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");

const { tempFile, cleanupTempDirs } = require("./helpers/tmp");

const { PriceFeedService } = require("../dist/utils/price-feed.service");
const { TriggerStore } = require("../dist/triggers/trigger-store");
const { PositionStore } = require("../dist/triggers/position-store");
const { TriggerRuntime } = require("../dist/trigger-runtime");

/**
 * Stand-in for the `ws` socket, extended past the one in price-feed-shared with
 * the failure modes this file is about: a `send` that throws once, and a `send`
 * that throws every time. `readyState` follows the values the service checks
 * (0 connecting, 1 open, 3 closed).
 */
class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.handlers = new Map();
    this.sent = [];
    this.closed = false;
    /** Throw on the next `send` only, then behave normally. */
    this.failNextSend = false;
    /** Throw on every `send`. */
    this.failEverySend = false;
    FakeWebSocket.instances.push(this);
  }
  on(event, fn) {
    const list = this.handlers.get(event) || [];
    list.push(fn);
    this.handlers.set(event, list);
  }
  emit(event, payload) {
    if (event === "open") this.readyState = 1;
    if (event === "close") this.readyState = 3;
    for (const fn of this.handlers.get(event) || []) fn(payload);
  }
  send(payload) {
    if (this.failEverySend || this.failNextSend) {
      this.failNextSend = false;
      throw new Error("socket write failed");
    }
    this.sent.push(payload);
  }
  close(code, reason) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
  }
}

/** A two-sided L2 book frame in the shape the feed parses. */
function book(symbol, bid, ask, bidQty = 10, askQty = 10) {
  return { s: symbol, bids: [{ p: bid, q: bidQty }], asks: [{ p: ask, q: askQty }] };
}

/** Wraps a payload the way the real transport hands frames to the feed. */
function frame(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
}

/** Parsed view of every control frame the feed wrote to a socket. */
function sent(ws) {
  return ws.sent.map((payload) => JSON.parse(payload));
}

/** Lets queued microtask deliveries (cached snapshot replay) run. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A feed wired to `FakeWebSocket`, torn down with the test so no socket and no
 * reconnect/idle timer can outlive the case that created it.
 */
function makeFeed(t, overrides = {}) {
  const warnings = [];
  const feed = new PriceFeedService({
    url: "ws://example.test/l2",
    idleCloseMs: 0,
    createWebSocket: (url) => new FakeWebSocket(url),
    onWarning: (message) => warnings.push(message),
    ...overrides,
  });
  t.after(() => feed.closeAll());
  return { feed, warnings };
}

/** One open socket serving one BTC subscriber — the starting point for most cases. */
function openBtcFeed(t, overrides = {}) {
  const { feed, warnings } = makeFeed(t, overrides);
  const seen = [];
  const stop = feed.subscribe("BTC", (quote) => seen.push(quote), 0);
  const ws = FakeWebSocket.instances[0];
  ws.emit("open");
  return { feed, warnings, seen, stop, ws };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});

// Every case that fakes time enables the timer mock itself; resetting here means
// a case can never leak a patched global into the next one.
afterEach(() => {
  mock.timers.reset();
});

after(cleanupTempDirs);

describe("price feed send failures and rollback", () => {
  it("rolls the symbol back to unsubscribed when the socket rejects the subscribe frame", (t) => {
    const { feed, warnings } = makeFeed(t);
    feed.subscribe("BTC", () => undefined, 0);
    const ws = FakeWebSocket.instances[0];
    ws.failNextSend = true;

    ws.emit("open");

    assert.deepStrictEqual(ws.sent, [], "a subscribe frame that throws must not be recorded as sent");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Price feed subscribe warning for BTC: socket write failed/);
    assert.equal(
      feed.stats()[0].subscribed,
      false,
      "a failed subscribe must be rolled back, not left marked as subscribed",
    );
  });

  it("re-sends a rolled-back subscribe on the next ensureActive", (t) => {
    const { feed } = makeFeed(t);
    feed.subscribe("BTC", () => undefined, 0);
    const ws = FakeWebSocket.instances[0];
    ws.failNextSend = true;
    ws.emit("open");
    assert.equal(feed.stats()[0].subscribed, false, "precondition: the subscribe must have failed and rolled back");

    feed.ensureActive();

    assert.deepStrictEqual(
      sent(ws),
      [{ symbol: "BTC", unsubscribe: 0 }],
      "ensureActive must re-send a subscribe the socket previously rejected",
    );
    assert.equal(feed.stats()[0].subscribed, true);
  });

  it("does not re-send a subscribe the open socket already holds", (t) => {
    const { feed, ws } = openBtcFeed(t);
    assert.deepStrictEqual(
      sent(ws),
      [{ symbol: "BTC", unsubscribe: 0 }],
      "precondition: BTC is already subscribed on the open socket",
    );

    feed.ensureActive();
    feed.ensureActive();

    assert.deepStrictEqual(
      sent(ws),
      [{ symbol: "BTC", unsubscribe: 0 }],
      "repeated ensureActive must not duplicate an existing subscription",
    );
  });

  it("swallows a send failure while unsubscribing and still forgets the symbol", (t) => {
    const { feed, stop, ws } = openBtcFeed(t, { idleCloseMs: 1000 });
    assert.equal(
      feed.stats()[0].subscribed,
      true,
      "precondition: BTC must be subscribed so the unsubscribe frame is actually attempted",
    );
    ws.failEverySend = true;

    assert.doesNotThrow(() => stop(), "a socket that rejects the unsubscribe frame must not surface to the caller");

    assert.equal(
      feed.stats()[0].subscribed,
      false,
      "the symbol must be dropped even when the unsubscribe frame could not be sent",
    );
    assert.equal(feed.subscriberCount("BTC"), 0);
  });

  it("never sends a subscribe for a symbol whose subscriber left while the socket was still connecting", (t) => {
    const { feed } = makeFeed(t);
    const stopEarly = feed.subscribe("BTC", () => undefined, 0);
    feed.subscribe("ETH", () => undefined, 0);
    const ws = FakeWebSocket.instances[0];

    stopEarly();
    ws.emit("open");

    assert.deepStrictEqual(
      sent(ws),
      [{ symbol: "ETH", unsubscribe: 0 }],
      "only the symbol that still has a subscriber may be sent on open",
    );
  });
});

describe("price feed socket error handling", () => {
  it("warns on a socket error without reconnecting while that socket is still usable", (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { warnings, ws } = openBtcFeed(t, { reconnectMs: 100 });

    ws.emit("error", new Error("stream hiccup"));
    mock.timers.tick(1000);

    assert.deepStrictEqual(
      warnings,
      ["Price feed warning: stream hiccup"],
      "a socket error must be reported to the warning sink",
    );
    assert.equal(
      FakeWebSocket.instances.length,
      1,
      "an error on a still-open socket must not spawn a replacement socket",
    );
  });

  it("schedules a reconnect after an error on a socket that is no longer open", (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { feed, warnings, ws } = openBtcFeed(t, { reconnectMs: 100 });

    ws.readyState = 3;
    ws.emit("error", { code: "ECONNRESET" });
    mock.timers.tick(100);

    assert.equal(warnings.length, 1, "the dead-socket error must still be reported");
    assert.equal(FakeWebSocket.instances.length, 2, "an error on a dead socket must schedule a reconnect");
    assert.equal(FakeWebSocket.instances[1].url, "ws://example.test/l2");
    FakeWebSocket.instances[1].emit("open");
    assert.equal(feed.activeSocketCount(), 1, "the replacement socket must be adopted as the live connection");
  });

  /**
   * Regression guard. Only the close handler used to clear subscribedSymbols, so an
   * error with no following close left it stale. The replacement socket's open
   * handler then skipped every symbol as "already subscribed" and subscribed to
   * nothing: a connected socket delivering no prices, with no error to go on.
   */
  it("resubscribes every active symbol after an error that is never followed by a close", (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { feed } = makeFeed(t, { reconnectMs: 100 });
    const seen = [];
    feed.subscribe("BTC", (quote) => seen.push(quote), 0);
    feed.subscribe("ETH", () => undefined, 0);
    const first = FakeWebSocket.instances[0];
    first.emit("open");
    assert.deepStrictEqual(
      sent(first).map((m) => m.symbol),
      ["BTC", "ETH"],
      "sanity: the first socket subscribed both symbols",
    );

    // Dead socket, error only -- deliberately no close event.
    first.readyState = 3;
    first.emit("error", { code: "ECONNRESET" });
    mock.timers.tick(100);

    const replacement = FakeWebSocket.instances[1];
    assert.ok(replacement, "an error on a dead socket must schedule a reconnect");
    replacement.emit("open");

    assert.deepStrictEqual(
      sent(replacement)
        .filter((m) => m.unsubscribe === 0)
        .map((m) => m.symbol),
      ["BTC", "ETH"],
      "the replacement socket must subscribe every active symbol, not inherit stale state",
    );

    // And it must actually deliver, which is the whole point.
    replacement.emit("message", frame(book("BTC", 99, 100)));
    assert.equal(seen.length, 1, "the reconnected feed must deliver prices again");
  });

  it("warns and retries when constructing the websocket throws", (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let failCreate = true;
    const { feed, warnings } = makeFeed(t, {
      reconnectMs: 100,
      createWebSocket: (url) => {
        if (failCreate) throw new Error("dns failure");
        return new FakeWebSocket(url);
      },
    });

    feed.subscribe("BTC", () => undefined, 0);

    assert.equal(FakeWebSocket.instances.length, 0, "a constructor that throws leaves no socket behind");
    assert.deepStrictEqual(warnings, ["Price feed warning: dns failure"]);
    assert.equal(feed.activeSocketCount(), 0);

    failCreate = false;
    mock.timers.tick(100);

    assert.equal(FakeWebSocket.instances.length, 1, "a failed connect attempt must be retried after reconnectMs");
    FakeWebSocket.instances[0].emit("open");
    assert.deepStrictEqual(sent(FakeWebSocket.instances[0]), [{ symbol: "BTC", unsubscribe: 0 }]);
  });

  it("falls back to console.warn when no warning sink is configured", (t) => {
    const previousUrl = process.env.LIQUIDITY_WS_URL;
    delete process.env.LIQUIDITY_WS_URL;
    const originalWarn = console.warn;
    const warned = [];
    console.warn = (...args) => warned.push(args.join(" "));
    t.after(() => {
      console.warn = originalWarn;
      if (previousUrl !== undefined) process.env.LIQUIDITY_WS_URL = previousUrl;
    });

    const { feed } = makeFeed(t, { url: () => undefined, onWarning: undefined });
    feed.subscribe("BTC", () => undefined, 0);

    assert.deepStrictEqual(
      warned,
      ["Price feed not started: LIQUIDITY_WS_URL is not configured."],
      "without a warning sink the feed must still report through console.warn",
    );
  });
});

describe("price feed idle close window", () => {
  it("closes the socket once idleCloseMs elapses with no active symbols", (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { stop, ws } = openBtcFeed(t, { idleCloseMs: 1000 });

    stop();
    mock.timers.tick(999);
    assert.equal(ws.closed, false, "the socket must survive until the idle window has fully elapsed");

    mock.timers.tick(1);

    assert.equal(ws.closed, true, "the idle socket must close once idleCloseMs elapses");
    assert.equal(ws.closeReason, "no active symbols");
  });

  it("cancels the pending idle close when a new subscriber arrives inside the window", (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { feed, stop, ws } = openBtcFeed(t, { idleCloseMs: 1000 });
    stop();
    mock.timers.tick(500);
    assert.equal(ws.closed, false, "precondition: the idle close is still pending, not already done");

    feed.subscribe("BTC", () => undefined, 0);
    mock.timers.tick(5000);

    assert.equal(ws.closed, false, "a subscriber arriving inside the idle window must cancel the pending close");
    assert.equal(FakeWebSocket.instances.length, 1, "the surviving socket must be reused rather than replaced");
    assert.deepStrictEqual(
      sent(ws).filter((x) => x.unsubscribe === 0),
      [
        { symbol: "BTC", unsubscribe: 0 },
        { symbol: "BTC", unsubscribe: 0 },
      ],
      "the returning subscriber must be re-subscribed on the reused socket",
    );
  });

  it("does not let a reconnect armed before the idle window shorten a later backoff", (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { feed, warnings } = makeFeed(t, { idleCloseMs: 10_000, reconnectMs: 400 });
    const stop = feed.subscribe("BTC", () => undefined, 0);
    const ws = FakeWebSocket.instances[0];
    // A rejected subscribe arms a reconnect at t=400 while the socket is still open.
    ws.failNextSend = true;
    ws.emit("open");
    assert.equal(warnings.length, 1, "precondition: the rejected subscribe must have armed a reconnect");

    stop();
    mock.timers.tick(100);
    feed.subscribe("BTC", () => undefined, 0);
    assert.deepStrictEqual(
      sent(ws),
      [{ symbol: "BTC", unsubscribe: 0 }],
      "precondition: the returning subscriber is served by the same live socket",
    );
    ws.emit("close");

    // The reconnect for this close belongs at t=100+400=500, not at the stale t=400.
    mock.timers.tick(300);
    assert.equal(
      FakeWebSocket.instances.length,
      1,
      "a reconnect armed before the socket went idle must not fire early",
    );
    mock.timers.tick(100);
    assert.equal(
      FakeWebSocket.instances.length,
      2,
      "the close must still be followed by a reconnect one backoff later",
    );
  });
});

describe("price feed stats and closeAll", () => {
  it("reports one row per symbol with connection, subscription and snapshot state", (t) => {
    const { feed, ws } = openBtcFeed(t);
    feed.subscribe("ETH", () => undefined, 0);
    ws.emit("message", frame(book("BTC", 99, 100)));

    const rows = feed.stats();

    assert.deepStrictEqual(
      rows.map((row) => row.symbol),
      ["BTC", "ETH"],
      "stats rows must be sorted by symbol",
    );
    assert.deepStrictEqual(
      rows.map((row) => row.subscribers),
      [1, 1],
    );
    assert.deepStrictEqual(
      rows.map((row) => row.connected),
      [true, true],
    );
    assert.deepStrictEqual(
      rows.map((row) => row.subscribed),
      [true, true],
    );
    assert.deepStrictEqual(
      rows.map((row) => row.hasSnapshot),
      [true, false],
      "only the symbol that received a book has a snapshot",
    );
    assert.equal(rows[0].lastUpdateTs, feed.getSnapshot("BTC").ts);
    assert.equal(rows[1].lastUpdateTs, undefined);
    assert.equal(feed.activeStreamCount(), 1, "two active symbols must still report a single underlying stream");
  });

  it("reports symbols as disconnected once the socket is gone", (t) => {
    const { feed, ws } = openBtcFeed(t, { reconnectMs: 60_000 });
    assert.equal(feed.stats()[0].connected, true, "precondition: the feed reports a live connection first");

    ws.emit("close");

    assert.equal(feed.stats()[0].connected, false, "a closed socket must be reported as disconnected");
    assert.equal(feed.stats()[0].subscribed, false, "a closed socket holds no symbol subscriptions");
    assert.equal(
      feed.stats()[0].subscribers,
      1,
      "the subscriber itself survives the socket so the reconnect can serve it",
    );
  });

  it("forgets every symbol, subscriber and snapshot on closeAll", (t) => {
    const { feed, ws } = openBtcFeed(t);
    ws.emit("message", frame(book("BTC", 99, 100)));
    assert.equal(feed.subscriberCount(), 1, "precondition: there is a subscriber to drop");
    assert.equal(feed.getSnapshot("BTC").ask, 100, "precondition: there is a snapshot to drop");

    feed.closeAll();

    assert.deepStrictEqual(feed.stats(), [], "closeAll must forget every tracked symbol");
    assert.equal(feed.subscriberCount(), 0);
    assert.equal(feed.getSnapshot("BTC"), undefined);
    assert.equal(feed.activeSocketCount(), 0);
    assert.equal(feed.activeStreamCount(), 0, "closeAll must leave no underlying stream behind");
    assert.equal(ws.closed, true);
    assert.equal(ws.closeReason, "close all");
  });

  it("stops delivering to a subscriber that closeAll dropped", (t) => {
    const { feed, seen, ws } = openBtcFeed(t);
    ws.emit("message", frame(book("BTC", 99, 100)));
    assert.equal(seen.length, 1, "precondition: delivery works before closeAll");

    feed.closeAll();
    ws.emit("message", frame(book("BTC", 88, 89)));

    assert.equal(seen.length, 1, "a subscriber dropped by closeAll must receive nothing further");
  });
});

describe("price feed getPrices", () => {
  it("resolves with the first quote and releases the subscription", async (t) => {
    const { feed } = makeFeed(t);

    const pending = feed.getPrices("BTC", 10_000);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.emit("message", frame(book("BTC", 99, 100, 3, 4)));
    const quote = await pending;

    assert.equal(quote.symbol, "BTC");
    assert.equal(quote.ask, 100);
    assert.equal(quote.askQty, 4);
    assert.equal(feed.subscriberCount("BTC"), 0, "getPrices must release its own subscription once resolved");
    assert.equal(ws.closed, true, "the one-shot subscription must not keep the socket open");
  });

  it("rejects and releases the subscription when no quote arrives before the timeout", async (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { feed } = makeFeed(t);

    const pending = feed.getPrices("BTC", 5000);
    FakeWebSocket.instances[0].emit("open");
    assert.equal(feed.subscriberCount("BTC"), 1, "precondition: getPrices holds a subscription while waiting");
    mock.timers.tick(5000);

    await assert.rejects(pending, /Timed out waiting for BTC price/);
    assert.equal(feed.subscriberCount("BTC"), 0, "a timed-out getPrices must not leak its subscription");
  });
});

describe("price feed snapshot freshness edges", () => {
  const previousMax = process.env.PRICE_FEED_MAX_SNAPSHOT_AGE_MS;
  const previousLegacyMax = process.env.TRIGGER_MAX_L2_AGE_MS;
  const realNow = Date.now;
  let fakeNow = 4_000_000;

  before(() => {
    delete process.env.PRICE_FEED_MAX_SNAPSHOT_AGE_MS;
    delete process.env.TRIGGER_MAX_L2_AGE_MS;
  });

  beforeEach(() => {
    fakeNow = 4_000_000;
    Date.now = () => fakeNow;
  });

  after(() => {
    Date.now = realNow;
    if (previousMax !== undefined) process.env.PRICE_FEED_MAX_SNAPSHOT_AGE_MS = previousMax;
    else delete process.env.PRICE_FEED_MAX_SNAPSHOT_AGE_MS;
    if (previousLegacyMax !== undefined) process.env.TRIGGER_MAX_L2_AGE_MS = previousLegacyMax;
    else delete process.env.TRIGGER_MAX_L2_AGE_MS;
  });

  /** Leaves a cached SOL snapshot behind, then re-subscribes `ageMs` later. */
  async function replayAfter(t, ageMs, overrides) {
    const { feed } = makeFeed(t, overrides);
    const stop = feed.subscribe("SOL", () => undefined, 0);
    FakeWebSocket.instances[0].emit("open");
    FakeWebSocket.instances[0].emit("message", frame(book("SOL", 20, 21)));
    stop();
    assert.equal(feed.getSnapshot("SOL").ts, 4_000_000, "precondition: a cached snapshot exists to replay");

    fakeNow += ageMs;
    const replayed = [];
    feed.subscribe("SOL", (quote) => replayed.push(quote), 0);
    await flush();
    return replayed;
  }

  it("replays a snapshot that is exactly maxSnapshotAgeMs old", async (t) => {
    const replayed = await replayAfter(t, 1000, { maxSnapshotAgeMs: 1000 });

    assert.equal(replayed.length, 1, "a snapshot exactly at the age limit is still fresh");
    assert.equal(replayed[0].ask, 21);
  });

  it("drops a snapshot one millisecond past maxSnapshotAgeMs", async (t) => {
    const replayed = await replayAfter(t, 1001, { maxSnapshotAgeMs: 1000 });

    assert.equal(replayed.length, 0, "a snapshot one millisecond past the limit is stale");
  });

  it("replays a snapshot of any age when the age limit is disabled with 0", async (t) => {
    const replayed = await replayAfter(t, 600_000, { maxSnapshotAgeMs: 0 });

    assert.equal(replayed.length, 1, "maxSnapshotAgeMs 0 disables the freshness check entirely");
    assert.equal(replayed[0].ask, 21);
  });

  it("takes the age limit from PRICE_FEED_MAX_SNAPSHOT_AGE_MS when the option is unset", async (t) => {
    process.env.PRICE_FEED_MAX_SNAPSHOT_AGE_MS = "100";
    t.after(() => {
      delete process.env.PRICE_FEED_MAX_SNAPSHOT_AGE_MS;
    });

    const stale = await replayAfter(t, 500, {});
    assert.equal(stale.length, 0, "PRICE_FEED_MAX_SNAPSHOT_AGE_MS must bound snapshot replay");

    process.env.PRICE_FEED_MAX_SNAPSHOT_AGE_MS = "5000";
    FakeWebSocket.instances = [];
    fakeNow = 4_000_000;
    const fresh = await replayAfter(t, 500, {});
    assert.equal(fresh.length, 1, "the same 500ms-old snapshot is replayed under a 5000ms limit");
  });
});

describe("price feed symbol normalisation", () => {
  const previousEnv = process.env.ENV;

  after(() => {
    if (previousEnv !== undefined) process.env.ENV = previousEnv;
    else delete process.env.ENV;
  });

  it("rejects a blank symbol instead of tracking an empty subscription", (t) => {
    const { feed } = makeFeed(t);

    assert.throws(() => feed.subscribe("   ", () => undefined, 0), /symbol is required/);
    assert.equal(feed.subscriberCount(), 0, "a rejected symbol must leave no subscriber behind");
    assert.throws(() => feed.getSnapshot(""), /symbol is required/);
  });

  it("keeps a short name that merely ends in a quote suffix", (t) => {
    const { feed } = makeFeed(t);
    const short = [];
    const long = [];
    feed.subscribe("XUSDT", (quote) => short.push(quote), 0);
    feed.subscribe("BTC", (quote) => long.push(quote), 0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");

    ws.emit("message", frame(book("XUSDT", 1, 2)));
    ws.emit("message", frame(book("BTCUSDT", 3, 4)));

    assert.equal(short.length, 1, "a name too short to survive suffix stripping must route to itself");
    assert.equal(short[0].symbol, "XUSDT");
    assert.equal(long.length, 1, "a genuine pair name must still be stripped to its base symbol");
    assert.equal(long[0].symbol, "BTC");
  });

  it("splits a T_ prefixed name on the separator outside testnet", (t) => {
    delete process.env.ENV;
    const { feed } = makeFeed(t);
    const prefixed = [];
    const base = [];
    feed.subscribe("T_BTC", (quote) => prefixed.push(quote), 0);
    feed.subscribe("T", (quote) => base.push(quote), 0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");

    ws.emit("message", frame(book("T_BTC", 1, 2)));

    assert.equal(base.length, 1, "outside testnet T_BTC is a separated pair name and routes to T");
    assert.equal(prefixed.length, 0, "the literal T_BTC symbol is not used outside testnet");
  });

  it("keeps a T_ prefixed name intact on testnet", (t) => {
    process.env.ENV = "testnet";
    t.after(() => {
      delete process.env.ENV;
    });
    const { feed } = makeFeed(t);
    const prefixed = [];
    const base = [];
    feed.subscribe("T_BTC", (quote) => prefixed.push(quote), 0);
    feed.subscribe("T", (quote) => base.push(quote), 0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");

    ws.emit("message", frame(book("T_BTC", 1, 2)));

    assert.equal(prefixed.length, 1, "testnet market names must route to the T_ prefixed subscriber");
    assert.equal(prefixed[0].symbol, "T_BTC");
    assert.equal(base.length, 0, "a testnet name must not be split down to its T prefix");
  });
});

describe("price feed market frame edge shapes", () => {
  it("routes an anonymous book frame to the only active symbol", (t) => {
    const { seen, ws } = openBtcFeed(t);

    ws.emit("message", frame({ bids: [{ p: 9, q: 1 }], asks: [{ p: 10, q: 2 }] }));

    assert.equal(seen.length, 1, "a frame with no symbol must fall back to the single active symbol");
    assert.equal(seen[0].symbol, "BTC");
    assert.equal(seen[0].ask, 10);
  });

  it("drops an anonymous book frame when more than one symbol is active", (t) => {
    const { feed, seen, ws } = openBtcFeed(t);
    const seenEth = [];
    feed.subscribe("ETH", (quote) => seenEth.push(quote), 0);
    ws.emit("message", frame({ bids: [{ p: 9, q: 1 }], asks: [{ p: 10, q: 2 }] }));
    assert.equal(seen.length, 0, "an anonymous frame is ambiguous with two active symbols");
    assert.equal(seenEth.length, 0, "an ambiguous frame must not be guessed onto either symbol");

    // Positive control: the same socket delivers fine once the frame names a symbol.
    ws.emit("message", frame(book("ETH", 9, 10)));
    assert.equal(seenEth.length, 1, "a named frame still routes, so the drop above was the ambiguity rule");
  });

  it("expands a bare symbol-keyed map of books", (t) => {
    const { feed } = makeFeed(t);
    const btc = [];
    const eth = [];
    feed.subscribe("BTC", (quote) => btc.push(quote), 0);
    feed.subscribe("ETH", (quote) => eth.push(quote), 0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");

    ws.emit(
      "message",
      frame({
        BTC: { bids: [{ p: 50, q: 1 }], asks: [{ p: 51, q: 1 }] },
        "ETH-USD": { bids: [{ p: 60, q: 2 }], asks: [{ p: 61, q: 2 }] },
      }),
    );

    assert.equal(btc.length, 1, "a top-level symbol-keyed map must be expanded per symbol");
    assert.equal(btc[0].ask, 51);
    assert.equal(eth.length, 1, "map keys are normalised like any other feed symbol");
    assert.equal(eth[0].ask, 61);
  });

  it("skips non-book values mixed into a symbol-keyed data map", (t) => {
    const { feed } = makeFeed(t);
    const btc = [];
    feed.subscribe("BTC", (quote) => btc.push(quote), 0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");

    ws.emit(
      "message",
      frame({
        data: {
          channel: "l2",
          seq: 42,
          BTC: { bids: [{ p: 50, q: 1 }], asks: [{ p: 51, q: 1 }] },
        },
      }),
    );

    assert.equal(btc.length, 1, "scalar metadata beside the books must not stop the book from being routed");
    assert.equal(btc[0].ask, 51);
    assert.equal(feed.getSnapshot("BTC").bid, 50);
  });

  it("reads tuple levels under the short b/a side keys", (t) => {
    const { seen, ws } = openBtcFeed(t);

    ws.emit("message", frame({ s: "BTC", b: [[9, "1.5"]], a: [[10, 2]] }));

    assert.equal(seen.length, 1, "the b/a side keys with tuple levels must parse");
    assert.equal(seen[0].bid, 9);
    assert.equal(seen[0].bidQty, 1.5);
    assert.equal(seen[0].ask, 10);
    assert.equal(seen[0].askQty, 2);
  });

  it("reads a book nested under a book wrapper", (t) => {
    const { seen, ws } = openBtcFeed(t);

    ws.emit("message", frame({ s: "BTC", book: { bids: [{ price: "7" }], asks: [{ price: "8", size: 3 }] } }));

    assert.equal(seen.length, 1, "a nested book wrapper must be unwrapped");
    assert.equal(seen[0].bid, 7);
    assert.equal(seen[0].ask, 8);
    assert.equal(seen[0].askQty, 3);
    assert.deepStrictEqual(
      seen[0].orderBook.asks,
      [{ price: "8", size: 3 }],
      "the unwrapped book is what reaches the subscriber",
    );
  });

  it("ignores a frame whose best levels carry no positive price", (t) => {
    const { feed, seen, ws } = openBtcFeed(t);
    ws.emit("message", frame(book("BTC", 99, 100)));
    assert.equal(seen.length, 1, "precondition: a good frame delivers and caches");

    ws.emit("message", frame({ s: "BTC", bids: [{ p: 0, q: 1 }], asks: [{ p: -5, q: 1 }] }));

    assert.equal(seen.length, 1, "a frame with no positive price must not be delivered");
    assert.equal(feed.getSnapshot("BTC").ask, 100, "the cached snapshot must survive an unusable frame");
  });

  it("ignores a malformed payload without breaking the next frame", (t) => {
    const { seen, ws } = openBtcFeed(t);

    ws.emit("message", frame('{"s":"BTC", not json'));
    assert.equal(seen.length, 0, "a malformed payload delivers nothing");

    ws.emit("message", frame(book("BTC", 99, 100)));
    assert.equal(seen.length, 1, "the feed must keep serving frames after a malformed one");
  });
});

describe("price feed debug telemetry", () => {
  const previousDebug = process.env.PRICE_DEBUG;

  after(() => {
    if (previousDebug !== undefined) process.env.PRICE_DEBUG = previousDebug;
    else delete process.env.PRICE_DEBUG;
  });

  /**
   * Drives one full lifecycle — subscribe, connect, subscribe frames, a redundant
   * ensureActive, a delivered book, and the final unsubscribe — while capturing
   * console.log. Both cases below run the identical script; only PRICE_DEBUG differs.
   */
  function lifecycle(t) {
    const originalLog = console.log;
    const logs = [];
    console.log = (...args) => logs.push(args);
    t.after(() => {
      console.log = originalLog;
    });

    const { feed } = makeFeed(t);
    const seen = [];
    const stopBtc = feed.subscribe("BTC", (quote) => seen.push(quote), 0);
    feed.subscribe("ETH", () => undefined, 0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    feed.ensureActive();
    ws.emit("message", frame(book("BTC", 99, 100)));
    stopBtc();

    return { logs, seen, tags: [...new Set(logs.map((entry) => entry[0]))].sort() };
  }

  it("emits the whole subscriber and socket lifecycle when PRICE_DEBUG is on", (t) => {
    process.env.PRICE_DEBUG = "true";
    t.after(() => {
      delete process.env.PRICE_DEBUG;
    });

    const { logs, seen, tags } = lifecycle(t);

    assert.equal(seen.length, 1, "the lifecycle must still deliver the quote while tracing");
    assert.deepStrictEqual(tags, [
      "[PRICE_FEED_DELIVER]",
      "[PRICE_FEED_RESUBSCRIBE_REMAINING]",
      "[PRICE_FEED_SOCKET_CREATE]",
      "[PRICE_FEED_SOCKET_SUBSCRIBE_SENT]",
      "[PRICE_FEED_SOCKET_SUBSCRIBE_SKIP]",
      "[PRICE_FEED_SOCKET_UNSUBSCRIBE_SENT]",
      "[PRICE_FEED_SUBSCRIBER_ADD]",
      "[PRICE_FEED_SUBSCRIBER_REMOVE]",
    ]);

    const skips = logs.filter((entry) => entry[0] === "[PRICE_FEED_SOCKET_SUBSCRIBE_SKIP]");
    assert.deepStrictEqual(
      skips.map((entry) => entry[1].reason),
      ["already-subscribed", "already-subscribed"],
      "the redundant ensureActive must be traced as a skip per symbol",
    );
    const create = logs.find((entry) => entry[0] === "[PRICE_FEED_SOCKET_CREATE]");
    assert.equal(create[1].url, "ws://example.test/l2");
    const remove = logs.find((entry) => entry[0] === "[PRICE_FEED_SUBSCRIBER_REMOVE]");
    assert.equal(remove[1].symbol, "BTC");
    assert.equal(remove[1].remainingSymbolSubscribers, 0);
    const resubscribe = logs.find((entry) => entry[0] === "[PRICE_FEED_RESUBSCRIBE_REMAINING]");
    assert.deepStrictEqual(
      resubscribe[1].activeSymbols,
      ["ETH"],
      "the unsubscribe trace must show which symbols are re-asserted",
    );
  });

  it("emits nothing when PRICE_DEBUG is off", (t) => {
    delete process.env.PRICE_DEBUG;

    const { logs, seen } = lifecycle(t);

    assert.equal(seen.length, 1, "positive control: the same lifecycle ran and delivered a quote");
    assert.deepStrictEqual(logs, [], "the feed must stay silent unless PRICE_DEBUG is enabled");
  });
});

describe("price feed batched frames with PRICE_DEBUG on", () => {
  const previousDebug = process.env.PRICE_DEBUG;

  after(() => {
    if (previousDebug !== undefined) process.env.PRICE_DEBUG = previousDebug;
    else delete process.env.PRICE_DEBUG;
  });

  /**
   * Regression guard. The [PRICE_FEED_DELIVER] trace used to read quote.symbol
   * before the `if (!quote) return` guard, so a frame yielding no quote threw a
   * TypeError. onMessage wraps the whole frame loop in a catch that ignores
   * everything, so the throw abandoned the rest of the message silently.
   */
  function deliverBatch(t, debug) {
    const originalLog = console.log;
    console.log = () => undefined;
    t.after(() => {
      console.log = originalLog;
    });

    if (debug) process.env.PRICE_DEBUG = "true";
    else delete process.env.PRICE_DEBUG;
    t.after(() => {
      delete process.env.PRICE_DEBUG;
    });

    const { feed } = makeFeed(t);
    const seen = [];
    feed.subscribe("BTC", (quote) => seen.push(quote), 0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");

    // First frame has an empty book, so quoteFromBook returns undefined for it.
    ws.emit("message", frame([{ s: "BTC", bids: [], asks: [] }, book("BTC", 99, 100)]));

    return seen;
  }

  it("still delivers the rest of a batch after a frame that yields no quote", (t) => {
    const seen = deliverBatch(t, true);

    assert.equal(seen.length, 1, "the quotable frame after an empty book must still be delivered");
    assert.equal(seen[0].symbol, "BTC");
    assert.equal(seen[0].ask, 100);
  });

  it("delivers the same batch identically with debug logging off", (t) => {
    const seen = deliverBatch(t, false);

    assert.equal(seen.length, 1, "debug logging must not change what subscribers receive");
    assert.equal(seen[0].ask, 100);
  });
});

/** Records every tick, timer sweep and position update the runtime asks for. */
class FakeEngine {
  constructor() {
    this.ticks = [];
    this.dueTimerRuns = 0;
    this.positionUpdates = [];
  }
  async processTick(tick) {
    this.ticks.push(tick);
  }
  async processDueTimers() {
    this.dueTimerRuns += 1;
  }
  async processPositionUpdate(symbol) {
    this.positionUpdates.push(symbol);
  }
}

/** Per-user account stream the runtime starts, stops and listens to. */
class FakeUserDataStream extends EventEmitter {
  constructor(startResult = true) {
    super();
    this.startResult = startResult;
    this.starts = 0;
    this.stops = 0;
  }
  start() {
    this.starts += 1;
    return this.startResult;
  }
  stop() {
    this.stops += 1;
  }
}

/** Price feed that hands back the callback so a case can push a quote by hand. */
class FakePriceFeed {
  constructor() {
    this.subscribed = [];
    this.unsubscribed = [];
    this.ensureActiveCalls = 0;
  }
  subscribe(symbol, onPrice, minIntervalMs) {
    this.subscribed.push({ symbol, onPrice, minIntervalMs });
    return () => this.unsubscribed.push(symbol);
  }
  ensureActive() {
    this.ensureActiveCalls += 1;
  }
  push(symbol, quote) {
    for (const entry of this.subscribed) if (entry.symbol === symbol) entry.onPrice(quote);
  }
}

/** Runtime wired to recording doubles, with real on-disk trigger/position stores. */
function runtimeRig(options = {}) {
  const triggers = new TriggerStore(tempFile("triggers.json", "qt-price-feed-branches-"));
  const positions = new PositionStore(tempFile("positions.json", "qt-price-feed-branches-"));
  const engine = new FakeEngine();
  const userData = new FakeUserDataStream(options.accountStreamStarts ?? true);
  const priceFeed = new FakePriceFeed();
  const orderHistory = {
    upserts: [],
    upsert(update) {
      this.upserts.push(update);
    },
  };
  const notifications = [];
  const runtime = new TriggerRuntime(
    triggers,
    positions,
    engine,
    (message) => notifications.push(message),
    userData,
    priceFeed,
    options.withOrderHistory === false ? undefined : orderHistory,
  );
  return { triggers, positions, engine, userData, priceFeed, orderHistory, notifications, runtime };
}

/** A watchable price trigger, so the runtime does not immediately stop itself as idle. */
function addPriceTrigger(triggers, symbol = "BTC") {
  return triggers.add({ kind: "LIMIT", symbol, side: "BUY", triggerPrice: 100, quantity: 1 });
}

describe("TriggerRuntime market data plumbing", () => {
  it("forwards a delivered quote to the engine as a tick", (t) => {
    const rig = runtimeRig();
    t.after(() => rig.runtime.stop());
    addPriceTrigger(rig.triggers);
    rig.runtime.ensure();
    assert.deepStrictEqual(
      rig.priceFeed.subscribed.map((x) => x.symbol),
      ["BTC"],
      "precondition: the runtime subscribed to BTC",
    );

    rig.priceFeed.push("BTC", {
      symbol: "BTC",
      price: 100,
      bid: 99,
      ask: 101,
      bidQty: 1,
      askQty: 2,
      mark: 100.5,
      ts: 1700,
      orderBook: { bids: [] },
    });

    assert.deepStrictEqual(
      rig.engine.ticks,
      [
        {
          symbol: "BTC",
          price: 100,
          bid: 99,
          ask: 101,
          bidQty: 1,
          askQty: 2,
          mark: 100.5,
          ts: 1700,
          orderBook: { bids: [] },
        },
      ],
      "the runtime must hand the full L2 quote to the engine",
    );
  });

  it("subscribes with the throttle from PRICE_FEED_MIN_TRIGGER_INTERVAL_MS", (t) => {
    const previous = process.env.PRICE_FEED_MIN_TRIGGER_INTERVAL_MS;
    process.env.PRICE_FEED_MIN_TRIGGER_INTERVAL_MS = "250";
    t.after(() => {
      if (previous !== undefined) process.env.PRICE_FEED_MIN_TRIGGER_INTERVAL_MS = previous;
      else delete process.env.PRICE_FEED_MIN_TRIGGER_INTERVAL_MS;
    });
    const rig = runtimeRig();
    t.after(() => rig.runtime.stop());
    addPriceTrigger(rig.triggers);

    rig.runtime.ensure();

    assert.equal(
      rig.priceFeed.subscribed[0].minIntervalMs,
      250,
      "the configured trigger throttle must reach the feed subscription",
    );
  });

  it("falls back to the legacy throttle variable and then to no throttle", (t) => {
    const previousPrimary = process.env.PRICE_FEED_MIN_TRIGGER_INTERVAL_MS;
    const previousLegacy = process.env.TRIGGER_PRICE_FEED_MIN_INTERVAL_MS;
    delete process.env.PRICE_FEED_MIN_TRIGGER_INTERVAL_MS;
    process.env.TRIGGER_PRICE_FEED_MIN_INTERVAL_MS = "75";
    t.after(() => {
      if (previousPrimary !== undefined) process.env.PRICE_FEED_MIN_TRIGGER_INTERVAL_MS = previousPrimary;
      else delete process.env.PRICE_FEED_MIN_TRIGGER_INTERVAL_MS;
      if (previousLegacy !== undefined) process.env.TRIGGER_PRICE_FEED_MIN_INTERVAL_MS = previousLegacy;
      else delete process.env.TRIGGER_PRICE_FEED_MIN_INTERVAL_MS;
    });

    const legacy = runtimeRig();
    t.after(() => legacy.runtime.stop());
    addPriceTrigger(legacy.triggers);
    legacy.runtime.ensure();
    assert.equal(
      legacy.priceFeed.subscribed[0].minIntervalMs,
      75,
      "the legacy throttle variable must still be honoured",
    );

    process.env.TRIGGER_PRICE_FEED_MIN_INTERVAL_MS = "not-a-number";
    const invalid = runtimeRig();
    t.after(() => invalid.runtime.stop());
    addPriceTrigger(invalid.triggers);
    invalid.runtime.ensure();
    assert.equal(
      invalid.priceFeed.subscribed[0].minIntervalMs,
      0,
      "an unusable throttle setting must fall back to no throttle",
    );
  });

  it("reconciles and sweeps due timers on every interval sweep", async (t) => {
    mock.timers.enable({ apis: ["setInterval"] });
    const rig = runtimeRig();
    t.after(() => rig.runtime.stop());
    addPriceTrigger(rig.triggers);

    rig.runtime.ensure();
    assert.equal(rig.priceFeed.ensureActiveCalls, 1, "precondition: ensure() reconciles once up front");

    mock.timers.tick(1000);
    await flush();

    assert.equal(rig.engine.dueTimerRuns, 1, "the interval sweep must process due timers");
    assert.equal(
      rig.priceFeed.ensureActiveCalls,
      3,
      "each sweep reconciles before the timer pass and again after it settles",
    );
  });

  it("does not stack a second interval when ensure is called again", (t) => {
    mock.timers.enable({ apis: ["setInterval"] });
    const rig = runtimeRig();
    t.after(() => rig.runtime.stop());
    addPriceTrigger(rig.triggers);

    rig.runtime.ensure();
    rig.runtime.ensure();
    rig.priceFeed.ensureActiveCalls = 0;
    mock.timers.tick(1000);

    assert.equal(rig.priceFeed.ensureActiveCalls, 1, "a repeated ensure() must not double the reconcile interval");
  });

  it("releases subscriptions, the interval and the account stream on stop", (_t) => {
    mock.timers.enable({ apis: ["setInterval"] });
    const rig = runtimeRig();
    addPriceTrigger(rig.triggers);
    rig.runtime.ensure();
    assert.deepStrictEqual(
      rig.priceFeed.subscribed.map((x) => x.symbol),
      ["BTC"],
      "precondition: a live subscription exists to release",
    );

    rig.runtime.stop();
    rig.priceFeed.ensureActiveCalls = 0;
    mock.timers.tick(5000);

    assert.deepStrictEqual(rig.priceFeed.unsubscribed, ["BTC"], "stop must release every symbol subscription");
    assert.equal(rig.priceFeed.ensureActiveCalls, 0, "stop must clear the reconcile interval");
    assert.equal(rig.userData.stops, 1, "stop must close the account stream");
  });

  it("releases only the symbol whose trigger was cancelled", (t) => {
    const rig = runtimeRig();
    t.after(() => rig.runtime.stop());
    addPriceTrigger(rig.triggers, "BTC");
    const eth = addPriceTrigger(rig.triggers, "ETH");
    rig.runtime.ensure();
    assert.deepStrictEqual(
      rig.priceFeed.subscribed.map((x) => x.symbol),
      ["BTC", "ETH"],
      "precondition: both symbols are watched",
    );

    rig.triggers.cancel(eth.id);
    rig.runtime.reconcile();

    assert.deepStrictEqual(
      rig.priceFeed.unsubscribed,
      ["ETH"],
      "only the symbol nothing watches any more may be released",
    );
    assert.deepStrictEqual(
      rig.priceFeed.subscribed.map((x) => x.symbol),
      ["BTC", "ETH"],
      "the surviving symbol must not be re-subscribed",
    );
  });

  it("starts the account stream from reconcile when a trigger needs position data", (t) => {
    const rig = runtimeRig();
    t.after(() => rig.runtime.stop());
    rig.triggers.add({ kind: "LIMIT", symbol: "ETH", side: "SELL", triggerPrice: 120, closePosition: true });

    rig.runtime.ensure();

    assert.equal(
      rig.userData.starts,
      1,
      "a close-position trigger must bring the account stream up without startAccountWatcher",
    );
    assert.equal(rig.userData.stops, 0, "the stream a trigger still needs must stay up");
  });
});

describe("TriggerRuntime account stream listeners", () => {
  it("records an order update in history and announces it", (t) => {
    const rig = runtimeRig();
    t.after(() => rig.runtime.stop());
    addPriceTrigger(rig.triggers);
    rig.runtime.ensure();

    rig.userData.emit("orderUpdate", { symbol: "BTC", side: "BUY", status: "FILLED", orderId: "77" });

    assert.deepStrictEqual(
      rig.orderHistory.upserts,
      [{ symbol: "BTC", side: "BUY", status: "FILLED", orderId: "77" }],
      "order updates must reach the history store",
    );
    assert.deepStrictEqual(rig.notifications, ["Order update: BUY BTC status=FILLED"]);
  });

  it("announces an order update even without a history store configured", (t) => {
    const rig = runtimeRig({ withOrderHistory: false });
    t.after(() => rig.runtime.stop());
    addPriceTrigger(rig.triggers);
    rig.runtime.ensure();

    rig.userData.emit("orderUpdate", { symbol: "ETH", side: "SELL", status: "NEW" });

    assert.deepStrictEqual(
      rig.notifications,
      ["Order update: SELL ETH status=NEW"],
      "an absent history store must not suppress the notification",
    );
  });

  it("relays stream warnings and errors to the notifier", (t) => {
    const rig = runtimeRig();
    t.after(() => rig.runtime.stop());
    addPriceTrigger(rig.triggers);
    rig.runtime.ensure();

    rig.userData.emit("warning", "reconnecting soon");
    rig.userData.emit("error", new Error("socket closed"));
    rig.userData.emit("error", "plain string failure");

    assert.deepStrictEqual(
      rig.notifications,
      ["reconnecting soon", "Account stream warning: socket closed", "Account stream warning: plain string failure"],
      "warnings and both error shapes must reach the user",
    );
  });

  it("stores a position update and reprocesses that symbol", async (t) => {
    const rig = runtimeRig();
    t.after(() => rig.runtime.stop());
    addPriceTrigger(rig.triggers);
    rig.runtime.ensure();

    rig.userData.emit("positionUpdate", { symbol: "BTC", positionAmt: 2, avgEntryPrice: 100, markPrice: 101 });
    await flush();

    assert.equal(rig.positions.get("BTC").netQty, 2, "the position update must be persisted");
    assert.deepStrictEqual(rig.engine.positionUpdates, ["BTC"], "the engine must re-evaluate the updated symbol");
  });

  it("ignores a position update that carries no quantity", async (t) => {
    const rig = runtimeRig();
    t.after(() => rig.runtime.stop());
    addPriceTrigger(rig.triggers);
    rig.runtime.ensure();
    rig.userData.emit("positionUpdate", { symbol: "BTC", positionAmt: 2 });
    await flush();
    assert.deepStrictEqual(
      rig.engine.positionUpdates,
      ["BTC"],
      "precondition: a well-formed update does reach the engine",
    );

    rig.userData.emit("positionUpdate", { symbol: "BTC" });
    await flush();

    assert.deepStrictEqual(
      rig.engine.positionUpdates,
      ["BTC"],
      "an unusable position payload must not trigger re-evaluation",
    );
  });

  it("attaches the account stream listeners exactly once", (t) => {
    const rig = runtimeRig();
    t.after(() => rig.runtime.stop());
    addPriceTrigger(rig.triggers);

    rig.runtime.ensure();
    rig.runtime.startAccountWatcher();
    rig.runtime.ensure();
    rig.userData.emit("warning", "once please");

    assert.deepStrictEqual(
      rig.notifications,
      ["once please"],
      "repeated setup must not duplicate the stream listeners",
    );
  });
});

describe("TriggerRuntime startAccountWatcher", () => {
  it("starts the account stream and reports it running", (t) => {
    const rig = runtimeRig();
    t.after(() => rig.runtime.stop());

    const started = rig.runtime.startAccountWatcher();

    assert.equal(started, true);
    assert.equal(rig.userData.starts, 1, "the watcher must actually start the account stream");
  });

  it("does not restart an account stream it already started", (t) => {
    const rig = runtimeRig();
    t.after(() => rig.runtime.stop());
    rig.runtime.startAccountWatcher();

    const again = rig.runtime.startAccountWatcher();

    assert.equal(again, true, "the second call still reports the stream as running");
    assert.equal(rig.userData.starts, 1, "an already-running account stream must not be started twice");
  });

  it("reports failure and retries when the account stream refuses to start", (t) => {
    const rig = runtimeRig({ accountStreamStarts: false });
    t.after(() => rig.runtime.stop());

    assert.equal(
      rig.runtime.startAccountWatcher(),
      false,
      "a stream that will not start must be reported as not running",
    );
    assert.equal(rig.runtime.startAccountWatcher(), false);
    assert.equal(rig.userData.starts, 2, "a failed start must be retried on the next call");
  });

  it("lets a later reconcile stop a watcher-started stream once nothing needs it", (t) => {
    const rig = runtimeRig();
    t.after(() => rig.runtime.stop());
    rig.runtime.startAccountWatcher();
    assert.equal(rig.userData.starts, 1, "precondition: the watcher started the stream");

    rig.runtime.reconcile();

    assert.equal(rig.userData.stops >= 1, true, "an account stream nothing needs must be released on reconcile");
  });
});
