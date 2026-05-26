import { chmodSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

export function quoteTradeStateRoot(): string {
  return resolve(process.env.QUOTE_TRADE_STATE_DIR ?? ".quote-trade");
}

export function safeOwnerKey(ownerId: string): string {
  const clean = String(ownerId ?? "").trim();
  if (!clean) throw new Error("ownerId is required");
  return createHash("sha256").update(clean).digest("hex").slice(0, 32);
}

export function userStateDir(ownerId: string): string {
  const root = quoteTradeStateRoot();
  const usersRoot = join(root, "users");
  const dir = join(usersRoot, safeOwnerKey(ownerId));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const candidate of [root, usersRoot, dir]) {
    try { chmodSync(candidate, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
  }
  return dir;
}

export function userStateFile(ownerId: string, name: string): string {
  return join(userStateDir(ownerId), name);
}
