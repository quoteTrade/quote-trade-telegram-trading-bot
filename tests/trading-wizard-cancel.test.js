"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { describe, it } = require("node:test");
const { runInNewContext } = require("node:vm");
const keyboards = require("../dist/constant/message");

// Exercise the compiled Cancel branch without importing the Telegram entry
// point, constructing its stores, or starting any network clients.
const compiledBot = readFileSync(require.resolve("../dist/bot"), "utf8");
const start = compiledBot.indexOf('if (data === "trade_cancel") {');
const end = compiledBot.indexOf('if (data.startsWith("trade_select:")) {', start);
assert.ok(start >= 0 && end > start, "the compiled wizard Cancel branch must be present");
const cancelHandler = runInNewContext(
  `(async ({ tradingWizards, ownerId, chatId, sendWithOptions }) => {
    const data = "trade_cancel";
    ${compiledBot.slice(start, end)}
  })`,
  { message_1: keyboards },
);

async function cancelWizard(command, step = "parameters") {
  const state = { command, step, startedAt: Date.now() };
  const otherState = { command: "market", step: "parameters", startedAt: Date.now() };
  const tradingWizards = new Map([
    ["owner", state],
    ["other-owner", otherState],
  ]);
  const replies = [];
  assert.equal(tradingWizards.get("owner"), state, "establish an active wizard before cancelling");
  await cancelHandler({
    tradingWizards,
    ownerId: "owner",
    chatId: 123,
    sendWithOptions: async (chatId, text, options) => replies.push({ chatId, text, options }),
  });
  assert.equal(replies.length, 1, "Cancel must produce one reply");
  assert.equal(replies[0].chatId, 123);
  assert.equal(tradingWizards.has("owner"), false, "Cancel clears the active wizard");
  assert.equal(tradingWizards.get("other-owner"), otherState, "another user's wizard is unchanged");
  return replies[0];
}

describe("trading wizard cancellation", () => {
  it("cancels market parameter entry with market wording and returns to Trading", async () => {
    const reply = await cancelWizard("market");
    assert.equal(reply.text, "Market order cancelled.");
    assert.equal(reply.options.reply_markup, keyboards.TRADING_KEYBOARD);
  });

  it("keeps trigger wording and the strategy menu when cancelling trigger parameters", async () => {
    const reply = await cancelWizard("limit");
    assert.equal(reply.text, "Trigger creation cancelled.");
    assert.equal(reply.options.reply_markup, keyboards.TRIGGER_CREATE_KEYBOARD);
  });

  it("keeps trigger cancellation behaviour at the trigger confirmation step", async () => {
    const reply = await cancelWizard("stoploss", "confirm");
    assert.equal(reply.text, "Trigger creation cancelled.");
    assert.equal(reply.options.reply_markup, keyboards.TRIGGER_CREATE_KEYBOARD);
  });
});
