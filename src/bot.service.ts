import { HttpSvc } from "./utils/http.service";
import { SubmitOrderRequest, SubmitOrderResult, toQuoteTradeSide } from "./triggers/types";
import { PositionStore } from "./triggers/position-store";
import { PositionSyncService } from "./triggers/position-sync";

export class BotService {
  constructor(private positions: PositionStore) {}

  async submitOrder(req: SubmitOrderRequest): Promise<SubmitOrderResult> {
    const formattedReq: any = {
      liquidityOrder: 1,
      account: req.account,
      symbol: req.symbol,
      side: toQuoteTradeSide(req.side),
      type: req.type,
      quantity: Number(req.quantity),
      disableLeverage: req.disableLeverage,
      paymentCurrency: req.paymentCurrency ?? process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD",
      timestamp: Date.now(),
      stake: 0,
      stakeOption: 0,
    };
    if (req.type === "LIMIT" && req.price !== undefined) formattedReq.price = req.price;

    if ((process.env.MODE ?? "paper").toLowerCase() !== "real") {
      console.log(`[PAPER] would submit ${JSON.stringify(formattedReq)}`);
      return { clientOrderId: req.clientOrderId ?? `paper_${Date.now()}`, paper: true, raw: formattedReq };
    }

    const resp = await HttpSvc.post("/order", formattedReq);
    return {
      orderId: resp?.orderId ? String(resp.orderId) : undefined,
      clientOrderId: resp?.clientOrderId ? String(resp.clientOrderId) : req.clientOrderId,
      raw: resp,
    };
  }

  async refreshPositions(): Promise<number> { return new PositionSyncService(HttpSvc, this.positions).refresh(); }
}
