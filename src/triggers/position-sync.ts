import { PositionStore } from "./position-store";

export interface HttpLike {
  get(path: string, config?: any): Promise<any>;
}

function looksLikeSinglePosition(payload: any): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;

  const hasSymbol = payload.symbol !== undefined || payload.s !== undefined || payload.a !== undefined || payload.asset !== undefined;
  const hasQty =
      payload.netQty !== undefined ||
      payload.positionAmt !== undefined ||
      payload.pa !== undefined ||
      payload.quantity !== undefined ||
      payload.qty !== undefined ||
      payload.availableQty !== undefined ||
      payload.availableQuantity !== undefined ||
      payload.aq !== undefined;

  return hasSymbol && hasQty;
}

function extractPositions(payload: any): { found: boolean; positions: any[] } {
  // Support ACCOUNT_UPDATE-style WS payload if API returns same shape.
  if (Array.isArray(payload?.a?.P)) {
    return { found: true, positions: payload.a.P };
  }

  return { found: false, positions: [] };
}

export class PositionSyncService {
  constructor(private http: HttpLike, private store: PositionStore) {}

  async refresh(config: any = {}): Promise<number> {
    // Use only the confirmed official endpoint.
    const path = process.env.POSITIONS_ENDPOINT || "/positions";

    if (process.env.SESSION_DEBUG === "true") {
      console.log("[POSITIONS_REFRESH_TRY]", { path });
    }

    const payload = await this.http.get(path, config);
    const extracted = extractPositions(payload);

    if (process.env.SESSION_DEBUG === "true") {
      console.log("[POSITIONS_REFRESH_RESPONSE]", {
        path,
        found: extracted.found,
        count: extracted.positions.length,
        isArray: Array.isArray(payload),
        topLevelKeys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 20) : [],
      });
    }

    if (!extracted.found) {
      return 0;
    }

    // REST /positions is authoritative, so replace stale cached positions.
    this.store.replace(extracted.positions);
    return extracted.positions.length;
  }
}