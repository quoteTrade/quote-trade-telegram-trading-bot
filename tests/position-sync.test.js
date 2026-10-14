"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { tempFile, cleanupTempDirs } = require("./helpers/tmp");
const { PositionStore } = require("../dist/triggers/position-store");
const { PositionSyncService } = require("../dist/triggers/position-sync");

after(cleanupTempDirs);

/** A position store backed by its own throwaway file, so cases stay independent. */
function makeStore() {
  return new PositionStore(tempFile("positions.json", "qt-tg-position-sync-"));
}

/** Minimal account client: every `get` resolves to the same positions payload. */
function accountClient(positions) {
  return { get: async () => ({ positions }) };
}

const BTC = { symbol: "BTC", positionAmt: 1, availableQuantity: 1, markPrice: 100 };
const ETH = { symbol: "ETH", positionAmt: 2, availableQuantity: 2, markPrice: 50 };

describe("PositionSyncService.refresh", () => {
  it("reports zero synced positions when the account holds none", async () => {
    const store = makeStore();
    store.upsert({ ...BTC });

    const count = await new PositionSyncService(accountClient([]), store).refresh();

    assert.equal(count, 0);
  });

  it("clears stale cached positions when the account reports none", async () => {
    const store = makeStore();
    store.upsert({ ...BTC });

    await new PositionSyncService(accountClient([]), store).refresh();

    assert.equal(store.get("BTC"), undefined, "authoritative empty position refresh must clear stale cached positions");
  });

  it("treats an account-update envelope with no positions as an empty authoritative refresh", async () => {
    const store = makeStore();
    store.upsert({ ...BTC });
    const client = { get: async () => ({ e: "ACCOUNT_UPDATE", E: 1, T: 1, a: { m: "ORDER", B: [] } }) };

    const count = await new PositionSyncService(client, store).refresh();

    assert.equal(count, 0);
    assert.equal(store.get("BTC"), undefined, "ACCOUNT_UPDATE without positions must clear stale cached positions");
  });

  it("reports the number of positions returned by the account", async () => {
    const store = makeStore();

    const count = await new PositionSyncService(accountClient([{ ...ETH }]), store).refresh();

    assert.equal(count, 1);
  });

  it("caches each position returned by the account with its net quantity", async () => {
    const store = makeStore();

    await new PositionSyncService(accountClient([{ ...ETH }]), store).refresh();

    assert.equal(store.get("ETH").netQty, 2);
  });

  it("drops a cached symbol that is absent from the account response", async () => {
    const store = makeStore();
    store.upsert({ ...BTC });

    await new PositionSyncService(accountClient([{ ...ETH }]), store).refresh();

    assert.equal(
      store.get("BTC"),
      undefined,
      "authoritative refresh should replace stale symbols not present in the account response",
    );
  });
});
