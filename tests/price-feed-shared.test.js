"use strict";

const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");

const { PriceFeedService } = require("../dist/utils/price-feed.service");

/**
 * Minimal stand-in for the `ws` socket the feed would otherwise open.
 *
 * It models only what `PriceFeedService` touches: the `readyState` values the
 * service checks (0 connecting, 1 open, 3 closed), `on`/`send`/`close`, and an
 * `emit` the tests use to drive lifecycle and market-data events by hand. Every
 * instance is recorded on `FakeWebSocket.instances`, so a case can assert how
 * many sockets the feed created and reach the one it cares about.
 */
class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.handlers = new Map();
    this.sent = [];
    this.closed = false;
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
  return JSON.stringify({
    s: symbol,
    bids: [{ p: bid, q: bidQty }],
    asks: [{ p: ask, q: askQty }],
  });
}

/** Parsed view of every control frame the feed wrote to a socket. */
function sent(ws) {
  return ws.sent.map((payload) => JSON.parse(payload));
}

/** Wraps a payload the way the real transport hands frames to the feed. */
function frame(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
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

/**
 * The shared fixture the original suite drove as one long script: one feed with
 * two subscribers on the same symbol, spelled differently to pin case-insensitive
 * normalization. The socket is created but NOT yet open, so a case can assert
 * pre-open behaviour before calling `ws.emit('open')`.
 */
function twoBtcSubscribers(t, overrides = {}) {
  const { feed, warnings } = makeFeed(t, { reconnectMs: 10, ...overrides });
  const seenA = [];
  const seenB = [];
  const stopA = feed.subscribe("btc", (quote) => seenA.push(quote), 0);
  const stopB = feed.subscribe("BTC", (quote) => seenB.push(quote), 0);
  return { feed, warnings, seenA, seenB, stopA, stopB, ws: FakeWebSocket.instances[0] };
}

// The original suite reset the instance list inline between scenarios. Doing it
// before every case keeps `instances[0]` the socket of the case under test.
beforeEach(() => {
  FakeWebSocket.instances = [];
});

describe("price feed subscribe multiplexing and reference counting", () => {
  it("shares one multiplexed websocket between two subscribers of the same symbol", (t) => {
    const { feed } = twoBtcSubscribers(t);

    assert.equal(FakeWebSocket.instances.length, 1, "subscribers should share one multiplexed websocket");
    assert.equal(feed.activeStreamCount(), 1);
    assert.equal(feed.activeSocketCount(), 1);
    assert.equal(feed.activeSymbolCount(), 1);
    assert.equal(feed.subscriberCount("BTC"), 2);
  });

  it("holds subscribe frames until the websocket is open", (t) => {
    const { ws } = twoBtcSubscribers(t);

    assert.deepStrictEqual(ws.sent, [], "subscriptions should wait until websocket open");

    ws.emit("open");

    assert.deepStrictEqual(sent(ws), [{ symbol: "BTC", unsubscribe: 0 }]);
  });

  it("multiplexes a second symbol onto the socket already serving the first", (t) => {
    const { feed, ws } = twoBtcSubscribers(t);
    ws.emit("open");

    feed.subscribe("ETH", () => undefined, 0);

    assert.equal(FakeWebSocket.instances.length, 1, "BTC and ETH should share the same multiplexed websocket");
    assert.equal(feed.activeStreamCount(), 1);
    assert.equal(feed.activeSocketCount(), 1);
    assert.equal(feed.activeSymbolCount(), 2);
    assert.deepStrictEqual(sent(ws), [
      { symbol: "BTC", unsubscribe: 0 },
      { symbol: "ETH", unsubscribe: 0 },
    ]);
  });
});

describe("price feed quote delivery", () => {
  it("delivers a two-sided book to every subscriber of the symbol", (t) => {
    const { feed, seenA, seenB, ws } = twoBtcSubscribers(t);
    ws.emit("open");

    ws.emit("message", frame(book("BTC", 99, 100, 3, 4)));

    assert.equal(seenA.length, 1);
    assert.equal(seenB.length, 1);
    assert.equal(seenA[0].bid, 99);
    assert.equal(seenA[0].ask, 100);
    assert.equal(feed.getSnapshot("BTC").askQty, 4);
  });

  it("delivers ask-only L2 frames so BUY triggers can use ask depth", (t) => {
    const { seenA, ws } = twoBtcSubscribers(t);
    ws.emit("open");
    // A full book first, so the case proves a side-only delta is delivered on top
    // of an existing snapshot rather than merely that the first frame arrives.
    ws.emit("message", frame(book("BTC", 99, 100, 3, 4)));

    ws.emit("message", frame({ s: "BTC", asks: [{ p: 98, q: 7 }] }));

    assert.equal(seenA.length, 2, "ask-only L2 frames should be delivered so BUY triggers can use ask depth");
    assert.equal(seenA[1].ask, 98);
    assert.equal(seenA[1].askQty, 7);
    assert.equal(seenA[1].bid, undefined);
  });

  it("delivers bid-only L2 frames so SELL triggers can use bid depth", (t) => {
    const { seenA, ws } = twoBtcSubscribers(t);
    ws.emit("open");
    ws.emit("message", frame(book("BTC", 99, 100, 3, 4)));

    ws.emit("message", frame({ s: "BTC", bids: [{ p: 101, q: 8 }] }));

    assert.equal(seenA.length, 2, "bid-only L2 frames should be delivered so SELL triggers can use bid depth");
    assert.equal(seenA[1].bid, 101);
    assert.equal(seenA[1].bidQty, 8);
    assert.equal(seenA[1].ask, undefined);
  });

  it("routes a frame only to the subscribers of that frame's symbol", (t) => {
    const { feed, seenA, ws } = twoBtcSubscribers(t);
    ws.emit("open");

    const seenEth = [];
    feed.subscribe("ETH", (quote) => seenEth.push(quote), 0);
    ws.emit("message", frame(book("ETH", 20, 21, 5, 6)));

    assert.equal(seenEth.length, 1);
    assert.equal(seenEth[0].symbol, "ETH");
    assert.equal(feed.getSnapshot("ETH").askQty, 6);
    assert.equal(seenA.length, 0, "an ETH frame must not reach BTC subscribers");
  });

  it("throttles a subscriber to its minIntervalMs", (t) => {
    const realNow = Date.now;
    let fakeNow = 2_000_000;
    Date.now = () => fakeNow;
    t.after(() => {
      Date.now = realNow;
    });

    const { feed } = makeFeed(t);
    const seen = [];
    feed.subscribe("BTC", (quote) => seen.push(quote), 1000);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");

    ws.emit("message", frame(book("BTC", 99, 100)));
    fakeNow += 500;
    ws.emit("message", frame(book("BTC", 98, 99)));

    assert.equal(seen.length, 1, "a second quote inside minIntervalMs must be suppressed");
    assert.equal(seen[0].ask, 100);
  });

  it("delivers again once minIntervalMs has elapsed", (t) => {
    const realNow = Date.now;
    let fakeNow = 3_000_000;
    Date.now = () => fakeNow;
    t.after(() => {
      Date.now = realNow;
    });

    const { feed } = makeFeed(t);
    const seen = [];
    feed.subscribe("BTC", (quote) => seen.push(quote), 1000);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");

    ws.emit("message", frame(book("BTC", 99, 100)));
    fakeNow += 1_500;
    ws.emit("message", frame(book("BTC", 98, 99)));

    assert.equal(seen.length, 2, "a quote past minIntervalMs must be delivered");
    assert.equal(seen[1].ask, 99);
  });
});

describe("price feed unsubscribe and socket lifecycle", () => {
  it("keeps a symbol subscribed while one of its two subscribers remains", (t) => {
    const { feed, stopA, ws } = twoBtcSubscribers(t);
    ws.emit("open");

    stopA();

    assert.equal(feed.subscriberCount("BTC"), 1, "unsubscribing one subscriber should keep BTC subscribed");
    assert.equal(ws.closed, false);
    assert.deepStrictEqual(
      sent(ws).filter((x) => x.symbol === "BTC"),
      [{ symbol: "BTC", unsubscribe: 0 }],
    );
  });

  it("unsubscribes a symbol whose final subscriber left while keeping the socket open for other symbols", (t) => {
    const { feed, stopA, stopB, ws } = twoBtcSubscribers(t);
    ws.emit("open");
    feed.subscribe("ETH", () => undefined, 0);

    stopA();
    stopB();

    assert.equal(feed.subscriberCount("BTC"), 0);
    assert.equal(feed.activeSymbolCount(), 1, "ETH should remain active after BTC leaves");
    assert.equal(ws.closed, false, "multiplexed websocket should stay open while ETH is active");
    assert.deepStrictEqual(
      sent(ws).filter((x) => x.symbol === "BTC"),
      [
        { symbol: "BTC", unsubscribe: 0 },
        { symbol: "BTC", unsubscribe: 1 },
      ],
    );
  });

  it("stops delivering a symbol's frames once its final subscriber left", (t) => {
    const { feed, seenA, seenB, stopA, stopB, ws } = twoBtcSubscribers(t);
    ws.emit("open");
    feed.subscribe("ETH", () => undefined, 0);
    // Deliver once while subscribed, so the post-unsubscribe assertion below can
    // only pass because delivery stopped, not because it never worked.
    ws.emit("message", frame(book("BTC", 99, 100)));
    assert.equal(seenA.length, 1);
    assert.equal(seenB.length, 1);

    stopA();
    stopB();
    ws.emit("message", frame(book("BTC", 88, 89)));

    assert.equal(seenA.length, 1, "unsubscribed BTC must not be delivered");
    assert.equal(seenB.length, 1, "unsubscribed BTC must not be delivered");
  });

  it("closes the multiplexed socket after the final active symbol leaves", (t) => {
    const { feed, warnings, stopA, stopB, ws } = twoBtcSubscribers(t);
    ws.emit("open");
    const stopEth = feed.subscribe("ETH", () => undefined, 0);
    stopA();
    stopB();

    stopEth();

    assert.equal(feed.subscriberCount(), 0);
    assert.equal(feed.activeSymbolCount(), 0);
    assert.equal(ws.closed, true, "multiplexed websocket should close after final active symbol leaves");
    // Unsubscribing BTC above runs resubscribeRemainingActiveSymbols, which force-resends a
    // subscribe for every symbol still active. That re-assertion is deliberate (added in 9add03d
    // "bug fixing", after this test was written), so ETH is legitimately subscribed twice.
    assert.deepStrictEqual(
      sent(ws).filter((x) => x.symbol === "ETH"),
      [
        { symbol: "ETH", unsubscribe: 0 },
        { symbol: "ETH", unsubscribe: 0 },
        { symbol: "ETH", unsubscribe: 1 },
      ],
    );
    assert.deepStrictEqual(warnings, []);
  });

  it("unsubscribes the final symbol immediately even when socket idle-close is delayed", (t) => {
    const { feed } = makeFeed(t, { idleCloseMs: 1000 });
    const stopIdle = feed.subscribe("BNB", () => undefined, 0);
    const idleWs = FakeWebSocket.instances[0];
    idleWs.emit("open");

    stopIdle();

    assert.deepStrictEqual(
      sent(idleWs),
      [
        { symbol: "BNB", unsubscribe: 0 },
        { symbol: "BNB", unsubscribe: 1 },
      ],
      "final symbol subscriber should unsubscribe immediately even when socket idle-close is delayed",
    );
    assert.equal(idleWs.closed, false, "socket can stay open briefly with zero active symbol subscriptions");
    // The pending idle timer must not outlive the case: closing here proves it is
    // cancelled rather than left to fire (and close a socket) after the test.
    feed.closeAll();
    assert.equal(idleWs.closed, true, "closeAll should close the idling socket");
  });
});

describe("price feed cached snapshot replay", () => {
  it("replays the cached shared snapshot to a late subscriber", async (t) => {
    const { feed } = makeFeed(t);
    const first = [];
    const stopFirst = feed.subscribe("SOL", (quote) => first.push(quote), 0);
    FakeWebSocket.instances[0].emit("open");
    FakeWebSocket.instances[0].emit("message", frame(book("SOL", 20, 21)));
    assert.equal(first.length, 1);
    stopFirst();

    const replayed = [];
    feed.subscribe("SOL", (quote) => replayed.push(quote), 0);
    FakeWebSocket.instances[1].emit("open");
    await flush();

    assert.equal(replayed.length, 1, "new subscribers should receive the cached shared snapshot");
    assert.equal(replayed[0].ask, 21);
  });

  it("does not replay a snapshot older than maxSnapshotAgeMs", async (t) => {
    const realNow = Date.now;
    let fakeNow = 1_000_000;
    Date.now = () => fakeNow;
    t.after(() => {
      Date.now = realNow;
    });

    const { feed } = makeFeed(t, { maxSnapshotAgeMs: 1000 });
    const firstStale = [];
    const stopStaleFirst = feed.subscribe("XLM", (quote) => firstStale.push(quote), 0);
    FakeWebSocket.instances[0].emit("open");
    FakeWebSocket.instances[0].emit("message", frame(book("XLM", 1, 2)));
    assert.equal(firstStale.length, 1);
    stopStaleFirst();

    // Precondition: a cached snapshot really is sitting there to be replayed, so
    // the empty assertion below can only pass because of its age. Without this,
    // the case would also pass if snapshot caching had stopped working entirely.
    const cached = feed.getSnapshot("XLM");
    assert.equal(cached?.ask, 2, "the first subscriber should have left a cached XLM snapshot behind");
    assert.equal(cached.ts, 1_000_000);

    fakeNow += 2_000;
    const staleReplayed = [];
    feed.subscribe("XLM", (quote) => staleReplayed.push(quote), 0);
    FakeWebSocket.instances[1].emit("open");
    await flush();

    assert.equal(staleReplayed.length, 0, "stale cached snapshots must not be replayed to fresh trigger subscribers");
  });
});

describe("price feed reconnect behaviour", () => {
  it("reconnects every active symbol onto one shared socket after the socket closes", async (t) => {
    const { feed } = makeFeed(t, { reconnectMs: 1 });
    feed.subscribe("BTC", () => undefined, 0);
    feed.subscribe("ADA", () => undefined, 0);
    FakeWebSocket.instances[0].emit("open");

    FakeWebSocket.instances[0].emit("close");
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(FakeWebSocket.instances.length, 2, "active symbols should reconnect on one shared socket");
    FakeWebSocket.instances[1].emit("open");
    assert.deepStrictEqual(sent(FakeWebSocket.instances[1]), [
      { symbol: "ADA", unsubscribe: 0 },
      { symbol: "BTC", unsubscribe: 0 },
    ]);
  });
});

describe("price feed market frame shapes", () => {
  it("routes batched pair-symbol frames to the base ticker subscribers", (t) => {
    const { feed } = makeFeed(t);
    const batchBtc = [];
    const batchEth = [];
    feed.subscribe("BTC", (quote) => batchBtc.push(quote), 0);
    feed.subscribe("ETH", (quote) => batchEth.push(quote), 0);
    const batchWs = FakeWebSocket.instances[0];
    batchWs.emit("open");

    batchWs.emit(
      "message",
      frame([
        { s: "BTC/USD", bids: [{ p: 50, q: 1 }], asks: [{ p: 51, q: 1 }] },
        { s: "ETH", bids: [{ p: 60, q: 2 }], asks: [{ p: 61, q: 2 }] },
      ]),
    );

    assert.equal(batchBtc.length, 1, "batched pair-symbol frames should route to the base ticker subscriber");
    assert.equal(batchEth.length, 1, "batched frames should route per symbol");
    assert.equal(batchBtc[0].symbol, "BTC");
    assert.equal(batchBtc[0].ask, 51);
    assert.equal(batchEth[0].ask, 61);
  });

  it("routes symbol-keyed data maps to the active base ticker subscribers", (t) => {
    const { feed } = makeFeed(t);
    const batchBtc = [];
    const batchEth = [];
    feed.subscribe("BTC", (quote) => batchBtc.push(quote), 0);
    feed.subscribe("ETH", (quote) => batchEth.push(quote), 0);
    const batchWs = FakeWebSocket.instances[0];
    batchWs.emit("open");

    batchWs.emit(
      "message",
      frame({
        data: {
          BTCUSDT: { bids: [{ p: 52, q: 3 }], asks: [{ p: 53, q: 3 }] },
          ETH_USD: { bids: [{ p: 62, q: 4 }], asks: [{ p: 63, q: 4 }] },
        },
      }),
    );

    assert.equal(batchBtc.length, 1, "symbol-keyed data maps should route to active base ticker subscribers");
    assert.equal(batchEth.length, 1, "symbol-keyed data maps should route ETH_USD to ETH subscribers");
    assert.equal(batchBtc[0].ask, 53);
    assert.equal(batchEth[0].ask, 63);
  });

  it("does not strip a quote suffix out of a base symbol that merely ends in ETH", (t) => {
    const { feed } = makeFeed(t);
    const steth = [];
    feed.subscribe("STETH", (quote) => steth.push(quote), 0);
    FakeWebSocket.instances[0].emit("open");

    FakeWebSocket.instances[0].emit("message", frame({ s: "STETH", bids: [{ p: 9, q: 1 }], asks: [{ p: 10, q: 1 }] }));

    assert.equal(steth.length, 1, "base symbols ending in ETH must not be stripped as ETH-quoted pairs");
    assert.equal(steth[0].symbol, "STETH");
  });
});

describe("price feed URL configuration", () => {
  // The feed falls back to LIQUIDITY_WS_URL when its configured url resolves to
  // nothing, so these cases have to run with that variable absent.
  const previousUrl = process.env.LIQUIDITY_WS_URL;

  before(() => {
    delete process.env.LIQUIDITY_WS_URL;
  });

  after(() => {
    if (previousUrl !== undefined) process.env.LIQUIDITY_WS_URL = previousUrl;
  });

  it("warns once instead of crashing when no feed URL is configured", (t) => {
    const missingWarnings = [];
    const { feed } = makeFeed(t, { url: () => undefined, onWarning: (message) => missingWarnings.push(message) });

    feed.subscribe("XRP", () => undefined, 0);
    feed.subscribe("DOT", () => undefined, 0);

    assert.equal(FakeWebSocket.instances.length, 0, "missing LIQUIDITY_WS_URL should not create a socket");
    assert.equal(missingWarnings.length, 1, "missing LIQUIDITY_WS_URL should warn once instead of crashing");
  });

  it("connects and subscribes on ensureActive once the feed URL becomes available", (t) => {
    let lateUrl;
    const { feed } = makeFeed(t, { url: () => lateUrl, onWarning: () => undefined });
    feed.subscribe("XRP", () => undefined, 0);
    assert.equal(FakeWebSocket.instances.length, 0, "no socket should exist before the feed URL is known");

    lateUrl = "ws://example.test/l2";
    feed.ensureActive();

    assert.equal(
      FakeWebSocket.instances.length,
      1,
      "ensureActive should recover when the feed URL becomes available after subscription",
    );
    FakeWebSocket.instances[0].emit("open");
    assert.deepStrictEqual(sent(FakeWebSocket.instances[0]), [{ symbol: "XRP", unsubscribe: 0 }]);
  });
});
