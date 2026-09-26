/**
 * Telegram as a channel to one person: whether it is offered, whether their
 * chat is linked, and the one-time code that links it.
 */
import { z } from 'zod';

const date = z.iso.datetime({ offset: true });

/** What Settings shows about the Telegram channel for the signed-in person. */
export const telegramStatus = z.strictObject({
  /** True when this installation has a bot configured. */
  available: z.boolean(),
  linked: z.boolean(),
  linked_at: date.nullable(),
  /** The bot to message, when Telegram told the service its name. */
  bot_username: z.string().max(64).nullable(),
});
export type TelegramStatus = z.infer<typeof telegramStatus>;

/** The code to send the bot as `/start <code>`. It works once, for a few minutes. */
export const telegramLinkCode = z.strictObject({
  code: z.string().regex(/^[A-Z2-9]{8}$/),
  expires_at: date,
  bot_username: z.string().max(64).nullable(),
});
export type TelegramLinkCode = z.infer<typeof telegramLinkCode>;

export const telegramUnlinked = z.strictObject({ status: z.literal('ok') });
