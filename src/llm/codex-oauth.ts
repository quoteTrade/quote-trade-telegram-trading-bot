import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userStateDir } from "../sessions/user-state";
import type { RawLlmPlan } from "./index";

export interface CodexLoginStart {
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export interface CodexStatus {
  connected: boolean;
  pending: boolean;
  codexHome: string;
  authFile: string;
  loginId?: string;
}

interface PendingLogin {
  ownerId: string;
  loginId?: string;
  proc: any;
  send: (message: unknown) => void;
  done: boolean;
  onComplete?: (result: { success: boolean; error?: string }) => void;
}

const pendingLogins = new Map<string, PendingLogin>();
let nextRpcId = 1;

function codexBin(): string {
  return String(process.env.CODEX_BIN || "codex");
}

function timeoutMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function codexHomeForOwner(ownerId: string): string {
  const dir = join(userStateDir(ownerId), "codex");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  return dir;
}

export function codexAuthFile(ownerId: string): string {
  return join(codexHomeForOwner(ownerId), "auth.json");
}

function codexWorkspace(ownerId: string): string {
  const dir = join(userStateDir(ownerId), "codex-workspace");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  return dir;
}

function ensureCodexConfig(ownerId: string): string {
  const home = codexHomeForOwner(ownerId);
  const file = join(home, "config.toml");
  if (!existsSync(file)) {
    writeFileSync(file, [
      'cli_auth_credentials_store = "file"',
      'forced_login_method = "chatgpt"',
      'model_reasoning_effort = "low"',
      'sandbox_mode = "read-only"',
      '',
    ].join("\n"), { mode: 0o600 });
  }
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
  return file;
}

function safeEnv(ownerId: string): Record<string, string> {
  const home = codexHomeForOwner(ownerId);
  const env: Record<string, string> = {
    PATH: String(process.env.PATH || ""),
    CODEX_HOME: home,
    HOME: home,
    USERPROFILE: home,
    TERM: String(process.env.TERM || "dumb"),
    NO_COLOR: "1",
  };
  const ca = process.env.CODEX_CA_CERTIFICATE || process.env.SSL_CERT_FILE;
  if (ca) env.CODEX_CA_CERTIFICATE = String(ca);
  return env;
}

export function hasCodexOAuthSession(ownerId: string): boolean {
  const file = codexAuthFile(ownerId);
  if (!existsSync(file)) return false;
  try {
    const text = readFileSync(file, "utf8");
    return /chatgpt|access/i.test(text);
  } catch {
    return false;
  }
}

export function codexOAuthStatus(ownerId: string): CodexStatus {
  const authFile = codexAuthFile(ownerId);
  const pending = pendingLogins.get(String(ownerId));
  return {
    connected: hasCodexOAuthSession(ownerId),
    pending: !!pending,
    codexHome: codexHomeForOwner(ownerId),
    authFile,
    loginId: pending?.loginId,
  };
}

function parseLines(buffer: { text: string }, chunk: any): any[] {
  buffer.text += String(chunk);
  const messages: any[] = [];
  for (;;) {
    const idx = buffer.text.indexOf("\n");
    if (idx < 0) break;
    const line = buffer.text.slice(0, idx).trim();
    buffer.text = buffer.text.slice(idx + 1);
    if (!line) continue;
    try { messages.push(JSON.parse(line)); } catch { /* ignore non-json logs */ }
  }
  return messages;
}

function spawnCodexAppServer(ownerId: string): { proc: any; send: (message: unknown) => void; waitForId: (id: number, ms: number) => Promise<any> } {
  ensureCodexConfig(ownerId);
  const { spawn } = require("node:child_process");
  const proc = spawn(codexBin(), ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: safeEnv(ownerId),
  });

  const callbacks = new Map<number, { resolve: (value: any) => void; reject: (error: any) => void; timer: any }>();
  const buffer = { text: "" };
  let stderr = "";

  const send = (message: unknown) => {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const waitForId = (id: number, ms: number) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      callbacks.delete(id);
      reject(new Error(`Codex app-server request ${id} timed out${stderr ? `: ${stderr.slice(-300)}` : ""}`));
    }, ms);
    callbacks.set(id, { resolve, reject, timer });
  });

  proc.stdout.on("data", (chunk: any) => {
    for (const msg of parseLines(buffer, chunk)) {
      if (msg && typeof msg.id === "number" && callbacks.has(msg.id)) {
        const cb = callbacks.get(msg.id)!;
        callbacks.delete(msg.id);
        clearTimeout(cb.timer);
        if (msg.error) cb.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else cb.resolve(msg.result);
        continue;
      }
      if (msg?.method === "account/login/completed") {
        const owner = String(ownerId);
        const pending = pendingLogins.get(owner);
        if (pending && (!pending.loginId || pending.loginId === msg.params?.loginId)) {
          pending.done = true;
          pendingLogins.delete(owner);
          try { chmodSync(codexAuthFile(owner), 0o600); } catch { /* best effort */ }
          pending.onComplete?.({ success: !!msg.params?.success, error: msg.params?.error ? String(msg.params.error) : undefined });
          try { pending.proc.stdin.end(); } catch { /* ignore */ }
          try { pending.proc.kill(); } catch { /* ignore */ }
        }
      }
    }
  });

  proc.stderr.on("data", (chunk: any) => { stderr += String(chunk); });
  proc.on("exit", () => {
    for (const [id, cb] of callbacks) {
      clearTimeout(cb.timer);
      cb.reject(new Error(`Codex app-server exited before request ${id} completed${stderr ? `: ${stderr.slice(-300)}` : ""}`));
    }
    callbacks.clear();
  });

  return { proc, send, waitForId };
}

export async function startCodexOAuthLogin(ownerId: string, onComplete?: (result: { success: boolean; error?: string }) => void): Promise<CodexLoginStart> {
  const owner = String(ownerId || "").trim();
  if (!owner) throw new Error("ownerId is required for Codex OAuth");
  if (pendingLogins.has(owner)) throw new Error("Codex OAuth login is already pending for this Telegram user. Use /codexcancel first if needed.");

  const app = spawnCodexAppServer(owner);
  const initializeId = nextRpcId++;
  app.send({ method: "initialize", id: initializeId, params: { clientInfo: { name: "quote_trade_telegram_bot", title: "Quote.Trade Telegram Bot", version: "1.0.0" } } });
  await app.waitForId(initializeId, timeoutMs("CODEX_LOGIN_START_TIMEOUT_MS", 30_000));
  app.send({ method: "initialized", params: {} });

  pendingLogins.set(owner, { ownerId: owner, proc: app.proc, send: app.send, done: false, onComplete });

  const loginId = nextRpcId++;
  try {
    app.send({ method: "account/login/start", id: loginId, params: { type: "chatgptDeviceCode" } });
    const result = await app.waitForId(loginId, timeoutMs("CODEX_LOGIN_START_TIMEOUT_MS", 30_000));

    if (result?.type !== "chatgptDeviceCode" || !result.verificationUrl || !result.userCode || !result.loginId) {
      pendingLogins.delete(owner);
      try { app.proc.kill(); } catch { /* ignore */ }
      throw new Error("Codex did not return a device-code OAuth challenge");
    }

    const pending = pendingLogins.get(owner);
    if (pending) pending.loginId = String(result.loginId);

    const killTimer: any = setTimeout(() => {
    const pending = pendingLogins.get(owner);
    if (!pending || pending.done) return;
    pendingLogins.delete(owner);
    try { pending.proc.kill(); } catch { /* ignore */ }
    pending.onComplete?.({ success: false, error: "Codex OAuth login timed out" });
    }, timeoutMs("CODEX_LOGIN_TIMEOUT_MS", 10 * 60_000));
    killTimer.unref?.();

    return { loginId: String(result.loginId), verificationUrl: String(result.verificationUrl), userCode: String(result.userCode) };
  } catch (error) {
    pendingLogins.delete(owner);
    try { app.proc.kill(); } catch { /* ignore */ }
    throw error;
  }
}

export function cancelCodexOAuthLogin(ownerId: string): boolean {
  const owner = String(ownerId);
  const pending = pendingLogins.get(owner);
  if (!pending) return false;
  pendingLogins.delete(owner);
  if (pending.loginId) {
    try { pending.send({ method: "account/login/cancel", id: nextRpcId++, params: { loginId: pending.loginId } }); } catch { /* ignore */ }
  }
  try { pending.proc.kill(); } catch { /* ignore */ }
  return true;
}

export function logoutCodexOAuth(ownerId: string): boolean {
  cancelCodexOAuthLogin(ownerId);
  const file = codexAuthFile(ownerId);
  if (!existsSync(file)) return false;
  try { unlinkSync(file); } catch { return false; }
  return true;
}

const CODEX_PLAN_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "commands", "riskNotes"],
  properties: {
    summary: { type: "string" },
    commands: { type: "array", minItems: 0, maxItems: 12, items: { type: "string" } },
    riskNotes: { type: "array", minItems: 0, maxItems: 12, items: { type: "string" } },
  },
};

function parseCodexJson(raw: string): RawLlmPlan {
  const text = String(raw || "").trim();
  if (!text) throw new Error("Codex returned an empty plan");
  const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(clean); } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
    throw new Error("Codex did not return a JSON object");
  }
}

export async function completeCodexOAuthPlan(ownerId: string, model: string, request: { systemPrompt: string; userPrompt: string }): Promise<RawLlmPlan> {
  const owner = String(ownerId || "").trim();
  if (!hasCodexOAuthSession(owner)) throw new Error("Codex OAuth is not connected for this Telegram user. Use /codexconnect in a private chat first.");
  ensureCodexConfig(owner);

  const home = codexHomeForOwner(owner);
  const workspace = codexWorkspace(owner);
  const schemaPath = join(home, "quote-trade-plan.schema.json");
  const outputPath = join(home, `quote-trade-plan-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(schemaPath, JSON.stringify(CODEX_PLAN_RESPONSE_SCHEMA), { mode: 0o600 });

  const prompt = [
    request.systemPrompt,
    "",
    request.userPrompt,
    "",
    "Return JSON only. Do not run shell commands. Do not access files. Do not submit trades.",
  ].join("\n");

  const args = [
    "exec",
    "--ephemeral",
    "--ignore-rules",
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "--cd", workspace,
    "--output-schema", schemaPath,
    "--output-last-message", outputPath,
  ];
  if (model && model !== "default") args.push("--model", model);
  args.push("-");

  const { spawn } = require("node:child_process");
  const proc = spawn(codexBin(), args, { stdio: ["pipe", "pipe", "pipe"], env: safeEnv(owner) });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk: any) => { stdout += String(chunk); });
  proc.stderr.on("data", (chunk: any) => { stderr += String(chunk); });
  proc.stdin.write(prompt);
  proc.stdin.end();

  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      reject(new Error("Codex strategy planning timed out"));
    }, timeoutMs("CODEX_EXEC_TIMEOUT_MS", 120_000));
    proc.on("exit", (exitCode: number) => { clearTimeout(timer); resolve(exitCode ?? 0); });
    proc.on("error", (error: any) => { clearTimeout(timer); reject(error); });
  });

  if (code !== 0) throw new Error(`Codex strategy planning failed${stderr ? `: ${stderr.slice(-500)}` : ""}`);
  const output = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : stdout;
  try { unlinkSync(outputPath); } catch { /* ignore */ }
  return parseCodexJson(output);
}
