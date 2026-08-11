"use strict";

const { describe, it, beforeEach, afterEach, after, mock } = require("node:test");
const assert = require("node:assert/strict");

const { OrderHistoryStore } = require("../dist/triggers/order-history-store");

// The store is a pure in-memory cache: no disk, no network, no dependencies to
// stub. Its only asynchrony is a 500ms debounced regroup driven by
// `setTimeout`, so every case runs on `mock.timers` instead of sleeping. That
// also guarantees no pending real timer survives a case and keeps the event
// loop alive.
beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
});

afterEach(() => {
  mock.timers.reset();
});

/** How long `scheduleRebuild` waits before regrouping. */
const REBUILD_MS = 500;

/** Advance past the debounce so the grouped views reflect every upsert so far. */
function settle() {
  mock.timers.tick(REBUILD_MS);
}

/** A minimally valid exchange update; overrides win. */
function update(overrides) {
  return { symbol: "BTC", side: "BUY", ...overrides };
}

/**
 * FIX execution-report shapes the grouping predicates key off.
 *
 * execType 0 = New, F = Trade, 4 = Canceled, 8 = Rejected.
 * ordStatus 2 = Filled, 4 = Canceled, 8 = Rejected.
 * ordType 1 = Market, 2 = Limit.
 */
function resting(orderId, extra) {
  return update({ orderId, execType: "0", ordType: "2", ordStatus: "0", leavesQty: 10, ...extra });
}

function partiallyFilled(orderId, extra) {
  return update({ orderId, execType: "F", ordType: "2", ordStatus: "1", cumQty: 4, leavesQty: 6, ...extra });
}

function fullyFilled(orderId, extra) {
  return update({ orderId, execType: "F", ordType: "2", ordStatus: "2", cumQty: 10, leavesQty: 0, ...extra });
}

function canceled(orderId, extra) {
  return update({ orderId, execType: "4", ordType: "2", ordStatus: "4", cumQty: 0, leavesQty: 0, ...extra });
}

/** orderIds of a paginated view, in the order the store returned them. */
function ids(page) {
  return page.items.map((item) => item.orderId);
}

/** A store holding `orderIds` as resting orders, already regrouped. */
function restingStore(orderIds, maxEntries) {
  const store = new OrderHistoryStore(maxEntries ?? 10000);
  for (const orderId of orderIds) store.upsert(resting(orderId));
  settle();
  return store;
}

/**
 * Regroups `store` and returns the summary it logs under SESSION_DEBUG.
 *
 * That log line is the only observation point for `entries.length` and for the
 * canceled group, neither of which has a public getter.
 */
function settleWithSummary(_store) {
  const originalDebug = process.env.SESSION_DEBUG;
  const originalLog = console.log;
  const lines = [];

  console.log = (...args) => lines.push(args);
  process.env.SESSION_DEBUG = "true";
  try {
    settle();
  } finally {
    console.log = originalLog;
    if (originalDebug === undefined) delete process.env.SESSION_DEBUG;
    else process.env.SESSION_DEBUG = originalDebug;
  }

  assert.equal(lines.length, 1, "exactly one rebuild summary per debounce window");
  assert.equal(lines[0][0], "[ORDER_HISTORY_REBUILD_DONE]");
  return lines[0][1];
}

describe("normalising an incoming order update", () => {
  it("upper-cases the symbol", () => {
    const entry = new OrderHistoryStore().upsert(update({ symbol: "btc-usd" }));
    assert.equal(entry.symbol, "BTC-USD");
  });

  it("keeps BUY and maps every other side value to SELL", () => {
    const store = new OrderHistoryStore();
    assert.equal(store.upsert(update({ side: "BUY" })).side, "BUY");
    assert.equal(store.upsert(update({ side: "SELL" })).side, "SELL");
    // Deliberate: the source compares `update.side === "BUY"` exactly, so a
    // lower-case or unknown side silently becomes SELL rather than throwing.
    assert.equal(store.upsert(update({ side: "buy" })).side, "SELL");
    assert.equal(store.upsert(update({ side: undefined })).side, "SELL");
  });

  it("stringifies identity fields but drops falsy ones", () => {
    const store = new OrderHistoryStore();

    const present = store.upsert(update({ orderId: 12345, clientOrderId: 7, execId: "e-1" }));
    assert.equal(present.orderId, "12345");
    assert.equal(present.clientOrderId, "7");
    assert.equal(present.execId, "e-1");

    // `orderId ? String(orderId) : undefined` — a zero or empty id is discarded,
    // it does not become "0"/"".
    const falsy = store.upsert(update({ orderId: 0, clientOrderId: "", execId: "e-2" }));
    assert.equal(falsy.orderId, undefined);
    assert.equal(falsy.clientOrderId, undefined);
    assert.equal(falsy.execId, "e-2");
  });

  it("falls back from orderType to type and from ordStatus to status", () => {
    const store = new OrderHistoryStore();

    const legacy = store.upsert(update({ type: "LIMIT", status: "NEW" }));
    assert.equal(legacy.orderType, "LIMIT");
    assert.equal(legacy.ordStatus, "NEW");

    // The FIX-style field wins when both are supplied.
    const fix = store.upsert(update({ orderType: "ORD", type: "LIMIT", ordStatus: "2", status: "NEW" }));
    assert.equal(fix.orderType, "ORD");
    assert.equal(fix.ordStatus, "2");
  });

  it("gives ordType and execType no legacy fallback", () => {
    const entry = new OrderHistoryStore().upsert(update({ type: "LIMIT", status: "NEW" }));
    assert.equal(entry.ordType, undefined);
    assert.equal(entry.execType, undefined);
  });

  it("stringifies quantity and price fields including zero", () => {
    const entry = new OrderHistoryStore().upsert(
      update({
        quantity: 1.5,
        cumQty: 0,
        lastQty: "0.25",
        price: 30000,
        avgPx: 0,
        lastPx: "29999.5",
        fillPrice: 30001,
      }),
    );

    assert.equal(entry.quantity, "1.5");
    assert.equal(entry.cumQty, "0");
    assert.equal(entry.lastQty, "0.25");
    assert.equal(entry.price, "30000");
    assert.equal(entry.avgPx, "0");
    assert.equal(entry.lastPx, "29999.5");
    assert.equal(entry.fillPrice, "30001");
  });

  it("coerces leavesQty to a number and non-numeric input to zero", () => {
    const store = new OrderHistoryStore();
    assert.equal(store.upsert(update({ leavesQty: "5.5" })).leavesQty, 5.5);
    assert.equal(store.upsert(update({ leavesQty: 0 })).leavesQty, 0);
    assert.equal(store.upsert(update({ leavesQty: "not-a-number" })).leavesQty, 0);
    assert.equal(store.upsert(update({ leavesQty: Infinity })).leavesQty, 0);
  });

  it("leaves absent optional fields undefined rather than defaulting them", () => {
    const entry = new OrderHistoryStore().upsert(update({}));

    for (const field of [
      "orderId",
      "clientOrderId",
      "execId",
      "ordType",
      "orderType",
      "execType",
      "ordStatus",
      "quantity",
      "cumQty",
      "lastQty",
      "leavesQty",
      "price",
      "avgPx",
      "lastPx",
      "fillPrice",
      "raw",
    ]) {
      assert.equal(entry[field], undefined, `${field} should stay undefined`);
    }
    // Positive control: the same call did produce the required fields, so the
    // undefined checks above are reading a real entry.
    assert.equal(entry.symbol, "BTC");
    assert.equal(entry.side, "BUY");
  });

  it("passes the raw payload through untouched", () => {
    const raw = { exchange: "payload" };
    assert.equal(new OrderHistoryStore().upsert(update({ raw })).raw, raw);
  });

  it("keeps a supplied timestamp and defaults a missing or zero one to now", () => {
    const store = new OrderHistoryStore();

    assert.equal(store.upsert(update({ timestamp: "1700000000000" })).timestamp, 1700000000000);

    const before = Date.now();
    const defaulted = store.upsert(update({}));
    const zeroed = store.upsert(update({ timestamp: 0 }));
    const afterNow = Date.now();

    for (const entry of [defaulted, zeroed]) {
      assert.ok(
        entry.timestamp >= before && entry.timestamp <= afterNow,
        `timestamp ${entry.timestamp} should default into [${before}, ${afterNow}]`,
      );
    }
  });

  it("always stamps updatedAt with the ingest time", () => {
    const before = Date.now();
    const entry = new OrderHistoryStore().upsert(update({ timestamp: 1700000000000 }));
    assert.ok(entry.updatedAt >= before, "updatedAt must be the ingest time, not the exchange timestamp");
    assert.notEqual(entry.updatedAt, entry.timestamp);
  });
});

describe("rejecting unusable updates", () => {
  it("returns undefined for input without a symbol", () => {
    const store = new OrderHistoryStore();
    assert.equal(store.upsert(undefined), undefined);
    assert.equal(store.upsert(null), undefined);
    assert.equal(store.upsert({}), undefined);
    assert.equal(store.upsert({ symbol: "" }), undefined);
    assert.equal(store.upsert({ side: "BUY", orderId: "x" }), undefined);
  });

  it("keeps rejected updates out of the grouped history", () => {
    const store = new OrderHistoryStore();

    store.upsert(resting("1"));
    settle();
    assert.equal(store.orders().total, 1, "precondition: one accepted order is grouped");

    store.upsert({ orderId: "2", side: "BUY", execType: "0", ordType: "2" });
    store.upsert(null);
    settle();

    assert.equal(store.orders().total, 1);
    assert.deepEqual(ids(store.orders()), ["1"]);
  });

  it("does not enter the syncing state for a rejected update", () => {
    const store = new OrderHistoryStore();

    store.upsert(resting("1"));
    assert.equal(store.isSyncing(), true, "precondition: an accepted update starts a sync");
    settle();
    assert.equal(store.isSyncing(), false);

    store.upsert({ side: "BUY" });
    assert.equal(store.isSyncing(), false, "a rejected update must not schedule a rebuild");
  });

  it("degrades rather than throwing on malformed field values", () => {
    const store = new OrderHistoryStore();

    const entry = store.upsert({
      symbol: 12345,
      side: { nope: true },
      orderId: { toString: () => "obj-id" },
      quantity: null,
      leavesQty: [],
      ordStatus: false,
      timestamp: "not-a-date",
    });

    assert.equal(entry.symbol, "12345");
    assert.equal(entry.side, "SELL");
    assert.equal(entry.orderId, "obj-id");
    assert.equal(entry.quantity, undefined, 'null is treated as absent, not as "null"');
    assert.equal(entry.leavesQty, 0, "Number([]) is 0");
    assert.equal(entry.ordStatus, "false", "false is not null, so it is stringified");
    assert.ok(Number.isNaN(entry.timestamp), "an unparseable timestamp is passed to Number() as-is");

    settle();
    assert.equal(store.orders().total, 1, "the malformed-but-symbolled update is still stored");
  });
});

describe("upsert identity", () => {
  it("replaces in place when the same orderId arrives twice", () => {
    const store = new OrderHistoryStore();

    store.upsert(resting("42", { price: 100 }));
    store.upsert(resting("42", { price: 200 }));
    settle();

    const page = store.orders();
    assert.equal(page.total, 1);
    assert.equal(page.items[0].price, "200");
  });

  it("keys off clientOrderId when no orderId is present", () => {
    const store = new OrderHistoryStore();

    store.upsert(update({ clientOrderId: "c-1", execType: "0", ordType: "2", price: 1 }));
    store.upsert(update({ clientOrderId: "c-1", execType: "0", ordType: "2", price: 2 }));
    settle();

    const page = store.orders();
    assert.equal(page.total, 1);
    assert.equal(page.items[0].price, "2");
    assert.equal(page.items[0].clientOrderId, "c-1");
  });

  it("keys off execId when neither order id is present", () => {
    const deduped = new OrderHistoryStore();
    deduped.upsert(update({ execId: "x-1", execType: "0", ordType: "2", price: 1, timestamp: 1000 }));
    deduped.upsert(update({ execId: "x-1", execType: "0", ordType: "2", price: 2, timestamp: 2000 }));
    settle();

    const same = deduped.orders();
    assert.equal(same.total, 1);
    assert.equal(same.items[0].price, "2", "the repeat replaced the original in place");
    assert.equal(same.items[0].children, undefined, "only one entry exists, so there is nothing to fold");

    const distinct = new OrderHistoryStore();
    distinct.upsert(update({ execId: "x-1", execType: "0", ordType: "2", price: 1, timestamp: 1000 }));
    distinct.upsert(update({ execId: "x-2", execType: "0", ordType: "2", price: 3, timestamp: 2000 }));
    settle();

    // Two stored entries, but neither carries an orderId, so `reduceOrderTrade`
    // folds the older one under the newer as a child. The child is the proof
    // that a different execId really did create a second entry.
    const two = distinct.orders();
    assert.equal(two.items[0].price, "3");
    assert.equal(two.items[0].children.length, 1, "a different execId is a different order");
    assert.equal(two.items[0].children[0].price, "1");
  });

  it("falls back to symbol/side/updatedAt when the update carries no identifier at all", () => {
    // Freeze the clock so `updatedAt` — part of the fallback key — is identical
    // for every ingest, instead of relying on three calls landing in one
    // millisecond.
    mock.timers.reset();
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1700000000000 });

    const store = new OrderHistoryStore();
    const first = store.upsert(update({ execType: "0", ordType: "2", price: 1, timestamp: 1000 }));
    const second = store.upsert(update({ execType: "0", ordType: "2", price: 2, timestamp: 1000 }));
    const otherSide = store.upsert(update({ side: "SELL", execType: "0", ordType: "2", price: 3, timestamp: 2000 }));

    assert.equal(first.updatedAt, second.updatedAt, "precondition: the fallback key is identical");
    assert.equal(store.orders(1, 25).total, 0, "precondition: nothing is grouped before the debounce fires");
    settle();

    const page = store.orders(1, 25);
    assert.equal(page.items[0].side, "SELL", "a different side is a different fallback key");
    assert.equal(page.items[0].price, "3");
    assert.equal(
      page.items[0].children.length,
      1,
      "the two BUY updates collapsed onto one entry, so only one child remains",
    );
    assert.equal(page.items[0].children[0].side, "BUY");
    assert.equal(page.items[0].children[0].price, "2", "the second BUY replaced the first in place");
    assert.equal(otherSide.side, "SELL");
  });

  it("keeps anonymous updates from different milliseconds apart", () => {
    mock.timers.reset();
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1700000000000 });

    const store = new OrderHistoryStore();
    const first = store.upsert(update({ execType: "0", ordType: "2", price: 1, timestamp: 1000 }));
    // One millisecond, far short of the 500ms debounce, so no rebuild happens
    // in between — only `updatedAt` moves.
    mock.timers.tick(1);
    const second = store.upsert(update({ execType: "0", ordType: "2", price: 2, timestamp: 2000 }));

    assert.notEqual(first.updatedAt, second.updatedAt, "precondition: the ingest times differ");

    const summary = settleWithSummary(store);
    assert.equal(summary.total, 2, "updatedAt is part of the fallback key, so this is a second order");

    const page = store.orders();
    assert.equal(page.items[0].price, "2");
    assert.equal(page.items[0].children[0].price, "1");
  });

  it("prefers orderId over clientOrderId and execId when several ids are present", () => {
    const store = new OrderHistoryStore();

    store.upsert(resting("o-1", { clientOrderId: "c-1", execId: "x-1", price: 1 }));
    // Same orderId, different client/exec ids: still the same order.
    store.upsert(resting("o-1", { clientOrderId: "c-2", execId: "x-2", price: 2 }));
    settle();

    const page = store.orders();
    assert.equal(page.total, 1);
    assert.equal(page.items[0].clientOrderId, "c-2");
    assert.equal(page.items[0].price, "2");
  });

  it("lets a later update clear a field the earlier one reported", () => {
    const store = new OrderHistoryStore();

    store.upsert(resting("7", { price: 100 }));
    settle();
    assert.equal(store.orders().items[0].price, "100", "precondition: price was recorded");

    store.upsert(resting("7", { price: undefined }));
    settle();

    // The merge spreads a freshly normalised entry over the stored one, and
    // that entry carries explicit `undefined`s for absent optionals.
    assert.equal(store.orders().items[0].price, undefined);
  });
});

describe("the entry cap", () => {
  it("keeps exactly maxEntries orders at the boundary and evicts the oldest past it", () => {
    const store = new OrderHistoryStore(2);

    store.upsert(resting("1"));
    store.upsert(resting("2"));
    settle();
    assert.deepEqual(ids(store.orders()), ["2", "1"], "at the cap nothing is evicted");

    store.upsert(resting("3"));
    settle();

    const page = store.orders();
    assert.equal(page.total, 2);
    assert.deepEqual(ids(page), ["3", "2"], "the oldest entry is dropped, the newest is kept");
  });

  it("reads its default cap from ORDER_HISTORY_MAX", () => {
    const original = process.env.ORDER_HISTORY_MAX;
    process.env.ORDER_HISTORY_MAX = "1";
    try {
      const store = new OrderHistoryStore();
      store.upsert(resting("1"));
      store.upsert(resting("2"));
      settle();
      assert.deepEqual(ids(store.orders()), ["2"]);
    } finally {
      if (original === undefined) delete process.env.ORDER_HISTORY_MAX;
      else process.env.ORDER_HISTORY_MAX = original;
    }
  });

  it("lets an explicit cap override the environment", () => {
    const original = process.env.ORDER_HISTORY_MAX;
    process.env.ORDER_HISTORY_MAX = "1";
    try {
      const store = new OrderHistoryStore(3);
      store.upsert(resting("1"));
      store.upsert(resting("2"));
      settle();
      assert.deepEqual(ids(store.orders()), ["2", "1"]);
    } finally {
      if (original === undefined) delete process.env.ORDER_HISTORY_MAX;
      else process.env.ORDER_HISTORY_MAX = original;
    }
  });

  it("does not evict when an update replaces an existing order", () => {
    const store = new OrderHistoryStore(2);

    store.upsert(resting("1"));
    store.upsert(resting("2"));
    store.upsert(resting("1", { price: 9 }));
    settle();

    const page = store.orders();
    assert.equal(page.total, 2);
    assert.deepEqual(ids(page), ["2", "1"]);
    assert.equal(page.items[1].price, "9");
  });
});

describe("the debounced rebuild", () => {
  it("publishes nothing until the debounce window elapses", () => {
    const store = new OrderHistoryStore();

    store.upsert(resting("1"));
    assert.equal(store.orders().total, 0, "grouped views are still empty one tick short of the window");
    assert.equal(store.isSyncing(), true);

    mock.timers.tick(REBUILD_MS - 1);
    assert.equal(store.orders().total, 0);
    assert.equal(store.isSyncing(), true);

    mock.timers.tick(1);
    assert.equal(store.orders().total, 1, "the rebuild lands exactly on the boundary");
    assert.equal(store.isSyncing(), false);
  });

  it("coalesces a burst of updates into one rebuild at the last window", () => {
    const store = new OrderHistoryStore();

    store.upsert(resting("1"));
    mock.timers.tick(400);
    assert.equal(store.orders().total, 0, "precondition: the first window has not elapsed");

    store.upsert(resting("2"));
    mock.timers.tick(400);
    assert.equal(store.orders().total, 0, "the second upsert restarted the window");

    mock.timers.tick(100);
    assert.equal(store.orders().total, 2, "both updates land together");
  });

  it("reports syncing again once a new update arrives after a rebuild", () => {
    const store = new OrderHistoryStore();

    assert.equal(store.isSyncing(), false, "a fresh store is not syncing");
    store.upsert(resting("1"));
    settle();
    assert.equal(store.isSyncing(), false);

    store.upsert(resting("2"));
    assert.equal(store.isSyncing(), true);
    settle();
    assert.equal(store.isSyncing(), false);
  });

  it("logs a rebuild summary only when SESSION_DEBUG is enabled", () => {
    const originalDebug = process.env.SESSION_DEBUG;
    const originalLog = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args);

    try {
      const quiet = new OrderHistoryStore();
      process.env.SESSION_DEBUG = "false";
      quiet.upsert(resting("1"));
      settle();
      assert.equal(quiet.orders().total, 1, "precondition: the quiet rebuild actually ran");
      assert.equal(lines.length, 0);

      process.env.SESSION_DEBUG = "true";
      const loud = new OrderHistoryStore();
      loud.upsert(resting("1"));
      loud.upsert(fullyFilled("2"));
      loud.upsert(canceled("3"));
      settle();

      assert.equal(lines.length, 1);
      const [tag, summary] = lines[0];
      assert.equal(tag, "[ORDER_HISTORY_REBUILD_DONE]");
      assert.equal(summary.total, 3);
      assert.equal(summary.open, loud.orders().total);
      assert.equal(summary.filled, loud.fills().total);
      assert.equal(summary.canceled, 1);
      assert.equal(typeof summary.ms, "number");
    } finally {
      console.log = originalLog;
      if (originalDebug === undefined) delete process.env.SESSION_DEBUG;
      else process.env.SESSION_DEBUG = originalDebug;
    }
  });
});

describe("grouped views", () => {
  it("lists a resting order as open and not as a fill", () => {
    const store = new OrderHistoryStore();
    store.upsert(resting("1"));
    settle();

    assert.deepEqual(ids(store.orders()), ["1"]);
    assert.equal(store.fills().total, 0);
  });

  it("drops a fully filled order out of open orders and into fills", () => {
    const store = new OrderHistoryStore();

    store.upsert(resting("1"));
    settle();
    assert.deepEqual(ids(store.orders()), ["1"], "precondition: the order rests first");
    assert.equal(store.fills().total, 0);

    store.upsert(fullyFilled("1"));
    settle();

    assert.equal(store.orders().total, 0);
    assert.deepEqual(ids(store.fills()), ["1"]);
  });

  it("shows a partial fill as both open and filled", () => {
    const store = new OrderHistoryStore();
    store.upsert(partiallyFilled("1"));
    settle();

    assert.deepEqual(ids(store.orders()), ["1"], "leavesQty is non-zero, so it is still working");
    assert.deepEqual(ids(store.fills()), ["1"], "cumQty is non-zero, so it has traded");
  });

  it("removes a canceled order from both open orders and fills", () => {
    const store = new OrderHistoryStore();

    store.upsert(resting("1"));
    store.upsert(resting("2"));
    settle();
    assert.deepEqual(ids(store.orders()), ["2", "1"], "precondition: both orders are open");

    store.upsert(canceled("1"));
    settle();

    assert.deepEqual(ids(store.orders()), ["2"], "only the surviving order stays open");
    assert.equal(store.fills().total, 0, "a cancel with no traded quantity is not a fill");
  });

  it("treats a rejected order as neither open nor filled", () => {
    const store = new OrderHistoryStore();

    store.upsert(resting("1"));
    store.upsert(resting("2", { execType: "8", ordStatus: "8" }));
    // Rejected via ordStatus only: execType stays 0, so the ordStatus=8
    // exclusion is the one thing keeping this out of the open list.
    store.upsert(resting("3", { execType: "0", ordStatus: "8" }));
    // Rejected via ordType only: ordType=8 is likewise excluded on its own.
    store.upsert(resting("4", { execType: "0", ordType: "8", ordStatus: "0" }));
    settle();

    assert.deepEqual(ids(store.orders()), ["1"], "only the accepted order is working");
    assert.equal(store.fills().total, 0);
  });

  it("counts a filled market order as a fill via ordType and ordStatus alone", () => {
    const store = new OrderHistoryStore();
    // execType is absent, so only the ordType=1 / ordStatus=2 clause can match.
    store.upsert(update({ orderId: "1", ordType: "1", ordStatus: "2", cumQty: 5 }));
    settle();

    assert.deepEqual(ids(store.fills()), ["1"]);
    assert.equal(store.orders().total, 0, "a market order is never listed as working");
  });

  it("counts a cancel-with-fill as both a fill and a cancel", () => {
    const store = new OrderHistoryStore();
    // execType C = Expired, with quantity already traded.
    store.upsert(update({ orderId: "1", execType: "C", ordType: "2", cumQty: 3 }));
    settle();

    assert.deepEqual(ids(store.fills()), ["1"], "traded quantity survives the expiry");
    assert.equal(store.orders().total, 0);
  });

  it("excludes a trade report that left nothing working from open orders", () => {
    const store = new OrderHistoryStore();

    store.upsert(partiallyFilled("1", { leavesQty: 0 }));
    store.upsert(partiallyFilled("2", { leavesQty: 6 }));
    settle();

    assert.deepEqual(ids(store.orders()), ["2"], "only the order with leavesQty left is working");
    assert.deepEqual(ids(store.fills()).sort(), ["1", "2"]);
  });

  it("orders the open list by descending orderId", () => {
    const store = restingStore(["3", "1", "2"]);
    assert.deepEqual(ids(store.orders()), ["3", "2", "1"]);
  });

  it("breaks an orderId tie by timestamp when ids are non-numeric", () => {
    const store = new OrderHistoryStore();
    // Both sort to 0, so the timestamp decides; the reduce then reverses.
    store.upsert(update({ clientOrderId: "c-1", execType: "0", ordType: "2", timestamp: 1000 }));
    store.upsert(update({ clientOrderId: "c-2", execType: "0", ordType: "2", timestamp: 2000 }));
    settle();

    const page = store.orders();
    assert.equal(page.total, 1, "both lack an orderId, so the reduce folds them together");
    assert.equal(page.items[0].clientOrderId, "c-2", "the newer timestamp survives as the parent");
    assert.equal(page.items[0].children.length, 1);
    assert.equal(page.items[0].children[0].clientOrderId, "c-1");
  });

  it("keeps orders with distinct orderIds separate instead of nesting them", () => {
    const store = restingStore(["1", "2"]);
    const page = store.orders();

    assert.equal(page.total, 2);
    for (const item of page.items) {
      assert.equal(item.children, undefined, "distinct orderIds must not be folded into children");
    }
  });

  it("counts every cancellation shape in the canceled group", () => {
    const store = new OrderHistoryStore();

    store.upsert(update({ orderId: "1", execType: "4", ordType: "2", ordStatus: "0" }));
    store.upsert(update({ orderId: "2", execType: "0", ordType: "2", ordStatus: "4" }));
    store.upsert(update({ orderId: "3", execType: "B", ordType: "2", cumQty: 0 }));
    store.upsert(update({ orderId: "4", execType: "B", ordType: "2", cumQty: 5 }));

    const summary = settleWithSummary(store);

    assert.equal(summary.total, 4, "precondition: all four reports were stored");
    // execType 4, ordStatus 4, and a B report with nothing traded each qualify
    // on their own; the B report that did trade does not.
    assert.equal(summary.canceled, 3);
    assert.equal(summary.filled, 1);
    assert.deepEqual(ids(store.fills()), ["4"]);
    // Deliberate: a cancel signalled only through ordStatus still satisfies the
    // open predicate, so it is reported as working and canceled at once.
    assert.deepEqual(ids(store.orders()), ["2"]);
    assert.equal(summary.open, 1);
  });
});

describe("pagination", () => {
  it("describes an empty view without inventing pages", () => {
    const page = new OrderHistoryStore().orders();
    assert.deepEqual(page, { items: [], page: 1, pageSize: 10, total: 0, totalPages: 1 });
  });

  it("defaults to the first page of ten", () => {
    const store = restingStore(Array.from({ length: 30 }, (_, i) => String(i + 1)));
    const page = store.orders();

    assert.equal(page.page, 1);
    assert.equal(page.pageSize, 10);
    assert.equal(page.total, 30);
    assert.equal(page.totalPages, 3);
    assert.deepEqual(ids(page), ["30", "29", "28", "27", "26", "25", "24", "23", "22", "21"]);
  });

  it("returns the requested slice for a later page", () => {
    const store = restingStore(Array.from({ length: 30 }, (_, i) => String(i + 1)));
    const page = store.orders(3, 10);

    assert.equal(page.page, 3);
    assert.deepEqual(ids(page), ["10", "9", "8", "7", "6", "5", "4", "3", "2", "1"]);
  });

  it("clamps a page beyond the end and a page below one", () => {
    const store = restingStore(Array.from({ length: 30 }, (_, i) => String(i + 1)));

    assert.equal(store.orders(99, 10).page, 3);
    assert.deepEqual(ids(store.orders(99, 10)), ids(store.orders(3, 10)));
    assert.equal(store.orders(0, 10).page, 1);
    assert.equal(store.orders(-4, 10).page, 1);
  });

  it("clamps page size to at most twenty-five", () => {
    const store = restingStore(Array.from({ length: 30 }, (_, i) => String(i + 1)));
    const page = store.orders(1, 100);

    assert.equal(page.pageSize, 25);
    assert.equal(page.items.length, 25);
    assert.equal(page.totalPages, 2);
  });

  it("treats a zero page size as the default and a negative one as one", () => {
    const store = restingStore(Array.from({ length: 30 }, (_, i) => String(i + 1)));

    assert.equal(store.orders(1, 0).pageSize, 10);
    const negative = store.orders(1, -3);
    assert.equal(negative.pageSize, 1);
    assert.equal(negative.totalPages, 30);
    assert.deepEqual(ids(negative), ["30"]);
  });

  it("takes its default page size from ORDER_HISTORY_PAGE_SIZE", () => {
    const original = process.env.ORDER_HISTORY_PAGE_SIZE;
    const store = restingStore(Array.from({ length: 30 }, (_, i) => String(i + 1)));
    try {
      process.env.ORDER_HISTORY_PAGE_SIZE = "5";
      assert.equal(store.orders().pageSize, 5);
      assert.equal(store.orders().items.length, 5);

      process.env.ORDER_HISTORY_PAGE_SIZE = "nonsense";
      assert.equal(store.orders().pageSize, 10, "an unparseable value falls back to ten");

      process.env.ORDER_HISTORY_PAGE_SIZE = "0";
      assert.equal(store.orders().pageSize, 10, "a non-positive value falls back to ten");

      process.env.ORDER_HISTORY_PAGE_SIZE = "-5";
      assert.equal(store.orders().pageSize, 10, "a negative value falls back to ten, not to one");
    } finally {
      if (original === undefined) delete process.env.ORDER_HISTORY_PAGE_SIZE;
      else process.env.ORDER_HISTORY_PAGE_SIZE = original;
    }
  });

  it("paginates fills independently of open orders", () => {
    const store = new OrderHistoryStore();
    for (let i = 1; i <= 12; i += 1) store.upsert(fullyFilled(String(i)));
    store.upsert(resting("100"));
    settle();

    assert.equal(store.fills().total, 12);
    assert.equal(store.fills().totalPages, 2);
    assert.deepEqual(ids(store.fills(2, 10)), ["2", "1"]);
    assert.deepEqual(ids(store.orders()), ["100"]);
  });
});

after(() => {
  mock.reset();
});
