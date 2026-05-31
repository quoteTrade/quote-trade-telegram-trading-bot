import { PriceFeedService, PriceFeedSvc } from "./utils/price-feed.service";
import { UserDataStreamService, UserDataStreamSvc } from "./utils/user-data-stream.service";
import { PositionStore } from "./triggers/position-store";
import { TriggerStore } from "./triggers/trigger-store";
import { TriggerEngine } from "./triggers/trigger-engine";
import {OrderHistoryStore} from "./triggers/order-history-store";

export class TriggerRuntime {
  private stops = new Map<string, () => void>();
  private userDataStarted = false;
  private userDataListenersAttached = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private triggers: TriggerStore,
    private positions: PositionStore,
    private engine: TriggerEngine,
    private notify: (message: string) => void,
    private userDataStream: UserDataStreamService = UserDataStreamSvc,
    private priceFeed: PriceFeedService = PriceFeedSvc,
    private orderHistory?: OrderHistoryStore,
  ) {}

  ensure(): void {
    this.attachUserDataListeners();
    this.reconcile();
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.reconcile();
        void this.engine.processDueTimers().finally(() => this.reconcile());
      }, 1000);
      this.timer.unref?.();
    }
  }

  reconcile(): void {
    this.reconcileSymbols();
    this.reconcileUserData();
    this.stopIfIdle();
  }

  private attachUserDataListeners(): void {
    if (this.userDataListenersAttached) return;
    this.userDataStream.on("positionUpdate", (p: any) => {
      const position = this.positions.upsert(p);
      if (position) void this.engine.processPositionUpdate(position.symbol).finally(() => this.reconcile());
    });
    // this.userDataStream.on("orderUpdate", (u: any) => this.notify(`Order update: ${u.side} ${u.symbol} status=${u.status}`));
    this.userDataStream.on("orderUpdate", (u: any) => {
      this.orderHistory?.upsert(u);
      this.notify(`Order update: ${u.side} ${u.symbol} status=${u.status}`);
    });
    this.userDataStream.on("warning", (message: any) => this.notify(String(message)));
    this.userDataStream.on("error", (e: any) => this.notify(`Account stream warning: ${e?.message ?? e}`));
    this.userDataListenersAttached = true;
  }

  private reconcileUserData(): void {
    const shouldRun = this.triggers.needsAccountData();
    if (shouldRun && !this.userDataStarted) {
      this.userDataStarted = this.userDataStream.start();
    } else if (!shouldRun && this.userDataStarted) {
      this.userDataStream.stop();
      this.userDataStarted = false;
    }
  }

  private stopIfIdle(): void {
    if (!this.triggers.runtimeNeeded()) this.stop();
  }

  reconcileSymbols(): void {
    const wanted = new Set(this.triggers.watchableSymbols().map((symbol) => symbol.toUpperCase()));
    for (const symbol of wanted) this.watchSymbol(symbol);
    for (const [symbol, stop] of [...this.stops.entries()]) {
      if (wanted.has(symbol)) continue;
      stop();
      this.stops.delete(symbol);
    }
    this.priceFeed.ensureActive();
  }

  watchSymbol(symbol: string): void {
    symbol = symbol.toUpperCase();
    if (this.stops.has(symbol)) return;
    const stop = this.priceFeed.subscribe(symbol, (q) => {
      void this.engine.processTick({
        symbol: q.symbol,
        price: q.price,
        bid: q.bid,
        ask: q.ask,
        bidQty: q.bidQty,
        askQty: q.askQty,
        mark: q.mark,
        ts: q.ts,
        orderBook: q.orderBook,
      });
    }, this.priceFeedMinIntervalMs());
    this.stops.set(symbol, stop);
  }

  private priceFeedMinIntervalMs(): number {
    const raw = process.env.PRICE_FEED_MIN_TRIGGER_INTERVAL_MS ?? process.env.TRIGGER_PRICE_FEED_MIN_INTERVAL_MS ?? "0";
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  stop(): void {
    for (const stop of this.stops.values()) stop();
    this.stops.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.userDataStream.stop();
    this.userDataStarted = false;
  }

  startAccountWatcher(): boolean {
    this.attachUserDataListeners();

    if (!this.userDataStarted) {
      this.userDataStarted = this.userDataStream.start();
    }

    return this.userDataStarted;
  }
}
