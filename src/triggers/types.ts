export type OrderSide = "BUY" | "SELL";
export type ApiOrderSide = "BUY" | "SEL";
export type TriggerKind =
  | "LIMIT"
  | "STOP_LIMIT"
  | "TAKE_PROFIT"
  | "STOP_LOSS"
  | "TRAILING_STOP"
  | "TRAILING_STOP_LIMIT"
  | "BREAK_EVEN_STOP"
  | "TIME_CLOSE"
  | "TIME_CANCEL"
  | "RISK_GUARD"
  | "PRICE_BAND";
export type TriggerDirection = "ABOVE" | "BELOW";
export type TriggerStatus = "ACTIVE" | "TRIGGERED" | "CANCELLED" | "REJECTED";
export type TriggerPriceSource = "last" | "mid" | "bid" | "ask" | "mark";
export type AmountMode = "AMOUNT" | "PERCENT";
export type PriceBandMode = "BREAKOUT" | "REVERSION";
export type RiskMetric = "MAX_POSITION_QTY" | "MAX_RISK_USD" | "MAX_LOSS_USD";
export type RiskAction = "ALERT" | "CLOSE_POSITION" | "CANCEL_TRIGGERS";

export interface PositionSnapshot {
  symbol: string;
  netQty: number;
  availableQty: number;
  avgEntryPrice?: number;
  markPrice?: number;
  riskUsd: number;
  updatedAt: number;
  raw?: unknown;
}

export interface BracketConfig {
  takeProfitPrice: number;
  stopLossPrice: number;
  stopLimitPrice?: number;
  /** Defaults to fixed-size exits sized from position memory after the entry is detected. Set true to close the whole remembered position. */
  useClosePosition?: boolean;
}

export interface TriggerOrder {
  id: string;
  ownerId: string;
  kind: TriggerKind;
  symbol: string;
  side: OrderSide;
  triggerPrice?: number;
  limitPrice?: number;
  quantity?: number;
  closePosition: boolean;
  closePercentage?: number;
  reduceOnly: boolean;
  account?: string;
  paymentCurrency: string;
  status: TriggerStatus;
  createdAt: number;
  updatedAt: number;
  firedAt?: number;
  lastPrice?: number;
  orderId?: string;
  clientOrderId?: string;
  error?: string;
  meta?: Record<string, unknown>;

  triggerSource: TriggerPriceSource;
  ocoGroupId?: string;
  cancelTriggerId?: string;
  cancelGroupId?: string;
  triggerAt?: number;

  trailMode?: AmountMode;
  trailValue?: number;
  activationMode?: AmountMode;
  activationValue?: number;
  lockMode?: AmountMode;
  lockValue?: number;
  highWaterMark?: number;
  lowWaterMark?: number;
  currentStopPrice?: number;
  breakEvenArmed?: boolean;
  limitOffset?: number;

  lowerPrice?: number;
  upperPrice?: number;
  priceBandMode?: PriceBandMode;

  riskMetric?: RiskMetric;
  riskThreshold?: number;
  riskAction?: RiskAction;
}

export interface TriggerInput {
  ownerId?: string;
  kind: TriggerKind;
  symbol: string;
  side: OrderSide | string;
  triggerPrice?: number;
  limitPrice?: number;
  quantity?: number;
  closePosition?: boolean;
  closePercentage?: number;
  reduceOnly?: boolean;
  account?: string;
  paymentCurrency?: string;
  meta?: Record<string, unknown>;
  triggerSource?: TriggerPriceSource;
  ocoGroupId?: string;
  cancelTriggerId?: string;
  cancelGroupId?: string;
  triggerAt?: number;
  trailMode?: AmountMode;
  trailValue?: number;
  activationMode?: AmountMode;
  activationValue?: number;
  lockMode?: AmountMode;
  lockValue?: number;
  limitOffset?: number;
  lowerPrice?: number;
  upperPrice?: number;
  priceBandMode?: PriceBandMode;
  riskMetric?: RiskMetric;
  riskThreshold?: number;
  riskAction?: RiskAction;
}

export interface MarketTick {
  symbol: string;
  price: number;
  last?: number;
  mid?: number;
  bid?: number;
  ask?: number;
  mark?: number;
  ts?: number;
  orderBook?: unknown;
}

export interface SubmitOrderRequest {
  symbol: string;
  side: OrderSide;
  type: "MARKET" | "LIMIT";
  quantity: number;
  price?: number;
  account?: string;
  paymentCurrency?: string;
  reduceOnly?: boolean;
  disableLeverage?: boolean;
  /** Local id only. Do not add trigger metadata to the Quote.Trade API body. */
  clientOrderId?: string;
}
export interface SubmitOrderResult { orderId?: string; clientOrderId?: string; raw?: unknown; paper?: boolean; }
export interface TriggerOrderExecutor { submitOrder(req: SubmitOrderRequest): Promise<SubmitOrderResult>; }

export function normalizeSymbol(symbol: string): string {
  const cleaned = String(symbol ?? "").trim().toUpperCase();
  if (!cleaned) throw new Error("symbol is required");
  return cleaned;
}

export function normalizeSide(side: string): OrderSide {
  const s = String(side ?? "").trim().toUpperCase();
  if (["BUY", "BID", "1"].includes(s)) return "BUY";
  if (["SELL", "SEL", "ASK", "2"].includes(s)) return "SELL";
  throw new Error(`side must be BUY or SELL, got: ${side}`);
}

export function toQuoteTradeSide(side: OrderSide): ApiOrderSide { return side === "SELL" ? "SEL" : "BUY"; }

export function assertPositiveNumber(value: unknown, name: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

export function assertNonNegativeNumber(value: unknown, name: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be zero or a positive number`);
  return n;
}

export function assertPercentage(value: unknown, name: string): number {
  const n = assertPositiveNumber(value, name);
  if (n > 100) throw new Error(`${name} must be <= 100`);
  return n;
}

export function makeTriggerId(prefix = "trg"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeGroupId(prefix = "grp"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeTriggerSource(value?: string): TriggerPriceSource {
  const source = String(value ?? "last").trim().toLowerCase();
  if (["last", "mid", "bid", "ask", "mark"].includes(source)) return source as TriggerPriceSource;
  throw new Error("triggerSource must be last, mid, bid, ask, or mark");
}

export function normalizeAmountMode(value?: string): AmountMode {
  const mode = String(value ?? "AMOUNT").trim().toUpperCase();
  if (mode === "AMOUNT" || mode === "PERCENT") return mode;
  throw new Error("amount mode must be AMOUNT or PERCENT");
}

export function parseAmountOrPercent(raw: string): { mode: AmountMode; value: number } {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("amount is required");
  if (text.endsWith("%")) return { mode: "PERCENT", value: assertPercentage(text.slice(0, -1), "percent") };
  return { mode: "AMOUNT", value: assertPositiveNumber(text, "amount") };
}

export function distanceFromMode(referencePrice: number, mode: AmountMode = "AMOUNT", value = 0): number {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return 0;
  const v = Number(value ?? 0);
  if (!Number.isFinite(v) || v < 0) return 0;
  return mode === "PERCENT" ? referencePrice * (v / 100) : v;
}

export function parseDurationMs(raw: string): number {
  const text = String(raw ?? "").trim().toLowerCase();
  const m = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!m) throw new Error("duration must look like 30s, 15m, 4h, or 1d");
  const n = assertPositiveNumber(m[1], "duration");
  const unit = m[2];
  const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}

export function parseTimeOrDuration(raw: string, now = Date.now()): number {
  const text = String(raw ?? "").trim();
  if (/^\d+(?:\.\d+)?(ms|s|m|h|d)$/i.test(text)) return now + parseDurationMs(text);
  const ts = Date.parse(text);
  if (!Number.isFinite(ts)) throw new Error("time must be an ISO date/time or a duration like 30m/4h/1d");
  if (ts <= now) throw new Error("time must be in the future");
  return ts;
}

export function sideToClosePosition(netQty: number): OrderSide | undefined {
  if (netQty > 0) return "SELL";
  if (netQty < 0) return "BUY";
  return undefined;
}

export function oppositeSide(side: OrderSide): OrderSide { return side === "BUY" ? "SELL" : "BUY"; }

export function deriveTriggerDirection(trigger: Pick<TriggerOrder, "kind" | "side" | "priceBandMode">): TriggerDirection | undefined {
  switch (trigger.kind) {
    case "LIMIT": return trigger.side === "BUY" ? "BELOW" : "ABOVE";
    case "STOP_LIMIT": return trigger.side === "BUY" ? "ABOVE" : "BELOW";
    case "TAKE_PROFIT": return trigger.side === "BUY" ? "BELOW" : "ABOVE";
    case "STOP_LOSS": return trigger.side === "BUY" ? "ABOVE" : "BELOW";
    case "TRAILING_STOP":
    case "TRAILING_STOP_LIMIT":
    case "BREAK_EVEN_STOP": return trigger.side === "BUY" ? "ABOVE" : "BELOW";
    case "PRICE_BAND": {
      const mode = trigger.priceBandMode ?? "BREAKOUT";
      if (mode === "BREAKOUT") return trigger.side === "BUY" ? "ABOVE" : "BELOW";
      return trigger.side === "BUY" ? "BELOW" : "ABOVE";
    }
    default: return undefined;
  }
}

export function priceTargetForTrigger(trigger: TriggerOrder): number | undefined {
  if (trigger.kind === "TRAILING_STOP" || trigger.kind === "TRAILING_STOP_LIMIT" || trigger.kind === "BREAK_EVEN_STOP") return trigger.currentStopPrice ?? trigger.triggerPrice;
  if (trigger.kind === "PRICE_BAND") {
    const dir = deriveTriggerDirection(trigger);
    return dir === "ABOVE" ? trigger.upperPrice ?? trigger.triggerPrice : trigger.lowerPrice ?? trigger.triggerPrice;
  }
  return trigger.triggerPrice;
}

export function shouldTrigger(trigger: TriggerOrder, price: number): boolean {
  if (trigger.status !== "ACTIVE") return false;
  if (!Number.isFinite(price) || price <= 0) return false;
  if (trigger.kind === "BREAK_EVEN_STOP" && !trigger.breakEvenArmed) return false;
  const dir = deriveTriggerDirection(trigger);
  if (!dir) return false;
  const target = priceTargetForTrigger(trigger);
  if (!Number.isFinite(target as number) || (target as number) <= 0) return false;
  return dir === "ABOVE" ? price >= (target as number) : price <= (target as number);
}

export function orderPriceForTrigger(trigger: TriggerOrder, marketPrice?: number): number | undefined {
  if (trigger.kind === "LIMIT") return trigger.triggerPrice;
  if (trigger.kind === "STOP_LIMIT") return trigger.limitPrice;
  if (trigger.kind === "TRAILING_STOP_LIMIT") {
    const stop = trigger.currentStopPrice ?? trigger.triggerPrice ?? marketPrice;
    if (!Number.isFinite(stop as number) || (stop as number) <= 0) return undefined;
    const offset = trigger.limitOffset ?? 0;
    return trigger.side === "SELL" ? (stop as number) - offset : (stop as number) + offset;
  }
  return trigger.limitPrice;
}

export function orderTypeForTrigger(trigger: TriggerOrder, marketPrice?: number): "MARKET" | "LIMIT" {
  const price = orderPriceForTrigger(trigger, marketPrice);
  return price && price > 0 ? "LIMIT" : "MARKET";
}

export function selectTickPrice(tick: MarketTick, source: TriggerPriceSource = "last", position?: PositionSnapshot): number {
  const pick = (v: unknown): number | undefined => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const bid = pick(tick.bid);
  const ask = pick(tick.ask);
  if (source === "bid") return bid ?? pick(tick.price) ?? 0;
  if (source === "ask") return ask ?? pick(tick.price) ?? 0;
  if (source === "mid") return pick(tick.mid) ?? (bid && ask ? (bid + ask) / 2 : undefined) ?? pick(tick.price) ?? 0;
  if (source === "mark") return pick(tick.mark) ?? pick(position?.markPrice) ?? pick(tick.price) ?? 0;
  return pick(tick.last) ?? pick(tick.price) ?? 0;
}

export function unrealizedPnlUsd(position?: PositionSnapshot): number {
  if (!position || !Number.isFinite(position.netQty) || !Number.isFinite(position.avgEntryPrice as number) || !Number.isFinite(position.markPrice as number)) return 0;
  return position.netQty * ((position.markPrice as number) - (position.avgEntryPrice as number));
}

export function formatUsd(value: number): string { return Number.isFinite(value) ? `$${value.toFixed(2)}` : "$0.00"; }
