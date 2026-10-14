import { createHash, randomUUID } from "node:crypto";
import type { AccountRiskStore } from "./account-risk";
import type { BotService } from "./bot.service";
import { asNumber } from "./bot.utils";
import type { TradingSessionStore } from "./sessions/trading-session-store";
import type { TriggerRuntime } from "./trigger-runtime";
import { normalizeSide, normalizeSymbol, type OrderSide, type SubmitOrderResult } from "./triggers/types";

export interface MarketOrderContext {
  ownerId: string;
  chatId: string | number;
  chatType?: string;
}

interface MarketOrderScope {
  accountRisk: Pick<AccountRiskStore, "isAccountFresh" | "updateAccount" | "canTrade">;
  service: Pick<BotService, "refreshAccount" | "submitOrder">;
  runtime: Pick<TriggerRuntime, "prepareAccountWatcher">;
}

interface MarketOrderDependencies {
  sessionIdentity: (ownerId: string) => string | undefined;
  getScope: (ownerId: string) => MarketOrderScope;
  isRealMode: () => boolean;
  paymentCurrency: () => string;
}

interface MarketOrderDraft {
  id: string;
  chatId: string | number;
  symbol: string;
  side: OrderSide;
  quantity: number;
  startedAt: number;
  sessionIdentity?: string;
  real: boolean;
  confirming: boolean;
}

/**
 * Use encrypted credential revisions rather than updatedAt: successful account
 * refreshes touch updatedAt without changing the connected credentials.
 * This identity stays in memory and never goes into a callback or order body.
 */
export function marketSessionIdentity(
  sessions: Pick<TradingSessionStore, "getStored">,
  ownerId: string,
): string | undefined {
  const session = sessions.getStored(ownerId);
  if (!session) return undefined;
  return createHash("sha256")
    .update(
      JSON.stringify([session.apiKeyEncrypted, session.apiSecretEncrypted, session.signingAlgorithm, session.account]),
    )
    .digest("hex");
}

export class MarketOrderFlow {
  private drafts = new Map<string, MarketOrderDraft>();

  constructor(
    private dependencies: MarketOrderDependencies,
    private ttlMs = 5 * 60 * 1000,
  ) {}

  invalidate(ownerId: string): void {
    // Removing the same draft also invalidates a confirmation already awaiting
    // account refresh or stream readiness.
    this.drafts.delete(ownerId);
  }

  preview(ctx: MarketOrderContext, words: string[]) {
    if (ctx.chatType !== "private") throw new Error("Market orders are only accepted in a private chat with the bot.");
    if (words.length !== 3) throw new Error("Usage: /market BTC BUY 0.01 (asset quantity, not USD or percent)");
    const symbol = normalizeSymbol(words[0]);
    const side = normalizeSide(words[1]);
    const quantity = asNumber(words[2], "quantity");
    if (quantity <= 0) throw new Error("quantity must be positive");
    const real = this.dependencies.isRealMode();
    const sessionIdentity = this.dependencies.sessionIdentity(ctx.ownerId);
    if (real && !sessionIdentity) throw new Error("Connect your Quote.Trade API keys before placing a market order.");
    const draft: MarketOrderDraft = {
      id: randomUUID(),
      chatId: ctx.chatId,
      symbol,
      side,
      quantity,
      startedAt: Date.now(),
      sessionIdentity,
      real,
      confirming: false,
    };
    this.drafts.set(ctx.ownerId, draft);
    return {
      text: `Review MARKET ${side} ${symbol} qty=${quantity}. Execution price is not guaranteed. Leverage is disabled. Confirm only if this is the intended order.`,
      options: {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Submit Market Order", callback_data: `trade_market_confirm:${draft.id}` },
              { text: "✖️ Cancel", callback_data: `trade_market_cancel:${draft.id}` },
            ],
          ],
        },
      },
    };
  }

  private requireDraft(ctx: MarketOrderContext, id: string): MarketOrderDraft {
    if (ctx.chatType !== "private") throw new Error("Market orders are only accepted in a private chat with the bot.");
    const draft = this.drafts.get(ctx.ownerId);
    if (!draft || draft.id !== id || draft.chatId !== ctx.chatId || Date.now() - draft.startedAt > this.ttlMs) {
      // A stale button must not consume the latest preview.
      throw new Error("Market order confirmation expired. Enter /market again.");
    }
    return draft;
  }

  cancel(ctx: MarketOrderContext, id: string): void {
    const draft = this.requireDraft(ctx, id);
    if (draft.confirming) throw new Error("Market order confirmation is already in progress.");
    this.invalidate(ctx.ownerId);
  }

  private assertCurrent(ctx: MarketOrderContext, draft: MarketOrderDraft): void {
    if (this.drafts.get(ctx.ownerId) !== draft || Date.now() - draft.startedAt > this.ttlMs) {
      throw new Error("Market order confirmation expired. Enter /market again.");
    }
    if (
      this.dependencies.sessionIdentity(ctx.ownerId) !== draft.sessionIdentity ||
      this.dependencies.isRealMode() !== draft.real
    ) {
      throw new Error("Your trading session changed. Enter /market again and review the order.");
    }
  }

  async confirm(
    ctx: MarketOrderContext,
    id: string,
  ): Promise<{ symbol: string; side: OrderSide; quantity: number; result: SubmitOrderResult }> {
    const draft = this.requireDraft(ctx, id);
    if (draft.confirming) throw new Error("Market order confirmation is already in progress.");
    draft.confirming = true;
    try {
      this.assertCurrent(ctx, draft);
      const scope = this.dependencies.getScope(ctx.ownerId);
      if (draft.real) {
        if (!scope.accountRisk.isAccountFresh()) {
          const account = await scope.service.refreshAccount(ctx.ownerId);
          this.assertCurrent(ctx, draft);
          scope.accountRisk.updateAccount(account);
        }
        if (!scope.accountRisk.canTrade()) {
          throw new Error(
            "Account trading permission or margin snapshot is unavailable or stale. Run /risk and try again.",
          );
        }
        await scope.runtime.prepareAccountWatcher();
      }
      // No await between this check and submitOrder: BotService resolves the
      // session synchronously before posting, so reconnect cannot redirect it.
      this.assertCurrent(ctx, draft);
      const result = await scope.service.submitOrder({
        ownerId: ctx.ownerId,
        symbol: draft.symbol,
        side: draft.side,
        type: "MARKET",
        quantity: draft.quantity,
        disableLeverage: 1,
        paymentCurrency: this.dependencies.paymentCurrency(),
      });
      return { symbol: draft.symbol, side: draft.side, quantity: draft.quantity, result };
    } finally {
      if (this.drafts.get(ctx.ownerId) === draft) this.invalidate(ctx.ownerId);
    }
  }
}
