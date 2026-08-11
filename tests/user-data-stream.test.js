"use strict";

const { describe, it, beforeEach, after, mock } = require("node:test");
const assert = require("node:assert/strict");

const { stubRequire } = require("./helpers/module-stub");
const { tempFile, cleanupTempDirs } = require("./helpers/tmp");

/**
 * Every socket the service has constructed since the last case, oldest first.
 * Reset in `beforeEach`, so `sockets.length` is itself an assertable fact:
 * "the stream opened exactly one connection".
 */
const sockets = [];

/**
 * Stands in for the `ws` constructor.
 *
 * Only the surface the service actually touches is modelled: `on`, `send`,
 * `close`, `readyState` and the static ready-state constants. The driver
 * methods (`fire`, `open`, `deliver`) let a case invoke the handlers the
 * service registered, which is how socket lifecycle is simulated without a
 * real connection, a timer or a port.
 *
 * Two behaviours are copied from the real socket on purpose, because tests
 * depend on them to be meaningful:
 *
 *   - `close()` transitions to CLOSED and fires the `close` handlers, exactly
 *     once. A second `close()` is a no-op, as on a real socket.
 *   - a CLOSED socket delivers no further frames and refuses `send`. That is
 *     what makes "no frames reach the subscriber after `stop()`" a real
 *     assertion: if `stop()` ever forgot to close the socket, this fake would
 *     happily keep delivering and the case would fail.
 */
class FakeSocket {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    /** Raw payloads passed to `send`, in order. */
    this.sent = [];
    /** One entry per accepted `close(code, reason)`. */
    this.closes = [];
    this.readyState = FakeSocket.CONNECTING;
    this.handlers = new Map();
    sockets.push(this);
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(handler);
    return this;
  }

  send(data) {
    if (this.readyState === FakeSocket.CLOSED) throw new Error("send() on a closed socket");
    this.sent.push(data);
  }

  close(code, reason) {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.closes.push({ code, reason });
    this.fire("close", code, reason);
  }

  /** Invoke the handlers the service registered for `event`. */
  fire(event, ...args) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  /** Complete the handshake half of the lifecycle: socket becomes OPEN. */
  open() {
    this.readyState = FakeSocket.OPEN;
    this.fire("open");
  }

  /**
   * Push an inbound frame. Objects are JSON-encoded; strings go out verbatim
   * so malformed payloads can be tested. Returns whether the socket was still
   * able to deliver it.
   */
  deliver(payload) {
    if (this.readyState === FakeSocket.CLOSED) return false;
    this.fire("message", Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)));
    return true;
  }
}
FakeSocket.CONNECTING = 0;
FakeSocket.OPEN = 1;
FakeSocket.CLOSING = 2;
FakeSocket.CLOSED = 3;

// Must run before anything from `../dist/` is required: the stream service does
// `const ws = require('ws')` once, at module load time.
const restoreRequire = stubRequire({ ws: FakeSocket });

const { UserDataStreamService, UserDataStreamSvc } = require("../dist/utils/user-data-stream.service");
const { PositionStore } = require("../dist/triggers/position-store");
const { PositionSyncService } = require("../dist/triggers/position-sync");

// Both modules read process.env at call time. Start from a known-empty state so
// an ambient value in the developer's shell cannot change what is asserted.
const OWNED_ENV = ["LISTEN_KEY_WS_URL", "TRADE_API_KEY", "SESSION_DEBUG", "POSITIONS_ENDPOINT"];
const savedEnv = Object.fromEntries(OWNED_ENV.map((key) => [key, process.env[key]]));
for (const key of OWNED_ENV) delete process.env[key];

after(() => {
  restoreRequire();
  cleanupTempDirs();
  mock.timers.reset();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  sockets.length = 0;
});

const URL = "wss://stream.test/user";

/**
 * A stream plus a record of everything it emitted. The `error` listener is
 * always attached: an EventEmitter with no `error` listener throws, so its
 * absence would turn a dispatched error into a crash instead of a assertion.
 */
function stream(options = {}) {
  const svc = new UserDataStreamService({ url: URL, requestToken: "tok-1", ...options });
  const events = { orderUpdate: [], positionUpdate: [], error: [], warning: [] };
  for (const name of Object.keys(events)) svc.on(name, (payload) => events[name].push(payload));
  return { svc, events };
}

/** The socket the service opened most recently. */
function socket(index = sockets.length - 1) {
  return sockets[index];
}

/** Set env vars for one case only, restoring the previous values afterwards. */
function withEnv(t, values) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** Collect `console.log` argument lists for one case only. */
function captureLog(t) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args);
  t.after(() => {
    console.log = original;
  });
  return lines;
}

/** A started stream whose socket has completed its handshake. */
function opened(t, options) {
  const rig = stream(options);
  assert.equal(rig.svc.start(), true);
  socket().open();
  t.after(() => rig.svc.stop());
  return rig;
}

describe("UserDataStreamService connection setup", () => {
  it("opens exactly one socket at the configured stream url", (t) => {
    const { svc } = stream();
    t.after(() => svc.stop());

    assert.equal(svc.start(), true);

    assert.equal(sockets.length, 1);
    assert.equal(socket().url, URL);
  });

  it("sends the unsubscribe handshake carrying the request token once the socket opens", (t) => {
    const { svc } = stream();
    t.after(() => svc.stop());
    svc.start();

    assert.deepEqual(socket().sent, [], "the handshake must wait for the socket to open");
    socket().open();

    assert.deepEqual(JSON.parse(socket().sent[0]), { unsubscribe: 0, requestToken: "tok-1" });
  });

  it("resolves the request token afresh on every start when given a factory", (t) => {
    let token = "first-key";
    const { svc } = stream({ requestToken: () => token });
    t.after(() => svc.stop());

    svc.start();
    socket().open();
    assert.equal(JSON.parse(socket().sent[0]).requestToken, "first-key");

    svc.stop();
    token = "rotated-key";
    svc.start();
    socket().open();

    assert.equal(
      JSON.parse(socket().sent[0]).requestToken,
      "rotated-key",
      "a token factory must be consulted per start, not captured at construction",
    );
  });

  it("falls back to the environment url and api key when the stream allows it", (t) => {
    withEnv(t, { LISTEN_KEY_WS_URL: "wss://env.test/user", TRADE_API_KEY: "env-key" });
    t.after(() => {
      UserDataStreamSvc.stop();
      UserDataStreamSvc.removeAllListeners();
    });
    UserDataStreamSvc.on("error", () => undefined);

    assert.equal(UserDataStreamSvc.start(), true);
    socket().open();

    assert.equal(socket().url, "wss://env.test/user");
    assert.equal(JSON.parse(socket().sent[0]).requestToken, "env-key");
  });

  it("refuses the environment api key when the stream does not allow the fallback", (t) => {
    withEnv(t, { LISTEN_KEY_WS_URL: "wss://env.test/user", TRADE_API_KEY: "env-key" });
    const { svc, events } = stream({ url: undefined, requestToken: undefined });
    t.after(() => svc.stop());

    assert.equal(svc.start(), false);

    assert.equal(sockets.length, 0, "no socket may be opened without a token");
    assert.match(events.warning[0], /missing session api key\./);
  });

  it("treats a blank url as missing configuration and names the missing setting", (t) => {
    const { svc, events } = stream({ url: "   " });
    t.after(() => svc.stop());

    assert.equal(svc.start(), false);

    assert.equal(sockets.length, 0);
    assert.match(events.warning[0], /missing LISTEN_KEY_WS_URL\./);
  });

  it("treats a blank request token as missing configuration", (t) => {
    const { svc, events } = stream({ requestToken: "  " });
    t.after(() => svc.stop());

    assert.equal(svc.start(), false);

    assert.equal(sockets.length, 0);
    assert.match(events.warning[0], /missing session api key\./);
  });

  it("names the owner in the configuration warning when the stream is scoped to one", (t) => {
    const { svc, events } = stream({ ownerId: "owner-9", url: undefined });
    t.after(() => svc.stop());

    svc.start();

    assert.deepEqual(events.warning, ["Account stream not started for owner owner-9: missing LISTEN_KEY_WS_URL."]);
  });

  it("warns once about missing configuration, and again after a healthy start is lost", (t) => {
    withEnv(t, { LISTEN_KEY_WS_URL: undefined });
    const { svc, events } = stream({ url: undefined });
    t.after(() => svc.stop());

    svc.start();
    svc.start();
    assert.equal(events.warning.length, 1, "a repeated failing start must not repeat the warning");

    process.env.LISTEN_KEY_WS_URL = URL;
    assert.equal(svc.start(), true, "the stream must start once the url appears");
    svc.stop();

    delete process.env.LISTEN_KEY_WS_URL;
    assert.equal(svc.start(), false);
    assert.equal(events.warning.length, 2, "losing configuration again must warn again");
  });

  it("reuses a connecting or open socket instead of opening a second one", (t) => {
    const { svc } = stream();
    t.after(() => svc.stop());

    svc.start();
    assert.equal(socket().readyState, FakeSocket.CONNECTING);
    assert.equal(svc.start(), true);
    assert.equal(sockets.length, 1, "a connecting socket must be reused");

    socket().open();
    assert.equal(svc.start(), true);
    assert.equal(sockets.length, 1, "an open socket must be reused");
  });

  it("does not run the handshake on a socket the stream has already replaced", (t) => {
    const { svc } = stream();
    t.after(() => svc.stop());
    svc.start();
    const stale = socket();

    // The transport went away without firing `close`; the next start replaces it.
    stale.readyState = FakeSocket.CLOSING;
    svc.start();
    assert.equal(sockets.length, 2);

    stale.fire("open");
    assert.deepEqual(stale.sent, [], "a superseded socket must not authenticate");

    socket().open();
    assert.equal(socket().sent.length, 1, "the current socket must still authenticate");
  });

  it("logs the start decision when session debugging is on", (t) => {
    withEnv(t, { SESSION_DEBUG: "true" });
    const lines = captureLog(t);
    const { svc } = stream({ ownerId: "owner-3" });
    t.after(() => svc.stop());

    svc.start();

    assert.deepEqual(lines, [["[USER_STREAM_START]", { ownerId: "owner-3", hasUrl: true, hasToken: true }]]);
  });
});

describe("UserDataStreamService inbound frames", () => {
  const ORDER = {
    s: "BTC/USDT",
    S: "BUY",
    T: 1_700_000_000_000,
    L: 101.5,
    a: 101.25,
    c: "cid-7",
    f: "GTC",
    i: 8814,
    l: 0.25,
    q: 1,
    p: 100,
    p2: 99,
    o: "LIMIT",
    X: "PARTIALLY_FILLED",
    x: "TRADE",
    r: "NONE",
    z: 0.25,
    t: 4321,
    lv: 0.75,
  };

  it("dispatches an order update with exchange numbers coerced to strings", (t) => {
    const { events } = opened(t, {});

    socket().deliver({ e: "ORDER_TRADE_UPDATE", o: ORDER });

    assert.equal(events.orderUpdate.length, 1);
    const update = events.orderUpdate[0];
    assert.deepEqual(
      {
        symbol: update.symbol,
        side: update.side,
        timestamp: update.timestamp,
        lastPx: update.lastPx,
        avgPx: update.avgPx,
        clientOrderId: update.clientOrderId,
        timeInForce: update.timeInForce,
        orderId: update.orderId,
        lastQty: update.lastQty,
        quantity: update.quantity,
        price: update.price,
        price2: update.price2,
        ordType: update.ordType,
        orderType: update.orderType,
        type: update.type,
        ordStatus: update.ordStatus,
        status: update.status,
        execType: update.execType,
        orderRejectReason: update.orderRejectReason,
        cumQty: update.cumQty,
        execId: update.execId,
      },
      {
        symbol: "BTC",
        side: "BUY",
        timestamp: 1_700_000_000_000,
        lastPx: "101.5",
        avgPx: "101.25",
        clientOrderId: "cid-7",
        timeInForce: "GTC",
        orderId: "8814",
        lastQty: "0.25",
        quantity: "1",
        price: "100",
        price2: "99",
        ordType: "LIMIT",
        orderType: "LIMIT",
        type: "LIMIT",
        ordStatus: "PARTIALLY_FILLED",
        status: "PARTIALLY_FILLED",
        execType: "TRADE",
        orderRejectReason: "NONE",
        cumQty: "0.25",
        execId: "4321",
      },
    );
    assert.equal(update.leavesQty, 0.75);
    assert.equal(typeof update.leavesQty, "number", "leavesQty is the one numeric field");
    assert.equal(update.fillPrice, 101.5, "fillPrice keeps the raw last price");
    assert.deepEqual(update.raw, ORDER, "the untouched frame must travel with the update");
  });

  it("maps a flat ORDER_TRADE_UPDATE frame that carries the order at the top level", (t) => {
    const { events } = opened(t, {});

    socket().deliver({ e: "ORDER_TRADE_UPDATE", symbol: "ETH/USDT", S: "1", L: 2500 });

    assert.equal(events.orderUpdate.length, 1);
    assert.equal(events.orderUpdate[0].symbol, "ETH");
    assert.equal(events.orderUpdate[0].side, "BUY", "S === '1' is a buy");
  });

  it("defaults status, client order id and timestamp when the order omits them", (t) => {
    const before = Date.now();
    const { events } = opened(t, {});

    socket().deliver({ o: { s: "SOL" } });

    const update = events.orderUpdate[0];
    assert.equal(update.ordStatus, "NEW");
    assert.equal(update.status, "NEW");
    assert.equal(update.clientOrderId, "");
    assert.ok(update.timestamp >= before, "a missing exchange timestamp falls back to now");
    assert.equal(update.lastPx, undefined);
  });

  it("dispatches an order that names no symbol with an empty symbol", (t) => {
    const { events } = opened(t, {});

    socket().deliver({ o: { S: "BUY", L: 10 } });

    assert.equal(events.orderUpdate.length, 1, "a symbolless fill is still reported");
    assert.equal(events.orderUpdate[0].symbol, "");
  });

  it("reads the order status from a non-exchange status field", (t) => {
    const { events } = opened(t, {});

    socket().deliver({ o: { s: "SOL", status: "CANCELED" } });

    assert.equal(events.orderUpdate[0].status, "CANCELED");
  });

  it("reports any side other than buy as a sell", (t) => {
    const { events } = opened(t, {});

    socket().deliver({ o: { s: "BTC", S: "SELL" } });
    socket().deliver({ o: { s: "BTC", S: "2" } });

    assert.deepEqual(
      events.orderUpdate.map((update) => update.side),
      ["SELL", "SELL"],
    );
  });

  it("ignores an ORDER_TRADE_UPDATE whose order payload is empty", (t) => {
    const { events } = opened(t, {});

    socket().deliver({ e: "ORDER_TRADE_UPDATE", o: false });
    assert.equal(events.orderUpdate.length, 0, "an empty order must not be dispatched");

    socket().deliver({ e: "ORDER_TRADE_UPDATE", o: { s: "BTC" } });
    assert.equal(events.orderUpdate.length, 1, "the same frame with an order is dispatched");
  });

  it("dispatches one position update per account position with its aliases resolved", (t) => {
    const { events } = opened(t, {});

    socket().deliver({
      e: "ACCOUNT_UPDATE",
      a: {
        P: [
          { s: "BTC", pa: 0.5, aq: 0.4, ep: 100, m: 110 },
          { a: "ETH", pa: 2, uacb: 1800, sm: 1900 },
        ],
      },
    });

    assert.equal(events.positionUpdate.length, 2);
    assert.deepEqual(
      events.positionUpdate.map((p) => ({
        symbol: p.symbol,
        quantity: p.quantity,
        availableQuantity: p.availableQuantity,
        avgEntryPrice: p.avgEntryPrice,
        markPrice: p.markPrice,
      })),
      [
        { symbol: "BTC", quantity: 0.5, availableQuantity: 0.4, avgEntryPrice: 100, markPrice: 110 },
        { symbol: "ETH", quantity: 2, availableQuantity: 2, avgEntryPrice: 1800, markPrice: 1900 },
      ],
    );
  });

  it("drops account positions that carry no symbol at all", (t) => {
    const { events } = opened(t, {});

    socket().deliver({ e: "ACCOUNT_UPDATE", a: { P: [{ pa: 3 }, { s: "BTC", pa: 1 }] } });

    assert.deepEqual(
      events.positionUpdate.map((p) => p.symbol),
      ["BTC"],
      "only the entry with a symbol may be dispatched",
    );
  });

  it("merges the P and positions arrays of one account frame", (t) => {
    const { events } = opened(t, {});

    socket().deliver({
      e: "ACCOUNT_UPDATE",
      a: { P: [{ s: "BTC", pa: 1 }], positions: [{ symbol: "ETH", quantity: 2 }] },
    });

    assert.deepEqual(
      events.positionUpdate.map((p) => p.symbol),
      ["BTC", "ETH"],
    );
  });

  it("accepts a positions frame that has no account envelope", (t) => {
    const { events } = opened(t, {});

    socket().deliver({ positions: [{ symbol: "SOL", quantity: 3 }] });

    assert.equal(events.positionUpdate.length, 1);
    assert.deepEqual(
      { symbol: events.positionUpdate[0].symbol, availableQuantity: events.positionUpdate[0].availableQuantity },
      { symbol: "SOL", availableQuantity: 3 },
    );
  });

  it("accepts an account update nested under an account key", (t) => {
    const { events } = opened(t, {});

    socket().deliver({ e: "ACCOUNT_UPDATE", account: { positions: [{ symbol: "SOL", quantity: 1 }] } });

    assert.deepEqual(
      events.positionUpdate.map((p) => p.symbol),
      ["SOL"],
    );
  });

  it("dispatches nothing for a balance-only account frame", (t) => {
    const { events } = opened(t, {});

    socket().deliver({ a: { B: [{ a: "USDT", wb: 500 }] } });
    assert.equal(events.positionUpdate.length, 0, "a balance list holds no positions");

    socket().deliver({ a: { B: [{ a: "USDT", wb: 500 }], P: [{ s: "BTC", pa: 1 }] } });
    assert.equal(events.positionUpdate.length, 1, "the same frame with positions does dispatch");
  });

  it("reports a malformed frame as an error and keeps serving later frames", (t) => {
    const { events } = opened(t, {});

    assert.equal(socket().deliver("<html>gateway timeout</html>"), true);

    assert.equal(events.error.length, 1);
    assert.ok(events.error[0] instanceof SyntaxError, "the parse failure itself is surfaced");

    socket().deliver({ o: { s: "BTC", S: "BUY" } });
    assert.equal(events.orderUpdate.length, 1, "a bad frame must not tear the stream down");
  });

  it("forwards a socket transport error to error subscribers", (t) => {
    const { events } = opened(t, {});
    const failure = new Error("ECONNRESET");

    socket().fire("error", failure);

    assert.deepEqual(events.error, [failure]);
  });

  it("keeps each owner stream on its own subscribers", (t) => {
    const alice = stream({ ownerId: "alice", url: "wss://stream.test/alice", requestToken: "alice-key" });
    const bob = stream({ ownerId: "bob", url: "wss://stream.test/bob", requestToken: "bob-key" });
    t.after(() => {
      alice.svc.stop();
      bob.svc.stop();
    });

    alice.svc.start();
    const aliceSocket = socket();
    bob.svc.start();
    const bobSocket = socket();
    aliceSocket.open();
    bobSocket.open();

    assert.deepEqual(
      [JSON.parse(aliceSocket.sent[0]).requestToken, JSON.parse(bobSocket.sent[0]).requestToken],
      ["alice-key", "bob-key"],
      "each stream authenticates with its own session key",
    );

    aliceSocket.deliver({ o: { s: "BTC", S: "BUY" } });

    assert.equal(alice.events.orderUpdate.length, 1);
    assert.equal(bob.events.orderUpdate.length, 0, "one owner's fills must not reach another owner");
  });
});

describe("UserDataStreamService.stop", () => {
  it("closes the live socket with the client stop code", (t) => {
    const { svc } = opened(t, {});

    svc.stop();

    assert.deepEqual(socket().closes, [{ code: 1000, reason: "client stop" }]);
  });

  it("delivers no further frames to subscribers once stopped", (t) => {
    const { svc, events } = opened(t, {});
    const frame = { o: { s: "BTC", S: "BUY" } };

    assert.equal(socket().deliver(frame), true);
    assert.equal(events.orderUpdate.length, 1, "the subscriber receives frames while running");

    svc.stop();

    assert.equal(socket().deliver(frame), false, "stop() must have closed the socket");
    assert.equal(events.orderUpdate.length, 1, "no frame may reach the subscriber after stop");
  });

  it("leaves an already closed socket alone but still forgets it", (t) => {
    const { svc } = opened(t, {});
    socket().readyState = FakeSocket.CLOSED;

    svc.stop();

    assert.deepEqual(socket().closes, [], "a dead socket must not be closed again");
    assert.equal(svc.start(), true);
    assert.equal(sockets.length, 2, "the stopped stream forgot the dead socket and reconnected");
    svc.stop();
  });

  it("is harmless on a stream that was never started", (t) => {
    const { svc } = stream();
    t.after(() => svc.stop());

    svc.stop();

    assert.equal(sockets.length, 0);
    assert.equal(svc.start(), true, "a stopped stream can still be started");
    assert.equal(sockets.length, 1);
  });
});

describe("UserDataStreamService reconnect", () => {
  /** Mocked `setTimeout`/`clearTimeout` so reconnect delays are driven, not slept through. */
  function useFakeTimers(t) {
    mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => mock.timers.reset());
  }

  it("reopens the stream one second after an unexpected close", (t) => {
    useFakeTimers(t);
    const { events } = opened(t, {});

    socket().close(1006, "abnormal");
    assert.equal(sockets.length, 1, "the reconnect is scheduled, not immediate");

    mock.timers.tick(999);
    assert.equal(sockets.length, 1, "the reconnect must wait the full backoff");

    mock.timers.tick(1);
    assert.equal(sockets.length, 2);
    assert.equal(socket().url, URL);

    socket().open();
    socket().deliver({ o: { s: "BTC", S: "BUY" } });
    assert.equal(events.orderUpdate.length, 1, "the replacement socket is fully wired up");
    assert.equal(JSON.parse(socket().sent[0]).requestToken, "tok-1");
  });

  it("schedules a single reconnect however often close fires", (t) => {
    useFakeTimers(t);
    const { svc } = opened(t, {});

    socket().close(1006, "abnormal");
    socket(0).fire("close");
    socket(0).fire("close");

    mock.timers.tick(5000);

    assert.equal(sockets.length, 2, "repeated close events must not stack up reconnects");
    svc.stop();
  });

  it("cancels a pending reconnect when the stream is stopped mid-backoff", (t) => {
    useFakeTimers(t);

    const reconnecting = opened(t, {});
    socket().close(1006, "abnormal");
    mock.timers.tick(1000);
    assert.equal(sockets.length, 2, "a pending reconnect fires when the stream keeps running");

    sockets.length = 0;
    const stopping = opened(t, {});
    socket().close(1006, "abnormal");
    stopping.svc.stop();
    mock.timers.tick(5000);

    assert.equal(sockets.length, 1, "stopping mid-backoff must cancel the pending reconnect");
    reconnecting.svc.stop();
  });

  it("does not reconnect after the stream is stopped", (t) => {
    useFakeTimers(t);
    const { svc } = opened(t, {});

    svc.stop();
    mock.timers.tick(5000);

    assert.equal(sockets.length, 1, "a client-side stop must not schedule a reconnect");
    assert.equal(svc.start(), true);
    assert.equal(sockets.length, 2, "an explicit start after stop still opens a socket");
    svc.stop();
  });
});

describe("PositionSyncService response shapes", () => {
  /** A store on its own throwaway file, so cases never share cached positions. */
  function makeStore() {
    return new PositionStore(tempFile("positions.json", "qt-tg-user-stream-"));
  }

  /** Account client that answers every `get` with `payload` and records the call. */
  function client(payload) {
    const calls = [];
    return {
      calls,
      get: async (path, config) => {
        calls.push({ path, config });
        return payload;
      },
    };
  }

  const BTC = { symbol: "BTC", positionAmt: 1, availableQuantity: 1, markPrice: 100 };

  it("reads positions from an ACCOUNT_UPDATE-style envelope", async () => {
    const store = makeStore();

    const count = await new PositionSyncService(client({ a: { P: [{ s: "ETH", pa: 2 }] } }), store).refresh();

    assert.equal(count, 1);
    assert.equal(store.get("ETH").netQty, 2);
  });

  it("reads positions from a bare array response", async () => {
    const store = makeStore();

    const count = await new PositionSyncService(client([{ ...BTC }]), store).refresh();

    assert.equal(count, 1);
    assert.equal(store.get("BTC").netQty, 1);
  });

  it("reads positions from a data-wrapped response", async () => {
    const store = makeStore();

    const count = await new PositionSyncService(client({ data: [{ ...BTC }] }), store).refresh();

    assert.equal(count, 1);
    assert.equal(store.get("BTC").netQty, 1);
  });

  it("accepts a single position object under any supported symbol and quantity alias", async () => {
    const variants = [
      { symbol: "BTC", netQty: 1 },
      { s: "BTC", pa: 1 },
      { a: "BTC", aq: 1 },
      { asset: "BTC", qty: 1 },
      { symbol: "BTC", positionAmt: 1 },
      { symbol: "BTC", quantity: 1 },
      { symbol: "BTC", availableQuantity: 1 },
    ];

    for (const variant of variants) {
      const store = makeStore();

      const count = await new PositionSyncService(client(variant), store).refresh();

      assert.equal(count, 1, `single position ${JSON.stringify(variant)} must be recognized`);
      assert.equal(store.get("BTC").netQty, 1, `netQty for ${JSON.stringify(variant)}`);
    }
  });

  // `availableQty` is accepted as proof that a payload *is* a position, but it
  // is not one of the fields `netQty` is derived from, so such a position is
  // cached as flat. Asserted as-is; reported as a suspected product bug.
  it("caches a position reported only as availableQty with a zero net quantity", async () => {
    const store = makeStore();

    const count = await new PositionSyncService(client({ symbol: "BTC", availableQty: 1 }), store).refresh();

    assert.equal(count, 1, "availableQty alone still identifies a single position");
    assert.deepEqual(
      { netQty: store.get("BTC").netQty, availableQty: store.get("BTC").availableQty },
      { netQty: 0, availableQty: 1 },
    );
  });

  it("evicts a cached symbol the account envelope no longer reports", async () => {
    const store = makeStore();
    store.upsert({ ...BTC });
    store.upsert({ symbol: "ETH", positionAmt: 2, availableQuantity: 2 });
    assert.equal(store.get("BTC").netQty, 1, "precondition: BTC is cached");

    await new PositionSyncService(client({ a: { P: [{ s: "ETH", pa: 2 }] } }), store).refresh();

    assert.equal(store.get("BTC"), undefined, "the authoritative envelope replaces the cache");
    assert.equal(store.get("ETH").netQty, 2, "the reported symbol survives the replace");
  });

  it("keeps a flat position the account still reports", async () => {
    const store = makeStore();

    const count = await new PositionSyncService(client([{ symbol: "BTC", positionAmt: 0 }]), store).refresh();

    assert.equal(count, 1);
    assert.equal(store.get("BTC").netQty, 0, "a zero net quantity is a reported position, not an absence");
  });

  it("counts every returned entry even when one cannot be normalized", async () => {
    const store = makeStore();

    const count = await new PositionSyncService(client([{ ...BTC }, { note: "no symbol" }]), store).refresh();

    assert.equal(count, 2, "the count reflects the account response");
    assert.equal(store.get("BTC").netQty, 1);
    assert.deepEqual(
      store.list().map((p) => p.symbol),
      ["BTC"],
      "only normalizable entries are cached",
    );
  });
});

describe("PositionSyncService failure handling", () => {
  function makeStore() {
    return new PositionStore(tempFile("positions.json", "qt-tg-user-stream-"));
  }

  function client(payload) {
    const calls = [];
    return {
      calls,
      get: async (path, config) => {
        calls.push({ path, config });
        return payload;
      },
    };
  }

  const BTC = { symbol: "BTC", positionAmt: 1, availableQuantity: 1, markPrice: 100 };

  /** A store with one cached position, so "the cache survived" is assertable. */
  function primedStore() {
    const store = makeStore();
    store.upsert({ ...BTC });
    assert.equal(store.get("BTC").netQty, 1, "precondition: a stale position is cached");
    return store;
  }

  it("rejects an unrecognized response and leaves the cache untouched", async () => {
    const store = primedStore();

    await assert.rejects(
      new PositionSyncService(client({ balances: [] }), store).refresh(),
      /unrecognized positions response/,
    );

    assert.equal(store.get("BTC").netQty, 1, "a failed refresh must not clear cached positions");
  });

  it("rejects an object that names a symbol but no quantity", async () => {
    const store = makeStore();

    await assert.rejects(
      new PositionSyncService(client({ symbol: "BTC" }), store).refresh(),
      /unrecognized positions response/,
    );

    assert.equal(
      await new PositionSyncService(client({ symbol: "BTC", positionAmt: 0 }), store).refresh(),
      1,
      "the same object with a quantity is a valid single position",
    );
  });

  it("rejects a response that is not an object", async () => {
    const store = makeStore();

    for (const payload of [null, undefined, "nope", 7]) {
      await assert.rejects(
        new PositionSyncService(client(payload), store).refresh(),
        /unrecognized positions response/,
        `payload ${String(payload)} must be rejected`,
      );
    }
  });

  it("surfaces an error field returned by the account endpoint", async () => {
    const store = primedStore();

    await assert.rejects(new PositionSyncService(client({ error: "rate limited" }), store).refresh(), /rate limited/);

    assert.equal(store.get("BTC").netQty, 1);
  });

  it("surfaces the message of a response that reports failure", async () => {
    const store = primedStore();

    await assert.rejects(
      new PositionSyncService(client({ message: "invalid api key", success: false }), store).refresh(),
      /invalid api key/,
    );

    assert.equal(store.get("BTC").netQty, 1);
  });

  it("accepts a successful response that also carries a message", async () => {
    const store = makeStore();

    const count = await new PositionSyncService(
      client({ message: "ok", success: true, positions: [{ ...BTC }] }),
      store,
    ).refresh();

    assert.equal(count, 1, "a message alone is not a failure");
    assert.equal(store.get("BTC").netQty, 1);
  });

  it("propagates a transport failure and leaves the cache untouched", async () => {
    const store = primedStore();
    const transport = {
      get: async () => {
        throw new Error("socket hang up");
      },
    };

    await assert.rejects(new PositionSyncService(transport, store).refresh(), /socket hang up/);

    assert.equal(store.get("BTC").netQty, 1);
  });
});

describe("PositionSyncService request", () => {
  function makeStore() {
    return new PositionStore(tempFile("positions.json", "qt-tg-user-stream-"));
  }

  function client(payload) {
    const calls = [];
    return {
      calls,
      get: async (path, config) => {
        calls.push({ path, config });
        return payload;
      },
    };
  }

  it("requests /positions with the caller config by default", async (t) => {
    withEnv(t, { POSITIONS_ENDPOINT: undefined });
    const account = client({ positions: [] });
    const config = { headers: { "x-api-key": "k" } };

    await new PositionSyncService(account, makeStore()).refresh(config);

    assert.deepEqual(account.calls, [{ path: "/positions", config }]);
  });

  it("requests the endpoint named by POSITIONS_ENDPOINT", async (t) => {
    withEnv(t, { POSITIONS_ENDPOINT: "/v2/account/positions" });
    const account = client({ positions: [] });

    await new PositionSyncService(account, makeStore()).refresh();

    assert.deepEqual(
      account.calls.map((call) => call.path),
      ["/v2/account/positions"],
    );
  });

  it("logs the attempt and the recognized response when session debugging is on", async (t) => {
    withEnv(t, { SESSION_DEBUG: "true", POSITIONS_ENDPOINT: undefined });
    const lines = captureLog(t);

    await new PositionSyncService(client([{ symbol: "BTC", positionAmt: 1 }]), makeStore()).refresh();

    assert.deepEqual(lines[0], ["[POSITIONS_REFRESH_TRY]", { path: "/positions" }]);
    assert.deepEqual(lines[1], [
      "[POSITIONS_REFRESH_RESPONSE]",
      { path: "/positions", found: true, count: 1, isArray: true, topLevelKeys: ["0"] },
    ]);
  });

  it("logs an unrecognized response before rejecting it", async (t) => {
    withEnv(t, { SESSION_DEBUG: "true", POSITIONS_ENDPOINT: undefined });
    const lines = captureLog(t);

    await assert.rejects(
      new PositionSyncService(client(null), makeStore()).refresh(),
      /unrecognized positions response/,
    );

    assert.deepEqual(lines[1], [
      "[POSITIONS_REFRESH_RESPONSE]",
      { path: "/positions", found: false, count: 0, isArray: false, topLevelKeys: [] },
    ]);
  });
});
