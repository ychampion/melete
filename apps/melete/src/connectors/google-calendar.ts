/**
 * The calendar a Google sign-in grants, over the Google Calendar API. It
 * offers the CalDAV calendar's tools with the same payloads, effect classes
 * and approvals, and keeps the same promises: an event Melete creates is named
 * by the action that created it, so a second create cannot make a second
 * event; a change or removal names the version it read; and only events Melete
 * created can be changed or removed.
 */
import type {
  Action,
  ConnectorHealth,
  ConnectorManifest,
  DispatchResult,
  JsonObject,
  VerifyResult,
} from '@melete/contracts';
import {
  type CalendarRead,
  type Occurrence,
  type OwnResponse,
  type SignalSource,
  sourceError,
} from '../signals/types.ts';
import {
  byStart,
  calendarManifest,
  createPayload,
  deletePayload,
  type EventView,
  listDetail,
  listPayload,
  listWindow,
  retryAfterSeconds,
  updatePayload,
} from './calendar.ts';
import { asConnectorFault, ConnectorFaultError } from './faults.ts';
import { googleErrorReason } from './google.ts';
import { signInEnded } from './mail-transport.ts';
import { bearerRequest, boundedJson, type SignedInAccess } from './signed-in.ts';
import type { Connector, ConnectorContext } from './types.ts';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RATE_LIMITED = ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded'];

export const googleCalendarManifest: ConnectorManifest = {
  ...calendarManifest,
  description: 'Read and update the Google Calendar of a signed-in account.',
  credentials: [
    {
      key: 'sign_in',
      description: 'The tokens of an account sign-in, sealed in the service.',
      secret: true,
    },
  ],
};

/**
 * Google event ids use the base32hex alphabet. The hexadecimal bytes of the
 * action id fit it, so the same action always names the same event.
 */
export function googleEventId(uid: string): string {
  return Buffer.from(uid, 'utf8').toString('hex');
}

type GoogleEvent = {
  id?: string;
  status?: string;
  etag?: string;
  iCalUID?: string;
  recurringEventId?: string;
  originalStartTime?: { dateTime?: string; date?: string };
  updated?: string;
  summary?: string;
  description?: string;
  location?: string;
  recurrence?: string[];
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
  attendees?: { email?: string; self?: boolean; resource?: boolean; responseStatus?: string }[];
  organizer?: { email?: string; self?: boolean };
};

/** The calendar's own answer to an event: organiser, or its own attendee entry's status. */
function googleResponse(event: GoogleEvent): OwnResponse {
  if (event.organizer?.self) return 'organizer';
  const own = (event.attendees ?? []).find((attendee) => attendee.self);
  // Others are listed but not the person (sent to a list they are on, or the
  // list was cut short): their answer is not known, so it is not their meeting.
  if (!own) return event.attendees?.length ? 'unknown' : 'organizer';
  switch (own.responseStatus) {
    case 'accepted':
      return 'accepted';
    case 'tentative':
      return 'tentative';
    case 'declined':
      return 'declined';
    case 'needsAction':
      return 'needs_action';
    default:
      return 'unknown';
  }
}

/** A Google time as a UTC instant, or the date of an all-day event. */
function googleTime(value: { dateTime?: string; date?: string } | undefined): string | null {
  if (value?.date && /^\d{4}-\d{2}-\d{2}$/.test(value.date)) return value.date;
  const at = Date.parse(value?.dateTime ?? '');
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/**
 * One instance as Google lists it with `singleEvents`: a repeating event's
 * instances carry the series' iCalUID and the start they were scheduled at,
 * which stays put when one is moved. A cancelled instance may carry nothing
 * else, and is placed at that original start.
 */
export function googleOccurrence(event: GoogleEvent): Occurrence | null {
  const original = googleTime(event.originalStartTime);
  const start = googleTime(event.start) ?? original;
  if (!start) return null;
  const uid = event.iCalUID ?? event.id;
  if (!uid) return null;
  return {
    uid,
    occurrence: event.recurringEventId ? original : null,
    title: event.summary ?? '',
    start,
    end: googleTime(event.end) ?? start,
    all_day: Boolean(event.start?.date ?? (!event.start && event.originalStartTime?.date)),
    location: event.location ?? '',
    status:
      event.status === 'cancelled'
        ? 'cancelled'
        : event.status === 'tentative'
          ? 'tentative'
          : 'confirmed',
    attendees: (event.attendees ?? []).filter((attendee) => !attendee.self && !attendee.resource)
      .length,
    time_zone: event.start?.timeZone ?? null,
    ref: event.id ?? null,
    updated_at: event.updated && !Number.isNaN(Date.parse(event.updated)) ? event.updated : null,
    response: googleResponse(event),
  };
}

/** Most pages of instances one read walks through. */
const MAX_OCCURRENCE_PAGES = 8;

function eventView(event: GoogleEvent): EventView {
  const marks = event.extendedProperties?.private ?? {};
  return {
    uid: marks.melete_uid ?? event.iCalUID ?? event.id ?? '',
    summary: event.summary ?? '',
    start: event.start?.dateTime ?? event.start?.date ?? '',
    end: event.end?.dateTime ?? event.end?.date ?? '',
    description: event.description ?? '',
    location: event.location ?? '',
    recurrence: event.recurrence?.length ? event.recurrence.join('\n') : null,
    etag: event.etag ?? null,
  };
}

export class GoogleCalendarConnector implements Connector {
  readonly manifest = googleCalendarManifest;

  constructor(
    private readonly config: {
      id: string;
      spaceId: string;
      /** `.../calendar/v3/calendars/primary` */
      base: string;
      access: SignedInAccess;
      fetcher?: typeof fetch;
      now?: () => number;
    },
  ) {}

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
    path: string,
    ctx?: ConnectorContext,
    body?: JsonObject,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return bearerRequest(
      this.config.access,
      `${this.config.base}${path}`,
      {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        ...(ctx?.signal ? { signal: ctx.signal } : {}),
      },
      this.config.fetcher,
    );
  }

  /**
   * Every instance touching the window, cancelled ones included, so that a
   * cancellation is seen as one rather than as a disappearance.
   */
  readonly signals: SignalSource = {
    stream: 'calendar',
    occurrences: async (window): Promise<CalendarRead> => {
      const items: Occurrence[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_OCCURRENCE_PAGES; page++) {
        const query = new URLSearchParams({
          singleEvents: 'true',
          showDeleted: 'true',
          orderBy: 'startTime',
          timeMin: window.from,
          timeMax: window.to,
          maxResults: '250',
        });
        if (pageToken) query.set('pageToken', pageToken);
        const response = await this.request('GET', `/events?${query}`);
        if (!response.ok) throw await sourceError(response);
        const listed = (await boundedJson(response, MAX_RESPONSE_BYTES)) as {
          items?: GoogleEvent[];
          nextPageToken?: string;
        } | null;
        for (const event of listed?.items ?? []) {
          const occurrence = googleOccurrence(event);
          if (occurrence) items.push(occurrence);
        }
        pageToken = listed?.nextPageToken || undefined;
        if (!pageToken) return { items, complete: true };
      }
      return { items, complete: false };
    },
    // An instance no longer listed is looked up by its own id: gone, or moved.
    confirm: async ({ ref }) => {
      if (!ref || !/^[A-Za-z0-9_]{1,1024}$/.test(ref)) return 'unknown';
      const response = await this.request('GET', `/events/${ref}`);
      if (response.status === 404 || response.status === 410) {
        await response.body?.cancel().catch(() => {});
        return 'gone';
      }
      if (!response.ok) throw await sourceError(response);
      const found = googleOccurrence(
        (await boundedJson(response, MAX_RESPONSE_BYTES)) as GoogleEvent,
      );
      return found ?? 'unknown';
    },
  };

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

  /** What a refused write means, in the same faults the CalDAV calendar raises. */
  private async refused(response: Response): Promise<DispatchResult> {
    const body = await boundedJson(response, 64 * 1024).catch(() => null);
    const reason = googleErrorReason(body);
    if (response.status === 429 || (response.status === 403 && RATE_LIMITED.includes(reason ?? '')))
      throw new ConnectorFaultError({
        kind: 'rate_limited',
        detail: 'the calendar server asked to be left alone for a while',
        retry_after: retryAfterSeconds(response.headers.get('retry-after')),
      });
    if (response.status === 401)
      throw new ConnectorFaultError({
        kind: 'expired_credential',
        detail: 'the calendar server refused the credential this write carried',
      });
    if (response.status === 403)
      throw new ConnectorFaultError({
        kind: 'revoked_credential',
        detail: 'the calendar server no longer permits this account to write',
      });
    if ([400, 404, 409, 410, 412].includes(response.status))
      return {
        outcome: 'failed',
        reason: `Calendar server rejected the write (${response.status}).`,
        retryable: false,
      };
    return {
      outcome: 'unknown',
      reason: 'Calendar write was not confirmed. Verify its UID before deciding.',
    };
  }

  private async event(uid: string, ctx?: ConnectorContext): Promise<GoogleEvent | null> {
    const response = await this.request('GET', `/events/${googleEventId(uid)}`, ctx);
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Calendar event unavailable');
    }
    return (await boundedJson(response, MAX_RESPONSE_BYTES)) as GoogleEvent;
  }

  /** The guests of the event an update rewrites, not counting the calendar's own account. */
  async existingGuests(action: Action, ctx: ConnectorContext): Promise<number> {
    this.assertContext(action, ctx);
    if (action.kind !== 'calendar.update') throw new Error('Only an update changes an event');
    const found = await this.event(updatePayload.parse(action.canonical_payload).uid, ctx);
    if (!found || found.status === 'cancelled') throw new Error('Calendar event unavailable');
    return (found.attendees ?? []).filter((attendee) => !attendee.self).length;
  }

  async execute(action: Action, ctx: ConnectorContext): Promise<DispatchResult> {
    let dispatched = false;
    try {
      this.assertContext(action, ctx);
      if (action.kind === 'calendar.list') {
        const payload = listPayload.parse(action.canonical_payload);
        const window = listWindow(payload, this.config.now?.() ?? Date.now());
        const query = new URLSearchParams({
          maxResults: String(payload.limit),
          // Series and single events that touch the window; a series keeps its rule.
          timeMin: window.from,
          timeMax: window.to,
          singleEvents: 'false',
        });
        const response = await this.request('GET', `/events?${query}`, ctx);
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new Error('Calendar listing unavailable');
        }
        const listed = (await boundedJson(response, MAX_RESPONSE_BYTES)) as {
          items?: GoogleEvent[];
          nextPageToken?: string;
        } | null;
        const items = (listed?.items ?? []).filter((event) => event.status !== 'cancelled');
        // Google cannot order series by start, so the page is put in order here.
        const events = byStart(items.map(eventView)).slice(0, payload.limit);
        const truncated = Boolean(listed?.nextPageToken) || items.length > payload.limit;
        return this.success(action, listDetail(events, window, truncated, false));
      }
      if (action.kind === 'calendar.delete') {
        const payload = deletePayload.parse(action.canonical_payload);
        dispatched = true;
        const response = await this.request(
          'DELETE',
          `/events/${googleEventId(payload.uid)}`,
          ctx,
          undefined,
          { 'if-match': payload.etag },
        );
        if (response.status >= 200 && response.status < 300) {
          await response.body?.cancel().catch(() => {});
          return this.success(action, { uid: payload.uid, removed: true }, payload.uid);
        }
        await response.body?.cancel().catch(() => {});
        return [401, 403, 404, 409, 410, 412].includes(response.status)
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
      const body: JsonObject = {
        summary: payload.summary,
        description: payload.description,
        location: payload.location,
        start: { dateTime: payload.start },
        end: { dateTime: payload.end },
        extendedProperties: {
          private: {
            melete_uid: uid,
            melete_action_id: action.id,
            melete_payload_hash: action.payload_hash,
          },
        },
      };
      dispatched = true;
      // A create names its event, so the calendar refuses a second one with that name.
      const response = update
        ? await this.request('PUT', `/events/${googleEventId(uid)}`, ctx, body, {
            'if-match': update.etag,
          })
        : await this.request('POST', '/events', ctx, { ...body, id: googleEventId(uid) });
      if (response.status >= 200 && response.status < 300) {
        const written = (await boundedJson(response, MAX_RESPONSE_BYTES).catch(
          () => null,
        )) as GoogleEvent | null;
        return this.success(
          action,
          { uid, etag: written?.etag ?? null, action_id: action.id },
          uid,
        );
      }
      return await this.refused(response);
    } catch (error) {
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
    if (action.kind === 'calendar.delete') {
      try {
        this.assertContext(action, ctx);
        const payload = deletePayload.parse(action.canonical_payload);
        const found = await this.event(payload.uid, ctx);
        // Absence proves the desired state, but cannot attribute an uncertain deletion.
        return {
          decision: 'undecided',
          reason:
            !found || found.status === 'cancelled'
              ? 'The event is absent, but this removal has no acknowledgement.'
              : 'The event removal could not be confirmed.',
        };
      } catch {
        return { decision: 'undecided', reason: 'Calendar verification unavailable.' };
      }
    }
    if (!['calendar.create', 'calendar.update'].includes(action.kind))
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
      const found = await this.event(uid, ctx);
      const marks = found?.extendedProperties?.private ?? {};
      const confirmed =
        found &&
        found.status !== 'cancelled' &&
        marks.melete_uid === uid &&
        marks.melete_action_id === action.id &&
        marks.melete_payload_hash === action.payload_hash &&
        (found.summary ?? '') === payload.summary &&
        (found.description ?? '') === payload.description &&
        (found.location ?? '') === payload.location &&
        Date.parse(found.start?.dateTime ?? '') === Date.parse(payload.start) &&
        Date.parse(found.end?.dateTime ?? '') === Date.parse(payload.end);
      if (!confirmed)
        return {
          decision: 'undecided',
          reason: found
            ? 'Calendar event does not confirm this exact action and payload.'
            : 'Calendar UID unavailable; absence cannot establish whether a write previously happened.',
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
    const checkedAt = () => new Date().toISOString();
    try {
      const response = await this.request('GET', '/events?maxResults=1');
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403)
        return {
          status: 'failing',
          detail: 'Calendar connection unavailable.',
          checked_at: checkedAt(),
          reason: 'credential_refused',
        };
      if (!response.ok) throw new Error('Calendar unavailable');
      return { status: 'ok', detail: 'Calendar is available.', checked_at: checkedAt() };
    } catch (error) {
      return {
        status: 'failing',
        detail: 'Calendar connection unavailable.',
        checked_at: checkedAt(),
        ...(signInEnded(error) ? { reason: 'sign_in_required' as const } : {}),
      };
    }
  }
}
