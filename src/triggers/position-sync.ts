import { PositionStore } from "./position-store";

export interface HttpLike { get(path: string, config?: any): Promise<any>; }

function extractPositions(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.positions)) return payload.positions;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.account?.positions)) return payload.account.positions;
  return [];
}

export class PositionSyncService {
  constructor(private http: HttpLike, private store: PositionStore) {}

  async refresh(config: any = {}): Promise<number> {
    const paths = [process.env.POSITIONS_ENDPOINT || "", "/positions", "/account/positions", "/position", "/getPositions"].filter(Boolean);
    let lastError: unknown;

    for (const path of paths) {
      try {
        const payload = await this.http.get(path, config);
        const positions = extractPositions(payload);
        if (positions.length) {
          this.store.merge(positions);
          return positions.length;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) throw lastError;
    return 0;
  }
}
