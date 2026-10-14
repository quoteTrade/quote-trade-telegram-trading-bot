import type { PositionStore } from "./position-store";

export interface HttpLike {
  get(path: string, config?: any): Promise<any>;
}

function looksLikeSinglePosition(payload: any): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;

  const hasSymbol =
    payload.symbol !== undefined || payload.s !== undefined || payload.a !== undefined || payload.asset !== undefined;
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

function looksLikeAccountUpdateEnvelope(payload: any): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (!payload.a || typeof payload.a !== "object" || Array.isArray(payload.a)) return false;
  return payload.e !== undefined || payload.E !== undefined || payload.T !== undefined;
}

function extractPositions(payload: any): { found: boolean; positions: any[] } {
  // Support ACCOUNT_UPDATE-style WS payload if API returns same shape.
  if (Array.isArray(payload?.a?.P)) {
    return { found: true, positions: payload.a.P };
  }
  if (looksLikeAccountUpdateEnvelope(payload) && payload.a.P === undefined) {
    return { found: true, positions: [] };
  }

  if (Array.isArray(payload)) return { found: true, positions: payload };
  if (Array.isArray(payload?.positions)) return { found: true, positions: payload.positions };
  if (Array.isArray(payload?.data)) return { found: true, positions: payload.data };
  if (looksLikeSinglePosition(payload)) return { found: true, positions: [payload] };

  return { found: false, positions: [] };
}

function positionResponseShape(payload: any): Record<string, unknown> {
  const accountEnvelope = payload?.a;
  const accountPositions = accountEnvelope?.P;
  return {
    topLevelKeys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 20) : [],
    accountEnvelopeKeys:
      accountEnvelope && typeof accountEnvelope === "object" ? Object.keys(accountEnvelope).slice(0, 20) : [],
    hasAccountPositions: accountPositions !== undefined,
    accountPositionsIsArray: Array.isArray(accountPositions),
    accountPositionsCount: Array.isArray(accountPositions) ? accountPositions.length : undefined,
  };
}

export class PositionSyncService {
  constructor(
    private http: HttpLike,
    private store: PositionStore,
  ) {}

  async refresh(config: any = {}): Promise<number> {
    // Use only the confirmed official endpoint.
    const path = process.env.POSITIONS_ENDPOINT || "/positions";

    if (process.env.SESSION_DEBUG === "true") {
      console.log("[POSITIONS_REFRESH_TRY]", { path });
    }

    const payload = await this.http.get(path, config);
    if (payload?.error || (payload?.message && payload?.success === false)) {
      throw new Error(String(payload.error ?? payload.message));
    }
    const extracted = extractPositions(payload);

    if (process.env.SESSION_DEBUG === "true") {
      console.log("[POSITIONS_REFRESH_RESPONSE]", {
        path,
        found: extracted.found,
        count: extracted.positions.length,
        isArray: Array.isArray(payload),
        ...positionResponseShape(payload),
      });
    }

    if (!extracted.found) {
      throw new Error("Quote.Trade returned an unrecognized positions response");
    }

    // REST /positions is authoritative, so replace stale cached positions.
    this.store.replace(extracted.positions);
    return extracted.positions.length;
  }
}
