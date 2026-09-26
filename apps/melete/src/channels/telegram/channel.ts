/**
 * Telegram as a channel to one person at a time.
 *
 * A person links their own private chat once, with a one-time code from
 * Settings. From then on the decisions Melete waits on are sent there: a
 * permission shows the exact text that would leave, with Allow once and Deny,
 * and a question shows its choices. A tap answers through the same service
 * calls the web app makes, as that person, in their own space; anything more
 * than Allow once or Deny, such as a standing rule, stays in the web app.
 * Anything else the person types becomes their next message in a conversation.
 *
 * What a tap may do is never read from the tap. Each button carries a random
 * token; only its hash is stored, beside the link it was sent to, the request
 * it answers, the choice and the version of the request. A token is spent
 * before the answer is given, so a second tap, a replayed update or a button
 * forwarded to another chat does nothing. An unlinked chat learns nothing
 * about anyone.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { ExperienceEvent, PermissionCard } from '@melete/contracts';
import { ID_PREFIXES } from '@melete/contracts';
import type { Sql } from 'postgres';
import { ServiceError } from '../../api/errors.ts';
import type { Database } from '../../db/client.ts';
import type { ExperienceParts } from '../../experience/routes.ts';
import { newId } from '../../ids.ts';
import { principalContext } from '../../principals/authority.ts';
import { resolveSessionSpace } from '../../principals/session-space.ts';
import {
  type InlineButton,
  TELEGRAM_TEXT_LIMIT,
  type TelegramApi,
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramUpdate,
} from './api.ts';

export const LINK_CODE_TTL_MS = 10 * 60_000;
/** A button outlives no request it answers; the request's own expiry still applies. */
export const BUTTON_TTL_MS = 7 * 24 * 60 * 60_000;
/** The most messages one request's exact text is spread over before it is sent to the web app instead. */
export const MAX_TEXT_PARTS = 8;
/** Room left in the last part for the heading and the note under the text. */
const PART_SIZE = TELEGRAM_TEXT_LIMIT - 600;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export const TEXT = {
  unlinked:
    'This chat is not linked to a Melete account. Open Settings in Melete, choose Telegram, and send the code here as /start followed by the code.',
  privateOnly: 'Melete answers only in a private chat with this bot.',
  badCode: 'That code is not valid or has expired. Get a new one in Settings.',
  chatTaken: 'This chat is already linked to a Melete account. Unlink it in Settings first.',
  linked: 'Linked. Melete will send the decisions it needs from you here.',
  unlinkedNow: 'Unlinked. This chat will get nothing more from Melete.',
  buttonRefused: 'This button is not valid here.',
  openWebApp: 'Open Melete to answer this one.',
  allowed: 'Allowed once.',
  denied: 'Denied. Nothing was sent.',
  answered: 'Answered.',
  received: 'Sent to Melete.',
  help: 'Reply here to talk to Melete, or send /unlink to stop.',
} as const;

type LinkRow = {
  id: string;
  principal_id: string;
  chat_id: string;
  user_id: string;
  event_cursor: number;
};

export type TelegramChannelDeps = {
  sql: Sql;
  db: Database;
  api: TelegramApi;
  spacesDir: string;
  experience: ExperienceParts;
  /** The bot's username, for Settings; learned from Telegram at start. */
  botUsername?: string | null;
  now?: () => Date;
  log?: (message: string) => void;
};

/** A conversation id is kept for replies only when it looks like one. */
const conversationId = (value: unknown) =>
  typeof value === 'string' && value.startsWith(`${ID_PREFIXES.job}_`) ? value : null;

export class TelegramChannel {
  botUsername: string | null;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: TelegramChannelDeps) {
    this.botUsername = deps.botUsername ?? null;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((message) => process.stderr.write(`telegram: ${message}\n`));
  }

  // ---------------------------------------------------------------- Settings

  /** A fresh code for this person; an unused older one stops working. */
  async issueLinkCode(principalId: string) {
    const code = Array.from(
      { length: 8 },
      () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
    ).join('');
    const expiresAt = new Date(this.now().getTime() + LINK_CODE_TTL_MS);
    await this.deps.sql.begin(async (tx) => {
      await tx`update telegram_link_code set used_at = now()
        where principal_id = ${principalId} and used_at is null`;
      await tx`insert into telegram_link_code (code_hash, principal_id, expires_at)
        values (${hash(code)}, ${principalId}, ${expiresAt.toISOString()})`;
    });
    return { code, expires_at: expiresAt.toISOString(), bot_username: this.botUsername };
  }

  async status(principalId: string) {
    const [link] = await this.deps.sql`select created_at from telegram_link
      where principal_id = ${principalId} and revoked_at is null`;
    return {
      available: true,
      linked: Boolean(link),
      linked_at: link ? new Date(link.created_at).toISOString() : null,
      bot_username: this.botUsername,
    };
  }

  async unlink(principalId: string) {
    await this.deps.sql`update telegram_link set revoked_at = now()
      where principal_id = ${principalId} and revoked_at is null`;
    return { status: 'ok' as const };
  }

  // ----------------------------------------------------------------- Updates

  /** One update from Telegram. Safe to receive twice. */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) return this.onButton(update.callback_query);
    if (update.message) return this.onMessage(update.message, update.update_id);
  }

  private async activeLink(chatId: string): Promise<LinkRow | undefined> {
    const [link] = await this.deps.sql<LinkRow[]>`select id, principal_id, chat_id, user_id,
      event_cursor from telegram_link where chat_id = ${chatId} and revoked_at is null`;
    return link;
  }

  private async onMessage(message: TelegramMessage, updateId: number) {
    const chatId = String(message.chat.id);
    if (message.chat.type !== 'private' || !message.from || message.from.is_bot) {
      if (message.chat.type !== 'private') await this.say(chatId, TEXT.privateOnly);
      return;
    }
    const text = (message.text ?? '').trim();
    const start = /^\/start(?:@\w+)?(?:\s+(\S+))?$/i.exec(text);
    if (start?.[1]) return this.link(message, start[1]);
    const link = await this.activeLink(chatId);
    // In a private chat the chat is the person; anyone else is refused too.
    if (!link || link.user_id !== String(message.from.id)) {
      await this.say(chatId, TEXT.unlinked);
      return;
    }
    if (/^\/unlink(?:@\w+)?$/i.test(text)) {
      await this.unlink(link.principal_id);
      await this.say(chatId, TEXT.unlinkedNow);
      return;
    }
    if (!text || text.startsWith('/')) {
      await this.say(chatId, TEXT.help);
      return;
    }
    await this.asPerson(link, async (spaceId) => {
      const target = await this.conversationFor(link, spaceId, message);
      if (!target) {
        await this.say(chatId, TEXT.openWebApp);
        return;
      }
      try {
        // The update id makes a redelivered update the same message, not a second one.
        await this.deps.experience.service.message(
          spaceId,
          target,
          { text },
          `telegram:${updateId}`,
        );
      } catch (error) {
        await this.say(chatId, error instanceof ServiceError ? error.message : TEXT.openWebApp);
        return;
      }
      const sent = await this.say(chatId, TEXT.received);
      if (sent) await this.remember(link, sent, target);
    });
  }

  /** The conversation a message continues: the one it replies to, else the latest, else a new one. */
  private async conversationFor(link: LinkRow, spaceId: string, message: TelegramMessage) {
    const { service } = this.deps.experience;
    const replied = message.reply_to_message?.message_id;
    if (replied !== undefined) {
      const [row] = await this.deps.sql`select conversation_id from telegram_delivery
        where link_id = ${link.id} and message_id = ${replied}`;
      const id = conversationId(row?.conversation_id);
      if (id) {
        try {
          await service.requireConversation(spaceId, id);
          return id;
        } catch {
          // Gone or no longer theirs: fall through to the latest one.
        }
      }
    }
    const list = (await service.conversations(spaceId, {})) as {
      conversations?: { id: string }[];
    };
    const latest = conversationId(list.conversations?.[0]?.id);
    if (latest) return latest;
    const agents = (await service.agents(spaceId)) as { agents?: { id: string }[] };
    const agent = agents.agents?.[0]?.id;
    if (!agent) return null;
    const created = (await service.createConversation(spaceId, {
      title: 'Telegram',
      agent_id: agent,
    })) as { conversation?: { id: string } };
    return conversationId(created.conversation?.id);
  }

  private async link(message: TelegramMessage, code: string) {
    const chatId = String(message.chat.id);
    const userId = String(message.from?.id ?? '');
    const outcome = await this.deps.sql.begin(async (tx) => {
      const [used] = await tx`update telegram_link_code set used_at = now()
        where code_hash = ${hash(code.toUpperCase())} and used_at is null and expires_at > now()
        returning principal_id`;
      if (!used) return 'bad_code' as const;
      const principalId = String(used.principal_id);
      const [holder] = await tx`select principal_id from telegram_link
        where chat_id = ${chatId} and revoked_at is null for update`;
      if (holder && String(holder.principal_id) !== principalId) return 'chat_taken' as const;
      // A person has one chat: linking another ends the first.
      await tx`update telegram_link set revoked_at = now()
        where principal_id = ${principalId} and revoked_at is null`;
      // Decisions from before the link are sent from the open list below, once.
      const [latest] = await tx`select coalesce(max(seq), 0) as seq from event`;
      const id = newId('tg');
      await tx`insert into telegram_link (id, principal_id, chat_id, user_id, event_cursor)
        values (${id}, ${principalId}, ${chatId}, ${userId}, ${Number(latest?.seq ?? 0)})`;
      return { id, principalId };
    });
    if (outcome === 'bad_code') return void (await this.say(chatId, TEXT.badCode));
    if (outcome === 'chat_taken') return void (await this.say(chatId, TEXT.chatTaken));
    await this.say(chatId, TEXT.linked);
    const link = await this.activeLink(chatId);
    if (link) await this.sendOpen(link);
  }

  // ------------------------------------------------------------------- Taps

  private async onButton(query: TelegramCallbackQuery) {
    const chatId = query.message ? String(query.message.chat.id) : '';
    const data = query.data ?? '';
    const claimed = TOKEN.test(data)
      ? await this.deps.sql.begin(async (tx) => {
          const [button] = await tx`select b.*, l.principal_id, l.chat_id, l.user_id
            from telegram_button b join telegram_link l on l.id = b.link_id
            where b.token_hash = ${hash(data)} and b.used_at is null and b.expires_at > now()
              and l.revoked_at is null
            for update of b`;
          // Bound to the chat it was sent to and the person who owns that chat:
          // a forwarded or replayed button fails here.
          if (
            !button ||
            String(button.chat_id) !== chatId ||
            String(button.user_id) !== String(query.from.id)
          )
            return null;
          // Spent before anything is done, with every other button on its message.
          await tx`update telegram_button set used_at = now()
            where message_key = ${button.message_key} and used_at is null`;
          return button;
        })
      : null;
    if (!claimed) {
      await this.answer(query.id, TEXT.buttonRefused);
      return;
    }
    const link: LinkRow = {
      id: String(claimed.link_id),
      principal_id: String(claimed.principal_id),
      chat_id: String(claimed.chat_id),
      user_id: String(claimed.user_id),
      event_cursor: 0,
    };
    let reply: string = TEXT.answered;
    try {
      await this.asPerson(link, async (spaceId) => {
        if (claimed.kind === 'permission') {
          const { permissions } = this.deps.experience;
          if (!permissions) throw new ServiceError('unavailable', TEXT.openWebApp, 503);
          await permissions.decide(spaceId, String(claimed.target_id), {
            option: claimed.choice,
            version: claimed.version,
          });
          reply = claimed.choice === 'deny' ? TEXT.denied : TEXT.allowed;
        } else {
          const result = await this.deps.experience.questions.answer(
            spaceId,
            String(claimed.target_id),
            String(claimed.choice),
          );
          if (result && typeof result === 'object' && 'reason' in result)
            throw new ServiceError('unavailable', TEXT.openWebApp, 409);
        }
      });
    } catch (error) {
      reply =
        error instanceof ServiceError ? `${error.message} ${TEXT.openWebApp}` : TEXT.openWebApp;
      if (!(error instanceof ServiceError)) this.log(`an answer failed: ${describe(error)}`);
    }
    await this.answer(query.id, reply);
    if (query.message)
      await this.deps.api.clearButtons(chatId, query.message.message_id).catch(() => undefined);
    await this.say(chatId, reply);
  }

  // --------------------------------------------------------------- Delivery

  /** Send every linked person what is new for them. Called on a timer. */
  async deliver(): Promise<void> {
    const links = await this.deps.sql<LinkRow[]>`select id, principal_id, chat_id, user_id,
      event_cursor from telegram_link where revoked_at is null order by created_at`;
    for (const link of links) {
      try {
        await this.deliverTo(link);
      } catch (error) {
        this.log(`delivery to one chat failed: ${describe(error)}`);
      }
    }
  }

  private async deliverTo(link: LinkRow) {
    await this.asPerson(link, async (spaceId) => {
      const page = await this.deps.experience.events.page(
        spaceId,
        link.event_cursor,
        undefined,
        50,
        link.principal_id,
      );
      for (const event of page.events as ExperienceEvent[]) {
        const item = event.item;
        if (item.type === 'permission') await this.sendPermission(link, item.permission);
        if (item.type === 'question') await this.sendQuestion(link, item.question);
        // Advanced per event, so a failure repeats at most the one in flight.
        await this.deps.sql`update telegram_link set event_cursor = ${event.seq}
          where id = ${link.id} and event_cursor < ${event.seq}`;
      }
    });
  }

  /** What is already waiting when a chat is linked. */
  private async sendOpen(link: LinkRow) {
    await this.asPerson(link, async (spaceId) => {
      const { permissions, questions } = this.deps.experience;
      const open = permissions ? await permissions.list(spaceId) : { permissions: [] };
      for (const card of open.permissions) await this.sendPermission(link, card);
      const asked = (await questions.list(spaceId)) as {
        questions?: Extract<ExperienceEvent['item'], { type: 'question' }>['question'][];
      };
      for (const question of asked.questions ?? []) await this.sendQuestion(link, question);
    });
  }

  private async sendPermission(link: LinkRow, card: PermissionCard) {
    const parts = permissionText(card);
    const fits = parts.length <= MAX_TEXT_PARTS;
    const options = card.options.filter(
      (option): option is 'allow_once' | 'deny' =>
        option === 'deny' || (option === 'allow_once' && fits),
    );
    const heading = fits ? parts : [`${card.what}\n\n${TOO_LONG}`];
    const note = card.options.includes('always')
      ? '\n\nTo allow this every time, open Melete.'
      : '';
    const buttons = await this.buttons(
      link,
      'permission',
      card.id,
      card.version,
      options.map((option) => ({
        choice: option,
        label: option === 'deny' ? 'Deny' : 'Allow once',
      })),
    );
    await this.sendParts(link, heading, note, buttons, card.conversation_id);
  }

  private async sendQuestion(
    link: LinkRow,
    question: Extract<ExperienceEvent['item'], { type: 'question' }>['question'],
  ) {
    const text = [question.text, ...question.why].join('\n\n');
    const buttons = await this.buttons(
      link,
      'question',
      question.id,
      null,
      question.options.map((option) => ({ choice: option.id, label: option.label })),
    );
    await this.sendParts(link, splitText(text), '', buttons, question.conversation_id);
  }

  private async sendParts(
    link: LinkRow,
    parts: string[],
    note: string,
    buttons: InlineButton[][],
    conversation: string | null,
  ) {
    for (const [index, part] of parts.entries()) {
      const last = index === parts.length - 1;
      const sent = await this.deps.api.sendMessage(
        link.chat_id,
        last ? `${part}${note}` : part,
        last && buttons.length ? buttons : undefined,
      );
      if (conversation) await this.remember(link, sent.message_id, conversation);
    }
  }

  private async buttons(
    link: LinkRow,
    kind: 'permission' | 'question',
    targetId: string,
    version: string | null,
    choices: { choice: string; label: string }[],
  ): Promise<InlineButton[][]> {
    const messageKey = randomBytes(16).toString('hex');
    const expiresAt = new Date(this.now().getTime() + BUTTON_TTL_MS);
    const row: InlineButton[] = [];
    for (const { choice, label } of choices) {
      const token = randomBytes(32).toString('base64url');
      await this.deps.sql`insert into telegram_button
        (token_hash, link_id, kind, target_id, choice, version, message_key, expires_at)
        values (${hash(token)}, ${link.id}, ${kind}, ${targetId}, ${choice}, ${version},
          ${messageKey}, ${expiresAt.toISOString()})`;
      row.push({ text: label, callback_data: token });
    }
    return row.length ? [row] : [];
  }

  // ---------------------------------------------------------------- Helpers

  private async asPerson<T>(link: LinkRow, work: (spaceId: string) => Promise<T>): Promise<T> {
    return principalContext.run(link.principal_id, async () => {
      const space = await resolveSessionSpace(
        this.deps.db,
        this.deps.spacesDir,
        link.principal_id,
        null,
      );
      return work(space.spaceId);
    });
  }

  private async remember(link: LinkRow, messageId: number, conversation: string) {
    await this.deps.sql`insert into telegram_delivery (link_id, message_id, conversation_id)
      values (${link.id}, ${messageId}, ${conversation}) on conflict do nothing`;
  }

  private async say(chatId: string, text: string): Promise<number | null> {
    try {
      return (await this.deps.api.sendMessage(chatId, text)).message_id;
    } catch (error) {
      this.log(`a reply was not sent: ${describe(error)}`);
      return null;
    }
  }

  private async answer(queryId: string, text: string) {
    await this.deps.api.answerCallbackQuery(queryId, text.slice(0, 190)).catch(() => undefined);
  }
}

/** An error for the log: its kind and first line, never an update's contents. */
const describe = (error: unknown) =>
  error instanceof Error
    ? `${error.name}: ${error.message.split(/\r?\n/)[0]?.slice(0, 200)}`
    : 'an unknown error';

const TOO_LONG =
  'The full text is too long to show here, so it can only be allowed in Melete. You can deny it here.';

/** Text in pieces Telegram accepts, split at a line where one falls near the limit. */
export function splitText(text: string, size = PART_SIZE): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const cut = rest.lastIndexOf('\n', size);
    const at = cut > size / 2 ? cut : size;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, '');
  }
  parts.push(rest);
  return parts;
}

/**
 * What a permission message says: what would happen, then exactly what would
 * leave. A draft is shown whole, recipient, subject and body, never summarised.
 */
export function permissionText(card: PermissionCard): string[] {
  const lines = [card.what, '', ...card.why];
  const draft = card.draft;
  if (draft) {
    lines.push('', `To: ${draft.recipient}`);
    if (draft.cc?.length) lines.push(`Cc: ${draft.cc.join(', ')}`);
    if (draft.bcc?.length) lines.push(`Bcc: ${draft.bcc.join(', ')}`);
    if (draft.subject !== undefined) lines.push(`Subject: ${draft.subject}`);
    lines.push('', draft.body);
  } else if (card.preview) {
    lines.push('', card.preview.title);
    if (card.preview.meta) lines.push(card.preview.meta);
    for (const fact of card.preview.facts) lines.push(`${fact.label}: ${fact.value}`);
  }
  return splitText(lines.join('\n'));
}
