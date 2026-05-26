const assert = require('node:assert');
const { PriceFeedService } = require('../dist/utils/price-feed.service');

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
    if (event === 'open') this.readyState = 1;
    if (event === 'close') this.readyState = 3;
    for (const fn of this.handlers.get(event) || []) fn(payload);
  }
  send(payload) { this.sent.push(payload); }
  close(code, reason) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
  }
}

function book(symbol, bid, ask, bidQty = 10, askQty = 10) {
  return JSON.stringify({
    s: symbol,
    bids: [{ p: bid, q: bidQty }],
    asks: [{ p: ask, q: askQty }],
  });
}

function sent(ws) {
  return ws.sent.map((payload) => JSON.parse(payload));
}

(async () => {
  FakeWebSocket.instances = [];
  const warnings = [];
  const feed = new PriceFeedService({
    url: 'ws://example.test/l2',
    idleCloseMs: 0,
    reconnectMs: 10,
    createWebSocket: (url) => new FakeWebSocket(url),
    onWarning: (message) => warnings.push(message),
  });

  const seenA = [];
  const seenB = [];
  const stopA = feed.subscribe('btc', (quote) => seenA.push(quote), 0);
  const stopB = feed.subscribe('BTC', (quote) => seenB.push(quote), 0);

  assert.strictEqual(FakeWebSocket.instances.length, 1, 'subscribers should share one multiplexed websocket');
  assert.strictEqual(feed.activeStreamCount(), 1);
  assert.strictEqual(feed.activeSocketCount(), 1);
  assert.strictEqual(feed.activeSymbolCount(), 1);
  assert.strictEqual(feed.subscriberCount('BTC'), 2);

  const ws = FakeWebSocket.instances[0];
  assert.deepStrictEqual(ws.sent, [], 'subscriptions should wait until websocket open');
  ws.emit('open');
  assert.deepStrictEqual(sent(ws), [{ symbol: 'BTC', unsubscribe: 0 }]);

  ws.emit('message', Buffer.from(book('BTC', 99, 100, 3, 4)));
  assert.strictEqual(seenA.length, 1);
  assert.strictEqual(seenB.length, 1);
  assert.strictEqual(seenA[0].bid, 99);
  assert.strictEqual(seenA[0].ask, 100);
  assert.strictEqual(feed.getSnapshot('BTC').askQty, 4);

  ws.emit('message', Buffer.from(JSON.stringify({ s: 'BTC', asks: [{ p: 98, q: 7 }] })));
  assert.strictEqual(seenA.length, 2, 'ask-only L2 frames should be delivered so BUY triggers can use ask depth');
  assert.strictEqual(seenA[1].ask, 98);
  assert.strictEqual(seenA[1].askQty, 7);
  assert.strictEqual(seenA[1].bid, undefined);

  ws.emit('message', Buffer.from(JSON.stringify({ s: 'BTC', bids: [{ p: 101, q: 8 }] })));
  assert.strictEqual(seenA.length, 3, 'bid-only L2 frames should be delivered so SELL triggers can use bid depth');
  assert.strictEqual(seenA[2].bid, 101);
  assert.strictEqual(seenA[2].bidQty, 8);
  assert.strictEqual(seenA[2].ask, undefined);

  const seenEth = [];
  const stopEth = feed.subscribe('ETH', (quote) => seenEth.push(quote), 0);
  assert.strictEqual(FakeWebSocket.instances.length, 1, 'BTC and ETH should share the same multiplexed websocket');
  assert.strictEqual(feed.activeStreamCount(), 1);
  assert.strictEqual(feed.activeSocketCount(), 1);
  assert.strictEqual(feed.activeSymbolCount(), 2);
  assert.deepStrictEqual(sent(ws), [
    { symbol: 'BTC', unsubscribe: 0 },
    { symbol: 'ETH', unsubscribe: 0 },
  ]);

  ws.emit('message', Buffer.from(book('ETH', 20, 21, 5, 6)));
  assert.strictEqual(seenEth.length, 1);
  assert.strictEqual(seenEth[0].symbol, 'ETH');
  assert.strictEqual(feed.getSnapshot('ETH').askQty, 6);

  stopA();
  assert.strictEqual(feed.subscriberCount('BTC'), 1, 'unsubscribing one subscriber should keep BTC subscribed');
  assert.strictEqual(ws.closed, false);
  assert.deepStrictEqual(sent(ws).filter((x) => x.symbol === 'BTC'), [{ symbol: 'BTC', unsubscribe: 0 }]);

  stopB();
  assert.strictEqual(feed.subscriberCount('BTC'), 0);
  assert.strictEqual(feed.activeSymbolCount(), 1, 'ETH should remain active after BTC leaves');
  assert.strictEqual(ws.closed, false, 'multiplexed websocket should stay open while ETH is active');
  assert.deepStrictEqual(sent(ws).filter((x) => x.symbol === 'BTC'), [
    { symbol: 'BTC', unsubscribe: 0 },
    { symbol: 'BTC', unsubscribe: 1 },
  ]);

  ws.emit('message', Buffer.from(book('BTC', 88, 89)));
  assert.strictEqual(seenA.length, 3, 'unsubscribed BTC must not be delivered');
  assert.strictEqual(seenB.length, 3, 'unsubscribed BTC must not be delivered');

  stopEth();
  assert.strictEqual(feed.subscriberCount(), 0);
  assert.strictEqual(feed.activeSymbolCount(), 0);
  assert.strictEqual(ws.closed, true, 'multiplexed websocket should close after final active symbol leaves');
  assert.deepStrictEqual(sent(ws).filter((x) => x.symbol === 'ETH'), [
    { symbol: 'ETH', unsubscribe: 0 },
    { symbol: 'ETH', unsubscribe: 1 },
  ]);
  assert.deepStrictEqual(warnings, []);

  FakeWebSocket.instances = [];
  const feedWithSnapshot = new PriceFeedService({
    url: 'ws://example.test/l2',
    idleCloseMs: 0,
    createWebSocket: (url) => new FakeWebSocket(url),
    onWarning: () => undefined,
  });
  const first = [];
  const stopFirst = feedWithSnapshot.subscribe('SOL', (quote) => first.push(quote), 0);
  const solWs = FakeWebSocket.instances[0];
  solWs.emit('open');
  solWs.emit('message', Buffer.from(book('SOL', 20, 21)));
  assert.strictEqual(first.length, 1);
  stopFirst();

  const replayed = [];
  const stopSecond = feedWithSnapshot.subscribe('SOL', (quote) => replayed.push(quote), 0);
  FakeWebSocket.instances[1].emit('open');
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(replayed.length, 1, 'new subscribers should receive the cached shared snapshot');
  assert.strictEqual(replayed[0].ask, 21);
  stopSecond();

  FakeWebSocket.instances = [];
  const feedReconnect = new PriceFeedService({
    url: 'ws://example.test/l2',
    idleCloseMs: 0,
    reconnectMs: 1,
    createWebSocket: (url) => new FakeWebSocket(url),
    onWarning: () => undefined,
  });
  const stopBtc = feedReconnect.subscribe('BTC', () => undefined, 0);
  const stopAda = feedReconnect.subscribe('ADA', () => undefined, 0);
  FakeWebSocket.instances[0].emit('open');
  FakeWebSocket.instances[0].emit('close');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.strictEqual(FakeWebSocket.instances.length, 2, 'active symbols should reconnect on one shared socket');
  FakeWebSocket.instances[1].emit('open');
  assert.deepStrictEqual(sent(FakeWebSocket.instances[1]), [
    { symbol: 'ADA', unsubscribe: 0 },
    { symbol: 'BTC', unsubscribe: 0 },
  ]);
  stopBtc();
  stopAda();


  FakeWebSocket.instances = [];
  const feedIdle = new PriceFeedService({
    url: 'ws://example.test/l2',
    idleCloseMs: 1000,
    createWebSocket: (url) => new FakeWebSocket(url),
    onWarning: () => undefined,
  });
  const stopIdle = feedIdle.subscribe('BNB', () => undefined, 0);
  const idleWs = FakeWebSocket.instances[0];
  idleWs.emit('open');
  stopIdle();
  assert.deepStrictEqual(sent(idleWs), [
    { symbol: 'BNB', unsubscribe: 0 },
    { symbol: 'BNB', unsubscribe: 1 },
  ], 'final symbol subscriber should unsubscribe immediately even when socket idle-close is delayed');
  assert.strictEqual(idleWs.closed, false, 'socket can stay open briefly with zero active symbol subscriptions');
  feedIdle.closeAll();

  FakeWebSocket.instances = [];
  const realNow = Date.now;
  let fakeNow = 1_000_000;
  Date.now = () => fakeNow;
  try {
    const feedStaleSnapshot = new PriceFeedService({
      url: 'ws://example.test/l2',
      idleCloseMs: 0,
      maxSnapshotAgeMs: 1000,
      createWebSocket: (url) => new FakeWebSocket(url),
      onWarning: () => undefined,
    });
    const firstStale = [];
    const stopStaleFirst = feedStaleSnapshot.subscribe('XLM', (quote) => firstStale.push(quote), 0);
    FakeWebSocket.instances[0].emit('open');
    FakeWebSocket.instances[0].emit('message', Buffer.from(book('XLM', 1, 2)));
    assert.strictEqual(firstStale.length, 1);
    stopStaleFirst();
    fakeNow += 2_000;
    const staleReplayed = [];
    const stopStaleSecond = feedStaleSnapshot.subscribe('XLM', (quote) => staleReplayed.push(quote), 0);
    FakeWebSocket.instances[1].emit('open');
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(staleReplayed.length, 0, 'stale cached snapshots must not be replayed to fresh trigger subscribers');
    stopStaleSecond();
  } finally {
    Date.now = realNow;
  }

  FakeWebSocket.instances = [];
  const feedBatch = new PriceFeedService({
    url: 'ws://example.test/l2',
    idleCloseMs: 0,
    createWebSocket: (url) => new FakeWebSocket(url),
    onWarning: () => undefined,
  });
  const batchBtc = [];
  const batchEth = [];
  const stopBatchBtc = feedBatch.subscribe('BTC', (quote) => batchBtc.push(quote), 0);
  const stopBatchEth = feedBatch.subscribe('ETH', (quote) => batchEth.push(quote), 0);
  const batchWs = FakeWebSocket.instances[0];
  batchWs.emit('open');
  batchWs.emit('message', Buffer.from(JSON.stringify([
    { s: 'BTC/USD', bids: [{ p: 50, q: 1 }], asks: [{ p: 51, q: 1 }] },
    { s: 'ETH', bids: [{ p: 60, q: 2 }], asks: [{ p: 61, q: 2 }] },
  ])));
  assert.strictEqual(batchBtc.length, 1, 'batched pair-symbol frames should route to the base ticker subscriber');
  assert.strictEqual(batchEth.length, 1, 'batched frames should route per symbol');
  assert.strictEqual(batchBtc[0].symbol, 'BTC');
  assert.strictEqual(batchBtc[0].ask, 51);
  assert.strictEqual(batchEth[0].ask, 61);
  batchWs.emit('message', Buffer.from(JSON.stringify({
    data: {
      BTCUSDT: { bids: [{ p: 52, q: 3 }], asks: [{ p: 53, q: 3 }] },
      ETH_USD: { bids: [{ p: 62, q: 4 }], asks: [{ p: 63, q: 4 }] },
    },
  })));
  assert.strictEqual(batchBtc.length, 2, 'symbol-keyed data maps should route to active base ticker subscribers');
  assert.strictEqual(batchEth.length, 2, 'symbol-keyed data maps should route ETH_USD to ETH subscribers');
  assert.strictEqual(batchBtc[1].ask, 53);
  assert.strictEqual(batchEth[1].ask, 63);
  stopBatchBtc();
  stopBatchEth();

  FakeWebSocket.instances = [];
  const feedBaseName = new PriceFeedService({
    url: 'ws://example.test/l2',
    idleCloseMs: 0,
    createWebSocket: (url) => new FakeWebSocket(url),
    onWarning: () => undefined,
  });
  const steth = [];
  const stopSteth = feedBaseName.subscribe('STETH', (quote) => steth.push(quote), 0);
  FakeWebSocket.instances[0].emit('open');
  FakeWebSocket.instances[0].emit('message', Buffer.from(JSON.stringify({ s: 'STETH', bids: [{ p: 9, q: 1 }], asks: [{ p: 10, q: 1 }] })));
  assert.strictEqual(steth.length, 1, 'base symbols ending in ETH must not be stripped as ETH-quoted pairs');
  stopSteth();

  const missingWarnings = [];
  const previousUrl = process.env.LIQUIDITY_WS_URL;
  delete process.env.LIQUIDITY_WS_URL;
  let lateUrl;
  FakeWebSocket.instances = [];
  const feedWithoutUrl = new PriceFeedService({
    url: () => lateUrl,
    idleCloseMs: 0,
    createWebSocket: (url) => new FakeWebSocket(url),
    onWarning: (message) => missingWarnings.push(message),
  });
  const stopMissing = feedWithoutUrl.subscribe('XRP', () => undefined, 0);
  assert.strictEqual(FakeWebSocket.instances.length, 0, 'missing LIQUIDITY_WS_URL should not create a socket');
  assert.strictEqual(missingWarnings.length, 1, 'missing LIQUIDITY_WS_URL should warn once instead of crashing');
  lateUrl = 'ws://example.test/l2';
  feedWithoutUrl.ensureActive();
  assert.strictEqual(FakeWebSocket.instances.length, 1, 'ensureActive should recover when the feed URL becomes available after subscription');
  FakeWebSocket.instances[0].emit('open');
  assert.deepStrictEqual(sent(FakeWebSocket.instances[0]), [{ symbol: 'XRP', unsubscribe: 0 }]);
  stopMissing();
  if (previousUrl !== undefined) process.env.LIQUIDITY_WS_URL = previousUrl;

  console.log('price-feed multiplexed active-symbol tests passed');
})();
