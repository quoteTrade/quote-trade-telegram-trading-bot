"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { tempFile, cleanupTempDirs } = require("./helpers/tmp");
const { formatTrigger, formatTriggers, formatRisk, parsePage, formatOrderPage } = require("../dist/triggers/format");
const { PositionStore } = require("../dist/triggers/position-store");

after(cleanupTempDirs);

/**
 * The smallest trigger the formatter accepts: the five leading pieces plus a
 * trigger price, and none of the optional detail fields. Cases that assert a
 * detail is absent use this as their control shape.
 */
function trigger(overrides) {
  return {
    id: "trg_1",
    ownerId: "owner-1",
    status: "ACTIVE",
    kind: "LIMIT",
    symbol: "BTC",
    side: "BUY",
    triggerPrice: 100,
    ...overrides,
  };
}

/** The `pieces` prefix, which is five space-free tokens before the details. */
function pieces(text) {
  return text.split(" ").slice(0, 5);
}

/** A trigger with every optional detail field populated. */
function kitchenSink() {
  return trigger({
    kind: "TRAILING_STOP_LIMIT",
    side: "SELL",
    status: "SUBMITTING",
    limitPrice: 90,
    lowerPrice: 80,
    upperPrice: 120,
    priceBandMode: "BREAKOUT",
    trailValue: 5,
    trailMode: "PERCENT",
    currentStopPrice: 95,
    highWaterMark: 130,
    lowWaterMark: 70,
    breakEvenArmed: true,
    activationValue: 3,
    activationMode: "PERCENT",
    lockValue: 2,
    lockMode: "PERCENT",
    triggerAt: Date.UTC(2024, 0, 2, 3, 4, 5),
    cancelTriggerId: "trg_other",
    cancelGroupId: "grp_other",
    riskMetric: "MAX_RISK_USD",
    riskThreshold: 1000,
    riskAction: "CLOSE_POSITION",
    quantity: 0.5,
    ocoGroupId: "oco_1",
    lastCheckedPrice: 101,
    clientOrderId: "cli_1",
    orderId: "ord_1",
    error: "rejected by venue",
    meta: { bracketAwaitingPosition: true, bracketChildrenCreated: true },
  });
}

/** A page envelope shaped like the order-history pager returns. */
function page(items, overrides) {
  return { items, page: 1, pageSize: 10, total: items.length, totalPages: 1, ...overrides };
}

describe("formatTrigger identity", () => {
  it("leads with id, status, kind, symbol and side in that order", () => {
    const text = formatTrigger(
      trigger({ id: "trg_abc", status: "TRIGGERED", kind: "STOP_LOSS", symbol: "ETH", side: "SELL" }),
    );

    assert.deepEqual(pieces(text), ["trg_abc", "TRIGGERED", "STOP_LOSS", "ETH", "SELL"]);
  });

  it("renders every populated detail field for a fully specified trigger", () => {
    const text = formatTrigger(kitchenSink());

    for (const token of [
      "target=95",
      "trigger=100",
      "limit=90",
      "lower=80",
      "upper=120",
      "band=BREAKOUT",
      "trail=5%",
      "stop=95",
      "high=130",
      "low=70",
      "armed=true",
      "bracket=awaiting-position",
      "bracket=exits-created",
      "after=3%",
      "lock=2%",
      "at=2024-01-02T03:04:05.000Z",
      "cancel=trg_other",
      "cancelGroup=grp_other",
      "risk=MAX_RISK_USD:1000",
      "action=CLOSE_POSITION",
      "direction=BELOW",
      "qty=0.5",
      "oco=oco_1",
      "checked=101",
      "order=cli_1",
      "error=rejected by venue",
    ]) {
      assert.ok(text.includes(` ${token}`), `expected ${token} in: ${text}`);
    }
  });

  it("omits every optional detail field a trigger does not carry", () => {
    const minimal = formatTrigger(trigger());
    const full = formatTrigger(kitchenSink());

    for (const prefix of [
      "limit=",
      "lower=",
      "upper=",
      "band=",
      "trail=",
      "stop=",
      "high=",
      "low=",
      "armed=",
      "bracket=",
      "after=",
      "lock=",
      "at=",
      "cancel=",
      "cancelGroup=",
      "risk=",
      "action=",
      "qty=",
      "oco=",
      "checked=",
      "order=",
      "error=",
    ]) {
      // Positive control: the same prefix is emitted when the field is present,
      // so the absence below is the formatter's choice, not a typo.
      assert.ok(full.includes(` ${prefix}`), `control failed for ${prefix}: ${full}`);
      assert.ok(!minimal.includes(` ${prefix}`), `unexpected ${prefix} in: ${minimal}`);
    }

    assert.equal(minimal, "trg_1 ACTIVE LIMIT BTC BUY target=100 trigger=100 direction=BELOW");
  });
});

describe("formatTrigger quantity variants", () => {
  it("renders close-position triggers as qty=close-position", () => {
    const text = formatTrigger(trigger({ closePosition: true }));

    assert.ok(text.includes(" qty=close-position"), text);
  });

  it("renders a close percentage as a percent-of-position quantity", () => {
    const text = formatTrigger(trigger({ closePercentage: 25 }));

    assert.ok(text.includes(" qty=25% position"), text);
  });

  it("renders an explicit quantity as the plain number", () => {
    const text = formatTrigger(trigger({ quantity: 1.75 }));

    assert.ok(text.includes(" qty=1.75"), text);
  });

  it("prefers close-position over both a close percentage and an explicit quantity", () => {
    const text = formatTrigger(trigger({ closePosition: true, closePercentage: 50, quantity: 3 }));

    assert.ok(text.includes(" qty=close-position"), text);
    assert.ok(!text.includes("% position"), text);
    assert.ok(!text.includes(" qty=3"), text);
  });

  it("prefers a close percentage over an explicit quantity", () => {
    const text = formatTrigger(trigger({ closePercentage: 50, quantity: 3 }));

    assert.ok(text.includes(" qty=50% position"), text);
    assert.ok(!text.includes(" qty=3"), text);
  });

  it("keeps a zero close percentage instead of treating it as unset", () => {
    const text = formatTrigger(trigger({ closePercentage: 0, quantity: 3 }));

    assert.ok(text.includes(" qty=0% position"), text);
  });

  it("keeps a zero quantity instead of dropping it as falsy", () => {
    const text = formatTrigger(trigger({ quantity: 0 }));

    assert.ok(text.includes(" qty=0"), text);
  });

  it("drops the quantity field when the quantity is blank or persisted as null", () => {
    const withQty = formatTrigger(trigger({ quantity: 2 }));

    assert.ok(withQty.includes(" qty=2"), withQty);
    for (const quantity of ["", null, undefined]) {
      const text = formatTrigger(trigger({ quantity }));
      assert.ok(!text.includes(" qty="), `unexpected qty for ${String(quantity)}: ${text}`);
    }
  });
});

describe("formatTrigger price targets", () => {
  it("takes the target from the trigger price for a limit trigger", () => {
    const text = formatTrigger(trigger({ triggerPrice: 123.5 }));

    assert.ok(text.includes(" target=123.5"), text);
    assert.ok(text.includes(" trigger=123.5"), text);
  });

  it("omits the target and trigger price for a time-based trigger that has neither", () => {
    const priced = formatTrigger(trigger({ kind: "TIME_CANCEL", triggerPrice: 100, triggerAt: Date.UTC(2030, 0, 1) }));
    const timed = formatTrigger(
      trigger({ kind: "TIME_CANCEL", triggerPrice: undefined, triggerAt: Date.UTC(2030, 0, 1) }),
    );

    assert.ok(priced.includes(" target=100") && priced.includes(" trigger=100"), priced);
    assert.ok(!timed.includes(" target=") && !timed.includes(" trigger="), timed);
    assert.ok(timed.includes(" at=2030-01-01T00:00:00.000Z"), timed);
  });

  it("prefers the current stop over the trigger price for a trailing stop", () => {
    const trailing = formatTrigger(trigger({ kind: "TRAILING_STOP", triggerPrice: 100, currentStopPrice: 97 }));
    const unarmed = formatTrigger(trigger({ kind: "TRAILING_STOP", triggerPrice: 100 }));

    assert.ok(trailing.includes(" target=97"), trailing);
    assert.ok(unarmed.includes(" target=100"), unarmed);
  });

  it("marks an absolute trail without a percent sign and a percent trail with one", () => {
    const absolute = formatTrigger(trigger({ kind: "TRAILING_STOP", trailValue: 5, trailMode: "AMOUNT" }));
    const percent = formatTrigger(trigger({ kind: "TRAILING_STOP", trailValue: 5, trailMode: "PERCENT" }));

    assert.ok(absolute.includes(" trail=5 "), absolute);
    assert.ok(percent.includes(" trail=5%"), percent);
  });

  it("targets the upper band for a breakout buy and the lower band for a reversion buy", () => {
    const breakout = formatTrigger(
      trigger({ kind: "PRICE_BAND", priceBandMode: "BREAKOUT", lowerPrice: 80, upperPrice: 120 }),
    );
    const reversion = formatTrigger(
      trigger({ kind: "PRICE_BAND", priceBandMode: "REVERSION", lowerPrice: 80, upperPrice: 120 }),
    );

    assert.ok(breakout.includes(" target=120"), breakout);
    assert.ok(breakout.includes(" direction=ABOVE"), breakout);
    assert.ok(reversion.includes(" target=80"), reversion);
    assert.ok(reversion.includes(" direction=BELOW"), reversion);
  });

  it("renders the limit price for a stop-limit trigger", () => {
    const text = formatTrigger(trigger({ kind: "STOP_LIMIT", limitPrice: 99 }));

    assert.ok(text.includes(" limit=99"), text);
    assert.ok(text.includes(" direction=ABOVE"), text);
  });

  it("reports the derived direction per kind and side", () => {
    const directionOf = (kind, side) => {
      const match = /direction=(\w+)/.exec(formatTrigger(trigger({ kind, side })));
      return match ? match[1] : undefined;
    };

    assert.equal(directionOf("LIMIT", "BUY"), "BELOW");
    assert.equal(directionOf("LIMIT", "SELL"), "ABOVE");
    assert.equal(directionOf("STOP_LOSS", "BUY"), "ABOVE");
    assert.equal(directionOf("STOP_LOSS", "SELL"), "BELOW");
    assert.equal(directionOf("TAKE_PROFIT", "BUY"), "BELOW");
    assert.equal(directionOf("BREAK_EVEN_STOP", "SELL"), "BELOW");
  });

  it("omits the direction for a time-based trigger that has no price direction", () => {
    const timed = formatTrigger(trigger({ kind: "TIME_CANCEL" }));
    const priced = formatTrigger(trigger({ kind: "LIMIT" }));

    assert.ok(priced.includes(" direction="), priced);
    assert.ok(!timed.includes(" direction="), timed);
  });
});

describe("formatTrigger annotations", () => {
  it("renders an absolute activation offset without a percent sign and a percent one with it", () => {
    const absolute = formatTrigger(trigger({ activationValue: 4, activationMode: "AMOUNT" }));
    const percent = formatTrigger(trigger({ activationValue: 4, activationMode: "PERCENT" }));

    assert.ok(absolute.includes(" after=4 "), absolute);
    assert.ok(percent.includes(" after=4%"), percent);
  });

  it("keeps a zero lock value, which means break even exactly at entry", () => {
    const zero = formatTrigger(trigger({ kind: "BREAK_EVEN_STOP", lockValue: 0 }));
    const percent = formatTrigger(trigger({ kind: "BREAK_EVEN_STOP", lockValue: 10, lockMode: "PERCENT" }));

    assert.ok(zero.includes(" lock=0"), zero);
    assert.ok(percent.includes(" lock=10%"), percent);
  });

  it("renders the break-even armed flag only once the stop is armed", () => {
    const armed = formatTrigger(trigger({ kind: "BREAK_EVEN_STOP", breakEvenArmed: true }));
    const idle = formatTrigger(trigger({ kind: "BREAK_EVEN_STOP", breakEvenArmed: false }));

    assert.ok(armed.includes(" armed=true"), armed);
    assert.ok(!idle.includes(" armed="), idle);
  });

  it("distinguishes a bracket waiting for its position from one whose exits exist", () => {
    const waiting = formatTrigger(trigger({ meta: { bracketAwaitingPosition: true } }));
    const created = formatTrigger(trigger({ meta: { bracketChildrenCreated: true } }));

    assert.ok(waiting.includes(" bracket=awaiting-position"), waiting);
    assert.ok(!waiting.includes("exits-created"), waiting);
    assert.ok(created.includes(" bracket=exits-created"), created);
    assert.ok(!created.includes("awaiting-position"), created);
  });

  it("renders the trigger time as an ISO timestamp", () => {
    const text = formatTrigger(trigger({ kind: "TIME_CLOSE", triggerAt: Date.UTC(2030, 5, 7, 8, 9, 10) }));

    assert.ok(text.includes(" at=2030-06-07T08:09:10.000Z"), text);
  });

  it("renders the risk metric together with its threshold and action", () => {
    const text = formatTrigger(
      trigger({ kind: "RISK_GUARD", riskMetric: "MAX_LOSS_USD", riskThreshold: 250, riskAction: "ALERT" }),
    );

    assert.ok(text.includes(" risk=MAX_LOSS_USD:250"), text);
    assert.ok(text.includes(" action=ALERT"), text);
  });

  it("prefers the client order id over the exchange order id", () => {
    const both = formatTrigger(trigger({ clientOrderId: "cli_9", orderId: "ord_9" }));
    const exchangeOnly = formatTrigger(trigger({ orderId: "ord_9" }));

    assert.ok(both.includes(" order=cli_9"), both);
    assert.ok(!both.includes("ord_9"), both);
    assert.ok(exchangeOnly.includes(" order=ord_9"), exchangeOnly);
  });

  it("renders the cancellation targets and the OCO group id", () => {
    const text = formatTrigger(trigger({ cancelTriggerId: "trg_x", cancelGroupId: "grp_x", ocoGroupId: "oco_x" }));

    assert.ok(text.includes(" cancel=trg_x"), text);
    assert.ok(text.includes(" cancelGroup=grp_x"), text);
    assert.ok(text.includes(" oco=oco_x"), text);
  });

  it("renders the last error last, keeping its whole message", () => {
    const text = formatTrigger(trigger({ error: "insufficient margin for reduce-only order" }));

    assert.ok(text.endsWith(" error=insufficient margin for reduce-only order"), text);
  });

  it("adds no markup of its own and never drops user text containing HTML metacharacters", () => {
    // These lines are delivered as plain text (no parse_mode), so the formatter
    // must neither introduce tags nor swallow the operator-visible message.
    const text = formatTrigger(trigger({ symbol: 'B<T>C&"X"', error: '<b>boom</b> & "quotes"' }));

    assert.ok(text.includes("boom"), text);
    assert.ok(text.includes("quotes"), text);
    assert.ok(text.includes('B<T>C&"X"') || text.includes("B&lt;T&gt;C&amp;&quot;X&quot;"), text);
    assert.ok(!/<\/?(?:b|i|u|s|code|pre|a)\b/i.test(text.replace("<b>boom</b>", "")), text);
  });
});

describe("formatTriggers", () => {
  it("renders one line per trigger, in the order given", () => {
    const text = formatTriggers([trigger({ id: "trg_a" }), trigger({ id: "trg_b", symbol: "ETH" })]);
    const lines = text.split("\n");

    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith("trg_a "), lines[0]);
    assert.ok(lines[1].startsWith("trg_b "), lines[1]);
    assert.ok(lines[1].includes(" ETH "), lines[1]);
  });

  it("reports that no triggers were found for an empty list", () => {
    assert.equal(formatTriggers([]), "No triggers found.");
  });
});

describe("formatRisk", () => {
  /** A store on its own throwaway file, so cases never share cached positions. */
  function store() {
    return new PositionStore(tempFile("positions.json", "qt-format-test-"));
  }

  it("sums the cached position risk and appends the per-position breakdown", () => {
    const positions = store();
    positions.upsert({ symbol: "BTC", netQty: 2, markPrice: 100 });
    positions.upsert({ symbol: "ETH", netQty: -1.5, avgEntryPrice: 20 });

    const text = formatRisk(positions);
    const lines = text.split("\n");

    assert.equal(lines[0], "Cached gross position risk: $230.00");
    assert.ok(lines[1].startsWith("BTC: net=2 available=2 mark=100 riskUsd=200.00"), lines[1]);
    assert.ok(lines[2].startsWith("ETH: net=-1.5 available=-1.5 avg=20 riskUsd=30.00"), lines[2]);
  });

  it("reports zero risk and the empty-cache hint when no positions are cached", () => {
    const text = formatRisk(store());

    assert.equal(
      text,
      "Cached gross position risk: $0.00\nNo positions cached yet. Run positions:refresh or start the watcher to receive account updates.",
    );
  });
});

describe("parsePage", () => {
  it("defaults to the first page when no page argument was given", () => {
    assert.equal(parsePage([]), 1);
    assert.equal(parsePage([""]), 1);
  });

  it("parses an explicit page number", () => {
    assert.equal(parsePage(["3"]), 3);
  });

  it("ignores any argument after the page number", () => {
    assert.equal(parsePage(["2", "ignored"]), 2);
  });

  it("floors a fractional page number", () => {
    assert.equal(parsePage(["2.9"]), 2);
  });

  it("rejects zero, negative and non-numeric pages", () => {
    for (const raw of ["0", "-1", "abc", "NaN"]) {
      assert.throws(() => parsePage([raw]), /Page must be a positive number/, `accepted ${raw}`);
    }
  });
});

describe("formatOrderPage with no cached orders", () => {
  it("names the empty collection using the lowercased title and points at the watcher", () => {
    const text = formatOrderPage("Recent fills", page([]), "filledorders");

    assert.equal(text, "No recent fills cached yet.\nAccount/order watcher started. Try again in a few seconds.");
  });

  it("adds the syncing note to the empty page only while history is syncing", () => {
    const syncing = formatOrderPage("Recent fills", page([]), "filledorders", true);
    const settled = formatOrderPage("Recent fills", page([]), "filledorders", false);

    assert.ok(syncing.endsWith("\nOrder history is still syncing."), syncing);
    assert.ok(!settled.includes("syncing"), settled);
  });
});

describe("formatOrderPage paging", () => {
  const order = (overrides) => ({
    symbol: "BTC",
    side: "BUY",
    type: "2",
    status: "2",
    quantity: 1,
    price: 10,
    orderId: "o1",
    ...overrides,
  });

  it("heads the page with the page number, page count and total", () => {
    const text = formatOrderPage(
      "Recent fills",
      page([order()], { page: 2, totalPages: 4, total: 37 }),
      "filledorders",
    );
    const lines = text.split("\n");

    assert.equal(lines[0], "Recent fills page 2/4 total=37");
    assert.equal(lines[1], "");
  });

  it("numbers rows continuously across pages using the page size", () => {
    const items = [order({ orderId: "o6" }), order({ orderId: "o7" })];
    const text = formatOrderPage(
      "Recent fills",
      page(items, { page: 2, pageSize: 5, total: 7, totalPages: 2 }),
      "filledorders",
    );
    const lines = text.split("\n");

    assert.ok(lines[2].startsWith("6. "), lines[2]);
    assert.ok(lines[3].startsWith("7. "), lines[3]);
  });

  it("advertises the next page only when one exists", () => {
    const more = formatOrderPage("Recent fills", page([order()], { page: 1, totalPages: 3 }), "filledorders");
    const last = formatOrderPage("Recent fills", page([order()], { page: 3, totalPages: 3 }), "filledorders");

    assert.ok(more.endsWith("Use /filledorders 2 for next page."), more);
    assert.ok(!last.includes("for next page"), last);
  });

  it("uses the command name it was given in the next-page hint", () => {
    const text = formatOrderPage("Recent orders", page([order()], { page: 1, totalPages: 2 }), "orders");

    assert.ok(text.includes("Use /orders 2 for next page."), text);
  });

  it("appends the retry advice to a populated page while history is syncing", () => {
    const syncing = formatOrderPage("Recent fills", page([order()]), "filledorders", true);
    const settled = formatOrderPage("Recent fills", page([order()]), "filledorders", false);

    assert.ok(
      syncing.endsWith("Order history is still syncing. Run this command again in a few seconds for latest results."),
      syncing,
    );
    assert.ok(!settled.includes("syncing"), settled);
  });
});

describe("formatOrderPage order lines", () => {
  /** The single rendered row for one order. */
  function line(order) {
    return formatOrderPage("Recent fills", page([order]), "filledorders").split("\n")[2];
  }

  it("renders symbol, side, type, status, quantity, price and id in that order", () => {
    const text = line({
      symbol: "ETH",
      side: "SELL",
      orderType: "1",
      ordStatus: "2",
      quantity: 3,
      price: 42,
      orderId: "ord_7",
    });

    assert.equal(text, "1. ETH SELL MARKET FILLED qty=3 price=42 id=ord_7");
  });

  it("maps the numeric order types to their names", () => {
    assert.ok(line({ orderType: "1" }).includes(" MARKET "), "type 1 is MARKET");
    assert.ok(line({ orderType: "2" }).includes(" LIMIT "), "type 2 is LIMIT");
  });

  it("passes an unrecognised order type through unchanged", () => {
    assert.ok(line({ orderType: "STOP_MARKET" }).includes(" STOP_MARKET "), "unknown type is passed through");
  });

  it("shows a dash when the order carries no type at all", () => {
    assert.equal(line({ symbol: "BTC", side: "BUY", ordStatus: "0" }), "1. BTC BUY - NEW qty=- price=- id=-");
  });

  it("falls back from orderType to ordType to type when reading the order type", () => {
    assert.ok(line({ orderType: "1", ordType: "2", type: "2" }).includes(" MARKET "), "orderType wins");
    assert.ok(line({ ordType: "1", type: "2" }).includes(" MARKET "), "ordType beats type");
    assert.ok(line({ type: "1" }).includes(" MARKET "), "type is the last source");
  });

  it("maps every numeric order status to its name", () => {
    assert.ok(line({ ordStatus: "0" }).includes(" NEW "), "status 0 is NEW");
    assert.ok(line({ ordStatus: "1" }).includes(" PARTIAL "), "status 1 is PARTIAL");
    assert.ok(line({ ordStatus: "2" }).includes(" FILLED "), "status 2 is FILLED");
    assert.ok(line({ ordStatus: "4" }).includes(" CANCELED "), "status 4 is CANCELED");
    assert.ok(line({ ordStatus: "8" }).includes(" REJECTED "), "status 8 is REJECTED");
  });

  it("maps a numeric zero status to NEW rather than treating it as missing", () => {
    assert.ok(line({ ordStatus: 0, status: "8" }).includes(" NEW "), "numeric 0 is NEW");
  });

  it("passes an unrecognised status code through unchanged", () => {
    assert.ok(line({ ordStatus: "9" }).includes(" 9 "), "unknown status is passed through");
  });

  it("prefers ordStatus over status when both are present", () => {
    assert.ok(line({ ordStatus: "2", status: "4" }).includes(" FILLED "), "ordStatus wins");
    assert.ok(line({ status: "4" }).includes(" CANCELED "), "status is the fallback");
  });

  it("reports the filled quantity when part of the order has traded", () => {
    assert.ok(line({ cumQty: 0.4, quantity: 1 }).includes(" qty=0.4 "), "cumQty wins when positive");
  });

  it("reports the ordered quantity while nothing has filled yet", () => {
    assert.ok(line({ cumQty: "0", quantity: 1 }).includes(" qty=1 "), "zero cumQty falls back");
    assert.ok(line({ quantity: 1 }).includes(" qty=1 "), "missing cumQty falls back");
  });

  it("shows a dash when neither a filled nor an ordered quantity is known", () => {
    assert.ok(line({ price: 1 }).includes(" qty=- "), "no quantity at all");
  });

  it("walks the price fallback chain from fill price down to the order price", () => {
    assert.ok(line({ fillPrice: 11, avgPx: 12, lastPx: 13, price: 14 }).includes(" price=11 "), "fillPrice wins");
    assert.ok(line({ avgPx: 12, lastPx: 13, price: 14 }).includes(" price=12 "), "avgPx is next");
    assert.ok(line({ lastPx: 13, price: 14 }).includes(" price=13 "), "lastPx is next");
    assert.ok(line({ price: 14 }).includes(" price=14 "), "price is last");
    assert.ok(line({ quantity: 1 }).includes(" price=- "), "no price at all");
  });

  it("prefers the exchange order id and falls back to the client order id", () => {
    assert.ok(line({ orderId: "ord_1", clientOrderId: "cli_1" }).endsWith(" id=ord_1"), "orderId wins");
    assert.ok(line({ clientOrderId: "cli_1" }).endsWith(" id=cli_1"), "clientOrderId is the fallback");
    assert.ok(line({ quantity: 1 }).endsWith(" id=-"), "no id at all");
  });
});
