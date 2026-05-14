import WebSocket from "ws";

export interface PriceQuote {
  symbol: string;
  price: number;
  last?: number;
  mid?: number;
  bid?: number;
  ask?: number;
  mark?: number;
  orderBook?: any;
  ts: number;
}

function quoteFromBook(symbol: string, msg: any): PriceQuote | undefined {
  if (!msg?.bids?.length || !msg?.asks?.length) return undefined;
  if (msg.s && msg.s.toUpperCase() !== symbol.toUpperCase()) return undefined;

  const bid = Number(msg.bids[0]?.p);
  const ask = Number(msg.asks[0]?.p);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return undefined;

  const mid = (bid + ask) / 2;
  return { symbol: symbol.toUpperCase(), price: mid, last: mid, mid, bid, ask, orderBook: msg, ts: Date.now() };
}

export class PriceFeedService {
  subscribe(symbol: string, onPrice: (quote: PriceQuote) => void, minIntervalMs = 1000): () => void {
    const url = process.env.LIQUIDITY_WS_URL || "";
    let ws: WebSocket | undefined;
    let reconnectTimer: NodeJS.Timeout | undefined;
    let stopped = false;
    let lastEmitAt = 0;

    const connect = () => {
      ws = new WebSocket(url);
      ws.on("open", () => ws?.send(JSON.stringify({ symbol, unsubscribe: 0 })));
      ws.on("message", (data: WebSocket.RawData) => {
        try {
          const quote = quoteFromBook(symbol, JSON.parse(data.toString()));
          if (!quote) return;
          if (minIntervalMs > 0 && quote.ts - lastEmitAt < minIntervalMs) return;
          lastEmitAt = quote.ts;

          if (process.env.TRIGGER_DEBUG === "true") {
            console.log("[PRICE_TICK]", {
              symbol: quote.symbol,
              bid: quote.bid,
              ask: quote.ask,
              mid: quote.mid,
              last: quote.last,
              price: quote.price,
              ts: quote.ts,
            });
          }

          onPrice(quote);
        } catch {
          // Ignore malformed market-data frames.
        }
      });
      ws.on("close", () => {
        if (!stopped) reconnectTimer = setTimeout(connect, 1000);
      });
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === 0)) ws.close(1000, "client stop");
    };
  }

  getPrices(symbol: string, timeoutMs = 10000): Promise<PriceQuote> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error(`Timed out waiting for ${symbol} price`));
      }, timeoutMs);
      const stop = this.subscribe(symbol, (quote) => {
        clearTimeout(timer);
        stop();
        resolve(quote);
      }, 0);
    });
  }
}

export const PriceFeedSvc = new PriceFeedService();
