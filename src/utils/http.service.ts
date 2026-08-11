import { createHmac, createPrivateKey, sign as nodeSign } from "node:crypto";
import axios from "axios";
import type { SigningAlgorithm } from "../sessions/trading-session-store";

export interface QuoteTradeCredentials {
  apiKey: string;
  apiSecret: string;
  signingAlgorithm?: SigningAlgorithm | string;
}

interface HttpConfigWithCredentials {
  headers?: Record<string, string>;
  quoteTradeCredentials?: QuoteTradeCredentials;
  /** Set false for session-scoped Telegram requests so a missing user session cannot fall back to global TRADE_* keys. */
  allowEnvCredentials?: boolean;
  [key: string]: unknown;
}

function normalizeSigningAlgorithm(raw?: string): "sha256" | "ed25519" {
  const value = String(raw ?? process.env.SIGNING_ALGORITHM ?? "sha256")
    .trim()
    .toLowerCase();
  return value === "ed25519" ? "ed25519" : "sha256";
}

function signRequest(payload: string, credentials?: QuoteTradeCredentials, allowEnvCredentials = true): string {
  const secret = credentials?.apiSecret ?? (allowEnvCredentials ? process.env.TRADE_API_SECRET : undefined);
  if (!secret) return "";

  if (normalizeSigningAlgorithm(credentials?.signingAlgorithm) === "ed25519") {
    const pem = secret.includes("BEGIN PRIVATE KEY")
      ? secret.replace(/\\n/g, "\n")
      : `-----BEGIN PRIVATE KEY-----\n${secret.match(/.{1,64}/g)?.join("\n") ?? secret}\n-----END PRIVATE KEY-----`;
    return nodeSign(null, Buffer.from(payload), createPrivateKey(pem)).toString("base64");
  }

  return createHmac("sha256", secret).update(payload).digest("hex");
}

function sanitizeConfig(config: HttpConfigWithCredentials = {}): Record<string, unknown> {
  const { quoteTradeCredentials: _credentials, allowEnvCredentials: _allowEnvCredentials, ...rest } = config;
  return rest;
}

function positiveMs(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

class HttpService {
  private readonly apiUrl = `${process.env.API_BASE_URL ?? ""}`.replace(/\/$/, "");

  private full(path: string): string {
    return /^https?:\/\//i.test(path) ? path : `${this.apiUrl}${path}`;
  }

  private headers(payload: string, config: HttpConfigWithCredentials = {}): Record<string, string> {
    const credentials = config.quoteTradeCredentials;
    const allowEnvCredentials = config.allowEnvCredentials !== false;
    const headers = { ...(config.headers || {}) };
    const apiKey = credentials?.apiKey ?? (allowEnvCredentials ? process.env.TRADE_API_KEY : undefined);
    if (apiKey) headers["X-Mbx-Apikey"] = apiKey;
    const signature = signRequest(payload, credentials, allowEnvCredentials);
    if (signature) headers.signature = signature;
    return headers;
  }

  async get(path: string, config: HttpConfigWithCredentials = {}): Promise<any> {
    const safeConfig = sanitizeConfig(config);
    const timeout = safeConfig.timeout ?? positiveMs(process.env.QUOTE_TRADE_GET_TIMEOUT_MS, 15_000);
    const startedAt = Date.now();
    try {
      const response = await axios.get(this.full(path), {
        ...safeConfig,
        timeout,
        headers: this.headers(path, config),
      });
      return response.data;
    } finally {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= positiveMs(process.env.SLOW_REQUEST_LOG_MS, 2_000)) {
        console.warn("[SLOW_QUOTE_TRADE_REQUEST]", { method: "GET", path, elapsedMs });
      }
    }
  }

  async post(path: string, body: any = {}, config: HttpConfigWithCredentials = {}): Promise<any> {
    const payload = JSON.stringify({ ...body, channel: body.channel ?? "LIQUIDITY" });
    const safeConfig = sanitizeConfig(config);
    const timeout = safeConfig.timeout ?? positiveMs(process.env.QUOTE_TRADE_POST_TIMEOUT_MS, 35_000);
    const startedAt = Date.now();
    try {
      const response = await axios.post(this.full(path), JSON.parse(payload), {
        ...safeConfig,
        timeout,
        headers: this.headers(payload, config),
      });
      return response.data;
    } finally {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= positiveMs(process.env.SLOW_REQUEST_LOG_MS, 2_000)) {
        console.warn("[SLOW_QUOTE_TRADE_REQUEST]", { method: "POST", path, elapsedMs });
      }
    }
  }
}

export const HttpSvc = new HttpService();
