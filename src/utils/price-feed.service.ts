import WebSocket from "ws";

type Sub = {
  resolve: (v: any) => void;
  reject: (err?: any) => void;
};

export class PriceFeedService {
  private ws?: WebSocket;
  private readonly url: string = String(process.env.LIQUIDITY_WS_URL);
  private maxReconnectAttempts = 10;
  private reconnectAttempts = 0;
  private reconnectInterval = 5000; // ms

  // queued/active per symbol until resolved
  private subscriptions = new Map<string, Sub>();
  // de-dup in-flight requests
  private inFlight = new Map<string, Promise<any>>();

  constructor() {
    this.initSocket();
  }

  private initSocket() {
    this.ws = new WebSocket(this.url);

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
      console.log("✅ Price Feed WebSocket connected...");
      // (Re)subscribe any queued symbols
      for (const sym of this.subscriptions.keys()) {
        this.sendSubscribe(sym);
      }
    });

    this.ws.on("message", (raw) => {
      try {
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        this.handleIncomingData(text);
      } catch (e) {
        console.error("❌ Price Feed WebSocket message error:", e);
      }
    });

    this.ws.on("close", () => {
      console.log("❌ Price Feed WebSocket closed...");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      console.error("❌ Price Feed WebSocket error:", err);
    });
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("🚫 Price Feed: Max reconnect attempts reached...");
      // Optional: reject all pending subs
      // for (const [, { reject }] of this.subscriptions) reject(new Error("socket closed"));
      return;
    }
    this.reconnectAttempts += 1;
    console.log(`📡 Reconnecting in ${this.reconnectInterval / 1000}s...`);
    setTimeout(() => this.initSocket(), this.reconnectInterval);
  }

  // Handle incoming WebSocket messages
  private handleIncomingData(json: string) {
    const payload = JSON.parse(json);
    const { s: symbol, bids, asks } = payload || {};

    if (!symbol || !this.subscriptions.has(symbol)) return;

    if (Array.isArray(bids) && Array.isArray(asks)) {
      const { resolve } = this.subscriptions.get(symbol)!;
      this.subscriptions.delete(symbol);
      this.inFlight.delete(symbol);
      this.sendUnsubscribe(symbol);
      resolve({ bids, asks });
    }
  }

  // Subscribe to a symbol
  private sendSubscribe(symbol: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ symbol, unsubscribe: 0 }));
      // console.log(`📡 Subscribed to ${symbol}`);
    }
  }

  private sendUnsubscribe(symbol: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ symbol, unsubscribe: 1 }));
      // console.log(`🚫 Unsubscribed from ${symbol}`);
    }
  }

  public async getPrices(symbol: string): Promise<any> {
    if (this.inFlight.has(symbol)) return this.inFlight.get(symbol)!;

    const p = new Promise<any>((resolve, reject) => {
      this.subscriptions.set(symbol, { resolve, reject });
      // subscribe now if socket is open; otherwise it will subscribe on 'open'
      this.sendSubscribe(symbol);
    });

    this.inFlight.set(symbol, p);
    return p;
  }

  public fetchMaxMatchingPrices(orderBook: any, quantity: number): any {
    // Filter bids and asks where the quantity (q) is greater than or equal to the input quantity
    const bid = orderBook.bids?.find((bid: any) => bid.q >= quantity) || {};
    const ask = orderBook.asks?.find((ask: any) => ask.q >= quantity) || {};

    return { s: orderBook.s, bid, ask };
  }

}

export const PriceFeedSvc = new PriceFeedService();