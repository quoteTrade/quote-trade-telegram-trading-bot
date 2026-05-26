import EventEmitter from "node:events";
import WebSocket from "ws";

function normalizePositionUpdate(feed: any): any[] {
  const account = feed?.a ?? feed?.account ?? feed;
  return [...(account?.P || []), ...(account?.positions || [])]
    .map((item: any) => ({
      ...item,
      symbol: item.s ?? item.a ?? item.symbol,
      quantity: item.pa ?? item.quantity,
      availableQuantity: item.aq ?? item.availableQuantity ?? item.pa ?? item.quantity,
      avgEntryPrice: item.ep ?? item.avgEntryPrice ?? item.uacb,
      markPrice: item.m ?? item.markPrice ?? item.sm,
    }))
    .filter((item: any) => item.symbol);
}

function mapOrderTrade(order: any): any | null {
  if (!order) return null;
  return {
    symbol: String(order.s ?? "").split("/")[0],
    side: order.S === "BUY" || order.S === "1" ? "BUY" : "SELL",
    status: String(order.X ?? order.status ?? "NEW"),
    clientOrderId: String(order.c ?? order.clientOrderId ?? ""),
    orderId: order.i ? String(order.i) : undefined,
    quantity: order.q != null ? String(order.q) : undefined,
    cumQty: order.z != null ? String(order.z) : undefined,
    price: order.p != null ? String(order.p) : undefined,
    fillPrice: order.L ?? order.a,
    reason: order.br != null ? String(order.br) : undefined,
  };
}

function isWsActive(ws?: WebSocket): boolean {
  return !!ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
}

export interface UserDataStreamOptions {
  ownerId?: string;
  url?: string;
  requestToken?: string | (() => string | undefined);
  allowEnvFallback?: boolean;
}

export class UserDataStreamService extends EventEmitter {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private warnedMissingConfig = false;
  private stopped = false;

  constructor(private readonly options: UserDataStreamOptions = {}) {
    super();
  }

  private streamUrl(): string | undefined {
    const url = this.options.url ?? process.env.LISTEN_KEY_WS_URL;
    return url && String(url).trim() ? String(url).trim() : undefined;
  }

  private requestToken(): string | undefined {
    const raw = typeof this.options.requestToken === "function" ? this.options.requestToken() : this.options.requestToken;
    const token = raw || (this.options.allowEnvFallback ? process.env.TRADE_API_KEY : undefined);
    return token && String(token).trim() ? String(token).trim() : undefined;
  }

  start(): boolean {
    this.stopped = false;
    // if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === 0 || this.ws.readyState === 1)) {
    if (isWsActive(this.ws)) {
      return true;
    }

    const url = this.streamUrl();
    const token = this.requestToken();

    if (process.env.SESSION_DEBUG === "true") {
      console.log("[USER_STREAM_START]", {
        ownerId: this.options.ownerId,
        hasUrl: !!url,
        hasToken: !!token,
      });
    }

    if (!url || !token) {
      if (!this.warnedMissingConfig) {
        this.warnedMissingConfig = true;
        this.emit("warning", `Account stream not started${this.options.ownerId ? ` for owner ${this.options.ownerId}` : ""}: missing ${!url ? "LISTEN_KEY_WS_URL" : "session api key"}.`);
      }
      return false;
    }
    this.warnedMissingConfig = false;

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      if (this.ws === ws) ws.send(JSON.stringify({ unsubscribe: 0, requestToken: token }));
    });

    ws.on("message", (data: WebSocket.RawData) => {
      try {
        const feed = JSON.parse(data.toString());
        if (feed.e === "ORDER_TRADE_UPDATE" || feed.o) {
          const update = mapOrderTrade(feed.o ?? feed);
          if (update) this.emit("orderUpdate", update);
        }
        if (feed.e === "ACCOUNT_UPDATE" || feed.a?.P || feed.a?.B || feed.positions) {
          for (const position of normalizePositionUpdate(feed)) this.emit("positionUpdate", position);
        }
      } catch (error) {
        this.emit("error", error);
      }
    });

    ws.on("close", () => {
      if (this.ws === ws) this.ws = undefined;
      if (!this.stopped && !this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = undefined;
          this.start();
        }, 1000);
        this.reconnectTimer.unref?.();
      }
    });
    ws.on("error", (error: any) => this.emit("error", error));
    return true;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const ws = this.ws;
    this.ws = undefined;
    // if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING || ws.readyState === 0 || ws.readyState === 1)) {
    if (isWsActive(ws)) {
      ws.close(1000, "client stop");
    }
  }
}

export const UserDataStreamSvc = new UserDataStreamService({ allowEnvFallback: true });
