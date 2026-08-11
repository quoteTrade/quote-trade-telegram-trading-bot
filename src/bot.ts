import * as dotenv from "dotenv";
import TelegramBot from "./utils/telegram-bot";

dotenv.config();

import { BotService } from "./bot.service";
import { asNumber, escapeLong, parseWords } from "./bot.utils";
import {
  ACCOUNT_CONNECT_CANCEL_KEYBOARD,
  ACCOUNT_CONNECTED_KEYBOARD,
  ACCOUNT_DISCONNECT_CONFIRM_KEYBOARD,
  ACCOUNT_DISCONNECTED_KEYBOARD,
  START_MESSAGE,
  TRADE_WIZARD_CANCEL_KEYBOARD,
  TRADING_KEYBOARD,
  TRIGGER_CREATE_KEYBOARD,
} from "./constant/message";
import {
  confirmOrderButtonText,
  FREE_FALLBACK_ORDER,
  formatDraft,
  formatDraftButtonLabel,
  formatDraftForTelegramHtml,
  formatLlmProviderRows,
  LLM_PROVIDER_DEFAULTS,
  LlmConfigStore,
  LlmDraftStore,
  LlmStrategyPlanner,
  parsePlanCommands,
  redactedSecret,
} from "./llm";
import { cancelCodexOAuthLogin, codexOAuthStatus, logoutCodexOAuth, startCodexOAuthLogin } from "./llm/codex-oauth";
import { detectSigningAlgorithm, redacted, TradingSessionStore } from "./sessions/trading-session-store";
import { userStateFile } from "./sessions/user-state";
import { TriggerRuntime } from "./trigger-runtime";
import { formatOrderPage, formatRisk, formatTriggers, parsePage } from "./triggers/format";
import { OrderHistoryStore } from "./triggers/order-history-store";
import { PositionStore } from "./triggers/position-store";
import { TriggerEngine } from "./triggers/trigger-engine";
import { TriggerStore } from "./triggers/trigger-store";
import {
  makeGroupId,
  normalizeSide,
  normalizeSymbol,
  parseAmountOrPercent,
  parseTimeOrDuration,
  type TriggerInput,
} from "./triggers/types";
import { UserDataStreamService } from "./utils/user-data-stream.service";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
// Constructed inert: importing this module must connect to nothing. `startBot()`
// at the foot of the file opens the long-poll, and only when this file is the
// program being run. The token is still required here because it doubles as the
// session encryption material (see sessions/trading-session-store.ts).
const bot = new TelegramBot(token, { polling: false });

interface CommandContext {
  chatId: any;
  ownerId: string;
  chatType?: string;
  msg: any;
}

interface CommandReply {
  text: string;
  options?: any;
}

interface ConnectWizardState {
  step: "api_key" | "api_secret";
  apiKey?: string;
  startedAt: number;
}

type TradingCommandName =
  | "limit"
  | "stoplimit"
  | "takeprofit"
  | "stoploss"
  | "trailingstop"
  | "trailingstoplimit"
  | "oco"
  | "bracket"
  | "scaleout"
  | "breakeven"
  | "closeafter"
  | "cancelafter"
  | "priceband"
  | "riskguard";

interface TradingWizardState {
  command: TradingCommandName;
  parameters?: string;
  step: "parameters" | "confirm";
  startedAt: number;
}

interface CodexModelWizardState {
  startedAt: number;
}

interface LlmUiWizardState {
  kind: "provider_key" | "strategy_prompt";
  provider?: string;
  startedAt: number;
}

interface UserScope {
  ownerId: string;
  positions: PositionStore;
  triggers: TriggerStore;
  llmConfig: LlmConfigStore;
  llmDrafts: LlmDraftStore;
  orderHistory: OrderHistoryStore;
  service: BotService;
  engine: TriggerEngine;
  runtime: TriggerRuntime;
}

const sessions = new TradingSessionStore();
const scopes = new Map<string, UserScope>();
const connectWizards = new Map<string, ConnectWizardState>();
const tradingWizards = new Map<string, TradingWizardState>();
const codexModelWizards = new Map<string, CodexModelWizardState>();
const llmUiWizards = new Map<string, LlmUiWizardState>();
const CONNECT_WIZARD_TTL_MS = 5 * 60 * 1000;
const TRADING_WIZARD_TTL_MS = 10 * 60 * 1000;
const CODEX_MODEL_WIZARD_TTL_MS = 5 * 60 * 1000;
const LLM_UI_WIZARD_TTL_MS = 10 * 60 * 1000;

const TRADING_COMMAND_HELP: Record<TradingCommandName, { title: string; parameters: string; example: string }> = {
  limit: { title: "Limit", parameters: "SYMBOL SIDE PRICE SIZE", example: "BTC BUY 60000 0.01" },
  stoplimit: { title: "Stop Limit", parameters: "SYMBOL SIDE STOP LIMIT SIZE", example: "BTC SELL 58000 57950 0.01" },
  takeprofit: {
    title: "Take Profit",
    parameters: "SYMBOL SIDE PRICE SIZE|close|PERCENT",
    example: "BTC SELL 65000 close",
  },
  stoploss: { title: "Stop Loss", parameters: "SYMBOL SIDE PRICE SIZE|close|PERCENT", example: "BTC SELL 58000 close" },
  trailingstop: {
    title: "Trailing Stop",
    parameters: "SYMBOL SIDE TRAIL SIZE|close|PERCENT",
    example: "BTC SELL 5% close",
  },
  trailingstoplimit: {
    title: "Trailing Stop Limit",
    parameters: "SYMBOL SIDE TRAIL LIMIT_OFFSET SIZE|close|PERCENT",
    example: "BTC SELL 5% 50 close",
  },
  oco: {
    title: "OCO",
    parameters: "SYMBOL SIDE TAKE_PROFIT STOP_LOSS SIZE|close|PERCENT [STOP_LIMIT]",
    example: "BTC SELL 65000 58000 close",
  },
  bracket: {
    title: "Bracket",
    parameters: "SYMBOL SIDE ENTRY SIZE TAKE_PROFIT STOP_LOSS [STOP_LIMIT]",
    example: "BTC BUY 60000 0.01 65000 58000",
  },
  scaleout: { title: "Scale Out", parameters: "SYMBOL SIDE PRICE PERCENT", example: "BTC SELL 63000 25%" },
  breakeven: { title: "Break Even", parameters: "SYMBOL SIDE AFTER [PLUS]", example: "BTC SELL 3% 0.5%" },
  closeafter: { title: "Close After", parameters: "SYMBOL DURATION", example: "BTC 4h" },
  cancelafter: { title: "Cancel After", parameters: "TRIGGER_ID DURATION", example: "trg_example 30m" },
  priceband: {
    title: "Price Band",
    parameters: "SYMBOL SIDE BREAKOUT|REVERSION PRICE SIZE|close|PERCENT",
    example: "BTC BUY BREAKOUT 65000 0.01",
  },
  riskguard: {
    title: "Risk Guard",
    parameters: "SYMBOL METRIC THRESHOLD ACTION",
    example: "BTC MAX_RISK_USD 500 CLOSE_POSITION",
  },
};

function ownerIdFrom(msg: any): string {
  const id = msg?.from?.id;
  if (id === undefined || id === null)
    throw new Error("Telegram from.id is required for account-isolated trading commands.");
  return String(id);
}

function acknowledgeCallback(queryId: string, options: Record<string, unknown> = {}): void {
  // Telegram only keeps the button spinner open until this request completes.
  // Do not make the actual button action wait on that network round trip.
  void (bot as any).answerCallbackQuery(queryId, options).catch((error: any) => {
    console.warn("[TELEGRAM_CALLBACK_ACK_FAILED]", { message: error?.message ?? String(error) });
  });
}

function getScope(ownerId: string): UserScope {
  const owner = String(ownerId);
  const cached = scopes.get(owner);
  if (cached) return cached;

  const orderHistory = new OrderHistoryStore();
  const positions = new PositionStore(userStateFile(owner, "positions.json"));
  const triggers = new TriggerStore(userStateFile(owner, "triggers.json"));
  const llmConfig = new LlmConfigStore(userStateFile(owner, "llm-config.json"));
  const llmDrafts = new LlmDraftStore(userStateFile(owner, "llm-drafts.json"));
  const service = new BotService(positions, sessions, owner);
  const userData = new UserDataStreamService({ ownerId: owner, requestToken: () => sessions.get(owner)?.apiKey });
  const engine = new TriggerEngine(triggers, positions, service, {
    onTrigger: (t, o) =>
      void notifyOwner(
        t.ownerId,
        `✅ Trigger fired ${t.id}: submitted ${o.type} ${o.side} ${o.symbol} qty=${o.quantity}${o.price ? ` limit=${o.price}` : ""}`,
      ),
    onReject: (t, r) => void notifyOwner(t.ownerId, `❌ Trigger rejected ${t.id}: ${r}`),
    onError: (t, e: any) => void notifyOwner(t.ownerId, `❌ Trigger error ${t.id}: ${e?.message ?? e}`),
    onAction: (t, m) => void notifyOwner(t.ownerId, `⚙️ ${t.id}: ${m}`),
  });
  // const runtime = new TriggerRuntime(triggers, positions, engine, (m) => console.log(`[owner=${owner}] ${m}`), userData);
  const runtime = new TriggerRuntime(
    triggers,
    positions,
    engine,
    (m) => console.log(`[owner=${owner}] ${m}`),
    userData,
    undefined,
    orderHistory,
  );

  const scope = { ownerId: owner, positions, triggers, llmConfig, llmDrafts, orderHistory, service, engine, runtime };
  // const scope = { ownerId: owner, positions, triggers, llmConfig, llmDrafts, service, engine, runtime };
  scopes.set(owner, scope);
  return scope;
}

/**
 * Re-attach runtimes for owners who already had active triggers when the process
 * last stopped. This opens the user-data stream and the price feed, so it is a
 * startup action, not an import-time one.
 */
function resumeExistingOwners(): void {
  for (const ownerId of sessions.listOwnerIds()) {
    const scope = getScope(ownerId);
    if (scope.triggers.active().length) scope.runtime.ensure();
  }
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
    throw new Error(
      `Ignoring stale Telegram command older than ${Math.round(maxAgeMs / 1000)} seconds. Re-send the command to execute it.`,
    );
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

function send(chatId: any, text: string): Promise<any> {
  // return bot.sendMessage(chatId, escapeLong(text));
  return bot.sendMessage(chatId, escapeLong(text), {
    disable_web_page_preview: true,
  });
}
function sendWithOptions(chatId: any, text: string, options?: any): Promise<any> {
  return (bot as any).sendMessage(chatId, escapeLong(text), options);
}
function command(
  handler: (
    ctx: CommandContext,
    words: string[],
    raw: string,
  ) => Promise<string | CommandReply> | string | CommandReply,
): (msg: any, match: RegExpExecArray | null) => void {
  return (msg, match) => {
    const chatId = msg?.chat?.id;
    try {
      assertFreshMessage(msg);
      const ctx: CommandContext = { chatId, ownerId: ownerIdFrom(msg), chatType: msg.chat?.type, msg };
      const raw = match?.[0] ?? msg.text ?? "";
      // Typing any slash command explicitly exits pending conversational flows.
      connectWizards.delete(ctx.ownerId);
      tradingWizards.delete(ctx.ownerId);
      codexModelWizards.delete(ctx.ownerId);
      llmUiWizards.delete(ctx.ownerId);
      const words = parseWords(raw).slice(1);
      void Promise.resolve(handler(ctx, words, raw))
        .then(async (reply) => {
          try {
            if (typeof reply === "string") await send(ctx.chatId, reply);
            else await sendWithOptions(ctx.chatId, reply.text, reply.options);
          } catch (error: any) {
            // The command already succeeded. A Telegram delivery timeout must
            // not be turned into a misleading command failure response.
            console.error(`[TELEGRAM_REPLY_FAILED] owner=${ctx.ownerId}`, error?.message ?? error);
          }
        })
        .catch(async (error: any) => {
          try {
            await send(ctx.chatId, `❌ ${error?.message ?? error}`);
          } catch (replyError: any) {
            console.error(`[TELEGRAM_ERROR_REPLY_FAILED] owner=${ctx.ownerId}`, replyError?.message ?? replyError);
          }
        });
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
  return sideRaw ? normalizeSide(sideRaw) : (scope.positions.getCloseSide(symbol) ?? "SELL");
}

function assertConnected(ownerId: string): void {
  if ((process.env.MODE ?? "paper").toLowerCase() === "real") sessions.require(ownerId);
}

function formatCreatedTriggerForUser(trigger: any): string {
  const qty = trigger.closePosition
    ? "close position"
    : trigger.closePercentage !== undefined
      ? `${trigger.closePercentage}% of position`
      : trigger.quantity;
  const target =
    trigger.triggerPrice ?? trigger.limitPrice ?? trigger.currentStopPrice ?? trigger.upperPrice ?? trigger.lowerPrice;
  const l2Side = trigger.side === "BUY" ? "ASK" : "BID";
  const pieces = [
    `• ${trigger.kind} ${trigger.side} ${trigger.symbol}`,
    qty ? `qty=${qty}` : "",
    target ? `target=${target}` : "",
    trigger.limitPrice && trigger.limitPrice !== target ? `limit=${trigger.limitPrice}` : "",
    `status=${trigger.status}`,
    `id=${trigger.id}`,
  ].filter(Boolean);
  return `${pieces.join(" ")}\n  Checks executable ${l2Side} depth before firing.`;
}

function created(scope: UserScope, list: any | any[]): string {
  const triggersList = Array.isArray(list) ? list : [list];
  scope.runtime.ensure();
  // Let TriggerStore.watchableSymbols decide which triggers actually need L2.
  // This prevents risk-only or cancel-only triggers from adding unnecessary
  // symbols to the shared multiplexed market-data stream.
  scope.runtime.reconcile();
  const noun = triggersList.length > 1 ? "order triggers" : "order trigger";
  return [
    `✅ Created ${noun}:`,
    triggersList.map(formatCreatedTriggerForUser).join("\n"),
    "",
    "No live Quote.Trade order is sent until the trigger rules are met.",
  ].join("\n");
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
  const reply_markup = draft.commands?.length
    ? {
        inline_keyboard: [
          [
            { text: confirmOrderButtonText(draft.commands.length), callback_data: `llm_confirm:${draft.id}` },
            { text: "Cancel", callback_data: `llm_cancel:${draft.id}` },
          ],
        ],
      }
    : undefined;

  try {
    await sendWithOptions(chatId, formatDraftForTelegramHtml(draft), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(reply_markup ? { reply_markup } : {}),
    });
  } catch (_error) {
    const fallbackText = `${formatDraft(draft)}\n\nConfirm only after review with /llmconfirm ${draft.id}`;
    await sendWithOptions(
      chatId,
      fallbackText,
      reply_markup ? { reply_markup, disable_web_page_preview: true } : { disable_web_page_preview: true },
    );
  }
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
  const plan = await planner.plan({
    ownerId: ctx.ownerId,
    prompt,
    commandFormat: "telegram",
    defaultPaymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
    positionsContext: scope.positions.describe(),
    riskContext: formatRisk(scope.positions),
    resolveCloseSide: (symbol) => scope.positions.getCloseSide(symbol) as any,
  });
  const draft = scope.llmDrafts.add({
    ownerId: ctx.ownerId,
    prompt,
    provider: plan.provider,
    model: plan.model,
    format: "telegram",
    summary: plan.summary,
    commands: plan.commands,
    riskNotes: plan.riskNotes,
  });
  await sendLlmDraft(chatId, draft);
}

async function refreshUserPositionsForCommand(ctx: CommandContext, scope: UserScope, label: string): Promise<number> {
  try {
    sessions.require(ctx.ownerId);

    const count = await scope.service.refreshPositions(ctx.ownerId);

    if (process.env.SESSION_DEBUG === "true") {
      console.log(`[${label}_POSITIONS_REFRESH_DONE]`, {
        ownerId: ctx.ownerId,
        count,
        cachedCount: scope.positions.list().length,
      });
    }

    for (const position of scope.positions.list()) {
      await scope.engine.processPositionUpdate(position.symbol);
    }

    return count;
  } catch (error: any) {
    const status = error?.response?.status;
    const backendMessage = error?.response?.data?.error ?? error?.response?.data?.message;
    const detail = backendMessage ?? error?.message ?? String(error);
    throw new Error(`Could not refresh Quote.Trade positions${status ? ` (HTTP ${status})` : ""}: ${detail}`);
  }
}

function sessionStatus(ownerId: string): string {
  const s = sessions.summary(ownerId);
  if (!s.connected)
    return `No Quote.Trade account session is connected for your Telegram user id ${ownerId}. Use /connectkey in a private chat.`;
  return [
    `Connected Quote.Trade session for Telegram user ${ownerId}`,
    `apiKey=${s.apiKey}`,
    `signing=${s.signingAlgorithm}`,
    s.account ? `account=${s.account}` : undefined,
    s.label ? `label=${s.label}` : undefined,
    s.lastVerifiedAt ? `lastVerified=${new Date(s.lastVerifiedAt).toISOString()}` : undefined,
    `storage=users/${s.pathKey}/session.json`,
  ]
    .filter(Boolean)
    .join("\n");
}

function clearUserPositions(ownerId: string): void {
  const cachedScope = scopes.get(ownerId);
  if (cachedScope) cachedScope.positions.clear();
  else new PositionStore(userStateFile(ownerId, "positions.json")).clear();
}

function connectTradingSession(
  ctx: CommandContext,
  apiKey: string,
  apiSecret: string,
  requestedSigningAlgorithm?: string,
  account?: string,
): string {
  connectWizards.delete(ctx.ownerId);
  const signingAlgorithm = requestedSigningAlgorithm || detectSigningAlgorithm(apiSecret);
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
  // A new account must never inherit cached positions from the previous keys.
  clearUserPositions(ctx.ownerId);
  scopes.delete(ctx.ownerId);
  const scope = getScope(ctx.ownerId);
  if (scope.triggers.active().length) scope.runtime.ensure();
  return `Saved encrypted Quote.Trade session for your Telegram user. apiKey=${redacted(apiKey)} signing=${saved.signingAlgorithm}${saved.account ? ` account=${saved.account}` : ""}`;
}

function disconnectTradingSession(ownerId: string): string {
  connectWizards.delete(ownerId);
  tradingWizards.delete(ownerId);
  scopes.get(ownerId)?.runtime.stop();
  clearUserPositions(ownerId);
  scopes.delete(ownerId);
  const removed = sessions.remove(ownerId);
  return removed
    ? "Disconnected your Quote.Trade account session and stopped your local runtime."
    : "No Quote.Trade session was connected for your Telegram user.";
}

function accountMenuKeyboard(ownerId: string): any {
  return sessions.summary(ownerId).connected ? ACCOUNT_CONNECTED_KEYBOARD : ACCOUNT_DISCONNECTED_KEYBOARD;
}

function accountMenuReply(ownerId: string, text = START_MESSAGE): CommandReply {
  return { text, options: { reply_markup: accountMenuKeyboard(ownerId), disable_web_page_preview: true } };
}

bot.onText(
  /^\/start\b/i,
  command(async (ctx) => {
    connectWizards.delete(ctx.ownerId);
    tradingWizards.delete(ctx.ownerId);
    codexModelWizards.delete(ctx.ownerId);
    llmUiWizards.delete(ctx.ownerId);
    return accountMenuReply(ctx.ownerId);
  }),
);

bot.onText(
  /^\/session\b/i,
  command(async (ctx) => sessionStatus(ctx.ownerId)),
);

bot.onText(
  /^\/connectkey\b.*/i,
  command(async (ctx, words) => {
    if (ctx.chatType !== "private")
      throw new Error("For security, /connectkey is only accepted in a private chat with the bot.");
    if (words.length < 2) throw new Error("Usage: /connectkey <api-key> <api-secret> [sha256|ed25519] [account]");
    const [apiKey, apiSecret, requestedSigningAlgorithm, account] = words;
    // Delete the credential-bearing message even when validation or saving fails,
    // but never wait for Telegram before handling the command.
    void deleteSensitiveCommand(ctx);
    return connectTradingSession(ctx, apiKey, apiSecret, requestedSigningAlgorithm, account);
  }),
);

bot.onText(
  /^\/disconnect\b/i,
  command(async (ctx) => disconnectTradingSession(ctx.ownerId)),
);

(bot as any).on("callback_query", (query: any) => {
  const data = String(query?.data ?? "");
  if (!data.startsWith("account_")) return;

  const chatId = query?.message?.chat?.id;
  const ownerId = String(query?.from?.id ?? "");
  const chatType = query?.message?.chat?.type;
  if (chatId === undefined || !ownerId) return;

  void Promise.resolve()
    .then(async () => {
      if (data === "account_connect" && chatType !== "private") {
        acknowledgeCallback(query.id, {
          text: "Connect API keys in a private chat with the bot.",
          show_alert: true,
        });
        return;
      }

      acknowledgeCallback(query.id);

      if (data === "account_session") {
        await sendWithOptions(chatId, sessionStatus(ownerId), { reply_markup: accountMenuKeyboard(ownerId) });
        return;
      }

      if (data === "account_connect") {
        if (sessions.summary(ownerId).connected) {
          await sendWithOptions(
            chatId,
            "A Quote.Trade session is already connected. Disconnect it before connecting different API keys.",
            {
              reply_markup: accountMenuKeyboard(ownerId),
            },
          );
          return;
        }
        connectWizards.set(ownerId, { step: "api_key", startedAt: Date.now() });
        await sendWithOptions(
          chatId,
          "🔐 Step 1 of 2: send your Quote.Trade API key as a normal message. Your message will be deleted after it is read.",
          {
            reply_markup: ACCOUNT_CONNECT_CANCEL_KEYBOARD,
          },
        );
        return;
      }

      if (data === "account_connect_cancel") {
        connectWizards.delete(ownerId);
        await sendWithOptions(chatId, "API-key connection cancelled.", { reply_markup: accountMenuKeyboard(ownerId) });
        return;
      }

      if (data === "account_disconnect") {
        if (!sessions.summary(ownerId).connected) {
          await sendWithOptions(chatId, "No Quote.Trade session is connected.", {
            reply_markup: accountMenuKeyboard(ownerId),
          });
          return;
        }
        await sendWithOptions(chatId, "Disconnect this Telegram user from the saved Quote.Trade session?", {
          reply_markup: ACCOUNT_DISCONNECT_CONFIRM_KEYBOARD,
        });
        return;
      }

      if (data === "account_disconnect_confirm") {
        await sendWithOptions(chatId, disconnectTradingSession(ownerId), {
          reply_markup: accountMenuKeyboard(ownerId),
        });
        return;
      }

      if (data === "account_disconnect_cancel") {
        await sendWithOptions(chatId, "Disconnect cancelled.", { reply_markup: accountMenuKeyboard(ownerId) });
      }
    })
    .catch(async (error: any) => {
      console.error(`[ACCOUNT_UI_FAILED] owner=${ownerId}`, error?.message ?? error);
      await send(chatId, `❌ ${error?.message ?? error}`).catch(() => undefined);
    });
});

async function handleConnectWizardMessage(msg: any, ownerId: string, state: ConnectWizardState): Promise<void> {
  const chatId = msg?.chat?.id;
  const ctx: CommandContext = { chatId, ownerId, chatType: msg?.chat?.type, msg };
  const value = String(msg?.text ?? "").trim();

  // API keys and secrets should not remain in Telegram chat history.
  void deleteSensitiveCommand(ctx);

  if (Date.now() - state.startedAt > CONNECT_WIZARD_TTL_MS) {
    connectWizards.delete(ownerId);
    await sendWithOptions(chatId, "The API-key connection wizard expired. Please start again.", {
      reply_markup: accountMenuKeyboard(ownerId),
    });
    return;
  }

  assertFreshMessage(msg);
  if (!value) throw new Error("API key or secret cannot be empty");

  if (state.step === "api_key") {
    connectWizards.set(ownerId, { step: "api_secret", apiKey: value, startedAt: state.startedAt });
    await sendWithOptions(
      chatId,
      "✅ API key received and deleted.\n\n🔑 Step 2 of 2: send your Quote.Trade API secret as a normal message. This message will also be deleted.",
      {
        reply_markup: ACCOUNT_CONNECT_CANCEL_KEYBOARD,
      },
    );
    return;
  }

  connectWizards.delete(ownerId);
  if (!state.apiKey) throw new Error("The API-key connection wizard lost its API key. Please start again.");
  const result = connectTradingSession(ctx, state.apiKey, value);
  await sendWithOptions(chatId, result, { reply_markup: accountMenuKeyboard(ownerId) });
}

function filledOrdersKeyboard(page: number, totalPages: number): any {
  const navigation: any[] = [];
  if (page > 1) navigation.push({ text: "⬅️ Previous", callback_data: `monitor_fills:${page - 1}` });
  navigation.push({ text: "🔄 Refresh", callback_data: `monitor_fills:${page}` });
  if (page < totalPages) navigation.push({ text: "Next ➡️", callback_data: `monitor_fills:${page + 1}` });
  return {
    inline_keyboard: [navigation, [{ text: "⬅️ Trading Menu", callback_data: "trade_menu" }]],
  };
}

(bot as any).on("callback_query", (query: any) => {
  const data = String(query?.data ?? "");
  if (!data.startsWith("monitor_")) return;

  const chatId = query?.message?.chat?.id;
  const ownerId = String(query?.from?.id ?? "");
  const chatType = query?.message?.chat?.type;
  if (chatId === undefined || !ownerId) return;
  const ctx: CommandContext = { chatId, ownerId, chatType, msg: query?.message };

  void Promise.resolve()
    .then(async () => {
      acknowledgeCallback(query.id);

      if (data === "monitor_account_menu") {
        const reply = accountMenuReply(ownerId, "🏠 Quote.Trade Home Menu");
        await sendWithOptions(chatId, reply.text, reply.options);
        return;
      }

      if (!sessions.summary(ownerId).connected) {
        await sendWithOptions(chatId, "Connect your Quote.Trade API keys before using monitoring and history.", {
          reply_markup: accountMenuKeyboard(ownerId),
        });
        return;
      }

      if (data === "monitor_menu") {
        await sendWithOptions(chatId, "💹 Trading", { reply_markup: TRADING_KEYBOARD });
        return;
      }

      if (data === "monitor_positions") {
        await sendWithOptions(chatId, await positionsText(ctx), { reply_markup: TRADING_KEYBOARD });
        return;
      }

      if (data === "monitor_risk") {
        await sendWithOptions(chatId, await riskText(ctx), { reply_markup: TRADING_KEYBOARD });
        return;
      }

      if (data === "monitor_triggers_active" || data === "monitor_triggers_all") {
        await sendWithOptions(chatId, triggersText(ctx, data.endsWith("_all")), { reply_markup: TRADING_KEYBOARD });
        return;
      }

      if (data === "monitor_cancel_select") {
        const active = getScope(ownerId).triggers.list({ ownerId, status: "ACTIVE" });
        if (!active.length) {
          await sendWithOptions(chatId, "No active triggers to cancel.", { reply_markup: TRADING_KEYBOARD });
          return;
        }
        const visible = active.slice(0, 20);
        const rows = visible.map((trigger) => [
          {
            text: `❌ ${trigger.kind} ${trigger.symbol} ${trigger.id.slice(-6)}`,
            callback_data: `monitor_cancel:${trigger.id}`,
          },
        ]);
        rows.push([{ text: "⬅️ Trading Menu", callback_data: "trade_menu" }]);
        const suffix =
          active.length > visible.length
            ? `\nShowing the first ${visible.length} of ${active.length} active triggers.`
            : "";
        await sendWithOptions(chatId, `Choose a trigger to review before cancellation.${suffix}`, {
          reply_markup: { inline_keyboard: rows },
        });
        return;
      }

      if (data.startsWith("monitor_cancel:")) {
        const triggerId = data.slice("monitor_cancel:".length);
        const trigger = getScope(ownerId).triggers.get(triggerId);
        if (!trigger || trigger.ownerId !== ownerId || trigger.status !== "ACTIVE") {
          await sendWithOptions(chatId, "That trigger is no longer active.", { reply_markup: TRADING_KEYBOARD });
          return;
        }
        await sendWithOptions(chatId, `Cancel this trigger?\n${formatTriggers([trigger])}`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Confirm Cancellation", callback_data: `monitor_cancel_confirm:${trigger.id}` },
                { text: "✖️ Keep Trigger", callback_data: "monitor_cancel_select" },
              ],
            ],
          },
        });
        return;
      }

      if (data.startsWith("monitor_cancel_confirm:")) {
        const triggerId = data.slice("monitor_cancel_confirm:".length);
        await sendWithOptions(chatId, cancelTriggerText(ctx, triggerId), { reply_markup: TRADING_KEYBOARD });
        return;
      }

      if (data.startsWith("monitor_fills:")) {
        const requestedPage = Number(data.slice("monitor_fills:".length));
        const result = filledOrdersPage(
          ctx,
          Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1,
        );
        await sendWithOptions(chatId, result.text, {
          reply_markup: filledOrdersKeyboard(result.page, result.totalPages),
        });
      }
    })
    .catch(async (error: any) => {
      console.error(`[MONITOR_UI_FAILED] owner=${ownerId}`, error?.message ?? error);
      await sendWithOptions(chatId, `❌ ${error?.message ?? error}`, { reply_markup: TRADING_KEYBOARD }).catch(
        () => undefined,
      );
    });
});

(bot as any).on("callback_query", (query: any) => {
  const data = String(query?.data ?? "");
  if (!data.startsWith("trade_")) return;

  const chatId = query?.message?.chat?.id;
  const ownerId = String(query?.from?.id ?? "");
  const chatType = query?.message?.chat?.type;
  if (chatId === undefined || !ownerId) return;

  void Promise.resolve()
    .then(async () => {
      if (data.startsWith("trade_select:") && chatType !== "private") {
        acknowledgeCallback(query.id, {
          text: "Create trading triggers in a private chat with the bot.",
          show_alert: true,
        });
        return;
      }

      acknowledgeCallback(query.id);

      if (data === "trade_account_menu") {
        const reply = accountMenuReply(ownerId, "🏠 Quote.Trade Home Menu");
        await sendWithOptions(chatId, reply.text, reply.options);
        return;
      }

      if (!sessions.summary(ownerId).connected) {
        tradingWizards.delete(ownerId);
        await sendWithOptions(chatId, "Connect your Quote.Trade API keys before creating or managing triggers.", {
          reply_markup: accountMenuKeyboard(ownerId),
        });
        return;
      }

      if (data === "trade_menu") {
        tradingWizards.delete(ownerId);
        await sendWithOptions(chatId, "💹 Trading", { reply_markup: TRADING_KEYBOARD });
        return;
      }

      if (data === "trade_create_menu") {
        tradingWizards.delete(ownerId);
        await sendWithOptions(chatId, "➕ Choose a trigger strategy", { reply_markup: TRIGGER_CREATE_KEYBOARD });
        return;
      }

      if (data === "trade_cancel") {
        tradingWizards.delete(ownerId);
        await sendWithOptions(chatId, "Trigger creation cancelled.", { reply_markup: TRIGGER_CREATE_KEYBOARD });
        return;
      }

      if (data.startsWith("trade_select:")) {
        const commandName = data.slice("trade_select:".length) as TradingCommandName;
        const help = TRADING_COMMAND_HELP[commandName];
        if (!help) throw new Error("Unknown trading command");
        tradingWizards.set(ownerId, { command: commandName, step: "parameters", startedAt: Date.now() });
        await sendWithOptions(
          chatId,
          `${help.title}\n\nSend these parameters as a normal message (do not include /${commandName}):\n${help.parameters}\n\nExample:\n${help.example}`,
          { reply_markup: TRADE_WIZARD_CANCEL_KEYBOARD },
        );
        return;
      }

      if (data === "trade_confirm") {
        const state = tradingWizards.get(ownerId);
        if (state?.step !== "confirm" || !state.parameters) {
          await sendWithOptions(chatId, "This trigger confirmation expired. Please start again.", {
            reply_markup: TRIGGER_CREATE_KEYBOARD,
          });
          return;
        }
        if (Date.now() - state.startedAt > TRADING_WIZARD_TTL_MS) {
          tradingWizards.delete(ownerId);
          await sendWithOptions(chatId, "This trigger wizard expired. Please start again.", {
            reply_markup: TRIGGER_CREATE_KEYBOARD,
          });
          return;
        }

        tradingWizards.delete(ownerId);
        await sendWithOptions(chatId, `Executing /${state.command}…`, { reply_markup: TRADING_KEYBOARD });
        bot.dispatchText(
          {
            ...query.message,
            from: query.from,
            date: Math.floor(Date.now() / 1000),
          },
          `/${state.command} ${state.parameters}`,
        );
      }
    })
    .catch(async (error: any) => {
      console.error(`[TRADE_UI_FAILED] owner=${ownerId}`, error?.message ?? error);
      await sendWithOptions(chatId, `❌ ${error?.message ?? error}`, { reply_markup: TRADING_KEYBOARD }).catch(
        () => undefined,
      );
    });
});

async function handleTradingWizardMessage(msg: any, ownerId: string, state: TradingWizardState): Promise<void> {
  const chatId = msg?.chat?.id;
  const parameters = String(msg?.text ?? "").trim();
  if (Date.now() - state.startedAt > TRADING_WIZARD_TTL_MS) {
    tradingWizards.delete(ownerId);
    await sendWithOptions(chatId, "This trigger wizard expired. Please start again.", {
      reply_markup: TRIGGER_CREATE_KEYBOARD,
    });
    return;
  }

  assertFreshMessage(msg);
  if (!parameters) throw new Error("Trading parameters cannot be empty");
  tradingWizards.set(ownerId, { ...state, parameters, step: "confirm" });
  await sendWithOptions(
    chatId,
    `Review this trigger command:\n/${state.command} ${parameters}\n\nCreate this trigger?`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Confirm", callback_data: "trade_confirm" },
            { text: "✖️ Cancel", callback_data: "trade_cancel" },
          ],
        ],
      },
    },
  );
}

bot.onText(
  /^\/limit\b.*/i,
  command(async (ctx, words) => {
    const scope = getScope(ctx.ownerId);
    assertConnected(ctx.ownerId);
    if (words.length < 4) throw new Error("Usage: /limit BTC BUY 60000 0.01|close|25%");
    const [symbolRaw, sideRaw, priceRaw, qtyRaw] = words;
    const symbol = normalizeSymbol(symbolRaw);
    return created(
      scope,
      scope.triggers.add({
        ownerId: ctx.ownerId,
        kind: "LIMIT",
        symbol,
        side: normalizeSide(sideRaw),
        triggerPrice: asNumber(priceRaw, "price"),
        ...sizingFromWord(qtyRaw),
        paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
      }),
    );
  }),
);

bot.onText(
  /^\/stoplimit\b.*/i,
  command(async (ctx, words) => {
    const scope = getScope(ctx.ownerId);
    assertConnected(ctx.ownerId);
    if (words.length < 5) throw new Error("Usage: /stoplimit BTC SELL 58000 57950 0.01|close|25%");
    const [symbolRaw, sideRaw, stopRaw, limitRaw, qtyRaw] = words;
    const symbol = normalizeSymbol(symbolRaw);
    return created(
      scope,
      scope.triggers.add({
        ownerId: ctx.ownerId,
        kind: "STOP_LIMIT",
        symbol,
        side: normalizeSide(sideRaw),
        triggerPrice: asNumber(stopRaw, "stop"),
        limitPrice: asNumber(limitRaw, "limit"),
        ...sizingFromWord(qtyRaw),
        paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
      }),
    );
  }),
);

bot.onText(
  /^\/takeprofit\b.*/i,
  command(async (ctx, words) => {
    const scope = getScope(ctx.ownerId);
    assertConnected(ctx.ownerId);
    if (words.length < 3) throw new Error("Usage: /takeprofit BTC SELL 65000 0.01|close|25%");
    const [symbolRaw, sideRaw, priceRaw, qtyRaw] = words;
    const symbol = normalizeSymbol(symbolRaw);
    return created(
      scope,
      scope.triggers.add({
        ownerId: ctx.ownerId,
        kind: "TAKE_PROFIT",
        symbol,
        side: defaultCloseSide(scope, symbol, sideRaw),
        triggerPrice: asNumber(priceRaw, "price"),
        ...sizingFromWord(qtyRaw),
        paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
      }),
    );
  }),
);

bot.onText(
  /^\/stoploss\b.*/i,
  command(async (ctx, words) => {
    const scope = getScope(ctx.ownerId);
    assertConnected(ctx.ownerId);
    if (words.length < 3) throw new Error("Usage: /stoploss BTC SELL 58000 0.01|close|25%");
    const [symbolRaw, sideRaw, priceRaw, qtyRaw] = words;
    const symbol = normalizeSymbol(symbolRaw);
    return created(
      scope,
      scope.triggers.add({
        ownerId: ctx.ownerId,
        kind: "STOP_LOSS",
        symbol,
        side: defaultCloseSide(scope, symbol, sideRaw),
        triggerPrice: asNumber(priceRaw, "price"),
        ...sizingFromWord(qtyRaw),
        paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
      }),
    );
  }),
);

bot.onText(
  /^\/trailingstop\b.*/i,
  command(async (ctx, words) => {
    const scope = getScope(ctx.ownerId);
    assertConnected(ctx.ownerId);
    if (words.length < 4) throw new Error("Usage: /trailingstop BTC SELL 5% 0.01|close|25%");
    const [symbolRaw, sideRaw, trailRaw, qtyRaw] = words;
    const symbol = normalizeSymbol(symbolRaw);
    const trail = parseAmountOrPercent(trailRaw);
    return created(
      scope,
      scope.triggers.add({
        ownerId: ctx.ownerId,
        kind: "TRAILING_STOP",
        symbol,
        side: defaultCloseSide(scope, symbol, sideRaw),
        trailMode: trail.mode,
        trailValue: trail.value,
        ...sizingFromWord(qtyRaw),
        paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
      }),
    );
  }),
);

bot.onText(
  /^\/trailingstoplimit\b.*/i,
  command(async (ctx, words) => {
    const scope = getScope(ctx.ownerId);
    assertConnected(ctx.ownerId);
    if (words.length < 5) throw new Error("Usage: /trailingstoplimit BTC SELL 5% 50 0.01|close|25%");
    const [symbolRaw, sideRaw, trailRaw, offsetRaw, qtyRaw] = words;
    const symbol = normalizeSymbol(symbolRaw);
    const trail = parseAmountOrPercent(trailRaw);
    return created(
      scope,
      scope.triggers.add({
        ownerId: ctx.ownerId,
        kind: "TRAILING_STOP_LIMIT",
        symbol,
        side: defaultCloseSide(scope, symbol, sideRaw),
        trailMode: trail.mode,
        trailValue: trail.value,
        limitOffset: asNumber(offsetRaw, "limitOffset"),
        ...sizingFromWord(qtyRaw),
        paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
      }),
    );
  }),
);

bot.onText(
  /^\/oco\b.*/i,
  command(async (ctx, words) => {
    const scope = getScope(ctx.ownerId);
    assertConnected(ctx.ownerId);
    if (words.length < 5) throw new Error("Usage: /oco BTC SELL 65000 58000 0.01|close|25% [stopLimit]");
    const [symbolRaw, sideRaw, takeProfitRaw, stopLossRaw, qtyRaw, stopLimitRaw] = words;
    const symbol = normalizeSymbol(symbolRaw);
    const side = defaultCloseSide(scope, symbol, sideRaw);
    const sizing = sizingFromWord(qtyRaw);
    const groupId = makeGroupId("oco");
    const childInputs: TriggerInput[] = [
      {
        ownerId: ctx.ownerId,
        kind: "TAKE_PROFIT",
        symbol,
        side,
        triggerPrice: asNumber(takeProfitRaw, "takeProfit"),
        ...sizing,
        paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
      },
      stopLimitRaw
        ? {
            ownerId: ctx.ownerId,
            kind: "STOP_LIMIT",
            symbol,
            side,
            triggerPrice: asNumber(stopLossRaw, "stopLoss"),
            limitPrice: asNumber(stopLimitRaw, "stopLimit"),
            ...sizing,
            paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
          }
        : {
            ownerId: ctx.ownerId,
            kind: "STOP_LOSS",
            symbol,
            side,
            triggerPrice: asNumber(stopLossRaw, "stopLoss"),
            ...sizing,
            paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
          },
    ];
    return created(scope, scope.triggers.addOco(childInputs, groupId));
  }),
);

bot.onText(
  /^\/bracket\b.*/i,
  command(async (ctx, words) => {
    const scope = getScope(ctx.ownerId);
    assertConnected(ctx.ownerId);
    if (words.length < 6) throw new Error("Usage: /bracket BTC BUY 60000 0.01 65000 58000 [57950]");
    const [symbolRaw, sideRaw, entryRaw, qtyRaw, takeProfitRaw, stopLossRaw, stopLimitRaw] = words;
    const symbol = normalizeSymbol(symbolRaw);
    return created(
      scope,
      scope.triggers.add({
        ownerId: ctx.ownerId,
        kind: "LIMIT",
        symbol,
        side: normalizeSide(sideRaw),
        triggerPrice: asNumber(entryRaw, "entry"),
        ...fixedQuantityFromWord(qtyRaw),
        paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
        meta: {
          bracket: {
            takeProfitPrice: asNumber(takeProfitRaw, "takeProfit"),
            stopLossPrice: asNumber(stopLossRaw, "stopLoss"),
            stopLimitPrice: stopLimitRaw ? asNumber(stopLimitRaw, "stopLimit") : undefined,
          },
        },
      }),
    );
  }),
);

bot.onText(
  /^\/scaleout\b.*/i,
  command(async (ctx, words) => {
    const scope = getScope(ctx.ownerId);
    assertConnected(ctx.ownerId);
    if (words.length < 4) throw new Error("Usage: /scaleout BTC SELL 63000 25%");
    const [symbolRaw, sideRaw, priceRaw, percentRaw] = words;
    const symbol = normalizeSymbol(symbolRaw);
    return created(
      scope,
      scope.triggers.add({
        ownerId: ctx.ownerId,
        kind: "TAKE_PROFIT",
        symbol,
        side: defaultCloseSide(scope, symbol, sideRaw),
        triggerPrice: asNumber(priceRaw, "price"),
        closePercentage: parsePercent(percentRaw),
        reduceOnly: true,
        paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
        meta: { strategy: "SCALE_OUT" },
      }),
    );
  }),
);

bot.onText(
  /^\/breakeven\b.*/i,
  command(async (ctx, words) => {
    const scope = getScope(ctx.ownerId);
    assertConnected(ctx.ownerId);
    if (words.length < 3) throw new Error("Usage: /breakeven BTC SELL 3% [plus]");
    const [symbolRaw, sideRaw, afterRaw, plusRaw] = words;
    const symbol = normalizeSymbol(symbolRaw);
    const after = parseAmountOrPercent(afterRaw);
    const plus = plusRaw ? parseAmountOrPercent(plusRaw) : { mode: "AMOUNT" as const, value: 0 };
    return created(
      scope,
      scope.triggers.add({
        ownerId: ctx.ownerId,
        kind: "BREAK_EVEN_STOP",
        symbol,
        side: defaultCloseSide(scope, symbol, sideRaw),
        activationMode: after.mode,
        activationValue: after.value,
        lockMode: plus.mode,
        lockValue: plus.value,
        closePosition: true,
        reduceOnly: true,
        paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
      }),
    );
  }),
);

bot.onText(
  /^\/closeafter\b.*/i,
  command(async (ctx, words) => {
    const scope = getScope(ctx.ownerId);
    assertConnected(ctx.ownerId);
    if (words.length < 2) throw new Error("Usage: /closeafter BTC 4h");
    const [symbolRaw, afterRaw] = words;
    const symbol = normalizeSymbol(symbolRaw);
    return created(
      scope,
      scope.triggers.add({
        ownerId: ctx.ownerId,
        kind: "TIME_CLOSE",
        symbol,
        side: defaultCloseSide(scope, symbol),
        triggerAt: parseTimeOrDuration(afterRaw),
        closePosition: true,
        reduceOnly: true,
        paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
      }),
    );
  }),
);

bot.onText(
  /^\/closeat\b.*/i,
  command(async (ctx, words) => {
    const scope = getScope(ctx.ownerId);
    assertConnected(ctx.ownerId);
    if (words.length < 2) throw new Error("Usage: /closeat BTC 2026-05-14T12:00:00+02:00");
    const [symbolRaw, ...timeParts] = words;
    const symbol = normalizeSymbol(symbolRaw);
    return created(
      scope,
      scope.triggers.add({
        ownerId: ctx.ownerId,
        kind: "TIME_CLOSE",
        symbol,
        side: defaultCloseSide(scope, symbol),
        triggerAt: parseTimeOrDuration(timeParts.join(" ")),
        closePosition: true,
        reduceOnly: true,
        paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
      }),
    );
  }),
);

bot.onText(
  /^\/cancelafter\b.*/i,
  command(async (ctx, words) => {
    const scope = getScope(ctx.ownerId);
    if (words.length < 2) throw new Error("Usage: /cancelafter <trigger-id> 30m");
    const [idRaw, afterRaw] = words;
    const target = scope.triggers.get(idRaw);
    if (!target || target.ownerId !== ctx.ownerId) throw new Error(`No trigger found for your Telegram user: ${idRaw}`);
    return created(
      scope,
      scope.triggers.add({
        ownerId: ctx.ownerId,
        kind: "TIME_CANCEL",
        symbol: target.symbol,
        side: "SELL",
        triggerAt: parseTimeOrDuration(afterRaw),
        cancelTriggerId: idRaw,
        paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
      }),
    );
  }),
);

bot.onText(
  /^\/priceband\b.*/i,
  command(async (ctx, words) => {
    const scope = getScope(ctx.ownerId);
    assertConnected(ctx.ownerId);
    if (words.length < 5)
      throw new Error(
        "Usage: /priceband BTC BUY BREAKOUT 65000 0.01|close|25% or /priceband BTC SELL BREAKOUT 58000 0.01",
      );
    const [symbolRaw, sideRaw, modeRaw, bandPriceRaw, qtyRaw] = words;
    const symbol = normalizeSymbol(symbolRaw);
    const side = normalizeSide(sideRaw);
    const mode = String(modeRaw).toUpperCase() as any;
    const dirNeedsUpper = (mode === "BREAKOUT" && side === "BUY") || (mode === "REVERSION" && side === "SELL");
    return created(
      scope,
      scope.triggers.add({
        ownerId: ctx.ownerId,
        kind: "PRICE_BAND",
        symbol,
        side,
        priceBandMode: mode,
        upperPrice: dirNeedsUpper ? asNumber(bandPriceRaw, "upper") : undefined,
        lowerPrice: dirNeedsUpper ? undefined : asNumber(bandPriceRaw, "lower"),
        ...sizingFromWord(qtyRaw),
        paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
      }),
    );
  }),
);

bot.onText(
  /^\/riskguard\b.*/i,
  command(async (ctx, words) => {
    const scope = getScope(ctx.ownerId);
    assertConnected(ctx.ownerId);
    if (words.length < 3)
      throw new Error("Usage: /riskguard BTC MAX_RISK_USD 500 ALERT|CLOSE_POSITION|CANCEL_TRIGGERS");
    const [symbolRaw, metricRaw, thresholdRaw, actionRaw] = words;
    const symbol = normalizeSymbol(symbolRaw);
    const metric = String(metricRaw).toUpperCase().replace(/-/g, "_") as any;
    const action = String(actionRaw ?? "ALERT")
      .toUpperCase()
      .replace(/-/g, "_") as any;
    return created(
      scope,
      scope.triggers.add({
        ownerId: ctx.ownerId,
        kind: "RISK_GUARD",
        symbol,
        side: defaultCloseSide(scope, symbol),
        riskMetric: metric,
        riskThreshold: asNumber(thresholdRaw, "threshold"),
        riskAction: action,
        closePosition: action === "CLOSE_POSITION",
        reduceOnly: action === "CLOSE_POSITION",
        paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
      }),
    );
  }),
);

bot.onText(
  /^\/closelimit\b.*/i,
  command(async (ctx, words) => {
    const scope = getScope(ctx.ownerId);
    assertConnected(ctx.ownerId);
    if (words.length < 2) throw new Error("Usage: /closelimit BTC 65000");
    const [symbolRaw, priceRaw] = words;
    const symbol = normalizeSymbol(symbolRaw);
    const side = scope.positions.getCloseSide(symbol) ?? "SELL";
    return created(
      scope,
      scope.triggers.add({
        ownerId: ctx.ownerId,
        kind: "LIMIT",
        symbol,
        side,
        triggerPrice: asNumber(priceRaw, "price"),
        closePosition: true,
        paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
      }),
    );
  }),
);

bot.onText(
  /^\/closestoplimit\b.*/i,
  command(async (ctx, words) => {
    const scope = getScope(ctx.ownerId);
    assertConnected(ctx.ownerId);
    if (words.length < 3) throw new Error("Usage: /closestoplimit BTC 58000 57950");
    const [symbolRaw, stopRaw, limitRaw] = words;
    const symbol = normalizeSymbol(symbolRaw);
    const side = scope.positions.getCloseSide(symbol) ?? "SELL";
    return created(
      scope,
      scope.triggers.add({
        ownerId: ctx.ownerId,
        kind: "STOP_LIMIT",
        symbol,
        side,
        triggerPrice: asNumber(stopRaw, "stop"),
        limitPrice: asNumber(limitRaw, "limit"),
        closePosition: true,
        paymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
      }),
    );
  }),
);

function triggersText(ctx: CommandContext, all = false): string {
  const scope = getScope(ctx.ownerId);
  return formatTriggers(scope.triggers.list({ ownerId: ctx.ownerId, status: all ? (undefined as any) : "ACTIVE" }));
}

function cancelTriggerText(ctx: CommandContext, triggerId: string): string {
  const scope = getScope(ctx.ownerId);
  if (!triggerId) throw new Error("Usage: /canceltrigger <trigger-id>");
  const current = scope.triggers.get(triggerId);
  if (!current || current.ownerId !== ctx.ownerId) return `No trigger found for your Telegram user: ${triggerId}`;
  const trigger = scope.triggers.cancel(triggerId);
  scope.runtime.reconcile();
  return trigger ? `Cancelled:\n${formatTriggers([trigger])}` : `Trigger is no longer active: ${triggerId}`;
}

async function positionsText(ctx: CommandContext): Promise<string> {
  const scope = getScope(ctx.ownerId);
  await refreshUserPositionsForCommand(ctx, scope, "POSITIONS");
  return scope.positions.list().length ? scope.positions.describe() : "No open Quote.Trade positions.";
}

async function riskText(ctx: CommandContext): Promise<string> {
  const scope = getScope(ctx.ownerId);
  await refreshUserPositionsForCommand(ctx, scope, "RISK");
  return formatRisk(scope.positions);
}

function filledOrdersPage(ctx: CommandContext, page: number): { text: string; page: number; totalPages: number } {
  const scope = getScope(ctx.ownerId);
  sessions.require(ctx.ownerId);
  scope.runtime.startAccountWatcher();
  const result = scope.orderHistory.fills(page);
  return {
    text: formatOrderPage("Recent fills", result, "filledorders", scope.orderHistory.isSyncing()),
    page: result.page,
    totalPages: result.totalPages,
  };
}

bot.onText(
  /^\/triggers\b.*/i,
  command(async (ctx, words) => triggersText(ctx, words.includes("all"))),
);

bot.onText(
  /^\/canceltrigger\b.*/i,
  command(async (ctx, words) => cancelTriggerText(ctx, words[0])),
);

bot.onText(
  /^\/positions\b/i,
  command(async (ctx) => positionsText(ctx)),
);

bot.onText(
  /^\/risk\b/i,
  command(async (ctx) => riskText(ctx)),
);

// bot.onText(/^\/orders\b.*/i, command(async (ctx, words) => {
//   const scope = getScope(ctx.ownerId);
//   sessions.require(ctx.ownerId);
//
//   scope.runtime.startAccountWatcher();
//
//   const page = parsePage(words);
//   return formatOrderPage("Recent orders", scope.orderHistory.orders(page), "orders");
// }));

bot.onText(
  /^\/filledorders\b.*/i,
  command(async (ctx, words) => {
    const page = parsePage(words);
    return filledOrdersPage(ctx, page).text;
  }),
);

bot.onText(
  /^\/llmconnect\b.*/i,
  command(async (ctx, words) => {
    const scope = getScope(ctx.ownerId);
    if (words.length < 1)
      throw new Error(
        "Usage: /llmconnect openai|codex|ovhcloud|gemini|openrouter|groq|huggingface|pollinations [model] [env:API_KEY|key:<api-key>] [default] [fallback]",
      );
    const [providerRaw, modelRaw, keyRaw, ...flags] = words;
    let apiKey: string | undefined;
    let apiKeyEnv: string | undefined;
    const extraFlags = [...flags];
    if (keyRaw?.startsWith("env:")) apiKeyEnv = keyRaw.slice(4);
    else if (keyRaw?.startsWith("key:")) apiKey = keyRaw.slice(4);
    else if (keyRaw && ["default", "fallback"].includes(keyRaw.toLowerCase())) extraFlags.unshift(keyRaw);
    const model =
      modelRaw &&
      !modelRaw.startsWith("env:") &&
      !modelRaw.startsWith("key:") &&
      !["default", "fallback"].includes(modelRaw.toLowerCase())
        ? modelRaw
        : undefined;
    if (!apiKey && !apiKeyEnv && modelRaw?.startsWith("env:")) apiKeyEnv = modelRaw.slice(4);
    if (!apiKey && !apiKeyEnv && modelRaw?.startsWith("key:")) apiKey = modelRaw.slice(4);
    if (apiKey && ctx.chatType !== "private")
      throw new Error("For security, inline LLM API keys are only accepted in a private chat. Use env:NAME in groups.");
    if (apiKey) await deleteSensitiveCommand(ctx);
    const saved = scope.llmConfig.setConnection({
      ownerId: ctx.ownerId,
      provider: providerRaw,
      model,
      apiKey,
      apiKeyEnv,
      makeDefault: extraFlags.includes("default"),
      useAsFallback: extraFlags.includes("fallback"),
    });
    const keySource =
      saved.provider === "codex-oauth"
        ? "per-user Codex OAuth (/codexconnect)"
        : apiKey
          ? `stored:${redactedSecret(apiKey)}`
          : `env:${saved.apiKeyEnv}`;
    return `Saved LLM connection for your Telegram user: ${saved.provider} model=${saved.model} key=${keySource}`;
  }),
);

function codexMenuKeyboard(ownerId: string): any {
  const status = codexOAuthStatus(ownerId);
  const rows: any[][] = [];
  if (status.pending) {
    rows.push([{ text: "⏳ OAuth Status", callback_data: "codex_status" }]);
    rows.push([{ text: "✖️ Cancel Login", callback_data: "codex_cancel" }]);
  } else if (status.connected) {
    rows.push([{ text: "✅ OAuth Status", callback_data: "codex_status" }]);
    rows.push([{ text: "🚪 Logout Codex", callback_data: "codex_logout" }]);
  } else {
    rows.push([{ text: "🔑 Connect (Default Model)", callback_data: "codex_connect_default" }]);
    rows.push([{ text: "⚙️ Connect (Custom Model)", callback_data: "codex_connect_custom" }]);
    rows.push([{ text: "📋 OAuth Status", callback_data: "codex_status" }]);
  }
  rows.push([{ text: "⬅️ LLM Strategy", callback_data: "llmui_menu" }]);
  return { inline_keyboard: rows };
}

function codexStatusText(ownerId: string): string {
  const status = codexOAuthStatus(ownerId);
  return [
    `Codex OAuth for Telegram user ${ownerId}`,
    `connected=${status.connected}`,
    `pending=${status.pending}`,
    status.loginId ? `loginId=${status.loginId}` : undefined,
    `storage=${status.authFile}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function startCodexConnection(ctx: CommandContext, requestedModel?: string): Promise<CommandReply> {
  if (ctx.chatType !== "private")
    throw new Error("For security, /codexconnect is only accepted in a private chat with the bot.");
  const scope = getScope(ctx.ownerId);
  const model =
    requestedModel && !["default", "fallback"].includes(requestedModel.toLowerCase())
      ? requestedModel
      : process.env.CODEX_MODEL || "default";
  scope.llmConfig.setConnection({
    ownerId: ctx.ownerId,
    provider: "codex-oauth",
    model,
    makeDefault: true,
    useAsFallback: false,
  });
  const challenge = await startCodexOAuthLogin(ctx.ownerId, (result) => {
    void notifyOwner(
      ctx.ownerId,
      result.success
        ? `✅ Codex OAuth connected for your Telegram user. /prompt will use Codex model=${model}.`
        : `❌ Codex OAuth login failed: ${result.error ?? "unknown error"}`,
    );
  });
  return {
    text: [
      "Codex OAuth started for your Telegram user.",
      `Open: ${challenge.verificationUrl}`,
      `Code: ${challenge.userCode}`,
      "After approving, I will send a confirmation message. Then use /prompt or /llmstrategy.",
    ].join("\n"),
    options: {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔗 Open Codex Login", url: challenge.verificationUrl }],
          [{ text: "✖️ Cancel Login", callback_data: "codex_cancel" }],
          [{ text: "📋 OAuth Status", callback_data: "codex_status" }],
        ],
      },
    },
  };
}

bot.onText(
  /^\/codexconnect\b.*/i,
  command(async (ctx, words) => {
    return startCodexConnection(ctx, words[0]);
  }),
);

bot.onText(
  /^\/codexstatus\b/i,
  command(async (ctx) => {
    if (ctx.chatType !== "private")
      throw new Error("For security, /codexstatus is only available in a private chat with the bot.");
    return codexStatusText(ctx.ownerId);
  }),
);

bot.onText(
  /^\/codexcancel\b/i,
  command(async (ctx) => {
    if (ctx.chatType !== "private")
      throw new Error("For security, /codexcancel is only available in a private chat with the bot.");
    return cancelCodexOAuthLogin(ctx.ownerId)
      ? "Cancelled pending Codex OAuth login."
      : "No pending Codex OAuth login for your Telegram user.";
  }),
);

bot.onText(
  /^\/codexlogout\b/i,
  command(async (ctx) => {
    if (ctx.chatType !== "private")
      throw new Error("For security, /codexlogout is only available in a private chat with the bot.");
    return logoutCodexOAuth(ctx.ownerId)
      ? "Removed your local Codex OAuth session."
      : "No local Codex OAuth session was found for your Telegram user.";
  }),
);

(bot as any).on("callback_query", (query: any) => {
  const data = String(query?.data ?? "");
  if (!data.startsWith("codex_")) return;

  const chatId = query?.message?.chat?.id;
  const ownerId = String(query?.from?.id ?? "");
  const chatType = query?.message?.chat?.type;
  if (chatId === undefined || !ownerId) return;
  const ctx: CommandContext = { chatId, ownerId, chatType, msg: query?.message };

  void Promise.resolve()
    .then(async () => {
      if (chatType !== "private") {
        acknowledgeCallback(query.id, {
          text: "Manage Codex OAuth in a private chat with the bot.",
          show_alert: true,
        });
        return;
      }
      acknowledgeCallback(query.id);

      if (data === "codex_account_menu") {
        codexModelWizards.delete(ownerId);
        const reply = accountMenuReply(ownerId, "🏠 Quote.Trade Home Menu");
        await sendWithOptions(chatId, reply.text, reply.options);
        return;
      }

      if (data === "codex_menu") {
        codexModelWizards.delete(ownerId);
        await sendWithOptions(chatId, "🤖 Codex OAuth", { reply_markup: codexMenuKeyboard(ownerId) });
        return;
      }

      if (data === "codex_status") {
        await sendWithOptions(chatId, codexStatusText(ownerId), { reply_markup: codexMenuKeyboard(ownerId) });
        return;
      }

      if (data === "codex_connect_default") {
        const status = codexOAuthStatus(ownerId);
        if (status.connected || status.pending) {
          await sendWithOptions(chatId, codexStatusText(ownerId), { reply_markup: codexMenuKeyboard(ownerId) });
          return;
        }
        await send(chatId, "Starting Codex OAuth…");
        const reply = await startCodexConnection(ctx, "default");
        await sendWithOptions(chatId, reply.text, reply.options);
        return;
      }

      if (data === "codex_connect_custom") {
        const status = codexOAuthStatus(ownerId);
        if (status.connected || status.pending) {
          await sendWithOptions(chatId, codexStatusText(ownerId), { reply_markup: codexMenuKeyboard(ownerId) });
          return;
        }
        codexModelWizards.set(ownerId, { startedAt: Date.now() });
        await sendWithOptions(chatId, "Send the Codex model name as a normal message. Example: gpt-5-codex", {
          reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "codex_model_cancel" }]] },
        });
        return;
      }

      if (data === "codex_model_cancel") {
        codexModelWizards.delete(ownerId);
        await sendWithOptions(chatId, "Custom-model connection cancelled.", {
          reply_markup: codexMenuKeyboard(ownerId),
        });
        return;
      }

      if (data === "codex_cancel") {
        codexModelWizards.delete(ownerId);
        const text = cancelCodexOAuthLogin(ownerId)
          ? "Cancelled pending Codex OAuth login."
          : "No pending Codex OAuth login for your Telegram user.";
        await sendWithOptions(chatId, text, { reply_markup: codexMenuKeyboard(ownerId) });
        return;
      }

      if (data === "codex_logout") {
        await sendWithOptions(chatId, "Remove the local Codex OAuth session for this Telegram user?", {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Logout", callback_data: "codex_logout_confirm" },
                { text: "✖️ Keep Connected", callback_data: "codex_menu" },
              ],
            ],
          },
        });
        return;
      }

      if (data === "codex_logout_confirm") {
        const text = logoutCodexOAuth(ownerId)
          ? "Removed your local Codex OAuth session."
          : "No local Codex OAuth session was found for your Telegram user.";
        await sendWithOptions(chatId, text, { reply_markup: codexMenuKeyboard(ownerId) });
      }
    })
    .catch(async (error: any) => {
      console.error(`[CODEX_UI_FAILED] owner=${ownerId}`, error?.message ?? error);
      await sendWithOptions(chatId, `❌ ${error?.message ?? error}`, {
        reply_markup: codexMenuKeyboard(ownerId),
      }).catch(() => undefined);
    });
});

async function handleCodexModelWizardMessage(msg: any, ownerId: string, state: CodexModelWizardState): Promise<void> {
  const chatId = msg?.chat?.id;
  if (Date.now() - state.startedAt > CODEX_MODEL_WIZARD_TTL_MS) {
    codexModelWizards.delete(ownerId);
    await sendWithOptions(chatId, "The custom-model prompt expired. Please start again.", {
      reply_markup: codexMenuKeyboard(ownerId),
    });
    return;
  }
  assertFreshMessage(msg);
  const model = String(msg?.text ?? "").trim();
  if (!model || /\s/.test(model) || model.length > 100)
    throw new Error("Model name must be one value of at most 100 characters");
  codexModelWizards.delete(ownerId);
  await send(chatId, `Starting Codex OAuth with model=${model}…`);
  const ctx: CommandContext = { chatId, ownerId, chatType: msg?.chat?.type, msg };
  const reply = await startCodexConnection(ctx, model);
  await sendWithOptions(chatId, reply.text, reply.options);
}

bot.onText(
  /^\/llmproviders\b/i,
  command(async (ctx) => formatLlmProviderRows(getScope(ctx.ownerId).llmConfig.listRows(ctx.ownerId))),
);
bot.onText(
  /^\/llmfallbacks\b/i,
  command(
    async () =>
      `Free/no-subscription fallback order: ${FREE_FALLBACK_ORDER.join(" -> ")}\nAnonymous providers are used without a key; other free-tier providers are tried when their env key is present.`,
  ),
);
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
  const prompt = String(msg.text ?? "")
    .replace(/^\/llmstrategy(?:@\w+)?\s*/i, "")
    .trim();
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

  const prompt = String(msg.text ?? "")
    .replace(/^\/prompt(?:@\w+)?\s*/i, "")
    .trim();

  Promise.resolve()
    .then(() => createLlmStrategyDraft(chatId, ctx, prompt))
    .catch((e: any) => send(chatId, `❌ ${e?.message ?? e}`));
});
bot.onText(
  /^\/llmconfirm\b.*/i,
  command(async (ctx, words) => {
    if (!words[0]) throw new Error("Usage: /llmconfirm <draft-id>");
    return confirmLlmDraft(ctx, words[0]);
  }),
);
bot.onText(
  /^\/llmcancel\b.*/i,
  command(async (ctx, words) => {
    if (!words[0]) throw new Error("Usage: /llmcancel <draft-id>");
    const draft = getScope(ctx.ownerId).llmDrafts.mark(words[0], "CANCELLED", ctx.ownerId);
    return `Cancelled ${draft.id}.`;
  }),
);
bot.onText(
  /^\/llmdrafts\b.*/i,
  command(async (ctx, words) => {
    const drafts = getScope(ctx.ownerId).llmDrafts.list(ctx.ownerId, words.includes("all"));
    return drafts.length
      ? drafts.map(formatDraft).join("\n\n---\n\n")
      : "No pending LLM drafts for your Telegram user.";
  }),
);

function llmUiMenuKeyboard(): any {
  return {
    inline_keyboard: [
      [
        { text: "🔑 Connect Provider", callback_data: "llmui_connect_provider" },
        { text: "🤖 Codex OAuth", callback_data: "llmui_codex" },
      ],
      [{ text: "✨ New Strategy Prompt", callback_data: "llmui_prompt" }],
      [
        { text: "📋 Providers", callback_data: "llmui_providers" },
        { text: "🛟 Fallbacks", callback_data: "llmui_fallbacks" },
      ],
      [
        { text: "📝 Pending Drafts", callback_data: "llmui_drafts" },
        { text: "📚 All Drafts", callback_data: "llmui_drafts_all" },
      ],
      [{ text: "🏠 Home Menu", callback_data: "llmui_account_menu" }],
    ],
  };
}

function llmProviderKeyboard(): any {
  return {
    inline_keyboard: [
      [
        { text: "OpenAI", callback_data: "llmui_provider:openai" },
        { text: "Codex OAuth", callback_data: "llmui_provider:codex" },
      ],
      [
        { text: "OVHcloud", callback_data: "llmui_provider:ovhcloud" },
        { text: "Gemini", callback_data: "llmui_provider:gemini" },
      ],
      [
        { text: "OpenRouter", callback_data: "llmui_provider:openrouter" },
        { text: "Groq", callback_data: "llmui_provider:groq" },
      ],
      [
        { text: "Hugging Face", callback_data: "llmui_provider:huggingface" },
        { text: "Pollinations", callback_data: "llmui_provider:pollinations" },
      ],
      [{ text: "⬅️ LLM Strategy Menu", callback_data: "llmui_menu" }],
    ],
  };
}

function saveLlmProviderConnection(ownerId: string, provider: string, apiKey?: string, apiKeyEnv?: string): string {
  const defaults = (LLM_PROVIDER_DEFAULTS as any)[provider];
  if (!defaults) throw new Error(`Unsupported LLM provider: ${provider}`);
  const saved = getScope(ownerId).llmConfig.setConnection({
    ownerId,
    provider,
    model: defaults.defaultModel,
    apiKey,
    apiKeyEnv: apiKey ? "" : (apiKeyEnv ?? ""),
    makeDefault: true,
    useAsFallback: !!defaults.freeFallbackCandidate,
  });
  const keySource = apiKey ? `stored:${redactedSecret(apiKey)}` : apiKeyEnv ? `env:${apiKeyEnv}` : "anonymous";
  return `Saved LLM connection for your Telegram user: ${saved.provider} model=${saved.model} key=${keySource}`;
}

function pendingDraftKeyboard(ownerId: string): any {
  const scope = getScope(ownerId);
  const drafts = scope.llmDrafts.list(ownerId).slice(0, 20);
  const rows = drafts.map((draft) => [
    {
      text: formatDraftButtonLabel(draft, {
        ownerId,
        defaultPaymentCurrency: process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
        resolveCloseSide: (symbol) => scope.positions.getCloseSide(symbol) as any,
        resolveCloseQuantity: (symbol) => scope.positions.getCloseQuantity(symbol),
      }),
      callback_data: `llmui_draft:${draft.id}`,
    },
  ]);
  rows.push([{ text: "⬅️ LLM Strategy Menu", callback_data: "llmui_menu" }]);
  return { inline_keyboard: rows };
}

(bot as any).on("callback_query", (query: any) => {
  const data = String(query?.data ?? "");
  if (!data.startsWith("llmui_")) return;
  const chatId = query?.message?.chat?.id;
  const ownerId = String(query?.from?.id ?? "");
  const chatType = query?.message?.chat?.type;
  if (chatId === undefined || !ownerId) return;

  void Promise.resolve()
    .then(async () => {
      if (chatType !== "private") {
        acknowledgeCallback(query.id, {
          text: "Manage LLM strategies in a private chat with the bot.",
          show_alert: true,
        });
        return;
      }
      acknowledgeCallback(query.id);

      if (data === "llmui_account_menu") {
        llmUiWizards.delete(ownerId);
        const reply = accountMenuReply(ownerId, "🏠 Quote.Trade Home Menu");
        await sendWithOptions(chatId, reply.text, reply.options);
        return;
      }

      if (data === "llmui_menu") {
        llmUiWizards.delete(ownerId);
        await sendWithOptions(chatId, "🧠 LLM Strategy", { reply_markup: llmUiMenuKeyboard() });
        return;
      }

      if (data === "llmui_connect_provider") {
        llmUiWizards.delete(ownerId);
        await sendWithOptions(chatId, "Choose an LLM provider to connect.", { reply_markup: llmProviderKeyboard() });
        return;
      }

      if (data === "llmui_codex") {
        llmUiWizards.delete(ownerId);
        await sendWithOptions(chatId, "🤖 Codex OAuth", { reply_markup: codexMenuKeyboard(ownerId) });
        return;
      }

      if (data.startsWith("llmui_provider:")) {
        const provider = data.slice("llmui_provider:".length);
        if (provider === "codex") {
          await sendWithOptions(chatId, "🤖 Codex OAuth", { reply_markup: codexMenuKeyboard(ownerId) });
          return;
        }
        const defaults = (LLM_PROVIDER_DEFAULTS as any)[provider];
        if (
          !defaults ||
          !["openai", "ovhcloud", "gemini", "openrouter", "groq", "huggingface", "pollinations"].includes(provider)
        ) {
          throw new Error(`Unsupported LLM provider: ${provider}`);
        }

        const configuredEnv = [defaults.defaultApiKeyEnv, ...(defaults.alternateApiKeyEnvs ?? [])]
          .filter(Boolean)
          .find((name: string) => !!String(process.env[name] ?? "").trim());
        if (configuredEnv) {
          const text = saveLlmProviderConnection(ownerId, provider, undefined, configuredEnv);
          await sendWithOptions(chatId, text, { reply_markup: llmUiMenuKeyboard() });
          return;
        }
        if (defaults.requiresApiKey === false) {
          const text = saveLlmProviderConnection(ownerId, provider);
          await sendWithOptions(chatId, text, { reply_markup: llmUiMenuKeyboard() });
          return;
        }

        llmUiWizards.set(ownerId, { kind: "provider_key", provider, startedAt: Date.now() });
        await sendWithOptions(
          chatId,
          `Send your ${defaults.displayName} API key as a normal message. It will be encrypted locally and deleted from Telegram after it is read.\n\nDefault model: ${defaults.defaultModel}`,
          {
            reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "llmui_cancel_wizard" }]] },
          },
        );
        return;
      }

      if (data === "llmui_prompt") {
        llmUiWizards.set(ownerId, { kind: "strategy_prompt", startedAt: Date.now() });
        await sendWithOptions(
          chatId,
          "Describe the strategy you want as a normal message.\n\nExample: Protect my BTC long with a trailing stop and take profit.",
          {
            reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "llmui_cancel_wizard" }]] },
          },
        );
        return;
      }

      if (data === "llmui_cancel_wizard") {
        llmUiWizards.delete(ownerId);
        await sendWithOptions(chatId, "LLM setup cancelled.", { reply_markup: llmUiMenuKeyboard() });
        return;
      }

      if (data === "llmui_providers") {
        const text = formatLlmProviderRows(getScope(ownerId).llmConfig.listRows(ownerId));
        await sendWithOptions(chatId, text, { reply_markup: llmUiMenuKeyboard() });
        return;
      }

      if (data === "llmui_fallbacks") {
        const text = `Free/no-subscription fallback order: ${FREE_FALLBACK_ORDER.join(" -> ")}\nAnonymous providers are used without a key; other free-tier providers are tried when their env key is present.`;
        await sendWithOptions(chatId, text, { reply_markup: llmUiMenuKeyboard() });
        return;
      }

      if (data === "llmui_drafts" || data === "llmui_drafts_all") {
        const includeAll = data.endsWith("_all");
        const drafts = getScope(ownerId).llmDrafts.list(ownerId, includeAll);
        if (!drafts.length) {
          await sendWithOptions(
            chatId,
            includeAll ? "No LLM drafts for your Telegram user." : "No pending LLM drafts for your Telegram user.",
            { reply_markup: llmUiMenuKeyboard() },
          );
          return;
        }
        if (includeAll) {
          await sendWithOptions(chatId, drafts.map(formatDraft).join("\n\n---\n\n"), {
            reply_markup: llmUiMenuKeyboard(),
          });
        } else {
          const suffix = drafts.length > 20 ? `\nShowing the first 20 of ${drafts.length} pending drafts.` : "";
          await sendWithOptions(chatId, `Choose a pending draft to review.${suffix}`, {
            reply_markup: pendingDraftKeyboard(ownerId),
          });
        }
        return;
      }

      if (data.startsWith("llmui_draft:")) {
        const draftId = data.slice("llmui_draft:".length);
        const draft = getScope(ownerId).llmDrafts.get(draftId, ownerId);
        if (draft?.status !== "PENDING") {
          await sendWithOptions(chatId, "That draft is no longer pending.", { reply_markup: llmUiMenuKeyboard() });
          return;
        }
        await sendLlmDraft(chatId, draft);
      }
    })
    .catch(async (error: any) => {
      console.error(`[LLM_UI_FAILED] owner=${ownerId}`, error?.message ?? error);
      await sendWithOptions(chatId, `❌ ${error?.message ?? error}`, { reply_markup: llmUiMenuKeyboard() }).catch(
        () => undefined,
      );
    });
});

async function handleLlmUiWizardMessage(msg: any, ownerId: string, state: LlmUiWizardState): Promise<void> {
  const chatId = msg?.chat?.id;
  const ctx: CommandContext = { chatId, ownerId, chatType: msg?.chat?.type, msg };
  if (Date.now() - state.startedAt > LLM_UI_WIZARD_TTL_MS) {
    llmUiWizards.delete(ownerId);
    if (state.kind === "provider_key") void deleteSensitiveCommand(ctx);
    await sendWithOptions(chatId, "The LLM wizard expired. Please start again.", { reply_markup: llmUiMenuKeyboard() });
    return;
  }
  assertFreshMessage(msg);
  const value = String(msg?.text ?? "").trim();
  if (!value)
    throw new Error(state.kind === "provider_key" ? "API key cannot be empty" : "Strategy prompt cannot be empty");
  llmUiWizards.delete(ownerId);

  if (state.kind === "provider_key") {
    void deleteSensitiveCommand(ctx);
    if (!state.provider) throw new Error("The LLM provider selection was lost. Please start again.");
    const text = saveLlmProviderConnection(ownerId, state.provider, value);
    await sendWithOptions(chatId, text, { reply_markup: llmUiMenuKeyboard() });
    return;
  }

  await send(chatId, "Planning your strategy…");
  await createLlmStrategyDraft(chatId, ctx, value);
}

(bot as any).on("callback_query", (query: any) => {
  const data = String(query?.data ?? "");
  const chatId = query?.message?.chat?.id;
  const ownerId = String(query?.from?.id ?? "");
  if (!chatId || !ownerId || !data.startsWith("llm_")) return;
  const ctx: CommandContext = { chatId, ownerId, chatType: query?.message?.chat?.type, msg: query?.message };
  acknowledgeCallback(query.id);
  Promise.resolve()
    .then(async () => {
      if (data.startsWith("llm_confirm:")) {
        const text = await confirmLlmDraft(ctx, data.slice("llm_confirm:".length));
        await sendWithOptions(chatId, text, { reply_markup: llmUiMenuKeyboard() });
      } else if (data.startsWith("llm_cancel:")) {
        const draft = getScope(ownerId).llmDrafts.mark(data.slice("llm_cancel:".length), "CANCELLED", ownerId);
        await sendWithOptions(chatId, `Cancelled ${draft.id}.`, { reply_markup: llmUiMenuKeyboard() });
      }
    })
    .catch(async (e: any) => {
      await send(chatId, `❌ ${e?.message ?? e}`);
    });
});

bot.onText(/^(?!\/)([\s\S]+)$/i, (msg) => {
  const chatId = msg.chat.id;
  const text = String(msg.text ?? "").trim();

  if (!text) return;

  // Safe first version: only allow plain text prompts in private chat
  if (msg.chat.type !== "private") return;

  let wizardOwnerId: string;
  try {
    wizardOwnerId = ownerIdFrom(msg);
  } catch (error: any) {
    void send(chatId, `❌ ${error?.message ?? error}`);
    return;
  }
  const connectWizard = connectWizards.get(wizardOwnerId);
  if (connectWizard) {
    void handleConnectWizardMessage(msg, wizardOwnerId, connectWizard).catch(async (error: any) => {
      connectWizards.delete(wizardOwnerId);
      await sendWithOptions(chatId, `❌ ${error?.message ?? error}`, {
        reply_markup: accountMenuKeyboard(wizardOwnerId),
      }).catch(() => undefined);
    });
    return;
  }

  const tradingWizard = tradingWizards.get(wizardOwnerId);
  if (tradingWizard) {
    void handleTradingWizardMessage(msg, wizardOwnerId, tradingWizard).catch(async (error: any) => {
      tradingWizards.delete(wizardOwnerId);
      await sendWithOptions(chatId, `❌ ${error?.message ?? error}`, { reply_markup: TRIGGER_CREATE_KEYBOARD }).catch(
        () => undefined,
      );
    });
    return;
  }

  const codexModelWizard = codexModelWizards.get(wizardOwnerId);
  if (codexModelWizard) {
    void handleCodexModelWizardMessage(msg, wizardOwnerId, codexModelWizard).catch(async (error: any) => {
      codexModelWizards.delete(wizardOwnerId);
      await sendWithOptions(chatId, `❌ ${error?.message ?? error}`, {
        reply_markup: codexMenuKeyboard(wizardOwnerId),
      }).catch(() => undefined);
    });
    return;
  }

  const llmUiWizard = llmUiWizards.get(wizardOwnerId);
  if (llmUiWizard) {
    void handleLlmUiWizardMessage(msg, wizardOwnerId, llmUiWizard).catch(async (error: any) => {
      llmUiWizards.delete(wizardOwnerId);
      await sendWithOptions(chatId, `❌ ${error?.message ?? error}`, { reply_markup: llmUiMenuKeyboard() }).catch(
        () => undefined,
      );
    });
    return;
  }

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

/**
 * Start the bot for real: resume runtimes, then open the Telegram long-poll.
 * Handlers are already registered by the time this runs, because registration is
 * pure and happens at module scope.
 */
function startBot(): void {
  resumeExistingOwners();
  bot.startPolling();
  console.log("Quote.Trade Telegram trigger bot started with per-user account sessions");
}

if (require.main === module) startBot();

export { bot, startBot };
