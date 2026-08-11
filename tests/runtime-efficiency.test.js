"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");

const { tempFile, cleanupTempDirs } = require("./helpers/tmp");

const { TriggerStore } = require("../dist/triggers/trigger-store");
const { PositionStore } = require("../dist/triggers/position-store");
const { TriggerEngine } = require("../dist/triggers/trigger-engine");
const { TriggerRuntime } = require("../dist/trigger-runtime");

/** Records submitted orders so cases can audit how much work the runtime asks for. */
class FakeExecutor {
  constructor() {
    this.orders = [];
  }
  async submitOrder(req) {
    this.orders.push(req);
    return { orderId: `order-${this.orders.length}` };
  }
}

/** Per-user account stream that counts start/stop calls — the resource under audit. */
class FakeUserDataStream extends EventEmitter {
  constructor() {
    super();
    this.starts = 0;
    this.stops = 0;
    this.started = false;
  }
  start() {
    this.starts += 1;
    this.started = true;
    return true;
  }
  stop() {
    this.stops += 1;
    this.started = false;
  }
}

/** Market-data feed that records every subscribe/unsubscribe so leaks are visible. */
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
}

/** Fresh runtime wired to on-disk stores in their own temp dirs, so cases stay independent. */
function rig() {
  const triggers = new TriggerStore(tempFile("triggers.json", "qt-runtime-test-"));
  const positions = new PositionStore(tempFile("positions.json", "qt-runtime-test-"));
  const executor = new FakeExecutor();
  const engine = new TriggerEngine(triggers, positions, executor);
  const userData = new FakeUserDataStream();
  const priceFeed = new FakePriceFeed();
  const runtime = new TriggerRuntime(triggers, positions, engine, () => undefined, userData, priceFeed);
  return { triggers, positions, executor, engine, userData, priceFeed, runtime };
}

/**
 * Rig holding a bracket entry that has been sent but not yet filled, with the
 * runtime already reconciled once. Shared by the two pending-bracket cases.
 */
function pendingBracketRig() {
  const r = rig();
  const parent = r.triggers.add({
    kind: "LIMIT",
    symbol: "BTC",
    side: "BUY",
    triggerPrice: 100,
    quantity: 1,
    meta: { bracket: { takeProfitPrice: 120, stopLossPrice: 90 } },
  });
  r.triggers.setStatus(parent.id, "TRIGGERED", {
    meta: { ...parent.meta, bracketEntrySubmittedAt: Date.now(), bracketEntryNetQtyBefore: 0 },
  });
  r.runtime.ensure();
  return r;
}

after(cleanupTempDirs);

describe("TriggerRuntime resource usage", () => {
  it("does not start a per-user account stream for fixed-size price triggers", () => {
    const { triggers, userData, priceFeed, runtime } = rig();
    triggers.add({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 1 });
    runtime.ensure();
    // `starts === 0` is an absence check, so the subscription assertion below is
    // its positive control: it proves the runtime did reconcile this trigger and
    // chose L2-only, rather than doing nothing at all.
    assert.strictEqual(userData.starts, 0, "fixed-size price triggers should not start a per-user account stream");
    assert.deepStrictEqual(
      priceFeed.subscribed.map((x) => x.symbol),
      ["BTC"],
    );
    runtime.stop();
  });

  it("starts the account stream for close-position triggers and releases both stream and symbol once they are gone", () => {
    const { triggers, userData, priceFeed, runtime } = rig();
    const close = triggers.add({ kind: "LIMIT", symbol: "ETH", side: "SELL", triggerPrice: 120, closePosition: true });
    runtime.ensure();
    assert.strictEqual(userData.starts, 1, "close-position triggers need the per-user account stream");
    triggers.cancel(close.id);
    runtime.reconcile();
    assert.strictEqual(
      userData.stops >= 1,
      true,
      "runtime should stop the account stream after all active triggers are gone",
    );
    assert.deepStrictEqual(priceFeed.unsubscribed, ["ETH"], "runtime should release inactive market-data symbols");
    runtime.stop();
  });

  it("keeps only the account stream open while a bracket entry is still pending", () => {
    const { userData, priceFeed, runtime } = pendingBracketRig();
    // `subscribed === []` is an absence check; `starts === 1` is its positive
    // control, proving the pending entry was seen and the runtime deliberately
    // took the account stream instead of an L2 subscription.
    assert.strictEqual(
      userData.starts,
      1,
      "pending bracket entries must keep account stream alive until the fill is observed",
    );
    assert.deepStrictEqual(priceFeed.subscribed, [], "pending bracket entries do not need L2 until exits are armed");
    runtime.stop();
  });

  it("swaps the account stream for a single symbol subscription once the bracket entry fills", async () => {
    const { triggers, userData, priceFeed, runtime } = pendingBracketRig();

    userData.emit("positionUpdate", {
      symbol: "BTC",
      positionAmt: 1,
      availableQuantity: 1,
      avgEntryPrice: 100,
      markPrice: 101,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(
      triggers.active("BTC").filter((t) => t.meta?.bracketExit).length,
      2,
      "position update should arm bracket exits",
    );
    assert.strictEqual(
      userData.stops >= 1,
      true,
      "fixed-size bracket exits can stop the account stream after they are armed",
    );
    assert.deepStrictEqual(
      priceFeed.subscribed.map((x) => x.symbol),
      ["BTC"],
      "armed bracket exits should start BTC L2 listening",
    );
    runtime.stop();
  });
});

describe("TriggerStore.addOco validation", () => {
  it("rejects an OCO leg missing limitPrice without persisting a half-created trigger", () => {
    const { triggers } = rig();
    // Positive control for the rollback assertion below: the first leg is valid
    // on its own, so `addOco` persists it before the second leg throws. Without
    // this, a future validation change that rejected leg one too would make
    // `list().length === 0` pass even with the atomic-rollback code deleted.
    const control = rig().triggers;
    control.add({ kind: "TAKE_PROFIT", symbol: "SOL", side: "SELL", triggerPrice: 120, quantity: 1 });
    assert.strictEqual(
      control.list().length,
      1,
      "first OCO leg must be valid on its own, otherwise the rollback path is never reached",
    );

    assert.throws(
      () =>
        triggers.addOco([
          { kind: "TAKE_PROFIT", symbol: "SOL", side: "SELL", triggerPrice: 120, quantity: 1 },
          { kind: "STOP_LIMIT", symbol: "SOL", side: "SELL", triggerPrice: 90, quantity: 1 },
        ]),
      /limitPrice is required/,
    );
    assert.strictEqual(triggers.list().length, 0, "failed OCO creation must not leave a half-created trigger behind");
  });
});
