import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeSymbol, PositionSnapshot, sideToClosePosition } from "./types";
import type { OrderSide } from "./types";

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
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, filePath);
  try { chmodSync(filePath, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
}

function toNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const n = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function normalizePosition(raw: any, fallbackSymbol?: string): PositionSnapshot | undefined {
  if (!raw) return undefined;

  const symbolRaw = raw.symbol ?? raw.s ?? raw.a ?? raw.asset ?? fallbackSymbol;
  if (!symbolRaw) return undefined;

  const hasPositionQuantity = raw.netQty !== undefined || raw.positionAmt !== undefined || raw.pa !== undefined || raw.quantity !== undefined || raw.qty !== undefined || raw.availableQty !== undefined || raw.availableQuantity !== undefined || raw.aq !== undefined;
  if (!hasPositionQuantity) return undefined;

  const symbol = normalizeSymbol(String(symbolRaw).split("/")[0]);
  const netQty = toNumber(raw.netQty, raw.positionAmt, raw.pa, raw.quantity, raw.qty, raw.availableQuantity, raw.aq) ?? 0;
  const availableQty = toNumber(raw.availableQty, raw.availableQuantity, raw.aq, raw.free, raw.quantity, raw.qty, raw.pa) ?? netQty;
  const avgEntryPrice = toNumber(raw.avgEntryPrice, raw.entryPrice, raw.usdAvgCostBasis, raw.uacb, raw.avgPrice, raw.ep);
  const markPrice = toNumber(raw.markPrice, raw.baseUsdMark, raw.m, raw.settleCoinUsdMark, raw.sm, raw.price, raw.lastPrice);

  return {
    symbol,
    netQty,
    availableQty,
    avgEntryPrice,
    markPrice,
    riskUsd: Math.abs(netQty) * (markPrice ?? avgEntryPrice ?? 0),
    updatedAt: Date.now(),
    raw,
  };
}

export class PositionStore {
  private readonly filePath: string;
  private positions = new Map<string, PositionSnapshot>();

  constructor(filePath = defaultDataFile("positions.json")) {
    this.filePath = filePath;
    this.load();
  }

  load(): void {
    const data = readJsonFile<PositionSnapshot[]>(this.filePath, []);
    this.positions.clear();
    for (const position of data) {
      if (position?.symbol) this.positions.set(normalizeSymbol(position.symbol), position);
    }
  }

  save(): void {
    writeJsonFile(this.filePath, this.list());
  }

  upsert(raw: any, fallbackSymbol?: string, persist = true): PositionSnapshot | undefined {
    const position = normalizePosition(raw, fallbackSymbol);
    if (!position) return undefined;
    this.positions.set(position.symbol, position);
    if (persist) this.save();
    return position;
  }

  private positionList(rawPositions: any): any[] {
    return Array.isArray(rawPositions)
      ? rawPositions
      : Array.isArray(rawPositions?.positions)
        ? rawPositions.positions
        : Array.isArray(rawPositions?.data)
          ? rawPositions.data
          : [];
  }

  merge(rawPositions: any): PositionSnapshot[] {
    const merged = this.positionList(rawPositions).map((position: any) => this.upsert(position, undefined, false)).filter(Boolean) as PositionSnapshot[];
    if (merged.length) this.save();
    return merged;
  }

  replace(rawPositions: any): PositionSnapshot[] {
    this.positions.clear();
    const replaced = this.positionList(rawPositions).map((position: any) => normalizePosition(position)).filter(Boolean) as PositionSnapshot[];
    for (const position of replaced) this.positions.set(position.symbol, position);
    this.save();
    return replaced;
  }

  clear(): void {
    this.positions.clear();
    this.save();
  }

  setMark(symbolRaw: string, markPrice: number, persist = false): void {
    if (!Number.isFinite(markPrice) || markPrice <= 0) return;

    const symbol = normalizeSymbol(symbolRaw);
    const current = this.positions.get(symbol);
    if (!current) return;

    const next = {
      ...current,
      markPrice,
      riskUsd: Math.abs(current.netQty) * markPrice,
      updatedAt: Date.now(),
    };
    this.positions.set(symbol, next);
    if (persist) this.save();
  }

  get(symbolRaw: string): PositionSnapshot | undefined {
    return this.positions.get(normalizeSymbol(symbolRaw));
  }

  getCloseQuantity(symbolRaw: string): number {
    const position = this.get(symbolRaw);
    return Math.abs(position?.availableQty ?? position?.netQty ?? 0);
  }

  getCloseSide(symbolRaw: string): OrderSide | undefined {
    const position = this.get(symbolRaw);
    return sideToClosePosition(position?.netQty ?? 0);
  }

  list(): PositionSnapshot[] {
    return [...this.positions.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  totalRiskUsd(): number {
    return this.list().reduce((sum, position) => sum + (Number.isFinite(position.riskUsd) ? position.riskUsd : 0), 0);
  }

  describe(): string {
    const rows = this.list();
    if (!rows.length) return "No positions cached yet. Run positions:refresh or start the watcher to receive account updates.";
    return rows
      .map((position) => {
        const avg = position.avgEntryPrice ? ` avg=${position.avgEntryPrice}` : "";
        const mark = position.markPrice ? ` mark=${position.markPrice}` : "";
        return `${position.symbol}: net=${position.netQty} available=${position.availableQty}${avg}${mark} riskUsd=${position.riskUsd.toFixed(2)}`;
      })
      .join("\n");
  }
}
