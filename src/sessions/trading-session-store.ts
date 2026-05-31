import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { quoteTradeStateRoot, safeOwnerKey, userStateFile } from "./user-state";

export type SigningAlgorithm = "sha256" | "hmac-sha256" | "ed25519";

export interface TradingSessionInput {
  apiKey: string;
  apiSecret: string;
  signingAlgorithm?: SigningAlgorithm | string;
  account?: string;
  label?: string;
}

export interface StoredTradingSession {
  version: 1;
  ownerId: string;
  apiKeyEncrypted: string;
  apiSecretEncrypted: string;
  signingAlgorithm: SigningAlgorithm;
  account?: string;
  label?: string;
  createdAt: number;
  updatedAt: number;
  lastVerifiedAt?: number;
}

export interface ResolvedTradingSession {
  ownerId: string;
  apiKey: string;
  apiSecret: string;
  signingAlgorithm: SigningAlgorithm;
  account?: string;
  label?: string;
  createdAt: number;
  updatedAt: number;
  lastVerifiedAt?: number;
}

export interface TradingSessionSummary {
  ownerId: string;
  connected: boolean;
  apiKey?: string;
  signingAlgorithm?: SigningAlgorithm;
  account?: string;
  label?: string;
  createdAt?: number;
  updatedAt?: number;
  lastVerifiedAt?: number;
  pathKey: string;
}

function now(): number { return Date.now(); }

export function redacted(value?: string): string {
  if (!value) return "not set";
  const text = String(value);
  return text.length <= 8 ? "••••" : `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function normalizeSigningAlgorithm(raw?: string): SigningAlgorithm {
  const value = String(raw ?? "sha256").trim().toLowerCase();
  if (["sha256", "hmac", "hmac-sha256", "hmac_sha256"].includes(value)) return "sha256";
  if (["ed25519", "ed-25519"].includes(value)) return "ed25519";
  throw new Error("signing algorithm must be sha256/hmac-sha256 or ed25519");
}

function keyMaterial(): string {
  const material = process.env.TELEGRAM_SESSION_ENCRYPTION_KEY
    || process.env.QUOTE_TRADE_SESSION_KEY
    || process.env.SESSION_ENCRYPTION_KEY
    || process.env.TELEGRAM_BOT_TOKEN;
  if (!material || !String(material).trim()) {
    throw new Error("TELEGRAM_SESSION_ENCRYPTION_KEY, QUOTE_TRADE_SESSION_KEY, SESSION_ENCRYPTION_KEY, or TELEGRAM_BOT_TOKEN is required to encrypt trading sessions");
  }
  return String(material);
}

function encryptionKey(): any {
  return createHash("sha256").update(keyMaterial()).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(payload: string): string {
  const [version, ivRaw, tagRaw, ciphertextRaw] = String(payload ?? "").split(":");
  if (version !== "v1" || !ivRaw || !tagRaw || !ciphertextRaw) throw new Error("Unsupported encrypted session payload");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, "base64")), decipher.final()]).toString("utf8");
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
}

export class TradingSessionStore {
  constructor(private readonly fileForOwner: (ownerId: string) => string = (ownerId) => userStateFile(ownerId, "session.json")) {}

  filePath(ownerId: string): string {
    return this.fileForOwner(String(ownerId));
  }

  listOwnerIds(): string[] {
    const usersDir = join(quoteTradeStateRoot(), "users");
    if (!existsSync(usersDir)) return [];
    const owners: string[] = [];
    for (const dirent of readdirSync(usersDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const session = readJsonFile<StoredTradingSession | undefined>(join(usersDir, dirent.name, "session.json"), undefined);
      if (session?.version === 1 && session.ownerId) owners.push(String(session.ownerId));
    }
    return [...new Set(owners)].sort();
  }

  set(ownerId: string, input: TradingSessionInput): StoredTradingSession {
    const owner = String(ownerId || "").trim();
    if (!owner) throw new Error("ownerId is required");
    const apiKey = String(input.apiKey ?? "").trim();
    const apiSecret = String(input.apiSecret ?? "").trim();
    if (!apiKey) throw new Error("api key is required");
    if (!apiSecret) throw new Error("api secret is required");

    const existing = this.getStored(owner);
    const session: StoredTradingSession = {
      version: 1,
      ownerId: owner,
      apiKeyEncrypted: encryptSecret(apiKey),
      apiSecretEncrypted: encryptSecret(apiSecret),
      signingAlgorithm: normalizeSigningAlgorithm(String(input.signingAlgorithm ?? existing?.signingAlgorithm ?? "sha256")),
      account: input.account !== undefined ? String(input.account).trim() || undefined : existing?.account,
      label: input.label !== undefined ? String(input.label).trim() || undefined : existing?.label,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
      lastVerifiedAt: existing?.lastVerifiedAt,
    };
    writeJsonFile(this.filePath(owner), session);
    return session;
  }

  getStored(ownerId: string): StoredTradingSession | undefined {
    const session = readJsonFile<StoredTradingSession | undefined>(this.filePath(ownerId), undefined);
    if (!session || session.version !== 1) return undefined;
    return session;
  }

  get(ownerId: string): ResolvedTradingSession | undefined {
    const stored = this.getStored(ownerId);
    if (!stored) return undefined;
    try {
      return {
        ownerId: stored.ownerId,
        apiKey: decryptSecret(stored.apiKeyEncrypted),
        apiSecret: decryptSecret(stored.apiSecretEncrypted),
        signingAlgorithm: stored.signingAlgorithm,
        account: stored.account,
        label: stored.label,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        lastVerifiedAt: stored.lastVerifiedAt,
      };
    } catch {
      // Most commonly caused by rotating/changing the encryption key. Treat the
      // session as unusable so real-mode orders cannot silently fall back to
      // process-global credentials. The user can reconnect with /connectkey.
      return undefined;
    }
  }

  require(ownerId: string): ResolvedTradingSession {
    const session = this.get(ownerId);
    if (!session) throw new Error("No Quote.Trade session connected for this Telegram user. Use /connectkey in a private chat first.");
    return session;
  }

  remove(ownerId: string): boolean {
    const file = this.filePath(ownerId);
    if (!existsSync(file)) return false;
    unlinkSync(file);
    return true;
  }

  touchVerified(ownerId: string): void {
    const stored = this.getStored(ownerId);
    if (!stored) return;
    writeJsonFile(this.filePath(ownerId), { ...stored, lastVerifiedAt: now(), updatedAt: now() });
  }

  summary(ownerId: string): TradingSessionSummary {
    const stored = this.getStored(ownerId);
    let resolved: ResolvedTradingSession | undefined;
    if (stored) {
      try {
        resolved = this.get(ownerId);
      } catch {
        resolved = undefined;
      }
    }
    return {
      ownerId: String(ownerId),
      connected: !!resolved,
      apiKey: stored ? (resolved ? redacted(resolved.apiKey) : "unreadable; reconnect required") : undefined,
      signingAlgorithm: stored?.signingAlgorithm,
      account: stored?.account,
      label: stored?.label,
      createdAt: stored?.createdAt,
      updatedAt: stored?.updatedAt,
      lastVerifiedAt: stored?.lastVerifiedAt,
      pathKey: safeOwnerKey(String(ownerId)),
    };
  }
}
