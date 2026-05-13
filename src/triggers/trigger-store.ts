import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  assertNonNegativeNumber,
  assertPercentage,
  assertPositiveNumber,
  makeGroupId,
  makeTriggerId,
  normalizeAmountMode,
  normalizeSide,
  normalizeSymbol,
  normalizeTriggerSource,
  RiskAction,
  RiskMetric,
  TriggerInput,
  TriggerKind,
  TriggerOrder,
  TriggerStatus,
} from "./types";

export interface TriggerStoreUpdateOptions {
  persist?: boolean;
}

const SUPPORTED_TRIGGER_KINDS = new Set<TriggerKind>([
  "LIMIT",
  "STOP_LIMIT",
  "TAKE_PROFIT",
  "STOP_LOSS",
  "TRAILING_STOP",
  "TRAILING_STOP_LIMIT",
  "BREAK_EVEN_STOP",
  "TIME_CLOSE",
  "TIME_CANCEL",
  "RISK_GUARD",
  "PRICE_BAND",
]);

const PRICE_TRIGGER_KINDS = new Set<TriggerKind>([
  "LIMIT",
  "STOP_LIMIT",
  "TAKE_PROFIT",
  "STOP_LOSS",
]);

const RISK_METRICS = new Set<RiskMetric>([
  "MAX_POSITION_QTY",
  "MAX_RISK_USD",
  "MAX_LOSS_USD",
]);

const RISK_ACTIONS = new Set<RiskAction>([
  "ALERT",
  "CLOSE_POSITION",
  "CANCEL_TRIGGERS",
]);

function defaultDataFile(name: string): string {
  return join(process.env.QUOTE_TRADE_STATE_DIR || join(process.cwd(), ".quote-trade"), name);
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filePath);
}

function hasChanged(current: TriggerOrder, patch: Partial<TriggerOrder>): boolean {
  return Object.entries(patch).some(([key, value]) => (current as any)[key] !== value);
}

function isOrderSubmittingKind(kind: TriggerKind): boolean {
  return kind !== "TIME_CANCEL";
}

function normalizeRiskMetric(metric: unknown): RiskMetric {
  const value = String(metric ?? "").trim().toUpperCase().replace(/-/g, "_") as RiskMetric;
  if (!RISK_METRICS.has(value)) throw new Error("riskMetric must be MAX_POSITION_QTY, MAX_RISK_USD, or MAX_LOSS_USD");
  return value;
}

function normalizeRiskAction(action: unknown): RiskAction {
  const value = String(action ?? "").trim().toUpperCase().replace(/-/g, "_") as RiskAction;
  if (!RISK_ACTIONS.has(value)) throw new Error("riskAction must be ALERT, CLOSE_POSITION, or CANCEL_TRIGGERS");
  return value;
}

export class TriggerStore {
  private readonly filePath: string;
  private triggers = new Map<string, TriggerOrder>();

  constructor(filePath = defaultDataFile("triggers.json")) {
    this.filePath = filePath;
    this.load();
  }

  load(): void {
    const data = readJsonFile<TriggerOrder[]>(this.filePath, []);
    this.triggers.clear();
    for (const trigger of Array.isArray(data) ? data : []) {
      if (trigger?.id) this.triggers.set(trigger.id, { ...trigger, triggerSource: trigger.triggerSource ?? "last" });
    }
  }

  save(): void {
    writeJsonFile(this.filePath, this.list());
  }

  add(input: TriggerInput): TriggerOrder {
    if (!SUPPORTED_TRIGGER_KINDS.has(input.kind)) throw new Error(`unsupported trigger kind: ${input.kind}`);

    const now = Date.now();
    const side = normalizeSide(String(input.side));
    const triggerPrice = input.triggerPrice === undefined ? undefined : assertPositiveNumber(input.triggerPrice, "triggerPrice");
    const limitPrice = input.limitPrice === undefined ? undefined : assertPositiveNumber(input.limitPrice, "limitPrice");
    const quantity = input.quantity === undefined ? undefined : assertPositiveNumber(input.quantity, "quantity");
    const closePercentage = input.closePercentage === undefined ? undefined : assertPercentage(input.closePercentage, "closePercentage");
    const closePosition = input.closePosition === true;

    if (PRICE_TRIGGER_KINDS.has(input.kind) && triggerPrice === undefined) throw new Error(`${input.kind} requires triggerPrice`);
    if (input.kind === "STOP_LIMIT" && limitPrice === undefined) throw new Error("limitPrice is required for STOP_LIMIT triggers");

    if (input.kind === "TRAILING_STOP" || input.kind === "TRAILING_STOP_LIMIT") {
      if (input.trailValue === undefined) throw new Error(`${input.kind} requires trailValue`);
      assertPositiveNumber(input.trailValue, "trailValue");
      if (input.kind === "TRAILING_STOP_LIMIT" && input.limitOffset !== undefined) assertNonNegativeNumber(input.limitOffset, "limitOffset");
    }

    if (input.kind === "BREAK_EVEN_STOP") {
      if (input.activationValue === undefined) throw new Error("BREAK_EVEN_STOP requires activationValue");
      assertPositiveNumber(input.activationValue, "activationValue");
      if (input.lockValue !== undefined) assertNonNegativeNumber(input.lockValue, "lockValue");
    }

    if ((input.kind === "TIME_CLOSE" || input.kind === "TIME_CANCEL") && (!input.triggerAt || input.triggerAt <= now)) {
      throw new Error(`${input.kind} requires a future triggerAt timestamp`);
    }
    if (input.kind === "TIME_CANCEL" && !input.cancelTriggerId && !input.cancelGroupId) {
      throw new Error("TIME_CANCEL requires cancelTriggerId or cancelGroupId");
    }

    if (input.kind === "PRICE_BAND") {
      if (!input.priceBandMode) throw new Error("PRICE_BAND requires priceBandMode");
      if (input.priceBandMode !== "BREAKOUT" && input.priceBandMode !== "REVERSION") throw new Error("priceBandMode must be BREAKOUT or REVERSION");
      const needsUpper =
        (input.priceBandMode === "BREAKOUT" && side === "BUY") ||
        (input.priceBandMode === "REVERSION" && side === "SELL");
      const needsLower =
        (input.priceBandMode === "BREAKOUT" && side === "SELL") ||
        (input.priceBandMode === "REVERSION" && side === "BUY");
      if (needsUpper && input.upperPrice === undefined) throw new Error("PRICE_BAND requires upperPrice for this side/mode");
      if (needsLower && input.lowerPrice === undefined) throw new Error("PRICE_BAND requires lowerPrice for this side/mode");
    }

    const riskMetric = input.kind === "RISK_GUARD" ? normalizeRiskMetric(input.riskMetric) : input.riskMetric;
    const riskAction = input.kind === "RISK_GUARD" ? normalizeRiskAction(input.riskAction) : input.riskAction;
    if (input.kind === "RISK_GUARD") assertPositiveNumber(input.riskThreshold, "riskThreshold");

    if (isOrderSubmittingKind(input.kind)) {
      const canResolveFromPosition = closePosition || closePercentage !== undefined || input.kind === "RISK_GUARD";
      if (!canResolveFromPosition && quantity === undefined) throw new Error("quantity is required unless closePosition or closePercentage is set");
    }

    const trigger: TriggerOrder = {
      id: makeTriggerId(),
      ownerId: input.ownerId ?? "default",
      kind: input.kind,
      symbol: normalizeSymbol(input.symbol),
      side,
      triggerPrice,
      limitPrice,
      quantity,
      closePosition,
      closePercentage,
      reduceOnly: input.reduceOnly ?? (closePosition || closePercentage !== undefined),
      account: input.account,
      paymentCurrency: input.paymentCurrency ?? "USD",
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
      meta: input.meta,
      triggerSource: normalizeTriggerSource(input.triggerSource),
      ocoGroupId: input.ocoGroupId,
      cancelTriggerId: input.cancelTriggerId,
      cancelGroupId: input.cancelGroupId,
      triggerAt: input.triggerAt,
      trailMode: input.trailMode ? normalizeAmountMode(input.trailMode) : undefined,
      trailValue: input.trailValue,
      activationMode: input.activationMode ? normalizeAmountMode(input.activationMode) : undefined,
      activationValue: input.activationValue,
      lockMode: input.lockMode ? normalizeAmountMode(input.lockMode) : undefined,
      lockValue: input.lockValue,
      limitOffset: input.limitOffset === undefined ? undefined : assertNonNegativeNumber(input.limitOffset, "limitOffset"),
      lowerPrice: input.lowerPrice === undefined ? undefined : assertPositiveNumber(input.lowerPrice, "lowerPrice"),
      upperPrice: input.upperPrice === undefined ? undefined : assertPositiveNumber(input.upperPrice, "upperPrice"),
      priceBandMode: input.priceBandMode,
      riskMetric,
      riskThreshold: input.riskThreshold,
      riskAction,
    };

    this.triggers.set(trigger.id, trigger);
    this.save();
    return trigger;
  }

  addOco(inputs: TriggerInput[], groupId = makeGroupId("oco")): TriggerOrder[] {
    if (inputs.length < 2) throw new Error("OCO requires at least two child triggers");
    return inputs.map((input) => this.add({ ...input, ocoGroupId: input.ocoGroupId ?? groupId }));
  }

  get(id: string): TriggerOrder | undefined {
    return this.triggers.get(id);
  }

  update(id: string, patch: Partial<TriggerOrder>, options: TriggerStoreUpdateOptions = {}): TriggerOrder | undefined {
    const current = this.triggers.get(id);
    if (!current) return undefined;
    if (!hasChanged(current, patch)) return current;

    const next = { ...current, ...patch, updatedAt: Date.now() };
    this.triggers.set(id, next);
    if (options.persist !== false) this.save();
    return next;
  }

  setStatus(id: string, status: TriggerStatus, patch: Partial<TriggerOrder> = {}): TriggerOrder | undefined {
    return this.update(id, { ...patch, status });
  }

  cancel(id: string): TriggerOrder | undefined {
    const current = this.triggers.get(id);
    if (!current || current.status !== "ACTIVE") return current;
    return this.setStatus(id, "CANCELLED");
  }

  cancelGroup(groupId: string, exceptId?: string): TriggerOrder[] {
    const cancelled: TriggerOrder[] = [];
    for (const trigger of this.active()) {
      if (trigger.id === exceptId) continue;
      if (trigger.ocoGroupId === groupId || trigger.cancelGroupId === groupId) {
        const canceled = this.cancel(trigger.id);
        if (canceled) cancelled.push(canceled);
      }
    }
    return cancelled;
  }

  cancelOcoSiblings(groupId: string | undefined, firedId: string): TriggerOrder[] {
    if (!groupId) return [];
    const cancelled: TriggerOrder[] = [];
    for (const trigger of this.active()) {
      if (trigger.id !== firedId && trigger.ocoGroupId === groupId) {
        const canceled = this.cancel(trigger.id);
        if (canceled) cancelled.push(canceled);
      }
    }
    return cancelled;
  }

  list(filter: Partial<Pick<TriggerOrder, "ownerId" | "symbol" | "status" | "ocoGroupId">> = {}): TriggerOrder[] {
    return [...this.triggers.values()]
      .filter((trigger) => !filter.ownerId || trigger.ownerId === filter.ownerId)
      .filter((trigger) => !filter.symbol || trigger.symbol === normalizeSymbol(filter.symbol))
      .filter((trigger) => !filter.status || trigger.status === filter.status)
      .filter((trigger) => !filter.ocoGroupId || trigger.ocoGroupId === filter.ocoGroupId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  active(symbol?: string): TriggerOrder[] {
    return this.list({ symbol, status: "ACTIVE" });
  }

  activeSymbols(): string[] {
    return [...new Set(this.active().map((trigger) => trigger.symbol))].sort();
  }

  watchableSymbols(): string[] {
    return [...new Set(this.active()
      .filter((trigger) => trigger.kind !== "TIME_CLOSE" && trigger.kind !== "TIME_CANCEL")
      .map((trigger) => trigger.symbol))].sort();
  }
}
