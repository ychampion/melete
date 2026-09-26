/**
 * The calendar a Microsoft sign-in grants, over Microsoft Graph. It offers the
 * CalDAV calendar's tools with the same payloads, effect classes and approvals,
 * and keeps the same promises: an event Melete creates carries the action that
 * created it, so a second create for that action is refused; a change or
 * removal names the version it read; and only events Melete created can be
 * changed or removed.
 *
 * Graph chooses its own event ids, so Melete's mark travels in an extended
 * property of the event, `<uid> <action id> <payload hash>`, and an event is
 * found again by that mark.
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
import { signInEnded } from './mail-transport.ts';
import { bearerRequest, boundedJson, type SignedInAccess } from './signed-in.ts';
import type { Connector, ConnectorContext } from './types.ts';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Melete's own property set, so its mark never collides with another app's. */
export const MELETE_MARK = 'String {0f5b3c7e-6d65-4c65-8a74-652d6d61726b} Name melete_mark';
/** Times in UTC and bodies as text, so what was written can be compared with what is read. */
const PREFER = 'outlook.timezone="UTC", outlook.body-content-type="text"';

export const outlookCalendarManifest: ConnectorManifest = {
  ...calendarManifest,
  description: 'Read and update the Outlook calendar of a signed-in account.',
  credentials: [
    {
      key: 'sign_in',
      description: 'The tokens of an account sign-in, sealed in the service.',
      secret: true,
    },
  ],
};

type GraphEvent = {
  id?: string;
  '@odata.etag'?: string;
  iCalUId?: string;
  isCancelled?: boolean;
  subject?: string;
  body?: { contentType?: string; content?: string };
  location?: { displayName?: string };
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  recurrence?: { pattern?: { type?: string; interval?: number } } | null;
  singleValueExtendedProperties?: { id?: string; value?: string }[];
};

/** A Graph dateTime in UTC ("2026-09-30T09:00:00.0000000") as an instant. */
function instant(value: string | undefined): number {
  if (!value) return Number.NaN;
  const trimmed = value.replace(/(\.\d{3})\d+/, '$1');
  return Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(trimmed) ? trimmed : `${trimmed}Z`);
}

const utc = (iso: string) => new Date(iso).toISOString().replace(/Z$/, '');
const mark = (event: GraphEvent) =>
  event.singleValueExtendedProperties?.find((property) => property.id === MELETE_MARK)?.value;
/** Graph's ETags are weak (`W/"..."`); the tools carry the quoted part. */
const toolEtag = (etag: string | undefined) => (etag ? etag.replace(/^W\//, '') : null);
const graphEtag = (etag: string) => (etag.startsWith('W/') ? etag : `W/${etag}`);
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

function eventView(event: GraphEvent): EventView {
  const time = (value: { dateTime?: string } | undefined) => {
    const at = instant(value?.dateTime);
    return Number.isNaN(at) ? (value?.dateTime ?? '') : new Date(at).toISOString();
  };
  return {
    uid: mark(event)?.split(' ')[0] ?? event.iCalUId ?? event.id ?? '',
    summary: event.subject ?? '',
    start: time(event.start),
    end: time(event.end),
    description: event.body?.content ?? '',
    location: event.location?.displayName ?? '',
    recurrence: event.recurrence?.pattern
      ? `${event.recurrence.pattern.type ?? 'recurring'} every ${event.recurrence.pattern.interval ?? 1}`
      : null,
    etag: toolEtag(event['@odata.etag']),
  };
}

export class OutlookCalendarConnector implements Connector {
  readonly manifest = outlookCalendarManifest;

  constructor(
    private readonly config: {
      id: string;
      spaceId: string;
      /** `https://graph.microsoft.com/v1.0/me` */
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
        headers: { prefer: PREFER, ...headers },
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

  /**
   * Events matching `query`. Before a write, a refused credential or a request
   * to slow down raises the same faults the write itself would.
   */
  private async events(
    query: URLSearchParams,
    ctx?: ConnectorContext,
    beforeWrite = false,
  ): Promise<GraphEvent[]> {
    query.set('$expand', `singleValueExtendedProperties($filter=id eq ${literal(MELETE_MARK)})`);
    const response = await this.request('GET', `/events?${query}`, ctx);
    if (beforeWrite && [401, 403, 429, 503].includes(response.status)) await this.refused(response);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Calendar listing unavailable');
    }
    const listed = (await boundedJson(response, MAX_RESPONSE_BYTES)) as {
      value?: GraphEvent[];
    } | null;
    return listed?.value ?? [];
  }

  /** The event Melete created under `uid`, found by its mark. */
  private async find(
    uid: string,
    ctx?: ConnectorContext,
    beforeWrite = false,
  ): Promise<GraphEvent | null> {
    const found = await this.events(
      new URLSearchParams({
        $filter: `singleValueExtendedProperties/Any(ep: ep/id eq ${literal(MELETE_MARK)} and startswith(ep/value, ${literal(`${uid} `)}))`,
        $top: '2',
      }),
      ctx,
      beforeWrite,
    );
    return found.find((event) => mark(event)?.split(' ')[0] === uid) ?? null;
  }

  /** What a refused write means, in the same faults the CalDAV calendar raises. */
  private async refused(response: Response): Promise<DispatchResult> {
    await response.body?.cancel().catch(() => {});
    if (response.status === 429 || response.status === 503)
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
    if ([400, 404, 409, 412].includes(response.status))
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

  async execute(action: Action, ctx: ConnectorContext): Promise<DispatchResult> {
    let dispatched = false;
    try {
      this.assertContext(action, ctx);
      if (action.kind === 'calendar.list') {
        const payload = listPayload.parse(action.canonical_payload);
        const now = this.config.now?.() ?? Date.now();
        const events = await this.events(
          new URLSearchParams({
            $top: String(payload.limit),
            // From yesterday on; a series keeps its pattern.
            $filter: `end/dateTime ge ${literal(utc(new Date(now - 86_400_000).toISOString()))}`,
          }),
          ctx,
        );
        return this.success(action, {
          events: events
            .filter((event) => !event.isCancelled)
            .map(eventView)
            .slice(0, payload.limit),
          read_only: false,
        });
      }
      if (action.kind === 'calendar.delete') {
        const payload = deletePayload.parse(action.canonical_payload);
        const found = await this.find(payload.uid, ctx, true);
        if (!found?.id)
          return {
            outcome: 'failed',
            reason: 'The event changed or could not be removed.',
            retryable: false,
          };
        dispatched = true;
        const response = await this.request(
          'DELETE',
          `/events/${encodeURIComponent(found.id)}`,
          ctx,
          undefined,
          { 'if-match': graphEtag(payload.etag) },
        );
        await response.body?.cancel().catch(() => {});
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
      const existing = await this.find(uid, ctx, true);
      if (update ? !existing?.id : existing)
        return {
          outcome: 'failed',
          reason: update
            ? 'Calendar server rejected the write (404).'
            : 'Calendar server rejected the write (409).',
          retryable: false,
        };
      const body: JsonObject = {
        subject: payload.summary,
        body: { contentType: 'text', content: payload.description },
        location: { displayName: payload.location },
        start: { dateTime: utc(payload.start), timeZone: 'UTC' },
        end: { dateTime: utc(payload.end), timeZone: 'UTC' },
        singleValueExtendedProperties: [
          { id: MELETE_MARK, value: `${uid} ${action.id} ${action.payload_hash}` },
        ],
      };
      dispatched = true;
      const response =
        update && existing?.id
          ? await this.request('PATCH', `/events/${encodeURIComponent(existing.id)}`, ctx, body, {
              'if-match': graphEtag(update.etag),
            })
          : // Graph refuses a second create carrying the same transaction id.
            await this.request('POST', '/events', ctx, { ...body, transactionId: action.id });
      if (response.status >= 200 && response.status < 300) {
        const written = (await boundedJson(response, MAX_RESPONSE_BYTES).catch(
          () => null,
        )) as GraphEvent | null;
        return this.success(
          action,
          { uid, etag: toolEtag(written?.['@odata.etag']), action_id: action.id },
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
        const found = await this.find(payload.uid, ctx);
        // Absence proves the desired state, but cannot attribute an uncertain deletion.
        return {
          decision: 'undecided',
          reason:
            !found || found.isCancelled
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
      const found = await this.find(uid, ctx);
      const confirmed =
        found &&
        !found.isCancelled &&
        mark(found) === `${uid} ${action.id} ${action.payload_hash}` &&
        (found.subject ?? '') === payload.summary &&
        (found.body?.content ?? '').trim() === payload.description.trim() &&
        (found.location?.displayName ?? '') === payload.location &&
        instant(found.start?.dateTime) === Date.parse(payload.start) &&
        instant(found.end?.dateTime) === Date.parse(payload.end);
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
      const response = await this.request('GET', '/events?$top=1&$select=id');
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
