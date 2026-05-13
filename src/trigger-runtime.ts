import { PriceFeedSvc } from "./utils/price-feed.service";
import { UserDataStreamSvc } from "./utils/user-data-stream.service";
import { PositionStore } from "./triggers/position-store";
import { TriggerStore } from "./triggers/trigger-store";
import { TriggerEngine } from "./triggers/trigger-engine";

export class TriggerRuntime {
  private stops = new Map<string, () => void>();
  private userDataStarted = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private triggers: TriggerStore,
    private positions: PositionStore,
    private engine: TriggerEngine,
    private notify: (message: string) => void,
  ) {}

  ensure(): void {
    for (const symbol of this.triggers.watchableSymbols()) this.watchSymbol(symbol);
    if (!this.timer) this.timer = setInterval(() => void this.engine.processDueTimers(), 1000);
    if (!this.userDataStarted) {
      UserDataStreamSvc.on("positionUpdate", (p: any) => {
        const position = this.positions.upsert(p);
        if (position) void this.engine.processPositionUpdate(position.symbol);
      });
      UserDataStreamSvc.on("orderUpdate", (u: any) => this.notify(`Order update: ${u.side} ${u.symbol} status=${u.status}`));
      UserDataStreamSvc.on("error", (e: any) => this.notify(`Account stream warning: ${e?.message ?? e}`));
      UserDataStreamSvc.start();
      this.userDataStarted = true;
    }
  }

  watchSymbol(symbol: string): void {
    symbol = symbol.toUpperCase();
    if (this.stops.has(symbol)) return;
    const stop = PriceFeedSvc.subscribe(symbol, (q) => {
      void this.engine.processTick({
        symbol: q.symbol,
        price: q.price,
        last: q.last,
        mid: q.mid,
        bid: q.bid,
        ask: q.ask,
        mark: q.mark,
        ts: q.ts,
        orderBook: q.orderBook,
      });
    });
    this.stops.set(symbol, stop);
  }

  stop(): void {
    for (const stop of this.stops.values()) stop();
    this.stops.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    UserDataStreamSvc.stop();
    this.userDataStarted = false;
  }
}
