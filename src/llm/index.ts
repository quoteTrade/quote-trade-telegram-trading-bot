import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  TriggerInput,
  normalizeSide,
  normalizeSymbol,
  parseAmountOrPercent,
  parseTimeOrDuration,
  PriceBandMode,
  RiskAction,
  RiskMetric,
} from "../triggers/types";
import { decryptSecret, encryptSecret } from "../sessions/trading-session-store";
import { completeCodexOAuthPlan, hasCodexOAuthSession } from "./codex-oauth";

export type LlmProviderId =
  | "openai"
  | "anthropic"
  | "xai"
  | "ovhcloud"
  | "gemini"
  | "openrouter"
  | "groq"
  | "huggingface"
  | "pollinations"
  | "custom-openai"
  | "codex-oauth";

export type LlmProtocol = "openai-chat" | "anthropic-messages" | "gemini-generate-content" | "codex-exec";
export type PlanCommandFormat = "cli" | "telegram" | "mixed";

export interface LlmProviderDefaults {
  provider: LlmProviderId;
  displayName: string;
  protocol: LlmProtocol;
  defaultModel: string;
  defaultBaseUrl: string;
  defaultApiKeyEnv: string;
  alternateApiKeyEnvs?: string[];
  freeFallbackCandidate?: boolean;
  requiresApiKey?: boolean;
}

export interface LlmConnectionInput {
  ownerId?: string;
  provider: string;
  model?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  enabled?: boolean;
  useAsFallback?: boolean;
  makeDefault?: boolean;
}

export interface LlmConnection {
  ownerId: string;
  provider: LlmProviderId;
  model: string;
  /** Legacy/in-memory only. Stored config files use apiKeyEncrypted. */
  apiKey?: string;
  apiKeyEncrypted?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  enabled: boolean;
  useAsFallback: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ResolvedLlmConnection extends LlmConnection {
  displayName: string;
  protocol: LlmProtocol;
  effectiveApiKey?: string;
  effectiveBaseUrl: string;
  keySource?: "stored" | "env";
  freeFallbackCandidate: boolean;
  source: "stored" | "env" | "anonymous" | "oauth";
}

export interface LlmProviderListRow {
  provider: LlmProviderId;
  displayName: string;
  model: string;
  baseUrl: string;
  key: string;
  source: "stored" | "env" | "anonymous" | "oauth" | "missing";
  enabled: boolean;
  default: boolean;
  fallback: boolean;
}

export const FREE_FALLBACK_ORDER: LlmProviderId[] = ["ovhcloud", "gemini", "openrouter", "groq", "huggingface", "pollinations"];

export const LLM_PROVIDER_DEFAULTS: Record<LlmProviderId, LlmProviderDefaults> = {
  openai: {
    provider: "openai",
    displayName: "OpenAI / ChatGPT",
    protocol: "openai-chat",
    defaultModel: "gpt-4o-mini",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultApiKeyEnv: "OPENAI_API_KEY",
  },
  anthropic: {
    provider: "anthropic",
    displayName: "Anthropic / Claude",
    protocol: "anthropic-messages",
    defaultModel: "claude-sonnet-4-5",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultApiKeyEnv: "ANTHROPIC_API_KEY",
  },
  xai: {
    provider: "xai",
    displayName: "xAI / Grok",
    protocol: "openai-chat",
    defaultModel: "grok-4.3",
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultApiKeyEnv: "XAI_API_KEY",
  },
  ovhcloud: {
    provider: "ovhcloud",
    displayName: "OVHcloud AI Endpoints",
    protocol: "openai-chat",
    defaultModel: "Meta-Llama-3_3-70B-Instruct",
    defaultBaseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    defaultApiKeyEnv: "OVHCLOUD_API_KEY",
    alternateApiKeyEnvs: ["AI_ENDPOINT_API_KEY"],
    freeFallbackCandidate: true,
    requiresApiKey: false,
  },
  gemini: {
    provider: "gemini",
    displayName: "Google Gemini",
    protocol: "gemini-generate-content",
    defaultModel: "gemini-2.5-flash",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultApiKeyEnv: "GEMINI_API_KEY",
    alternateApiKeyEnvs: ["GOOGLE_API_KEY"],
    freeFallbackCandidate: true,
  },
  openrouter: {
    provider: "openrouter",
    displayName: "OpenRouter",
    protocol: "openai-chat",
    defaultModel: "openrouter/free",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultApiKeyEnv: "OPENROUTER_API_KEY",
    freeFallbackCandidate: true,
  },
  groq: {
    provider: "groq",
    displayName: "GroqCloud",
    protocol: "openai-chat",
    defaultModel: "llama-3.1-8b-instant",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    defaultApiKeyEnv: "GROQ_API_KEY",
    freeFallbackCandidate: true,
  },
  huggingface: {
    provider: "huggingface",
    displayName: "Hugging Face Inference Providers",
    protocol: "openai-chat",
    defaultModel: "deepseek-ai/DeepSeek-R1:fastest",
    defaultBaseUrl: "https://router.huggingface.co/v1",
    defaultApiKeyEnv: "HF_TOKEN",
    alternateApiKeyEnvs: ["HUGGINGFACE_API_KEY"],
    freeFallbackCandidate: true,
  },
  pollinations: {
    provider: "pollinations",
    displayName: "Pollinations",
    protocol: "openai-chat",
    defaultModel: "openai",
    defaultBaseUrl: "https://gen.pollinations.ai/v1",
    defaultApiKeyEnv: "POLLINATIONS_API_KEY",
    freeFallbackCandidate: true,
  },
  "custom-openai": {
    provider: "custom-openai",
    displayName: "Custom OpenAI-compatible API",
    protocol: "openai-chat",
    defaultModel: "",
    defaultBaseUrl: "",
    defaultApiKeyEnv: "CUSTOM_LLM_API_KEY",
    alternateApiKeyEnvs: ["LLM_API_KEY"],
  },
  "codex-oauth": {
    provider: "codex-oauth",
    displayName: "OpenAI Codex OAuth / ChatGPT",
    protocol: "codex-exec",
    defaultModel: "default",
    defaultBaseUrl: "codex://local",
    defaultApiKeyEnv: "",
    requiresApiKey: false,
  },
};

function stateDir(): string {
  return resolve(process.env.QUOTE_TRADE_STATE_DIR ?? ".quote-trade");
}

function now(): number {
  return Date.now();
}

function owner(ownerId?: string): string {
  return String(ownerId || "default");
}

function env(name?: string): string | undefined {
  const value = name ? process.env[name] : undefined;
  return value && String(value).trim() ? String(value).trim() : undefined;
}

function providerPrefix(provider: LlmProviderId): string {
  return provider.toUpperCase().replace(/-/g, "_");
}

export function redactedSecret(value?: string): string {
  if (!value) return "not set";
  const text = String(value);
  return text.length <= 8 ? "••••" : `${text.slice(0, 4)}…${text.slice(-4)}`;
}

export function normalizeLlmProvider(raw: string): LlmProviderId {
  const provider = String(raw ?? "").trim().toLowerCase();
  if (provider === "chatgpt" || provider === "gpt") return "openai";
  if (provider === "claude") return "anthropic";
  if (provider === "grok") return "xai";
  if (provider === "google") return "gemini";
  if (provider === "ovh" || provider === "ovh-cloud" || provider === "ovhcloud-ai") return "ovhcloud";
  if (provider === "hf") return "huggingface";
  if (provider === "pollinations-ai") return "pollinations";
  if (provider === "custom" || provider === "openai-compatible") return "custom-openai";
  if (["codex", "openai-codex", "chatgpt-pro", "chatgpt-codex", "gpt-pro"].includes(provider)) return "codex-oauth";
  if (Object.prototype.hasOwnProperty.call(LLM_PROVIDER_DEFAULTS, provider)) return provider as LlmProviderId;
  throw new Error(`Unsupported LLM provider: ${raw}`);
}

function providerDefaults(provider: string): LlmProviderDefaults {
  return LLM_PROVIDER_DEFAULTS[normalizeLlmProvider(provider)];
}

function resolveKey(connection: LlmConnection): { key?: string; source?: "stored" | "env" } {
  if (connection.apiKeyEncrypted) {
    try { return { key: decryptSecret(connection.apiKeyEncrypted), source: "stored" }; }
    catch { /* Continue to env fallback if the local encryption key was rotated. */ }
  }
  if (connection.apiKey) return { key: connection.apiKey, source: "stored" };
  const defaults = providerDefaults(connection.provider);
  const envs = [connection.apiKeyEnv, defaults.defaultApiKeyEnv, ...(defaults.alternateApiKeyEnvs ?? [])].filter(Boolean) as string[];
  for (const name of envs) {
    const key = env(name);
    if (key) return { key, source: "env" };
  }
  return {};
}

function requiresApiKey(provider: LlmProviderId): boolean {
  return LLM_PROVIDER_DEFAULTS[provider].requiresApiKey !== false;
}

function canUseConnection(connection: ResolvedLlmConnection): boolean {
  if (connection.provider === "codex-oauth") return hasCodexOAuthSession(connection.ownerId);
  return !requiresApiKey(connection.provider) || !!connection.effectiveApiKey;
}

interface LlmConfigFile {
  version: 1;
  defaultsByOwner: Record<string, LlmProviderId>;
  fallbackOrder: LlmProviderId[];
  connections: LlmConnection[];
}

export class LlmConfigStore {
  constructor(private readonly file = join(stateDir(), "llm-config.json")) {}

  load(): LlmConfigFile {
    if (!existsSync(this.file)) return this.empty();
    const parsed = JSON.parse(readFileSync(this.file, "utf8"));
    const rawConnections = Array.isArray(parsed.connections) ? parsed.connections : [];
    const config = {
      version: 1 as const,
      defaultsByOwner: parsed.defaultsByOwner ?? {},
      fallbackOrder: Array.isArray(parsed.fallbackOrder) ? parsed.fallbackOrder.map(normalizeLlmProvider) : FREE_FALLBACK_ORDER,
      connections: rawConnections.map((raw: any) => this.clean(raw)).filter(Boolean) as LlmConnection[],
    };
    if (rawConnections.some((raw: any) => raw?.apiKey && !raw?.apiKeyEncrypted)) this.save(config);
    return config;
  }

  save(config: LlmConfigFile): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(this.file), 0o700); } catch { /* best effort on non-POSIX filesystems */ }
    const tempFile = `${this.file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tempFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    renameSync(tempFile, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
  }

  setConnection(input: LlmConnectionInput): LlmConnection {
    const provider = normalizeLlmProvider(input.provider);
    const defaults = providerDefaults(provider);
    const config = this.load();
    const ownerId = owner(input.ownerId);
    const old = config.connections.find((existing) => existing.ownerId === ownerId && existing.provider === provider);
    const connection: LlmConnection = {
      ownerId,
      provider,
      model: String(input.model ?? old?.model ?? defaults.defaultModel).trim(),
      apiKeyEncrypted: input.apiKey !== undefined ? encryptSecret(String(input.apiKey).trim()) : input.apiKeyEnv !== undefined ? undefined : old?.apiKeyEncrypted,
      apiKeyEnv: input.apiKeyEnv !== undefined ? String(input.apiKeyEnv).trim() : old?.apiKeyEnv ?? defaults.defaultApiKeyEnv,
      baseUrl: input.baseUrl !== undefined ? String(input.baseUrl).trim().replace(/\/$/, "") : old?.baseUrl ?? defaults.defaultBaseUrl,
      enabled: input.enabled ?? old?.enabled ?? true,
      useAsFallback: input.useAsFallback ?? old?.useAsFallback ?? !!defaults.freeFallbackCandidate,
      createdAt: old?.createdAt ?? now(),
      updatedAt: now(),
    };

    if (connection.provider === "custom-openai" && !connection.baseUrl) throw new Error("custom-openai requires --base-url");
    if (!connection.model) throw new Error(`${provider} requires a model`);

    config.connections = config.connections.filter((item) => !(item.ownerId === ownerId && item.provider === provider));
    config.connections.push(connection);
    if (input.makeDefault || !config.defaultsByOwner[ownerId]) config.defaultsByOwner[ownerId] = provider;
    this.save(config);
    return connection;
  }

  listRows(ownerId?: string): LlmProviderListRow[] {
    const actualOwner = owner(ownerId);
    const config = this.load();
    const rows: LlmProviderListRow[] = [];
    const seen = new Set<LlmProviderId>();

    for (const connection of config.connections.filter((item) => item.ownerId === actualOwner)) {
      const resolved = this.resolveConnection(connection);
      const isCodex = connection.provider === "codex-oauth";
      const codexConnected = isCodex && hasCodexOAuthSession(actualOwner);
      const anonymous = !isCodex && !resolved.effectiveApiKey && !requiresApiKey(connection.provider);
      rows.push({
        provider: connection.provider,
        displayName: providerDefaults(connection.provider).displayName,
        model: connection.model,
        baseUrl: resolved.effectiveBaseUrl,
        key: isCodex ? (codexConnected ? "oauth:connected" : "run /codexconnect") : resolved.effectiveApiKey ? `${resolved.keySource}:${redactedSecret(resolved.effectiveApiKey)}` : anonymous ? "anonymous/free-tier" : "missing",
        source: isCodex ? (codexConnected ? "oauth" : "missing") : resolved.effectiveApiKey ? resolved.source : anonymous ? "anonymous" : "missing",
        enabled: connection.enabled && (codexConnected || anonymous || !!resolved.effectiveApiKey),
        default: config.defaultsByOwner[actualOwner] === connection.provider,
        fallback: connection.useAsFallback,
      });
      seen.add(connection.provider);
    }

    for (const provider of Object.keys(LLM_PROVIDER_DEFAULTS) as LlmProviderId[]) {
      if (seen.has(provider)) continue;
      const defaults = providerDefaults(provider);
      const key = this.envKey(defaults);
      const isCodex = provider === "codex-oauth";
      const codexConnected = isCodex && hasCodexOAuthSession(actualOwner);
      rows.push({
        provider,
        displayName: defaults.displayName,
        model: defaults.defaultModel || "(set model)",
        baseUrl: defaults.defaultBaseUrl || "(set base URL)",
        key: isCodex ? (codexConnected ? "oauth:connected" : "run /codexconnect") : key ? `env:${redactedSecret(key)}` : !requiresApiKey(provider) ? "anonymous/free-tier" : `env:${[defaults.defaultApiKeyEnv, ...(defaults.alternateApiKeyEnvs ?? [])].filter(Boolean).join("|")} not set`,
        source: isCodex ? (codexConnected ? "oauth" : "missing") : key ? "env" : !requiresApiKey(provider) ? "anonymous" : "missing",
        enabled: codexConnected || !!key || (!isCodex && !requiresApiKey(provider)),
        default: config.defaultsByOwner[actualOwner] === provider,
        fallback: !!defaults.freeFallbackCandidate,
      });
    }

    return rows;
  }

  resolvePlanConnections(ownerId?: string, provider?: string, allowFallback = true): ResolvedLlmConnection[] {
    const actualOwner = owner(ownerId);
    const config = this.load();
    const order: LlmProviderId[] = [];
    const preferred = provider ? normalizeLlmProvider(provider) : config.defaultsByOwner[actualOwner];

    if (preferred) order.push(preferred);
    if (allowFallback) {
      for (const candidate of config.fallbackOrder ?? FREE_FALLBACK_ORDER) {
        if (!order.includes(candidate)) order.push(candidate);
      }
      for (const connection of config.connections.filter((item) => item.ownerId === actualOwner && item.useAsFallback)) {
        if (!order.includes(connection.provider)) order.push(connection.provider);
      }
    }
    if (!order.length) order.push("openai", "anthropic", "xai", ...FREE_FALLBACK_ORDER);

    return order
      .map((candidate) => this.resolveByProvider(actualOwner, candidate))
      .filter((resolved): resolved is ResolvedLlmConnection => !!resolved && canUseConnection(resolved));
  }

  resolveByProvider(ownerId: string, provider: LlmProviderId): ResolvedLlmConnection | undefined {
    const stored = this.load().connections.find((connection) => connection.ownerId === ownerId && connection.provider === provider && connection.enabled !== false);
    return stored ? this.resolveConnection(stored) : this.envConnection(ownerId, provider);
  }

  resolveConnection(connection: LlmConnection): ResolvedLlmConnection {
    const defaults = providerDefaults(connection.provider);
    const key = resolveKey(connection);
    const baseUrl = connection.baseUrl || defaults.defaultBaseUrl || env(`${providerPrefix(connection.provider)}_BASE_URL`) || "";
    return {
      ...connection,
      displayName: defaults.displayName,
      protocol: defaults.protocol,
      effectiveApiKey: key.key,
      effectiveBaseUrl: baseUrl.replace(/\/$/, ""),
      keySource: key.source,
      freeFallbackCandidate: !!defaults.freeFallbackCandidate,
      source: connection.provider === "codex-oauth" && hasCodexOAuthSession(connection.ownerId) ? "oauth" : "stored",
    };
  }

  private envConnection(ownerId: string, provider: LlmProviderId): ResolvedLlmConnection | undefined {
    const defaults = providerDefaults(provider);
    if (provider === "codex-oauth") {
      if (!hasCodexOAuthSession(ownerId)) return undefined;
      const model = env("CODEX_MODEL") || defaults.defaultModel;
      return {
        ownerId,
        provider,
        model,
        enabled: true,
        useAsFallback: false,
        createdAt: 0,
        updatedAt: 0,
        displayName: defaults.displayName,
        protocol: defaults.protocol,
        effectiveBaseUrl: defaults.defaultBaseUrl,
        freeFallbackCandidate: false,
        source: "oauth",
      };
    }
    const apiKey = this.envKey(defaults);
    const baseUrl = env(`${providerPrefix(provider)}_BASE_URL`) || env("CUSTOM_LLM_BASE_URL") || env("LLM_BASE_URL") || defaults.defaultBaseUrl;
    const model = env(`${providerPrefix(provider)}_MODEL`) || defaults.defaultModel;
    if ((!apiKey && requiresApiKey(provider)) || !model || !baseUrl) return undefined;
    return {
      ownerId,
      provider,
      model,
      apiKeyEnv: defaults.defaultApiKeyEnv,
      enabled: true,
      useAsFallback: !!defaults.freeFallbackCandidate,
      createdAt: 0,
      updatedAt: 0,
      displayName: defaults.displayName,
      protocol: defaults.protocol,
      effectiveApiKey: apiKey,
      effectiveBaseUrl: baseUrl.replace(/\/$/, ""),
      keySource: apiKey ? "env" : undefined,
      freeFallbackCandidate: !!defaults.freeFallbackCandidate,
      source: apiKey ? "env" : "anonymous",
    };
  }

  private clean(raw: any): LlmConnection | undefined {
    try {
      const provider = normalizeLlmProvider(raw.provider);
      const defaults = providerDefaults(provider);
      return {
        ownerId: owner(raw.ownerId),
        provider,
        model: String(raw.model ?? defaults.defaultModel).trim(),
        apiKeyEncrypted: raw.apiKeyEncrypted ? String(raw.apiKeyEncrypted) : raw.apiKey ? encryptSecret(String(raw.apiKey).trim()) : undefined,
        apiKeyEnv: raw.apiKeyEnv ? String(raw.apiKeyEnv).trim() : defaults.defaultApiKeyEnv,
        baseUrl: raw.baseUrl ? String(raw.baseUrl).trim().replace(/\/$/, "") : defaults.defaultBaseUrl,
        enabled: raw.enabled !== false,
        useAsFallback: raw.useAsFallback ?? !!defaults.freeFallbackCandidate,
        createdAt: Number(raw.createdAt) || now(),
        updatedAt: Number(raw.updatedAt) || now(),
      };
    } catch {
      return undefined;
    }
  }

  private envKey(defaults: LlmProviderDefaults): string | undefined {
    for (const name of [defaults.defaultApiKeyEnv, ...(defaults.alternateApiKeyEnvs ?? [])]) {
      const key = env(name);
      if (key) return key;
    }
    return undefined;
  }

  private empty(): LlmConfigFile {
    return { version: 1, defaultsByOwner: {}, fallbackOrder: FREE_FALLBACK_ORDER, connections: [] };
  }
}

export type LlmDraftStatus = "PENDING" | "CONFIRMING" | "CONFIRMED" | "CANCELLED" | "REJECTED";

export interface LlmDraft {
  id: string;
  ownerId: string;
  prompt: string;
  provider: string;
  model: string;
  format: PlanCommandFormat;
  summary: string;
  commands: string[];
  riskNotes: string[];
  status: LlmDraftStatus;
  createdAt: number;
  updatedAt: number;
}

export function isLlmDraftExpired(draft: Pick<LlmDraft, "createdAt">, maxAgeMs: number, nowMs = now()): boolean {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return false;
  const createdAt = Number(draft.createdAt);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return true;
  return nowMs - createdAt > maxAgeMs;
}

interface DraftFile {
  version: 1;
  drafts: LlmDraft[];
}

export class LlmDraftStore {
  constructor(private readonly file = join(stateDir(), "llm-drafts.json")) {}

  add(input: Omit<LlmDraft, "id" | "status" | "createdAt" | "updatedAt">): LlmDraft {
    const data = this.load();
    const draft: LlmDraft = {
      ...input,
      ownerId: owner(input.ownerId),
      id: `llm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      commands: input.commands.map((command) => String(command).trim()).filter(Boolean),
      riskNotes: input.riskNotes.map(String),
      status: "PENDING",
      createdAt: now(),
      updatedAt: now(),
    };
    data.drafts.push(draft);
    this.save(data);
    return draft;
  }

  get(id: string, ownerId?: string): LlmDraft | undefined {
    const actualOwner = owner(ownerId);
    return this.load().drafts.find((draft) => draft.id === id && draft.ownerId === actualOwner);
  }

  claimPending(id: string, ownerId?: string, maxAgeMs = 0): LlmDraft {
    const data = this.load();
    const actualOwner = owner(ownerId);
    const draft = data.drafts.find((item) => item.id === id && item.ownerId === actualOwner);
    if (!draft) throw new Error(`No LLM draft found: ${id}`);
    if (draft.status !== "PENDING") throw new Error(`Draft ${id} is ${draft.status}, not PENDING`);
    const current = now();
    if (maxAgeMs > 0 && current - draft.createdAt > maxAgeMs) {
      draft.status = "REJECTED";
      draft.updatedAt = current;
      this.save(data);
      throw new Error(`Draft ${id} expired. Re-run /llmstrategy to create a fresh draft.`);
    }
    draft.status = "CONFIRMING";
    draft.updatedAt = current;
    this.save(data);
    return { ...draft, commands: [...draft.commands], riskNotes: [...draft.riskNotes] };
  }

  list(ownerId?: string, includeAll = false): LlmDraft[] {
    const actualOwner = owner(ownerId);
    return this.load().drafts.filter((draft) => draft.ownerId === actualOwner && (includeAll || draft.status === "PENDING"));
  }

  mark(id: string, status: LlmDraftStatus, ownerId?: string): LlmDraft {
    const data = this.load();
    const actualOwner = owner(ownerId);
    const draft = data.drafts.find((item) => item.id === id && item.ownerId === actualOwner);
    if (!draft) throw new Error(`No LLM draft found: ${id}`);
    draft.status = status;
    draft.updatedAt = now();
    this.save(data);
    return draft;
  }

  private load(): DraftFile {
    if (!existsSync(this.file)) return { version: 1, drafts: [] };
    const parsed = JSON.parse(readFileSync(this.file, "utf8"));
    return { version: 1, drafts: Array.isArray(parsed.drafts) ? parsed.drafts : [] };
  }

  private save(data: DraftFile): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(this.file), 0o700); } catch { /* best effort on non-POSIX filesystems */ }
    const tempFile = `${this.file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tempFile, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tempFile, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
  }
}

export function formatLlmProviderRows(rows: LlmProviderListRow[]): string {
  if (!rows.length) return "No LLM providers configured.";
  return rows
    .map((row) => `${row.default ? "*" : " "} ${row.provider.padEnd(13)} ${row.enabled ? "enabled" : "missing"} model=${row.model} key=${row.key}${row.fallback ? " fallback" : ""}`)
    .join("\n");
}

export function formatDraft(draft: LlmDraft): string {
  const commandText = draft.commands.length ? draft.commands.map((command, index) => `${index + 1}. ${command}`).join("\n") : "No executable commands proposed.";
  const notes = draft.riskNotes.length ? `\nRisk notes:\n- ${draft.riskNotes.join("\n- ")}` : "";
  return [`Draft ${draft.id} (${draft.status})`, `Provider: ${draft.provider} / ${draft.model}`, `Summary: ${draft.summary}`, "Commands:", commandText, notes].filter(Boolean).join("\n");
}

export function escapeTelegramHtml(value: unknown): string {
  return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
}

function orderWord(count: number): string {
  return count === 1 ? "order" : "orders";
}

export function confirmOrderButtonText(commandCount: number): string {
  return commandCount === 1 ? "✅ Confirm Order" : "✅ Confirm Orders";
}

export function formatDraftForTelegramHtml(draft: LlmDraft): string {
  const count = draft.commands.length;
  const header = count ? `🧾 Proposed ${orderWord(count)} for review` : "🧾 Strategy draft for review";
  const commandText = count
      ? draft.commands.map((command, index) => {
        const prefix = count > 1 ? `${index + 1}. ` : "";
        return `${prefix}<b>${escapeTelegramHtml(command)}</b>`;
      }).join("\n")
      : "No executable commands proposed.";

  const riskNotes = draft.riskNotes.length
      ? ["", "<b>Risk notes</b>", ...draft.riskNotes.map((note) => `• ${escapeTelegramHtml(note)}`)]
      : [];

  const safetyNotes = count ? [
    "",
    "<b>Before confirming</b>",
    "• The bot will validate the exact command text above.",
    "• Confirmation creates the local order/trigger setup for your Telegram user only.",
    "• BUY checks executable ASK depth; SELL checks executable BID depth.",
  ] : [];

  return [
    `<b>${header}</b>`,
    `ID: <code>${escapeTelegramHtml(draft.id)}</code>`,
    `Provider: ${escapeTelegramHtml(draft.provider)} / ${escapeTelegramHtml(draft.model)}`,
    "",
    "<b>Trade</b>",
    commandText,
    "",
    `<b>Summary</b>: ${escapeTelegramHtml(draft.summary)}`,
    ...riskNotes,
    ...safetyNotes,
    "",
    `Confirm with <code>/llmconfirm ${escapeTelegramHtml(draft.id)}</code> or tap the button below.`,
  ].filter((line) => line !== undefined && line !== null).join("\n");
}

export interface ParsedPlanAction {
  action: "add" | "oco";
  description: string;
  inputs: TriggerInput[];
  symbols: string[];
}

export interface PlanCommandParseContext {
  ownerId?: string;
  defaultPaymentCurrency?: string;
  format?: PlanCommandFormat;
  resolveCloseSide?: (symbol: string) => "BUY" | "SELL" | undefined;
  now?: number;
}

interface CliCommand {
  command: string;
  opts: Record<string, string | true>;
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined;
  let escaped = false;

  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  if (escaped) current += "\\";
  if (quote) throw new Error("Unterminated quote in command");
  if (current) tokens.push(current);
  return tokens;
}

function cleanCommandLine(line: string): string {
  return String(line ?? "")
    .trim()
    .replace(/^```(?:bash|sh|text)?/i, "")
    .replace(/```$/i, "")
    .replace(/^[-*]\s+/, "")
    .trim();
}

function parseCliCommand(line: string): CliCommand {
  const rawTokens = tokenize(line);
  const commandIndex = rawTokens.findIndex((token) => token.startsWith("trigger:"));
  const tokens = commandIndex >= 0 ? rawTokens.slice(commandIndex) : rawTokens;
  if (!tokens.length) throw new Error("Empty command line");

  const [command, ...rest] = tokens;
  const opts: Record<string, string | true> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected positional token in ${command}: ${token}`);

    const equalIndex = token.indexOf("=");
    if (equalIndex > 2) {
      opts[token.slice(2, equalIndex)] = token.slice(equalIndex + 1);
      continue;
    }

    const name = token.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      opts[name] = next;
      index += 1;
    } else {
      opts[name] = true;
    }
  }
  return { command: command.toLowerCase(), opts };
}

function assertAllowedOptions(command: string, opts: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const option of Object.keys(opts)) {
    if (!allowedSet.has(option)) throw new Error(`Unsupported option for ${command}: --${option}`);
  }
}

function optionString(opts: Record<string, string | true>, name: string): string | undefined {
  const value = opts[name];
  if (value === undefined || value === true) return undefined;
  return String(value);
}

function optionFlag(opts: Record<string, string | true>, name: string): boolean {
  const value = opts[name];
  return value === true || String(value).toLowerCase() === "true";
}

function numberOption(opts: Record<string, string | true>, name: string): number | undefined {
  const value = optionString(opts, name);
  return value === undefined ? undefined : positiveNumber(value, name);
}

function requiredString(opts: Record<string, string | true>, name: string): string {
  const value = optionString(opts, name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function requiredNumber(opts: Record<string, string | true>, name: string): number {
  return positiveNumber(requiredString(opts, name), name);
}

function positiveNumber(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

function percentage(value: unknown, name: string): number {
  const raw = String(value).replace(/%$/, "");
  const n = positiveNumber(raw, name);
  if (n > 100) throw new Error(`${name} must be <= 100`);
  return n;
}

function paymentCurrency(ctx: PlanCommandParseContext, opts?: Record<string, string | true>): string {
  return optionString(opts ?? {}, "payment-currency") ?? ctx.defaultPaymentCurrency ?? process.env.DEFAULT_PAYMENT_CURRENCY ?? "USD";
}

function closeSide(ctx: PlanCommandParseContext, symbol: string, explicitSide?: string): "BUY" | "SELL" {
  return explicitSide ? normalizeSide(explicitSide) : ctx.resolveCloseSide?.(symbol) ?? "SELL";
}

function baseInput(ctx: PlanCommandParseContext, kind: TriggerInput["kind"], symbol: string, side: string, opts?: Record<string, string | true>): TriggerInput {
  return {
    ownerId: owner(ctx.ownerId),
    kind,
    symbol: normalizeSymbol(symbol),
    side: normalizeSide(side),
    paymentCurrency: paymentCurrency(ctx, opts),
  };
}

function sizingFromOptions(opts: Record<string, string | true>, requireSize = true): Pick<TriggerInput, "quantity" | "closePosition" | "closePercentage" | "reduceOnly"> {
  const out: Pick<TriggerInput, "quantity" | "closePosition" | "closePercentage" | "reduceOnly"> = {};
  if (opts.quantity !== undefined) out.quantity = requiredNumber(opts, "quantity");
  if (optionFlag(opts, "close-position")) out.closePosition = true;
  if (opts["close-percentage"] !== undefined) out.closePercentage = percentage(requiredString(opts, "close-percentage"), "close-percentage");
  if (optionFlag(opts, "reduce-only")) out.reduceOnly = true;

  if (requireSize && out.quantity === undefined && !out.closePosition && out.closePercentage === undefined) {
    throw new Error("Order-submitting LLM commands must include an explicit size: --quantity, --close-position, or --close-percentage");
  }
  return out;
}

function sizingFromWord(raw: string | undefined, requireSize = true): Pick<TriggerInput, "quantity" | "closePosition" | "closePercentage"> {
  if (!raw) {
    if (requireSize) throw new Error("Order-submitting LLM commands must include an explicit size: quantity, close, or percent");
    return {};
  }
  const lowered = raw.toLowerCase();
  if (["close", "all", "position", "close-position"].includes(lowered)) return { closePosition: true };
  if (raw.endsWith("%")) return { closePercentage: percentage(raw, "percent") };
  return { quantity: positiveNumber(raw, "quantity") };
}

function assertNoForbiddenSource(cleaned: string): void {
  const tokens = tokenize(cleaned).map((token) => token.toLowerCase());
  if (tokens.includes("--source") || tokens.includes("last") || tokens.includes("mid") || tokens.includes("mark")) {
    throw new Error("LLM commands must not select last/mid/mark trigger sources; triggers use side-specific L2 depth by default");
  }
}

function cliAction(parsed: CliCommand, ctx: PlanCommandParseContext): ParsedPlanAction {
  const { command, opts } = parsed;
  const common = ["symbol", "side", "quantity", "close-position", "close-percentage", "payment-currency", "account", "reduce-only"];

  switch (command) {
    case "trigger:limit": {
      assertAllowedOptions(command, opts, [...common, "price"]);
      const symbol = normalizeSymbol(requiredString(opts, "symbol"));
      return {
        action: "add",
        description: "limit trigger",
        inputs: [{ ...baseInput(ctx, "LIMIT", symbol, requiredString(opts, "side"), opts), triggerPrice: requiredNumber(opts, "price"), ...sizingFromOptions(opts) }],
        symbols: [symbol],
      };
    }
    case "trigger:stop-limit": {
      assertAllowedOptions(command, opts, [...common, "stop", "limit"]);
      const symbol = normalizeSymbol(requiredString(opts, "symbol"));
      return {
        action: "add",
        description: "stop-limit trigger",
        inputs: [{ ...baseInput(ctx, "STOP_LIMIT", symbol, requiredString(opts, "side"), opts), triggerPrice: requiredNumber(opts, "stop"), limitPrice: requiredNumber(opts, "limit"), ...sizingFromOptions(opts) }],
        symbols: [symbol],
      };
    }
    case "trigger:take-profit":
    case "trigger:stop-loss": {
      assertAllowedOptions(command, opts, [...common, "price", "limit"]);
      const symbol = normalizeSymbol(requiredString(opts, "symbol"));
      const kind = command.endsWith("take-profit") ? "TAKE_PROFIT" : "STOP_LOSS";
      return {
        action: "add",
        description: `${kind.toLowerCase()} trigger`,
        inputs: [{ ...baseInput(ctx, kind, symbol, closeSide(ctx, symbol, optionString(opts, "side")), opts), triggerPrice: requiredNumber(opts, "price"), limitPrice: numberOption(opts, "limit"), ...sizingFromOptions(opts) }],
        symbols: [symbol],
      };
    }
    case "trigger:trailing-stop":
    case "trigger:trailing-stop-limit": {
      const isLimit = command.endsWith("limit");
      assertAllowedOptions(command, opts, [...common, "trail", "limit-offset"]);
      const symbol = normalizeSymbol(requiredString(opts, "symbol"));
      const trail = parseAmountOrPercent(requiredString(opts, "trail"));
      return {
        action: "add",
        description: `${isLimit ? "trailing stop-limit" : "trailing stop"} trigger`,
        inputs: [{
          ...baseInput(ctx, isLimit ? "TRAILING_STOP_LIMIT" : "TRAILING_STOP", symbol, closeSide(ctx, symbol, optionString(opts, "side")), opts),
          trailMode: trail.mode,
          trailValue: trail.value,
          limitOffset: numberOption(opts, "limit-offset"),
          ...sizingFromOptions(opts),
        }],
        symbols: [symbol],
      };
    }
    case "trigger:oco": {
      assertAllowedOptions(command, opts, [...common, "take-profit", "stop-loss", "stop-limit"]);
      const symbol = normalizeSymbol(requiredString(opts, "symbol"));
      const side = closeSide(ctx, symbol, optionString(opts, "side"));
      const sizing = sizingFromOptions(opts);
      const first = { ...baseInput(ctx, "TAKE_PROFIT", symbol, side, opts), triggerPrice: requiredNumber(opts, "take-profit"), ...sizing };
      const secondKind: TriggerInput["kind"] = opts["stop-limit"] !== undefined ? "STOP_LIMIT" : "STOP_LOSS";
      const second = { ...baseInput(ctx, secondKind, symbol, side, opts), triggerPrice: requiredNumber(opts, "stop-loss"), limitPrice: numberOption(opts, "stop-limit"), ...sizing };
      return { action: "oco", description: "oco trigger pair", inputs: [first, second], symbols: [symbol] };
    }
    case "trigger:bracket": {
      assertAllowedOptions(command, opts, ["symbol", "side", "entry", "quantity", "take-profit", "stop-loss", "stop-limit", "payment-currency", "exits-close-position"]);
      const symbol = normalizeSymbol(requiredString(opts, "symbol"));
      const quantity = requiredNumber(opts, "quantity");
      return {
        action: "add",
        description: "bracket entry trigger",
        inputs: [{
          ...baseInput(ctx, "LIMIT", symbol, requiredString(opts, "side"), opts),
          triggerPrice: requiredNumber(opts, "entry"),
          quantity,
          meta: {
            bracket: {
              takeProfitPrice: requiredNumber(opts, "take-profit"),
              stopLossPrice: requiredNumber(opts, "stop-loss"),
              stopLimitPrice: numberOption(opts, "stop-limit"),
              useClosePosition: optionFlag(opts, "exits-close-position"),
            },
          },
        }],
        symbols: [symbol],
      };
    }
    case "trigger:scale-out": {
      assertAllowedOptions(command, opts, ["symbol", "side", "price", "percent", "limit", "payment-currency"]);
      const symbol = normalizeSymbol(requiredString(opts, "symbol"));
      return {
        action: "add",
        description: "scale-out take-profit trigger",
        inputs: [{ ...baseInput(ctx, "TAKE_PROFIT", symbol, closeSide(ctx, symbol, optionString(opts, "side")), opts), triggerPrice: requiredNumber(opts, "price"), limitPrice: numberOption(opts, "limit"), closePercentage: percentage(requiredString(opts, "percent"), "percent"), reduceOnly: true, meta: { strategy: "SCALE_OUT" } }],
        symbols: [symbol],
      };
    }
    case "trigger:break-even": {
      assertAllowedOptions(command, opts, [...common, "after", "plus", "limit"]);
      const symbol = normalizeSymbol(requiredString(opts, "symbol"));
      const after = parseAmountOrPercent(requiredString(opts, "after"));
      const plus = opts.plus !== undefined ? parseAmountOrPercent(requiredString(opts, "plus")) : { mode: "AMOUNT" as const, value: 0 };
      return {
        action: "add",
        description: "break-even stop trigger",
        inputs: [{ ...baseInput(ctx, "BREAK_EVEN_STOP", symbol, closeSide(ctx, symbol, optionString(opts, "side")), opts), activationMode: after.mode, activationValue: after.value, lockMode: plus.mode, lockValue: plus.value, limitPrice: numberOption(opts, "limit"), ...sizingFromOptions(opts) }],
        symbols: [symbol],
      };
    }
    case "trigger:close-after":
    case "trigger:close-at": {
      assertAllowedOptions(command, opts, [...common, "after", "at", "limit"]);
      const symbol = normalizeSymbol(requiredString(opts, "symbol"));
      const time = command.endsWith("after") ? requiredString(opts, "after") : requiredString(opts, "at");
      const sizing = { closePosition: true, reduceOnly: true, ...sizingFromOptions(opts, false) };
      return {
        action: "add",
        description: "time close trigger",
        inputs: [{ ...baseInput(ctx, "TIME_CLOSE", symbol, closeSide(ctx, symbol, optionString(opts, "side")), opts), triggerAt: parseTimeOrDuration(time, ctx.now), limitPrice: numberOption(opts, "limit"), ...sizing }],
        symbols: [symbol],
      };
    }
    case "trigger:cancel-after": {
      assertAllowedOptions(command, opts, ["id", "after", "payment-currency"]);
      return {
        action: "add",
        description: "time cancel trigger",
        inputs: [{ ...baseInput(ctx, "TIME_CANCEL", "GLOBAL", "SELL", opts), triggerAt: parseTimeOrDuration(requiredString(opts, "after"), ctx.now), cancelTriggerId: requiredString(opts, "id") }],
        symbols: [],
      };
    }
    case "trigger:price-band": {
      assertAllowedOptions(command, opts, [...common, "mode", "upper", "lower", "limit"]);
      const symbol = normalizeSymbol(requiredString(opts, "symbol"));
      const mode = String(requiredString(opts, "mode")).toUpperCase().replace(/-/g, "_") as PriceBandMode;
      if (mode !== "BREAKOUT" && mode !== "REVERSION") throw new Error("--mode must be BREAKOUT or REVERSION");
      if (opts.upper === undefined && opts.lower === undefined) throw new Error("price-band requires --upper or --lower");
      return {
        action: "add",
        description: "price-band trigger",
        inputs: [{ ...baseInput(ctx, "PRICE_BAND", symbol, requiredString(opts, "side"), opts), priceBandMode: mode, upperPrice: numberOption(opts, "upper"), lowerPrice: numberOption(opts, "lower"), limitPrice: numberOption(opts, "limit"), ...sizingFromOptions(opts) }],
        symbols: [symbol],
      };
    }
    case "trigger:risk-guard": {
      assertAllowedOptions(command, opts, ["symbol", "metric", "threshold", "action", "side", "limit", "quantity", "close-position", "payment-currency"]);
      const symbol = normalizeSymbol(requiredString(opts, "symbol"));
      const action = String(optionString(opts, "action") ?? "ALERT").toUpperCase().replace(/-/g, "_") as RiskAction;
      const sizing = action === "CLOSE_POSITION" ? { closePosition: true, reduceOnly: true, ...sizingFromOptions(opts, false) } : sizingFromOptions(opts, false);
      return {
        action: "add",
        description: "risk guard trigger",
        inputs: [{ ...baseInput(ctx, "RISK_GUARD", symbol, closeSide(ctx, symbol, optionString(opts, "side")), opts), riskMetric: String(requiredString(opts, "metric")).toUpperCase().replace(/-/g, "_") as RiskMetric, riskThreshold: requiredNumber(opts, "threshold"), riskAction: action, limitPrice: numberOption(opts, "limit"), ...sizing }],
        symbols: [symbol],
      };
    }
    default:
      throw new Error(`Unsupported CLI command: ${command}`);
  }
}

function slashAction(line: string, ctx: PlanCommandParseContext): ParsedPlanAction {
  const [rawCommand, ...args] = tokenize(line);
  const command = rawCommand.replace(/^\//, "").toLowerCase();

  switch (command) {
    case "limit": {
      if (args.length < 4) throw new Error("/limit requires symbol side price quantity|close|percent");
      const [symbolRaw, sideRaw, priceRaw, qtyRaw] = args;
      const symbol = normalizeSymbol(symbolRaw);
      return { action: "add", description: "limit trigger", inputs: [{ ...baseInput(ctx, "LIMIT", symbol, sideRaw), triggerPrice: positiveNumber(priceRaw, "price"), ...sizingFromWord(qtyRaw) }], symbols: [symbol] };
    }
    case "stoplimit": {
      if (args.length < 5) throw new Error("/stoplimit requires symbol side stop limit quantity|close|percent");
      const [symbolRaw, sideRaw, stopRaw, limitRaw, qtyRaw] = args;
      const symbol = normalizeSymbol(symbolRaw);
      return { action: "add", description: "stop-limit trigger", inputs: [{ ...baseInput(ctx, "STOP_LIMIT", symbol, sideRaw), triggerPrice: positiveNumber(stopRaw, "stop"), limitPrice: positiveNumber(limitRaw, "limit"), ...sizingFromWord(qtyRaw) }], symbols: [symbol] };
    }
    case "takeprofit":
    case "stoploss": {
      if (args.length < 4) throw new Error(`/${command} requires symbol side price quantity|close|percent`);
      const [symbolRaw, sideRaw, priceRaw, qtyRaw] = args;
      const symbol = normalizeSymbol(symbolRaw);
      const kind: TriggerInput["kind"] = command === "takeprofit" ? "TAKE_PROFIT" : "STOP_LOSS";
      return { action: "add", description: `${command} trigger`, inputs: [{ ...baseInput(ctx, kind, symbol, closeSide(ctx, symbol, sideRaw)), triggerPrice: positiveNumber(priceRaw, "price"), ...sizingFromWord(qtyRaw) }], symbols: [symbol] };
    }
    case "trailingstop":
    case "trailingstoplimit": {
      const needs = command === "trailingstoplimit" ? 5 : 4;
      if (args.length < needs) throw new Error(`/${command} requires symbol side trail${command === "trailingstoplimit" ? " offset" : ""} quantity|close|percent`);
      const [symbolRaw, sideRaw, trailRaw, maybeOffset, maybeQty] = args;
      const symbol = normalizeSymbol(symbolRaw);
      const trail = parseAmountOrPercent(trailRaw);
      const isLimit = command === "trailingstoplimit";
      return {
        action: "add",
        description: command,
        inputs: [{ ...baseInput(ctx, isLimit ? "TRAILING_STOP_LIMIT" : "TRAILING_STOP", symbol, closeSide(ctx, symbol, sideRaw)), trailMode: trail.mode, trailValue: trail.value, limitOffset: isLimit ? positiveNumber(maybeOffset, "offset") : undefined, ...sizingFromWord(isLimit ? maybeQty : maybeOffset) }],
        symbols: [symbol],
      };
    }
    case "oco": {
      if (args.length < 5) throw new Error("/oco requires symbol side takeProfit stopLoss quantity|close|percent [stopLimit]");
      const [symbolRaw, sideRaw, takeProfitRaw, stopLossRaw, qtyRaw, stopLimitRaw] = args;
      const symbol = normalizeSymbol(symbolRaw);
      const side = closeSide(ctx, symbol, sideRaw);
      const sizing = sizingFromWord(qtyRaw);
      const first = { ...baseInput(ctx, "TAKE_PROFIT", symbol, side), triggerPrice: positiveNumber(takeProfitRaw, "takeProfit"), ...sizing };
      const secondKind: TriggerInput["kind"] = stopLimitRaw ? "STOP_LIMIT" : "STOP_LOSS";
      const second = { ...baseInput(ctx, secondKind, symbol, side), triggerPrice: positiveNumber(stopLossRaw, "stopLoss"), limitPrice: stopLimitRaw ? positiveNumber(stopLimitRaw, "stopLimit") : undefined, ...sizing };
      return { action: "oco", description: "oco trigger pair", inputs: [first, second], symbols: [symbol] };
    }
    case "bracket": {
      if (args.length < 6) throw new Error("/bracket requires symbol side entry quantity takeProfit stopLoss [stopLimit]");
      const [symbolRaw, sideRaw, entryRaw, qtyRaw, takeProfitRaw, stopLossRaw, stopLimitRaw] = args;
      const symbol = normalizeSymbol(symbolRaw);
      return {
        action: "add",
        description: "bracket entry trigger",
        inputs: [{ ...baseInput(ctx, "LIMIT", symbol, sideRaw), triggerPrice: positiveNumber(entryRaw, "entry"), quantity: positiveNumber(qtyRaw, "quantity"), meta: { bracket: { takeProfitPrice: positiveNumber(takeProfitRaw, "takeProfit"), stopLossPrice: positiveNumber(stopLossRaw, "stopLoss"), stopLimitPrice: stopLimitRaw ? positiveNumber(stopLimitRaw, "stopLimit") : undefined } } }],
        symbols: [symbol],
      };
    }
    case "scaleout": {
      if (args.length < 4) throw new Error("/scaleout requires symbol side price percent");
      const [symbolRaw, sideRaw, priceRaw, percentRaw] = args;
      const symbol = normalizeSymbol(symbolRaw);
      return { action: "add", description: "scale-out trigger", inputs: [{ ...baseInput(ctx, "TAKE_PROFIT", symbol, closeSide(ctx, symbol, sideRaw)), triggerPrice: positiveNumber(priceRaw, "price"), closePercentage: percentage(percentRaw, "percent"), reduceOnly: true, meta: { strategy: "SCALE_OUT" } }], symbols: [symbol] };
    }
    case "breakeven": {
      if (args.length < 3) throw new Error("/breakeven requires symbol side after [plus]");
      const [symbolRaw, sideRaw, afterRaw, plusRaw] = args;
      const symbol = normalizeSymbol(symbolRaw);
      const after = parseAmountOrPercent(afterRaw);
      const plus = plusRaw ? parseAmountOrPercent(plusRaw) : { mode: "AMOUNT" as const, value: 0 };
      return { action: "add", description: "break-even stop", inputs: [{ ...baseInput(ctx, "BREAK_EVEN_STOP", symbol, closeSide(ctx, symbol, sideRaw)), activationMode: after.mode, activationValue: after.value, lockMode: plus.mode, lockValue: plus.value, closePosition: true, reduceOnly: true }], symbols: [symbol] };
    }
    case "closeafter":
    case "closeat": {
      if (args.length < 2) throw new Error(`/${command} requires symbol time`);
      const [symbolRaw, ...timeParts] = args;
      const symbol = normalizeSymbol(symbolRaw);
      return { action: "add", description: "time close trigger", inputs: [{ ...baseInput(ctx, "TIME_CLOSE", symbol, closeSide(ctx, symbol)), triggerAt: parseTimeOrDuration(timeParts.join(" "), ctx.now), closePosition: true, reduceOnly: true }], symbols: [symbol] };
    }
    case "cancelafter": {
      if (args.length < 2) throw new Error("/cancelafter requires trigger-id duration");
      const [idRaw, afterRaw] = args;
      return { action: "add", description: "time cancel trigger", inputs: [{ ...baseInput(ctx, "TIME_CANCEL", "GLOBAL", "SELL"), triggerAt: parseTimeOrDuration(afterRaw, ctx.now), cancelTriggerId: idRaw }], symbols: [] };
    }
    case "priceband": {
      if (args.length < 5) throw new Error("/priceband requires symbol side mode bandPrice quantity|close|percent");
      const [symbolRaw, sideRaw, modeRaw, bandPriceRaw, qtyRaw] = args;
      const symbol = normalizeSymbol(symbolRaw);
      const side = normalizeSide(sideRaw);
      const mode = String(modeRaw).toUpperCase().replace(/-/g, "_") as PriceBandMode;
      const needsUpper = (mode === "BREAKOUT" && side === "BUY") || (mode === "REVERSION" && side === "SELL");
      return { action: "add", description: "price-band trigger", inputs: [{ ...baseInput(ctx, "PRICE_BAND", symbol, side), priceBandMode: mode, upperPrice: needsUpper ? positiveNumber(bandPriceRaw, "upper") : undefined, lowerPrice: needsUpper ? undefined : positiveNumber(bandPriceRaw, "lower"), ...sizingFromWord(qtyRaw) }], symbols: [symbol] };
    }
    case "riskguard": {
      if (args.length < 3) throw new Error("/riskguard requires symbol metric threshold [action]");
      const [symbolRaw, metricRaw, thresholdRaw, actionRaw] = args;
      const symbol = normalizeSymbol(symbolRaw);
      const action = String(actionRaw ?? "ALERT").toUpperCase().replace(/-/g, "_") as RiskAction;
      return { action: "add", description: "risk guard", inputs: [{ ...baseInput(ctx, "RISK_GUARD", symbol, closeSide(ctx, symbol)), riskMetric: String(metricRaw).toUpperCase().replace(/-/g, "_") as RiskMetric, riskThreshold: positiveNumber(thresholdRaw, "threshold"), riskAction: action, closePosition: action === "CLOSE_POSITION", reduceOnly: action === "CLOSE_POSITION" }], symbols: [symbol] };
    }
    case "closelimit": {
      if (args.length < 2) throw new Error("/closelimit requires symbol price");
      const [symbolRaw, priceRaw] = args;
      const symbol = normalizeSymbol(symbolRaw);
      return { action: "add", description: "close limit trigger", inputs: [{ ...baseInput(ctx, "LIMIT", symbol, closeSide(ctx, symbol)), triggerPrice: positiveNumber(priceRaw, "price"), closePosition: true, reduceOnly: true }], symbols: [symbol] };
    }
    case "closestoplimit": {
      if (args.length < 3) throw new Error("/closestoplimit requires symbol stop limit");
      const [symbolRaw, stopRaw, limitRaw] = args;
      const symbol = normalizeSymbol(symbolRaw);
      return { action: "add", description: "close stop-limit trigger", inputs: [{ ...baseInput(ctx, "STOP_LIMIT", symbol, closeSide(ctx, symbol)), triggerPrice: positiveNumber(stopRaw, "stop"), limitPrice: positiveNumber(limitRaw, "limit"), closePosition: true, reduceOnly: true }], symbols: [symbol] };
    }
    default:
      throw new Error(`Unsupported Telegram command: ${command}`);
  }
}

export function parsePlanCommand(line: string, ctx: PlanCommandParseContext = {}): ParsedPlanAction {
  const cleaned = cleanCommandLine(line);
  if (!cleaned) throw new Error("Empty command line");
  assertNoForbiddenSource(cleaned);
  const tokens = tokenize(cleaned);
  if ((ctx.format !== "cli" && tokens[0]?.startsWith("/")) || tokens.some((token) => token.startsWith("/"))) return slashAction(cleaned, ctx);
  return cliAction(parseCliCommand(cleaned), ctx);
}

export function parsePlanCommands(commands: string[], ctx: PlanCommandParseContext = {}): ParsedPlanAction[] {
  if (!Array.isArray(commands) || !commands.length) throw new Error("LLM plan must include at least one command");
  if (commands.length > 12) throw new Error("LLM plan is too large; maximum is 12 commands");
  return commands.map((command) => parsePlanCommand(command, ctx));
}

export interface RawLlmPlan {
  summary?: string;
  commands?: string[];
  riskNotes?: string[];
  [key: string]: unknown;
}

const PLAN_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "commands", "riskNotes"],
  properties: {
    summary: { type: "string" },
    commands: { type: "array", minItems: 0, maxItems: 12, items: { type: "string" } },
    riskNotes: { type: "array", minItems: 0, maxItems: 12, items: { type: "string" } },
  },
};

const GEMINI_PLAN_RESPONSE_SCHEMA = {
  type: "object",
  required: ["summary", "commands", "riskNotes"],
  properties: {
    summary: { type: "string" },
    commands: {
      type: "array",
      minItems: 0,
      maxItems: 12,
      items: { type: "string" },
    },
    riskNotes: {
      type: "array",
      minItems: 0,
      maxItems: 12,
      items: { type: "string" },
    },
  },
};

function parseJsonObject(text: unknown): RawLlmPlan {
  if (typeof text === "object" && text !== null) return text as RawLlmPlan;
  const raw = String(text ?? "").trim();
  if (!raw) throw new Error("LLM returned an empty response");

  const withoutFence = raw.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf("{");
    const end = withoutFence.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(withoutFence.slice(start, end + 1));
    throw new Error("LLM did not return a JSON object");
  }
}

type PostJsonFn = (url: string, body: unknown, options: unknown) => Promise<any>;

async function postJson(url: string, body: unknown, options: unknown): Promise<any> {
  // Lazy require keeps parser/draft tests usable even when axios is not installed in a downstream fork.
  const axios = require("axios");
  return axios.post(url, body, options);
}

export class LlmProviderClient {
  constructor(private readonly post: PostJsonFn = postJson) {}

  async completePlan(connection: ResolvedLlmConnection, request: { systemPrompt: string; userPrompt: string; temperature?: number; maxTokens?: number }): Promise<RawLlmPlan> {
    if (connection.protocol === "codex-exec") return completeCodexOAuthPlan(connection.ownerId, connection.model, request);
    if (!connection.effectiveApiKey && requiresApiKey(connection.provider)) throw new Error(`${connection.provider} API key is not configured`);
    if (connection.protocol === "anthropic-messages") return this.callAnthropic(connection, request);
    if (connection.protocol === "gemini-generate-content") return this.callGemini(connection, request);
    return this.callOpenAiCompatible(connection, request);
  }

  private async callOpenAiCompatible(connection: ResolvedLlmConnection, request: { systemPrompt: string; userPrompt: string; temperature?: number; maxTokens?: number }): Promise<RawLlmPlan> {
    const body: any = {
      model: connection.model,
      messages: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: request.userPrompt },
      ],
      temperature: request.temperature ?? 0.1,
      max_tokens: request.maxTokens ?? 1400,
      response_format: connection.provider === "openai" || connection.provider === "openrouter" || connection.provider === "ovhcloud"
        ? { type: "json_schema", json_schema: { name: "quote_trade_order_plan", strict: true, schema: PLAN_RESPONSE_SCHEMA } }
        : { type: "json_object" },
    };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (connection.effectiveApiKey) headers.Authorization = `Bearer ${connection.effectiveApiKey}`;
    if (connection.provider === "openrouter") headers["X-Title"] = "Quote.Trade local strategy planner";

    const response = await this.post(`${connection.effectiveBaseUrl}/chat/completions`, body, { headers, timeout: 45_000 });
    return parseJsonObject(response.data?.choices?.[0]?.message?.content);
  }

  private async callAnthropic(connection: ResolvedLlmConnection, request: { systemPrompt: string; userPrompt: string; temperature?: number; maxTokens?: number }): Promise<RawLlmPlan> {
    const body = {
      model: connection.model,
      system: request.systemPrompt,
      max_tokens: request.maxTokens ?? 1400,
      temperature: request.temperature ?? 0.1,
      messages: [{ role: "user", content: request.userPrompt }],
      tools: [{
        name: "propose_order_plan",
        description: "Return a proposed Quote.Trade local bot order plan in exact command format.",
        input_schema: PLAN_RESPONSE_SCHEMA,
      }],
      tool_choice: { type: "tool", name: "propose_order_plan" },
    };
    const response = await this.post(`${connection.effectiveBaseUrl}/messages`, body, {
      headers: {
        "x-api-key": connection.effectiveApiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      timeout: 45_000,
    });
    const content = response.data?.content ?? [];
    const toolUse = Array.isArray(content) ? content.find((part: any) => part?.type === "tool_use" && part?.name === "propose_order_plan") : undefined;
    if (toolUse?.input) return parseJsonObject(toolUse.input);
    const text = Array.isArray(content) ? content.map((part: any) => part?.text).filter(Boolean).join("\n") : response.data;
    return parseJsonObject(text);
  }

  private async callGemini(connection: ResolvedLlmConnection, request: { systemPrompt: string; userPrompt: string; temperature?: number; maxTokens?: number }): Promise<RawLlmPlan> {
    const body = {
      systemInstruction: { parts: [{ text: request.systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: request.userPrompt }] }],
      generationConfig: {
        temperature: request.temperature ?? 0.1,
        maxOutputTokens: request.maxTokens ?? 1400,
        responseMimeType: "application/json",
        responseSchema: GEMINI_PLAN_RESPONSE_SCHEMA,
      },
    };
    const response = await this.post(`${connection.effectiveBaseUrl}/models/${encodeURIComponent(connection.model)}:generateContent?key=${encodeURIComponent(connection.effectiveApiKey as string)}`, body, {
      headers: { "Content-Type": "application/json" },
      timeout: 45_000,
    });
    const text = response.data?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text).filter(Boolean).join("\n");
    return parseJsonObject(text);
  }
}

export interface StrategyPlannerInput {
  ownerId?: string;
  prompt: string;
  commandFormat: PlanCommandFormat;
  provider?: string;
  allowFallback?: boolean;
  defaultPaymentCurrency?: string;
  positionsContext?: string;
  riskContext?: string;
  resolveCloseSide?: PlanCommandParseContext["resolveCloseSide"];
  now?: number;
}

export interface ValidatedStrategyPlan {
  provider: string;
  model: string;
  summary: string;
  commands: string[];
  riskNotes: string[];
  actions: ParsedPlanAction[];
  attemptedProviders: string[];
}

function commandExamples(format: PlanCommandFormat): string {
  if (format === "telegram") {
    return [
      "/limit BTC BUY 60000 0.01",
      "/stoplimit BTC SELL 58000 57950 close",
      "/takeprofit BTC SELL 65000 close",
      "/stoploss BTC SELL 58000 close",
      "/trailingstop BTC SELL 5% close",
      "/trailingstoplimit BTC SELL 5% 50 close",
      "/oco BTC SELL 65000 58000 close 57950",
      "/bracket BTC BUY 60000 0.01 65000 58000 57950",
      "/scaleout BTC SELL 63000 25%",
      "/breakeven BTC SELL 3% 0.5%",
      "/closeafter BTC 4h",
      "/priceband BTC BUY BREAKOUT 65000 0.01",
      "/riskguard BTC MAX_RISK_USD 500 ALERT",
      "/closelimit BTC 65000",
      "/closestoplimit BTC 58000 57950",
    ].join("\n");
  }

  return [
    "trigger:limit --symbol BTC --side BUY --price 60000 --quantity 0.01",
    "trigger:stop-limit --symbol BTC --side SELL --stop 58000 --limit 57950 --close-position",
    "trigger:take-profit --symbol BTC --side SELL --price 65000 --close-position",
    "trigger:stop-loss --symbol BTC --side SELL --price 58000 --close-position",
    "trigger:trailing-stop --symbol BTC --side SELL --trail 5% --close-position",
    "trigger:trailing-stop-limit --symbol BTC --side SELL --trail 5% --limit-offset 50 --close-position",
    "trigger:oco --symbol BTC --side SELL --take-profit 65000 --stop-loss 58000 --stop-limit 57950 --close-position",
    "trigger:bracket --symbol BTC --side BUY --entry 60000 --quantity 0.01 --take-profit 65000 --stop-loss 58000 --stop-limit 57950",
    "trigger:scale-out --symbol BTC --side SELL --price 63000 --percent 25",
    "trigger:break-even --symbol BTC --side SELL --after 3% --plus 0.5% --close-position",
    "trigger:close-after --symbol BTC --after 4h --close-position",
    "trigger:price-band --symbol BTC --side BUY --mode BREAKOUT --upper 65000 --quantity 0.01",
    "trigger:risk-guard --symbol BTC --metric MAX_RISK_USD --threshold 500 --action ALERT",
  ].join("\n");
}

function systemPrompt(format: PlanCommandFormat): string {
  const commandKind = format === "telegram" ? "Telegram slash-command" : "CLI trigger-command";
  return [
    "You are a local Quote.Trade bot strategy planner.",
    "You never place orders. You only propose exact commands for the local bot to validate and store as a pending draft.",
    "The user must confirm before anything is created.",
    "Return exactly one JSON object with keys: summary, commands, riskNotes.",
    `commands must be exact ${commandKind} strings.`,
    "Do not include markdown, raw Quote.Trade API JSON, clientOrderId, or trigger metadata.",
    "Every order-submitting command must include side and explicit size: quantity, close-position/close, or percent.",
    "Do not guess missing size.",
    "Do not use last, mid, mark, or --source.",
    "The bot always uses side-specific streaming L2 depth: BUY checks executable ask depth for the requested quantity; SELL checks executable bid depth for the requested quantity.",
    "If the request is ambiguous, return commands: [] and explain in riskNotes.",
  ].join(" ");
}

function userPrompt(input: StrategyPlannerInput): string {
  return [
    "User request:",
    input.prompt,
    "",
    "Current remembered position/risk context:",
    input.positionsContext || "No remembered positions provided.",
    input.riskContext || "",
    "",
    "Allowed command examples:",
    commandExamples(input.commandFormat),
    "",
    "Output JSON only. Unknown commands or ambiguous orders will be rejected locally.",
  ].join("\n");
}

function normalizePlan(raw: RawLlmPlan): { summary: string; commands: string[]; riskNotes: string[] } {
  return {
    summary: String(raw.summary ?? "Proposed local bot commands."),
    commands: Array.isArray(raw.commands) ? raw.commands.map(String).map((command) => command.trim()).filter(Boolean) : [],
    riskNotes: Array.isArray(raw.riskNotes) ? raw.riskNotes.map(String).filter(Boolean) : [],
  };
}

export class LlmStrategyPlanner {
  constructor(
    private readonly configStore: Pick<LlmConfigStore, "resolvePlanConnections">,
    private readonly client: Pick<LlmProviderClient, "completePlan"> = new LlmProviderClient(),
  ) {}

  async plan(input: StrategyPlannerInput): Promise<ValidatedStrategyPlan> {
    const connections = this.configStore.resolvePlanConnections(input.ownerId, input.provider, input.allowFallback !== false);
    if (!connections.length) throw new Error("No LLM provider is configured. Set an API key env var or run llm:connect / /llmconnect first.");

    const attemptedProviders: string[] = [];
    let lastError: any;

    for (const connection of connections) {
      attemptedProviders.push(`${connection.provider}:${connection.model}`);
      try {
        const raw = await this.client.completePlan(connection, {
          systemPrompt: systemPrompt(input.commandFormat),
          userPrompt: userPrompt(input),
          temperature: 0.1,
          maxTokens: 1400,
        });
        const plan = normalizePlan(raw);
        const actions = plan.commands.length
          ? parsePlanCommands(plan.commands, {
              ownerId: input.ownerId,
              defaultPaymentCurrency: input.defaultPaymentCurrency,
              format: input.commandFormat,
              resolveCloseSide: input.resolveCloseSide,
              now: input.now,
            })
          : [];
        return { provider: connection.provider, model: connection.model, summary: plan.summary, commands: plan.commands, riskNotes: plan.riskNotes, actions, attemptedProviders };
      } catch (error: any) {
        lastError = error;

        if (process.env.LLM_DEBUG === "true") {
          console.log("[LLM_PROVIDER_FAILED]", {
            provider: connection.provider,
            model: connection.model,
            message: error?.message,
            status: error?.response?.status,
            responseData: error?.response?.data,
          });
        }
      }
    }

    throw new Error(`All configured LLM providers failed or produced invalid commands. Attempted: ${attemptedProviders.join(", ")}. Last error: ${lastError?.message ?? lastError}`);
  }
}
