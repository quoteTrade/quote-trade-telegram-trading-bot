import WebSocket from "ws";

export class PriceFeedService {
  private readonly ws: WebSocket;
  private maxReconnectAttempts = 10;
  private reconnectAttempts = 0;
  private reconnectInterval = 5000; // 5 seconds
  private subscriptions: Map<string, any> = new Map();
  private pendingRequests: Map<string, Promise<any>> = new Map();

  constructor() {
    this.ws = new WebSocket(`${process.env.LIQUIDITY_WS_URL}`);
    this.connect();
  }

  private connect() {
    this.ws.onopen = () => {
      console.log('✅ Price Feed WebSocket connected...');
    };

    this.ws.onmessage = (message: any) => {
      // console.log('Message received:', message.data);
      try {
        this.handleIncomingData(message.data);
      } catch (e) {
        console.error('❌ Price Feed WebSocket message error:', e);
      }
    };

    this.ws.onclose = () => {
      console.log('❌ Price Feed WebSocket closed...');
      this.handleReconnect();
    };

    this.ws.onerror = (error: any) => {
      console.error('❌ Price Feed WebSocket error:', error);
    };
  }

  private handleReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts += 1;
      console.log(`📡 Reconnecting in ${this.reconnectInterval / 1000}s...`);
      setTimeout(() => this.connect(), this.reconnectInterval);
    } else {
      console.error('🚫 Price Feed: Max reconnect attempts reached...');
    }
  }

  // Handle incoming WebSocket messages
  private handleIncomingData(data: any) {
    try {
      const { s, bids, asks } = JSON.parse(data);

      if (bids && asks && this.subscriptions.has(s)) {
        const { resolve } = this.subscriptions.get(s);
        if (resolve) {
          this.subscriptions.delete(s); // Remove after use
          this.unsubscribe(s); // Unsubscribe if no longer needed
          resolve({bids, asks});
        }
      }
    } catch (e) {
      console.error('❌ Price Feed WebSocket message error:', e);
    }
  }

  // Subscribe to a symbol
  private subscribe(symbol: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        "symbol": symbol,
        "unsubscribe": 0
      }));
      console.log(`📡 Price Feed: Subscribed to ${symbol}`);
    } else {
      if (this.subscriptions.has(symbol)) {
        const { reject } = this.subscriptions.get(symbol);
        if (reject) {
          this.subscriptions.delete(symbol);
          this.pendingRequests.delete(symbol);
          reject();
        }
      }
      console.warn('❌ Cannot send message: Price Feed WebSocket is not open');
    }
  }

  // Unsubscribe from a symbol
  private unsubscribe(symbol: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        "symbol": symbol,
        "unsubscribe": 1
      }));
      this.subscriptions.delete(symbol);
      console.log(`🚫 Price Feed: Unsubscribed from ${symbol}`);
    } else {
      console.warn('❌ Cannot send message: Price Feed WebSocket is not open');
    }
  }

  public async getPrices(symbol: string): Promise<any> {
    if (this.pendingRequests.has(symbol)) {
      return this.pendingRequests.get(symbol)!; // Return existing promise
    }

    const pricePromise = new Promise<any>((resolve, reject) => {
      this.subscriptions.set(symbol, {resolve, reject});
      this.subscribe(symbol);
    });

    this.pendingRequests.set(symbol, pricePromise);
    return pricePromise;
  }

  public fetchMaxMatchingPrices(orderBook: any, quantity: number): any {
    // Filter bids and asks where the quantity (q) is greater than or equal to the input quantity
    const bid = orderBook.bids?.find((bid: any) => bid.q >= quantity) || {};
    const ask = orderBook.asks?.find((ask: any) => ask.q >= quantity) || {};

    return { bid, ask };
  }

}

export const PriceFeedSvc = new PriceFeedService();