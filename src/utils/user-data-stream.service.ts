import WebSocket from "ws";

export class UserDataStreamService {
  private readonly ws: WebSocket;
  private maxReconnectAttempts = 10;
  private reconnectAttempts = 0;
  private reconnectInterval = 5000; // 5 seconds
  private type: string; // positions, open_orders, filled_orders, canceled_orders
  private callback: any;
  private defaultPositions: any = {
    id: 0,
    symbol: "",
    quantity: "0.000000",
    assetTypeDisplayValue: "ASSET",
    availableQuantity: "0.000000",
    usdRealized: '0.0',
    baseUsdMark: '0.0',
    usdValue: '0.0',
  };

  private timeoutHandle: NodeJS.Timeout | null = null;
  private TIMEOUT_MS = 10_000; // 10 seconds

  constructor() {
    this.ws = new WebSocket(`${process.env.LISTEN_KEY_WS_URL}`);
    this.type = '';
    this.callback = undefined;
  }

  private startTimeout() {
    // Clear old timeout first
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);

    // Start new timeout
    this.timeoutHandle = setTimeout(() => {
      console.warn('No data received in 10 seconds. Closing WebSocket.');
      this.calBackReject();
    }, this.TIMEOUT_MS);
  }

  private connect(subscribeMessage: any) {
    this.ws.onopen = () => {
      console.log('✅ User Data Stream WebSocket connected...');
      this.ws.send(JSON.stringify(subscribeMessage));
      this.startTimeout();
      console.log(`📡 User Data Stream: Subscribed`);
    };

    this.ws.onmessage = (message: any) => {
      // console.log('Message received:', message.data);
      try {
        this.handleIncomingData(message.data);
        this.startTimeout();
      } catch (e) {
        console.error('❌ User Data Stream WebSocket message error:', e);
        this.calBackReject();
      }
    };

    this.ws.onclose = () => {
      if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
      console.log('❌ User Data Stream WebSocket closed...');
    };

    this.ws.onerror = (error: any) => {
      if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
      console.error('❌ User Data Stream WebSocket error:', error);
      this.calBackReject();
    };
  }

  private handleReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts += 1;
      console.log(`📡 Reconnecting in ${this.reconnectInterval / 1000}s...`);
      setTimeout(() => this.connect({}), this.reconnectInterval);
    } else {
      console.error('🚫 User Data Stream: Max reconnect attempts reached...');
    }
  }

  // Handle incoming WebSocket messages
  private handleIncomingData(data: any) {
    try {
      const feed = JSON.parse(data);
      switch (this.type) {
        case 'positions':
          if (feed.e === 'ACCOUNT_UPDATE' && feed.a?.m === 'ORDER' && this.callback) {
            const { resolve } = this.callback;
            if (resolve) {
              this.callback = undefined; // Remove after use
              resolve(this.analyzePositionsUpdate(feed));
              if (this.ws) {
                this.ws.close();
              }
            }
          }
          break;
        default:
          break;
      }
    } catch (e) {
      console.error('❌ User Data Stream WebSocket message error:', e);
      this.calBackReject();
    }
  }

  private analyzePositionsUpdate(feed: any = {}) {
    // const data = feed.a?.B || [];
    const data =  [...(feed?.a?.B || []), ...(feed?.a?.P || [])];
    (data).forEach((item, index) => {
      item.id = index;
      item.instrumentId = item.i;
      item.symbol = item.a;
      item.quantity = item.wb;
      item.availableQuantity = item.aq;
      item.userId = item.u;
      item.assetType = item.at;
      item.assetTypeDisplayValue = item.at;
      item.usdCostBasis = item.ucb;
      item.usdAvgCostBasis = item.uacb;
      // item.usdUnrealized = item.up;
      // item.usdRealized = item.ur;
      // item.baseUsdMark = item.m;
      item.settleCoinUsdMark = item.sm;
      item.settleCoinUnrealized = item.su;
      item.settleCoinRealized = item.sr;
      item.usdValue = (item.uv);

      if (item.s) {
        item.symbol = item.s;
      }
      if (item.pa) {
        item.quantity = item.pa;
      }

      // item.usdAvgCostBasisDisplayValue = (parseFloat(item.usdAvgCostBasis) === 0 || parseFloat(item.quantity) === 0) ? '--' : fCurrency(item.usdAvgCostBasis);
    });

    const hasUSD = data.find((item) => item.symbol === "USD");
    const hasUSDC = data.find((item) => item.symbol === "USDC");
    const hasUSDT = data.find((item) => item.symbol === "USDT");

    const newDataArray = [ ...data ];
    // const newDataArray = data.filter((element) => element.symbol !== 'USD');

    if (!hasUSD) {
      const positions = { ...this.defaultPositions };
      positions.id = "USD";
      positions.symbol = "USD";
      newDataArray.push(positions);
    }

    if (!hasUSDC) {
      const positions = { ...this.defaultPositions };
      positions.id = "USDC";
      positions.symbol = "USDC";
      newDataArray.push(positions);
    }

    if (!hasUSDT) {
      const positions = { ...this.defaultPositions };
      positions.id = "USDT";
      positions.symbol = "USDT";
      newDataArray.push(positions);
    }

    const customSortOrder = ["USD", "USDC", "USDT"];

    newDataArray.sort((a, b) => {
      const indexA = customSortOrder.indexOf(a.symbol);
      const indexB = customSortOrder.indexOf(b.symbol);

      // Symbols in customOrder come first
      if (indexA === -1 && indexB === -1) return 0; // Both not in customOrder, keep original order
      if (indexA === -1) return 1; // a is not in customOrder, b comes first
      if (indexB === -1) return -1; // b is not in customOrder, a comes first
      return indexA - indexB; // Both in customOrder, sort by their indices
    });

    return newDataArray;
  }

  private calBackReject() {
    if (this.callback) {
      const { reject } = this.callback;
      if (reject) {
        this.callback = undefined;
        reject();
      }
    }
  }

  public async getPositions(auth: any): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      this.type = 'positions';
      this.callback = {resolve, reject};
      this.connect({
        "account": "",
        "unsubscribe": 0,
        "requestToken": auth.requestToken,
        // "channel": ''
      });
    });
  }

}