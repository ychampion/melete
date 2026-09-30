/**
 * A notetaker for Zoom, Google Meet and Microsoft Teams calls, through
 * Recall.ai.
 *
 * `meeting.join` is an external effect the person approves first, and the
 * approval is bound to the bytes it showed: the meeting link, the name the
 * notetaker appears under, when it joins and the chat message it posts on
 * arrival. The service writes the name and the message itself before the
 * payload is hashed, so the model cannot make the notetaker look like anyone
 * but a notetaker, and a changed link is a different effect that needs its own
 * approval.
 *
 * Joining only starts the work. The notes come back later, through
 * `meetings/notes.ts`, which reads the row this connector writes.
 */
import type {
  Action,
  ConnectorHealth,
  ConnectorManifest,
  DispatchResult,
  JsonObject,
  MeetingsConnectionConfig,
  Receipt,
  VerifyResult,
} from '@melete/contracts';
import { meetingsCredentials } from '@melete/contracts';
import type { Query } from '../broker/records.ts';
import { type Fetcher, RecallClient, RecallError } from '../meetings/recall.ts';
import { ConnectorFaultError } from './faults.ts';
import type { SecretAccess } from './secrets.ts';
import type { Connector, ConnectorContext } from './types.ts';

/** A scheduled notetaker joins at most this far ahead. */
const MAX_LEAD_MS = 30 * 24 * 60 * 60 * 1000;
/** A time this close to now, or already past, means "join now". */
const NOW_WINDOW_MS = 60_000;
const BOT_NAME_LIMIT = 100;

export const meetingsManifest: ConnectorManifest = {
  name: 'meetings',
  version: '0.1.0',
  provider: 'meetings',
  description:
    'Send a notetaker into a Zoom, Google Meet or Microsoft Teams call. The transcript, a summary, decisions and follow-ups come back to this conversation when the meeting ends.',
  credentials: [
    {
      key: 'api_key',
      description: 'The Recall.ai API key, sealed in the service.',
      secret: true,
    },
  ],
  health: true,
  tools: [
    {
      name: 'meeting.join',
      description:
        'Send a notetaker into a Zoom, Google Meet or Microsoft Teams meeting, now or at a set time. It announces itself in the meeting chat and records the call. The notes arrive in this conversation after the meeting ends; do not wait for them.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['meeting_url'],
        properties: {
          meeting_url: {
            type: 'string',
            maxLength: 2048,
            description: 'The meeting link, as shared in the invitation.',
          },
          join_at: {
            type: 'string',
            maxLength: 40,
            description:
              'When to join, as an ISO 8601 time with its offset. Leave it out to join now.',
          },
          bot_name: {
            type: 'string',
            maxLength: BOT_NAME_LIMIT,
            description:
              'The name the notetaker shows in the meeting. Leave it out for the usual one.',
          },
          announcement: {
            type: 'string',
            maxLength: 500,
            description: 'Written by the service; anything given here is replaced.',
          },
        },
      },
      effect_class: 'write_external',
      required_scopes: ['meeting.join'],
      verify: true,
      requires_approval: true,
    },
  ],
};

/** The platforms a notetaker can join, by the host of the link. */
export function meetingPlatform(url: URL): 'Zoom' | 'Google Meet' | 'Microsoft Teams' | null {
  const host = url.hostname.toLowerCase();
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'Zoom';
  if (host === 'meet.google.com') return 'Google Meet';
  if (host === 'teams.microsoft.com' || host === 'teams.live.com') return 'Microsoft Teams';
  return null;
}

/** A link a notetaker may be sent to, or a plain-words reason it may not. */
export function meetingLink(value: unknown): URL {
  if (typeof value !== 'string' || !URL.canParse(value.trim()))
    throw new Error('The meeting link is not a web address.');
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    throw new Error('The meeting link must be an ordinary https:// meeting address.');
  if (!meetingPlatform(url))
    throw new Error('The notetaker joins Zoom, Google Meet and Microsoft Teams meetings only.');
  url.hash = '';
  return url;
}

/** The name the notetaker shows: it always says it is a notetaker, and for whom. */
export function notetakerName(person: string, requested?: unknown): string {
  const who = person.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  const fallback = who ? `Notetaker for ${who}` : 'Melete notetaker';
  const asked = typeof requested === 'string' ? requested.replace(/[\p{Cc}\s]+/gu, ' ').trim() : '';
  const name = !asked ? fallback : /notetaker/i.test(asked) ? asked : `${asked} (notetaker)`;
  return name.slice(0, BOT_NAME_LIMIT);
}

/** What the notetaker posts in the meeting chat as it joins, so nobody is recorded unawares. */
export function announcementFor(botName: string, person: string): string {
  const who = person.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  return `${botName} has joined to take notes${who ? ` for ${who}` : ''}. This meeting is being recorded and transcribed.`;
}

export type PreparedJoin = {
  meeting_url: string;
  bot_name: string;
  announcement: string;
  join_at?: string;
};

/** The approved payload, read back strictly: it was written by `prepare`. */
export function preparedJoin(payload: JsonObject): PreparedJoin {
  const url = meetingLink(payload.meeting_url).toString();
  if (typeof payload.bot_name !== 'string' || typeof payload.announcement !== 'string')
    throw new Error('meeting.join payload was not prepared');
  if (payload.join_at !== undefined && typeof payload.join_at !== 'string')
    throw new Error('meeting.join payload was not prepared');
  return {
    meeting_url: url,
    bot_name: payload.bot_name,
    announcement: payload.announcement,
    ...(typeof payload.join_at === 'string' ? { join_at: payload.join_at } : {}),
  };
}

export type MeetingsConnectorOptions = {
  id: string;
  spaceId: string;
  secretRef: string;
  config: MeetingsConnectionConfig;
  secrets: SecretAccess;
  sql: Query;
  fetcher?: Fetcher;
  now?: () => number;
};

export class MeetingsConnector implements Connector {
  readonly manifest = meetingsManifest;

  constructor(private readonly options: MeetingsConnectorOptions) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private assertContext(action: Action, ctx: ConnectorContext): void {
    if (
      action.connection_id !== this.options.id ||
      ctx.space_id !== this.options.spaceId ||
      action.job_id !== ctx.job_id ||
      ctx.idempotency_key !== action.id ||
      action.idempotency_key !== action.id
    )
      throw new Error('Meeting action context mismatch');
    ctx.signal?.throwIfAborted();
  }

  private async client(): Promise<{ client: RecallClient; scribe: boolean }> {
    return this.options.secrets.withSecret(
      this.options.secretRef,
      this.options.spaceId,
      async (sealed) => {
        const credentials = meetingsCredentials.parse(JSON.parse(sealed));
        return {
          client: new RecallClient(
            this.options.config.region,
            credentials.api_key,
            this.options.fetcher,
          ),
          scribe: Boolean(credentials.elevenlabs_api_key),
        };
      },
    );
  }

  /**
   * Resolve everything the person approves before it is hashed: the checked
   * link, the notetaker's name, the chat announcement and the join time.
   */
  async prepare(payload: JsonObject, ctx: ConnectorContext, tx: Query): Promise<JsonObject> {
    if (ctx.space_id !== this.options.spaceId) throw new Error('Meeting action context mismatch');
    const url = meetingLink(payload.meeting_url);
    const [profile] =
      await tx`select name from experience_profile where space_id = ${ctx.space_id}`;
    const person = typeof profile?.name === 'string' ? profile.name : '';
    const botName = notetakerName(person, payload.bot_name);
    let joinAt: string | undefined;
    if (payload.join_at !== undefined) {
      const at = typeof payload.join_at === 'string' ? Date.parse(payload.join_at) : Number.NaN;
      if (!Number.isFinite(at)) throw new Error('The join time is not a date and time.');
      if (at - this.now() > MAX_LEAD_MS)
        throw new Error('The notetaker can be scheduled at most 30 days ahead.');
      if (at - this.now() > NOW_WINDOW_MS) joinAt = new Date(at).toISOString();
    }
    return {
      meeting_url: url.toString(),
      bot_name: botName,
      announcement: announcementFor(botName, person),
      ...(joinAt ? { join_at: joinAt } : {}),
    };
  }

  private receipt(action: Action, botId: string, join: PreparedJoin): Receipt {
    const url = new URL(join.meeting_url);
    return {
      action_id: action.id,
      connection_id: action.connection_id,
      external_ref: botId,
      detail: {
        bot_id: botId,
        platform: meetingPlatform(url) ?? 'Meeting',
        bot_name: join.bot_name,
        join_at: join.join_at ?? null,
        notes: 'The notes come back to this conversation after the meeting ends.',
      },
      received_at: new Date(this.now()).toISOString(),
      late: false,
    };
  }

  async execute(action: Action, ctx: ConnectorContext): Promise<DispatchResult> {
    this.assertContext(action, ctx);
    const join = preparedJoin(action.canonical_payload);
    // This action already has its notetaker: the same approval never makes two.
    const [existing] = await this.options.sql`select bot_id from meeting_bot
      where action_id = ${action.id}`;
    if (existing)
      return { outcome: 'succeeded', receipt: this.receipt(action, existing.bot_id, join) };
    const { client, scribe } = await this.client();
    let botId: string;
    try {
      const bot = await client.createBot(
        {
          meeting_url: join.meeting_url,
          bot_name: join.bot_name,
          ...(join.join_at ? { join_at: join.join_at } : {}),
          transcription: scribe ? 'recording' : 'recall',
          announcement: join.announcement,
          metadata: { melete_action: action.id },
        },
        ctx.signal,
      );
      botId = bot.id;
    } catch (error) {
      if (!(error instanceof RecallError)) throw error;
      if (error.refused)
        throw new ConnectorFaultError({
          kind: 'revoked_credential',
          detail: 'Recall.ai refused the API key. Check the key in the meetings connection.',
        });
      if (error.status === 429)
        throw new ConnectorFaultError({
          kind: 'rate_limited',
          detail: 'Recall.ai asked to be left alone for a while.',
        });
      if (error.status !== null && error.status >= 400 && error.status < 500)
        return {
          outcome: 'failed',
          reason: `Recall.ai would not send a notetaker to that meeting (${error.status}). Check the link and the time.`,
          retryable: false,
        };
      // No answer, or a server error after the request left: the bot may exist.
      return {
        outcome: 'unknown',
        reason:
          'Recall.ai did not confirm the notetaker. Check the Recall.ai dashboard before asking again.',
      };
    }
    const firstCheck = join.join_at
      ? new Date(Math.max(Date.parse(join.join_at), this.now() + NOW_WINDOW_MS))
      : new Date(this.now() + NOW_WINDOW_MS);
    await this.options.sql`insert into meeting_bot
      (action_id, connection_id, space_id, job_id, bot_id, meeting_url, bot_name, join_at, next_check_at)
      values (${action.id}, ${this.options.id}, ${this.options.spaceId}, ${action.job_id}, ${botId},
        ${join.meeting_url}, ${join.bot_name}, ${join.join_at ?? null}, ${firstCheck.toISOString()})
      on conflict (action_id) do nothing`;
    return { outcome: 'succeeded', receipt: this.receipt(action, botId, join) };
  }

  async verify(action: Action): Promise<VerifyResult> {
    const [row] = await this.options.sql`select bot_id from meeting_bot
      where action_id = ${action.id} and connection_id = ${this.options.id}`;
    if (row)
      return {
        decision: 'succeeded',
        evidence: { bot_id: row.bot_id },
        receipt: this.receipt(action, row.bot_id, preparedJoin(action.canonical_payload)),
      };
    return {
      decision: 'undecided',
      reason:
        'This service has no record of the notetaker. Check the Recall.ai dashboard to see whether it was created.',
    };
  }

  async health(): Promise<ConnectorHealth> {
    const checked_at = new Date(this.now()).toISOString();
    try {
      const { client } = await this.client();
      await client.probe(AbortSignal.timeout(20_000));
      return { status: 'ok', detail: 'Recall.ai accepted the key.', checked_at };
    } catch (error) {
      if (error instanceof RecallError && error.refused)
        return {
          status: 'failing',
          detail: 'Recall.ai refused the key.',
          checked_at,
          reason: 'credential_refused',
        };
      return { status: 'failing', detail: 'Recall.ai could not be reached.', checked_at };
    }
  }
}
