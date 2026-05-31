const assert = require('node:assert');
const Module = require('node:module');
const posts = [];
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'axios') {
    return {
      get: async () => ({ data: {} }),
      post: async (url, body) => {
        posts.push({ url, body });
        return { data: { orderId: 'mock-order', clientOrderId: body && body.clientOrderId } };
      },
    };
  }
  return originalLoad.apply(this, arguments);
};
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BotService } = require('../dist/bot.service');
const { PositionStore } = require('../dist/triggers/position-store');

function tmp(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-payload-test-'));
  return path.join(d, name);
}

const triggerBackedOrder = {
  symbol: 'BTC',
  side: 'SELL',
  type: 'LIMIT',
  quantity: 0.25,
  price: 123,
  paymentCurrency: 'USD',
  reduceOnly: true,
  clientOrderId: 'local-client-id',
  triggerId: 'local-trigger-id',
  meta: { localOnly: true },
};

function assertQuoteTradePayload(body, options = {}) {
  const expected = {
    liquidityOrder: 1,
    symbol: 'BTC',
    side: 'SEL',
    type: 'LIMIT',
    quantity: 0.25,
    paymentCurrency: 'USD',
    timestamp: body.timestamp,
    stake: 0,
    stakeOption: 0,
    price: 123,
  };
  if (!options.withChannel) { expected.account = undefined; expected.disableLeverage = undefined; }
  if (options.withChannel) expected.channel = 'LIQUIDITY';
  assert.deepStrictEqual(body, expected);
  assert.strictEqual('triggerId' in body, false);
  assert.strictEqual('meta' in body, false);
  assert.strictEqual('reduceOnly' in body, false);
  assert.strictEqual('clientOrderId' in body, false);
}

(async () => {
  const oldMode = process.env.MODE;
  const service = () => new BotService(new PositionStore(tmp('positions.json')));

  process.env.MODE = 'paper';
  assertQuoteTradePayload((await service().submitOrder(triggerBackedOrder)).raw);

  process.env.MODE = 'real';
  await service().submitOrder(triggerBackedOrder);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].url, '/order');
  assertQuoteTradePayload(posts[0].body, { withChannel: true });

  process.env.MODE = oldMode;
  console.log('order-payload tests passed');
})();
