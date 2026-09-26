/** The Telegram pieces that need no database: text, the API client, and configuration. */
import { describe, expect, test } from 'bun:test';
import type { PermissionCard } from '@melete/contracts';
import { readEnv } from '../../env.ts';
import { TelegramApi, TelegramApiError } from './api.ts';
import { permissionText, splitText } from './channel.ts';

const TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789ab';

const card = (body: string): PermissionCard => ({
  id: 'apr_01J0000000000000000000000A',
  conversation_id: 'job_01J0000000000000000000000B',
  what: 'Send an email to alex@example.test',
  why: ['This change needs your permission before it happens.'],
  options: ['allow_once', 'deny'],
  version: 'v1',
  preview: null,
  draft: {
    id: 'act_01J0000000000000000000000C',
    recipient: 'alex@example.test',
    cc: ['jules@example.test'],
    channel: 'email',
    subject: 'Dinner',
    body,
    connection_id: 'conn_01J0000000000000000000000D',
    status: 'awaiting_permission',
  },
  created_at: new Date().toISOString(),
});

describe('what a permission message says', () => {
  test('the draft is shown whole: recipient, copies, subject and the exact body', () => {
    const body = 'Line one\n\n  indented *not markup* <b>not html</b>\nlast';
    const [text, ...rest] = permissionText(card(body));
    expect(rest).toEqual([]);
    expect(text).toContain('To: alex@example.test\nCc: jules@example.test\nSubject: Dinner');
    expect(text?.endsWith(`\n\n${body}`)).toBe(true);
  });

  test('a long body is split across messages without losing a character', () => {
    const body = Array.from({ length: 900 }, (_, i) => `Line ${i} of a long letter.`).join('\n');
    const parts = permissionText(card(body));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(4096 - 600);
    // Each split falls at a line break, which the message boundary stands for.
    expect(parts.join('\n')).toContain(body);
  });

  test('text with no line breaks is cut at the size', () => {
    const parts = splitText('x'.repeat(10_000), 4_000);
    expect(parts.map((part) => part.length)).toEqual([4_000, 4_000, 2_000]);
  });
});

describe('the Bot API client', () => {
  test('a token that is not the shape BotFather issues is refused before any call', () => {
    expect(() => new TelegramApi({ token: 'not-a-token' })).toThrow('BotFather');
  });

  test('a failure names the method and what Telegram said, never the token', async () => {
    const api = new TelegramApi({
      token: TOKEN,
      baseUrl: 'http://telegram.test',
      fetch: async () =>
        Response.json(
          {
            ok: false,
            error_code: 429,
            description: 'Too Many Requests',
            parameters: { retry_after: 7 },
          },
          { status: 429 },
        ),
    });
    const error = await api.sendMessage('1', 'hi').catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect((error as TelegramApiError).retryAfter).toBe(7);
    expect(String((error as Error).message)).not.toContain(TOKEN);
    expect(String((error as Error).message)).not.toContain('AAFake');
  });

  test('a transport failure says only that the request did not complete', async () => {
    const api = new TelegramApi({
      token: TOKEN,
      fetch: async (input) => {
        throw new Error(`connect failed to ${input}`);
      },
    });
    const error = (await api.getMe().catch((failure: unknown) => failure)) as Error;
    expect(error.message).toBe('Telegram getMe failed: the request did not complete');
  });

  test('messages are sent as plain text, so what is shown is exactly the text given', async () => {
    let body: Record<string, unknown> = {};
    const api = new TelegramApi({
      token: TOKEN,
      fetch: async (_input, init) => {
        body = JSON.parse(String(init.body));
        return Response.json({ ok: true, result: { message_id: 1 } });
      },
    });
    await api.sendMessage('7', '*bold?* <i>no</i>');
    expect(body).toMatchObject({ chat_id: '7', text: '*bold?* <i>no</i>' });
    expect(body.parse_mode).toBeUndefined();
  });
});

describe('configuration', () => {
  const base = { NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: TOKEN };
  test('polling is the default and needs no public address', () => {
    const result = readEnv(base);
    expect(result.ok && result.env.MELETE_TELEGRAM_MODE).toBe('polling');
  });
  test('webhook mode needs an https public address', () => {
    const refused = readEnv({
      ...base,
      MELETE_TELEGRAM_MODE: 'webhook',
      MELETE_PUBLIC_URL: 'http://melete.example.test',
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.issues.join(' ')).toContain('https://');
    expect(
      readEnv({
        ...base,
        MELETE_TELEGRAM_MODE: 'webhook',
        MELETE_PUBLIC_URL: 'https://melete.example.test',
      }).ok,
    ).toBe(true);
  });
  test('a token of the wrong shape stops the service at start', () => {
    expect(readEnv({ NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: 'abc' }).ok).toBe(false);
  });
});
