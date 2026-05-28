export interface OrderHistoryEntry {
    symbol: string;
    side: "BUY" | "SELL";
    orderId?: string;
    clientOrderId?: string;
    execId?: string;

    ordType?: string;
    orderType?: string;
    execType?: string;
    ordStatus?: string;

    quantity?: string;
    cumQty?: string;
    lastQty?: string;
    leavesQty?: number;

    price?: string;
    avgPx?: string;
    lastPx?: string;
    fillPrice?: string;

    timestamp?: number;
    updatedAt: number;
    children?: OrderHistoryEntry[];
    raw?: any;
}

export interface PaginatedOrders {
    items: OrderHistoryEntry[];
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
}

function toNumber(value: any): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function orderKey(order: OrderHistoryEntry): string {
    return order.orderId || order.clientOrderId || order.execId || `${order.symbol}:${order.side}:${order.updatedAt}`;
}

function normalizeOrder(update: any): OrderHistoryEntry | undefined {
    if (!update?.symbol) return undefined;

    return {
        symbol: String(update.symbol).toUpperCase(),
        side: update.side === "BUY" ? "BUY" : "SELL",

        orderId: update.orderId ? String(update.orderId) : undefined,
        clientOrderId: update.clientOrderId ? String(update.clientOrderId) : undefined,
        execId: update.execId ? String(update.execId) : undefined,

        ordType: update.ordType != null ? String(update.ordType) : undefined,
        orderType: update.orderType != null ? String(update.orderType) : update.type != null ? String(update.type) : undefined,
        execType: update.execType != null ? String(update.execType) : undefined,
        ordStatus: update.ordStatus != null ? String(update.ordStatus) : update.status != null ? String(update.status) : undefined,

        quantity: update.quantity != null ? String(update.quantity) : undefined,
        cumQty: update.cumQty != null ? String(update.cumQty) : undefined,
        lastQty: update.lastQty != null ? String(update.lastQty) : undefined,
        leavesQty: update.leavesQty != null ? toNumber(update.leavesQty) : undefined,

        price: update.price != null ? String(update.price) : undefined,
        avgPx: update.avgPx != null ? String(update.avgPx) : undefined,
        lastPx: update.lastPx != null ? String(update.lastPx) : undefined,
        fillPrice: update.fillPrice != null ? String(update.fillPrice) : undefined,

        timestamp: update.timestamp ? Number(update.timestamp) : Date.now(),
        updatedAt: Date.now(),
        raw: update.raw,
    };
}

export class OrderHistoryStore {
    private entries: OrderHistoryEntry[] = [];

    private openOrders: OrderHistoryEntry[] = [];
    private filledOrders: OrderHistoryEntry[] = [];
    private canceledOrders: OrderHistoryEntry[] = [];

    private rebuildTimer?: NodeJS.Timeout;
    private syncing = false;

    constructor(private readonly maxEntries = Number(process.env.ORDER_HISTORY_MAX ?? 3000)) {}

    upsert(update: any): OrderHistoryEntry | undefined {
        const entry = normalizeOrder(update);
        if (!entry) return undefined;

        this.syncing = true;

        // Keep every latest order state by orderId/clientOrderId.
        const key = orderKey(entry);
        const existingIndex = this.entries.findIndex((item) => orderKey(item) === key);

        if (existingIndex >= 0) {
            this.entries[existingIndex] = {
                ...this.entries[existingIndex],
                ...entry,
                updatedAt: Date.now(),
            };
        } else {
            this.entries.unshift(entry);
        }

        this.entries = this.entries.slice(0, this.maxEntries);

        // Important: do not rebuild immediately for every WS event.
        this.scheduleRebuild();

        return entry;
    }

    orders(page = 1, pageSize = this.defaultPageSize()): PaginatedOrders {
        return this.paginate(this.openOrders, page, pageSize);
    }

    fills(page = 1, pageSize = this.defaultPageSize()): PaginatedOrders {
        return this.paginate(this.filledOrders, page, pageSize);
    }

    isSyncing(): boolean {
        return this.syncing;
    }

    private scheduleRebuild(): void {
        if (this.rebuildTimer) clearTimeout(this.rebuildTimer);

        this.rebuildTimer = setTimeout(() => {
            this.rebuildTimer = undefined;

            const started = Date.now();
            this.rebuildGroups();
            this.syncing = false;

            if (process.env.SESSION_DEBUG === "true") {
                console.log("[ORDER_HISTORY_REBUILD_DONE]", {
                    total: this.entries.length,
                    open: this.openOrders.length,
                    filled: this.filledOrders.length,
                    canceled: this.canceledOrders.length,
                    ms: Date.now() - started,
                });
            }
        }, 500);
    }

    private rebuildGroups(): void {
        const sorted = this.sortOrderTrade(this.entries);
        const reduced = this.reduceOrderTrade(sorted);
        const grouped = this.orderTradeGroupBy(reduced);

        this.openOrders = grouped.openOrders;
        this.filledOrders = grouped.filledOrders;
        this.canceledOrders = grouped.canceledOrders;
    }

    private sortOrderTrade(orders: OrderHistoryEntry[]): OrderHistoryEntry[] {
        return [...orders].sort((current, next) => {
            const currentOrderId = toNumber(current.orderId);
            const nextOrderId = toNumber(next.orderId);

            if (currentOrderId !== nextOrderId) {
                return currentOrderId - nextOrderId;
            }

            return toNumber(current.timestamp ?? current.updatedAt) - toNumber(next.timestamp ?? next.updatedAt);
        });
    }

    private reduceOrderTrade(orders: OrderHistoryEntry[]): OrderHistoryEntry[] {
        const reduceOrders = orders.reduce<OrderHistoryEntry[]>((array, current) => {
            const length = array.length;
            const lastOrderId = length > 0 ? array[length - 1]?.orderId : undefined;
            const currentOrderId = current.orderId;

            if (length === 0 || lastOrderId !== currentOrderId) {
                return [...array, current];
            }

            if (lastOrderId === currentOrderId) {
                current.children = [
                    array[length - 1],
                    ...(array[length - 1].children || []),
                ];
                array.pop();
                return [...array, current];
            }

            return [...array];
        }, []);

        return reduceOrders.reverse();
    }

    private orderTradeGroupBy(orders: OrderHistoryEntry[]): {
        openOrders: OrderHistoryEntry[];
        filledOrders: OrderHistoryEntry[];
        canceledOrders: OrderHistoryEntry[];
    } {
        const openOrders = orders.filter((order) => {
            const execType = String(order.execType ?? "");
            const ordType = String(order.ordType ?? "");
            const ordStatus = String(order.ordStatus ?? "");
            const leavesQty = toNumber(order.leavesQty);

            return (
                (["F"].includes(execType) && !["1"].includes(ordType) && leavesQty !== 0) ||
                (
                    !["F", "4", "8", "B", "C"].includes(execType) &&
                    !["1"].includes(ordType) &&
                    !["8"].includes(ordType) &&
                    !["8"].includes(ordStatus)
                )
            );
        });

        const filledOrders = orders.filter((order) => {
            const execType = String(order.execType ?? "");
            const ordType = String(order.ordType ?? "");
            const ordStatus = String(order.ordStatus ?? "");
            const cumQty = toNumber(order.cumQty);

            return (
                (!["4", "8"].includes(execType) && ["1"].includes(ordType) && ["2"].includes(ordStatus)) ||
                (["B", "C", "F"].includes(execType) && cumQty !== 0)
            );
        });

        const canceledOrders = orders.filter((order) => {
            const execType = String(order.execType ?? "");
            const ordStatus = String(order.ordStatus ?? "");
            const cumQty = toNumber(order.cumQty);

            return (
                ["4", "8"].includes(execType) ||
                ["4"].includes(ordStatus) ||
                (["B", "C"].includes(execType) && cumQty === 0)
            );
        });

        return { openOrders, filledOrders, canceledOrders };
    }

    private paginate(items: OrderHistoryEntry[], page: number, pageSize: number): PaginatedOrders {
        const safePageSize = Math.min(Math.max(pageSize || 10, 1), 25);
        const total = items.length;
        const totalPages = Math.max(1, Math.ceil(total / safePageSize));
        const safePage = Math.min(Math.max(page || 1, 1), totalPages);
        const start = (safePage - 1) * safePageSize;

        return {
            items: items.slice(start, start + safePageSize),
            page: safePage,
            pageSize: safePageSize,
            total,
            totalPages,
        };
    }

    private defaultPageSize(): number {
        const n = Number(process.env.ORDER_HISTORY_PAGE_SIZE ?? 10);
        return Number.isFinite(n) && n > 0 ? n : 10;
    }
}