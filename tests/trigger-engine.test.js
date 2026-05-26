const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TriggerStore } = require('../dist/triggers/trigger-store');
const { PositionStore, normalizePosition } = require('../dist/triggers/position-store');
const { TriggerEngine } = require('../dist/triggers/trigger-engine');
const { shouldTrigger } = require('../dist/triggers/types');

function tmp(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-trigger-test-'));
  return path.join(d, name);
}
class FakeExecutor {
  constructor(){ this.orders=[]; }
  async submitOrder(req){ this.orders.push(req); return { clientOrderId: req.clientOrderId, orderId: `order-${this.orders.length}` }; }
}
function rig() {
  const store = new TriggerStore(tmp('triggers.json'));
  const positions = new PositionStore(tmp('positions.json'));
  const executor = new FakeExecutor();
  const engine = new TriggerEngine(store, positions, executor);
  return { store, positions, executor, engine };
}
function assertThrowsMessage(fn, text) {
  assert.throws(fn, (e) => String(e.message || e).includes(text));
}
function l2(symbol, price, qty = 1000) {
  return l2Book(symbol, price, price, qty, qty);
}
function l2Book(symbol, bid, ask, bidQty = 1000, askQty = 1000, extra = {}) {
  return {
    symbol,
    price: ask,
    bid,
    ask,
    bidQty,
    askQty,
    orderBook: {
      s: symbol,
      bids: extra.bids ?? [{ p: bid, q: bidQty }],
      asks: extra.asks ?? [{ p: ask, q: askQty }],
    },
  };
}

(async () => {
  {
    const { store, executor, engine } = rig();
    const buyLimit = store.add({ kind:'LIMIT', symbol:'BTC', side:'BUY', triggerPrice:100, quantity:0.5 });
    const sellLimit = store.add({ kind:'LIMIT', symbol:'ETH', side:'SELL', triggerPrice:120, quantity:2 });
    assert.strictEqual(shouldTrigger(buyLimit, 101), false);
    assert.strictEqual(shouldTrigger(buyLimit, 100), true);
    assert.strictEqual(shouldTrigger(sellLimit, 119), false);
    assert.strictEqual(shouldTrigger(sellLimit, 120), true);
    await engine.processTick(l2('BTC',100));
    await engine.processTick(l2('ETH',120));
    assert.deepStrictEqual({ side: executor.orders[0].side, type: executor.orders[0].type, price: executor.orders[0].price, qty: executor.orders[0].quantity }, { side:'BUY', type:'LIMIT', price:100, qty:0.5 });
    assert.deepStrictEqual({ side: executor.orders[1].side, type: executor.orders[1].type, price: executor.orders[1].price, qty: executor.orders[1].quantity }, { side:'SELL', type:'LIMIT', price:120, qty:2 });
    await engine.processTick(l2('BTC',99));
    assert.strictEqual(executor.orders.length, 2, 'triggered limits must not fire twice');
  }

  {
    const { store, positions, executor, engine } = rig();
    positions.upsert({ symbol:'ETH', positionAmt:2, availableQuantity:1.75, markPrice:2000 });
    const close = store.add({ kind:'STOP_LIMIT', symbol:'ETH', side:'SELL', triggerPrice:1900, limitPrice:1895, closePosition:true });
    const buyStop = store.add({ kind:'STOP_LIMIT', symbol:'BTC', side:'BUY', triggerPrice:110, limitPrice:111, quantity:0.25 });
    await engine.processTick(l2('ETH',1901));
    await engine.processTick(l2('BTC',109));
    assert.strictEqual(executor.orders.length, 0);
    await engine.processTick(l2('ETH',1900));
    await engine.processTick(l2('BTC',110));
    assert.strictEqual(executor.orders[0].side, 'SELL');
    assert.strictEqual(executor.orders[0].quantity, 1.75);
    assert.strictEqual(executor.orders[0].price, 1895);
    assert.strictEqual(executor.orders[1].side, 'BUY');
    assert.strictEqual(executor.orders[1].price, 111);
    assert.strictEqual(store.get(close.id).status, 'TRIGGERED');
    assert.strictEqual(store.get(buyStop.id).status, 'TRIGGERED');
  }

  {
    const { store, executor, engine } = rig();
    const tpLong = store.add({ kind:'TAKE_PROFIT', symbol:'BTC', side:'SELL', triggerPrice:120, quantity:1 });
    const slLong = store.add({ kind:'STOP_LOSS', symbol:'ETH', side:'SELL', triggerPrice:90, quantity:2 });
    const tpShort = store.add({ kind:'TAKE_PROFIT', symbol:'SOL', side:'BUY', triggerPrice:80, quantity:3 });
    const slShort = store.add({ kind:'STOP_LOSS', symbol:'XRP', side:'BUY', triggerPrice:105, quantity:4 });
    await engine.processTick(l2('BTC',119));
    await engine.processTick(l2('ETH',91));
    await engine.processTick(l2('SOL',81));
    await engine.processTick(l2('XRP',104));
    assert.strictEqual(executor.orders.length, 0);
    await engine.processTick(l2('BTC',120));
    await engine.processTick(l2('ETH',90));
    await engine.processTick(l2('SOL',80));
    await engine.processTick(l2('XRP',105));
    assert.deepStrictEqual([tpLong, slLong, tpShort, slShort].map(t => store.get(t.id).status), ['TRIGGERED','TRIGGERED','TRIGGERED','TRIGGERED']);
    assert.deepStrictEqual(executor.orders.map(o => o.side), ['SELL','SELL','BUY','BUY']);
    assert.strictEqual(executor.orders.every(o => o.type === 'MARKET'), true);
  }

  {
    const { store, executor, engine } = rig();
    const trailing = store.add({ kind:'TRAILING_STOP', symbol:'BTC', side:'SELL', trailMode:'AMOUNT', trailValue:10, quantity:1 });
    await engine.processTick(l2('BTC',100));
    assert.strictEqual(store.get(trailing.id).currentStopPrice, 90);
    await engine.processTick(l2('BTC',120));
    assert.strictEqual(store.get(trailing.id).currentStopPrice, 110);
    await engine.processTick(l2('BTC',109));
    assert.strictEqual(executor.orders.length, 1);
    assert.strictEqual(executor.orders[0].type, 'MARKET');
    assert.strictEqual(executor.orders[0].side, 'SELL');
  }

  {
    const { store, executor, engine } = rig();
    const trailingShort = store.add({ kind:'TRAILING_STOP', symbol:'ETH', side:'BUY', trailMode:'PERCENT', trailValue:10, quantity:1 });
    await engine.processTick(l2('ETH',100));
    assert.strictEqual(store.get(trailingShort.id).currentStopPrice, 110);
    await engine.processTick(l2('ETH',80));
    assert.strictEqual(store.get(trailingShort.id).currentStopPrice, 88);
    await engine.processTick(l2('ETH',87.9));
    assert.strictEqual(executor.orders.length, 0);
    await engine.processTick(l2('ETH',88));
    assert.strictEqual(executor.orders[0].side, 'BUY');
  }

  {
    const { store, executor, engine } = rig();
    store.add({ kind:'TRAILING_STOP_LIMIT', symbol:'BTC', side:'SELL', trailMode:'AMOUNT', trailValue:5, limitOffset:1, quantity:1 });
    store.add({ kind:'TRAILING_STOP_LIMIT', symbol:'ETH', side:'BUY', trailMode:'AMOUNT', trailValue:5, limitOffset:2, quantity:2 });
    await engine.processTick(l2('BTC',100));
    await engine.processTick(l2('BTC',110));
    await engine.processTick(l2('BTC',104));
    await engine.processTick(l2('ETH',100));
    await engine.processTick(l2('ETH',90));
    await engine.processTick(l2('ETH',95));
    assert.strictEqual(executor.orders.length, 2);
    assert.deepStrictEqual(executor.orders.map(o => ({ side:o.side, type:o.type, price:o.price })), [
      { side:'SELL', type:'LIMIT', price:104 },
      { side:'BUY', type:'LIMIT', price:97 },
    ]);
  }

  {
    const { store, executor, engine } = rig();
    const [tp, sl] = store.addOco([
      { kind:'TAKE_PROFIT', symbol:'BTC', side:'SELL', triggerPrice:120, quantity:1 },
      { kind:'STOP_LOSS', symbol:'BTC', side:'SELL', triggerPrice:90, quantity:1 },
    ], 'oco-test');
    await engine.processTick(l2('BTC',121));
    assert.strictEqual(executor.orders.length, 1);
    assert.strictEqual(store.get(tp.id).status, 'TRIGGERED');
    assert.strictEqual(store.get(sl.id).status, 'CANCELLED');
  }

  {
    const { store, positions, executor, engine } = rig();
    positions.upsert({ symbol:'SOL', positionAmt:4, availableQuantity:4, markPrice:100 });
    store.add({ kind:'TAKE_PROFIT', symbol:'SOL', side:'SELL', triggerPrice:120, closePercentage:25, reduceOnly:true });
    positions.upsert({ symbol:'DOGE', positionAmt:-8, availableQuantity:-8, markPrice:10 });
    store.add({ kind:'TAKE_PROFIT', symbol:'DOGE', side:'BUY', triggerPrice:8, closePercentage:50, reduceOnly:true });
    await engine.processTick(l2('SOL',120));
    await engine.processTick(l2('DOGE',8));
    assert.strictEqual(executor.orders[0].quantity, 1);
    assert.strictEqual(executor.orders[0].reduceOnly, true);
    assert.strictEqual(executor.orders[1].side, 'BUY');
    assert.strictEqual(executor.orders[1].quantity, 4);
  }

  {
    const { store, positions, executor, engine } = rig();
    positions.upsert({ symbol:'BTC', positionAmt:1, availableQuantity:1, avgEntryPrice:100, markPrice:100 });
    const be = store.add({ kind:'BREAK_EVEN_STOP', symbol:'BTC', side:'SELL', activationMode:'AMOUNT', activationValue:10, lockMode:'AMOUNT', lockValue:0, closePosition:true });
    await engine.processTick(l2('BTC',109));
    assert.strictEqual(store.get(be.id).breakEvenArmed, false);
    await engine.processTick(l2('BTC',110));
    assert.strictEqual(store.get(be.id).breakEvenArmed, true);
    assert.strictEqual(store.get(be.id).currentStopPrice, 100);
    await engine.processTick(l2('BTC',99));
    assert.strictEqual(executor.orders[0].side, 'SELL');
    assert.strictEqual(executor.orders[0].quantity, 1);
  }

  {
    const { store, positions, executor, engine } = rig();
    positions.upsert({ symbol:'ETH', positionAmt:-2, availableQuantity:-2, avgEntryPrice:100, markPrice:100 });
    const be = store.add({ kind:'BREAK_EVEN_STOP', symbol:'ETH', side:'BUY', activationMode:'PERCENT', activationValue:10, lockMode:'AMOUNT', lockValue:0, closePosition:true });
    await engine.processTick(l2('ETH',91));
    assert.strictEqual(store.get(be.id).breakEvenArmed, false);
    await engine.processTick(l2('ETH',90));
    assert.strictEqual(store.get(be.id).breakEvenArmed, true);
    await engine.processTick(l2('ETH',100));
    assert.strictEqual(executor.orders[0].side, 'BUY');
    assert.strictEqual(executor.orders[0].quantity, 2);
  }

  {
    const { store, positions, executor, engine } = rig();
    positions.upsert({ symbol:'ETH', positionAmt:-3, availableQuantity:-3, avgEntryPrice:100, markPrice:100 });
    store.add({ kind:'TIME_CLOSE', symbol:'ETH', side:'BUY', triggerAt:Date.now()+1000, closePosition:true });
    assert.deepStrictEqual(store.watchableSymbols(), ['ETH'], 'TIME_CLOSE must subscribe to L2 so it has executable depth when due');
    store.add({ kind:'RISK_GUARD', symbol:'DOGE', side:'SELL', riskMetric:'MAX_POSITION_QTY', riskThreshold:100, riskAction:'ALERT' });
    assert.deepStrictEqual(store.watchableSymbols(), ['ETH'], 'MAX_POSITION_QTY alerts do not need L2 subscriptions');
    store.add({ kind:'RISK_GUARD', symbol:'SOL', side:'SELL', riskMetric:'MAX_LOSS_USD', riskThreshold:50, riskAction:'ALERT' });
    assert.deepStrictEqual(store.watchableSymbols(), ['ETH', 'SOL'], 'risk guards that need live mark/risk values should subscribe to L2');
    await engine.processTick(l2('ETH',100));
    assert.strictEqual(executor.orders.length, 0);
    await engine.processDueTimers(Date.now()+2000);
    assert.strictEqual(executor.orders[0].side, 'BUY');
    assert.strictEqual(executor.orders[0].quantity, 3);
  }

  {
    const store = new TriggerStore(tmp('triggers.json'));
    const positions = new PositionStore(tmp('positions.json'));
    const executor = new FakeExecutor();
    const engine = new TriggerEngine(store, positions, executor, { maxTickAgeMs: 1000 });
    const base = Date.now();
    positions.upsert({ symbol:'BTC', positionAmt:1, availableQuantity:1, avgEntryPrice:100, markPrice:100 });
    store.add({ kind:'TIME_CLOSE', symbol:'BTC', side:'SELL', triggerAt:base+1000, closePosition:true });
    await engine.processTick({ ...l2('BTC',100), ts: base - 10_000 });
    await engine.processDueTimers(base+2000);
    assert.strictEqual(executor.orders.length, 0, 'TIME_CLOSE must not submit against stale cached L2 depth');
    await engine.processTick({ ...l2('BTC',100), ts: base+1500 });
    await engine.processDueTimers(base+2000);
    assert.strictEqual(executor.orders[0].side, 'SELL');
  }


  {
    const store = new TriggerStore(tmp('triggers.json'));
    const positions = new PositionStore(tmp('positions.json'));
    const executor = new FakeExecutor();
    const engine = new TriggerEngine(store, positions, executor, { maxTickAgeMs: 1000 });
    const base = Date.now();
    store.add({ kind:'LIMIT', symbol:'BTC', side:'BUY', triggerPrice:100, quantity:1 });
    await engine.processTick({ ...l2('BTC',100), ts: base - 10_000 });
    assert.strictEqual(executor.orders.length, 0, 'regular triggers must not submit against stale cached L2 depth replayed to a new subscriber');
    await engine.processTick({ ...l2('BTC',100), ts: base });
    assert.strictEqual(executor.orders[0].side, 'BUY');
  }

  {
    const { store, engine } = rig();
    const target = store.add({ kind:'LIMIT', symbol:'BTC', side:'BUY', triggerPrice:80, quantity:1 });
    const cancel = store.add({ kind:'TIME_CANCEL', symbol:'BTC', side:'SELL', triggerAt:Date.now()+1000, cancelTriggerId:target.id });
    await engine.processDueTimers(Date.now()+2000);
    assert.strictEqual(store.get(target.id).status, 'CANCELLED');
    assert.strictEqual(store.get(cancel.id).status, 'TRIGGERED');
  }

  {
    const { store, executor, engine } = rig();
    const breakoutBuy = store.add({ kind:'PRICE_BAND', symbol:'BTC', side:'BUY', priceBandMode:'BREAKOUT', upperPrice:150, quantity:1 });
    const reversionSell = store.add({ kind:'PRICE_BAND', symbol:'ETH', side:'SELL', priceBandMode:'REVERSION', upperPrice:200, quantity:2 });
    const reversionBuy = store.add({ kind:'PRICE_BAND', symbol:'SOL', side:'BUY', priceBandMode:'REVERSION', lowerPrice:50, quantity:3 });
    await engine.processTick(l2('BTC',149));
    await engine.processTick(l2('ETH',199));
    await engine.processTick(l2('SOL',51));
    assert.strictEqual(executor.orders.length, 0);
    await engine.processTick(l2('BTC',150));
    await engine.processTick(l2('ETH',200));
    await engine.processTick(l2('SOL',50));
    assert.deepStrictEqual([breakoutBuy, reversionSell, reversionBuy].map(t => store.get(t.id).status), ['TRIGGERED','TRIGGERED','TRIGGERED']);
    assert.deepStrictEqual(executor.orders.map(o => o.side), ['BUY','SELL','BUY']);
  }

  {
    const { store, positions, executor, engine } = rig();
    positions.upsert({ symbol:'DOGE', positionAmt:10, availableQuantity:10, avgEntryPrice:5, markPrice:10 });
    store.add({ kind:'RISK_GUARD', symbol:'DOGE', side:'SELL', riskMetric:'MAX_RISK_USD', riskThreshold:50, riskAction:'CLOSE_POSITION', closePosition:true });
    await engine.processTick(l2('DOGE',10));
    assert.strictEqual(executor.orders[0].side, 'SELL');
    assert.strictEqual(executor.orders[0].quantity, 10);
  }

  {
    const { store, positions, engine } = rig();
    const target = store.add({ kind:'LIMIT', symbol:'XRP', side:'BUY', triggerPrice:1, quantity:100 });
    positions.upsert({ symbol:'XRP', positionAmt:100, availableQuantity:100, markPrice:2 });
    const guard = store.add({ kind:'RISK_GUARD', symbol:'XRP', side:'SELL', riskMetric:'MAX_POSITION_QTY', riskThreshold:50, riskAction:'CANCEL_TRIGGERS' });
    await engine.processTick(l2('XRP',2));
    assert.strictEqual(store.get(target.id).status, 'CANCELLED');
    assert.strictEqual(store.get(guard.id).status, 'TRIGGERED');
  }

  {
    const { store, positions, executor, engine } = rig();
    positions.upsert({ symbol:'ADA', positionAmt:5, availableQuantity:5, avgEntryPrice:100, markPrice:80 });
    store.add({ kind:'RISK_GUARD', symbol:'ADA', side:'SELL', riskMetric:'MAX_LOSS_USD', riskThreshold:100, riskAction:'ALERT' });
    await engine.processTick(l2('ADA',80));
    assert.strictEqual(executor.orders.length, 0);
    assert.strictEqual(store.active('ADA').length, 0, 'alert risk guard should mark itself triggered without submitting');
  }

  {
    const { store, positions, executor, engine } = rig();
    const bracket = store.add({ kind:'LIMIT', symbol:'BTC', side:'BUY', triggerPrice:100, quantity:1, meta:{ bracket:{ takeProfitPrice:120, stopLossPrice:90, stopLimitPrice:89 } } });
    await engine.processTick(l2('BTC',100));
    assert.strictEqual(executor.orders.length, 1);
    assert.strictEqual(store.get(bracket.id).status, 'TRIGGERED');
    let children = store.active('BTC').filter(t => t.meta && t.meta.bracketExit);
    assert.strictEqual(children.length, 0, 'bracket exits should not be active before position memory confirms entry');
    await engine.processTick(l2('BTC',121));
    assert.strictEqual(executor.orders.length, 1, 'bracket exits must not fire before position memory confirms entry');
    positions.upsert({ symbol:'BTC', positionAmt:1, availableQuantity:1, avgEntryPrice:100, markPrice:101 });
    await engine.processPositionUpdate('BTC');
    children = store.active('BTC').filter(t => t.meta && t.meta.bracketExit);
    assert.strictEqual(children.length, 2);
    assert.strictEqual(children.every(t => t.closePosition === false && t.quantity === 1), true);
    await engine.processTick(l2('BTC',121));
    assert.strictEqual(executor.orders.length, 2);
    assert.strictEqual(executor.orders[1].quantity, 1);
    assert.strictEqual(children.map(t => store.get(t.id).status).filter(s => s === 'CANCELLED').length, 1);
  }

  {
    const { store, positions, executor, engine } = rig();
    positions.upsert({ symbol:'ETH', positionAmt:-1, availableQuantity:-1, avgEntryPrice:100, markPrice:100 });
    const bracket = store.add({ kind:'LIMIT', symbol:'ETH', side:'BUY', triggerPrice:90, quantity:1, meta:{ bracket:{ takeProfitPrice:110, stopLossPrice:80 } } });
    await engine.processTick(l2('ETH',90));
    positions.upsert({ symbol:'ETH', positionAmt:-0.5, availableQuantity:-0.5, avgEntryPrice:100, markPrice:91 });
    await engine.processPositionUpdate('ETH');
    assert.strictEqual(store.active('ETH').filter(t => t.meta && t.meta.bracketExit).length, 0, 'reducing an existing short is not a new long bracket entry');
    positions.upsert({ symbol:'ETH', positionAmt:0.25, availableQuantity:0.25, avgEntryPrice:90, markPrice:91 });
    await engine.processPositionUpdate('ETH');
    const children = store.active('ETH').filter(t => t.meta && t.meta.bracketExit);
    assert.strictEqual(children.length, 2);
    assert.strictEqual(children.every(t => t.closePosition === false && t.quantity === 0.25), true);
    await engine.processTick(l2('ETH',110));
    assert.strictEqual(executor.orders[1].quantity, 0.25);
    assert.strictEqual(store.get(bracket.id).status, 'TRIGGERED');
  }

  {
    const { store, executor, engine } = rig();
    store.add({ kind:'LIMIT', symbol:'BTC', side:'BUY', triggerPrice:100, quantity:2 });
    store.add({ kind:'LIMIT', symbol:'ETH', side:'SELL', triggerPrice:120, quantity:2 });
    await engine.processTick(l2Book('BTC', 100, 101, 10, 10));
    await engine.processTick(l2Book('ETH', 119, 120, 10, 10));
    assert.strictEqual(executor.orders.length, 0, 'BUY must ignore bid and SELL must ignore ask');

    await engine.processTick(l2Book('BTC', 100, 100, 10, 1.99));
    await engine.processTick(l2Book('ETH', 120, 120, 1.99, 10));
    assert.strictEqual(executor.orders.length, 0, 'triggers must wait for enough cumulative L2 quantity');

    await engine.processTick(l2Book('BTC', 100, 100, 10, 2));
    await engine.processTick(l2Book('ETH', 120, 120, 2, 10));
    assert.deepStrictEqual(executor.orders.map(o => o.side), ['BUY','SELL']);
  }

  {
    const { store, executor, engine } = rig();
    store.add({ kind:'LIMIT', symbol:'BTC', side:'BUY', triggerPrice:100, quantity:3 });
    await engine.processTick(l2Book('BTC', 99, 99, 10, 1, { asks:[{ p:99, q:1 }, { p:100, q:2 }] }));
    assert.strictEqual(executor.orders.length, 1, 'BUY limit may use cumulative ask depth through the trigger price');

    const { store: store2, executor: executor2, engine: engine2 } = rig();
    store2.add({ kind:'LIMIT', symbol:'ETH', side:'SELL', triggerPrice:120, quantity:3 });
    await engine2.processTick(l2Book('ETH', 121, 122, 1, 10, { bids:[{ p:121, q:1 }, { p:120, q:2 }] }));
    assert.strictEqual(executor2.orders.length, 1, 'SELL limit may use cumulative bid depth through the trigger price');
  }

  {
    const { store, executor, engine } = rig();
    store.add({ kind:'LIMIT', symbol:'BTC', side:'BUY', triggerPrice:100, quantity:2 });
    await engine.processTick({ symbol:'BTC', orderBook:{ asks:[{ p:100, q:2 }] } });
    assert.strictEqual(executor.orders.length, 1, 'BUY triggers should work from ask-only L2 depth');

    const { store: store2, executor: executor2, engine: engine2 } = rig();
    store2.add({ kind:'LIMIT', symbol:'ETH', side:'SELL', triggerPrice:120, quantity:2 });
    await engine2.processTick({ symbol:'ETH', orderBook:{ bids:[{ p:120, q:2 }] } });
    assert.strictEqual(executor2.orders.length, 1, 'SELL triggers should work from bid-only L2 depth');
  }

  {
    const { store, positions } = rig();
    assertThrowsMessage(() => store.add({ kind:'LIMIT', symbol:'BTC', side:'BUY', triggerPrice:1 }), 'quantity is required');
    assert.strictEqual(normalizePosition({ a:'USDC', wb:1000 }), undefined, 'wallet balance updates must not be cached as positions');
    assert.strictEqual(positions.upsert({ a:'USDC', wb:1000 }), undefined);
    assert.strictEqual(positions.list().length, 0);
    positions.setMark('BTC', 100);
    assert.strictEqual(positions.list().length, 0, 'market ticks alone must not create fake zero positions');
  }


  {
    const { store, positions, executor, engine } = rig();
    positions.upsert({ symbol:'AVAX', positionAmt:3, availableQuantity:3, avgEntryPrice:100, markPrice:150 });
    const guard = store.add({ kind:'RISK_GUARD', symbol:'AVAX', side:'SELL', riskMetric:'MAX_RISK_USD', riskThreshold:400, riskAction:'CLOSE_POSITION', closePosition:true });
    await engine.processPositionUpdate('AVAX');
    assert.strictEqual(store.get(guard.id).status, 'ACTIVE', 'close-position risk guards wait for L2 quantity before submitting');
    assert.strictEqual(executor.orders.length, 0);
    await engine.processTick(l2('AVAX',150));
    assert.strictEqual(store.get(guard.id).status, 'TRIGGERED');
    assert.strictEqual(executor.orders[0].quantity, 3);
  }

  {
    const { store, positions, engine } = rig();
    const bracket = store.add({ kind:'LIMIT', symbol:'ETH', side:'SELL', triggerPrice:100, quantity:2, meta:{ bracket:{ takeProfitPrice:80, stopLossPrice:110, useClosePosition:false } } });
    await engine.processTick(l2('ETH',100));
    positions.upsert({ symbol:'ETH', positionAmt:-0.75, availableQuantity:-0.75, avgEntryPrice:100, markPrice:99 });
    await engine.processPositionUpdate('ETH');
    const children = store.active('ETH').filter(t => t.meta && t.meta.bracketExit);
    assert.strictEqual(children.length, 2);
    assert.strictEqual(children.every(t => t.side === 'BUY'), true);
    assert.strictEqual(children.every(t => t.quantity === 0.75), true, 'bracket exits should size to confirmed filled quantity when entry only partially fills');
    assert.strictEqual(store.get(bracket.id).meta.bracketChildrenCreated, true);
  }

  {
    const { store, engine } = rig();
    const group = 'oco_test_group';
    const [a, b] = store.addOco([
      { kind:'TAKE_PROFIT', symbol:'MATIC', side:'SELL', triggerPrice:120, quantity:1 },
      { kind:'STOP_LOSS', symbol:'MATIC', side:'SELL', triggerPrice:90, quantity:1 },
    ], group);
    store.add({ kind:'TIME_CANCEL', symbol:'MATIC', side:'SELL', triggerAt:Date.now()+1000, cancelGroupId:group });
    await engine.processDueTimers(Date.now()+2000);
    assert.strictEqual(store.get(a.id).status, 'CANCELLED');
    assert.strictEqual(store.get(b.id).status, 'CANCELLED');
  }


  {
    const { store, engine } = rig();
    const trailing = store.add({ kind:'TRAILING_STOP', symbol:'BTC', side:'SELL', trailMode:'AMOUNT', trailValue:10, quantity:1 });
    await engine.processTick(l2('BTC',100));
    const savedAfterMove = JSON.parse(fs.readFileSync(store.filePath, 'utf8')).find(t => t.id === trailing.id);
    await engine.processTick(l2('BTC',99));
    const savedAfterNoise = JSON.parse(fs.readFileSync(store.filePath, 'utf8')).find(t => t.id === trailing.id);
    assert.strictEqual(store.get(trailing.id).lastCheckedPrice, 99);
    assert.strictEqual(savedAfterMove.lastCheckedPrice, 100);
    assert.strictEqual(savedAfterNoise.lastCheckedPrice, 100, 'side-quote-only ticks should not write triggers.json');
  }


  {
    class DelayedExecutor {
      constructor() {
        this.orders = [];
        this.release = () => undefined;
        this.wait = new Promise((resolve) => { this.release = resolve; });
      }
      async submitOrder(req) {
        this.orders.push(req);
        await this.wait;
        return { clientOrderId: req.clientOrderId, orderId: 'delayed-order' };
      }
    }
    const store = new TriggerStore(tmp('triggers.json'));
    const positions = new PositionStore(tmp('positions.json'));
    const executor = new DelayedExecutor();
    const engine = new TriggerEngine(store, positions, executor);
    const trigger = store.add({ kind:'LIMIT', symbol:'BTC', side:'BUY', triggerPrice:100, quantity:1 });
    const firstFire = engine.processTick(l2('BTC',100));
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(store.get(trigger.id).status, 'SUBMITTING', 'trigger should be durably reserved before awaiting order submission');
    assert.strictEqual(store.active('BTC').length, 0, 'SUBMITTING triggers should not remain active for duplicate firing');
    await engine.processTick(l2('BTC',100));
    assert.strictEqual(executor.orders.length, 1, 'a second tick during submission must not submit a duplicate order');
    executor.release();
    await firstFire;
    assert.strictEqual(store.get(trigger.id).status, 'TRIGGERED');
  }

  console.log('trigger-engine tests passed');
})();
