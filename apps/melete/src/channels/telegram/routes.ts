/**
 * Settings for the Telegram channel, for the signed-in person, and the address
 * Telegram posts to in webhook mode.
 */
import { timingSafeEqual } from 'node:crypto';
import { telegramLinkCode, telegramStatus, telegramUnlinked } from '@melete/contracts';
import type { Hono } from 'hono';
import { ServiceError } from '../../api/errors.ts';
import type { TelegramUpdate } from './api.ts';
import type { TelegramChannel } from './channel.ts';

export const WEBHOOK_PATH = '/telegram/webhook';
export const WEBHOOK_SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';

const sameSecret = (given: string | undefined, expected: string) => {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function mountTelegram(
  app: Hono,
  deps: {
    channel?: TelegramChannel;
  },
) {
  const { channel } = deps;
  const person = (c: { get(key: 'owner'): { id: string } | undefined }) => {
    const owner = c.get('owner');
    if (!owner) throw new ServiceError('unauthorized', 'A session is required.', 401);
    return owner.id;
  };

  app.get('/telegram', async (c) =>
    c.json(
      telegramStatus.parse(
        channel
          ? await channel.status(person(c))
          : { available: false, linked: false, linked_at: null, bot_username: null },
      ),
    ),
  );

  app.post('/telegram/link-code', async (c) => {
    const id = person(c);
    if (!channel)
      throw new ServiceError('unavailable', 'Telegram is not set up on this installation.', 503);
    return c.json(telegramLinkCode.parse(await channel.issueLinkCode(id)));
  });

  app.delete('/telegram', async (c) => {
    const id = person(c);
    return c.json(telegramUnlinked.parse(channel ? await channel.unlink(id) : { status: 'ok' }));
  });
}

/**
 * Where Telegram posts in webhook mode. Mounted with the other routes that
 * need no session, before any middleware that expects one; the channel is read
 * when a request arrives, because it is built after the routes it answers.
 */
export function mountTelegramWebhook(
  app: Hono,
  deps: {
    channel: () => TelegramChannel | undefined;
    /** Set only in webhook mode: the secret Telegram was told to send. */
    webhookSecret?: string;
  },
) {
  app.post(WEBHOOK_PATH, async (c) => {
    const channel = deps.channel();
    if (!channel || !deps.webhookSecret)
      return c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
    if (!sameSecret(c.req.header(WEBHOOK_SECRET_HEADER), deps.webhookSecret))
      return c.json({ error: { code: 'unauthorized', message: 'Unauthorized.' } }, 401);
    const update = (await c.req.json().catch(() => null)) as TelegramUpdate | null;
    if (!update || !Number.isSafeInteger(update.update_id))
      return c.json({ error: { code: 'payload_invalid', message: 'Invalid update.' } }, 400);
    await channel.handleUpdate(update);
    return c.json({ ok: true });
  });
}
