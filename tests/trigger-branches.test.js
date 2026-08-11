"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTempDir, tempFile, cleanupTempDirs } = require("./helpers/tmp");
const {
  assertNonNegativeNumber,
  assertPercentage,
  assertPositiveNumber,
  bookSideForOrder,
  deriveTriggerDirection,
  distanceFromMode,
  formatUsd,
  makeGroupId,
  makeTriggerId,
  normalizeAmountMode,
  normalizeSide,
  normalizeSymbol,
  normalizeTriggerSource,
  oppositeSide,
  orderPriceForTrigger,
  orderTypeForTrigger,
  parseAmountOrPercent,
  parseDurationMs,
  parseTimeOrDuration,
  priceTargetForTrigger,
  selectL2SideQuote,
  shouldTrigger,
  sideToClosePosition,
  toQuoteTradeSide,
  unrealizedPnlUsd,
} = require("../dist/triggers/types");
const { PositionStore, normalizePosition } = require("../dist/triggers/position-store");
const { TriggerStore } = require("../dist/triggers/trigger-store");
const { TriggerEngine } = require("../dist/triggers/trigger-engine");

after(cleanupTempDirs);

/** Path for a store file inside a fresh temp dir, so cases never share state. */
function storePath(name) {
  return tempFile(name, "qt-tg-trigger-branch-");
}

/** Write `contents` (JSON, or raw text for the malformed cases) to a fresh store file. */
function seedFile(name, contents) {
  const file = storePath(name);
  fs.writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return file;
}

/** Run `body` with QUOTE_TRADE_STATE_DIR pointed at a fresh temp dir, then restore the env. */
function withStateDir(body) {
  const dir = makeTempDir("qt-tg-trigger-state-");
  const had = Object.hasOwn(process.env, "QUOTE_TRADE_STATE_DIR");
  const previous = process.env.QUOTE_TRADE_STATE_DIR;
  process.env.QUOTE_TRADE_STATE_DIR = dir;
  try {
    return body(dir);
  } finally {
    if (had) process.env.QUOTE_TRADE_STATE_DIR = previous;
    else delete process.env.QUOTE_TRADE_STATE_DIR;
  }
}

/** Order executor that only records what the engine asked it to submit. */
class FakeExecutor {
  constructor() {
    this.orders = [];
  }
  async submitOrder(req) {
    this.orders.push(req);
    return { clientOrderId: req.clientOrderId, orderId: `order-${this.orders.length}` };
  }
}

/** Executor that rejects its first `failures` submissions with `thrown`, then behaves. */
class FlakyExecutor {
  constructor(failures = 1, thrown = new Error("exchange rejected order")) {
    this.orders = [];
    this.failures = failures;
    this.thrown = thrown;
  }
  async submitOrder(req) {
    this.orders.push(req);
    if (this.orders.length <= this.failures) throw this.thrown;
    return { clientOrderId: req.clientOrderId, orderId: `order-${this.orders.length}` };
  }
}

/** Engine plus its stores, a recording executor and captured callback traffic. */
function rig(options = {}, executor = new FakeExecutor()) {
  const store = new TriggerStore(storePath("triggers.json"));
  const positions = new PositionStore(storePath("positions.json"));
  const events = { rejects: [], errors: [], actions: [], fired: [] };
  const engine = new TriggerEngine(store, positions, executor, {
    onReject: (trigger, reason) => events.rejects.push({ id: trigger.id, reason }),
    onError: (trigger, error) => events.errors.push({ id: trigger.id, message: error?.message ?? String(error) }),
    onAction: (trigger, message) => events.actions.push({ id: trigger.id, message }),
    onTrigger: (trigger) => events.fired.push(trigger.id),
    ...options,
  });
  return { store, positions, executor, engine, events };
}

/** Market tick with a one-level book quoting the same price on both sides. */
function l2(symbol, price, qty = 1000) {
  return {
    symbol,
    price,
    bid: price,
    ask: price,
    bidQty: qty,
    askQty: qty,
    orderBook: { s: symbol, bids: [{ p: price, q: qty }], asks: [{ p: price, q: qty }] },
  };
}

/** Trigger-shaped object for the pure helpers, which only read the fields they need. */
function triggerLike(overrides) {
  return {
    id: "t",
    ownerId: "default",
    symbol: "BTC",
    status: "ACTIVE",
    closePosition: false,
    reduceOnly: false,
    paymentCurrency: "USD",
    createdAt: 1,
    updatedAt: 1,
    triggerSource: "side",
    ...overrides,
  };
}

describe("Symbol and side normalisation", () => {
  it("trims and upper-cases a symbol and refuses a blank one", () => {
    assert.strictEqual(normalizeSymbol(" btc "), "BTC");
    assert.strictEqual(normalizeSymbol("Eth"), "ETH");
    for (const blank of ["", "   ", null, undefined]) {
      assert.throws(() => normalizeSymbol(blank), { message: "symbol is required" });
    }
  });

  it("accepts every accepted spelling of a side and names the offender when rejecting", () => {
    for (const buy of ["BUY", "buy", " Bid ", "1"]) assert.strictEqual(normalizeSide(buy), "BUY");
    for (const sell of ["SELL", "sell", "SEL", " ask ", "2"]) assert.strictEqual(normalizeSide(sell), "SELL");
    assert.throws(() => normalizeSide("LONG"), { message: "side must be BUY or SELL, got: LONG" });
    assert.throws(() => normalizeSide(""), { message: "side must be BUY or SELL, got: " });
    assert.throws(() => normalizeSide(undefined), { message: "side must be BUY or SELL, got: undefined" });
  });

  it("sends SELL to the exchange as SEL and leaves BUY alone", () => {
    assert.strictEqual(toQuoteTradeSide("SELL"), "SEL");
    assert.strictEqual(toQuoteTradeSide("BUY"), "BUY");
  });

  it("flips a side", () => {
    assert.strictEqual(oppositeSide("BUY"), "SELL");
    assert.strictEqual(oppositeSide("SELL"), "BUY");
  });

  it("reports the price source as side-based whatever a persisted trigger asked for", () => {
    assert.strictEqual(normalizeTriggerSource(), "side");
    assert.strictEqual(normalizeTriggerSource("mid"), "side");
    assert.strictEqual(normalizeTriggerSource("last"), "side");
  });
});

describe("Numeric assertions", () => {
  it("parses numeric strings as positive numbers and rejects zero, negatives and nonsense", () => {
    assert.strictEqual(assertPositiveNumber(2.5, "quantity"), 2.5);
    assert.strictEqual(assertPositiveNumber("2.5", "quantity"), 2.5);
    for (const bad of [0, -1, "-1", "abc", "", NaN, Infinity, undefined, null]) {
      assert.throws(() => assertPositiveNumber(bad, "quantity"), { message: "quantity must be a positive number" });
    }
  });

  it("allows zero as a non-negative number but still rejects negatives and nonsense", () => {
    assert.strictEqual(assertNonNegativeNumber(0, "limitOffset"), 0);
    assert.strictEqual(assertNonNegativeNumber("1.5", "limitOffset"), 1.5);
    for (const bad of [-0.1, "-2", "abc", Infinity, undefined]) {
      assert.throws(() => assertNonNegativeNumber(bad, "limitOffset"), {
        message: "limitOffset must be zero or a positive number",
      });
    }
  });

  it("caps a percentage at one hundred and still refuses zero", () => {
    assert.strictEqual(assertPercentage(100, "closePercentage"), 100);
    assert.strictEqual(assertPercentage("0.5", "closePercentage"), 0.5);
    assert.throws(() => assertPercentage(100.1, "closePercentage"), { message: "closePercentage must be <= 100" });
    assert.throws(() => assertPercentage(0, "closePercentage"), {
      message: "closePercentage must be a positive number",
    });
  });
});

describe("Id minting", () => {
  it("mints unique trigger and group ids under the requested prefix", () => {
    assert.match(makeTriggerId(), /^trg_[0-9a-z]+_[0-9a-z]{1,6}$/);
    assert.match(makeTriggerId("bracket"), /^bracket_[0-9a-z]+_[0-9a-z]{1,6}$/);
    assert.match(makeGroupId(), /^grp_[0-9a-z]+_[0-9a-z]{1,6}$/);
    assert.match(makeGroupId("oco"), /^oco_[0-9a-z]+_[0-9a-z]{1,6}$/);

    const minted = new Set();
    for (let i = 0; i < 200; i += 1) minted.add(makeGroupId("oco"));
    assert.strictEqual(minted.size, 200, "group ids must not collide inside one millisecond");
  });
});

describe("Amount and percent parsing", () => {
  it("normalises an amount mode and rejects anything that is neither", () => {
    assert.strictEqual(normalizeAmountMode(), "AMOUNT");
    assert.strictEqual(normalizeAmountMode(" amount "), "AMOUNT");
    assert.strictEqual(normalizeAmountMode("percent"), "PERCENT");
    for (const bad of ["RATIO", "", "PERCENTAGE"]) {
      assert.throws(() => normalizeAmountMode(bad), { message: "amount mode must be AMOUNT or PERCENT" });
    }
  });

  it("reads a trailing percent sign as PERCENT and a bare number as AMOUNT", () => {
    assert.deepStrictEqual(parseAmountOrPercent("25%"), { mode: "PERCENT", value: 25 });
    assert.deepStrictEqual(parseAmountOrPercent("100%"), { mode: "PERCENT", value: 100 });
    assert.deepStrictEqual(parseAmountOrPercent(" 0.5 "), { mode: "AMOUNT", value: 0.5 });
    assert.deepStrictEqual(parseAmountOrPercent("12"), { mode: "AMOUNT", value: 12 });
  });

  it("rejects a missing amount, an out-of-range percent and a non-positive amount", () => {
    for (const blank of ["", "   ", undefined, null]) {
      assert.throws(() => parseAmountOrPercent(blank), { message: "amount is required" });
    }
    assert.throws(() => parseAmountOrPercent("150%"), { message: "percent must be <= 100" });
    assert.throws(() => parseAmountOrPercent("0%"), { message: "percent must be a positive number" });
    assert.throws(() => parseAmountOrPercent("%"), { message: "percent must be a positive number" });
    assert.throws(() => parseAmountOrPercent("-3"), { message: "amount must be a positive number" });
    assert.throws(() => parseAmountOrPercent("later"), { message: "amount must be a positive number" });
  });

  it("measures a distance absolutely or as a share of the reference and treats nonsense as no distance", () => {
    assert.strictEqual(distanceFromMode(200, "PERCENT", 10), 20);
    assert.strictEqual(distanceFromMode(200, "AMOUNT", 5), 5);
    assert.strictEqual(distanceFromMode(200, undefined, 5), 5, "the default mode is absolute");
    assert.strictEqual(distanceFromMode(200), 0, "no configured distance means no distance");
    assert.strictEqual(distanceFromMode(0, "PERCENT", 10), 0, "a zero reference price cannot be scaled");
    assert.strictEqual(distanceFromMode(-1, "AMOUNT", 5), 0);
    assert.strictEqual(distanceFromMode(Number.NaN, "AMOUNT", 5), 0);
    assert.strictEqual(distanceFromMode(200, "AMOUNT", -5), 0);
    assert.strictEqual(distanceFromMode(200, "AMOUNT", "oops"), 0);
  });
});

describe("Duration and time parsing", () => {
  it("converts every supported duration unit to milliseconds", () => {
    assert.strictEqual(parseDurationMs("500ms"), 500);
    assert.strictEqual(parseDurationMs("30s"), 30_000);
    assert.strictEqual(parseDurationMs("15m"), 900_000);
    assert.strictEqual(parseDurationMs("4h"), 14_400_000);
    assert.strictEqual(parseDurationMs("1d"), 86_400_000);
    assert.strictEqual(parseDurationMs("1.5h"), 5_400_000);
    assert.strictEqual(parseDurationMs(" 2H "), 7_200_000, "a duration is trimmed and case-insensitive");
  });

  it("rejects a malformed duration and a zero-length one", () => {
    for (const bad of ["", "soon", "10", "5w", "-5m", "1 h", "m"]) {
      assert.throws(() => parseDurationMs(bad), { message: "duration must look like 30s, 15m, 4h, or 1d" });
    }
    assert.throws(() => parseDurationMs("0s"), { message: "duration must be a positive number" });
    assert.throws(() => parseDurationMs("0.0h"), { message: "duration must be a positive number" });
  });

  it("adds a duration to the reference instant", () => {
    assert.strictEqual(parseTimeOrDuration("30m", 1_000), 1_000 + 1_800_000);
    assert.strictEqual(parseTimeOrDuration(" 4H ", 1_000), 1_000 + 14_400_000);
    assert.strictEqual(parseTimeOrDuration("250ms", 1_000), 1_250);
  });

  it("accepts an absolute future timestamp", () => {
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    assert.strictEqual(parseTimeOrDuration("2030-01-01T00:01:00.000Z", now), now + 60_000);
    assert.strictEqual(parseTimeOrDuration("2031-06-30T12:00:00Z", now), Date.parse("2031-06-30T12:00:00Z"));
  });

  it("rejects an unparseable time and one that is not in the future", () => {
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    for (const bad of ["tomorrow", "", "   ", undefined]) {
      assert.throws(() => parseTimeOrDuration(bad, now), {
        message: "time must be an ISO date/time or a duration like 30m/4h/1d",
      });
    }
    assert.throws(() => parseTimeOrDuration("2029-12-31T23:59:59.000Z", now), {
      message: "time must be in the future",
    });
    assert.throws(() => parseTimeOrDuration("2030-01-01T00:00:00.000Z", now), {
      message: "time must be in the future",
    });
  });
});

describe("Close side and trigger direction", () => {
  it("closes a long with a SELL, a short with a BUY and a flat book with neither", () => {
    assert.strictEqual(sideToClosePosition(1.5), "SELL");
    assert.strictEqual(sideToClosePosition(-1.5), "BUY");
    assert.strictEqual(sideToClosePosition(0), undefined);
  });

  it("derives the arming direction of every price-driven kind from its side", () => {
    const expected = [
      ["LIMIT", "BELOW", "ABOVE"],
      ["STOP_LIMIT", "ABOVE", "BELOW"],
      ["TAKE_PROFIT", "BELOW", "ABOVE"],
      ["STOP_LOSS", "ABOVE", "BELOW"],
      ["TRAILING_STOP", "ABOVE", "BELOW"],
      ["TRAILING_STOP_LIMIT", "ABOVE", "BELOW"],
      ["BREAK_EVEN_STOP", "ABOVE", "BELOW"],
    ];
    for (const [kind, onBuy, onSell] of expected) {
      assert.strictEqual(deriveTriggerDirection({ kind, side: "BUY" }), onBuy, `${kind} BUY`);
      assert.strictEqual(deriveTriggerDirection({ kind, side: "SELL" }), onSell, `${kind} SELL`);
    }
  });

  it("derives a PRICE_BAND direction from its mode and treats a missing mode as a breakout", () => {
    assert.strictEqual(deriveTriggerDirection({ kind: "PRICE_BAND", side: "BUY", priceBandMode: "BREAKOUT" }), "ABOVE");
    assert.strictEqual(
      deriveTriggerDirection({ kind: "PRICE_BAND", side: "SELL", priceBandMode: "BREAKOUT" }),
      "BELOW",
    );
    assert.strictEqual(
      deriveTriggerDirection({ kind: "PRICE_BAND", side: "BUY", priceBandMode: "REVERSION" }),
      "BELOW",
    );
    assert.strictEqual(
      deriveTriggerDirection({ kind: "PRICE_BAND", side: "SELL", priceBandMode: "REVERSION" }),
      "ABOVE",
    );
    assert.strictEqual(deriveTriggerDirection({ kind: "PRICE_BAND", side: "BUY" }), "ABOVE");
  });

  it("gives the timer and risk kinds no price direction at all", () => {
    assert.strictEqual(
      deriveTriggerDirection({ kind: "LIMIT", side: "BUY" }),
      "BELOW",
      "control: a price kind does have a direction",
    );
    for (const kind of ["TIME_CLOSE", "TIME_CANCEL", "RISK_GUARD"]) {
      assert.strictEqual(deriveTriggerDirection({ kind, side: "BUY" }), undefined, kind);
    }
  });
});

describe("Price target selection", () => {
  it("prefers the trailed stop over the original trigger price, and falls back to it", () => {
    for (const kind of ["TRAILING_STOP", "TRAILING_STOP_LIMIT", "BREAK_EVEN_STOP"]) {
      assert.strictEqual(
        priceTargetForTrigger(triggerLike({ kind, side: "SELL", triggerPrice: 100, currentStopPrice: 95 })),
        95,
        kind,
      );
      assert.strictEqual(
        priceTargetForTrigger(triggerLike({ kind, side: "SELL", triggerPrice: 100 })),
        100,
        `${kind} without a stop yet`,
      );
    }
  });

  it("picks the band edge that matches the PRICE_BAND direction", () => {
    const band = (side, priceBandMode) =>
      triggerLike({ kind: "PRICE_BAND", side, priceBandMode, upperPrice: 110, lowerPrice: 90, triggerPrice: 105 });
    assert.strictEqual(priceTargetForTrigger(band("BUY", "BREAKOUT")), 110);
    assert.strictEqual(priceTargetForTrigger(band("SELL", "BREAKOUT")), 90);
    assert.strictEqual(priceTargetForTrigger(band("BUY", "REVERSION")), 90);
    assert.strictEqual(priceTargetForTrigger(band("SELL", "REVERSION")), 110);
    assert.strictEqual(
      priceTargetForTrigger(
        triggerLike({ kind: "PRICE_BAND", side: "BUY", priceBandMode: "BREAKOUT", triggerPrice: 105 }),
      ),
      105,
      "a band with no upper edge falls back to the trigger price",
    );
  });

  it("uses the plain trigger price for the remaining kinds", () => {
    assert.strictEqual(
      priceTargetForTrigger(triggerLike({ kind: "LIMIT", side: "BUY", triggerPrice: 100, currentStopPrice: 5 })),
      100,
    );
    assert.strictEqual(priceTargetForTrigger(triggerLike({ kind: "STOP_LOSS", side: "SELL", triggerPrice: 80 })), 80);
  });
});

describe("shouldTrigger guards", () => {
  const armedBuyLimit = (overrides) => triggerLike({ kind: "LIMIT", side: "BUY", triggerPrice: 100, ...overrides });

  it("never fires a trigger that has left the ACTIVE state", () => {
    assert.strictEqual(shouldTrigger(armedBuyLimit(), 100), true, "control: the ACTIVE trigger does match this price");
    for (const status of ["SUBMITTING", "TRIGGERED", "CANCELLED", "REJECTED"]) {
      assert.strictEqual(shouldTrigger(armedBuyLimit({ status }), 100), false, status);
    }
  });

  it("never fires on a price that is not a positive number", () => {
    assert.strictEqual(shouldTrigger(armedBuyLimit(), 99), true, "control: a real price below the trigger does match");
    for (const price of [0, -5, Number.NaN, Infinity * 0, undefined]) {
      assert.strictEqual(shouldTrigger(armedBuyLimit(), price), false, String(price));
    }
  });

  it("holds a BREAK_EVEN_STOP back until it has armed", () => {
    const disarmed = triggerLike({
      kind: "BREAK_EVEN_STOP",
      side: "SELL",
      currentStopPrice: 100,
      breakEvenArmed: false,
    });
    assert.strictEqual(shouldTrigger(disarmed, 100), false);
    assert.strictEqual(
      shouldTrigger({ ...disarmed, breakEvenArmed: true }, 100),
      true,
      "the same price fires once armed",
    );
  });

  it("never fires a kind with no direction or a target that is not positive", () => {
    assert.strictEqual(shouldTrigger(armedBuyLimit(), 100), true, "control: a well-formed trigger fires");
    assert.strictEqual(shouldTrigger(triggerLike({ kind: "TIME_CLOSE", side: "BUY", triggerPrice: 100 }), 100), false);
    assert.strictEqual(shouldTrigger(armedBuyLimit({ triggerPrice: 0 }), 100), false);
    assert.strictEqual(shouldTrigger(armedBuyLimit({ triggerPrice: undefined }), 100), false);
  });

  it("arms above for a stop and below for a limit at the exact target", () => {
    assert.strictEqual(shouldTrigger(triggerLike({ kind: "STOP_LOSS", side: "BUY", triggerPrice: 100 }), 100), true);
    assert.strictEqual(shouldTrigger(triggerLike({ kind: "STOP_LOSS", side: "BUY", triggerPrice: 100 }), 99.99), false);
    assert.strictEqual(shouldTrigger(armedBuyLimit(), 100.01), false);
  });
});

describe("Order price and order type", () => {
  it("prices a LIMIT from its trigger price and a STOP_LIMIT from its limit price", () => {
    assert.strictEqual(
      orderPriceForTrigger(triggerLike({ kind: "LIMIT", side: "BUY", triggerPrice: 100, limitPrice: 7 })),
      100,
    );
    assert.strictEqual(
      orderPriceForTrigger(triggerLike({ kind: "STOP_LIMIT", side: "BUY", triggerPrice: 100, limitPrice: 101 })),
      101,
    );
    assert.strictEqual(
      orderPriceForTrigger(triggerLike({ kind: "TAKE_PROFIT", side: "SELL", triggerPrice: 100, limitPrice: 99 })),
      99,
    );
    assert.strictEqual(
      orderPriceForTrigger(triggerLike({ kind: "TAKE_PROFIT", side: "SELL", triggerPrice: 100 })),
      undefined,
    );
  });

  it("offsets a trailing stop limit from the stop on each side and gives up with no stop at all", () => {
    const trail = (overrides) => triggerLike({ kind: "TRAILING_STOP_LIMIT", limitOffset: 0.5, ...overrides });
    assert.strictEqual(orderPriceForTrigger(trail({ side: "SELL", currentStopPrice: 100 })), 99.5);
    assert.strictEqual(orderPriceForTrigger(trail({ side: "BUY", currentStopPrice: 100 })), 100.5);
    assert.strictEqual(
      orderPriceForTrigger(trail({ side: "SELL", triggerPrice: 100, limitOffset: undefined })),
      100,
      "no offset means price at the stop",
    );
    assert.strictEqual(
      orderPriceForTrigger(trail({ side: "SELL" }), 50),
      49.5,
      "the market price is the last resort stop",
    );
    assert.strictEqual(orderPriceForTrigger(trail({ side: "SELL" })), undefined);
    assert.strictEqual(orderPriceForTrigger(trail({ side: "SELL", currentStopPrice: 0 })), undefined);
  });

  it("sends a MARKET order whenever no positive limit price can be resolved", () => {
    assert.strictEqual(orderTypeForTrigger(triggerLike({ kind: "LIMIT", side: "BUY", triggerPrice: 100 })), "LIMIT");
    assert.strictEqual(
      orderTypeForTrigger(triggerLike({ kind: "TAKE_PROFIT", side: "SELL", triggerPrice: 100 })),
      "MARKET",
    );
    assert.strictEqual(orderTypeForTrigger(triggerLike({ kind: "TRAILING_STOP_LIMIT", side: "SELL" })), "MARKET");
    assert.strictEqual(
      orderTypeForTrigger(triggerLike({ kind: "TRAILING_STOP_LIMIT", side: "SELL", currentStopPrice: 100 })),
      "LIMIT",
    );
  });
});

describe("L2 quote selection", () => {
  it("maps a BUY to the ask ladder and a SELL to the bid ladder", () => {
    assert.strictEqual(bookSideForOrder("BUY"), "ask");
    assert.strictEqual(bookSideForOrder("SELL"), "bid");
    const tick = { symbol: "BTC", orderBook: { asks: [{ p: 101, q: 5 }], bids: [{ p: 99, q: 5 }] } };
    assert.deepStrictEqual(selectL2SideQuote(tick, "BUY", 1), {
      bookSide: "ask",
      orderSide: "BUY",
      price: 101,
      availableQuantity: 5,
      requestedQuantity: 1,
      levelsConsumed: 1,
    });
    assert.deepStrictEqual(selectL2SideQuote(tick, "SELL", 1), {
      bookSide: "bid",
      orderSide: "SELL",
      price: 99,
      availableQuantity: 5,
      requestedQuantity: 1,
      levelsConsumed: 1,
    });
  });

  it("quotes top of book when the tick carries no ladder at all", () => {
    const tick = { symbol: "BTC", bid: 99, ask: 101, bidQty: 5, askQty: 4 };
    assert.deepStrictEqual(selectL2SideQuote(tick, "BUY", 3), {
      bookSide: "ask",
      orderSide: "BUY",
      price: 101,
      availableQuantity: 4,
      requestedQuantity: 3,
      levelsConsumed: 1,
    });
    assert.deepStrictEqual(selectL2SideQuote(tick, "SELL", 5), {
      bookSide: "bid",
      orderSide: "SELL",
      price: 99,
      availableQuantity: 5,
      requestedQuantity: 5,
      levelsConsumed: 1,
    });
    assert.strictEqual(selectL2SideQuote(tick, "BUY", 4.5), undefined, "top of book cannot cover more than it quotes");
  });

  it("reads the long-form quantity field names on a ladderless tick", () => {
    const tick = { symbol: "BTC", bid: 99, ask: 101, askQuantity: 2, bidQuantity: 3 };
    assert.strictEqual(selectL2SideQuote(tick, "BUY", 2).price, 101);
    assert.strictEqual(selectL2SideQuote(tick, "SELL", 3).price, 99);
    assert.strictEqual(
      selectL2SideQuote({ symbol: "BTC", ask: 101 }, "BUY", 1),
      undefined,
      "a price with no size is not a level",
    );
  });

  it("walks array-form ladder levels and ignores the malformed ones", () => {
    const tick = {
      symbol: "BTC",
      orderBook: {
        asks: [
          [101, 1],
          [102, 2],
        ],
        bids: [[99, 3]],
      },
    };
    assert.deepStrictEqual(selectL2SideQuote(tick, "BUY", 2.5), {
      bookSide: "ask",
      orderSide: "BUY",
      price: 102,
      availableQuantity: 3,
      requestedQuantity: 2.5,
      levelsConsumed: 2,
    });
    assert.strictEqual(selectL2SideQuote(tick, "SELL", 3).price, 99);

    const dirty = {
      symbol: "BTC",
      orderBook: {
        asks: [
          [0, 5],
          ["x", 1],
          [103, 0],
          [104, 2],
        ],
      },
    };
    const quote = selectL2SideQuote(dirty, "BUY", 1);
    assert.strictEqual(quote.price, 104, "a zero or non-numeric level must not be treated as the best price");
    assert.strictEqual(quote.availableQuantity, 2);
    assert.strictEqual(quote.levelsConsumed, 1);
  });

  it("accepts the alternate ladder and level field names, including a nested data envelope", () => {
    const cases = [
      { asks: [{ px: 101, size: 2 }], bids: [{ rate: 99, amount: 2 }] },
      { a: [{ price: 101, qty: 2 }], b: [{ p: 99, dp: 2 }] },
      { sell: [{ p: 101, d: 2 }], buy: [{ p: 99, quantity: 2 }] },
      { sells: [{ p: 101, q: 2 }], buys: [{ p: 99, q: 2 }] },
      { data: { asks: [{ p: 101, q: 2 }], bids: [{ p: 99, q: 2 }] } },
    ];
    for (const [index, orderBook] of cases.entries()) {
      const tick = { symbol: "BTC", orderBook };
      assert.strictEqual(selectL2SideQuote(tick, "BUY", 2)?.price, 101, `asks shape ${index}`);
      assert.strictEqual(selectL2SideQuote(tick, "SELL", 2)?.price, 99, `bids shape ${index}`);
    }
  });

  it("consumes the best price first however the ladder arrives", () => {
    const tick = {
      symbol: "BTC",
      orderBook: {
        asks: [
          { p: 102, q: 1 },
          { p: 101, q: 1 },
        ],
        bids: [
          { p: 98, q: 1 },
          { p: 99, q: 1 },
        ],
      },
    };
    assert.strictEqual(selectL2SideQuote(tick, "BUY", 1).price, 101);
    assert.strictEqual(selectL2SideQuote(tick, "SELL", 1).price, 99);
    assert.strictEqual(
      selectL2SideQuote(tick, "BUY", 2).price,
      102,
      "the worse level is only reached when size demands it",
    );
  });

  it("quotes nothing without a positive requested quantity or enough depth to fill it", () => {
    const tick = { symbol: "BTC", orderBook: { asks: [{ p: 101, q: 4 }] } };
    assert.strictEqual(selectL2SideQuote(tick, "BUY", 4).price, 101, "control: the book does fill this size");
    for (const quantity of [0, -1, Number.NaN, undefined, null, "", 4.5, 100]) {
      assert.strictEqual(selectL2SideQuote(tick, "BUY", quantity), undefined, String(quantity));
    }
    assert.strictEqual(selectL2SideQuote(tick, "SELL", 1), undefined, "an ask-only tick cannot quote a SELL");
  });
});

describe("USD helpers", () => {
  it("formats positive, zero, negative and fractional amounts to two decimals", () => {
    assert.strictEqual(formatUsd(1234.5), "$1234.50");
    assert.strictEqual(formatUsd(0), "$0.00");
    assert.strictEqual(formatUsd(-0.5), "$-0.50");
    assert.strictEqual(formatUsd(-1234.567), "$-1234.57");
    assert.strictEqual(formatUsd(0.126), "$0.13");
    assert.strictEqual(formatUsd(Number.NaN), "$0.00");
    assert.strictEqual(formatUsd(Infinity), "$0.00");
  });

  it("measures unrealised pnl only when the position carries both an entry and a mark", () => {
    assert.strictEqual(
      unrealizedPnlUsd({
        symbol: "BTC",
        netQty: 2,
        availableQty: 2,
        avgEntryPrice: 100,
        markPrice: 110,
        riskUsd: 220,
        updatedAt: 1,
      }),
      20,
    );
    assert.strictEqual(
      unrealizedPnlUsd({
        symbol: "BTC",
        netQty: -2,
        availableQty: -2,
        avgEntryPrice: 100,
        markPrice: 90,
        riskUsd: 180,
        updatedAt: 1,
      }),
      20,
    );
    assert.strictEqual(
      unrealizedPnlUsd({
        symbol: "BTC",
        netQty: -2,
        availableQty: -2,
        avgEntryPrice: 100,
        markPrice: 110,
        riskUsd: 220,
        updatedAt: 1,
      }),
      -20,
    );
    assert.strictEqual(
      unrealizedPnlUsd({ symbol: "BTC", netQty: 2, availableQty: 2, avgEntryPrice: 100, riskUsd: 0, updatedAt: 1 }),
      0,
      "no mark means no measurable pnl",
    );
    assert.strictEqual(
      unrealizedPnlUsd({ symbol: "BTC", netQty: 2, availableQty: 2, markPrice: 110, riskUsd: 0, updatedAt: 1 }),
      0,
      "no entry means no measurable pnl",
    );
    assert.strictEqual(unrealizedPnlUsd(undefined), 0);
  });
});

describe("PositionStore loading", () => {
  it("loads the positions already on disk and keys them by upper-cased symbol", () => {
    const file = seedFile("positions.json", [
      { symbol: "btc", netQty: 1, availableQty: 1, riskUsd: 100, updatedAt: 1 },
      { symbol: "ETH", netQty: -2, availableQty: -2, riskUsd: 200, updatedAt: 1 },
    ]);
    const store = new PositionStore(file);
    assert.strictEqual(store.list().length, 2);
    assert.strictEqual(
      store.get("BTC").netQty,
      1,
      "a lower-cased symbol on disk must still be found under its upper-cased key",
    );
    assert.strictEqual(store.get("btc").netQty, 1);
    assert.strictEqual(store.get("eth").netQty, -2);
  });

  it("starts empty when the positions file cannot be parsed", () => {
    const good = new PositionStore(
      seedFile("positions.json", [{ symbol: "BTC", netQty: 1, availableQty: 1, riskUsd: 1, updatedAt: 1 }]),
    );
    assert.strictEqual(good.list().length, 1, "control: a well-formed file does load its rows");
    const broken = new PositionStore(seedFile("positions.json", "{ this is not json"));
    assert.deepStrictEqual(broken.list(), []);
  });

  it("ignores rows on disk that carry no symbol", () => {
    const store = new PositionStore(
      seedFile("positions.json", [
        { netQty: 5, availableQty: 5, riskUsd: 500, updatedAt: 1 },
        { symbol: "ETH", netQty: 2, availableQty: 2, riskUsd: 200, updatedAt: 1 },
      ]),
    );
    assert.deepStrictEqual(
      store.list().map((p) => p.symbol),
      ["ETH"],
    );
  });

  it("reads its default file from the configured state directory", () => {
    withStateDir((dir) => {
      fs.writeFileSync(
        path.join(dir, "positions.json"),
        JSON.stringify([{ symbol: "SOL", netQty: 7, availableQty: 7, riskUsd: 70, updatedAt: 1 }]),
      );
      const store = new PositionStore();
      assert.strictEqual(store.get("SOL").netQty, 7);
      store.upsert({ symbol: "BTC", netQty: 1, availableQty: 1 });
      assert.deepStrictEqual(
        JSON.parse(fs.readFileSync(path.join(dir, "positions.json"), "utf8")).map((p) => p.symbol),
        ["BTC", "SOL"],
      );
    });
  });
});

describe("Position normalisation", () => {
  it("rejects a raw update with no symbol or no quantity field at all", () => {
    for (const empty of [undefined, null, 0, ""])
      assert.strictEqual(normalizePosition(empty), undefined, String(empty));
    assert.strictEqual(normalizePosition({ netQty: 1 }), undefined, "no symbol and no fallback");
    assert.strictEqual(
      normalizePosition({ symbol: "BTC", markPrice: 100 }),
      undefined,
      "a bare mark is not a position",
    );
    assert.strictEqual(
      normalizePosition({ symbol: "BTC", netQty: 0 }).netQty,
      0,
      "control: a flat position is still a position",
    );
  });

  it("takes the symbol from every accepted field or the fallback, and strips the quote leg", () => {
    assert.strictEqual(normalizePosition({ s: "BTC/USD", pa: "2" }).symbol, "BTC");
    assert.strictEqual(normalizePosition({ a: "sol", aq: 3 }).symbol, "SOL");
    assert.strictEqual(normalizePosition({ asset: "DOGE", qty: 4 }).symbol, "DOGE");
    assert.strictEqual(normalizePosition({ netQty: 1 }, "eth").symbol, "ETH");
    assert.strictEqual(
      normalizePosition({ symbol: "BTC", netQty: 1 }, "ETH").symbol,
      "BTC",
      "an explicit symbol beats the fallback",
    );
  });

  it("takes the first finite value among the accepted numeric aliases", () => {
    const position = normalizePosition({
      symbol: "BTC",
      netQty: "",
      positionAmt: null,
      pa: 3,
      free: 1,
      ep: "10",
      m: "20",
    });
    assert.strictEqual(position.netQty, 3, "blank and null aliases are skipped");
    assert.strictEqual(position.availableQty, 1);
    assert.strictEqual(position.avgEntryPrice, 10);
    assert.strictEqual(position.markPrice, 20);
    assert.strictEqual(
      normalizePosition({ symbol: "BTC", quantity: 4 }).availableQty,
      4,
      "the quantity doubles as the available size",
    );
  });

  it("values the risk off the mark, then the entry, then nothing", () => {
    assert.strictEqual(
      normalizePosition({ symbol: "BTC", netQty: -2, markPrice: 100, avgEntryPrice: 50 }).riskUsd,
      200,
    );
    assert.strictEqual(normalizePosition({ symbol: "BTC", netQty: 2, avgEntryPrice: 50 }).riskUsd, 100);
    assert.strictEqual(normalizePosition({ symbol: "BTC", netQty: 2 }).riskUsd, 0);
  });
});

describe("PositionStore queries", () => {
  it("derives the close side for a long, a short, a flat and an unknown symbol", () => {
    const store = new PositionStore(storePath("positions.json"));
    store.upsert({ symbol: "BTC", netQty: 2, availableQty: 2 });
    store.upsert({ symbol: "ETH", netQty: -3, availableQty: -3 });
    store.upsert({ symbol: "SOL", netQty: 0, availableQty: 0 });
    assert.strictEqual(store.getCloseSide("btc"), "SELL");
    assert.strictEqual(store.getCloseQuantity("btc"), 2);
    assert.strictEqual(store.getCloseSide("ETH"), "BUY");
    assert.strictEqual(store.getCloseQuantity("ETH"), 3);
    assert.strictEqual(store.getCloseSide("SOL"), undefined, "a flat position has nothing to close");
    assert.strictEqual(store.getCloseQuantity("SOL"), 0);
    assert.strictEqual(store.getCloseSide("DOGE"), undefined, "an unknown symbol has nothing to close");
    assert.strictEqual(store.getCloseQuantity("DOGE"), 0);
  });

  it("closes with the available quantity when it differs from the net quantity", () => {
    const store = new PositionStore(storePath("positions.json"));
    store.upsert({ symbol: "BTC", netQty: 5, availableQty: 2 });
    assert.strictEqual(store.getCloseQuantity("BTC"), 2);
  });

  it("zeroing a position leaves it cached but no longer closeable", () => {
    const store = new PositionStore(storePath("positions.json"));
    store.upsert({ symbol: "BTC", netQty: 4, availableQty: 4, markPrice: 10 });
    assert.strictEqual(store.getCloseSide("BTC"), "SELL", "control: the long is closeable before it is flattened");
    store.upsert({ symbol: "BTC", netQty: 0, availableQty: 0, markPrice: 10 });
    assert.strictEqual(store.get("BTC").netQty, 0);
    assert.strictEqual(store.getCloseSide("BTC"), undefined);
    assert.strictEqual(store.totalRiskUsd(), 0);
  });

  it("marks a cached symbol and ignores a mark for an unknown symbol or a bad price", () => {
    const file = storePath("positions.json");
    const store = new PositionStore(file);
    store.upsert({ symbol: "BTC", netQty: -3, availableQty: -3 });
    store.setMark("btc", 100);
    assert.strictEqual(store.get("BTC").markPrice, 100, "control: a valid mark for a known symbol is applied");
    assert.strictEqual(store.get("BTC").riskUsd, 300, "the mark revalues the risk");

    for (const bad of [0, -1, Number.NaN, undefined]) {
      store.setMark("BTC", bad);
      assert.strictEqual(store.get("BTC").markPrice, 100, `mark ${bad} must be ignored`);
    }
    store.setMark("DOGE", 100);
    assert.strictEqual(store.get("DOGE"), undefined, "an unknown symbol is never created by a mark");
    assert.strictEqual(store.list().length, 1);
  });

  it("only writes a mark to disk when asked to persist it", () => {
    const file = storePath("positions.json");
    const store = new PositionStore(file);
    store.upsert({ symbol: "BTC", netQty: 2, availableQty: 2 });
    store.setMark("BTC", 100);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(file, "utf8"))[0].markPrice,
      undefined,
      "a transient mark stays in memory",
    );
    store.setMark("BTC", 150, true);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8"))[0].markPrice, 150);
    assert.strictEqual(new PositionStore(file).get("BTC").riskUsd, 300);
  });

  it("merges a payload given as an array, a positions envelope or a data envelope", () => {
    const store = new PositionStore(storePath("positions.json"));
    assert.strictEqual(store.merge([{ symbol: "BTC", netQty: 1, availableQty: 1 }]).length, 1);
    assert.strictEqual(store.merge({ positions: [{ symbol: "ETH", netQty: 2, availableQty: 2 }] }).length, 1);
    assert.strictEqual(store.merge({ data: [{ symbol: "SOL", netQty: 3, availableQty: 3 }] }).length, 1);
    assert.deepStrictEqual(
      store.list().map((p) => p.symbol),
      ["BTC", "ETH", "SOL"],
    );

    for (const unusable of [null, undefined, {}, { positions: "nope" }, "nope"]) {
      assert.deepStrictEqual(store.merge(unusable), [], `merge(${JSON.stringify(unusable)})`);
    }
    assert.deepStrictEqual(
      store.list().map((p) => p.symbol),
      ["BTC", "ETH", "SOL"],
      "an unusable payload must not disturb the cache",
    );
  });

  it("replaces the whole cache, dropping a symbol the account no longer reports", () => {
    const file = storePath("positions.json");
    const store = new PositionStore(file);
    store.merge([
      { symbol: "BTC", netQty: 1, availableQty: 1 },
      { symbol: "ETH", netQty: 2, availableQty: 2 },
    ]);
    assert.deepStrictEqual(
      store.list().map((p) => p.symbol),
      ["BTC", "ETH"],
      "control: both symbols were cached first",
    );
    const replaced = store.replace({ positions: [{ symbol: "BTC", netQty: 5, availableQty: 5 }] });
    assert.deepStrictEqual(
      replaced.map((p) => p.symbol),
      ["BTC"],
    );
    assert.strictEqual(store.get("ETH"), undefined);
    assert.strictEqual(store.get("BTC").netQty, 5);
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(file, "utf8")).map((p) => p.symbol),
      ["BTC"],
    );
  });

  it("clears every cached position and persists the empty list", () => {
    const file = storePath("positions.json");
    const store = new PositionStore(file);
    store.upsert({ symbol: "BTC", netQty: 1, availableQty: 1 });
    assert.strictEqual(store.list().length, 1, "control: there was something to clear");
    store.clear();
    assert.deepStrictEqual(store.list(), []);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), []);
    assert.deepStrictEqual(new PositionStore(file).list(), []);
  });

  it("adds long and short risk into the total and reports zero with nothing cached", () => {
    const empty = new PositionStore(storePath("positions.json"));
    assert.strictEqual(empty.totalRiskUsd(), 0);
    empty.upsert({ symbol: "BTC", netQty: 2, availableQty: 2, markPrice: 100 });
    empty.upsert({ symbol: "ETH", netQty: -3, availableQty: -3, markPrice: 100 });
    assert.strictEqual(empty.totalRiskUsd(), 500, "a short contributes its absolute notional, same as a long");

    const seeded = new PositionStore(
      seedFile("positions.json", [
        { symbol: "BTC", netQty: 1, availableQty: 1, riskUsd: 200, updatedAt: 1 },
        { symbol: "ETH", netQty: -2, availableQty: -2, riskUsd: 300, updatedAt: 1 },
        { symbol: "SOL", netQty: 1, availableQty: 1, riskUsd: null, updatedAt: 1 },
      ]),
    );
    assert.strictEqual(seeded.totalRiskUsd(), 500, "a row with no usable risk contributes nothing");
  });

  it("describes an empty cache with the refresh hint and a populated one row per symbol", () => {
    const store = new PositionStore(storePath("positions.json"));
    assert.strictEqual(
      store.describe(),
      "No positions cached yet. Run positions:refresh or start the watcher to receive account updates.",
    );
    store.upsert({ symbol: "ETH", netQty: -3, availableQty: -3 });
    store.upsert({ symbol: "BTC", netQty: 2, availableQty: 2, avgEntryPrice: 100, markPrice: 110 });
    assert.strictEqual(
      store.describe(),
      "BTC: net=2 available=2 avg=100 mark=110 riskUsd=220.00\nETH: net=-3 available=-3 riskUsd=0.00",
    );
  });
});

describe("TriggerStore loading", () => {
  const persistedTrigger = (overrides) => ({
    id: "t1",
    ownerId: "default",
    kind: "LIMIT",
    symbol: "BTC",
    side: "BUY",
    triggerPrice: 100,
    quantity: 1,
    closePosition: false,
    reduceOnly: false,
    paymentCurrency: "USD",
    status: "ACTIVE",
    createdAt: 1,
    updatedAt: 1,
    triggerSource: "side",
    ...overrides,
  });

  it("migrates a legacy lastPrice into lastCheckedPrice and forces the side-based price source", () => {
    const store = new TriggerStore(
      seedFile("triggers.json", [
        persistedTrigger({ id: "legacy", triggerSource: "mid", lastPrice: 99 }),
        persistedTrigger({ id: "both", lastPrice: 99, lastCheckedPrice: 101 }),
      ]),
    );
    const legacy = store.get("legacy");
    assert.strictEqual(legacy.lastCheckedPrice, 99);
    assert.strictEqual(Object.hasOwn(legacy, "lastPrice"), false, "the legacy field must not survive the migration");
    assert.strictEqual(legacy.triggerSource, "side");
    assert.strictEqual(store.get("both").lastCheckedPrice, 101, "an existing lastCheckedPrice wins");
  });

  it("skips a persisted row with no id and a file that does not hold an array", () => {
    const store = new TriggerStore(
      seedFile("triggers.json", [{ ...persistedTrigger(), id: undefined }, persistedTrigger({ id: "keep" })]),
    );
    assert.deepStrictEqual(
      store.list().map((t) => t.id),
      ["keep"],
    );
    assert.deepStrictEqual(new TriggerStore(seedFile("triggers.json", { triggers: [persistedTrigger()] })).list(), []);
  });

  it("starts empty when triggers.json cannot be parsed", () => {
    assert.strictEqual(
      new TriggerStore(seedFile("triggers.json", [persistedTrigger()])).list().length,
      1,
      "control: a well-formed file does load",
    );
    assert.deepStrictEqual(new TriggerStore(seedFile("triggers.json", "not json at all")).list(), []);
  });

  it("sorts the loaded triggers oldest first", () => {
    const store = new TriggerStore(
      seedFile("triggers.json", [
        persistedTrigger({ id: "newer", createdAt: 200 }),
        persistedTrigger({ id: "older", createdAt: 100 }),
      ]),
    );
    assert.deepStrictEqual(
      store.list().map((t) => t.id),
      ["older", "newer"],
    );
  });

  it("reads and writes its default file in the configured state directory", () => {
    withStateDir((dir) => {
      fs.writeFileSync(path.join(dir, "triggers.json"), JSON.stringify([persistedTrigger({ id: "seeded" })]));
      const store = new TriggerStore();
      assert.strictEqual(store.get("seeded").symbol, "BTC");
      const added = store.add({ kind: "LIMIT", symbol: "ETH", side: "BUY", triggerPrice: 10, quantity: 1 });
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "triggers.json"), "utf8"));
      assert.deepStrictEqual(onDisk.map((t) => t.id).sort(), ["seeded", added.id].sort());
    });
  });
});

describe("TriggerStore add validation", () => {
  const store = () => new TriggerStore(storePath("triggers.json"));
  const limit = { kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 1 };

  it("rejects a kind it does not support", () => {
    assert.strictEqual(store().add(limit).kind, "LIMIT", "control: a supported kind is accepted");
    assert.throws(() => store().add({ ...limit, kind: "MOON_SHOT" }), {
      message: "unsupported trigger kind: MOON_SHOT",
    });
    assert.throws(() => store().add({ ...limit, kind: undefined }), { message: "unsupported trigger kind: undefined" });
  });

  it("rejects a bad side, a blank symbol and non-positive prices or sizes", () => {
    assert.throws(() => store().add({ ...limit, side: "LONG" }), { message: "side must be BUY or SELL, got: LONG" });
    assert.throws(() => store().add({ ...limit, symbol: "  " }), { message: "symbol is required" });
    assert.throws(() => store().add({ ...limit, triggerPrice: 0 }), {
      message: "triggerPrice must be a positive number",
    });
    assert.throws(() => store().add({ ...limit, quantity: -1 }), { message: "quantity must be a positive number" });
    assert.throws(
      () =>
        store().add({ kind: "STOP_LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, limitPrice: 0, quantity: 1 }),
      { message: "limitPrice must be a positive number" },
    );
    assert.throws(() => store().add({ ...limit, quantity: undefined, closePercentage: 101 }), {
      message: "closePercentage must be <= 100",
    });
    assert.throws(() => store().add({ ...limit, lowerPrice: 0, kind: "PRICE_BAND", priceBandMode: "REVERSION" }), {
      message: "lowerPrice must be a positive number",
    });
    assert.throws(() => store().add({ ...limit, kind: "PRICE_BAND", priceBandMode: "BREAKOUT", upperPrice: -5 }), {
      message: "upperPrice must be a positive number",
    });
  });

  it("requires a trigger price for every price-driven kind and a limit price for a stop limit", () => {
    for (const kind of ["LIMIT", "STOP_LIMIT", "TAKE_PROFIT", "STOP_LOSS"]) {
      assert.throws(
        () => store().add({ kind, symbol: "BTC", side: "BUY", quantity: 1, limitPrice: 100 }),
        { message: `${kind} requires triggerPrice` },
        kind,
      );
    }
    assert.throws(
      () => store().add({ kind: "STOP_LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 1 }),
      { message: "limitPrice is required for STOP_LIMIT triggers" },
    );
    assert.strictEqual(
      store().add({ kind: "STOP_LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, limitPrice: 101, quantity: 1 })
        .limitPrice,
      101,
    );
  });

  it("requires a positive trail value and a non-negative limit offset on the trailing kinds", () => {
    for (const kind of ["TRAILING_STOP", "TRAILING_STOP_LIMIT"]) {
      assert.throws(
        () => store().add({ kind, symbol: "BTC", side: "SELL", quantity: 1 }),
        { message: `${kind} requires trailValue` },
        kind,
      );
      assert.throws(
        () => store().add({ kind, symbol: "BTC", side: "SELL", quantity: 1, trailValue: 0 }),
        { message: "trailValue must be a positive number" },
        kind,
      );
    }
    assert.throws(
      () =>
        store().add({
          kind: "TRAILING_STOP_LIMIT",
          symbol: "BTC",
          side: "SELL",
          quantity: 1,
          trailValue: 5,
          limitOffset: -1,
        }),
      { message: "limitOffset must be zero or a positive number" },
    );
    assert.strictEqual(
      store().add({
        kind: "TRAILING_STOP_LIMIT",
        symbol: "BTC",
        side: "SELL",
        quantity: 1,
        trailValue: 5,
        limitOffset: 0,
      }).limitOffset,
      0,
    );
  });

  it("requires a positive activation value and a non-negative lock value on a break-even stop", () => {
    assert.throws(() => store().add({ kind: "BREAK_EVEN_STOP", symbol: "BTC", side: "SELL", quantity: 1 }), {
      message: "BREAK_EVEN_STOP requires activationValue",
    });
    assert.throws(
      () => store().add({ kind: "BREAK_EVEN_STOP", symbol: "BTC", side: "SELL", quantity: 1, activationValue: 0 }),
      { message: "activationValue must be a positive number" },
    );
    assert.throws(
      () =>
        store().add({
          kind: "BREAK_EVEN_STOP",
          symbol: "BTC",
          side: "SELL",
          quantity: 1,
          activationValue: 5,
          lockValue: -1,
        }),
      { message: "lockValue must be zero or a positive number" },
    );
    assert.strictEqual(
      store().add({
        kind: "BREAK_EVEN_STOP",
        symbol: "BTC",
        side: "SELL",
        quantity: 1,
        activationValue: 5,
        lockValue: 0,
      }).lockValue,
      0,
    );
  });

  it("requires a future timestamp on both timed kinds and a cancel target on TIME_CANCEL", () => {
    for (const kind of ["TIME_CLOSE", "TIME_CANCEL"]) {
      const message = `${kind} requires a future triggerAt timestamp`;
      assert.throws(
        () => store().add({ kind, symbol: "BTC", side: "SELL", closePosition: true, cancelTriggerId: "x" }),
        { message },
        `${kind} with no triggerAt`,
      );
      assert.throws(
        () =>
          store().add({
            kind,
            symbol: "BTC",
            side: "SELL",
            closePosition: true,
            cancelTriggerId: "x",
            triggerAt: Date.now() - 1000,
          }),
        { message },
        `${kind} in the past`,
      );
    }
    assert.throws(
      () => store().add({ kind: "TIME_CANCEL", symbol: "BTC", side: "SELL", triggerAt: Date.now() + 60_000 }),
      { message: "TIME_CANCEL requires cancelTriggerId or cancelGroupId" },
    );
    assert.strictEqual(
      store().add({
        kind: "TIME_CANCEL",
        symbol: "BTC",
        side: "SELL",
        triggerAt: Date.now() + 60_000,
        cancelGroupId: "g",
      }).cancelGroupId,
      "g",
    );
  });

  it("validates the PRICE_BAND mode and the band edge that its side needs", () => {
    const band = (overrides) => ({ kind: "PRICE_BAND", symbol: "BTC", side: "BUY", quantity: 1, ...overrides });
    assert.throws(() => store().add(band({})), { message: "PRICE_BAND requires priceBandMode" });
    assert.throws(() => store().add(band({ priceBandMode: "SIDEWAYS" })), {
      message: "priceBandMode must be BREAKOUT or REVERSION",
    });
    assert.throws(() => store().add(band({ priceBandMode: "BREAKOUT" })), {
      message: "PRICE_BAND requires upperPrice for this side/mode",
    });
    assert.throws(() => store().add(band({ priceBandMode: "REVERSION", side: "SELL" })), {
      message: "PRICE_BAND requires upperPrice for this side/mode",
    });
    assert.throws(() => store().add(band({ priceBandMode: "BREAKOUT", side: "SELL" })), {
      message: "PRICE_BAND requires lowerPrice for this side/mode",
    });
    assert.throws(() => store().add(band({ priceBandMode: "REVERSION" })), {
      message: "PRICE_BAND requires lowerPrice for this side/mode",
    });
    assert.strictEqual(store().add(band({ priceBandMode: "BREAKOUT", upperPrice: 150 })).upperPrice, 150);
    assert.strictEqual(store().add(band({ priceBandMode: "REVERSION", lowerPrice: 50 })).lowerPrice, 50);
  });

  it("normalises a risk metric and action and demands a positive threshold", () => {
    const guard = store().add({
      kind: "RISK_GUARD",
      symbol: "BTC",
      side: "SELL",
      riskMetric: "max-risk-usd",
      riskAction: " close-position ",
      riskThreshold: 500,
    });
    assert.strictEqual(guard.riskMetric, "MAX_RISK_USD");
    assert.strictEqual(guard.riskAction, "CLOSE_POSITION");
    assert.throws(
      () =>
        store().add({
          kind: "RISK_GUARD",
          symbol: "BTC",
          side: "SELL",
          riskMetric: "MAX_DRAWDOWN",
          riskAction: "ALERT",
          riskThreshold: 1,
        }),
      { message: "riskMetric must be MAX_POSITION_QTY, MAX_RISK_USD, or MAX_LOSS_USD" },
    );
    assert.throws(
      () =>
        store().add({
          kind: "RISK_GUARD",
          symbol: "BTC",
          side: "SELL",
          riskMetric: "MAX_RISK_USD",
          riskAction: "PANIC",
          riskThreshold: 1,
        }),
      { message: "riskAction must be ALERT, CLOSE_POSITION, or CANCEL_TRIGGERS" },
    );
    assert.throws(
      () =>
        store().add({
          kind: "RISK_GUARD",
          symbol: "BTC",
          side: "SELL",
          riskMetric: "MAX_RISK_USD",
          riskAction: "ALERT",
          riskThreshold: 0,
        }),
      { message: "riskThreshold must be a positive number" },
    );
  });

  it("accepts no quantity only when the position can size the order", () => {
    const s = store();
    assert.strictEqual(
      s.add({ kind: "TAKE_PROFIT", symbol: "BTC", side: "SELL", triggerPrice: 120, closePosition: true }).reduceOnly,
      true,
    );
    assert.strictEqual(
      s.add({ kind: "TAKE_PROFIT", symbol: "BTC", side: "SELL", triggerPrice: 120, closePercentage: 50 }).reduceOnly,
      true,
    );
    assert.strictEqual(
      s.add({
        kind: "RISK_GUARD",
        symbol: "BTC",
        side: "SELL",
        riskMetric: "MAX_RISK_USD",
        riskAction: "ALERT",
        riskThreshold: 5,
      }).quantity,
      undefined,
    );
    assert.strictEqual(
      s.add({ kind: "TIME_CANCEL", symbol: "BTC", side: "SELL", triggerAt: Date.now() + 60_000, cancelTriggerId: "x" })
        .quantity,
      undefined,
    );
    assert.throws(() => s.add({ kind: "TAKE_PROFIT", symbol: "BTC", side: "SELL", triggerPrice: 120 }), {
      message: "quantity is required unless closePosition or closePercentage is set",
    });
    assert.strictEqual(
      s.add({
        kind: "TAKE_PROFIT",
        symbol: "BTC",
        side: "SELL",
        triggerPrice: 120,
        closePosition: true,
        reduceOnly: false,
      }).reduceOnly,
      false,
      "an explicit reduceOnly beats the derived one",
    );
  });

  it("fills in the owner, payment currency, status and price source", () => {
    const created = store().add({ ...limit, symbol: " btc " });
    assert.strictEqual(created.ownerId, "default");
    assert.strictEqual(created.paymentCurrency, "USD");
    assert.strictEqual(created.status, "ACTIVE");
    assert.strictEqual(created.triggerSource, "side");
    assert.strictEqual(created.symbol, "BTC");
    assert.strictEqual(created.closePosition, false);
    assert.strictEqual(created.reduceOnly, false);
    const custom = store().add({ ...limit, ownerId: "tg-42", paymentCurrency: "USDT", account: "sub-1" });
    assert.deepStrictEqual([custom.ownerId, custom.paymentCurrency, custom.account], ["tg-42", "USDT", "sub-1"]);
  });

  it("normalises the trail, activation and lock modes and rejects an unknown one", () => {
    const created = store().add({
      kind: "TRAILING_STOP",
      symbol: "BTC",
      side: "SELL",
      quantity: 1,
      trailValue: 5,
      trailMode: "percent",
      activationMode: "amount",
      activationValue: 1,
      lockMode: " PERCENT ",
      lockValue: 2,
    });
    assert.deepStrictEqual(
      [created.trailMode, created.activationMode, created.lockMode],
      ["PERCENT", "AMOUNT", "PERCENT"],
    );
    assert.throws(
      () =>
        store().add({
          kind: "TRAILING_STOP",
          symbol: "BTC",
          side: "SELL",
          quantity: 1,
          trailValue: 5,
          trailMode: "RATIO",
        }),
      { message: "amount mode must be AMOUNT or PERCENT" },
    );
    const bare = store().add({ kind: "TRAILING_STOP", symbol: "BTC", side: "SELL", quantity: 1, trailValue: 5 });
    assert.deepStrictEqual([bare.trailMode, bare.activationMode, bare.lockMode], [undefined, undefined, undefined]);
  });
});

describe("TriggerStore lookups and transitions", () => {
  it("returns nothing for an unknown trigger id", () => {
    const store = new TriggerStore(storePath("triggers.json"));
    const created = store.add({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 1 });
    assert.strictEqual(store.get(created.id).id, created.id, "control: a known id resolves");
    assert.strictEqual(store.get("trg_nope"), undefined);
    assert.strictEqual(store.get(undefined), undefined);
  });

  it("filters the active triggers by symbol, status, owner and group", () => {
    const store = new TriggerStore(storePath("triggers.json"));
    const btc = store.add({
      kind: "LIMIT",
      symbol: "BTC",
      side: "BUY",
      triggerPrice: 100,
      quantity: 1,
      ownerId: "tg-1",
    });
    const doomed = store.add({
      kind: "LIMIT",
      symbol: "BTC",
      side: "BUY",
      triggerPrice: 90,
      quantity: 1,
      ownerId: "tg-2",
    });
    const eth = store.add({
      kind: "LIMIT",
      symbol: "ETH",
      side: "BUY",
      triggerPrice: 10,
      quantity: 1,
      ownerId: "tg-1",
      ocoGroupId: "g1",
    });
    store.cancel(doomed.id);

    assert.deepStrictEqual(
      store
        .active()
        .map((t) => t.id)
        .sort(),
      [btc.id, eth.id].sort(),
    );
    assert.deepStrictEqual(
      store.active("btc").map((t) => t.id),
      [btc.id],
      "the symbol filter is normalised",
    );
    assert.deepStrictEqual(
      store.list({ status: "CANCELLED" }).map((t) => t.id),
      [doomed.id],
    );
    assert.deepStrictEqual(
      store
        .list({ ownerId: "tg-1" })
        .map((t) => t.id)
        .sort(),
      [btc.id, eth.id].sort(),
    );
    assert.deepStrictEqual(
      store.list({ ocoGroupId: "g1" }).map((t) => t.id),
      [eth.id],
    );
    assert.strictEqual(store.list().length, 3, "an unfiltered list keeps the settled triggers too");
  });

  it("reports the distinct symbols that still have active triggers", () => {
    const store = new TriggerStore(storePath("triggers.json"));
    const eth = store.add({ kind: "LIMIT", symbol: "ETH", side: "BUY", triggerPrice: 10, quantity: 1 });
    store.add({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 1 });
    store.add({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 90, quantity: 1 });
    assert.deepStrictEqual(store.activeSymbols(), ["BTC", "ETH"]);
    store.cancel(eth.id);
    assert.deepStrictEqual(store.activeSymbols(), ["BTC"], "a cancelled symbol stops being watched");
  });

  it("cancels an ACTIVE trigger once and refuses one that has already settled", () => {
    const store = new TriggerStore(storePath("triggers.json"));
    const target = store.add({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 1 });
    const fired = store.add({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 90, quantity: 1 });
    store.setStatus(fired.id, "TRIGGERED", { orderId: "o1" });

    assert.strictEqual(store.cancel(target.id).status, "CANCELLED");
    assert.strictEqual(store.cancel(target.id), undefined, "cancelling twice is a no-op");
    assert.strictEqual(store.get(target.id).status, "CANCELLED");
    assert.strictEqual(store.cancel(fired.id), undefined, "a triggered order cannot be cancelled");
    assert.strictEqual(store.get(fired.id).status, "TRIGGERED");
    assert.strictEqual(store.get(fired.id).orderId, "o1");
    assert.strictEqual(store.cancel("trg_nope"), undefined);
  });

  it("keeps the stored trigger untouched when a patch changes nothing", () => {
    const store = new TriggerStore(storePath("triggers.json"));
    const created = store.add({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 1 });
    const before = store.get(created.id);
    assert.strictEqual(
      store.update(created.id, { status: "ACTIVE", quantity: 1 }),
      before,
      "a no-op patch returns the very same record",
    );
    const after = store.update(created.id, { lastCheckedPrice: 99 });
    assert.notStrictEqual(after, before);
    assert.strictEqual(after.lastCheckedPrice, 99);
    assert.strictEqual(store.update("trg_nope", { lastCheckedPrice: 1 }), undefined);
  });

  it("cancels a whole group except the trigger that asked for it", () => {
    const store = new TriggerStore(storePath("triggers.json"));
    const [a, b] = store.addOco(
      [
        { kind: "TAKE_PROFIT", symbol: "BTC", side: "SELL", triggerPrice: 120, quantity: 1 },
        { kind: "STOP_LOSS", symbol: "BTC", side: "SELL", triggerPrice: 90, quantity: 1 },
      ],
      "g1",
    );
    const timer = store.add({
      kind: "TIME_CANCEL",
      symbol: "BTC",
      side: "SELL",
      triggerAt: Date.now() + 60_000,
      cancelGroupId: "g1",
    });
    const unrelated = store.add({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 50, quantity: 1 });

    const cancelled = store.cancelGroup("g1", timer.id);
    assert.deepStrictEqual(cancelled.map((t) => t.id).sort(), [a.id, b.id].sort());
    assert.strictEqual(store.get(timer.id).status, "ACTIVE", "the timer that fired the cancellation survives it");
    assert.strictEqual(store.get(unrelated.id).status, "ACTIVE");
    assert.deepStrictEqual(store.cancelGroup("g1", timer.id), [], "a second sweep finds nothing left to cancel");
  });

  it("cancels the surviving OCO siblings of the leg that fired, and nothing without a group", () => {
    const store = new TriggerStore(storePath("triggers.json"));
    const [a, b, c] = store.addOco(
      [
        { kind: "TAKE_PROFIT", symbol: "BTC", side: "SELL", triggerPrice: 120, quantity: 1 },
        { kind: "STOP_LOSS", symbol: "BTC", side: "SELL", triggerPrice: 90, quantity: 1 },
        { kind: "LIMIT", symbol: "BTC", side: "SELL", triggerPrice: 130, quantity: 1 },
      ],
      "g2",
    );
    assert.deepStrictEqual(store.cancelOcoSiblings(undefined, a.id), [], "a trigger with no group has no siblings");
    const cancelled = store.cancelOcoSiblings("g2", a.id);
    assert.deepStrictEqual(cancelled.map((t) => t.id).sort(), [b.id, c.id].sort());
    assert.strictEqual(store.get(a.id).status, "ACTIVE", "the leg that fired is not cancelled by its own sweep");
  });
});

describe("TriggerStore OCO creation", () => {
  it("requires at least two legs", () => {
    const store = new TriggerStore(storePath("triggers.json"));
    assert.throws(
      () => store.addOco([{ kind: "TAKE_PROFIT", symbol: "BTC", side: "SELL", triggerPrice: 120, quantity: 1 }]),
      { message: "OCO requires at least two child triggers" },
    );
    assert.throws(() => store.addOco([]), { message: "OCO requires at least two child triggers" });
    assert.deepStrictEqual(store.list(), [], "a refused OCO creates nothing");
  });

  it("gives every leg the minted group id unless the leg names its own", () => {
    const store = new TriggerStore(storePath("triggers.json"));
    const [minted, own] = store.addOco([
      { kind: "TAKE_PROFIT", symbol: "BTC", side: "SELL", triggerPrice: 120, quantity: 1 },
      { kind: "STOP_LOSS", symbol: "BTC", side: "SELL", triggerPrice: 90, quantity: 1, ocoGroupId: "mine" },
    ]);
    assert.match(minted.ocoGroupId, /^oco_/);
    assert.strictEqual(own.ocoGroupId, "mine");
    const [first, second] = store.addOco(
      [
        { kind: "TAKE_PROFIT", symbol: "ETH", side: "SELL", triggerPrice: 20, quantity: 1 },
        { kind: "STOP_LOSS", symbol: "ETH", side: "SELL", triggerPrice: 9, quantity: 1 },
      ],
      "explicit",
    );
    assert.deepStrictEqual([first.ocoGroupId, second.ocoGroupId], ["explicit", "explicit"]);
  });

  it("rolls the whole group back, on disk too, when a later leg fails validation", () => {
    const file = storePath("triggers.json");
    const store = new TriggerStore(file);
    const kept = store.addOco(
      [
        { kind: "TAKE_PROFIT", symbol: "BTC", side: "SELL", triggerPrice: 120, quantity: 1 },
        { kind: "STOP_LOSS", symbol: "BTC", side: "SELL", triggerPrice: 90, quantity: 1 },
      ],
      "good",
    );
    assert.strictEqual(store.list().length, 2, "control: a valid pair is created and persisted");

    assert.throws(
      () =>
        store.addOco(
          [
            { kind: "TAKE_PROFIT", symbol: "ETH", side: "SELL", triggerPrice: 20, quantity: 1 },
            { kind: "STOP_LOSS", symbol: "ETH", side: "SELL", triggerPrice: 0, quantity: 1 },
          ],
          "doomed",
        ),
      { message: "triggerPrice must be a positive number" },
    );

    assert.deepStrictEqual(
      store
        .list()
        .map((t) => t.id)
        .sort(),
      kept.map((t) => t.id).sort(),
      "no half-created leg may survive",
    );
    assert.deepStrictEqual(store.list({ ocoGroupId: "doomed" }), []);
    assert.deepStrictEqual(
      new TriggerStore(file)
        .list()
        .map((t) => t.id)
        .sort(),
      kept.map((t) => t.id).sort(),
      "the rollback is persisted",
    );
  });
});

describe("TriggerStore runtime requirements", () => {
  const bracketMeta = { bracket: { takeProfitPrice: 120, stopLossPrice: 90 } };

  it("needs no runtime until a trigger is active, and none again once every one has settled", () => {
    const store = new TriggerStore(storePath("triggers.json"));
    assert.strictEqual(store.runtimeNeeded(), false);
    const created = store.add({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 1 });
    assert.strictEqual(store.runtimeNeeded(), true);
    store.cancel(created.id);
    assert.strictEqual(store.runtimeNeeded(), false);
  });

  it("keeps the runtime alive for a bracket entry whose exits do not exist yet", () => {
    const store = new TriggerStore(storePath("triggers.json"));
    const parent = store.add({
      kind: "LIMIT",
      symbol: "BTC",
      side: "BUY",
      triggerPrice: 100,
      quantity: 1,
      meta: bracketMeta,
    });
    store.update(parent.id, { status: "TRIGGERED", meta: { ...bracketMeta, bracketEntrySubmittedAt: Date.now() } });
    assert.deepStrictEqual(store.active(), [], "the parent has left the active set");
    assert.deepStrictEqual(
      store.pendingBracketEntries().map((t) => t.id),
      [parent.id],
    );
    assert.strictEqual(store.runtimeNeeded(), true);

    store.update(parent.id, {
      meta: { ...bracketMeta, bracketEntrySubmittedAt: Date.now(), bracketChildrenCreated: true },
    });
    assert.deepStrictEqual(store.pendingBracketEntries(), []);
    assert.strictEqual(store.runtimeNeeded(), false);
  });

  it("needs account data only for the triggers that read the position", () => {
    const withOne = (input) => {
      const store = new TriggerStore(storePath("triggers.json"));
      const created = store.add(input);
      return { store, created };
    };
    const plain = withOne({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 1 });
    assert.strictEqual(plain.store.needsAccountData(), false, "a fully sized limit needs no position memory");

    for (const input of [
      { kind: "TAKE_PROFIT", symbol: "BTC", side: "SELL", triggerPrice: 120, closePosition: true },
      { kind: "TAKE_PROFIT", symbol: "BTC", side: "SELL", triggerPrice: 120, closePercentage: 50 },
      { kind: "BREAK_EVEN_STOP", symbol: "BTC", side: "SELL", quantity: 1, activationValue: 5 },
      { kind: "TIME_CLOSE", symbol: "BTC", side: "SELL", quantity: 1, triggerAt: Date.now() + 60_000 },
      {
        kind: "RISK_GUARD",
        symbol: "BTC",
        side: "SELL",
        riskMetric: "MAX_RISK_USD",
        riskAction: "ALERT",
        riskThreshold: 5,
      },
      { kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 1, meta: bracketMeta },
    ]) {
      assert.strictEqual(withOne(input).store.needsAccountData(), true, input.kind);
    }

    const settled = withOne({
      kind: "TAKE_PROFIT",
      symbol: "BTC",
      side: "SELL",
      triggerPrice: 120,
      closePosition: true,
    });
    settled.store.cancel(settled.created.id);
    assert.strictEqual(settled.store.needsAccountData(), false, "a cancelled close order no longer needs the position");

    const pending = withOne({
      kind: "LIMIT",
      symbol: "BTC",
      side: "BUY",
      triggerPrice: 100,
      quantity: 1,
      meta: bracketMeta,
    });
    pending.store.update(pending.created.id, {
      status: "TRIGGERED",
      meta: { ...bracketMeta, bracketEntrySubmittedAt: Date.now() },
    });
    assert.strictEqual(pending.store.needsAccountData(), true, "a fired bracket entry still needs the fill");
  });
});

describe("Engine ticks that do nothing", () => {
  it("ignores a tick for a symbol that has no triggers", async () => {
    const { store, executor, engine } = rig();
    const btc = store.add({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 1 });
    await engine.processTick(l2("ETH", 100));
    assert.deepStrictEqual(executor.orders, []);
    assert.strictEqual(
      store.get(btc.id).lastCheckedPrice,
      undefined,
      "another symbol must not even record a checked price",
    );
    await engine.processTick(l2("BTC", 100));
    assert.strictEqual(executor.orders.length, 1, "control: the same price on the right symbol does fire");
    assert.strictEqual(store.get(btc.id).lastCheckedPrice, 100);
  });

  it("skips a trigger that has already fired or been cancelled", async () => {
    const { store, executor, engine } = rig();
    const alreadyFired = store.add({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 1 });
    const cancelled = store.add({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 2 });
    const live = store.add({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 3 });
    store.setStatus(alreadyFired.id, "TRIGGERED", { orderId: "old" });
    store.cancel(cancelled.id);

    await engine.processTick(l2("BTC", 100));
    assert.deepStrictEqual(
      executor.orders.map((o) => o.clientOrderId),
      [`qt_${live.id}`],
    );
    assert.strictEqual(store.get(alreadyFired.id).orderId, "old", "a triggered order is never resubmitted");
    assert.strictEqual(store.get(cancelled.id).status, "CANCELLED");
    assert.strictEqual(store.get(cancelled.id).lastCheckedPrice, undefined);
  });

  it("processes no timer when none is due yet", async () => {
    // The tick-age cap is off here so the cached book cannot go stale under the
    // clock we hand to processDueTimers: the only thing under test is dueness.
    const { store, positions, executor, engine } = rig({ maxTickAgeMs: 0 });
    positions.upsert({ symbol: "ETH", netQty: -3, availableQty: -3, avgEntryPrice: 100, markPrice: 100 });
    const triggerAt = Date.now() + 60_000;
    const timer = store.add({ kind: "TIME_CLOSE", symbol: "ETH", side: "BUY", triggerAt, closePosition: true });
    await engine.processTick(l2("ETH", 100));
    await engine.processDueTimers();
    assert.deepStrictEqual(executor.orders, []);
    assert.strictEqual(store.get(timer.id).status, "ACTIVE");
    await engine.processDueTimers(triggerAt + 1);
    assert.strictEqual(executor.orders.length, 1, "control: the same timer fires once it is due");
    assert.strictEqual(store.get(timer.id).status, "TRIGGERED");
  });

  it("holds a due TIME_CLOSE back until some L2 depth has been seen for its symbol", async () => {
    const { store, positions, executor, engine } = rig();
    const base = Date.now();
    positions.upsert({ symbol: "ETH", netQty: -3, availableQty: -3, avgEntryPrice: 100, markPrice: 100 });
    const timer = store.add({
      kind: "TIME_CLOSE",
      symbol: "ETH",
      side: "BUY",
      triggerAt: base + 1_000,
      closePosition: true,
    });
    await engine.processDueTimers(base + 2_000);
    assert.deepStrictEqual(executor.orders, [], "with no cached book there is no price to close against");
    assert.strictEqual(store.get(timer.id).status, "ACTIVE");
    await engine.processTick(l2("ETH", 100));
    await engine.processDueTimers(base + 2_000);
    assert.strictEqual(executor.orders.length, 1);
    assert.strictEqual(executor.orders[0].quantity, 3);
  });

  it("never arms a break-even stop while position memory holds no entry price", async () => {
    const { store, positions, executor, engine } = rig();
    const stop = store.add({
      kind: "BREAK_EVEN_STOP",
      symbol: "BTC",
      side: "SELL",
      quantity: 1,
      activationValue: 10,
      lockValue: 0,
    });
    await engine.processTick(l2("BTC", 200));
    assert.deepStrictEqual(executor.orders, []);
    assert.strictEqual(
      store.get(stop.id).breakEvenArmed,
      undefined,
      "with no entry price there is nothing to break even against",
    );
    assert.strictEqual(store.get(stop.id).currentStopPrice, undefined);
    assert.strictEqual(store.get(stop.id).lastCheckedPrice, 200, "the tick was still seen by the trigger");

    positions.upsert({ symbol: "BTC", netQty: 1, availableQty: 1, avgEntryPrice: 100, markPrice: 200 });
    await engine.processTick(l2("BTC", 200));
    assert.strictEqual(
      store.get(stop.id).breakEvenArmed,
      true,
      "control: the same price arms it once the entry is known",
    );
    assert.strictEqual(store.get(stop.id).currentStopPrice, 100);
  });
});

describe("Engine executor failures", () => {
  it("marks the trigger REJECTED and keeps working through the rest of the tick when the executor throws", async () => {
    const { store, executor, engine, events } = rig({}, new FlakyExecutor(1));
    const doomed = store.add({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 1 });
    const survivor = store.add({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 2 });

    await engine.processTick(l2("BTC", 100));

    const rejected = store.get(doomed.id);
    assert.strictEqual(rejected.status, "REJECTED");
    assert.strictEqual(rejected.error, "exchange rejected order");
    assert.strictEqual(rejected.lastCheckedPrice, 100);
    assert.strictEqual(typeof rejected.firedAt, "number");
    assert.deepStrictEqual(events.errors, [{ id: doomed.id, message: "exchange rejected order" }]);
    assert.strictEqual(
      store.get(survivor.id).status,
      "TRIGGERED",
      "the engine must keep processing after a failed submission",
    );
    assert.deepStrictEqual(events.fired, [survivor.id]);
    assert.strictEqual(executor.orders.length, 2);
  });

  it("records a non-Error rejection by stringifying it", async () => {
    const { store, engine, events } = rig({}, new FlakyExecutor(1, "insufficient margin"));
    const doomed = store.add({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 1 });
    await engine.processTick(l2("BTC", 100));
    assert.strictEqual(store.get(doomed.id).status, "REJECTED");
    assert.strictEqual(store.get(doomed.id).error, "insufficient margin");
    assert.deepStrictEqual(
      events.errors.map((e) => e.id),
      [doomed.id],
    );
  });

  it("releases the submission reservation so a later trigger on the same symbol still fires", async () => {
    const { store, executor, engine } = rig({}, new FlakyExecutor(1));
    const doomed = store.add({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 1 });
    await engine.processTick(l2("BTC", 100));
    assert.strictEqual(store.get(doomed.id).status, "REJECTED", "control: the first submission really did fail");
    const retry = store.add({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 1 });
    await engine.processTick(l2("BTC", 100));
    assert.strictEqual(store.get(retry.id).status, "TRIGGERED");
    assert.strictEqual(executor.orders.length, 2);
  });
});

describe("Engine position updates", () => {
  it("does nothing for a position update on a symbol with no triggers", async () => {
    const { store, positions, executor, engine } = rig();
    positions.upsert({ symbol: "DOGE", netQty: 100, availableQty: 100, markPrice: 1 });
    positions.upsert({ symbol: "BTC", netQty: 6, availableQty: 6, markPrice: 10 });
    const guard = store.add({
      kind: "RISK_GUARD",
      symbol: "BTC",
      side: "SELL",
      riskMetric: "MAX_POSITION_QTY",
      riskThreshold: 5,
      riskAction: "ALERT",
    });

    assert.deepStrictEqual(await engine.processPositionUpdate("DOGE"), []);
    assert.deepStrictEqual(
      (await engine.processPositionUpdate("BTC")).map((t) => t.id),
      [guard.id],
      "control: the symbol that does have a guard reports it",
    );
    assert.deepStrictEqual(executor.orders, []);
  });

  it("fires an ALERT risk guard straight from a position update", async () => {
    const { store, positions, executor, engine, events } = rig();
    positions.upsert({ symbol: "BTC", netQty: 6, availableQty: 6, markPrice: 10 });
    const guard = store.add({
      kind: "RISK_GUARD",
      symbol: "BTC",
      side: "SELL",
      riskMetric: "MAX_POSITION_QTY",
      riskThreshold: 5,
      riskAction: "ALERT",
    });

    const changed = await engine.processPositionUpdate(positions.get("BTC"));
    assert.deepStrictEqual(
      changed.map((t) => [t.id, t.status]),
      [[guard.id, "TRIGGERED"]],
    );
    assert.strictEqual(
      store.get(guard.id).lastCheckedPrice,
      10,
      "the cached mark is recorded as the price it fired at",
    );
    assert.deepStrictEqual(events.actions, [{ id: guard.id, message: "Risk guard fired for BTC." }]);
    assert.deepStrictEqual(executor.orders, [], "an alert guard never submits an order");
  });

  it("never fires a guard whose metric the engine does not recognise", async () => {
    const { store, positions, engine } = rig();
    positions.upsert({ symbol: "BTC", netQty: 6, availableQty: 6, markPrice: 10 });
    const guard = store.add({
      kind: "RISK_GUARD",
      symbol: "BTC",
      side: "SELL",
      riskMetric: "MAX_POSITION_QTY",
      riskThreshold: 5,
      riskAction: "ALERT",
    });
    store.update(guard.id, { riskMetric: "MAX_DRAWDOWN" });

    assert.deepStrictEqual(await engine.processPositionUpdate("BTC"), []);
    assert.strictEqual(store.get(guard.id).status, "ACTIVE");

    store.update(guard.id, { riskMetric: "MAX_POSITION_QTY" });
    assert.strictEqual(
      (await engine.processPositionUpdate("BTC")).length,
      1,
      "control: the recognised metric on the same position does breach",
    );
  });

  it("never fires a guard with no threshold or no cached position", async () => {
    const { store, positions, engine } = rig();
    const guard = store.add({
      kind: "RISK_GUARD",
      symbol: "BTC",
      side: "SELL",
      riskMetric: "MAX_POSITION_QTY",
      riskThreshold: 5,
      riskAction: "ALERT",
    });
    assert.deepStrictEqual(
      await engine.processPositionUpdate("BTC"),
      [],
      "no cached position means nothing to measure",
    );
    positions.upsert({ symbol: "BTC", netQty: 6, availableQty: 6, markPrice: 10 });
    store.update(guard.id, { riskThreshold: 0 });
    assert.deepStrictEqual(await engine.processPositionUpdate("BTC"), [], "a zero threshold is not a limit");
    store.update(guard.id, { riskThreshold: 5 });
    assert.strictEqual(
      (await engine.processPositionUpdate("BTC")).length,
      1,
      "control: a real threshold on the cached position breaches",
    );
  });
});

describe("Engine bracket exit maintenance", () => {
  /** Fire a bracket entry so its exits can be created from position memory. */
  async function armedBracket(bracket, quantity = 4) {
    const context = rig();
    const parent = context.store.add({
      kind: "LIMIT",
      symbol: "BTC",
      side: "BUY",
      triggerPrice: 100,
      quantity,
      meta: { bracket },
    });
    await context.engine.processTick(l2("BTC", 100));
    assert.strictEqual(
      context.store.get(parent.id).status,
      "TRIGGERED",
      "the entry must fire before its exits can be considered",
    );
    return { ...context, parent };
  }

  const exits = (store) =>
    store
      .active("BTC")
      .filter((t) => t.meta?.bracketExit)
      .sort((a, b) => a.kind.localeCompare(b.kind));

  it("resizes the bracket exits when the entry fills further, and leaves them alone when it does not", async () => {
    const { store, positions, engine, parent } = await armedBracket({ takeProfitPrice: 120, stopLossPrice: 90 });
    positions.upsert({ symbol: "BTC", netQty: 1, availableQty: 1, avgEntryPrice: 100, markPrice: 100 });
    await engine.processPositionUpdate("BTC");
    assert.deepStrictEqual(
      exits(store).map((t) => t.quantity),
      [1, 1],
      "the exits start sized to the first confirmed fill",
    );

    positions.upsert({ symbol: "BTC", netQty: 3, availableQty: 3, avgEntryPrice: 100, markPrice: 100 });
    const changed = await engine.processPositionUpdate("BTC");
    assert.strictEqual(changed.length, 2);
    assert.deepStrictEqual(
      exits(store).map((t) => t.quantity),
      [3, 3],
    );
    assert.deepStrictEqual(
      exits(store).map((t) => t.meta.bracketExitQuantity),
      [3, 3],
    );
    assert.strictEqual(store.get(parent.id).meta.bracketChildrenCreated, true);

    assert.deepStrictEqual(
      await engine.processPositionUpdate("BTC"),
      [],
      "a repeated update of the same fill changes nothing",
    );
  });

  it("sizes an exit leg that has lost its quantity back to the confirmed fill", async () => {
    const { store, positions, engine } = await armedBracket({ takeProfitPrice: 120, stopLossPrice: 90 });
    positions.upsert({ symbol: "BTC", netQty: 2, availableQty: 2, avgEntryPrice: 100, markPrice: 100 });
    await engine.processPositionUpdate("BTC");
    const [takeProfit] = exits(store);
    assert.strictEqual(takeProfit.quantity, 2, "control: the leg was sized when it was created");

    store.update(takeProfit.id, { quantity: undefined });
    const changed = await engine.processPositionUpdate("BTC");
    assert.deepStrictEqual(
      changed.map((t) => t.id),
      [takeProfit.id],
    );
    assert.strictEqual(store.get(takeProfit.id).quantity, 2);
  });

  it("never resizes bracket exits that close the whole position", async () => {
    const sized = await armedBracket({ takeProfitPrice: 120, stopLossPrice: 90 });
    const closing = await armedBracket({ takeProfitPrice: 120, stopLossPrice: 90, useClosePosition: true });
    for (const context of [sized, closing]) {
      context.positions.upsert({ symbol: "BTC", netQty: 1, availableQty: 1, avgEntryPrice: 100, markPrice: 100 });
      await context.engine.processPositionUpdate("BTC");
    }
    assert.deepStrictEqual(
      exits(closing.store).map((t) => t.closePosition),
      [true, true],
    );
    assert.deepStrictEqual(
      exits(closing.store).map((t) => t.quantity),
      [undefined, undefined],
    );

    for (const context of [sized, closing]) {
      context.positions.upsert({ symbol: "BTC", netQty: 3, availableQty: 3, avgEntryPrice: 100, markPrice: 100 });
    }
    assert.strictEqual(
      (await sized.engine.processPositionUpdate("BTC")).length,
      2,
      "control: a quantity-sized bracket does follow the fill",
    );
    assert.deepStrictEqual(await closing.engine.processPositionUpdate("BTC"), []);
    assert.deepStrictEqual(
      exits(closing.store).map((t) => t.quantity),
      [undefined, undefined],
    );
  });

  it("creates a stop-limit exit leg when the bracket names a stop limit price", async () => {
    const { store, positions, engine } = await armedBracket({
      takeProfitPrice: 120,
      stopLossPrice: 90,
      stopLimitPrice: 89,
    });
    positions.upsert({ symbol: "BTC", netQty: 1, availableQty: 1, avgEntryPrice: 100, markPrice: 100 });
    await engine.processPositionUpdate("BTC");
    assert.deepStrictEqual(
      exits(store).map((t) => t.kind),
      ["STOP_LIMIT", "TAKE_PROFIT"],
    );
    assert.strictEqual(exits(store)[0].limitPrice, 89);
  });

  it("rejects a bracket whose exit prices are not both positive", async () => {
    for (const bracket of [
      { takeProfitPrice: 120 },
      { stopLossPrice: 90 },
      { takeProfitPrice: 0, stopLossPrice: 90 },
    ]) {
      const { store, positions, engine, events, parent } = await armedBracket(bracket);
      positions.upsert({ symbol: "BTC", netQty: 1, availableQty: 1, avgEntryPrice: 100, markPrice: 100 });
      assert.deepStrictEqual(await engine.processPositionUpdate("BTC"), []);
      assert.deepStrictEqual(events.rejects, [
        { id: parent.id, reason: "Bracket requires positive takeProfitPrice and stopLossPrice" },
      ]);
      assert.deepStrictEqual(exits(store), []);
      assert.strictEqual(store.get(parent.id).meta.bracketChildrenCreated, undefined);
    }

    const ok = await armedBracket({ takeProfitPrice: 120, stopLossPrice: 90 });
    ok.positions.upsert({ symbol: "BTC", netQty: 1, availableQty: 1, avgEntryPrice: 100, markPrice: 100 });
    assert.strictEqual(
      (await ok.engine.processPositionUpdate("BTC")).length,
      2,
      "control: a well-formed bracket does create its exits",
    );
    assert.deepStrictEqual(ok.events.rejects, []);
  });
});

describe("Engine debug tracing", () => {
  const originalLog = console.log;
  const hadDebug = Object.hasOwn(process.env, "TRIGGER_DEBUG");
  const previousDebug = process.env.TRIGGER_DEBUG;

  after(() => {
    console.log = originalLog;
    if (hadDebug) process.env.TRIGGER_DEBUG = previousDebug;
    else delete process.env.TRIGGER_DEBUG;
  });

  it("traces the L2 market, the decision, the submission and the result only when TRIGGER_DEBUG is on", async () => {
    const { store, engine } = rig();
    const quiet = store.add({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 1 });
    const traced = store.add({ kind: "LIMIT", symbol: "ETH", side: "SELL", triggerPrice: 50, quantity: 2 });
    const lines = [];

    try {
      console.log = (...args) => lines.push(args);
      delete process.env.TRIGGER_DEBUG;
      await engine.processTick(l2("BTC", 100));
      assert.strictEqual(store.get(quiet.id).status, "TRIGGERED", "control: the untraced tick did fire");
      assert.deepStrictEqual(lines, [], "nothing is traced while the flag is off");

      process.env.TRIGGER_DEBUG = "true";
      await engine.processTick(l2("ETH", 50));
    } finally {
      console.log = originalLog;
      if (hadDebug) process.env.TRIGGER_DEBUG = previousDebug;
      else delete process.env.TRIGGER_DEBUG;
    }

    assert.strictEqual(store.get(traced.id).status, "TRIGGERED");
    const traces = new Map(lines.map(([tag, payload]) => [tag, payload]));
    assert.deepStrictEqual([...traces.keys()].sort(), [
      "[L2_TRIGGER_MARKET]",
      "[TRIGGER_CHECK]",
      "[TRIGGER_FIRE_SUBMIT_ORDER]",
      "[TRIGGER_ORDER_RESULT]",
    ]);
    assert.strictEqual(traces.get("[L2_TRIGGER_MARKET]").hasEnoughL2Depth, true);
    assert.strictEqual(traces.get("[L2_TRIGGER_MARKET]").selectedL2Price, 50);
    assert.strictEqual(traces.get("[TRIGGER_CHECK]").matched, true);
    assert.strictEqual(traces.get("[TRIGGER_CHECK]").resolvedSide, "SELL");
    assert.strictEqual(traces.get("[TRIGGER_FIRE_SUBMIT_ORDER]").order.clientOrderId, `qt_${traced.id}`);
    assert.strictEqual(traces.get("[TRIGGER_ORDER_RESULT]").result.orderId, "order-2");
    assert.strictEqual(traces.get("[TRIGGER_ORDER_RESULT]").triggerId, traced.id);
  });
});

describe("Engine order resolution", () => {
  it("refuses to size an order with no quantity and no position to read", () => {
    const { store, engine } = rig();
    const closer = store.add({
      kind: "TAKE_PROFIT",
      symbol: "BTC",
      side: "SELL",
      triggerPrice: 120,
      closePosition: true,
    });
    assert.strictEqual(engine.resolveOrder(store.get(closer.id), 120), "No open BTC position to close");
  });

  it("sizes a percentage close off the cached position and keeps it reduce-only", () => {
    const { store, positions, engine } = rig();
    positions.upsert({ symbol: "BTC", netQty: 4, availableQty: 4, markPrice: 100 });
    const half = store.add({
      kind: "TAKE_PROFIT",
      symbol: "BTC",
      side: "SELL",
      triggerPrice: 120,
      closePercentage: 25,
    });
    const order = engine.resolveOrder(store.get(half.id), 120);
    assert.strictEqual(order.quantity, 1);
    assert.strictEqual(order.side, "SELL");
    assert.strictEqual(order.reduceOnly, true);
    assert.strictEqual(order.type, "MARKET");
    assert.strictEqual(order.clientOrderId, `qt_${half.id}`);
  });

  it("refuses a trigger whose own quantity is not positive", () => {
    const { store, engine } = rig();
    const created = store.add({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 1 });
    assert.strictEqual(
      engine.resolveOrder(store.get(created.id), 100).quantity,
      1,
      "control: a sized trigger resolves",
    );
    store.update(created.id, { quantity: 0 });
    assert.strictEqual(engine.resolveOrder(store.get(created.id), 100), "Trigger quantity resolved to zero");
  });

  it("prices a limit order from the trigger and sends the market kinds without a price", () => {
    const { store, engine } = rig();
    const limit = store.add({ kind: "LIMIT", symbol: "BTC", side: "BUY", triggerPrice: 100, quantity: 1 });
    const stopLimit = store.add({
      kind: "STOP_LIMIT",
      symbol: "BTC",
      side: "BUY",
      triggerPrice: 100,
      limitPrice: 101,
      quantity: 1,
    });
    const takeProfit = store.add({ kind: "TAKE_PROFIT", symbol: "BTC", side: "SELL", triggerPrice: 120, quantity: 1 });

    assert.deepStrictEqual(
      [limit, stopLimit, takeProfit].map((t) => {
        const order = engine.resolveOrder(store.get(t.id), 100);
        return [order.type, order.price];
      }),
      [
        ["LIMIT", 100],
        ["LIMIT", 101],
        ["MARKET", undefined],
      ],
    );
  });
});
