import axios from "axios";

export interface TelegramBotOptions {
  polling?: boolean;
  apiBaseUrl?: string;
  pollTimeoutSeconds?: number;
  pollErrorDelayMs?: number;
}

export interface TelegramSendMessageOptions {
  reply_markup?: unknown;
  parse_mode?: string;
  disable_web_page_preview?: boolean;
  [key: string]: unknown;
}

interface TelegramUser {
  id?: string | number;
  [key: string]: unknown;
}

interface TelegramChat {
  id?: string | number;
  type?: string;
  [key: string]: unknown;
}

export interface TelegramMessage {
  message_id?: number;
  date?: number;
  text?: string;
  chat?: TelegramChat;
  from?: TelegramUser;
  [key: string]: unknown;
}

export interface TelegramCallbackQuery {
  id?: string;
  data?: string;
  message?: TelegramMessage;
  from?: TelegramUser;
  [key: string]: unknown;
}

interface TelegramUpdate {
  update_id?: number | string;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  [key: string]: unknown;
}

interface TelegramErrorResponse {
  status?: unknown;
  data?: {
    description?: unknown;
  };
}

type TextHandler = (msg: TelegramMessage, match: RegExpExecArray | null) => void;
type EventHandler = (payload: unknown) => void;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveMs(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function telegramIpFamily(): 4 | 6 {
  return String(process.env.TELEGRAM_IP_FAMILY ?? "4").trim() === "6" ? 6 : 4;
}

function asObject<T extends object>(value: unknown): Partial<T> {
  return typeof value === "object" && value !== null ? (value as Partial<T>) : {};
}

function telegramErrorResponse(error: unknown): TelegramErrorResponse | undefined {
  return asObject<{ response?: TelegramErrorResponse }>(error).response;
}

/**
 * Small Telegram Bot API polling client used to avoid deprecated request-based
 * transitive dependencies. It intentionally implements only the methods this bot
 * needs: onText, callback_query events, sendMessage, and answerCallbackQuery.
 */
export default class TelegramBot {
  private readonly apiBaseUrl: string;
  private readonly textHandlers: Array<{ regex: RegExp; handler: TextHandler }> = [];
  private readonly eventHandlers = new Map<string, EventHandler[]>();
  private offset = 0;
  private stopped = false;
  private pollingStarted = false;

  constructor(
    private readonly token: string,
    private readonly options: TelegramBotOptions = {},
  ) {
    if (!token) throw new Error("Telegram bot token is required");
    this.apiBaseUrl = `${options.apiBaseUrl ?? "https://api.telegram.org"}/bot${token}`;
    if (options.polling) this.startPolling();
  }

  onText(regex: RegExp, handler: TextHandler): void {
    this.textHandlers.push({ regex, handler });
  }

  on(event: string, handler: EventHandler): void {
    const list = this.eventHandlers.get(event) ?? [];
    list.push(handler);
    this.eventHandlers.set(event, list);
  }

  /** Route a trusted UI-generated command through the same handlers as Telegram text. */
  dispatchText(msg: TelegramMessage, text: string): void {
    this.handleMessage({ ...msg, text });
  }

  async sendMessage(chatId: string | number, text: string, options: TelegramSendMessageOptions = {}): Promise<unknown> {
    return this.call("sendMessage", { chat_id: chatId, text, ...options });
  }

  async answerCallbackQuery(callbackQueryId: string, options: Record<string, unknown> = {}): Promise<unknown> {
    return this.call(
      "answerCallbackQuery",
      { callback_query_id: callbackQueryId, ...options },
      positiveMs(process.env.TELEGRAM_CALLBACK_TIMEOUT_MS, 3_000),
    );
  }

  async deleteMessage(chatId: string | number, messageId: string | number): Promise<unknown> {
    // Deleting a sensitive command is best-effort and must never hold up the
    // command itself for the full Telegram request timeout.
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageId }, 3_000);
  }

  stopPolling(): void {
    this.stopped = true;
  }

  /**
   * Open the long-poll loop. Public so an entry point can construct the bot
   * inertly (`polling: false`), register its handlers, and only then connect.
   * Re-entrant callers are ignored, so calling it twice cannot double the loop.
   */
  startPolling(): void {
    if (this.pollingStarted) return;
    this.pollingStarted = true;
    this.stopped = false;
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await this.call("getUpdates", {
          offset: this.offset,
          timeout: this.options.pollTimeoutSeconds ?? 30,
          allowed_updates: ["message", "callback_query"],
        });
        for (const update of Array.isArray(updates) ? updates : []) this.handleUpdate(update);
      } catch (error) {
        this.emit("polling_error", error);
        await delay(this.options.pollErrorDelayMs ?? 1000);
      }
    }
  }

  private handleUpdate(update: unknown): void {
    const telegramUpdate = asObject<TelegramUpdate>(update);
    const updateId = Number(telegramUpdate.update_id);
    if (Number.isFinite(updateId)) this.offset = Math.max(this.offset, updateId + 1);

    if (telegramUpdate.message) this.handleMessage(telegramUpdate.message);
    if (telegramUpdate.callback_query) this.emit("callback_query", telegramUpdate.callback_query);
  }

  private handleMessage(msg: TelegramMessage): void {
    const text = typeof msg?.text === "string" ? msg.text : "";
    if (!text) return;
    for (const { regex, handler } of this.textHandlers) {
      regex.lastIndex = 0;
      const match = regex.exec(text);
      if (match) handler(msg, match);
    }
  }

  private emit(event: string, payload: unknown): void {
    for (const handler of this.eventHandlers.get(event) ?? []) handler(payload);
  }

  private async call(method: string, payload: Record<string, unknown>, timeoutMs = 35_000): Promise<unknown> {
    const startedAt = Date.now();
    let succeeded = false;
    try {
      const response = await axios.post(`${this.apiBaseUrl}/${method}`, payload, {
        timeout: timeoutMs,
        // Some production hosts advertise IPv6 but have an unreliable route to
        // Telegram. Prefer IPv4 unless the deployment explicitly selects IPv6.
        family: telegramIpFamily(),
      });
      if (!response.data?.ok) throw new Error(response.data?.description ?? `Telegram API ${method} failed`);
      succeeded = true;
      return response.data.result;
    } catch (error: unknown) {
      const response = telegramErrorResponse(error);
      const telegramDescription = response?.data?.description;
      if (telegramDescription) {
        const status = response?.status;
        throw new Error(`Telegram API ${method}${status ? ` (${status})` : ""}: ${telegramDescription}`);
      }
      throw error;
    } finally {
      const elapsedMs = Date.now() - startedAt;
      const slowMs = positiveMs(process.env.SLOW_REQUEST_LOG_MS, 2_000);
      if (method !== "getUpdates" && elapsedMs >= slowMs) {
        console.warn("[SLOW_TELEGRAM_REQUEST]", { method, elapsedMs, succeeded });
      }
    }
  }
}
