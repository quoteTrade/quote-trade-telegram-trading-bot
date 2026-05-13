import TelegramBot from "node-telegram-bot-api";
import * as dotenv from "dotenv";
dotenv.config();

import { START_MESSAGE } from "./constant/message";
import { BotService } from "./bot.service";
import { PositionStore } from "./triggers/position-store";
import { TriggerStore } from "./triggers/trigger-store";
import { TriggerEngine } from "./triggers/trigger-engine";
import { TriggerRuntime } from "./trigger-runtime";
import { formatRisk, formatTriggers } from "./triggers/format";
import { asNumber, escapeLong, parseWords } from "./bot.utils";
import { makeGroupId, normalizeSide, normalizeSymbol, parseAmountOrPercent, parseTimeOrDuration, TriggerInput } from "./triggers/types";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
const bot = new TelegramBot(token, { polling: true });

const positions = new PositionStore();
const triggers = new TriggerStore();
const service = new BotService(positions);
const engine = new TriggerEngine(triggers, positions, service, {
  onTrigger: (t, o) => void notifyOwner(t.ownerId, `✅ Trigger fired ${t.id}: submitted ${o.type} ${o.side} ${o.symbol} qty=${o.quantity}${o.price ? ` limit=${o.price}` : ""}`),
  onReject: (t, r) => void notifyOwner(t.ownerId, `❌ Trigger rejected ${t.id}: ${r}`),
  onError: (t, e: any) => void notifyOwner(t.ownerId, `❌ Trigger error ${t.id}: ${e?.message ?? e}`),
  onAction: (t, m) => void notifyOwner(t.ownerId, `⚙️ ${t.id}: ${m}`),
});
const runtime = new TriggerRuntime(triggers, positions, engine, (m) => console.log(m));
runtime.ensure();

async function notifyOwner(ownerId: string, text: string): Promise<void> {
  if (!ownerId || ownerId === "default") {
    console.log(text);
    return;
  }
  await bot.sendMessage(ownerId, escapeLong(text)).catch(() => undefined);
}

function send(chatId: any, text: string): Promise<any> { return bot.sendMessage(chatId, escapeLong(text)); }
function command(handler: (chatId: any, words: string[], raw: string) => Promise<string> | string): (msg: any, match: RegExpExecArray | null) => void {
  return (msg, match) => {
    const chatId = msg.chat.id;
    const raw = match?.[0] ?? msg.text ?? "";
    const words = parseWords(raw).slice(1);
    Promise.resolve(handler(chatId, words, raw)).then((t) => send(chatId, t)).catch((e: any) => send(chatId, `❌ ${e?.message ?? e}`));
  };
}

function parsePercent(raw: string): number {
  const n = asNumber(String(raw).replace(/%$/, ""), "percent");
  if (n > 100) throw new Error("percent must be <= 100");
  return n;
}

function sizingFromWord(raw?: string): Pick<TriggerInput, "quantity" | "closePosition" | "closePercentage"> {
  if (!raw || ["close", "all", "position"].includes(raw.toLowerCase())) return { closePosition: true };
  if (raw.endsWith("%")) return { closePercentage: parsePercent(raw) };
  return { quantity: asNumber(raw, "quantity") };
}

function defaultCloseSide(symbol: string, sideRaw?: string): any {
  return sideRaw ? normalizeSide(sideRaw) : positions.getCloseSide(symbol) ?? "SELL";
}

function created(list: any | any[]): string {
  const triggersList = Array.isArray(list) ? list : [list];
  for (const t of triggersList) {
    if (t.kind !== "TIME_CLOSE" && t.kind !== "TIME_CANCEL") runtime.watchSymbol(t.symbol);
  }
  return `Created trigger${triggersList.length > 1 ? "s" : ""}:\n${formatTriggers(triggersList)}`;
}

bot.onText(/^\/start\b/i, command(async () => START_MESSAGE));

bot.onText(/^\/limit\b.*/i, command(async (chatId, words) => {
  if (words.length < 4) throw new Error("Usage: /limit BTC BUY 60000 0.01|close|25%");
  const [symbolRaw, sideRaw, priceRaw, qtyRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  return created(triggers.add({ ownerId: String(chatId), kind: "LIMIT", symbol, side: normalizeSide(sideRaw), triggerPrice: asNumber(priceRaw, "price"), ...sizingFromWord(qtyRaw), paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/stoplimit\b.*/i, command(async (chatId, words) => {
  if (words.length < 5) throw new Error("Usage: /stoplimit BTC SELL 58000 57950 0.01|close|25%");
  const [symbolRaw, sideRaw, stopRaw, limitRaw, qtyRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  return created(triggers.add({ ownerId: String(chatId), kind: "STOP_LIMIT", symbol, side: normalizeSide(sideRaw), triggerPrice: asNumber(stopRaw, "stop"), limitPrice: asNumber(limitRaw, "limit"), ...sizingFromWord(qtyRaw), paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/takeprofit\b.*/i, command(async (chatId, words) => {
  if (words.length < 3) throw new Error("Usage: /takeprofit BTC SELL 65000 0.01|close|25%");
  const [symbolRaw, sideRaw, priceRaw, qtyRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  return created(triggers.add({ ownerId: String(chatId), kind: "TAKE_PROFIT", symbol, side: defaultCloseSide(symbol, sideRaw), triggerPrice: asNumber(priceRaw, "price"), ...sizingFromWord(qtyRaw), paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/stoploss\b.*/i, command(async (chatId, words) => {
  if (words.length < 3) throw new Error("Usage: /stoploss BTC SELL 58000 0.01|close|25%");
  const [symbolRaw, sideRaw, priceRaw, qtyRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  return created(triggers.add({ ownerId: String(chatId), kind: "STOP_LOSS", symbol, side: defaultCloseSide(symbol, sideRaw), triggerPrice: asNumber(priceRaw, "price"), ...sizingFromWord(qtyRaw), paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/trailingstop\b.*/i, command(async (chatId, words) => {
  if (words.length < 4) throw new Error("Usage: /trailingstop BTC SELL 5% 0.01|close|25%");
  const [symbolRaw, sideRaw, trailRaw, qtyRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  const trail = parseAmountOrPercent(trailRaw);
  return created(triggers.add({ ownerId: String(chatId), kind: "TRAILING_STOP", symbol, side: defaultCloseSide(symbol, sideRaw), trailMode: trail.mode, trailValue: trail.value, ...sizingFromWord(qtyRaw), paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/trailingstoplimit\b.*/i, command(async (chatId, words) => {
  if (words.length < 5) throw new Error("Usage: /trailingstoplimit BTC SELL 5% 50 0.01|close|25%");
  const [symbolRaw, sideRaw, trailRaw, offsetRaw, qtyRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  const trail = parseAmountOrPercent(trailRaw);
  return created(triggers.add({ ownerId: String(chatId), kind: "TRAILING_STOP_LIMIT", symbol, side: defaultCloseSide(symbol, sideRaw), trailMode: trail.mode, trailValue: trail.value, limitOffset: asNumber(offsetRaw, "limitOffset"), ...sizingFromWord(qtyRaw), paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/oco\b.*/i, command(async (chatId, words) => {
  if (words.length < 5) throw new Error("Usage: /oco BTC SELL 65000 58000 0.01|close|25% [stopLimit]");
  const [symbolRaw, sideRaw, takeProfitRaw, stopLossRaw, qtyRaw, stopLimitRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  const side = defaultCloseSide(symbol, sideRaw);
  const sizing = sizingFromWord(qtyRaw);
  const groupId = makeGroupId("oco");
  const childInputs: TriggerInput[] = [
    { ownerId: String(chatId), kind: "TAKE_PROFIT", symbol, side, triggerPrice: asNumber(takeProfitRaw, "takeProfit"), ...sizing, paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" },
    stopLimitRaw
      ? { ownerId: String(chatId), kind: "STOP_LIMIT", symbol, side, triggerPrice: asNumber(stopLossRaw, "stopLoss"), limitPrice: asNumber(stopLimitRaw, "stopLimit"), ...sizing, paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }
      : { ownerId: String(chatId), kind: "STOP_LOSS", symbol, side, triggerPrice: asNumber(stopLossRaw, "stopLoss"), ...sizing, paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" },
  ];
  return created(triggers.addOco(childInputs, groupId));
}));

bot.onText(/^\/bracket\b.*/i, command(async (chatId, words) => {
  if (words.length < 6) throw new Error("Usage: /bracket BTC BUY 60000 0.01 65000 58000 [57950]");
  const [symbolRaw, sideRaw, entryRaw, qtyRaw, takeProfitRaw, stopLossRaw, stopLimitRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  return created(triggers.add({
    ownerId: String(chatId),
    kind: "LIMIT",
    symbol,
    side: normalizeSide(sideRaw),
    triggerPrice: asNumber(entryRaw, "entry"),
    ...sizingFromWord(qtyRaw),
    paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
    meta: { bracket: { takeProfitPrice: asNumber(takeProfitRaw, "takeProfit"), stopLossPrice: asNumber(stopLossRaw, "stopLoss"), stopLimitPrice: stopLimitRaw ? asNumber(stopLimitRaw, "stopLimit") : undefined } },
  }));
}));

bot.onText(/^\/scaleout\b.*/i, command(async (chatId, words) => {
  if (words.length < 4) throw new Error("Usage: /scaleout BTC SELL 63000 25%");
  const [symbolRaw, sideRaw, priceRaw, percentRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  return created(triggers.add({ ownerId: String(chatId), kind: "TAKE_PROFIT", symbol, side: defaultCloseSide(symbol, sideRaw), triggerPrice: asNumber(priceRaw, "price"), closePercentage: parsePercent(percentRaw), reduceOnly: true, paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD", meta: { strategy: "SCALE_OUT" } }));
}));

bot.onText(/^\/breakeven\b.*/i, command(async (chatId, words) => {
  if (words.length < 3) throw new Error("Usage: /breakeven BTC SELL 3% [plus]");
  const [symbolRaw, sideRaw, afterRaw, plusRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  const after = parseAmountOrPercent(afterRaw);
  const plus = plusRaw ? parseAmountOrPercent(plusRaw) : { mode: "AMOUNT" as const, value: 0 };
  return created(triggers.add({ ownerId: String(chatId), kind: "BREAK_EVEN_STOP", symbol, side: defaultCloseSide(symbol, sideRaw), activationMode: after.mode, activationValue: after.value, lockMode: plus.mode, lockValue: plus.value, closePosition: true, reduceOnly: true, paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/closeafter\b.*/i, command(async (chatId, words) => {
  if (words.length < 2) throw new Error("Usage: /closeafter BTC 4h");
  const [symbolRaw, afterRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  return created(triggers.add({ ownerId: String(chatId), kind: "TIME_CLOSE", symbol, side: defaultCloseSide(symbol), triggerAt: parseTimeOrDuration(afterRaw), closePosition: true, reduceOnly: true, paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/closeat\b.*/i, command(async (chatId, words) => {
  if (words.length < 2) throw new Error("Usage: /closeat BTC 2026-05-14T12:00:00+02:00");
  const [symbolRaw, ...timeParts] = words;
  const symbol = normalizeSymbol(symbolRaw);
  return created(triggers.add({ ownerId: String(chatId), kind: "TIME_CLOSE", symbol, side: defaultCloseSide(symbol), triggerAt: parseTimeOrDuration(timeParts.join(" ")), closePosition: true, reduceOnly: true, paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/cancelafter\b.*/i, command(async (chatId, words) => {
  if (words.length < 2) throw new Error("Usage: /cancelafter <trigger-id> 30m");
  const [idRaw, afterRaw] = words;
  const target = triggers.get(idRaw);
  return created(triggers.add({ ownerId: String(chatId), kind: "TIME_CANCEL", symbol: target?.symbol ?? "GLOBAL", side: "SELL", triggerAt: parseTimeOrDuration(afterRaw), cancelTriggerId: idRaw, paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/priceband\b.*/i, command(async (chatId, words) => {
  if (words.length < 5) throw new Error("Usage: /priceband BTC BUY BREAKOUT 65000 0.01|close|25% or /priceband BTC SELL BREAKOUT 58000 0.01");
  const [symbolRaw, sideRaw, modeRaw, bandPriceRaw, qtyRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  const side = normalizeSide(sideRaw);
  const mode = String(modeRaw).toUpperCase() as any;
  const dirNeedsUpper = (mode === "BREAKOUT" && side === "BUY") || (mode === "REVERSION" && side === "SELL");
  return created(triggers.add({ ownerId: String(chatId), kind: "PRICE_BAND", symbol, side, priceBandMode: mode, upperPrice: dirNeedsUpper ? asNumber(bandPriceRaw, "upper") : undefined, lowerPrice: dirNeedsUpper ? undefined : asNumber(bandPriceRaw, "lower"), ...sizingFromWord(qtyRaw), paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/riskguard\b.*/i, command(async (chatId, words) => {
  if (words.length < 3) throw new Error("Usage: /riskguard BTC MAX_RISK_USD 500 ALERT|CLOSE_POSITION|CANCEL_TRIGGERS");
  const [symbolRaw, metricRaw, thresholdRaw, actionRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  const metric = String(metricRaw).toUpperCase().replace(/-/g, "_") as any;
  const action = String(actionRaw ?? "ALERT").toUpperCase().replace(/-/g, "_") as any;
  return created(triggers.add({ ownerId: String(chatId), kind: "RISK_GUARD", symbol, side: defaultCloseSide(symbol), riskMetric: metric, riskThreshold: asNumber(thresholdRaw, "threshold"), riskAction: action, closePosition: action === "CLOSE_POSITION", reduceOnly: action === "CLOSE_POSITION", paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/closelimit\b.*/i, command(async (chatId, words) => {
  if (words.length < 2) throw new Error("Usage: /closelimit BTC 65000");
  const [symbolRaw, priceRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  const side = positions.getCloseSide(symbol) ?? "SELL";
  return created(triggers.add({ ownerId: String(chatId), kind: "LIMIT", symbol, side, triggerPrice: asNumber(priceRaw, "price"), closePosition: true, paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/closestoplimit\b.*/i, command(async (chatId, words) => {
  if (words.length < 3) throw new Error("Usage: /closestoplimit BTC 58000 57950");
  const [symbolRaw, stopRaw, limitRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  const side = positions.getCloseSide(symbol) ?? "SELL";
  return created(triggers.add({ ownerId: String(chatId), kind: "STOP_LIMIT", symbol, side, triggerPrice: asNumber(stopRaw, "stop"), limitPrice: asNumber(limitRaw, "limit"), closePosition: true, paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/triggers\b.*/i, command(async (chatId, words) => {
  const all = words.includes("all");
  return formatTriggers(triggers.list({ ownerId: String(chatId), status: all ? undefined as any : "ACTIVE" }));
}));

bot.onText(/^\/canceltrigger\b.*/i, command(async (_chatId, words) => {
  if (!words[0]) throw new Error("Usage: /canceltrigger <trigger-id>");
  const trigger = triggers.cancel(words[0]);
  return trigger ? `Cancelled:\n${formatTriggers([trigger])}` : `No trigger found: ${words[0]}`;
}));

bot.onText(/^\/positions\b/i, command(async () => {
  await service.refreshPositions().catch(() => 0);
  for (const position of positions.list()) await engine.processPositionUpdate(position.symbol);
  return positions.describe();
}));

bot.onText(/^\/risk\b/i, command(async () => formatRisk(positions)));
console.log("Quote.Trade Telegram trigger bot started");
