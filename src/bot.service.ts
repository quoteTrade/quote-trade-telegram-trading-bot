import { HttpSvc } from "./utils/http.service";
import { SubmitOrderRequest, SubmitOrderResult, toQuoteTradeSide } from "./triggers/types";
import { PositionStore } from "./triggers/position-store";
import { PositionSyncService } from "./triggers/position-sync";
import {redacted, TradingSessionStore} from "./sessions/trading-session-store";

export class BotService {
  constructor(
    private positions: PositionStore,
    private sessions?: TradingSessionStore,
    private ownerId = "default",
    private http: typeof HttpSvc = HttpSvc,
  ) {}

  private resolveOwner(reqOwnerId?: string): string {
    return String(reqOwnerId || this.ownerId || "default");
  }

  private sessionForRealMode(ownerId: string): any {
    return (process.env.MODE ?? "paper").toLowerCase() === "real" && this.sessions ? this.sessions.require(ownerId) : undefined;
  }

  private quoteTradeConfig(ownerId: string, preloadedSession?: any): any {
    if (!this.sessions) return {};
    const session = preloadedSession ?? this.sessions.require(ownerId);
    return {
      quoteTradeCredentials: {
        apiKey: session.apiKey,
        apiSecret: session.apiSecret,
        signingAlgorithm: session.signingAlgorithm,
      },
      allowEnvCredentials: false,
    };
  }

  async submitOrder(req: SubmitOrderRequest): Promise<SubmitOrderResult> {
    const ownerId = this.resolveOwner(req.ownerId);
    if (!req.symbol) throw new Error("symbol is required");
    const quantity = Number(req.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("quantity must be a positive number");
    if (req.type === "LIMIT") {
      const price = Number(req.price);
      if (!Number.isFinite(price) || price <= 0) throw new Error("limit price must be a positive number");
    }
    const session = this.sessionForRealMode(ownerId);

    if (process.env.SESSION_DEBUG === "true") {
      console.log("[ORDER_SESSION_RESOLVED]", {
        ownerId,
        mode: process.env.MODE ?? "paper",
        hasSession: !!session,
        account: session?.account,
        signingAlgorithm: session?.signingAlgorithm,
        apiKeyMasked: session ? redacted(session.apiKey) : undefined,
        symbol: req.symbol,
        side: req.side,
        type: req.type,
        quantity: req.quantity,
        price: req.price,
      });
    }

    const formattedReq: any = {
      liquidityOrder: 1,
      account: req.account ?? session?.account,
      symbol: req.symbol,
      side: toQuoteTradeSide(req.side),
      type: req.type,
      quantity,
      disableLeverage: req.disableLeverage,
      paymentCurrency: req.paymentCurrency ?? process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
      timestamp: Date.now(),
      stake: 0,
      stakeOption: 0,
    };
    if (req.type === "LIMIT" && req.price !== undefined) formattedReq.price = req.price;

    if ((process.env.MODE ?? "paper").toLowerCase() !== "real") {
      console.log(`[PAPER][owner=${ownerId}] would submit ${JSON.stringify(formattedReq)}`);
      return { clientOrderId: req.clientOrderId ?? `paper_${Date.now()}`, paper: true, raw: formattedReq };
    }

    if (process.env.SESSION_DEBUG === "true") {
      console.log("[ORDER_SUBMIT_REAL]", {
        ownerId,
        symbol: formattedReq.symbol,
        side: formattedReq.side,
        type: formattedReq.type,
        quantity: formattedReq.quantity,
        price: formattedReq.price,
        account: formattedReq.account,
      });
    }

    const resp = await this.http.post("/order", formattedReq, this.quoteTradeConfig(ownerId, session));
    return {
      orderId: resp?.orderId ? String(resp.orderId) : undefined,
      clientOrderId: resp?.clientOrderId ? String(resp.clientOrderId) : req.clientOrderId,
      raw: resp,
    };
  }

  async refreshPositions(ownerId = this.ownerId): Promise<number> {
    const config = this.sessions ? this.quoteTradeConfig(ownerId) : {};
    const count = await new PositionSyncService(this.http, this.positions).refresh(config);
    if (count > 0 && this.sessions) this.sessions.touchVerified(ownerId);
    return count;
  }
}
