"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { stubRequire } = require("./helpers/module-stub");
const { tempFile, cleanupTempDirs } = require("./helpers/tmp");

class FakeSocket extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;
  static latest;
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
    FakeSocket.latest = this;
  }
  send(frame, callback) {
    this.sent.push(JSON.parse(frame));
    this.finishSend = callback;
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  deliver(frame) {
    assert.equal(this.readyState, 1, "the stream must be open to deliver a fill");
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}
const restore = stubRequire({ ws: FakeSocket });
const { MarketOrderFlow, marketSessionIdentity } = require("../dist/market-orders");
const { AccountRiskStore } = require("../dist/account-risk");
const { BotService } = require("../dist/bot.service");
const { TriggerRuntime } = require("../dist/trigger-runtime");
const { UserDataStreamService } = require("../dist/utils/user-data-stream.service");
const { TriggerStore } = require("../dist/triggers/trigger-store");
const { PositionStore } = require("../dist/triggers/position-store");
const { OrderHistoryStore } = require("../dist/triggers/order-history-store");
after(restore);
after(cleanupTempDirs);

const ctx = { ownerId: "market-test-owner", chatId: 123, chatType: "private" };
const validWords = ["BTC", "BUY", "0.01"];
function draftId(preview) {
  return preview.options.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function rig() {
  let identity = "session-a",
    real = true;
  const orders = [],
    steps = [];
  const accountRisk = new AccountRiskStore();
  const scope = {
    accountRisk,
    service: {
      async refreshAccount() {
        steps.push("refresh");
        return { canTrade: true, updateTime: Date.now() };
      },
      async submitOrder(order) {
        steps.push("submit");
        orders.push(order);
        return { orderId: "42", paper: !real };
      },
    },
    runtime: {
      async prepareAccountWatcher() {
        steps.push("watcher-ready");
      },
    },
  };
  const flow = new MarketOrderFlow({
    sessionIdentity: () => identity,
    getScope: () => scope,
    isRealMode: () => real,
    paymentCurrency: () => "USD",
  });
  return {
    flow,
    scope,
    orders,
    steps,
    preview: (words = validWords, context = ctx) => flow.preview(context, words),
    setIdentity: (value) => {
      identity = value;
    },
    setReal: (value) => {
      real = value;
    },
  };
}

describe("market order confirmation", () => {
  it("rejects the old preview without submitting or consuming the newer draft", async () => {
    const r = rig();
    const old = draftId(r.preview());
    const current = draftId(r.preview(["ETH", "SELL", "2"]));
    assert.notEqual(old, current);
    await assert.rejects(r.flow.confirm(ctx, old), /confirmation expired/);
    assert.equal(r.orders.length, 0);
    const result = await r.flow.confirm(ctx, current);
    assert.equal(result.symbol, "ETH");
    assert.deepEqual(
      r.orders.map(({ symbol, side, quantity }) => ({ symbol, side, quantity })),
      [{ symbol: "ETH", side: "SELL", quantity: 2 }],
    );
  });

  it("rejects an old cancel button while allowing the current draft to confirm", async () => {
    const r = rig();
    const old = draftId(r.preview());
    const current = draftId(r.preview(["ETH", "BUY", "1"]));
    assert.throws(() => r.flow.cancel(ctx, old), /confirmation expired/);
    await r.flow.confirm(ctx, current);
    assert.equal(r.orders[0].symbol, "ETH");
  });

  it("cancels only the matching preview", async () => {
    const r = rig();
    const id = draftId(r.preview());
    r.flow.cancel(ctx, id);
    await assert.rejects(r.flow.confirm(ctx, id), /confirmation expired/);
    assert.equal(r.orders.length, 0);
    await r.flow.confirm(ctx, draftId(r.preview()));
    assert.equal(r.orders.length, 1);
  });

  it("submits once when the confirmation is clicked twice", async () => {
    const r = rig();
    const wait = deferred();
    r.scope.service.refreshAccount = () => {
      r.steps.push("refresh");
      return wait.promise;
    };
    const id = draftId(r.preview());
    const first = r.flow.confirm(ctx, id);
    assert.deepEqual(r.steps, ["refresh"]);
    await assert.rejects(r.flow.confirm(ctx, id), /already in progress/);
    assert.throws(() => r.flow.cancel(ctx, id), /already in progress/);
    wait.resolve({ canTrade: true });
    await first;
    await assert.rejects(r.flow.confirm(ctx, id), /confirmation expired/);
    assert.equal(r.orders.length, 1);
  });

  it("rejects legacy buttons without an ID without consuming a valid preview", async () => {
    const r = rig();
    const id = draftId(r.preview());
    await assert.rejects(r.flow.confirm(ctx, ""), /confirmation expired/);
    await r.flow.confirm(ctx, id);
    assert.equal(r.orders.length, 1);
  });

  it("keeps the order isolated to its owner and private chat", async () => {
    const r = rig();
    const id = draftId(r.preview());
    await assert.rejects(r.flow.confirm({ ...ctx, ownerId: "other-owner" }, id), /confirmation expired/);
    await assert.rejects(r.flow.confirm({ ...ctx, chatId: 456 }, id), /confirmation expired/);
    await assert.rejects(r.flow.confirm({ ...ctx, chatType: "group" }, id), /private chat/);
    await r.flow.confirm(ctx, id);
    assert.equal(r.orders.length, 1);
  });

  it("expires confirmations after five minutes", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    const r = rig();
    const id = draftId(r.preview());
    t.mock.timers.tick(300001);
    await assert.rejects(r.flow.confirm(ctx, id), /confirmation expired/);
    assert.equal(r.orders.length, 0);
    await r.flow.confirm(ctx, draftId(r.preview()));
    assert.equal(r.orders.length, 1);
  });

  it("keeps the callback under Telegram's 64-byte limit and free of session data", () => {
    const r = rig();
    const preview = r.preview();
    for (const button of preview.options.reply_markup.inline_keyboard[0]) {
      assert.ok(Buffer.byteLength(button.callback_data) <= 64);
      assert.ok(!button.callback_data.includes("session-a"));
    }
    assert.match(preview.text, /BTC qty=0.01/);
  });
});

describe("market order session binding", () => {
  it("rejects a changed session before confirmation", async () => {
    const r = rig();
    const id = draftId(r.preview());
    r.setIdentity("session-b");
    await assert.rejects(r.flow.confirm(ctx, id), /session changed/);
    assert.equal(r.orders.length, 0);
    await r.flow.confirm(ctx, draftId(r.preview()));
    assert.equal(r.orders.length, 1);
  });

  for (const action of ["replaced", "disconnected", "reconnected"]) {
    it(`does not submit if the session is ${action} during account refresh`, async () => {
      const r = rig();
      const wait = deferred();
      r.scope.service.refreshAccount = () => {
        r.steps.push("refresh");
        return wait.promise;
      };
      const pending = r.flow.confirm(ctx, draftId(r.preview()));
      assert.deepEqual(r.steps, ["refresh"]);
      if (action === "replaced") r.setIdentity("session-b");
      else {
        r.flow.invalidate(ctx.ownerId);
        if (action === "disconnected") r.setIdentity(undefined);
      }
      wait.resolve({ canTrade: true });
      await assert.rejects(pending, /session changed|confirmation expired/);
      assert.equal(r.orders.length, 0);
      assert.equal(r.steps.includes("watcher-ready"), false);
      r.setIdentity("session-b");
      await r.flow.confirm(ctx, draftId(r.preview()));
      assert.equal(r.orders.length, 1);
    });
  }

  it("rechecks the session after waiting for fill tracking", async () => {
    const r = rig();
    r.scope.accountRisk.updateAccount({ canTrade: true });
    const wait = deferred();
    r.scope.runtime.prepareAccountWatcher = () => {
      r.steps.push("watcher-wait");
      return wait.promise;
    };
    const pending = r.flow.confirm(ctx, draftId(r.preview()));
    assert.deepEqual(r.steps, ["watcher-wait"]);
    r.setIdentity("session-b");
    wait.resolve();
    await assert.rejects(pending, /session changed/);
    assert.equal(r.orders.length, 0);
  });

  it("preserves a newer preview when an invalidated confirmation finishes", async () => {
    const r = rig();
    const wait = deferred();
    r.scope.service.refreshAccount = () => wait.promise;
    const pending = r.flow.confirm(ctx, draftId(r.preview()));
    const current = draftId(r.preview(["ETH", "BUY", "1"]));
    wait.resolve({ canTrade: true });
    await assert.rejects(pending, /confirmation expired/);
    await r.flow.confirm(ctx, current);
    assert.equal(r.orders.length, 1);
    assert.equal(r.orders[0].symbol, "ETH");
  });

  it("allows verification timestamps to change but detects credential/account revisions", () => {
    const stored = {
      apiKeyEncrypted: "encrypted-fixture-key-a",
      apiSecretEncrypted: "encrypted-fixture-secret-a",
      signingAlgorithm: "sha256",
      account: "fixture-account",
      updatedAt: 1,
    };
    const sessions = { getStored: () => stored };
    const initial = marketSessionIdentity(sessions, ctx.ownerId);
    stored.updatedAt = 2;
    stored.lastVerifiedAt = 2;
    assert.equal(marketSessionIdentity(sessions, ctx.ownerId), initial);
    for (const key of ["apiKeyEncrypted", "apiSecretEncrypted", "signingAlgorithm", "account"]) {
      const prior = stored[key];
      stored[key] = "changed";
      assert.notEqual(marketSessionIdentity(sessions, ctx.ownerId), initial);
      stored[key] = prior;
    }
    assert.equal(marketSessionIdentity({ getStored: () => undefined }, ctx.ownerId), undefined);
  });
});

describe("market order validation and submission", () => {
  it("starts fill tracking before submission and keeps quantity/leverage settings", async () => {
    const r = rig();
    await r.flow.confirm(ctx, draftId(r.preview()));
    assert.deepEqual(r.steps, ["refresh", "watcher-ready", "submit"]);
    assert.deepEqual(r.orders[0], {
      ownerId: ctx.ownerId,
      symbol: "BTC",
      side: "BUY",
      type: "MARKET",
      quantity: 0.01,
      disableLeverage: 1,
      paymentCurrency: "USD",
    });
  });

  it("does not submit when account trading permission is disabled", async () => {
    const r = rig();
    r.scope.service.refreshAccount = async () => ({ canTrade: false });
    await assert.rejects(r.flow.confirm(ctx, draftId(r.preview())), /trading permission/);
    assert.equal(r.orders.length, 0);
    r.scope.accountRisk.updateAccount({ canTrade: true });
    await r.flow.confirm(ctx, draftId(r.preview()));
    assert.equal(r.orders.length, 1);
  });

  it("does not submit or reuse confirmation after fill tracking fails", async () => {
    const r = rig();
    const id = draftId(r.preview());
    r.scope.runtime.prepareAccountWatcher = async () => {
      throw new Error("stream unavailable");
    };
    await assert.rejects(r.flow.confirm(ctx, id), /stream unavailable/);
    assert.equal(r.orders.length, 0);
    await assert.rejects(r.flow.confirm(ctx, id), /confirmation expired/);
    r.scope.runtime.prepareAccountWatcher = async () => {};
    await r.flow.confirm(ctx, draftId(r.preview()));
    assert.equal(r.orders.length, 1);
  });

  it("does not retry a submission with an ambiguous transport timeout", async () => {
    const r = rig();
    r.scope.service.submitOrder = async (order) => {
      r.orders.push(order);
      throw new Error("ETIMEDOUT");
    };
    const id = draftId(r.preview());
    await assert.rejects(r.flow.confirm(ctx, id), /ETIMEDOUT/);
    await assert.rejects(r.flow.confirm(ctx, id), /confirmation expired/);
    assert.equal(r.orders.length, 1);
  });

  it("keeps paper orders offline without requiring a trading session", async () => {
    const r = rig();
    r.setReal(false);
    r.setIdentity(undefined);
    const result = await r.flow.confirm(ctx, draftId(r.preview()));
    assert.equal(result.result.paper, true);
    assert.deepEqual(r.steps, ["submit"]);
  });

  it("rejects invalid quantities and real orders without a session", () => {
    const r = rig();
    for (const quantity of ["0", "-1", "NaN", "Infinity"]) {
      assert.throws(() => r.preview(["BTC", "BUY", quantity]), /positive|number/);
    }
    assert.throws(() => r.preview(["BTC", "BUY"]), /Usage/);
    assert.throws(() => r.preview(validWords, { ...ctx, chatType: "group" }), /private chat/);
    r.setIdentity(undefined);
    assert.throws(() => r.preview(), /Connect/);
    r.setIdentity("session-a");
    assert.match(r.preview().text, /Review MARKET/);
  });
});

describe("market order fill stream integration", () => {
  it("waits for subscription and records immediate and later fills without active triggers", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const priorMode = process.env.MODE,
      priorDebug = process.env.SESSION_DEBUG;
    process.env.MODE = "real";
    delete process.env.SESSION_DEBUG;
    t.after(() => {
      if (priorMode === undefined) delete process.env.MODE;
      else process.env.MODE = priorMode;
      if (priorDebug === undefined) delete process.env.SESSION_DEBUG;
      else process.env.SESSION_DEBUG = priorDebug;
    });
    const stream = new UserDataStreamService({ url: "ws://fixture.invalid", requestToken: "fixture-only-token" });
    const positions = new PositionStore(tempFile("positions.json", "qt-market-stream-"));
    const triggers = new TriggerStore(tempFile("triggers.json", "qt-market-stream-"));
    const history = new OrderHistoryStore();
    const runtime = new TriggerRuntime(
      triggers,
      positions,
      {
        async processPositionUpdate() {},
      },
      () => {},
      stream,
      { ensureActive() {} },
      history,
    );
    t.after(() => runtime.stop());
    let posts = 0;
    const fill = (quantity) => ({
      e: "ORDER_TRADE_UPDATE",
      o: { s: "BTC", S: "BUY", i: 42, o: "1", X: "2", x: "F", z: quantity, q: "0.01", lv: 0 },
    });
    const service = new BotService(positions, undefined, ctx.ownerId, {
      async post() {
        posts++;
        FakeSocket.latest.deliver(fill("0.005"));
        return { orderId: 42, status: "NEW" };
      },
    });
    const risk = new AccountRiskStore();
    risk.updateAccount({ canTrade: true });
    const flow = new MarketOrderFlow({
      sessionIdentity: () => "session-a",
      getScope: () => ({ service, accountRisk: risk, runtime }),
      isRealMode: () => true,
      paymentCurrency: () => "USD",
    });
    const pending = flow.confirm(ctx, draftId(flow.preview(ctx, validWords)));
    assert.equal(posts, 0);
    const socket = FakeSocket.latest;
    assert.equal(socket.readyState, 0, "precondition: subscription is still connecting");
    socket.open();
    assert.equal(posts, 0, "open alone must not allow submission before the subscription is sent");
    assert.equal(socket.sent.length, 1);
    socket.finishSend();
    await pending;
    assert.equal(posts, 1);
    t.mock.timers.tick(500);
    assert.equal(history.fills().items[0].cumQty, "0.005");
    socket.deliver({ e: "ACCOUNT_UPDATE", a: { P: [{ s: "BTC", pa: 0.01, ep: 100 }] } });
    await Promise.resolve();
    await Promise.resolve();
    runtime.reconcile();
    assert.equal(socket.readyState, 1, "position reconciliation must not stop market fill tracking");
    socket.deliver(fill("0.01"));
    t.mock.timers.tick(500);
    assert.equal(history.fills().items[0].cumQty, "0.01");
    assert.equal(history.fills().total, 1, "cumulative fills update the same order instead of being summed");
    assert.equal(positions.get("BTC").netQty, 0.01);
    runtime.stop();
    assert.equal(socket.readyState, 3, "disconnect/stop still releases the retained stream");
  });
});
