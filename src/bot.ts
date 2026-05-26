import TelegramBot from "./utils/telegram-bot";
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
import { LlmConfigStore, LlmDraftStore, LlmStrategyPlanner, FREE_FALLBACK_ORDER, formatDraft, formatLlmProviderRows, parsePlanCommands, redactedSecret } from "./llm";
import { TradingSessionStore, redacted } from "./sessions/trading-session-store";
import { userStateFile } from "./sessions/user-state";
import { UserDataStreamService } from "./utils/user-data-stream.service";
import {PriceFeedSvc} from "./utils/price-feed.service";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
const bot = new TelegramBot(token, { polling: true });

interface CommandContext {
  chatId: any;
  ownerId: string;
  chatType?: string;
  msg: any;
}

interface UserScope {
  ownerId: string;
  positions: PositionStore;
  triggers: TriggerStore;
  llmConfig: LlmConfigStore;
  llmDrafts: LlmDraftStore;
  service: BotService;
  engine: TriggerEngine;
  runtime: TriggerRuntime;
}

const sessions = new TradingSessionStore();
const scopes = new Map<string, UserScope>();

function ownerIdFrom(msg: any): string {
  const id = msg?.from?.id;
  if (id === undefined || id === null) throw new Error("Telegram from.id is required for account-isolated trading commands.");
  return String(id);
}

function getScope(ownerId: string): UserScope {
  const owner = String(ownerId);
  const cached = scopes.get(owner);
  if (cached) return cached;

  const positions = new PositionStore(userStateFile(owner, "positions.json"));
  const triggers = new TriggerStore(userStateFile(owner, "triggers.json"));
  const llmConfig = new LlmConfigStore(userStateFile(owner, "llm-config.json"));
  const llmDrafts = new LlmDraftStore(userStateFile(owner, "llm-drafts.json"));
  const service = new BotService(positions, sessions, owner);
  const userData = new UserDataStreamService({ ownerId: owner, requestToken: () => sessions.get(owner)?.apiKey });
  const engine = new TriggerEngine(triggers, positions, service, {
    onTrigger: (t, o) => void notifyOwner(t.ownerId, `✅ Trigger fired ${t.id}: submitted ${o.type} ${o.side} ${o.symbol} qty=${o.quantity}${o.price ? ` limit=${o.price}` : ""}`),
    onReject: (t, r) => void notifyOwner(t.ownerId, `❌ Trigger rejected ${t.id}: ${r}`),
    onError: (t, e: any) => void notifyOwner(t.ownerId, `❌ Trigger error ${t.id}: ${e?.message ?? e}`),
    onAction: (t, m) => void notifyOwner(t.ownerId, `⚙️ ${t.id}: ${m}`),
  });
  const runtime = new TriggerRuntime(triggers, positions, engine, (m) => console.log(`[owner=${owner}] ${m}`), userData);

  const scope = { ownerId: owner, positions, triggers, llmConfig, llmDrafts, service, engine, runtime };
  scopes.set(owner, scope);
  return scope;
}

for (const ownerId of sessions.listOwnerIds()) {
  const scope = getScope(ownerId);
  if (scope.triggers.active().length) scope.runtime.ensure();
}


function maxCommandAgeMs(): number {
  const raw = process.env.TELEGRAM_MAX_COMMAND_AGE_SECONDS ?? "300";
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function assertFreshMessage(msg: any): void {
  const maxAgeMs = maxCommandAgeMs();
  if (!maxAgeMs) return;
  const timestampSeconds = Number(msg?.date);
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return;
  const ageMs = Date.now() - timestampSeconds * 1000;
  if (ageMs > maxAgeMs) {
    throw new Error(`Ignoring stale Telegram command older than ${Math.round(maxAgeMs / 1000)} seconds. Re-send the command to execute it.`);
  }
}

function maxLlmDraftAgeMs(): number {
  const raw = process.env.LLM_DRAFT_MAX_AGE_SECONDS ?? "3600";
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

async function deleteSensitiveCommand(ctx: CommandContext): Promise<void> {
  if (ctx.chatType !== "private") return;
  const messageId = ctx.msg?.message_id;
  if (messageId === undefined || messageId === null) return;
  await (bot as any).deleteMessage?.(ctx.chatId, messageId).catch?.(() => undefined);
}

async function notifyOwner(ownerId: string, text: string): Promise<void> {
  if (!ownerId || ownerId === "default") {
    console.log(text);
    return;
  }
  await bot.sendMessage(ownerId, escapeLong(text)).catch(() => undefined);
}

function send(chatId: any, text: string): Promise<any> { return bot.sendMessage(chatId, escapeLong(text)); }
function sendWithOptions(chatId: any, text: string, options?: any): Promise<any> { return (bot as any).sendMessage(chatId, escapeLong(text), options); }
function command(handler: (ctx: CommandContext, words: string[], raw: string) => Promise<string> | string): (msg: any, match: RegExpExecArray | null) => void {
  return (msg, match) => {
    const chatId = msg?.chat?.id;
    try {
      assertFreshMessage(msg);
      const ctx: CommandContext = { chatId, ownerId: ownerIdFrom(msg), chatType: msg.chat?.type, msg };
      const raw = match?.[0] ?? msg.text ?? "";
      const words = parseWords(raw).slice(1);
      Promise.resolve(handler(ctx, words, raw)).then((t) => send(ctx.chatId, t)).catch((e: any) => send(ctx.chatId, `❌ ${e?.message ?? e}`));
    } catch (e: any) {
      if (chatId !== undefined) void send(chatId, `❌ ${e?.message ?? e}`);
    }
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

function fixedQuantityFromWord(raw?: string): { quantity: number } {
  if (!raw || ["close", "all", "position"].includes(raw.toLowerCase()) || raw.endsWith("%")) {
    throw new Error("this command requires a fixed positive quantity");
  }
  return { quantity: asNumber(raw, "quantity") };
}

function defaultCloseSide(scope: UserScope, symbol: string, sideRaw?: string): any {
  return sideRaw ? normalizeSide(sideRaw) : scope.positions.getCloseSide(symbol) ?? "SELL";
}

function assertConnected(ownerId: string): void {
  if ((process.env.MODE ?? "paper").toLowerCase() === "real") sessions.require(ownerId);
}

function created(scope: UserScope, list: any | any[]): string {
  const triggersList = Array.isArray(list) ? list : [list];
  scope.runtime.ensure();
  // Let TriggerStore.watchableSymbols decide which triggers actually need L2.
  // This prevents risk-only or cancel-only triggers from adding unnecessary
  // symbols to the shared multiplexed market-data stream.
  scope.runtime.reconcile();
  return `Created trigger${triggersList.length > 1 ? "s" : ""}:\n${formatTriggers(triggersList)}`;
}

function createTriggersFromLlmCommands(scope: UserScope, commands: string[]): any[] {
  const actions = parsePlanCommands(commands, {
    ownerId: scope.ownerId,
    defaultPaymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
    format: "telegram",
    resolveCloseSide: (symbol) => scope.positions.getCloseSide(symbol) as any,
  });
  const out: any[] = [];
  for (const action of actions) {
    if (action.action === "oco") out.push(...scope.triggers.addOco(action.inputs, makeGroupId("llm_oco")));
    else for (const input of action.inputs) out.push(scope.triggers.add(input));
  }
  scope.runtime.ensure();
  scope.runtime.reconcile();
  return out;
}

async function sendLlmDraft(chatId: any, draft: any): Promise<void> {
  const text = `${formatDraft(draft)}\n\nConfirm only after review with /llmconfirm ${draft.id}`;
  const reply_markup = draft.commands?.length ? { inline_keyboard: [[
    { text: "Confirm draft", callback_data: `llm_confirm:${draft.id}` },
    { text: "Cancel", callback_data: `llm_cancel:${draft.id}` },
  ]] } : undefined;
  await sendWithOptions(chatId, text, reply_markup ? { reply_markup } : undefined);
}

async function confirmLlmDraft(ctx: CommandContext, id: string): Promise<string> {
  const scope = getScope(ctx.ownerId);
  assertConnected(ctx.ownerId);
  const maxAgeMs = maxLlmDraftAgeMs();
  const draft = scope.llmDrafts.claimPending(id, ctx.ownerId, maxAgeMs);
  if (!draft.commands.length) {
    scope.llmDrafts.mark(id, "REJECTED", ctx.ownerId);
    throw new Error(`Draft ${id} has no commands to confirm`);
  }
  try {
    const made = createTriggersFromLlmCommands(scope, draft.commands);
    scope.llmDrafts.mark(id, "CONFIRMED", ctx.ownerId);
    return created(scope, made);
  } catch (error) {
    scope.llmDrafts.mark(id, "REJECTED", ctx.ownerId);
    throw error;
  }
}

async function createLlmStrategyDraft(chatId: any, ctx: any, prompt: string): Promise<void> {
  if (!prompt) throw new Error("Usage: /llmstrategy describe the strategy you want");
  const scope = getScope(ctx.ownerId);
  const planner = new LlmStrategyPlanner(scope.llmConfig);
  const plan = await planner.plan({ ownerId: ctx.ownerId, prompt, commandFormat: "telegram", defaultPaymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD", positionsContext: scope.positions.describe(), riskContext: formatRisk(scope.positions), resolveCloseSide: (symbol) => scope.positions.getCloseSide(symbol) as any });
  const draft = scope.llmDrafts.add({ ownerId: ctx.ownerId, prompt, provider: plan.provider, model: plan.model, format: "telegram", summary: plan.summary, commands: plan.commands, riskNotes: plan.riskNotes });
  await sendLlmDraft(chatId, draft);
}

function sessionStatus(ownerId: string): string {
  const s = sessions.summary(ownerId);
  if (!s.connected) return `No Quote.Trade account session is connected for your Telegram user id ${ownerId}. Use /connectkey in a private chat.`;
  return [
    `Connected Quote.Trade session for Telegram user ${ownerId}`,
    `apiKey=${s.apiKey}`,
    `signing=${s.signingAlgorithm}`,
    s.account ? `account=${s.account}` : undefined,
    s.label ? `label=${s.label}` : undefined,
    s.lastVerifiedAt ? `lastVerified=${new Date(s.lastVerifiedAt).toISOString()}` : undefined,
    `storage=users/${s.pathKey}/session.json`,
  ].filter(Boolean).join("\n");
}

bot.onText(/^\/start\b/i, command(async () => `${START_MESSAGE}\n\nAccount isolation: trading credentials, triggers, positions, and LLM drafts are stored per Telegram user. Use /connectkey in a private chat before real trading.`));

bot.onText(/^\/session\b/i, command(async (ctx) => sessionStatus(ctx.ownerId)));

bot.onText(/^\/connectkey\b.*/i, command(async (ctx, words) => {
  if (ctx.chatType !== "private") throw new Error("For security, /connectkey is only accepted in a private chat with the bot.");
  if (words.length < 2) throw new Error("Usage: /connectkey <api-key> <api-secret> [sha256|ed25519] [account]");
  const [apiKey, apiSecret, signingAlgorithm, account] = words;
  await deleteSensitiveCommand(ctx);
  const saved = sessions.set(ctx.ownerId, { apiKey, apiSecret, signingAlgorithm, account });

  if (process.env.SESSION_DEBUG === "true") {
    console.log("[SESSION_CONNECT]", {
      ownerId: ctx.ownerId,
      chatType: ctx.chatType,
      account: saved.account,
      signingAlgorithm: saved.signingAlgorithm,
      apiKeyMasked: redacted(apiKey),
    });
  }

  scopes.get(ctx.ownerId)?.runtime.stop();
  scopes.delete(ctx.ownerId);
  const scope = getScope(ctx.ownerId);
  if (scope.triggers.active().length) scope.runtime.ensure();
  return `Saved encrypted Quote.Trade session for your Telegram user. apiKey=${redacted(apiKey)} signing=${saved.signingAlgorithm}${saved.account ? ` account=${saved.account}` : ""}`;
}));

bot.onText(/^\/disconnect\b/i, command(async (ctx) => {
  scopes.get(ctx.ownerId)?.runtime.stop();
  scopes.delete(ctx.ownerId);
  const removed = sessions.remove(ctx.ownerId);
  return removed ? "Disconnected your Quote.Trade account session and stopped your local runtime." : "No Quote.Trade session was connected for your Telegram user.";
}));

bot.onText(/^\/limit\b.*/i, command(async (ctx, words) => {
  const scope = getScope(ctx.ownerId); assertConnected(ctx.ownerId);
  if (words.length < 4) throw new Error("Usage: /limit BTC BUY 60000 0.01|close|25%");
  const [symbolRaw, sideRaw, priceRaw, qtyRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  return created(scope, scope.triggers.add({ ownerId: ctx.ownerId, kind: "LIMIT", symbol, side: normalizeSide(sideRaw), triggerPrice: asNumber(priceRaw, "price"), ...sizingFromWord(qtyRaw), paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/stoplimit\b.*/i, command(async (ctx, words) => {
  const scope = getScope(ctx.ownerId); assertConnected(ctx.ownerId);
  if (words.length < 5) throw new Error("Usage: /stoplimit BTC SELL 58000 57950 0.01|close|25%");
  const [symbolRaw, sideRaw, stopRaw, limitRaw, qtyRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  return created(scope, scope.triggers.add({ ownerId: ctx.ownerId, kind: "STOP_LIMIT", symbol, side: normalizeSide(sideRaw), triggerPrice: asNumber(stopRaw, "stop"), limitPrice: asNumber(limitRaw, "limit"), ...sizingFromWord(qtyRaw), paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/takeprofit\b.*/i, command(async (ctx, words) => {
  const scope = getScope(ctx.ownerId); assertConnected(ctx.ownerId);
  if (words.length < 3) throw new Error("Usage: /takeprofit BTC SELL 65000 0.01|close|25%");
  const [symbolRaw, sideRaw, priceRaw, qtyRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  return created(scope, scope.triggers.add({ ownerId: ctx.ownerId, kind: "TAKE_PROFIT", symbol, side: defaultCloseSide(scope, symbol, sideRaw), triggerPrice: asNumber(priceRaw, "price"), ...sizingFromWord(qtyRaw), paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/stoploss\b.*/i, command(async (ctx, words) => {
  const scope = getScope(ctx.ownerId); assertConnected(ctx.ownerId);
  if (words.length < 3) throw new Error("Usage: /stoploss BTC SELL 58000 0.01|close|25%");
  const [symbolRaw, sideRaw, priceRaw, qtyRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  return created(scope, scope.triggers.add({ ownerId: ctx.ownerId, kind: "STOP_LOSS", symbol, side: defaultCloseSide(scope, symbol, sideRaw), triggerPrice: asNumber(priceRaw, "price"), ...sizingFromWord(qtyRaw), paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/trailingstop\b.*/i, command(async (ctx, words) => {
  const scope = getScope(ctx.ownerId); assertConnected(ctx.ownerId);
  if (words.length < 4) throw new Error("Usage: /trailingstop BTC SELL 5% 0.01|close|25%");
  const [symbolRaw, sideRaw, trailRaw, qtyRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  const trail = parseAmountOrPercent(trailRaw);
  return created(scope, scope.triggers.add({ ownerId: ctx.ownerId, kind: "TRAILING_STOP", symbol, side: defaultCloseSide(scope, symbol, sideRaw), trailMode: trail.mode, trailValue: trail.value, ...sizingFromWord(qtyRaw), paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/trailingstoplimit\b.*/i, command(async (ctx, words) => {
  const scope = getScope(ctx.ownerId); assertConnected(ctx.ownerId);
  if (words.length < 5) throw new Error("Usage: /trailingstoplimit BTC SELL 5% 50 0.01|close|25%");
  const [symbolRaw, sideRaw, trailRaw, offsetRaw, qtyRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  const trail = parseAmountOrPercent(trailRaw);
  return created(scope, scope.triggers.add({ ownerId: ctx.ownerId, kind: "TRAILING_STOP_LIMIT", symbol, side: defaultCloseSide(scope, symbol, sideRaw), trailMode: trail.mode, trailValue: trail.value, limitOffset: asNumber(offsetRaw, "limitOffset"), ...sizingFromWord(qtyRaw), paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/oco\b.*/i, command(async (ctx, words) => {
  const scope = getScope(ctx.ownerId); assertConnected(ctx.ownerId);
  if (words.length < 5) throw new Error("Usage: /oco BTC SELL 65000 58000 0.01|close|25% [stopLimit]");
  const [symbolRaw, sideRaw, takeProfitRaw, stopLossRaw, qtyRaw, stopLimitRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  const side = defaultCloseSide(scope, symbol, sideRaw);
  const sizing = sizingFromWord(qtyRaw);
  const groupId = makeGroupId("oco");
  const childInputs: TriggerInput[] = [
    { ownerId: ctx.ownerId, kind: "TAKE_PROFIT", symbol, side, triggerPrice: asNumber(takeProfitRaw, "takeProfit"), ...sizing, paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" },
    stopLimitRaw
      ? { ownerId: ctx.ownerId, kind: "STOP_LIMIT", symbol, side, triggerPrice: asNumber(stopLossRaw, "stopLoss"), limitPrice: asNumber(stopLimitRaw, "stopLimit"), ...sizing, paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }
      : { ownerId: ctx.ownerId, kind: "STOP_LOSS", symbol, side, triggerPrice: asNumber(stopLossRaw, "stopLoss"), ...sizing, paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" },
  ];
  return created(scope, scope.triggers.addOco(childInputs, groupId));
}));

bot.onText(/^\/bracket\b.*/i, command(async (ctx, words) => {
  const scope = getScope(ctx.ownerId); assertConnected(ctx.ownerId);
  if (words.length < 6) throw new Error("Usage: /bracket BTC BUY 60000 0.01 65000 58000 [57950]");
  const [symbolRaw, sideRaw, entryRaw, qtyRaw, takeProfitRaw, stopLossRaw, stopLimitRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  return created(scope, scope.triggers.add({
    ownerId: ctx.ownerId,
    kind: "LIMIT",
    symbol,
    side: normalizeSide(sideRaw),
    triggerPrice: asNumber(entryRaw, "entry"),
    ...fixedQuantityFromWord(qtyRaw),
    paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
    meta: { bracket: { takeProfitPrice: asNumber(takeProfitRaw, "takeProfit"), stopLossPrice: asNumber(stopLossRaw, "stopLoss"), stopLimitPrice: stopLimitRaw ? asNumber(stopLimitRaw, "stopLimit") : undefined } },
  }));
}));

bot.onText(/^\/scaleout\b.*/i, command(async (ctx, words) => {
  const scope = getScope(ctx.ownerId); assertConnected(ctx.ownerId);
  if (words.length < 4) throw new Error("Usage: /scaleout BTC SELL 63000 25%");
  const [symbolRaw, sideRaw, priceRaw, percentRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  return created(scope, scope.triggers.add({ ownerId: ctx.ownerId, kind: "TAKE_PROFIT", symbol, side: defaultCloseSide(scope, symbol, sideRaw), triggerPrice: asNumber(priceRaw, "price"), closePercentage: parsePercent(percentRaw), reduceOnly: true, paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD", meta: { strategy: "SCALE_OUT" } }));
}));

bot.onText(/^\/breakeven\b.*/i, command(async (ctx, words) => {
  const scope = getScope(ctx.ownerId); assertConnected(ctx.ownerId);
  if (words.length < 3) throw new Error("Usage: /breakeven BTC SELL 3% [plus]");
  const [symbolRaw, sideRaw, afterRaw, plusRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  const after = parseAmountOrPercent(afterRaw);
  const plus = plusRaw ? parseAmountOrPercent(plusRaw) : { mode: "AMOUNT" as const, value: 0 };
  return created(scope, scope.triggers.add({ ownerId: ctx.ownerId, kind: "BREAK_EVEN_STOP", symbol, side: defaultCloseSide(scope, symbol, sideRaw), activationMode: after.mode, activationValue: after.value, lockMode: plus.mode, lockValue: plus.value, closePosition: true, reduceOnly: true, paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/closeafter\b.*/i, command(async (ctx, words) => {
  const scope = getScope(ctx.ownerId); assertConnected(ctx.ownerId);
  if (words.length < 2) throw new Error("Usage: /closeafter BTC 4h");
  const [symbolRaw, afterRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  return created(scope, scope.triggers.add({ ownerId: ctx.ownerId, kind: "TIME_CLOSE", symbol, side: defaultCloseSide(scope, symbol), triggerAt: parseTimeOrDuration(afterRaw), closePosition: true, reduceOnly: true, paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/closeat\b.*/i, command(async (ctx, words) => {
  const scope = getScope(ctx.ownerId); assertConnected(ctx.ownerId);
  if (words.length < 2) throw new Error("Usage: /closeat BTC 2026-05-14T12:00:00+02:00");
  const [symbolRaw, ...timeParts] = words;
  const symbol = normalizeSymbol(symbolRaw);
  return created(scope, scope.triggers.add({ ownerId: ctx.ownerId, kind: "TIME_CLOSE", symbol, side: defaultCloseSide(scope, symbol), triggerAt: parseTimeOrDuration(timeParts.join(" ")), closePosition: true, reduceOnly: true, paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/cancelafter\b.*/i, command(async (ctx, words) => {
  const scope = getScope(ctx.ownerId);
  if (words.length < 2) throw new Error("Usage: /cancelafter <trigger-id> 30m");
  const [idRaw, afterRaw] = words;
  const target = scope.triggers.get(idRaw);
  if (!target || target.ownerId !== ctx.ownerId) throw new Error(`No trigger found for your Telegram user: ${idRaw}`);
  return created(scope, scope.triggers.add({ ownerId: ctx.ownerId, kind: "TIME_CANCEL", symbol: target.symbol, side: "SELL", triggerAt: parseTimeOrDuration(afterRaw), cancelTriggerId: idRaw, paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/priceband\b.*/i, command(async (ctx, words) => {
  const scope = getScope(ctx.ownerId); assertConnected(ctx.ownerId);
  if (words.length < 5) throw new Error("Usage: /priceband BTC BUY BREAKOUT 65000 0.01|close|25% or /priceband BTC SELL BREAKOUT 58000 0.01");
  const [symbolRaw, sideRaw, modeRaw, bandPriceRaw, qtyRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  const side = normalizeSide(sideRaw);
  const mode = String(modeRaw).toUpperCase() as any;
  const dirNeedsUpper = (mode === "BREAKOUT" && side === "BUY") || (mode === "REVERSION" && side === "SELL");
  return created(scope, scope.triggers.add({ ownerId: ctx.ownerId, kind: "PRICE_BAND", symbol, side, priceBandMode: mode, upperPrice: dirNeedsUpper ? asNumber(bandPriceRaw, "upper") : undefined, lowerPrice: dirNeedsUpper ? undefined : asNumber(bandPriceRaw, "lower"), ...sizingFromWord(qtyRaw), paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/riskguard\b.*/i, command(async (ctx, words) => {
  const scope = getScope(ctx.ownerId); assertConnected(ctx.ownerId);
  if (words.length < 3) throw new Error("Usage: /riskguard BTC MAX_RISK_USD 500 ALERT|CLOSE_POSITION|CANCEL_TRIGGERS");
  const [symbolRaw, metricRaw, thresholdRaw, actionRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  const metric = String(metricRaw).toUpperCase().replace(/-/g, "_") as any;
  const action = String(actionRaw ?? "ALERT").toUpperCase().replace(/-/g, "_") as any;
  return created(scope, scope.triggers.add({ ownerId: ctx.ownerId, kind: "RISK_GUARD", symbol, side: defaultCloseSide(scope, symbol), riskMetric: metric, riskThreshold: asNumber(thresholdRaw, "threshold"), riskAction: action, closePosition: action === "CLOSE_POSITION", reduceOnly: action === "CLOSE_POSITION", paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/closelimit\b.*/i, command(async (ctx, words) => {
  const scope = getScope(ctx.ownerId); assertConnected(ctx.ownerId);
  if (words.length < 2) throw new Error("Usage: /closelimit BTC 65000");
  const [symbolRaw, priceRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  const side = scope.positions.getCloseSide(symbol) ?? "SELL";
  return created(scope, scope.triggers.add({ ownerId: ctx.ownerId, kind: "LIMIT", symbol, side, triggerPrice: asNumber(priceRaw, "price"), closePosition: true, paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/closestoplimit\b.*/i, command(async (ctx, words) => {
  const scope = getScope(ctx.ownerId); assertConnected(ctx.ownerId);
  if (words.length < 3) throw new Error("Usage: /closestoplimit BTC 58000 57950");
  const [symbolRaw, stopRaw, limitRaw] = words;
  const symbol = normalizeSymbol(symbolRaw);
  const side = scope.positions.getCloseSide(symbol) ?? "SELL";
  return created(scope, scope.triggers.add({ ownerId: ctx.ownerId, kind: "STOP_LIMIT", symbol, side, triggerPrice: asNumber(stopRaw, "stop"), limitPrice: asNumber(limitRaw, "limit"), closePosition: true, paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD" }));
}));

bot.onText(/^\/triggers\b.*/i, command(async (ctx, words) => {
  const scope = getScope(ctx.ownerId);
  const all = words.includes("all");
  return formatTriggers(scope.triggers.list({ ownerId: ctx.ownerId, status: all ? undefined as any : "ACTIVE" }));
}));

bot.onText(/^\/canceltrigger\b.*/i, command(async (ctx, words) => {
  const scope = getScope(ctx.ownerId);
  if (!words[0]) throw new Error("Usage: /canceltrigger <trigger-id>");
  const current = scope.triggers.get(words[0]);
  if (!current || current.ownerId !== ctx.ownerId) return `No trigger found for your Telegram user: ${words[0]}`;
  const trigger = scope.triggers.cancel(words[0]);
  scope.runtime.reconcile();
  return trigger ? `Cancelled:\n${formatTriggers([trigger])}` : `No trigger found: ${words[0]}`;
}));

bot.onText(/^\/positions\b/i, command(async (ctx) => {
  const scope = getScope(ctx.ownerId);
  sessions.require(ctx.ownerId);
  const count = await scope.service.refreshPositions(ctx.ownerId).catch(() => 0);
  for (const position of scope.positions.list()) await scope.engine.processPositionUpdate(position.symbol);
  return scope.positions.describe();
}));

bot.onText(/^\/risk\b/i, command(async (ctx) => formatRisk(getScope(ctx.ownerId).positions)));

bot.onText(/^\/llmconnect\b.*/i, command(async (ctx, words) => {
  const scope = getScope(ctx.ownerId);
  if (words.length < 1) throw new Error("Usage: /llmconnect openai|ovhcloud|gemini|openrouter|groq|huggingface|pollinations [model] [env:API_KEY|key:<api-key>] [default] [fallback]");
  const [providerRaw, modelRaw, keyRaw, ...flags] = words;
  let apiKey: string | undefined; let apiKeyEnv: string | undefined; const extraFlags = [...flags];
  if (keyRaw?.startsWith("env:")) apiKeyEnv = keyRaw.slice(4); else if (keyRaw?.startsWith("key:")) apiKey = keyRaw.slice(4); else if (keyRaw && ["default", "fallback"].includes(keyRaw.toLowerCase())) extraFlags.unshift(keyRaw);
  const model = modelRaw && !modelRaw.startsWith("env:") && !modelRaw.startsWith("key:") && !["default", "fallback"].includes(modelRaw.toLowerCase()) ? modelRaw : undefined;
  if (!apiKey && !apiKeyEnv && modelRaw?.startsWith("env:")) apiKeyEnv = modelRaw.slice(4);
  if (!apiKey && !apiKeyEnv && modelRaw?.startsWith("key:")) apiKey = modelRaw.slice(4);
  if (apiKey && ctx.chatType !== "private") throw new Error("For security, inline LLM API keys are only accepted in a private chat. Use env:NAME in groups.");
  if (apiKey) await deleteSensitiveCommand(ctx);
  const saved = scope.llmConfig.setConnection({ ownerId: ctx.ownerId, provider: providerRaw, model, apiKey, apiKeyEnv, makeDefault: extraFlags.includes("default"), useAsFallback: extraFlags.includes("fallback") });
  const keySource = apiKey ? `stored:${redactedSecret(apiKey)}` : `env:${saved.apiKeyEnv}`;
  return `Saved LLM connection for your Telegram user: ${saved.provider} model=${saved.model} key=${keySource}`;
}));
bot.onText(/^\/llmproviders\b/i, command(async (ctx) => formatLlmProviderRows(getScope(ctx.ownerId).llmConfig.listRows(ctx.ownerId))));
bot.onText(/^\/llmfallbacks\b/i, command(async () => `Free/no-subscription fallback order: ${FREE_FALLBACK_ORDER.join(" -> ")}\nAnonymous providers are used without a key; other free-tier providers are tried when their env key is present.`));
bot.onText(/^\/llmstrategy\b.*/i, (msg) => {
  const chatId = msg?.chat?.id;
  let ctx: CommandContext;
  try {
    assertFreshMessage(msg);
    ctx = { chatId, ownerId: ownerIdFrom(msg), chatType: msg.chat?.type, msg };
  } catch (e: any) {
    if (chatId !== undefined) void send(chatId, `❌ ${e?.message ?? e}`);
    return;
  }
  const prompt = String(msg.text ?? "").replace(/^\/llmstrategy(?:@\w+)?\s*/i, "").trim();
  Promise.resolve()
      .then(() => createLlmStrategyDraft(chatId, ctx, prompt))
      .catch((e: any) => send(chatId, `❌ ${e?.message ?? e}`));
  // Promise.resolve().then(async () => {
  //   if (!prompt) throw new Error("Usage: /llmstrategy describe the strategy you want");
  //   const scope = getScope(ctx.ownerId);
  //   const planner = new LlmStrategyPlanner(scope.llmConfig);
  //   const plan = await planner.plan({ ownerId: ctx.ownerId, prompt, commandFormat: "telegram", defaultPaymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD", positionsContext: scope.positions.describe(), riskContext: formatRisk(scope.positions), resolveCloseSide: (symbol) => scope.positions.getCloseSide(symbol) as any });
  //   const draft = scope.llmDrafts.add({ ownerId: ctx.ownerId, prompt, provider: plan.provider, model: plan.model, format: "telegram", summary: plan.summary, commands: plan.commands, riskNotes: plan.riskNotes });
  //   await sendLlmDraft(ctx.chatId, draft);
  // }).catch((e: any) => send(ctx.chatId, `❌ ${e?.message ?? e}`));
});
bot.onText(/^\/prompt\b.*/i, (msg) => {
  const chatId = msg.chat.id;
  let ctx: CommandContext;
  try {
    assertFreshMessage(msg);
    ctx = { chatId, ownerId: ownerIdFrom(msg), chatType: msg.chat?.type, msg };
  } catch (e: any) {
    if (chatId !== undefined) void send(chatId, `❌ ${e?.message ?? e}`);
    return;
  }

  const prompt = String(msg.text ?? "").replace(/^\/prompt(?:@\w+)?\s*/i, "").trim();

  Promise.resolve()
      .then(() => createLlmStrategyDraft(chatId, ctx, prompt))
      .catch((e: any) => send(chatId, `❌ ${e?.message ?? e}`));
});
bot.onText(/^\/llmconfirm\b.*/i, command(async (ctx, words) => { if (!words[0]) throw new Error("Usage: /llmconfirm <draft-id>"); return confirmLlmDraft(ctx, words[0]); }));
bot.onText(/^\/llmcancel\b.*/i, command(async (ctx, words) => { if (!words[0]) throw new Error("Usage: /llmcancel <draft-id>"); const draft = getScope(ctx.ownerId).llmDrafts.mark(words[0], "CANCELLED", ctx.ownerId); return `Cancelled ${draft.id}.`; }));
bot.onText(/^\/llmdrafts\b.*/i, command(async (ctx, words) => { const drafts = getScope(ctx.ownerId).llmDrafts.list(ctx.ownerId, words.includes("all")); return drafts.length ? drafts.map(formatDraft).join("\n\n---\n\n") : "No pending LLM drafts for your Telegram user."; }));
(bot as any).on("callback_query", (query: any) => {
  const data = String(query?.data ?? ""); const chatId = query?.message?.chat?.id; const ownerId = String(query?.from?.id ?? ""); if (!chatId || !ownerId || !data.startsWith("llm_")) return;
  const ctx: CommandContext = { chatId, ownerId, chatType: query?.message?.chat?.type, msg: query?.message };
  Promise.resolve().then(async () => {
    if (data.startsWith("llm_confirm:")) { const text = await confirmLlmDraft(ctx, data.slice("llm_confirm:".length)); await (bot as any).answerCallbackQuery?.(query.id, { text: "Draft confirmed" }).catch?.(() => undefined); await send(chatId, text); }
    else if (data.startsWith("llm_cancel:")) { const draft = getScope(ownerId).llmDrafts.mark(data.slice("llm_cancel:".length), "CANCELLED", ownerId); await (bot as any).answerCallbackQuery?.(query.id, { text: "Draft cancelled" }).catch?.(() => undefined); await send(chatId, `Cancelled ${draft.id}.`); }
  }).catch(async (e: any) => { await (bot as any).answerCallbackQuery?.(query.id, { text: "LLM draft action failed" }).catch?.(() => undefined); await send(chatId, `❌ ${e?.message ?? e}`); });
});

bot.onText(/^(?!\/)([\s\S]+)$/i, (msg) => {
  const chatId = msg.chat.id;
  const text = String(msg.text ?? "").trim();

  if (!text) return;

  // Safe first version: only allow plain text prompts in private chat
  if (msg.chat.type !== "private") return;

  let ctx: CommandContext;
  try {
    assertFreshMessage(msg);
    ctx = { chatId, ownerId: ownerIdFrom(msg), chatType: msg.chat?.type, msg };
  } catch (e: any) {
    if (chatId !== undefined) void send(chatId, `❌ ${e?.message ?? e}`);
    return;
  }

  Promise.resolve()
      .then(() => createLlmStrategyDraft(chatId, ctx, text))
      .catch((e: any) => send(chatId, `❌ ${e?.message ?? e}`));
});

console.log("Quote.Trade Telegram trigger bot started with per-user account sessions");
