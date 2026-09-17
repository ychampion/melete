import type {
  Action,
  ConnectorHealth,
  ConnectorManifest,
  DispatchResult,
  JsonObject,
  VerifyResult,
} from '@melete/contracts';
import { XMLParser } from 'fast-xml-parser';
import ICAL from 'ical.js';
import { z } from 'zod';
import { asConnectorFault, ConnectorFaultError } from './faults.ts';
import type { SecretAccess } from './secrets.ts';
import type { Connector, ConnectorContext } from './types.ts';

/**
 * `Retry-After` is either seconds or an HTTP date. Anything unreadable means
 * the server asked for a wait without saying how long, and the policy uses its
 * own default rather than inventing one here.
 */
function retryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isInteger(seconds) && seconds >= 0) return Math.min(seconds, 86_400);
  const at = Date.parse(header);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.min(Math.ceil((at - Date.now()) / 1000), 86_400));
}

export type CalendarConnection = {
  id: string;
  spaceId: string;
} & (
  | {
      mode: 'caldav';
      calendarUrl: string;
      username: string;
      secretRef: string;
      allowInsecureLocalForTests?: boolean;
    }
  | {
      mode: 'ics';
      /** An owner-imported file, never a URL supplied by a runtime. */
      ics: string;
    }
);

const MAX_CALENDAR_BYTES = 2 * 1024 * 1024;
const listPayload = z.object({ limit: z.number().int().min(1).max(100).default(50) }).strict();
const fields = {
  summary: z.string().min(1).max(1000),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  description: z.string().max(50_000).default(''),
  location: z.string().max(2000).default(''),
};
const createPayload = z
  .object(fields)
  .strict()
  .refine((v) => Date.parse(v.end) > Date.parse(v.start));
const updatePayload = z
  .object({
    ...fields,
    uid: z.string().regex(/^act_[A-Za-z0-9_-]+$/),
    etag: z
      .string()
      .min(1)
      .max(500)
      .regex(/^"[^"\r\n]+"$/),
  })
  .strict()
  .refine((v) => Date.parse(v.end) > Date.parse(v.start));
const deletePayload = z.strictObject({
  uid: z.string().regex(/^act_[A-Za-z0-9_-]+$/),
  etag: z
    .string()
    .min(1)
    .max(500)
    .regex(/^"[^"\r\n]+"$/),
});
const properties = {
  summary: { type: 'string', minLength: 1, maxLength: 1000 },
  start: { type: 'string', format: 'date-time' },
  end: { type: 'string', format: 'date-time' },
  description: { type: 'string', maxLength: 50000 },
  location: { type: 'string', maxLength: 2000 },
};

export const calendarManifest: ConnectorManifest = {
  name: 'calendar',
  version: '0.1.0',
  provider: 'caldav',
  description: 'Read imported ICS calendars or read and update an approved CalDAV calendar.',
  credentials: [
    {
      key: 'app_password',
      description: 'CalDAV app password, sealed in the service; unnecessary for an ICS import.',
      secret: true,
    },
  ],
  health: true,
  tools: [
    {
      name: 'calendar.delete',
      description: 'Remove a Melete-created event only if its observed ETag still matches.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['uid', 'etag'],
        properties: {
          uid: { type: 'string', pattern: '^act_[A-Za-z0-9_-]+$' },
          etag: { type: 'string', maxLength: 500 },
        },
      },
      effect_class: 'write_external',
      required_scopes: ['calendar.delete'],
      verify: true,
      requires_approval: true,
    },
    {
      name: 'calendar.list',
      description: 'List calendar event series, including recurrence rules.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
      },
      effect_class: 'read',
      required_scopes: ['calendar.list'],
      verify: false,
      requires_approval: false,
    },
    {
      name: 'calendar.create',
      description: 'Create an approved CalDAV event whose UID is the action ID.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'start', 'end'],
        properties,
      },
      effect_class: 'write_external',
      required_scopes: ['calendar.create'],
      verify: true,
      requires_approval: true,
    },
    {
      name: 'calendar.update',
      description: 'Update a Melete-created event by UID and its last observed ETag.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['uid', 'etag', 'summary', 'start', 'end'],
        properties: {
          ...properties,
          uid: { type: 'string', pattern: '^act_[A-Za-z0-9_-]+$' },
          etag: { type: 'string', maxLength: 500 },
        },
      },
      effect_class: 'write_external',
      required_scopes: ['calendar.update'],
      verify: true,
      requires_approval: true,
    },
  ],
};

type EventView = {
  uid: string;
  summary: string;
  start: string;
  end: string;
  description: string;
  location: string;
  recurrence: string | null;
  etag: string | null;
};

/** Parse structured ICS, including folded/escaped fields, without executing embedded URLs. */
export function importIcs(ics: string, etag: string | null = null): EventView[] {
  if (Buffer.byteLength(ics) > MAX_CALENDAR_BYTES) throw new Error('Calendar import too large');
  const component = new ICAL.Component(ICAL.parse(ics));
  if (component.name !== 'vcalendar') throw new Error('Expected VCALENDAR');
  return component.getAllSubcomponents('vevent').map((item) => {
    const event = new ICAL.Event(item);
    if (!event.uid || !event.startDate) throw new Error('Malformed calendar event');
    return {
      uid: event.uid,
      summary: event.summary ?? '',
      start: event.startDate.toString(),
      end: event.endDate.toString(),
      description: event.description ?? '',
      location: event.location ?? '',
      recurrence: item.getFirstPropertyValue('rrule')?.toString() ?? null,
      etag,
    };
  });
}

function eventIcs(action: Action, uid: string, payload: z.infer<typeof createPayload>): string {
  const calendar = new ICAL.Component('vcalendar');
  calendar.updatePropertyWithValue('version', '2.0');
  calendar.updatePropertyWithValue('prodid', '-//Melete//Calendar//EN');
  const component = new ICAL.Component('vevent');
  component.updatePropertyWithValue('uid', uid);
  component.updatePropertyWithValue(
    'dtstamp',
    ICAL.Time.fromJSDate(new Date(action.created_at), true),
  );
  component.updatePropertyWithValue('dtstart', ICAL.Time.fromJSDate(new Date(payload.start), true));
  component.updatePropertyWithValue('dtend', ICAL.Time.fromJSDate(new Date(payload.end), true));
  component.updatePropertyWithValue('summary', payload.summary);
  component.updatePropertyWithValue('description', payload.description);
  component.updatePropertyWithValue('location', payload.location);
  component.updatePropertyWithValue('x-melete-action-id', action.id);
  component.updatePropertyWithValue('x-melete-payload-hash', action.payload_hash);
  calendar.addSubcomponent(component);
  return `${calendar.toString()}\r\n`;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const array = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** Shared with the calendar feed reader so both stop at the same size. */
export async function boundedText(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length') ?? '0') > MAX_CALENDAR_BYTES)
    throw new Error('Calendar response too large');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_CALENDAR_BYTES) throw new Error('Calendar response too large');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class CalendarConnector implements Connector {
  readonly manifest: ConnectorManifest;
  private readonly base: URL | null;

  constructor(
    private readonly config: CalendarConnection,
    private readonly secrets: SecretAccess,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.manifest =
      config.mode === 'ics'
        ? {
            ...calendarManifest,
            credentials: [],
            tools: calendarManifest.tools.filter((tool) => tool.name === 'calendar.list'),
          }
        : calendarManifest;
    this.base = config.mode === 'caldav' ? new URL(config.calendarUrl) : null;
    if (this.base && config.mode === 'caldav') {
      const local =
        config.allowInsecureLocalForTests &&
        ['127.0.0.1', '[::1]', 'localhost'].includes(this.base.hostname);
      if (
        (this.base.protocol !== 'https:' && !(local && this.base.protocol === 'http:')) ||
        this.base.username ||
        this.base.password ||
        this.base.search ||
        this.base.hash
      )
        throw new Error('CalDAV requires a trusted HTTPS calendar URL');
      if (!this.base.pathname.endsWith('/')) this.base.pathname += '/';
    }
    if (config.mode === 'ics') importIcs(config.ics);
  }

  private assertContext(action: Action, ctx: ConnectorContext): void {
    if (
      action.connection_id !== this.config.id ||
      ctx.space_id !== this.config.spaceId ||
      action.job_id !== ctx.job_id ||
      ctx.idempotency_key !== action.id ||
      action.idempotency_key !== action.id
    )
      throw new Error('Calendar action context mismatch');
    ctx.signal?.throwIfAborted();
  }

  private request(
    method: string,
    uid: string | null,
    body: string | null,
    ctx?: ConnectorContext,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const config = this.config;
    if (config.mode !== 'caldav' || !this.base) throw new Error('Imported calendars are read-only');
    if (uid && !/^act_[A-Za-z0-9_-]+$/.test(uid)) throw new Error('Invalid calendar UID');
    const url = uid ? new URL(`${encodeURIComponent(uid)}.ics`, this.base) : this.base;
    return this.secrets.withSecret(config.secretRef, config.spaceId, (password) =>
      this.fetcher(url, {
        method,
        headers: {
          ...headers,
          authorization: `Basic ${Buffer.from(`${config.username}:${password}`).toString('base64')}`,
        },
        body,
        redirect: 'error',
        signal: ctx?.signal
          ? AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      }),
    );
  }

  private success(action: Action, detail: JsonObject, uid: string | null = null): DispatchResult {
    return {
      outcome: 'succeeded',
      receipt: {
        action_id: action.id,
        connection_id: action.connection_id,
        external_ref: uid,
        detail,
        received_at: new Date().toISOString(),
        late: false,
      },
    };
  }

  async execute(action: Action, ctx: ConnectorContext): Promise<DispatchResult> {
    let dispatched = false;
    try {
      this.assertContext(action, ctx);
      if (action.kind === 'calendar.list') {
        const payload = listPayload.parse(action.canonical_payload);
        if (this.config.mode === 'ics')
          return this.success(action, {
            events: importIcs(this.config.ics).slice(0, payload.limit),
            read_only: true,
          });
        const response = await this.request(
          'REPORT',
          null,
          '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>',
          ctx,
          { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
        );
        if (response.status !== 207) {
          await response.body?.cancel();
          throw new Error('CalDAV listing unavailable');
        }
        const xml = await boundedText(response);
        if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML declarations are not accepted');
        const parsed: unknown = new XMLParser({
          removeNSPrefix: true,
          ignoreAttributes: true,
        }).parse(xml);
        const events: EventView[] = [];
        for (const item of array(object(object(parsed).multistatus).response)) {
          for (const propstat of array(object(item).propstat)) {
            const prop = object(object(propstat).prop);
            if (
              typeof prop['calendar-data'] === 'string' &&
              /\s200\s/.test(String(object(propstat).status))
            ) {
              events.push(
                ...importIcs(
                  prop['calendar-data'],
                  typeof prop.getetag === 'string' ? prop.getetag : null,
                ),
              );
            }
          }
        }
        return this.success(action, { events: events.slice(0, payload.limit), read_only: false });
      }
      if (this.config.mode === 'ics')
        return {
          outcome: 'failed',
          reason: 'Imported ICS calendars are read-only.',
          retryable: false,
        };
      if (action.kind === 'calendar.delete') {
        const payload = deletePayload.parse(action.canonical_payload);
        dispatched = true;
        const response = await this.request('DELETE', payload.uid, null, ctx, {
          'if-match': payload.etag,
        });
        await response.body?.cancel();
        if (response.status >= 200 && response.status < 300)
          return this.success(action, { uid: payload.uid, removed: true }, payload.uid);
        return [401, 403, 404, 409, 412].includes(response.status)
          ? {
              outcome: 'failed',
              reason: 'The event changed or could not be removed.',
              retryable: false,
            }
          : { outcome: 'unknown', reason: 'Removal was not confirmed. Check the calendar.' };
      }
      if (action.kind !== 'calendar.create' && action.kind !== 'calendar.update')
        return { outcome: 'failed', reason: 'Unknown calendar tool.', retryable: false };
      const update =
        action.kind === 'calendar.update' ? updatePayload.parse(action.canonical_payload) : null;
      const payload = update ?? createPayload.parse(action.canonical_payload);
      const uid = update?.uid ?? action.id;
      const ics = eventIcs(action, uid, payload);
      const condition: Record<string, string> = update
        ? { 'if-match': update.etag }
        : { 'if-none-match': '*' };
      dispatched = true;
      const response = await this.request('PUT', uid, ics, ctx, {
        'content-type': 'text/calendar; charset=utf-8',
        ...condition,
      });
      await response.body?.cancel();
      if (response.status >= 200 && response.status < 300)
        return this.success(
          action,
          { uid, etag: response.headers.get('etag'), action_id: action.id },
          uid,
        );
      // Three statuses mean something specific enough to repair rather than
      // report. All three are definitive non-execution: the server answered
      // the write and did not perform it.
      if (response.status === 429) {
        throw new ConnectorFaultError({
          kind: 'rate_limited',
          detail: 'the calendar server asked to be left alone for a while',
          retry_after: retryAfterSeconds(response.headers.get('retry-after')),
        });
      }
      if (response.status === 401) {
        throw new ConnectorFaultError({
          kind: 'expired_credential',
          detail: 'the calendar server refused the credential this write carried',
        });
      }
      if (response.status === 403) {
        throw new ConnectorFaultError({
          kind: 'revoked_credential',
          detail: 'the calendar server no longer permits this account to write',
        });
      }
      if ([400, 404, 409, 412, 415, 422].includes(response.status))
        return {
          outcome: 'failed',
          reason: `Calendar server rejected the write (${response.status}).`,
          retryable: false,
        };
      return {
        outcome: 'unknown',
        reason: 'Calendar write was not confirmed. Verify its UID before deciding.',
      };
    } catch (error) {
      // A typed fault has already said what happened; do not flatten it into a
      // guess about the outcome.
      if (asConnectorFault(error)) throw error;
      return dispatched
        ? {
            outcome: 'unknown',
            reason: 'Calendar write was not acknowledged. Verify its UID before deciding.',
          }
        : {
            outcome: 'failed',
            reason: 'Calendar request rejected or connection unavailable.',
            retryable: false,
          };
    }
  }

  async verify(action: Action, ctx: ConnectorContext): Promise<VerifyResult> {
    if (this.config.mode === 'caldav' && action.kind === 'calendar.delete') {
      try {
        this.assertContext(action, ctx);
        const payload = deletePayload.parse(action.canonical_payload);
        const response = await this.request('GET', payload.uid, null, ctx);
        await response.body?.cancel();
        // Absence proves the desired state, but cannot attribute an uncertain deletion.
        return {
          decision: 'undecided',
          reason:
            response.status === 404
              ? 'The event is absent, but this removal has no acknowledgement.'
              : 'The event removal could not be confirmed.',
        };
      } catch {
        return { decision: 'undecided', reason: 'Calendar verification unavailable.' };
      }
    }
    if (this.config.mode === 'ics' || !['calendar.create', 'calendar.update'].includes(action.kind))
      return {
        decision: 'unsupported',
        reason: 'This calendar operation has no external verification.',
      };
    try {
      this.assertContext(action, ctx);
      const update =
        action.kind === 'calendar.update' ? updatePayload.parse(action.canonical_payload) : null;
      const payload = update ?? createPayload.parse(action.canonical_payload);
      const uid = update?.uid ?? action.id;
      const response = await this.request('GET', uid, null, ctx);
      if (!response.ok) {
        await response.body?.cancel();
        return {
          decision: 'undecided',
          reason:
            'Calendar UID unavailable; absence cannot establish whether a write previously happened.',
        };
      }
      const calendar = new ICAL.Component(ICAL.parse(await boundedText(response)));
      const events = calendar.getAllSubcomponents('vevent');
      const found = events.find((component) => {
        const event = new ICAL.Event(component);
        return (
          event.uid === uid &&
          component.getFirstPropertyValue('x-melete-action-id') === action.id &&
          component.getFirstPropertyValue('x-melete-payload-hash') === action.payload_hash &&
          event.summary === payload.summary &&
          (event.description ?? '') === payload.description &&
          (event.location ?? '') === payload.location &&
          event.startDate.toUnixTime() * 1000 === Date.parse(payload.start) &&
          event.endDate.toUnixTime() * 1000 === Date.parse(payload.end)
        );
      });
      if (!found)
        return {
          decision: 'undecided',
          reason: 'Calendar resource does not confirm this exact action and payload.',
        };
      const result = this.success(action, { uid, verified_action_id: action.id }, uid);
      return {
        decision: 'succeeded',
        evidence: { uid, action_id: action.id, payload_hash: action.payload_hash },
        receipt: result.outcome === 'succeeded' ? result.receipt : null,
      };
    } catch {
      return { decision: 'undecided', reason: 'Calendar verification unavailable.' };
    }
  }

  async health(): Promise<ConnectorHealth> {
    try {
      if (this.config.mode === 'ics') importIcs(this.config.ics);
      else {
        const response = await this.request(
          'PROPFIND',
          null,
          '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
          undefined,
          { depth: '0', 'content-type': 'application/xml' },
        );
        await response.body?.cancel();
        if (response.status !== 207) throw new Error('Calendar unavailable');
      }
      return {
        status: 'ok',
        detail: 'Calendar is available.',
        checked_at: new Date().toISOString(),
      };
    } catch {
      return {
        status: 'failing',
        detail: 'Calendar connection unavailable.',
        checked_at: new Date().toISOString(),
      };
    }
  }
}
