const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const posts = [];
const gets = [];
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'axios') {
    return {
      post: async (url, body, options) => {
        posts.push({ url, body, headers: options && options.headers });
        return { data: { orderId: `mock-${posts.length}` } };
      },
      get: async (url, options) => {
        gets.push({ url, headers: options && options.headers });
        return { data: { positions: [{ symbol: 'ETH', positionAmt: 2, availableQuantity: 2, markPrice: 100 }] } };
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

process.env.MODE = 'real';
process.env.TRADE_API_KEY = 'GLOBAL_KEY_SHOULD_NOT_BE_USED';
process.env.TRADE_API_SECRET = 'GLOBAL_SECRET_SHOULD_NOT_BE_USED';
process.env.TELEGRAM_SESSION_ENCRYPTION_KEY = 'test-only-session-encryption-key';
process.env.QUOTE_TRADE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-account-isolation-'));

const { TradingSessionStore } = require('../dist/sessions/trading-session-store');
const { userStateFile, safeOwnerKey } = require('../dist/sessions/user-state');
const { TriggerStore } = require('../dist/triggers/trigger-store');
const { PositionStore } = require('../dist/triggers/position-store');
const { TriggerEngine } = require('../dist/triggers/trigger-engine');
const { BotService } = require('../dist/bot.service');
const { LlmDraftStore, LlmConfigStore } = require('../dist/llm');

function l2(symbol, bid, ask, qty = 10) {
  return { symbol, bid, ask, bidQty: qty, askQty: qty, orderBook: { bids: [{ p: bid, q: qty }], asks: [{ p: ask, q: qty }] } };
}

(async () => {
  const sessions = new TradingSessionStore();
  sessions.set('alice', { apiKey: 'ALICE_API_KEY', apiSecret: 'ALICE_SECRET' });
  sessions.set('bob', { apiKey: 'BOB_API_KEY', apiSecret: 'BOB_SECRET', account: 'bob-account' });

  assert.notStrictEqual(safeOwnerKey('alice'), safeOwnerKey('bob'));
  assert.notStrictEqual(userStateFile('alice', 'triggers.json'), userStateFile('bob', 'triggers.json'));

  const aliceSessionFile = fs.readFileSync(sessions.filePath('alice'), 'utf8');
  assert.strictEqual(aliceSessionFile.includes('ALICE_API_KEY'), false, 'api key must not be stored in plaintext');
  assert.strictEqual(aliceSessionFile.includes('ALICE_SECRET'), false, 'api secret must not be stored in plaintext');
  assert.strictEqual(sessions.get('alice').apiKey, 'ALICE_API_KEY');
  assert.strictEqual(sessions.get('bob').apiKey, 'BOB_API_KEY');

  const originalSessionKey = process.env.TELEGRAM_SESSION_ENCRYPTION_KEY;
  process.env.TELEGRAM_SESSION_ENCRYPTION_KEY = 'rotated-key-cannot-decrypt-existing-sessions';
  assert.strictEqual(sessions.get('alice'), undefined, 'rotated encryption key should make stored sessions unusable instead of throwing');
  assert.strictEqual(sessions.summary('alice').connected, false, 'unreadable sessions should not be treated as connected');
  assert.match(sessions.summary('alice').apiKey, /unreadable/);
  assert.throws(() => sessions.require('alice'), /No Quote\.Trade session connected/);
  process.env.TELEGRAM_SESSION_ENCRYPTION_KEY = originalSessionKey;
  assert.strictEqual(sessions.get('alice').apiKey, 'ALICE_API_KEY', 'restoring the encryption key should restore access');

  const aliceTriggers = new TriggerStore(userStateFile('alice', 'triggers.json'));
  const bobTriggers = new TriggerStore(userStateFile('bob', 'triggers.json'));
  const alicePositions = new PositionStore(userStateFile('alice', 'positions.json'));
  const bobPositions = new PositionStore(userStateFile('bob', 'positions.json'));
  const aliceLlmDrafts = new LlmDraftStore(userStateFile('alice', 'llm-drafts.json'));
  const bobLlmDrafts = new LlmDraftStore(userStateFile('bob', 'llm-drafts.json'));
  const aliceLlmConfig = new LlmConfigStore(userStateFile('alice', 'llm-config.json'));
  const bobLlmConfig = new LlmConfigStore(userStateFile('bob', 'llm-config.json'));

  const t = aliceTriggers.add({ ownerId: 'alice', kind: 'LIMIT', symbol: 'BTC', side: 'BUY', triggerPrice: 100, quantity: 1 });
  assert.strictEqual(bobTriggers.get(t.id), undefined, 'bob must not be able to load alice trigger id from his store');
  assert.strictEqual(bobTriggers.cancel(t.id), undefined, 'bob must not be able to cancel alice trigger id from his store');

  alicePositions.upsert({ symbol: 'BTC', positionAmt: 1, availableQuantity: 1, markPrice: 100 });
  bobPositions.upsert({ symbol: 'BTC', positionAmt: -3, availableQuantity: -3, markPrice: 100 });
  assert.strictEqual(alicePositions.getCloseSide('BTC'), 'SELL');
  assert.strictEqual(bobPositions.getCloseSide('BTC'), 'BUY');
  assert.strictEqual(alicePositions.getCloseQuantity('BTC'), 1);
  assert.strictEqual(bobPositions.getCloseQuantity('BTC'), 3);

  const aliceDraft = aliceLlmDrafts.add({ ownerId: 'alice', prompt: 'x', provider: 'ovhcloud', model: 'm', format: 'telegram', summary: 's', commands: ['/limit BTC BUY 100 1'], riskNotes: [] });
  assert.strictEqual(bobLlmDrafts.get(aliceDraft.id, 'bob'), undefined, 'bob must not load alice LLM drafts');
  aliceLlmConfig.setConnection({ ownerId: 'alice', provider: 'openai', model: 'alice-model', apiKey: 'ALICE_LLM_KEY' });
  const aliceLlmConfigFile = fs.readFileSync(userStateFile('alice', 'llm-config.json'), 'utf8');
  assert.strictEqual(aliceLlmConfigFile.includes('ALICE_LLM_KEY'), false, 'stored LLM API key must not be plaintext');
  assert.strictEqual(aliceLlmConfig.resolvePlanConnections('alice', 'openai', false)[0].effectiveApiKey, 'ALICE_LLM_KEY');
  process.env.ALICE_OPENAI_ENV = 'ALICE_ENV_LLM_KEY';
  aliceLlmConfig.setConnection({ ownerId: 'alice', provider: 'openai', model: 'alice-model', apiKeyEnv: 'ALICE_OPENAI_ENV' });
  assert.strictEqual(aliceLlmConfig.resolvePlanConnections('alice', 'openai', false)[0].effectiveApiKey, 'ALICE_ENV_LLM_KEY', 'env config should replace a previously stored inline LLM key');
  assert.strictEqual(fs.readFileSync(userStateFile('alice', 'llm-config.json'), 'utf8').includes('ALICE_LLM_KEY'), false);
  assert.strictEqual(bobLlmConfig.listRows('bob').some((row) => row.model === 'alice-model'), false, 'bob must not list alice LLM config');

  const fakeExecutorOrders = [];
  const engine = new TriggerEngine(aliceTriggers, alicePositions, { submitOrder: async (req) => { fakeExecutorOrders.push(req); return {}; } });
  await engine.processTick(l2('BTC', 99, 100));
  assert.strictEqual(fakeExecutorOrders[0].ownerId, 'alice', 'trigger engine must pass ownerId into submitOrder');

  const charlieService = new BotService(new PositionStore(userStateFile('charlie', 'positions.json')), sessions, 'charlie');
  await assert.rejects(() => charlieService.submitOrder({ ownerId: 'charlie', symbol: 'BTC', side: 'BUY', type: 'LIMIT', quantity: 1, price: 1 }), /No Quote\.Trade session connected/);

  const aliceService = new BotService(alicePositions, sessions, 'alice');
  await aliceService.submitOrder({ ownerId: 'alice', symbol: 'BTC', side: 'SELL', type: 'LIMIT', quantity: 1, price: 101, paymentCurrency: 'USD' });
  const bobService = new BotService(bobPositions, sessions, 'bob');
  await bobService.submitOrder({ ownerId: 'bob', symbol: 'BTC', side: 'BUY', type: 'LIMIT', quantity: 2, price: 99, paymentCurrency: 'USD' });

  assert.strictEqual(posts.length, 2);
  assert.strictEqual(posts[0].headers['X-Mbx-Apikey'], 'ALICE_API_KEY');
  assert.strictEqual(posts[1].headers['X-Mbx-Apikey'], 'BOB_API_KEY');
  assert.strictEqual(posts[1].body.account, 'bob-account', 'session account should default onto real orders for that user');
  assert.notStrictEqual(posts[0].headers.signature, posts[1].headers.signature);
  for (const post of posts) {
    const serialized = JSON.stringify(post.body);
    assert.strictEqual(serialized.includes('ownerId'), false, 'ownerId is local-only');
    assert.strictEqual(serialized.includes('ALICE'), false, 'alice secrets must not enter order body');
    assert.strictEqual(serialized.includes('BOB'), false, 'bob secrets must not enter order body');
    assert.strictEqual(post.headers['X-Mbx-Apikey'].includes('GLOBAL'), false, 'global env api key must not be used for session-backed order');
  }

  await bobService.refreshPositions('bob');
  assert.strictEqual(gets[0].headers['X-Mbx-Apikey'], 'BOB_API_KEY');
  assert.strictEqual(bobPositions.get('ETH').netQty, 2);
  assert.strictEqual(alicePositions.get('ETH'), undefined, 'bob position refresh must not update alice position store');

  assert.deepStrictEqual(sessions.listOwnerIds(), ['alice', 'bob']);
  console.log('session-isolation audit checks passed');
})();
