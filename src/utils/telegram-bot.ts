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

type TextHandler = (msg: any, match: RegExpExecArray | null) => void;
type EventHandler = (payload: any) => void;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  constructor(private readonly token: string, private readonly options: TelegramBotOptions = {}) {
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

  async sendMessage(chatId: string | number, text: string, options: TelegramSendMessageOptions = {}): Promise<any> {
    return this.call("sendMessage", { chat_id: chatId, text, ...options });
  }

  async answerCallbackQuery(callbackQueryId: string, options: Record<string, unknown> = {}): Promise<any> {
    return this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...options });
  }

  async deleteMessage(chatId: string | number, messageId: string | number): Promise<any> {
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  stopPolling(): void {
    this.stopped = true;
  }

  private startPolling(): void {
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

  private handleUpdate(update: any): void {
    const updateId = Number(update?.update_id);
    if (Number.isFinite(updateId)) this.offset = Math.max(this.offset, updateId + 1);

    if (update?.message) this.handleMessage(update.message);
    if (update?.callback_query) this.emit("callback_query", update.callback_query);
  }

  private handleMessage(msg: any): void {
    const text = typeof msg?.text === "string" ? msg.text : "";
    if (!text) return;
    for (const { regex, handler } of this.textHandlers) {
      regex.lastIndex = 0;
      const match = regex.exec(text);
      if (match) handler(msg, match);
    }
  }

  private emit(event: string, payload: any): void {
    for (const handler of this.eventHandlers.get(event) ?? []) handler(payload);
  }

  private async call(method: string, payload: Record<string, unknown>): Promise<any> {
    const response = await axios.post(`${this.apiBaseUrl}/${method}`, payload, { timeout: 35_000 });
    if (!response.data?.ok) throw new Error(response.data?.description ?? `Telegram API ${method} failed`);
    return response.data.result;
  }
}
