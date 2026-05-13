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

export class UserDataStreamService extends EventEmitter {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;

  start(): void {
    this.stopped = false;
    this.ws = new WebSocket(process.env.LISTEN_KEY_WS_URL || "");

    this.ws.on("open", () => {
      this.ws?.send(JSON.stringify({ unsubscribe: 0, requestToken: process.env.TRADE_API_KEY ?? "" }));
    });

    this.ws.on("message", (data: WebSocket.RawData) => {
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

    this.ws.on("close", () => {
      if (!this.stopped) this.reconnectTimer = setTimeout(() => this.start(), 1000);
    });
    this.ws.on("error", (error: any) => this.emit("error", error));
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === 0)) {
      this.ws.close(1000, "client stop");
    }
  }
}

export const UserDataStreamSvc = new UserDataStreamService();
