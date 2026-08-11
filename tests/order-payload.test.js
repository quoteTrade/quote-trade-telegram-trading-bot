"use strict";

const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");

const { stubRequire } = require("./helpers/module-stub");
const { tempFile, cleanupTempDirs } = require("./helpers/tmp");

/** Every request the fake axios saw, newest last. Reset before each case. */
const posts = [];

/**
 * Stands in for `axios`. Records the outbound POST instead of reaching the
 * exchange, and answers with the response shape a filled order returns.
 */
const axiosStub = {
  get: async () => ({ data: {} }),
  post: async (url, body) => {
    posts.push({ url, body });
    return { data: { orderId: "mock-order", clientOrderId: body?.clientOrderId } };
  },
};

// Must run before anything from `../dist/` is required: the HTTP service does
// `const axios = require('axios')` once, at module load time.
const restoreRequire = stubRequire({ axios: axiosStub });

const { BotService } = require("../dist/bot.service");
const { PositionStore } = require("../dist/triggers/position-store");

/** A service backed by its own throwaway position file, so cases stay independent. */
function makeService() {
  return new BotService(new PositionStore(tempFile("positions.json", "qt-payload-test-")));
}

/**
 * An order as the trigger engine hands it over: exchange fields plus local-only
 * bookkeeping (`clientOrderId`, `triggerId`, `meta`, `reduceOnly`) that exists
 * only inside this process and must never be forwarded.
 */
function triggerBackedOrder() {
  return {
    symbol: "BTC",
    side: "SELL",
    type: "LIMIT",
    quantity: 0.25,
    price: 123,
    paymentCurrency: "USD",
    reduceOnly: true,
    clientOrderId: "local-client-id",
    triggerId: "local-trigger-id",
    meta: { localOnly: true },
  };
}

/**
 * The exact wire payload `triggerBackedOrder()` must translate into.
 *
 * `withChannel` selects the real-mode shape: the HTTP service tags the request
 * with `channel: 'LIQUIDITY'`, and the JSON round-trip it performs drops the
 * undefined-valued `account`/`disableLeverage` keys that the paper payload
 * still carries. `timestamp` is read back off the body because it is `Date.now()`.
 */
function assertQuoteTradePayload(body, options = {}) {
  const expected = {
    liquidityOrder: 1,
    symbol: "BTC",
    side: "SEL",
    type: "LIMIT",
    quantity: 0.25,
    paymentCurrency: "USD",
    timestamp: body.timestamp,
    stake: 0,
    stakeOption: 0,
    price: 123,
  };
  if (!options.withChannel) {
    expected.account = undefined;
    expected.disableLeverage = undefined;
  }
  if (options.withChannel) expected.channel = "LIQUIDITY";
  assert.deepStrictEqual(body, expected);
}

/**
 * The security-relevant guarantee: local-only bookkeeping never leaves the
 * process.
 *
 * Takes the submitted order as well as the wire body, and asserts each field
 * was actually PRESENT on the input first. Without that precondition the
 * `'x' in body === false` checks are vacuous — they would pass just as happily
 * against a fixture that never carried the field, defending nothing.
 *
 * Presence is checked with `in`, not by value, so an `undefined` leak fails too.
 */
function assertLocalOnlyFieldsStripped(submitted, body) {
  for (const field of ["triggerId", "meta", "reduceOnly", "clientOrderId"]) {
    assert.equal(field in submitted, true, `fixture must carry ${field} for the strip check to mean anything`);
    assert.equal(field in body, false);
  }
}

describe("submitOrder wire payload", () => {
  let oldMode;

  before(() => {
    oldMode = process.env.MODE;
  });

  beforeEach(() => {
    posts.length = 0;
  });

  after(() => {
    if (oldMode === undefined) delete process.env.MODE;
    else process.env.MODE = oldMode;
    cleanupTempDirs();
    restoreRequire();
  });

  describe("paper mode", () => {
    beforeEach(() => {
      process.env.MODE = "paper";
    });

    it("returns the payload it would have sent to the exchange", async () => {
      const result = await makeService().submitOrder(triggerBackedOrder());
      assertQuoteTradePayload(result.raw);
    });

    it("does not send anything to the exchange", async () => {
      const result = await makeService().submitOrder(triggerBackedOrder());
      // `paper: true` is returned only by the paper branch, so this pins down
      // that the order really was processed and deliberately withheld. Without
      // it, `posts.length === 0` would also pass if submitOrder had done nothing.
      assert.equal(result.paper, true);
      assert.equal(posts.length, 0);
    });

    it("strips local-only bookkeeping fields from the payload", async () => {
      const submitted = triggerBackedOrder();
      const result = await makeService().submitOrder(submitted);
      assertLocalOnlyFieldsStripped(submitted, result.raw);
    });
  });

  describe("real mode", () => {
    beforeEach(() => {
      process.env.MODE = "real";
    });

    it("posts the order exactly once, to /order", async () => {
      await makeService().submitOrder(triggerBackedOrder());
      assert.equal(posts.length, 1);
      assert.equal(posts[0].url, "/order");
    });

    it("sends the exchange the LIQUIDITY-channel payload", async () => {
      await makeService().submitOrder(triggerBackedOrder());
      assertQuoteTradePayload(posts[0].body, { withChannel: true });
    });

    it("strips local-only bookkeeping fields from the posted payload", async () => {
      const submitted = triggerBackedOrder();
      await makeService().submitOrder(submitted);
      assert.equal(posts.length, 1, "nothing was posted, so the strip check would be vacuous");
      assertLocalOnlyFieldsStripped(submitted, posts[0].body);
    });
  });
});
