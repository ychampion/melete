/**
 * A fake of the Telegram Bot API, answering the `fetch` a TelegramApi makes.
 * It records what the bot sent, hands out queued updates to getUpdates, and
 * refuses a request made with any other token, the way Telegram does.
 */
import type { InlineButton, TelegramUpdate } from '../../src/channels/telegram/api.ts';

export const FAKE_BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789ab';

export type SentMessage = {
  chat_id: string;
  message_id: number;
  text: string;
  buttons: InlineButton[];
};

export class FakeTelegram {
  readonly sent: SentMessage[] = [];
  readonly answered: { id: string; text: string }[] = [];
  readonly cleared: { chat_id: string; message_id: number }[] = [];
  readonly calls: string[] = [];
  webhook: { url: string; secret_token: string } | null = null;
  private readonly queue: TelegramUpdate[] = [];
  private nextMessage = 1000;
  private nextUpdate = 1;

  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const [, bot, method = ''] = url.pathname.split('/');
    if (bot !== `bot${FAKE_BOT_TOKEN}`)
      return Response.json(
        { ok: false, error_code: 401, description: 'Unauthorized' },
        { status: 401 },
      );
    this.calls.push(method);
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    switch (method) {
      case 'getMe':
        return ok({ id: 42, is_bot: true, username: 'melete_test_bot' });
      case 'getUpdates': {
        const offset = Number(body.offset ?? 0);
        const ready = this.queue.filter((update) => update.update_id >= offset);
        this.queue.splice(0, this.queue.length, ...ready);
        return ok(ready);
      }
      case 'sendMessage': {
        const text = String(body.text ?? '');
        if (text.length > 4096)
          return Response.json({ ok: false, error_code: 400, description: 'message is too long' });
        const markup = body.reply_markup as { inline_keyboard?: InlineButton[][] } | undefined;
        const message: SentMessage = {
          chat_id: String(body.chat_id),
          message_id: this.nextMessage++,
          text,
          buttons: markup?.inline_keyboard?.flat() ?? [],
        };
        this.sent.push(message);
        return ok({ message_id: message.message_id });
      }
      case 'answerCallbackQuery':
        this.answered.push({ id: String(body.callback_query_id), text: String(body.text) });
        return ok(true);
      case 'editMessageReplyMarkup':
        this.cleared.push({ chat_id: String(body.chat_id), message_id: Number(body.message_id) });
        return ok(true);
      case 'setWebhook':
        this.webhook = { url: String(body.url), secret_token: String(body.secret_token) };
        return ok(true);
      case 'deleteWebhook':
        this.webhook = null;
        return ok(true);
      default:
        return Response.json({ ok: false, error_code: 404, description: 'Not Found' });
    }
  };

  /** An update as a person in a private chat would produce it. */
  text(chatId: number, text: string, extra: Partial<NonNullable<TelegramUpdate['message']>> = {}) {
    return {
      update_id: this.nextUpdate++,
      message: {
        message_id: this.nextMessage++,
        chat: { id: chatId, type: 'private' },
        from: { id: chatId },
        text,
        ...extra,
      },
    } satisfies TelegramUpdate;
  }

  /** A tap on a button, from `fromId` in `chatId`. */
  tap(chatId: number, data: string, fromId = chatId, messageId = 1) {
    return {
      update_id: this.nextUpdate++,
      callback_query: {
        id: `cb-${this.nextUpdate}`,
        from: { id: fromId },
        message: { message_id: messageId, chat: { id: chatId, type: 'private' } },
        data,
      },
    } satisfies TelegramUpdate;
  }

  push(update: TelegramUpdate) {
    this.queue.push(update);
  }

  /** The messages sent to one chat, oldest first. */
  to(chatId: number) {
    return this.sent.filter((message) => message.chat_id === String(chatId));
  }

  lastWithButtons(chatId: number) {
    const found = this.to(chatId)
      .filter((message) => message.buttons.length)
      .at(-1);
    if (!found) throw new Error(`no message with buttons was sent to ${chatId}`);
    return found;
  }
}

const ok = (result: unknown) => Response.json({ ok: true, result });
