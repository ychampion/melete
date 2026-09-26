/**
 * The few Telegram Bot API methods the channel uses, over plain HTTPS.
 *
 * The bot token is part of every request URL, so neither the URL nor anything
 * built from it appears in an error: a failure names the method and what
 * Telegram said, and nothing else.
 */

export const TELEGRAM_API = 'https://api.telegram.org';

/** Telegram refuses a message longer than this many characters. */
export const TELEGRAM_TEXT_LIMIT = 4096;

export type TelegramChat = { id: number; type: string };
export type TelegramUser = { id: number; is_bot?: boolean };
export type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  reply_to_message?: { message_id: number };
  /** Present on a message someone forwarded from elsewhere. */
  forward_origin?: unknown;
};
export type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: { message_id: number; chat: TelegramChat };
  data?: string;
};
export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};
export type InlineButton = { text: string; callback_data: string };

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | null,
    readonly description: string,
    /** Seconds Telegram asked to wait before the next call, when it asked. */
    readonly retryAfter: number | null = null,
  ) {
    super(`Telegram ${method} failed${code ? ` (${code})` : ''}: ${description}`);
  }
}

export type TelegramApiOptions = {
  token: string;
  /** The Bot API host; a test points this at a fake. */
  baseUrl?: string;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
};

export class TelegramApi {
  private readonly base: string;
  private readonly send: (input: string, init: RequestInit) => Promise<Response>;

  constructor(private readonly options: TelegramApiOptions) {
    if (!/^\d{3,}:[A-Za-z0-9_-]{20,}$/.test(options.token))
      throw new Error('TELEGRAM_BOT_TOKEN is not the shape BotFather issues');
    this.base = (options.baseUrl ?? TELEGRAM_API).replace(/\/+$/, '');
    this.send = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await this.send(`${this.base}/bot${this.options.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new TelegramApiError(method, null, 'the request did not complete');
    }
    const parsed = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    } | null;
    if (!parsed?.ok)
      throw new TelegramApiError(
        method,
        parsed?.error_code ?? response.status,
        typeof parsed?.description === 'string' ? parsed.description.slice(0, 200) : 'no answer',
        parsed?.parameters?.retry_after ?? null,
      );
    return parsed.result as T;
  }

  getMe(signal?: AbortSignal) {
    return this.call<{ id: number; username?: string }>('getMe', {}, signal);
  }

  getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal) {
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'callback_query'] },
      signal,
    );
  }

  /** Plain text only: what the person reads is exactly the text given. */
  sendMessage(chatId: string, text: string, buttons?: InlineButton[][]) {
    return this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
  }

  answerCallbackQuery(id: string, text: string) {
    return this.call<boolean>('answerCallbackQuery', { callback_query_id: id, text });
  }

  /** Takes the buttons off a message once it has been answered. */
  clearButtons(chatId: string, messageId: number) {
    return this.call<unknown>('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  }

  setWebhook(url: string, secretToken: string) {
    return this.call<boolean>('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query'],
    });
  }

  deleteWebhook() {
    return this.call<boolean>('deleteWebhook', {});
  }
}
