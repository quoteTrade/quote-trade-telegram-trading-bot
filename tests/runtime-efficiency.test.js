const assert = require('node:assert');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TriggerStore } = require('../dist/triggers/trigger-store');
const { PositionStore } = require('../dist/triggers/position-store');
const { TriggerEngine } = require('../dist/triggers/trigger-engine');
const { TriggerRuntime } = require('../dist/trigger-runtime');

function tmp(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-runtime-test-'));
  return path.join(d, name);
}

class FakeExecutor {
  constructor() { this.orders = []; }
  async submitOrder(req) { this.orders.push(req); return { orderId: `order-${this.orders.length}` }; }
}

class FakeUserDataStream extends EventEmitter {
  constructor() {
    super();
    this.starts = 0;
    this.stops = 0;
    this.started = false;
  }
  start() { this.starts += 1; this.started = true; return true; }
  stop() { this.stops += 1; this.started = false; }
}

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
  ensureActive() { this.ensureActiveCalls += 1; }
}

function rig() {
  const triggers = new TriggerStore(tmp('triggers.json'));
  const positions = new PositionStore(tmp('positions.json'));
  const executor = new FakeExecutor();
  const engine = new TriggerEngine(triggers, positions, executor);
  const userData = new FakeUserDataStream();
  const priceFeed = new FakePriceFeed();
  const runtime = new TriggerRuntime(triggers, positions, engine, () => undefined, userData, priceFeed);
  return { triggers, positions, executor, engine, userData, priceFeed, runtime };
}

(async () => {
  {
    const { triggers, userData, priceFeed, runtime } = rig();
    triggers.add({ kind: 'LIMIT', symbol: 'BTC', side: 'BUY', triggerPrice: 100, quantity: 1 });
    runtime.ensure();
    assert.strictEqual(userData.starts, 0, 'fixed-size price triggers should not start a per-user account stream');
    assert.deepStrictEqual(priceFeed.subscribed.map((x) => x.symbol), ['BTC']);
    runtime.stop();
  }

  {
    const { triggers, userData, priceFeed, runtime } = rig();
    const close = triggers.add({ kind: 'LIMIT', symbol: 'ETH', side: 'SELL', triggerPrice: 120, closePosition: true });
    runtime.ensure();
    assert.strictEqual(userData.starts, 1, 'close-position triggers need the per-user account stream');
    triggers.cancel(close.id);
    runtime.reconcile();
    assert.strictEqual(userData.stops >= 1, true, 'runtime should stop the account stream after all active triggers are gone');
    assert.deepStrictEqual(priceFeed.unsubscribed, ['ETH'], 'runtime should release inactive market-data symbols');
    runtime.stop();
  }

  {
    const { triggers, positions, userData, priceFeed, runtime } = rig();
    const parent = triggers.add({ kind: 'LIMIT', symbol: 'BTC', side: 'BUY', triggerPrice: 100, quantity: 1, meta: { bracket: { takeProfitPrice: 120, stopLossPrice: 90 } } });
    triggers.setStatus(parent.id, 'TRIGGERED', { meta: { ...parent.meta, bracketEntrySubmittedAt: Date.now(), bracketEntryNetQtyBefore: 0 } });
    runtime.ensure();
    assert.strictEqual(userData.starts, 1, 'pending bracket entries must keep account stream alive until the fill is observed');
    assert.deepStrictEqual(priceFeed.subscribed, [], 'pending bracket entries do not need L2 until exits are armed');

    userData.emit('positionUpdate', { symbol: 'BTC', positionAmt: 1, availableQuantity: 1, avgEntryPrice: 100, markPrice: 101 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(triggers.active('BTC').filter((t) => t.meta && t.meta.bracketExit).length, 2, 'position update should arm bracket exits');
    assert.strictEqual(userData.stops >= 1, true, 'fixed-size bracket exits can stop the account stream after they are armed');
    assert.deepStrictEqual(priceFeed.subscribed.map((x) => x.symbol), ['BTC'], 'armed bracket exits should start BTC L2 listening');
    runtime.stop();
  }

  {
    const { triggers } = rig();
    assert.throws(() => triggers.addOco([
      { kind: 'TAKE_PROFIT', symbol: 'SOL', side: 'SELL', triggerPrice: 120, quantity: 1 },
      { kind: 'STOP_LIMIT', symbol: 'SOL', side: 'SELL', triggerPrice: 90, quantity: 1 },
    ]), /limitPrice is required/);
    assert.strictEqual(triggers.list().length, 0, 'failed OCO creation must not leave a half-created trigger behind');
  }

  console.log('runtime efficiency audit tests passed');
})();
