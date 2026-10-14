"use strict";

const { describe, it, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const { stubRequire } = require("./helpers/module-stub");
const { tempFile, cleanupTempDirs } = require("./helpers/tmp");

const priorMode = process.env.MODE;
process.env.MODE = "real";
let response;
let transportError;
const posts = [];
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;
  static latest;
  constructor() {
    super();
    this.readyState = 1;
    FakeSocket.latest = this;
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}
const restore = stubRequire({
  ws: FakeSocket,
  axios: {
    post: async (_url, body) => {
      posts.push(body);
      if (transportError) throw transportError;
      return { status: 200, data: response };
    },
  },
});
const { selectL2SideQuote } = require("../dist/triggers/types");
const { TriggerStore } = require("../dist/triggers/trigger-store");
const { PositionStore } = require("../dist/triggers/position-store");
const { TriggerEngine } = require("../dist/triggers/trigger-engine");
const { BotService } = require("../dist/bot.service");
const { PriceFeedService } = require("../dist/utils/price-feed.service");
function makeService() {
  return new BotService(new PositionStore(tempFile("positions.json", "audit-service-")));
}
function receiveSnapshot(book) {
  const feed = new PriceFeedService({ url: "ws://fixture.invalid", createWebSocket: () => new FakeSocket() });
  let result;
  feed.subscribe(
    "BTC",
    (tick) => {
      result = tick;
    },
    0,
  );
  try {
    FakeSocket.latest.emit("message", Buffer.from(JSON.stringify({ s: "BTC", ...book })));
    return result;
  } finally {
    feed.closeAll();
  }
}

after(() => {
  restore();
  cleanupTempDirs();
  if (priorMode === undefined) delete process.env.MODE;
  else process.env.MODE = priorMode;
});
beforeEach(() => {
  posts.length = 0;
  transportError = undefined;
  response = { orderId: 42, status: "NEW", executedQty: "0" };
});
const order = { symbol: "BTC", side: "BUY", type: "LIMIT", quantity: 1, price: 100 };
function snapshot(mode = "cumulative", arrays = false) {
  const level = (p, q) => (arrays ? [String(p), String(q)] : { p, q });
  return {
    symbol: "BTC",
    ts: Date.now(),
    depthQuantityMode: mode,
    orderBook: {
      asks: [level(99, 2), level(100, 3), level(101, 5)],
      bids: [level(98, 2), level(97, 3), level(96, 5)],
    },
  };
}

describe("audit: cumulative depth", () => {
  for (const arrays of [false, true]) {
    for (const side of ["BUY", "SELL"]) {
      it(`selects exact and between-level ${side} thresholds for ${arrays ? "REST" : "WS"} quantities`, () => {
        const tick = snapshot("cumulative", arrays);
        const original = JSON.stringify(tick);
        const exact = selectL2SideQuote(tick, side, 3);
        assert.equal(exact.price, side === "BUY" ? 100 : 97);
        assert.equal(exact.availableQuantity, 3);
        const between = selectL2SideQuote(tick, side, 4);
        assert.equal(between.price, side === "BUY" ? 101 : 96);
        assert.equal(between.availableQuantity, 5);
        assert.equal(selectL2SideQuote(tick, side, 5.01), undefined);
        assert.equal(JSON.stringify(tick), original, "source snapshot must not be mutated");
      });
    }
  }
  it("selects the audit's first qualifying 500 BTC level", () => {
    // The last two levels are quoted in the audit; the first is a synthetic smaller level.
    const tick = {
      depthQuantityMode: "cumulative",
      orderBook: {
        asks: [
          { p: 85000, q: 200 },
          { p: 85115.8, q: 430.286802 },
          { p: 85158.29, q: 594.250427 },
        ],
      },
    };
    assert.equal(selectL2SideQuote(tick, "BUY", 500).price, 85158.29);
    assert.equal(selectL2SideQuote(tick, "BUY", 500).availableQuantity, 594.250427);
  });
  it("preserves explicitly per-level and legacy caller quantities", () => {
    for (const mode of ["per-level", undefined]) {
      const tick = snapshot();
      tick.depthQuantityMode = mode;
      assert.equal(selectL2SideQuote(tick, "BUY", 4).price, 100);
      assert.equal(selectL2SideQuote(tick, "SELL", 4).availableQuantity, 5);
    }
  });
  it("marks feed snapshots as cumulative without altering their quantities", () => {
    const tick = receiveSnapshot(snapshot().orderBook);
    assert.equal(tick.depthQuantityMode, "cumulative");
    assert.equal(tick.orderBook.asks[1].q, 3);
    assert.equal(selectL2SideQuote(tick, "BUY", 4).price, 101);
  });
});

describe("audit: submission and OCO", () => {
  for (const rejection of [
    { code: -1000, msg: "AUDIT simulated application rejection" },
    { code: "-1000", msg: "AUDIT simulated application rejection" },
    { error: "AUDIT simulated application rejection" },
    { success: false, message: "AUDIT simulated application rejection" },
    { orderId: 42, status: "REJECTED", rejectReason: "AUDIT simulated application rejection" },
  ]) {
    it(`rejects an HTTP 200 application rejection: ${JSON.stringify(rejection)}`, async () => {
      response = rejection;
      await assert.rejects(makeService().submitOrder(order), /AUDIT simulated application rejection/);
      assert.equal(posts.length, 1);
    });
  }
  it("accepts an acknowledgement without claiming a fill", async () => {
    const result = await makeService().submitOrder(order);
    assert.equal(result.orderId, "42");
    assert.equal(result.raw.status, "NEW");
    assert.equal(result.raw.executedQty, "0");
  });
  it("forwards supported options and maps booleans to the backend leverage integer", async () => {
    for (const value of [true, false, 1, 0]) {
      await makeService().submitOrder({
        ...order,
        account: "123",
        clientOrderId: "audit-client",
        reduceOnly: true,
        disableLeverage: value,
      });
      const body = posts.at(-1);
      assert.equal(body.account, "123");
      assert.equal(body.clientOrderId, "audit-client");
      assert.equal(body.reduceOnly, true);
      assert.equal(body.disableLeverage, value === true || value === 1 ? 1 : 0);
    }
    await makeService().submitOrder({ ...order, reduceOnly: false });
    assert.equal(posts.at(-1).reduceOnly, false);
    assert.equal(Object.hasOwn(posts.at(-1), "disableLeverage"), false);
  });
  for (const outcome of ["rejected", "timeout", "acknowledged"]) {
    it(`${outcome} submission preserves the intended sibling state and does not resubmit`, async () => {
      const storeFile = tempFile("triggers.json", "audit-oco-");
      const store = new TriggerStore(storeFile);
      const positions = new PositionStore(tempFile("positions.json", "audit-oco-"));
      const engine = new TriggerEngine(store, positions, makeService());
      const first = store.add({
        kind: "LIMIT",
        symbol: "BTC",
        side: "BUY",
        triggerPrice: 100,
        quantity: 1,
        ocoGroupId: "audit",
      });
      const sibling = store.add({
        kind: "STOP_LIMIT",
        symbol: "BTC",
        side: "BUY",
        triggerPrice: 120,
        limitPrice: 121,
        quantity: 1,
        ocoGroupId: "audit",
      });
      assert.equal(store.get(sibling.id).status, "ACTIVE");
      if (outcome === "rejected") response = { code: -1000, msg: "AUDIT simulated application rejection" };
      if (outcome === "timeout") transportError = new Error("ETIMEDOUT: acknowledgement unavailable");
      await engine.processTick(snapshot());
      assert.equal(posts.length, 1);
      assert.equal(store.get(first.id).status, outcome === "acknowledged" ? "TRIGGERED" : "REJECTED");
      assert.equal(store.get(sibling.id).status, outcome === "acknowledged" ? "CANCELLED" : "ACTIVE");
      await engine.processTick(snapshot());
      const restarted = new TriggerEngine(new TriggerStore(storeFile), positions, makeService());
      await restarted.processTick(snapshot());
      assert.equal(posts.length, 1, "persisted terminal state must prevent automatic retry");
    });
  }
});
