/**
 * Texts that reach a Twilio number, and Melete's answers to them.
 *
 * Twilio posts each incoming text to `/api/sms/twilio/<connection>` at the
 * service's public address. Nothing in the request is believed until its
 * `X-Twilio-Signature` checks out under the connection's own auth token, for
 * that exact address, and it names the connection's own account and number.
 *
 * A text from one of the person's own numbers is a message in their texting
 * conversation, taken the way a message typed in the app is. A text from any
 * other number is kept for the person to read and goes nowhere else: it never
 * becomes a turn, so nothing in it is ever acted on.
 *
 * Answers go back by text once the turn has finished, to the number that
 * asked, split to fit. Nothing is approved by text: a turn that needs the
 * person's decision says so and waits for them in the app.
 */
import { smsConnectionConfig, smsTextListResponse } from '@melete/contracts';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import type { SecretAccess } from '../connectors/secrets.ts';
import { smsParts, withTwilio } from '../connectors/sms.ts';
import { type TwilioOptions, validTwilioSignature } from '../connectors/twilio.ts';
import { answerText } from '../experience/projectors.ts';
import type { ExperienceService } from '../experience/service.ts';
import { newId } from '../ids.ts';
import { principalContext } from '../principals/authority.ts';

export type SmsInboxDeps = {
  sql: Sql;
  secrets: SecretAccess;
  publicUrl?: string;
  twilio?: TwilioOptions;
  /** Present where conversations are served; without it a text from the person is only kept. */
  experience?: ExperienceService;
};

/** The service route Twilio calls, behind the web app's `/api` prefix. */
export const SMS_WEBHOOK_ROUTE = '/sms/twilio/:id';
const CONNECTION_ID = /^conn_[A-Za-z0-9]{1,64}$/;
const MESSAGE_SID = /^[A-Z]{2}[0-9a-fA-F]{32}$/;

/**
 * The address Twilio sends a connection's incoming texts to, or null when this
 * service has no public https:// address Twilio could reach.
 */
export function smsWebhookUrl(publicUrl: string | undefined, connectionId: string): string | null {
  if (!publicUrl || !CONNECTION_ID.test(connectionId)) return null;
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== 'https:') return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}/api/sms/twilio/${connectionId}`;
  } catch {
    return null;
  }
}

/** What everyone reads when texts can be sent from here but cannot reach Melete yet. */
export const SMS_INBOUND_LIMITED =
  'Texts can be sent from here, but texts to Melete cannot reach it on this Melete yet.';
/** What the operator reads: what to set so texts reach Melete. */
export const SMS_INBOUND_NEEDS =
  'Texting Melete needs the public https:// address Twilio can reach this service at. Set MELETE_PUBLIC_URL.';

/** What the person is told by text when their text could not become a message. */
const BUSY =
  'Melete is still answering your last text. Send this one again when the answer arrives.';
const NO_ASSISTANT = 'Choose an assistant in Melete first, then text again.';

type ConnectionRow = {
  id: string;
  space_id: string;
  secret_ref: string | null;
  configuration: Record<string, unknown>;
};

export class SmsInbox {
  /** One conversation per connection is made at a time, so two first texts share one. */
  private readonly making = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: SmsInboxDeps) {}

  /**
   * One request from Twilio. `forbidden` covers everything that is not a
   * signed text for an active connection, so the answer says nothing about
   * which check failed.
   */
  async receive(
    connectionId: string,
    params: URLSearchParams,
    signature: string | undefined,
  ): Promise<'ok' | 'forbidden'> {
    const url = smsWebhookUrl(this.deps.publicUrl, connectionId);
    if (!url) return 'forbidden';
    const [row] = await this.deps.sql<ConnectionRow[]>`select id, space_id, secret_ref,
      configuration from connection
      where id = ${connectionId} and provider = 'twilio' and status = 'active'`;
    if (!row?.secret_ref) return 'forbidden';
    const connection = { ...row, secret_ref: row.secret_ref };
    const genuine = await withTwilio(
      this.deps.secrets,
      { secretRef: connection.secret_ref, spaceId: row.space_id },
      async (_client, credentials) =>
        validTwilioSignature(signature, url, params.entries(), credentials.auth_token) &&
        params.get('AccountSid') === credentials.account_sid &&
        params.get('To') === credentials.from_number,
    ).catch(() => false);
    if (!genuine) return 'forbidden';

    const sid = params.get('MessageSid') ?? '';
    const from = params.get('From') ?? '';
    if (!MESSAGE_SID.test(sid) || !from) return 'ok';
    const media = Number(params.get('NumMedia') ?? '0');
    const body = [
      (params.get('Body') ?? '').slice(0, 1600),
      ...(Number.isInteger(media) && media > 0
        ? [`(${media === 1 ? 'A picture was' : `${media} pictures were`} sent with this text.)`]
        : []),
    ]
      .filter(Boolean)
      .join('\n');
    const config = smsConnectionConfig.safeParse(row.configuration.sms);
    const fromYou = config.success && config.data.allowed_numbers.includes(from);
    const id = newId('sms');
    const kept = await this.deps.sql`insert into sms_text
      (id, connection_id, space_id, direction, counterpart, body, from_you, message_sid, state)
      values (${id}, ${row.id}, ${row.space_id}, 'in', ${from}, ${body}, ${fromYou}, ${sid},
        ${fromYou ? 'refused' : 'kept'})
      on conflict (connection_id, message_sid) where direction = 'in' and message_sid is not null
      do nothing returning id`;
    // Twilio delivered this message before: it was handled then.
    if (!kept.length || !fromYou || !body) return 'ok';
    // The text is kept whatever happens next, and Twilio is answered either way:
    // a text that could not become a message stays `refused`, where the person sees it.
    await this.converse(connection, id, from, sid, body).catch(() =>
      process.stderr.write(`a text to connection ${row.id} could not reach its conversation\n`),
    );
    return 'ok';
  }

  /** Put the person's text in their texting conversation, as a message typed in the app is. */
  private async converse(
    connection: ConnectionRow & { secret_ref: string },
    textId: string,
    from: string,
    sid: string,
    body: string,
  ) {
    const experience = this.deps.experience;
    if (!experience) return;
    const owner = await this.owner(connection.space_id);
    if (!owner) return;
    await principalContext.run(owner, async () => {
      let conversation: string | null;
      try {
        conversation = await this.conversationFor(connection, experience);
      } catch {
        conversation = null;
      }
      if (!conversation) return this.tell(connection, from, NO_ASSISTANT);
      try {
        const accepted = await experience.message(
          connection.space_id,
          conversation,
          { text: body },
          `sms:${sid}`,
        );
        if (!('turn_id' in accepted)) return this.tell(connection, from, BUSY);
        await this.deps.sql`update sms_text set state = 'conversation', job_id = ${conversation},
          turn_id = ${accepted.turn_id} where id = ${textId}`;
      } catch (error) {
        if (error instanceof ServiceError && error.code === 'message_not_accepted')
          return this.tell(connection, from, BUSY);
        throw error;
      }
    });
  }

  /** Whose space it is: the person a text from their own number speaks as. */
  private async owner(spaceId: string): Promise<string | null> {
    const [row] = await this.deps.sql`select coalesce(owner_principal_id,
      (select id from owner limit 1)) as owner_id from space
      where id = ${spaceId} and removed_at is null`;
    return row?.owner_id ? String(row.owner_id) : null;
  }

  /**
   * The conversation this number's texts go to: the one earlier texts went to
   * while it lasts, otherwise a new one with the assistant the person last
   * talked to. Null when the person has no assistant yet.
   */
  private async conversationFor(
    connection: ConnectionRow,
    experience: ExperienceService,
  ): Promise<string | null> {
    const pending = this.making.get(connection.id) ?? Promise.resolve();
    const next = pending.then(async () => {
      const [earlier] = await this.deps.sql`select t.job_id from sms_text t
        join job j on j.id = t.job_id and j.kind = 'chat'
        where t.connection_id = ${connection.id} and t.direction = 'in' and t.job_id is not null
        order by t.created_at desc limit 1`;
      if (earlier?.job_id) return String(earlier.job_id);
      const [recent] = await this.deps.sql`select agent_id from job
        where space_id = ${connection.space_id} and kind = 'chat' and agent_id is not null
        order by updated_at desc limit 1`;
      const [first] = recent
        ? [recent]
        : await this.deps.sql`select id as agent_id from agent
            where space_id = ${connection.space_id} order by created_at, id limit 1`;
      if (!first?.agent_id) return null;
      const made = await experience.createConversation(connection.space_id, {
        title: 'Texts',
        agent_id: String(first.agent_id),
      });
      return 'conversation' in made ? made.conversation.id : null;
    });
    this.making.set(
      connection.id,
      next.catch(() => undefined),
    );
    return next;
  }

  /** A short answer of the service's own, by text, to the person's own number. */
  private async tell(connection: ConnectionRow & { secret_ref: string }, to: string, text: string) {
    const id = newId('sms');
    await this.deps.sql`insert into sms_text
      (id, connection_id, space_id, direction, counterpart, body, state)
      values (${id}, ${connection.id}, ${connection.space_id}, 'out', ${to}, ${text}, 'sending')`;
    const sent = await withTwilio(
      this.deps.secrets,
      { secretRef: connection.secret_ref, spaceId: connection.space_id, twilio: this.deps.twilio },
      (client) => client.send(to, text),
    ).catch(() => null);
    await this.deps.sql`update sms_text set state = ${sent ? 'sent' : 'failed'},
      message_sid = ${sent?.sid ?? null} where id = ${id}`;
  }

  /** Texts that reached the number, newest first, for the space's owner to read. */
  async texts(connectionId: string) {
    const rows = await this.deps.sql`select id, counterpart, body, from_you, state, created_at
      from sms_text where connection_id = ${connectionId} and direction = 'in'
      order by created_at desc, id desc limit 100`;
    return smsTextListResponse.parse({
      texts: rows.map((row) => ({
        id: String(row.id),
        from: String(row.counterpart),
        body: String(row.body),
        from_you: Boolean(row.from_you),
        handling:
          row.state === 'kept'
            ? 'kept'
            : row.state === 'conversation'
              ? 'conversation'
              : 'not_taken',
        received_at: new Date(row.created_at).toISOString(),
      })),
    });
  }
}

/** What a finished turn says by text. */
export function replyText(status: string, answer: string): string {
  const said = answerText(answer).trim();
  if (status === 'done') return said || 'Done.';
  if (status === 'needs_you')
    return said ? `${said}\n\nOpen Melete to go on.` : 'Melete needs you in the app to go on.';
  return 'Melete could not finish that. Open the app to see what happened.';
}

/** Turns that finished long ago are left alone: an answer a day late is noise. */
const REPLY_WINDOW = '1 day';

/**
 * Answer, by text, each finished turn a text started and nothing has answered
 * yet. Each text of a reply is written as `sending` before Twilio is asked, and
 * the rows are unique by turn and part, so a turn is answered at most once
 * however many sweeps find it. Returns how many turns it answered.
 */
export async function sweepSmsReplies(deps: {
  sql: Sql;
  secrets: SecretAccess;
  twilio?: TwilioOptions;
}): Promise<number> {
  const due = await deps.sql`select i.connection_id, i.space_id, i.counterpart, i.job_id,
      i.turn_id, t.status, t.answer, c.secret_ref
    from sms_text i
    join experience_turn t on t.id = i.turn_id
    join connection c on c.id = i.connection_id
    where i.direction = 'in' and i.state = 'conversation'
      and t.status in ('done', 'needs_you', 'failed')
      and c.status = 'active' and c.secret_ref is not null
      and i.created_at > now() - ${REPLY_WINDOW}::interval
      and not exists (select 1 from sms_text o where o.direction = 'out' and o.turn_id = i.turn_id)
    order by i.created_at
    limit 20`;
  let answered = 0;
  for (const turn of due) {
    const parts = smsParts(replyText(String(turn.status), String(turn.answer ?? '')));
    const claimed = await deps.sql.begin(async (tx) => {
      const rows: string[] = [];
      for (const [part, body] of parts.entries()) {
        const id = newId('sms');
        const [row] = await tx`insert into sms_text
          (id, connection_id, space_id, direction, counterpart, body, job_id, turn_id, part, state)
          values (${id}, ${turn.connection_id}, ${turn.space_id}, 'out', ${turn.counterpart},
            ${body}, ${turn.job_id}, ${turn.turn_id}, ${part}, 'sending')
          on conflict (turn_id, part) where direction = 'out' and turn_id is not null
          do nothing returning id`;
        // Another sweep claimed this turn first.
        if (!row) return [];
        rows.push(id);
      }
      return rows;
    });
    if (!claimed.length) continue;
    answered++;
    await withTwilio(
      deps.secrets,
      { secretRef: String(turn.secret_ref), spaceId: String(turn.space_id), twilio: deps.twilio },
      async (client) => {
        for (const [index, id] of claimed.entries()) {
          try {
            const sent = await client.send(String(turn.counterpart), parts[index] ?? '');
            await deps.sql`update sms_text set state = 'sent', message_sid = ${sent.sid}
              where id = ${id}`;
          } catch {
            // The rest would read out of order without it, so they are not sent either.
            await deps.sql`update sms_text set state = 'failed' where id = any(${claimed.slice(index)})`;
            return;
          }
        }
      },
    ).catch(async () => {
      await deps.sql`update sms_text set state = 'failed'
        where id = any(${claimed}) and state = 'sending'`;
    });
  }
  return answered;
}

/** Keep answering texts while the service runs. `poke` answers soon after a turn ends. */
export function startSmsReplies(
  deps: { sql: Sql; secrets: SecretAccess; twilio?: TwilioOptions },
  intervalMs = 5000,
) {
  let running: Promise<unknown> | undefined;
  const sweep = () => {
    running ??= sweepSmsReplies(deps)
      .catch(() => process.stderr.write('text replies could not be sent\n'))
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(sweep, intervalMs);
  timer.unref();
  return {
    poke: () => setTimeout(sweep, 250).unref(),
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
