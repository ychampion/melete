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
import { BrokerFault } from '../broker/errors.ts';
import type { Query } from '../broker/records.ts';
import { confirmFromIcs, expandIcs, instantMs } from '../signals/occurrences.ts';
import {
  type CalendarOccurrences,
  type Occurrence,
  type SignalSource,
  sourceError,
} from '../signals/types.ts';
import {
  bindCalendarCheck,
  calendarAhead,
  calendarAsksFirst,
  checkCalendarAhead,
  clearToWrite,
  freeBusy,
  invited,
  MAX_FREEBUSY_DAYS,
} from './calendar-truth.ts';
import { asConnectorFault, ConnectorFaultError } from './faults.ts';
import type { SecretAccess } from './secrets.ts';
import type { Connector, ConnectorContext } from './types.ts';

/**
 * `Retry-After` is either seconds or an HTTP date. Anything unreadable means
 * the server asked for a wait without saying how long, and the policy uses its
 * own default rather than inventing one here.
 */
export function retryAfterSeconds(header: string | null): number | null {
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

export const MAX_CALENDAR_BYTES = 2 * 1024 * 1024;
/** How far ahead a listing looks when the caller names no end. */
export const DEFAULT_LIST_DAYS = 90;
const DAY_MS = 86_400_000;
const instant = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);
export const listPayload = z
  .object({
    limit: z.number().int().min(1).max(100).default(50),
    from: instant.optional(),
    to: instant.optional(),
  })
  .strict()
  .refine((v) => !v.from || !v.to || Date.parse(v.to) > Date.parse(v.from), {
    message: '`to` must be after `from`',
  });

export type ListWindow = { from: string; to: string };

/**
 * The window a listing covers. With neither end it starts yesterday, so an
 * event that is under way is still listed, and ends {@link DEFAULT_LIST_DAYS}
 * days later. With only `to`, it is the {@link DEFAULT_LIST_DAYS} days before
 * `to`, so an end in the past never makes an empty, inverted window; with only
 * `from`, it is the same span after `from`. The receipt always carries the
 * window, so whoever reads it knows what was and was not looked at.
 */
export function listWindow(payload: z.infer<typeof listPayload>, now = Date.now()): ListWindow {
  const span = DEFAULT_LIST_DAYS * DAY_MS;
  const to = payload.to
    ? Date.parse(payload.to)
    : (payload.from ? Date.parse(payload.from) : now - DAY_MS) + span;
  const from = payload.from ? Date.parse(payload.from) : payload.to ? to - span : now - DAY_MS;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** Events earliest first; one whose start cannot be read goes last. */
export function byStart(events: EventView[]): EventView[] {
  const at = (event: EventView) => {
    const time = Date.parse(event.start);
    return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
  };
  return [...events].sort((a, b) => at(a) - at(b));
}

/**
 * The receipt detail of a listing. `truncated` says more events fall in the
 * window than were returned, so the list must not be presented as complete.
 */
export function listDetail(
  events: EventView[],
  window: ListWindow,
  truncated: boolean,
  readOnly: boolean,
): JsonObject {
  return {
    events,
    read_only: readOnly,
    window,
    truncated,
    ...(truncated
      ? {
          note: `Only the first ${events.length} events in this window are listed; more exist. Ask again with a narrower from/to before treating the list as complete.`,
        }
      : {}),
  };
}
const fields = {
  summary: z.string().min(1).max(1000),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  description: z.string().max(50_000).default(''),
  location: z.string().max(2000).default(''),
  /** Guests to invite, by address. Anyone outside the person's own accounts is asked about first. */
  attendees: z.array(z.email().max(320)).max(50).optional(),
  /** A hold: the time is kept, marked tentative, until it is confirmed or released. */
  tentative: z.boolean().optional(),
  /** Asked for only when the person wants this on top of something already there. */
  double_book: z.strictObject({ reason: z.string().trim().min(1).max(500) }).optional(),
  /** Bound by Melete before anyone is asked (see `bindCalendarCheck`); never the agent's. */
  checked: z.record(z.string(), z.unknown()).optional(),
};
export const createPayload = z
  .object(fields)
  .strict()
  .refine((v) => Date.parse(v.end) > Date.parse(v.start));
export const updatePayload = z
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
export type WritePayload = z.infer<typeof createPayload>;
export const deletePayload = z.strictObject({
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
  attendees: {
    type: 'array',
    maxItems: 50,
    items: { type: 'string', maxLength: 320 },
    description:
      'Email addresses to invite. Inviting anyone outside the person’s own accounts asks the person first. Leave it out to put the event on their calendar only.',
  },
  tentative: {
    type: 'boolean',
    description:
      'true places a hold: the time is kept and marked tentative. Confirm it later with calendar.update and tentative false, or release it with calendar.delete.',
  },
  double_book: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
    description:
      'Only when the person wants this on top of an event already there. The person is asked, with the reason.',
  },
  checked: {
    type: 'object',
    additionalProperties: true,
    description: 'Filled in by Melete. Leave it out.',
  },
};

/**
 * A free/busy read: a window of at most 62 days, and the zone all-day events are placed in.
 * The window is `start` and `end`: `from` and `to` are address fields to the
 * broker, which compares them in lower case.
 */
export const freebusyPayload = z
  .object({
    start: instant,
    end: instant,
    time_zone: z.string().min(1).max(100).optional(),
    /** Bound by Melete before the read; never the agent's. */
    checked: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((v) => instantMs(v.end) > instantMs(v.start), { message: '`end` must be after `start`' })
  .refine((v) => instantMs(v.end) - instantMs(v.start) <= MAX_FREEBUSY_DAYS * DAY_MS, {
    message: `a window of at most ${MAX_FREEBUSY_DAYS} days`,
  });

/** Free and busy time in a window, as the free/busy tool answers it. */
export async function freebusyDetail(
  source: CalendarOccurrences,
  payload: z.infer<typeof freebusyPayload>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const window = {
    from: new Date(instantMs(payload.start)).toISOString(),
    to: new Date(instantMs(payload.end)).toISOString(),
  };
  const self = payload.checked?.self;
  const found = await freeBusy(source, window, payload.time_zone ?? 'UTC', {
    ...(signal ? { signal } : {}),
    ...(Array.isArray(self)
      ? { self: self.filter((value): value is string => typeof value === 'string') }
      : {}),
  });
  return {
    ...found,
    ...(found.complete
      ? {}
      : {
          note: 'The calendar has more events in this window than one read covers. Ask again for a shorter window before treating any time as free.',
        }),
  } as unknown as JsonObject;
}
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
      description:
        'List events and series (with recurrence rules) between `from` and `to`, earliest first. Defaults: yesterday to 90 days later; one end alone covers the 90 days after `from` or before `to`. The result names its window. If `truncated` is true more events exist than were returned: list again with a narrower window before calling the list complete.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          from: {
            type: 'string',
            description: 'Start of the window, an ISO date or date-time. Defaults to yesterday.',
          },
          to: {
            type: 'string',
            description:
              'End of the window, an ISO date or date-time after `from`. Defaults to 90 days after `from`.',
          },
        },
      },
      effect_class: 'read',
      required_scopes: ['calendar.list'],
      verify: false,
      requires_approval: false,
    },
    {
      name: 'calendar.freebusy',
      description:
        'When the person is busy and free between `start` and `end` (at most 62 days), every repeating event counted. Each busy block names its event and says busy or tentative; events shown as free and invitations they declined leave the time free. All-day events fill the person’s own day. Check this before proposing or booking a time.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end'],
        properties: {
          start: { type: 'string', description: 'Start of the window, an ISO date or date-time.' },
          end: { type: 'string', description: 'End of the window, after `start`.' },
          time_zone: {
            type: 'string',
            description: 'IANA zone for all-day events. Defaults to the person’s own.',
          },
          checked: {
            type: 'object',
            additionalProperties: true,
            description: 'Filled in by Melete. Leave it out.',
          },
        },
      },
      effect_class: 'read',
      required_scopes: ['calendar.freebusy'],
      verify: false,
      requires_approval: false,
    },
    {
      name: 'calendar.create',
      description:
        'Create an event whose UID is the action ID. A time already taken is refused, naming what is there. `attendees` invites people; `tentative` places a hold.',
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
      description:
        'Update a Melete-created event by UID and its last observed ETag. Moving it onto a taken time is refused. `tentative: false` confirms a hold.',
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

/** The receipt of a create or update: the event, its version, and whether it is a hold or invites anyone. */
export function writeDetail(
  uid: string,
  etag: string | null,
  action: Pick<Action, 'id'>,
  payload: WritePayload,
): JsonObject {
  const guests = invited(payload as JsonObject);
  return {
    uid,
    etag,
    action_id: action.id,
    tentative: payload.tentative === true,
    ...(guests.length ? { attendees: guests } : {}),
  };
}

/** The tools a read-only calendar (an import or a feed) offers. */
export const READ_TOOLS = new Set(['calendar.list', 'calendar.freebusy']);

export type EventView = {
  uid: string;
  summary: string;
  start: string;
  end: string;
  description: string;
  location: string;
  recurrence: string | null;
  etag: string | null;
};

type ParsedEvent = { view: EventView; event: ICAL.Event };

/** Parse structured ICS, including folded/escaped fields, without executing embedded URLs. */
export function importIcs(ics: string, etag: string | null = null): EventView[] {
  return parseIcs(ics, etag).map((parsed) => parsed.view);
}

/** Most occurrences a series is walked through looking for one inside the window. */
const MAX_OCCURRENCES = 5000;

/**
 * When an event or series first touches the window, in epoch milliseconds, or
 * null when it never does. A series too long to walk is kept rather than
 * dropped, placed at the start of the window.
 */
function firstInWindow(event: ICAL.Event, from: number, to: number): number | null {
  const first = event.startDate.toJSDate().getTime();
  const length = Math.max(0, (event.endDate?.toJSDate().getTime() ?? first) - first);
  const touches = (start: number) => start < to && (start + length > from || start >= from);
  if (!event.isRecurring()) return touches(first) ? first : null;
  const occurrences = event.iterator();
  for (let step = 0; step < MAX_OCCURRENCES; step++) {
    const next = occurrences.next();
    if (!next) return null;
    const start = next.toJSDate().getTime();
    if (start >= to) return null;
    if (touches(start)) return start;
  }
  return from;
}

/** The events in a window, earliest first, and whether any were left out. */
export function eventsInWindow(
  parsed: ParsedEvent[],
  window: ListWindow,
  limit: number,
): { events: EventView[]; truncated: boolean } {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  const inside = parsed
    .flatMap(({ view, event }) => {
      const at = firstInWindow(event, from, to);
      return at === null ? [] : [{ view, at }];
    })
    .sort((a, b) => a.at - b.at);
  return {
    events: inside.slice(0, limit).map((item) => item.view),
    truncated: inside.length > limit,
  };
}

export function parseIcs(ics: string, etag: string | null = null): ParsedEvent[] {
  if (Buffer.byteLength(ics) > MAX_CALENDAR_BYTES) throw new Error('Calendar import too large');
  const component = new ICAL.Component(ICAL.parse(ics));
  if (component.name !== 'vcalendar') throw new Error('Expected VCALENDAR');
  return component.getAllSubcomponents('vevent').map((item) => {
    const event = new ICAL.Event(item);
    if (!event.uid || !event.startDate) throw new Error('Malformed calendar event');
    const view: EventView = {
      uid: event.uid,
      summary: event.summary ?? '',
      start: event.startDate.toString(),
      end: event.endDate.toString(),
      description: event.description ?? '',
      location: event.location ?? '',
      recurrence: item.getFirstPropertyValue('rrule')?.toString() ?? null,
      etag,
    };
    return { view, event };
  });
}

function eventIcs(
  action: Action,
  uid: string,
  payload: WritePayload,
  organizer: string | null,
): string {
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
  component.updatePropertyWithValue('status', payload.tentative ? 'TENTATIVE' : 'CONFIRMED');
  component.updatePropertyWithValue('transp', 'OPAQUE');
  const guests = invited(payload as JsonObject);
  if (guests.length && organizer)
    component.updatePropertyWithValue('organizer', `mailto:${organizer}`);
  for (const guest of guests) {
    const attendee = new ICAL.Property('attendee');
    attendee.setParameter('partstat', 'NEEDS-ACTION');
    attendee.setParameter('rsvp', 'TRUE');
    attendee.setValue(`mailto:${guest}`);
    component.addProperty(attendee);
  }
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

const xmlText = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
/** An instant as CalDAV's time-range wants it: `20261005T120000Z`. */
const caldavTime = (iso: string) =>
  new Date(Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso))
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/**
 * Narrows a REPORT to the events touching a window, which the server works
 * out with their recurrence rules, or to one event by its UID, so a large
 * calendar is never read whole.
 */
function eventFilter(only: { window?: ListWindow; uid?: string }): string {
  if (only.uid !== undefined)
    return `<c:prop-filter name="UID"><c:text-match collation="i;octet">${xmlText(only.uid)}</c:text-match></c:prop-filter>`;
  if (only.window)
    return `<c:time-range start="${caldavTime(only.window.from)}" end="${caldavTime(only.window.to)}"/>`;
  return '';
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
            tools: calendarManifest.tools.filter((tool) => READ_TOOLS.has(tool.name)),
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

  /** Every calendar object the collection holds, as iCalendar text with its ETag. */
  private async calendarObjects(
    ctx?: ConnectorContext,
    only: { window?: ListWindow; uid?: string } = {},
  ): Promise<{ ics: string; etag: string | null }[]> {
    const response = await this.request(
      'REPORT',
      null,
      `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">${eventFilter(only)}</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
      ctx,
      { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
    );
    if (response.status !== 207) throw await sourceError(response);
    const xml = await boundedText(response);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML declarations are not accepted');
    const parsed: unknown = new XMLParser({
      removeNSPrefix: true,
      ignoreAttributes: true,
    }).parse(xml);
    const objects: { ics: string; etag: string | null }[] = [];
    for (const item of array(object(object(parsed).multistatus).response)) {
      for (const propstat of array(object(item).propstat)) {
        const prop = object(object(propstat).prop);
        if (
          typeof prop['calendar-data'] === 'string' &&
          /\s200\s/.test(String(object(propstat).status))
        ) {
          objects.push({
            ics: prop['calendar-data'],
            etag: typeof prop.getetag === 'string' ? prop.getetag : null,
          });
        }
      }
    }
    return objects;
  }

  /**
   * Every occurrence touching the window, a repeating event expanded into its
   * instances. An imported file is read as it was imported; a CalDAV
   * collection is read fresh.
   */
  readonly signals: SignalSource = {
    stream: 'calendar',
    occurrences: async (window, options) =>
      expandIcs(
        this.config.mode === 'ics'
          ? [this.config.ics]
          : (
              await this.calendarObjects(
                options?.signal ? ({ signal: options.signal } as ConnectorContext) : undefined,
                { window },
              )
            ).map((object) => object.ics),
        window,
        undefined,
        [...this.selfAddresses(), ...(options?.self ?? [])],
        options?.zone ?? null,
      ),
    confirm: async ({ uid, occurrence }) =>
      confirmFromIcs(
        this.config.mode === 'ics'
          ? [this.config.ics]
          : (await this.calendarObjects(undefined, { uid })).map((object) => object.ics),
        uid,
        occurrence,
      ),
  };

  /** The account's own address, when its user name is one: who organises and who declined. */
  private selfAddresses(): string[] {
    return this.config.mode === 'caldav' && /^[^\s@]+@[^\s@]+$/.test(this.config.username)
      ? [this.config.username]
      : [];
  }

  /** The event a change rewrites, which never conflicts with itself. */
  private static mine(uid: string | null) {
    return uid ? (occurrence: Occurrence) => occurrence.uid === uid : undefined;
  }

  /** What a write would land on, read before the proposal's lock. */
  async ahead(
    proposal: Pick<Action, 'kind' | 'canonical_payload'>,
    ctx: ConnectorContext,
    sql: Query,
  ): Promise<JsonObject | null> {
    if (this.config.mode !== 'caldav') return null;
    const uid = proposal.canonical_payload.uid;
    const mine = CalendarConnector.mine(typeof uid === 'string' ? uid : null);
    return calendarAhead(this.signals as CalendarOccurrences, proposal, {
      sql,
      ctx,
      connectionId: this.config.id,
      ...(mine ? { mine } : {}),
    });
  }

  async prepare(payload: JsonObject, ctx: ConnectorContext, tx: Query, kind?: string) {
    // Guests are invited by the account that organises the event; a CalDAV
    // account whose user name is not an address cannot be named as one.
    if (
      (kind === 'calendar.create' || kind === 'calendar.update') &&
      invited(payload).length &&
      !this.selfAddresses().length
    )
      throw new BrokerFault(
        'payload_invalid',
        'This calendar’s account name is not an email address, so it cannot send invitations. Create the event without attendees, or use a calendar signed in with its address.',
      );
    return bindCalendarCheck(payload, ctx, tx, kind);
  }

  checkAhead(proposal: Pick<Action, 'kind' | 'canonical_payload'>, ctx: ConnectorContext) {
    checkCalendarAhead(proposal, ctx);
  }

  asksFirst(action: Pick<Action, 'kind' | 'canonical_payload'>): boolean {
    return calendarAsksFirst(action);
  }

  async execute(action: Action, ctx: ConnectorContext): Promise<DispatchResult> {
    let dispatched = false;
    try {
      this.assertContext(action, ctx);
      if (action.kind === 'calendar.freebusy') {
        const payload = freebusyPayload.parse(action.canonical_payload);
        try {
          return this.success(
            action,
            await freebusyDetail(this.signals as CalendarOccurrences, payload, ctx.signal),
          );
        } catch {
          return {
            outcome: 'failed',
            reason: 'The calendar could not be read just now.',
            retryable: true,
          };
        }
      }
      if (action.kind === 'calendar.list') {
        const payload = listPayload.parse(action.canonical_payload);
        const window = listWindow(payload);
        if (this.config.mode === 'ics') {
          const listed = eventsInWindow(parseIcs(this.config.ics), window, payload.limit);
          return this.success(action, listDetail(listed.events, window, listed.truncated, true));
        }
        const events: ParsedEvent[] = [];
        for (const object of await this.calendarObjects(ctx, { window }))
          events.push(...parseIcs(object.ics, object.etag));
        const listed = eventsInWindow(events, window, payload.limit);
        return this.success(action, listDetail(listed.events, window, listed.truncated, false));
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
      const blocked = await clearToWrite(
        this.signals as CalendarOccurrences,
        payload as JsonObject & WritePayload,
        CalendarConnector.mine(uid),
        { actionId: action.id, ...(ctx.signal ? { signal: ctx.signal } : {}) },
      );
      // A change that does not say whether it is a hold keeps what the event is now.
      const tentative =
        payload.tentative ??
        (update ? (await this.currentStatus(update.uid, ctx)) === 'TENTATIVE' : false);
      if (blocked) return blocked;
      const ics = eventIcs(action, uid, { ...payload, tentative }, this.selfAddresses()[0] ?? null);
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
          writeDetail(uid, response.headers.get('etag'), action, { ...payload, tentative }),
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

  /** The STATUS the event stored under `uid` has now, upper case; null when it has none. */
  private async currentStatus(uid: string, ctx: ConnectorContext): Promise<string | null> {
    const response = await this.request('GET', uid, null, ctx);
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const calendar = new ICAL.Component(ICAL.parse(await boundedText(response)));
    const event = calendar
      .getAllSubcomponents('vevent')
      .find((component) => new ICAL.Event(component).uid === uid);
    const status = event?.getFirstPropertyValue('status');
    return typeof status === 'string' ? status.toUpperCase() : null;
  }

  /** The attendees of the event an update rewrites, across every instance stored under its UID. */
  async existingGuests(action: Action, ctx: ConnectorContext): Promise<number> {
    this.assertContext(action, ctx);
    if (action.kind !== 'calendar.update') throw new Error('Only an update changes an event');
    const { uid } = updatePayload.parse(action.canonical_payload);
    const response = await this.request('GET', uid, null, ctx);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Calendar event unavailable');
    }
    const calendar = new ICAL.Component(ICAL.parse(await boundedText(response)));
    const events = calendar
      .getAllSubcomponents('vevent')
      .filter((component) => new ICAL.Event(component).uid === uid);
    if (events.length === 0) throw new Error('Calendar event unavailable');
    return events.reduce(
      (count, component) => count + component.getAllProperties('attendee').length,
      0,
    );
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
        if (response.status === 401 || response.status === 403)
          return {
            status: 'failing',
            detail: 'Calendar connection unavailable.',
            checked_at: new Date().toISOString(),
            reason: 'credential_refused',
          };
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
