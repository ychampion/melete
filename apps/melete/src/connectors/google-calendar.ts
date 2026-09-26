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
  calendarManifest,
  createPayload,
  deletePayload,
  type EventView,
  listPayload,
  retryAfterSeconds,
  updatePayload,
} from './calendar.ts';
import { asConnectorFault, ConnectorFaultError } from './faults.ts';
import { boundedJson, type GoogleAccess, googleErrorReason, googleRequest } from './google.ts';
import { signInEnded } from './mail-transport.ts';
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
  summary?: string;
  description?: string;
  location?: string;
  recurrence?: string[];
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
};

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
      access: GoogleAccess;
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
    return googleRequest(
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

  async execute(action: Action, ctx: ConnectorContext): Promise<DispatchResult> {
    let dispatched = false;
    try {
      this.assertContext(action, ctx);
      if (action.kind === 'calendar.list') {
        const payload = listPayload.parse(action.canonical_payload);
        const now = this.config.now?.() ?? Date.now();
        const query = new URLSearchParams({
          maxResults: String(payload.limit),
          // Series and single events from yesterday on; a series keeps its rule.
          timeMin: new Date(now - 86_400_000).toISOString(),
          singleEvents: 'false',
        });
        const response = await this.request('GET', `/events?${query}`, ctx);
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new Error('Calendar listing unavailable');
        }
        const listed = (await boundedJson(response, MAX_RESPONSE_BYTES)) as {
          items?: GoogleEvent[];
        } | null;
        const events = (listed?.items ?? [])
          .filter((event) => event.status !== 'cancelled')
          .map(eventView)
          .slice(0, payload.limit);
        return this.success(action, { events, read_only: false });
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
