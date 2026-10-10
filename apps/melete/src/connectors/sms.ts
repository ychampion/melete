import {
  type Action,
  type ConnectorHealth,
  type ConnectorManifest,
  type DispatchResult,
  e164Number,
  type SmsCredentials,
  smsCredentials,
  type VerifyResult,
} from '@melete/contracts';
import { z } from 'zod';
import type { SecretAccess } from './secrets.ts';
import { TwilioClient, TwilioFailure, type TwilioOptions } from './twilio.ts';
import type { Connector, ConnectorContext } from './types.ts';

/** Twilio's own ceiling for one message body. */
export const SMS_BODY_MAX = 1600;

const outgoing = z
  .object({
    to: e164Number,
    body: z.string().min(1).max(SMS_BODY_MAX),
  })
  .strict();

export const smsManifest: ConnectorManifest = {
  name: 'sms',
  version: '0.1.0',
  provider: 'twilio',
  description: 'Send an approved text message from your Twilio number.',
  credentials: [
    {
      key: 'twilio',
      description: 'Twilio account SID, auth token and sending number, sealed in the service.',
      secret: true,
    },
  ],
  health: true,
  tools: [
    {
      name: 'sms.send',
      description:
        'Send one text message to a phone number, written with + and the country code. It is sent once, after the person approves this exact text and number.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['to', 'body'],
        properties: {
          to: { type: 'string', pattern: '^\\+[1-9]\\d{6,14}$' },
          body: { type: 'string', minLength: 1, maxLength: SMS_BODY_MAX },
        },
      },
      effect_class: 'write_external',
      required_scopes: ['sms.send'],
      verify: true,
      requires_approval: true,
    },
  ],
};

export type SmsConnection = {
  id: string;
  spaceId: string;
  secretRef: string;
  twilio?: TwilioOptions;
};

/** Open the sealed Twilio credential for one piece of work, and keep nothing afterwards. */
export function withTwilio<T>(
  secrets: SecretAccess,
  connection: { secretRef: string; spaceId: string; twilio?: TwilioOptions },
  work: (client: TwilioClient, credentials: SmsCredentials) => Promise<T>,
): Promise<T> {
  return secrets.withSecret(connection.secretRef, connection.spaceId, async (value) => {
    const credentials = smsCredentials.parse(JSON.parse(value));
    return work(new TwilioClient(credentials, connection.twilio), credentials);
  });
}

/** How far back from the dispatch a message found at Twilio still counts as this one. */
const CLOCK_SLACK_MS = 2 * 60 * 1000;

export class SmsConnector implements Connector {
  readonly manifest = smsManifest;

  constructor(
    private readonly config: SmsConnection,
    private readonly secrets: SecretAccess,
  ) {}

  private use<T>(work: (client: TwilioClient) => Promise<T>): Promise<T> {
    return withTwilio(this.secrets, this.config, (client) => work(client));
  }

  private assertContext(action: Action, ctx: ConnectorContext): void {
    if (
      action.connection_id !== this.config.id ||
      ctx.space_id !== this.config.spaceId ||
      action.job_id !== ctx.job_id ||
      ctx.idempotency_key !== action.id ||
      action.idempotency_key !== action.id
    )
      throw new Error('Text action context mismatch');
    ctx.signal?.throwIfAborted();
  }

  async execute(action: Action, ctx: ConnectorContext): Promise<DispatchResult> {
    if (action.kind !== 'sms.send')
      return { outcome: 'failed', reason: 'Unknown text tool.', retryable: false };
    let dispatched = false;
    try {
      this.assertContext(action, ctx);
      const payload = outgoing.parse(action.canonical_payload);
      return await this.use(async (client) => {
        if (payload.to === client.from)
          return {
            outcome: 'failed' as const,
            reason: 'A text cannot be sent to the number it is sent from.',
            retryable: false,
          };
        ctx.signal?.throwIfAborted();
        dispatched = true;
        const sent = await client.send(payload.to, payload.body);
        return {
          outcome: 'succeeded' as const,
          receipt: {
            action_id: action.id,
            connection_id: action.connection_id,
            external_ref: sent.sid,
            detail: { message_sid: sent.sid, status: sent.status, to: payload.to },
            received_at: new Date().toISOString(),
            late: false,
          },
        };
      });
    } catch (error) {
      // Twilio refused it, or it never left: nothing was sent.
      if (!dispatched || (error instanceof TwilioFailure && error.code !== 'unavailable'))
        return {
          outcome: 'failed',
          reason:
            error instanceof TwilioFailure && error.code === 'credential_refused'
              ? 'Twilio refused the account SID or auth token. Reconnect text messages.'
              : error instanceof TwilioFailure && error.code === 'rate_limited'
                ? 'Twilio is sending too many texts for this account right now. Try again shortly.'
                : 'Twilio did not accept the text. Check the number and try again.',
          retryable: error instanceof TwilioFailure && error.code === 'rate_limited',
        };
      return {
        outcome: 'unknown',
        reason:
          'Twilio did not confirm the text. Check whether it arrived before sending it again.',
      };
    }
  }

  async verify(action: Action, ctx: ConnectorContext): Promise<VerifyResult> {
    if (action.kind !== 'sms.send')
      return { decision: 'unsupported', reason: 'Only a sent text can be checked.' };
    try {
      this.assertContext(action, ctx);
      const payload = outgoing.parse(action.canonical_payload);
      const since = Date.parse(action.dispatched_at ?? action.created_at) - CLOCK_SLACK_MS;
      const found = (await this.use((client) => client.sentTo(payload.to))).find(
        (row) =>
          row.body === payload.body &&
          row.date_created !== null &&
          Date.parse(row.date_created) >= since,
      );
      if (!found)
        return {
          decision: 'undecided',
          reason: 'Twilio lists no such text to that number since it was sent.',
        };
      if (['failed', 'undelivered', 'canceled'].includes(found.status))
        return {
          decision: 'failed',
          evidence: { message_sid: found.sid, status: found.status },
        };
      return {
        decision: 'succeeded',
        evidence: { message_sid: found.sid, status: found.status },
        receipt: {
          action_id: action.id,
          connection_id: action.connection_id,
          external_ref: found.sid,
          detail: { message_sid: found.sid, status: found.status, to: payload.to },
          received_at: new Date().toISOString(),
          late: false,
        },
      };
    } catch {
      return { decision: 'undecided', reason: 'Twilio could not be asked about the text.' };
    }
  }

  async health(): Promise<ConnectorHealth> {
    try {
      await this.use((client) => client.account());
      return {
        status: 'ok',
        detail: 'Twilio answered.',
        checked_at: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'failing',
        detail: 'Twilio is unavailable.',
        checked_at: new Date().toISOString(),
        ...(error instanceof TwilioFailure && error.code === 'credential_refused'
          ? { reason: 'credential_refused' as const }
          : {}),
      };
    }
  }
}

// --------------------------------------------------------------------------
// splitting a long answer into texts
// --------------------------------------------------------------------------

/** The GSM 03.38 basic set: each costs one of a segment's 160 septets. */
const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
/** The extension set: each costs two septets, an escape and the character. */
const GSM_EXTENDED = new Set('^{}\\[~]|€\f');

/**
 * What a text costs against one message's budget: septets when every
 * character is in the GSM alphabet, otherwise UTF-16 code units, which is how
 * a carrier sends anything else.
 */
function smsCost(text: string): { gsm: boolean; units: number } {
  let septets = 0;
  for (const character of text) {
    if (GSM_BASIC.has(character)) septets += 1;
    else if (GSM_EXTENDED.has(character)) septets += 2;
    else return { gsm: false, units: text.length };
  }
  return { gsm: true, units: septets };
}

/**
 * One text may be up to ten segments: 10 × 153 septets in the GSM alphabet, or
 * 10 × 67 UTF-16 units otherwise, both within Twilio's 1,600-character body.
 */
const MAX_GSM_UNITS = 1530;
const MAX_UCS2_UNITS = 670;
const fits = (text: string) => {
  const cost = smsCost(text);
  return cost.units <= (cost.gsm ? MAX_GSM_UNITS : MAX_UCS2_UNITS);
};

/** The longest head of `text` that fits, cut at a paragraph, a line, a sentence or a word. */
function head(text: string, room: (candidate: string) => boolean): string {
  if (room(text)) return text;
  // Grow by code points until it no longer fits, so a surrogate pair is never split.
  const points = [...text];
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (room(points.slice(0, middle).join(''))) low = middle;
    else high = middle - 1;
  }
  const hard = points.slice(0, Math.max(low, 1)).join('');
  let sentence = -1;
  for (const match of hard.matchAll(/[.!?]\s/g)) sentence = match.index + 1;
  // Where each kind of pause ends, best first.
  const cuts = [
    hard.lastIndexOf('\n\n') + 2,
    hard.lastIndexOf('\n') + 1,
    sentence,
    hard.lastIndexOf(' ') + 1,
  ];
  // A pause in the first third would leave a text too short to be worth its own message.
  const cut = cuts.find((at) => at > 0 && at >= hard.length / 3);
  return cut ? hard.slice(0, cut) : hard;
}

export const SMS_MORE_IN_APP = '(The rest is in Melete.)';

/**
 * A reply as texts: each within the size a phone reassembles into one
 * message, cut where a reader would pause, and no more than `maxParts` of
 * them. What does not fit is left in the conversation, and the last text says so.
 */
export function smsParts(text: string, maxParts = 3): string[] {
  const parts: string[] = [];
  let rest = text.replace(/\r\n?/g, '\n').trim();
  while (rest && parts.length < maxParts) {
    const last = parts.length === maxParts - 1;
    const part = head(rest, fits);
    if (last && part.length < rest.length) {
      const room = (candidate: string) => fits(`${candidate.trimEnd()}\n${SMS_MORE_IN_APP}`);
      parts.push(`${head(rest, room).trimEnd()}\n${SMS_MORE_IN_APP}`);
      break;
    }
    parts.push(part.trim());
    rest = rest.slice(part.length).trim();
  }
  return parts.filter(Boolean);
}
