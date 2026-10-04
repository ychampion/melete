/**
 * How each change Melete makes can be taken back.
 *
 * Every tool that changes something declares one of four answers:
 *
 * - `reversal`: an exact inverse, run as its own brokered action. Creating an
 *   event is undone by removing it; an update by writing back what it replaced;
 *   a delete into the trash by restoring it; a draft by discarding it; a new
 *   version of an app by going back to the one before.
 * - `compensation`: no true inverse exists, so a second change makes up for
 *   the first, and its receipt names the one it made up for. Removing an event
 *   Melete made is compensated by making it again, with the same details, as a
 *   new event.
 * - `hold`: the change cannot be taken back once it has happened, so it waits
 *   first. A message waits a few seconds before it is sent, and cancelling it
 *   in that time means nothing leaves.
 * - `none`: nothing takes it back, and no Undo is offered.
 *
 * A connector can declare its own reversals (`Connector.reversal`), which is
 * how a connected app's own tools (tasks, bookings) take part. The reversal
 * always runs through the broker, under the same tiers as any other change.
 */
import type { Action, JsonObject } from '@melete/contracts';
import type { Connector } from '../connectors/types.ts';
import type { Query } from './records.ts';

export type ReversalMode = 'reversal' | 'compensation' | 'hold' | 'none';

export type Declaration = {
  mode: ReversalMode;
  /** What undoing it does, in the person's words. */
  says: string;
};

/** The built-in tools' declarations. A tool not named here declares `none`. */
export const REVERSALS: Readonly<Record<string, Declaration>> = {
  'calendar.create': { mode: 'reversal', says: 'Removes the event it made.' },
  'calendar.update': { mode: 'reversal', says: 'Puts the event back the way it was.' },
  'calendar.delete': {
    mode: 'compensation',
    says: 'Puts the event back, as a new event with the same details.',
  },
  'email.draft': { mode: 'reversal', says: 'Discards the draft.' },
  'email.send': {
    mode: 'hold',
    says: 'Waits a few seconds before sending, and can be cancelled until then.',
  },
  'files.delete': { mode: 'reversal', says: 'Restores what it put in the trash.' },
  'apps.publish': { mode: 'reversal', says: 'Shows people the version they saw before.' },
  'apps.rollback': { mode: 'reversal', says: 'Shows people the version they saw before.' },
};

const NONE: Declaration = { mode: 'none', says: 'This cannot be taken back.' };

/** What a tool declares, built-in or from its connector. */
export function declarationOf(
  kind: string,
  connector?: Pick<Connector, 'reversalDeclared'> | null,
): Declaration {
  return REVERSALS[kind] ?? connector?.reversalDeclared?.(kind) ?? NONE;
}

/** Tools that wait before they run, so they can be cancelled first. */
export const heldKind = (kind: string) => REVERSALS[kind]?.mode === 'hold';

/** How long a message waits before it is sent, unless the installation says otherwise. */
export const DEFAULT_SEND_HOLD_SECONDS = 20;
/** How long an exact inverse or a compensation stays on offer, unless the change says. */
export const UNDO_WINDOW_MS = 24 * 3600_000;

/** One reversal ready to propose: the tool, its bytes, and where it runs. */
export type ReversalPlan = {
  mode: 'reversal' | 'compensation';
  kind: string;
  payload: JsonObject;
  /** Set when it runs on another connection than the change it takes back. */
  connectionId?: string;
  /** Until when it is offered; the default is a day after the change. */
  validUntil?: string;
};

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const QUOTED_ETAG = /^"[^"\r\n]+"$/;
const EVENT_FIELDS = ['summary', 'start', 'end', 'description', 'location'] as const;

/**
 * The last write Melete made to an event it made, before `before` if given:
 * the create that named it, or an update since. Only a write that succeeded,
 * on the same connection, in the same space, counts.
 */
async function lastWrite(
  q: Query,
  spaceId: string,
  connectionId: string,
  uid: string,
  before: Action | null,
): Promise<Action | null> {
  const rows = await q`select a.id, a.kind, a.canonical_payload, a.receipt, a.resolved_at
    from action a join job j on j.id = a.job_id
    where j.space_id = ${spaceId} and a.connection_id = ${connectionId} and a.status = 'succeeded'
      and ((a.kind = 'calendar.create' and a.id = ${uid})
        or (a.kind = 'calendar.update' and a.canonical_payload->>'uid' = ${uid}))
      ${before ? q`and a.id <> ${before.id} and a.resolved_at <= ${before.resolved_at ?? before.created_at}` : q``}
    order by a.resolved_at desc nulls last, a.id desc limit 1`;
  const row = rows[0];
  return row ? (row as unknown as Action) : null;
}

/** The ETag the calendar gave a write Melete made, from its receipt. */
const writtenEtag = (write: Pick<Action, 'receipt'> | null): string | null => {
  const etag = object(object(write?.receipt).detail).etag;
  return typeof etag === 'string' && QUOTED_ETAG.test(etag) ? etag : null;
};

const eventFields = (payload: unknown): JsonObject => {
  const source = object(payload);
  const fields: JsonObject = {};
  for (const key of EVENT_FIELDS)
    if (typeof source[key] === 'string') fields[key] = source[key] as string;
  return fields;
};

/**
 * The event as it stood before a change to it, when Melete wrote it last and
 * nobody changed it since: the change names the very ETag Melete's own last
 * write was given. Anything else might lose someone's edit, so it is not
 * offered.
 */
export async function eventBefore(
  q: Query,
  spaceId: string,
  change: Pick<Action, 'connection_id' | 'canonical_payload'> & Partial<Action>,
): Promise<JsonObject | null> {
  const payload = object(change.canonical_payload);
  if (typeof payload.uid !== 'string' || typeof payload.etag !== 'string') return null;
  const before = change.id && change.status === 'succeeded' ? (change as Action) : null;
  const prior = await lastWrite(q, spaceId, change.connection_id, payload.uid, before);
  if (!prior || writtenEtag(prior) !== payload.etag) return null;
  const fields = eventFields(prior.canonical_payload);
  return typeof fields.summary === 'string' &&
    typeof fields.start === 'string' &&
    typeof fields.end === 'string'
    ? fields
    : null;
}

/**
 * Whether a proposed change could be taken back once it has run. A new event
 * always can; an update or a removal only when Melete knows what the event was.
 */
export async function reversibleProposal(
  q: Query,
  spaceId: string,
  change: Pick<Action, 'connection_id' | 'kind' | 'canonical_payload'>,
): Promise<boolean> {
  if (change.kind === 'calendar.create') return true;
  if (change.kind === 'calendar.update' || change.kind === 'calendar.delete')
    return (await eventBefore(q, spaceId, change)) !== null;
  return REVERSALS[change.kind]?.mode === 'reversal';
}

/**
 * The reversal or compensation for a change that happened, or null when it has
 * none. Only what the change's own receipt and Melete's own records say is
 * used, never anything a tool result could have changed.
 */
export async function planReversal(
  q: Query,
  spaceId: string,
  source: Action,
  connector?: Pick<Connector, 'reversal'> | null,
): Promise<ReversalPlan | null> {
  if (source.status !== 'succeeded') return null;
  const detail = object(source.receipt?.detail);
  // A delete went to the trash: undoing it restores everything it took.
  if (source.kind === 'files.delete' && typeof detail.trash_id === 'string')
    return {
      mode: 'reversal',
      kind: 'files.restore',
      payload: { trash_id: detail.trash_id },
      ...(typeof detail.restorable_until === 'string'
        ? { validUntil: detail.restorable_until }
        : {}),
    };
  // So did what a command deleted in the agent's computer; the space's own
  // Files connection restores it.
  if (typeof detail.workspace_trash === 'string') {
    const [files] = await q`select id from connection
      where space_id = ${spaceId} and provider = 'files' and status = 'active'
      order by created_at limit 1`;
    if (!files) return null;
    return {
      mode: 'reversal',
      kind: 'files.restore',
      payload: { trash_id: detail.workspace_trash },
      connectionId: String(files.id),
      ...(typeof detail.workspace_restorable_until === 'string'
        ? { validUntil: detail.workspace_restorable_until }
        : {}),
    };
  }
  switch (source.kind) {
    case 'calendar.create':
      return typeof detail.uid === 'string' && writtenEtag(source)
        ? {
            mode: 'reversal',
            kind: 'calendar.delete',
            payload: { uid: detail.uid, etag: writtenEtag(source) as string },
          }
        : null;
    case 'calendar.update': {
      const etag = writtenEtag(source);
      const uid = object(source.canonical_payload).uid;
      const before = etag ? await eventBefore(q, spaceId, source) : null;
      return before && typeof uid === 'string'
        ? { mode: 'reversal', kind: 'calendar.update', payload: { ...before, uid, etag } }
        : null;
    }
    case 'calendar.delete': {
      const before = await eventBefore(q, spaceId, source);
      return before ? { mode: 'compensation', kind: 'calendar.create', payload: before } : null;
    }
    case 'email.draft':
      return { mode: 'reversal', kind: 'email.discard', payload: { draft_id: source.id } };
    case 'apps.publish':
    case 'apps.rollback':
      // A brand new app has no earlier version to go back to.
      return typeof detail.app_id === 'string' && typeof detail.previous_version_id === 'string'
        ? {
            mode: 'reversal',
            kind: 'apps.rollback',
            payload: { app_id: detail.app_id, version_id: detail.previous_version_id },
          }
        : null;
  }
  const declared = connector?.reversal?.(source) ?? null;
  return declared;
}

export type ReversalStep<T> = { effect: T; ok: boolean; reason?: string };

/**
 * Take back a series of changes, newest first, the way cancelling a piece of
 * work that made them should. Every step is tried even after one fails, and
 * each one's result is kept, so what could not be taken back is listed
 * plainly rather than hidden behind the first failure.
 */
export async function reverseInOrder<T>(
  effects: readonly T[],
  run: (effect: T) => Promise<{ ok: boolean; reason?: string }>,
): Promise<ReversalStep<T>[]> {
  const steps: ReversalStep<T>[] = [];
  for (const effect of [...effects].reverse()) {
    try {
      steps.push({ effect, ...(await run(effect)) });
    } catch (error) {
      steps.push({ effect, ok: false, reason: error instanceof Error ? error.message : 'failed' });
    }
  }
  return steps;
}
