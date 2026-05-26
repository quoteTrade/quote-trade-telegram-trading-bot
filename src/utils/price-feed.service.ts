import WebSocket from "ws";

export interface PriceQuote {
  symbol: string;
  /** Diagnostic only; trigger checks use side-specific L2 depth from orderBook. */
  price?: number;
  bid?: number;
  ask?: number;
  bidQty?: number;
  askQty?: number;
  mark?: number;
  orderBook?: any;
  ts: number;
}

export interface PriceFeedStatsRow {
  symbol: string;
  subscribers: number;
  connected: boolean;
  subscribed: boolean;
  hasSnapshot: boolean;
  lastUpdateTs?: number;
}

export interface PriceFeedServiceOptions {
  url?: string | (() => string | undefined);
  reconnectMs?: number;
  idleCloseMs?: number;
  /** Max age for replaying cached L2 snapshots to new subscribers. Set 0 to disable. */
  maxSnapshotAgeMs?: number;
  createWebSocket?: (url: string) => any;
  onWarning?: (message: string) => void;
}

interface Subscriber {
  onPrice: (quote: PriceQuote) => void;
  minIntervalMs: number;
  lastEmitAt: number;
}

interface SymbolState {
  symbol: string;
  subscribers: Map<number, Subscriber>;
  lastQuote?: PriceQuote;
}

function normalizeSymbol(symbol: string): string {
  const value = String(symbol ?? "").trim().toUpperCase();
  if (!value) throw new Error("symbol is required");
  return value;
}

function wsIsOpen(ws: any): boolean {
  return !!ws && ws.readyState === WebSocket.OPEN;
}

function wsIsOpenOrConnecting(ws: any): boolean {
  return !!ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING || ws.readyState === 0 || ws.readyState === 1);
}

function asPositiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const n = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function extractBook(msg: any): any {
  return msg?.data?.bids || msg?.data?.asks ? msg.data : msg?.book?.bids || msg?.book?.asks ? msg.book : msg;
}

const COMMON_QUOTE_SUFFIXES = ["USDT", "USDC", "FDUSD", "USD", "EUR"];

function normalizeFeedSymbol(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const text = String(raw).trim().toUpperCase();
  if (!text) return undefined;

  if (/^T_[A-Z0-9]+$/.test(text) && process.env.ENV === "testnet") {
    return normalizeSymbol(text);
  }

  // Quote.Trade trigger commands use base symbols such as BTC/ETH. Route common
  // feed pair formats like BTC/USD, BTC-USDT, or BTCUSDT back to the active base
  // symbol instead of subscribing to thousands of full market names. For
  // concatenated names, strip only stable/fiat quote suffixes so assets such as
  // STETH/WBTC are not accidentally normalized to ST/W.
  const separated = text.split(/[/:_\-]/).filter(Boolean);
  if (separated.length > 1) return normalizeSymbol(separated[0]);

  for (const suffix of COMMON_QUOTE_SUFFIXES) {
    if (text.endsWith(suffix) && text.length > suffix.length + 1) {
      return normalizeSymbol(text.slice(0, -suffix.length));
    }
  }
  return normalizeSymbol(text);
}

function extractSymbol(msg: any): string | undefined {
  const book = extractBook(msg);
  const raw = book?.s ?? book?.symbol ?? book?.ticker ?? book?.pair ?? msg?.s ?? msg?.symbol ?? msg?.ticker ?? msg?.pair;
  return normalizeFeedSymbol(raw);
}

function rawBookLevels(book: any, side: "bid" | "ask"): any[] {
  const raw = side === "ask"
    ? (book?.asks ?? book?.a ?? book?.sell ?? book?.sells)
    : (book?.bids ?? book?.b ?? book?.buy ?? book?.buys);
  return Array.isArray(raw) ? raw : [];
}

function firstLevelPrice(level: any): number | undefined {
  return asPositiveNumber(level?.p, level?.price, level?.px, level?.rate, Array.isArray(level) ? level[0] : undefined);
}

function firstLevelQuantity(level: any): number | undefined {
  return asPositiveNumber(level?.q, level?.qty, level?.quantity, level?.size, level?.amount, level?.dp, level?.d, Array.isArray(level) ? level[1] : undefined);
}

function quoteFromBook(symbol: string, msg: any): PriceQuote | undefined {
  const book = extractBook(msg);
  const bids = rawBookLevels(book, "bid");
  const asks = rawBookLevels(book, "ask");
  if (!bids.length && !asks.length) return undefined;

  const messageSymbol = extractSymbol(msg);
  if (messageSymbol && messageSymbol !== symbol) return undefined;

  // Some L2 feeds emit deltas or side-only snapshots. Keep those frames so a
  // BUY can be evaluated from ask-side depth and a SELL can be evaluated from
  // bid-side depth without requiring the opposite side to be present too.
  const bid = firstLevelPrice(bids[0]);
  const ask = firstLevelPrice(asks[0]);
  const bidQty = firstLevelQuantity(bids[0]);
  const askQty = firstLevelQuantity(asks[0]);
  const price = ask ?? bid;
  if (!price) return undefined;

  return {
    symbol,
    price,
    bid,
    ask,
    bidQty,
    askQty,
    orderBook: book,
    ts: Date.now(),
  };
}

/**
 * Shared multiplexed L2 feed.
 *
 * The service opens at most one WebSocket connection. It dynamically subscribes
 * only to symbols that have active trigger subscribers and unsubscribes a symbol
 * when its final subscriber leaves. Public L2 snapshots are shared across users;
 * user credentials, positions, trigger stores, and order execution stay isolated
 * outside this service.
 */
export class PriceFeedService {
  private readonly symbols = new Map<string, SymbolState>();
  private readonly subscribedSymbols = new Set<string>();
  private nextSubscriberId = 1;
  private ws?: any;
  private reconnectTimer?: NodeJS.Timeout;
  private socketIdleTimer?: NodeJS.Timeout;
  private warnedMissingUrl = false;
  private stopped = false;
  private socketSeq = 0;
  private currentSocketId = 0;

  constructor(private readonly options: PriceFeedServiceOptions = {}) {}

  subscribe(symbolInput: string, onPrice: (quote: PriceQuote) => void, minIntervalMs = 1000): () => void {
    const symbol = normalizeSymbol(symbolInput);
    const state = this.ensureSymbol(symbol);
    const id = this.nextSubscriberId++;

    if (this.socketIdleTimer) {
      clearTimeout(this.socketIdleTimer);
      this.socketIdleTimer = undefined;
    }

    state.subscribers.set(id, { onPrice, minIntervalMs: Math.max(0, minIntervalMs), lastEmitAt: 0 });

    if (process.env.PRICE_DEBUG === "true") {
      console.log("[PRICE_FEED_SUBSCRIBER_ADD]", {
        socketId: this.currentSocketId,
        symbol,
        subscriberId: id,
        symbolSubscriberCount: state.subscribers.size,
        activeSocketCount: this.activeSocketCount(),
        activeSymbolCount: this.activeSymbolCount(),
        totalSubscribers: this.subscriberCount(),
        subscribedSymbols: Array.from(this.subscribedSymbols),
      });
    }

    this.stopped = false;
    this.ensureSocket();
    this.subscribeSymbol(symbol);

    if (state.lastQuote && this.isSnapshotFresh(state.lastQuote)) {
      const snapshot = state.lastQuote;
      queueMicrotask(() => this.deliverToSubscriber(state, id, snapshot));
    }

    return () => this.unsubscribe(symbol, id);
  }

  /**
   * Re-check the underlying socket for the current active symbol set. This lets
   * runtimes recover if LIQUIDITY_WS_URL is configured after a subscription was
   * already requested, and is also a cheap safety net after transient socket
   * states that did not schedule a reconnect.
   */
  ensureActive(): void {
    if (this.activeSymbolCount() <= 0) return;
    if (this.socketIdleTimer) {
      clearTimeout(this.socketIdleTimer);
      this.socketIdleTimer = undefined;
    }
    this.stopped = false;
    this.ensureSocket();
    if (wsIsOpen(this.ws)) {
      for (const symbol of this.activeSymbols()) this.sendSubscribe(symbol);
    }
  }

  getSnapshot(symbolInput: string): PriceQuote | undefined {
    return this.symbols.get(normalizeSymbol(symbolInput))?.lastQuote;
  }

  stats(): PriceFeedStatsRow[] {
    const connected = !!this.ws && wsIsOpenOrConnecting(this.ws);
    return [...this.symbols.values()]
      .map((state) => ({
        symbol: state.symbol,
        subscribers: state.subscribers.size,
        connected,
        subscribed: this.subscribedSymbols.has(state.symbol),
        hasSnapshot: !!state.lastQuote,
        lastUpdateTs: state.lastQuote?.ts,
      }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  /** Number of underlying WebSocket connections currently open or connecting. */
  activeStreamCount(): number {
    return this.activeSocketCount();
  }

  activeSocketCount(): number {
    return this.ws && wsIsOpenOrConnecting(this.ws) ? 1 : 0;
  }

  activeSymbolCount(): number {
    return [...this.symbols.values()].filter((state) => state.subscribers.size > 0).length;
  }

  subscriberCount(symbolInput?: string): number {
    if (symbolInput) return this.symbols.get(normalizeSymbol(symbolInput))?.subscribers.size ?? 0;
    return [...this.symbols.values()].reduce((sum, state) => sum + state.subscribers.size, 0);
  }

  closeAll(): void {
    this.stopped = true;
    for (const state of this.symbols.values()) state.subscribers.clear();
    this.subscribedSymbols.clear();
    this.closeSocket("close all");
    this.symbols.clear();
  }

  getPrices(symbol: string, timeoutMs = 10000): Promise<PriceQuote> {
    return new Promise((resolve, reject) => {
      let stop: (() => void) | undefined;
      const timer = setTimeout(() => {
        stop?.();
        reject(new Error(`Timed out waiting for ${symbol} price`));
      }, timeoutMs);
      stop = this.subscribe(symbol, (quote) => {
        clearTimeout(timer);
        stop?.();
        resolve(quote);
      }, 0);
    });
  }

  private ensureSymbol(symbol: string): SymbolState {
    let state = this.symbols.get(symbol);
    if (!state) {
      state = { symbol, subscribers: new Map() };
      this.symbols.set(symbol, state);
    }
    return state;
  }

  private streamUrl(): string | undefined {
    const raw = typeof this.options.url === "function" ? this.options.url() : this.options.url;
    const url = raw ?? process.env.LIQUIDITY_WS_URL;
    return url && String(url).trim() ? String(url).trim() : undefined;
  }

  private createWebSocket(url: string): any {
    return this.options.createWebSocket ? this.options.createWebSocket(url) : new WebSocket(url);
  }

  private warn(message: string): void {
    if (this.options.onWarning) this.options.onWarning(message);
    else console.warn(message);
  }

  private maxSnapshotAgeMs(): number {
    const configured = this.options.maxSnapshotAgeMs ?? Number(process.env.PRICE_FEED_MAX_SNAPSHOT_AGE_MS ?? process.env.TRIGGER_MAX_L2_AGE_MS ?? 5000);
    return Number.isFinite(configured) && configured > 0 ? configured : 0;
  }

  private isSnapshotFresh(quote: PriceQuote, now = Date.now()): boolean {
    const maxAge = this.maxSnapshotAgeMs();
    if (!maxAge) return true;
    const ts = Number(quote.ts);
    return Number.isFinite(ts) && ts > 0 && now - ts <= maxAge;
  }

  private ensureSocket(): void {
    if (this.stopped || this.activeSymbolCount() === 0 || wsIsOpenOrConnecting(this.ws)) return;

    const url = this.streamUrl();
    if (!url) {
      if (!this.warnedMissingUrl) {
        this.warnedMissingUrl = true;
        this.warn("Price feed not started: LIQUIDITY_WS_URL is not configured.");
      }
      return;
    }

    try {
      const ws = this.createWebSocket(url);
      this.ws = ws;

      this.currentSocketId = ++this.socketSeq;
      if (process.env.PRICE_DEBUG === "true") {
        console.log("[PRICE_FEED_SOCKET_CREATE]", {
          socketId: this.currentSocketId,
          url,
          activeSymbolCount: this.activeSymbolCount(),
          totalSubscribers: this.subscriberCount(),
        });
      }

      ws.on("open", () => {
        for (const symbol of this.activeSymbols()) this.sendSubscribe(symbol);
      });
      ws.on("message", (data: WebSocket.RawData) => this.onMessage(data));
      ws.on("close", () => {
        if (this.ws === ws) this.ws = undefined;
        this.subscribedSymbols.clear();
        if (!this.stopped && this.activeSymbolCount() > 0) this.scheduleReconnect();
      });
      ws.on("error", (error: any) => {
        this.warn(`Price feed warning: ${error?.message ?? error}`);
        if (!this.stopped && this.activeSymbolCount() > 0 && this.ws === ws && !wsIsOpenOrConnecting(ws)) this.scheduleReconnect();
      });
    } catch (error: any) {
      this.ws = undefined;
      this.subscribedSymbols.clear();
      this.warn(`Price feed warning: ${error?.message ?? error}`);
      this.scheduleReconnect();
    }
  }

  private activeSymbols(): string[] {
    return [...this.symbols.values()].filter((state) => state.subscribers.size > 0).map((state) => state.symbol).sort();
  }

  private subscribeSymbol(symbol: string): void {
    if (this.subscribedSymbols.has(symbol)) return;
    if (!wsIsOpen(this.ws)) return;
    this.sendSubscribe(symbol);
  }

  private sendSubscribe(symbol?: string, force = false): void {
    if (!wsIsOpen(this.ws)) return;

    if (!symbol) {
      if (process.env.PRICE_DEBUG === "true") {
        console.log("[PRICE_FEED_SOCKET_SUBSCRIBE_SKIP]", {
          reason: "missing-symbol",
          symbol,
          socketId: this.currentSocketId,
          subscribedSymbols: Array.from(this.subscribedSymbols),
        });
      }
      return;
    }

    if (!force && this.subscribedSymbols.has(symbol)) {
      if (process.env.SESSION_DEBUG === "true") {
        console.log("[PRICE_FEED_SOCKET_SUBSCRIBE_SKIP]", {
          reason: "already-subscribed",
          symbol,
          subscribedSymbols: Array.from(this.subscribedSymbols),
        });
      }
      return;
    }

    try {
      this.ws.send(JSON.stringify({ symbol, unsubscribe: 0 }));
      this.subscribedSymbols.add(symbol);

      if (process.env.PRICE_DEBUG === "true") {
        console.log("[PRICE_FEED_SOCKET_SUBSCRIBE_SENT]", {
          symbol,
          activeSocketCount: this.activeSocketCount(),
          activeSymbolCount: this.activeSymbolCount(),
          totalSubscribers: this.subscriberCount(),
          subscribedSymbols: Array.from(this.subscribedSymbols),
        });
      }
    } catch (error: any) {
      this.subscribedSymbols.delete(symbol);
      this.warn(`Price feed subscribe warning for ${symbol}: ${error?.message ?? error}`);
      this.scheduleReconnect();
    }
  }

  private sendUnsubscribe(symbol: string): void {
    if (!wsIsOpen(this.ws) || !this.subscribedSymbols.has(symbol)) {
      this.subscribedSymbols.delete(symbol);
      return;
    }
    try {
      this.ws.send(JSON.stringify({ symbol, unsubscribe: 1 }));
    } catch {
      // The socket may be closing; the reconnect path will rebuild active subscriptions.
    }
    this.subscribedSymbols.delete(symbol);

    if (process.env.PRICE_DEBUG === "true") {
      console.log("[PRICE_FEED_SOCKET_UNSUBSCRIBE_SENT]", {
        socketId: this.currentSocketId,
        symbol,
        activeSocketCount: this.activeSocketCount(),
        activeSymbolCount: this.activeSymbolCount(),
        totalSubscribers: this.subscriberCount(),
        subscribedSymbols: Array.from(this.subscribedSymbols),
      });
    }

    this.resubscribeRemainingActiveSymbols("after-unsubscribe", symbol);
  }

  private resubscribeRemainingActiveSymbols(reason: string, excludeSymbol?: string): void {
    if (!wsIsOpen(this.ws)) return;

    const activeSymbols = Array.from(this.symbols.entries())
        .filter(([symbol, state]) => symbol !== excludeSymbol && state.subscribers.size > 0)
        .map(([symbol]) => symbol)
        .sort();

    if (process.env.PRICE_DEBUG === "true") {
      console.log("[PRICE_FEED_RESUBSCRIBE_REMAINING]", {
        socketId: this.currentSocketId,
        reason,
        excludeSymbol,
        activeSymbols,
        subscribedSymbols: Array.from(this.subscribedSymbols),
      });
    }

    for (const symbol of activeSymbols) {
      this.sendSubscribe(symbol, true);
    }
  }

  private onMessage(data: WebSocket.RawData): void {
    try {
      const raw = JSON.parse(data.toString());
      for (const frame of this.marketFrames(raw)) this.onMarketFrame(frame);
    } catch {
      // Ignore malformed market-data frames.
    }
  }

  private marketFrames(raw: any): any[] {
    const frames = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [raw];
    const expanded: any[] = [];

    for (const frame of frames) {
      const data = frame?.data;
      if (data && !Array.isArray(data) && typeof data === "object" && !data.bids && !data.asks && !data.b && !data.a) {
        for (const [symbol, book] of Object.entries(data)) {
          if (book && typeof book === "object") expanded.push({ ...(book as any), symbol });
        }
        continue;
      }

      if (frame && !extractSymbol(frame) && typeof frame === "object" && !Array.isArray(frame) && !frame.bids && !frame.asks && !frame.book) {
        const entries = Object.entries(frame).filter(([, value]) => value && typeof value === "object");
        if (entries.length) {
          for (const [symbol, book] of entries) expanded.push({ ...(book as any), symbol });
          continue;
        }
      }

      expanded.push(frame);
    }

    return expanded;
  }

  private onMarketFrame(frame: any): void {
    const symbol = extractSymbol(frame) ?? (this.activeSymbolCount() === 1 ? this.activeSymbols()[0] : undefined);

    if (!symbol) return;
    const state = this.symbols.get(symbol);
    if (!state || state.subscribers.size === 0) return;

    const quote = quoteFromBook(symbol, frame);

    if (process.env.PRICE_DEBUG === "true") {
      console.log("[PRICE_FEED_DELIVER]", {
        socketId: this.currentSocketId,
        symbol: quote.symbol,
        subscriberCount: state.subscribers.size,
      });
    }

    if (!quote) return;
    state.lastQuote = quote;
    for (const id of state.subscribers.keys()) this.deliverToSubscriber(state, id, quote);
  }

  private deliverToSubscriber(state: SymbolState, id: number, quote: PriceQuote): void {
    const subscriber = state.subscribers.get(id);
    if (!subscriber) return;
    if (subscriber.minIntervalMs > 0 && quote.ts - subscriber.lastEmitAt < subscriber.minIntervalMs) return;
    subscriber.lastEmitAt = quote.ts;
    subscriber.onPrice(quote);
  }

  private unsubscribe(symbol: string, id: number): void {
    const state = this.symbols.get(symbol);
    if (!state) return;
    state.subscribers.delete(id);

    if (process.env.PRICE_DEBUG === "true") {
      console.log("[PRICE_FEED_SUBSCRIBER_REMOVE]", {
        symbol,
        subscriberId: id,
        remainingSymbolSubscribers: state.subscribers.size,
        activeSocketCount: this.activeSocketCount(),
        activeSymbolCount: this.activeSymbolCount(),
        totalSubscribers: this.subscriberCount(),
        subscribedSymbols: Array.from(this.subscribedSymbols),
      });
    }

    if (state.subscribers.size > 0) return;

    // Stop listening to the symbol immediately once the final trigger/user leaves.
    // The socket itself may stay open briefly to avoid reconnect churn, but it has
    // no active symbol subscriptions during that idle window.
    this.sendUnsubscribe(symbol);
    this.scheduleSocketIdleClose();
  }

  private scheduleSocketIdleClose(): void {
    if (this.activeSymbolCount() > 0 || !this.ws) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const idleCloseMs = this.options.idleCloseMs ?? 5000;
    if (idleCloseMs <= 0) this.closeSocket("no active symbols");
    else if (!this.socketIdleTimer) {
      this.socketIdleTimer = setTimeout(() => this.closeSocket("no active symbols"), idleCloseMs);
      this.socketIdleTimer.unref?.();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped || this.activeSymbolCount() === 0) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.ensureSocket();
    }, this.options.reconnectMs ?? 1000);
    this.reconnectTimer.unref?.();
  }

  private closeSocket(reason: string): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.socketIdleTimer) clearTimeout(this.socketIdleTimer);
    this.reconnectTimer = undefined;
    this.socketIdleTimer = undefined;

    const ws = this.ws;
    this.ws = undefined;
    this.subscribedSymbols.clear();
    if (wsIsOpenOrConnecting(ws)) ws.close(1000, reason);
  }
}

export const PriceFeedSvc = new PriceFeedService();
