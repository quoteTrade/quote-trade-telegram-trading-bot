const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PositionStore } = require('../dist/triggers/position-store');
const { PositionSyncService } = require('../dist/triggers/position-sync');

function tmp(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-position-sync-test-'));
  return path.join(d, name);
}

(async () => {
  const store = new PositionStore(tmp('positions.json'));
  store.upsert({ symbol: 'BTC', positionAmt: 1, availableQuantity: 1, markPrice: 100 });
  assert.strictEqual(store.get('BTC').netQty, 1);

  const emptySync = new PositionSyncService({ get: async () => ({ positions: [] }) }, store);
  const emptyCount = await emptySync.refresh();
  assert.strictEqual(emptyCount, 0);
  assert.strictEqual(store.get('BTC'), undefined, 'authoritative empty position refresh must clear stale cached positions');

  const replaceSync = new PositionSyncService({ get: async () => ({ positions: [{ symbol: 'ETH', positionAmt: 2, availableQuantity: 2, markPrice: 50 }] }) }, store);
  const count = await replaceSync.refresh();
  assert.strictEqual(count, 1);
  assert.strictEqual(store.get('ETH').netQty, 2);
  assert.strictEqual(store.get('BTC'), undefined, 'authoritative refresh should replace stale symbols not present in the account response');

  console.log('position-sync tests passed');
})();
