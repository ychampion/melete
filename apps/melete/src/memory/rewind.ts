/**
 * Rewind: put every belief learned or changed in a window back the way it was
 * when the window began, as one operation that can itself be undone.
 *
 * Nothing is deleted. A belief that had an earlier value gets that value back
 * as a new revision citing the same evidence, so its trust and history are
 * what they were. A belief first learned inside the window is set aside: its
 * revision is marked retracted, which every read already skips, and its
 * content stays so undoing the rewind can bring it back exactly. The steps are
 * recorded with a snapshot of what each belief held, and undoing replays them
 * in reverse. A belief that changed again after the rewind is left as it is and
 * named, rather than overwritten. Rewinding a window likewise leaves alone, and
 * names, a belief whose current value was set after the window: undoing one
 * day never takes back a later day's change, least of all the person's own.
 */
import type { BeliefChange, ClaimRevision, MemoryRewind, RewindTarget } from '@melete/contracts';
import { beliefVersion, subjectLabel } from './beliefs.ts';
import {
  type ClaimHead,
  eligibleRevision,
  getHead,
  publishRevision,
  references,
} from './claims.ts';
import {
  bumpRevision,
  enqueue,
  iso,
  lockSpace,
  MemoryError,
  type MemoryScope,
  type MemorySql,
  type MemoryTx,
  newId,
} from './db.ts';
import { invalidateDependencies, lockEventOrder, notifyInvalidated } from './invalidate.ts';
import { dayWindow, localDay, shortDate } from './zoned.ts';

/** What one revision held, enough to publish it again exactly. */
type Snapshot = {
  revision: number;
  status: ClaimRevision['status'];
  content: string | null;
  kind: ClaimRevision['kind'];
  factual_status: ClaimRevision['factual_status'];
  valid_from: string;
  valid_until: string | null;
  protected: boolean;
  confidence: number | null;
};
export type RewindStep =
  | {
      action: 'restore';
      claim_id: string;
      label: string;
      /** The head before the rewind; undo publishes it again. */
      from: Snapshot;
      /** The revision whose value is restored. */
      to: Snapshot;
      /** The revision the rewind published; undo requires it still to be the head. */
      produced?: number;
    }
  | { action: 'set_aside'; claim_id: string; label: string; from: Snapshot };
type UndoStep = { claim_id: string; produced: number | null };
export type RewindWindow = { start: Date; end: Date; claimIds?: string[] };

const NOT_HISTORICAL = ['superseded', 'active', 'disputed', 'retracted'];

async function snapshot(tx: MemoryTx, claimId: string, revision: number): Promise<Snapshot> {
  const [row] = await tx`select r.*, b.content from memory_revisions r
    left join memory_revision_content b on b.claim_id = r.claim_id and b.revision = r.revision
    where r.claim_id = ${claimId} and r.revision = ${revision}`;
  if (!row) throw new MemoryError('claim_not_found');
  return {
    revision,
    status: row.status,
    content: row.content === null || row.content === undefined ? null : String(row.content),
    kind: row.kind,
    factual_status: row.factual_status,
    valid_from: iso(row.valid_from as Date),
    valid_until: row.valid_until ? iso(row.valid_until as Date) : null,
    protected: Boolean(row.protected),
    confidence: row.confidence === null ? null : Number(row.confidence),
  };
}

/**
 * Revisions rewinds and their undos published, which are never themselves
 * "learned", each mapped to the revision whose value it published again.
 */
async function rewindRevisions(tx: MemoryTx, spaceId: string) {
  const rows = await tx`select steps, undo_steps from memory_rewinds where space_id = ${spaceId}`;
  const produced = new Map<string, number>();
  for (const row of rows) {
    const steps = (row.steps as RewindStep[]) ?? [];
    for (const step of steps)
      if (step.action === 'restore' && step.produced)
        produced.set(`${step.claim_id}:${step.produced}`, step.to.revision);
    for (const step of (row.undo_steps as UndoStep[] | null) ?? []) {
      const undid = steps.find((s) => s.claim_id === step.claim_id && s.action === 'restore');
      if (step.produced && undid)
        produced.set(`${step.claim_id}:${step.produced}`, undid.from.revision);
    }
  }
  return produced;
}

/** The revision a value was first written in, looking through rewinds that published it again. */
function originOf(produced: Map<string, number>, claimId: string, revision: number) {
  let current = revision;
  for (let hops = 0; hops < 1000; hops++) {
    const next = produced.get(`${claimId}:${current}`);
    if (next === undefined || next === current) return current;
    current = next;
  }
  return current;
}

/**
 * Why a belief's current value is kept by a rewind of a window, or null when it
 * may be rewound: its value was set after the window ended, by the person
 * (a correction, or a settled question) or by something learned later.
 */
async function keptReason(
  tx: MemoryTx,
  claimId: string,
  revision: number,
  recordedAt: Date,
  window: RewindWindow,
) {
  if (recordedAt < window.end) return null;
  const [owner] = await tx`select 1 from memory_references ref
    join memory_sources s on s.id = ref.source_id
    where ref.claim_id = ${claimId} and ref.revision = ${revision}
      and (s.source_type = 'owner_edit' or s.stream = 'owner-corrections') limit 1`;
  return owner ? 'kept — you changed this later.' : 'kept — it changed again later.';
}

/** The steps a rewind of this window would take now, and what it would leave. */
async function planSteps(tx: MemoryTx, scope: MemoryScope, window: RewindWindow) {
  const produced = await rewindRevisions(tx, scope.spaceId);
  const ids = window.claimIds ?? null;
  const touched = await tx`select distinct r.claim_id from memory_revisions r
    join memory_claims c on c.id = r.claim_id
    where c.space_id = ${scope.spaceId} and not c.hidden
      and r.recorded_at >= ${window.start.toISOString()} and r.recorded_at < ${window.end.toISOString()}
      and r.status <> 'historical'
      and (${ids}::text[] is null or r.claim_id = any(${ids}))
    order by r.claim_id`;
  const steps: RewindStep[] = [];
  const skipped: string[] = [];
  for (const { claim_id } of touched) {
    const head = await getHead(tx, scope, String(claim_id));
    if (!head) continue;
    const label = subjectLabel(head.key, head.domain_key);
    const revisions = await tx`select revision, status, recorded_at from memory_revisions
      where claim_id = ${head.id} and status = any(${NOT_HISTORICAL}) order by revision`;
    const learned = revisions.filter(
      (row) =>
        new Date(String(row.recorded_at)) >= window.start &&
        new Date(String(row.recorded_at)) < window.end &&
        !produced.has(`${head.id}:${row.revision}`),
    );
    if (!learned.length) continue;
    const origin = originOf(produced, head.id, head.head_revision);
    const originRow = revisions.find((row) => Number(row.revision) === origin);
    const kept = originRow
      ? await keptReason(tx, head.id, origin, new Date(String(originRow.recorded_at)), window)
      : null;
    if (kept) {
      skipped.push(`${label}: ${kept}`);
      continue;
    }
    const before = revisions
      .filter((row) => new Date(String(row.recorded_at)) < window.start)
      .at(-1);
    const current = await snapshot(tx, head.id, head.head_revision);
    if (!before || before.status === 'retracted') {
      if (current.status === 'active' || current.status === 'disputed')
        steps.push({ action: 'set_aside', claim_id: head.id, label, from: current });
      continue;
    }
    const prior = await snapshot(tx, head.id, Number(before.revision));
    if (prior.revision === current.revision) continue;
    if (!(await eligibleRevision(tx, scope, head.id, prior.revision))) {
      skipped.push(`${label}: what it said before came from something you have since forgotten.`);
      continue;
    }
    steps.push({ action: 'restore', claim_id: head.id, label, from: current, to: prior });
  }
  return { steps, skipped };
}

/** Publish a snapshot's value again on its claim, citing the snapshot's own evidence. */
async function republish(
  tx: MemoryTx,
  scope: MemoryScope,
  head: ClaimHead,
  value: Snapshot,
  status: 'active' | 'disputed',
) {
  const sources = await references(tx, head.id, value.revision);
  const revision = await publishRevision(
    tx,
    { ...scope, audience: head.audience },
    head.domain_key,
    head,
    {
      content: value.content,
      kind: value.kind,
      factual_status: value.factual_status,
      valid_from: value.valid_from,
      valid_until: value.valid_until,
      protected: value.protected,
      confidence: value.confidence,
      sources,
    },
    status,
  );
  await invalidateDependencies(tx, scope, [head.id], revision.data_revision);
  await enqueue(tx, scope.spaceId, 'invalidate', `${head.id}:${revision.revision}`);
  return revision.revision;
}

/** Mark a head's status, as a rewind sets a belief aside or its undo brings it back. */
async function setStatus(
  tx: MemoryTx,
  scope: MemoryScope,
  claimId: string,
  revision: number,
  from: string,
  to: string,
) {
  const rows = await tx`update memory_revisions set status = ${to},
      superseded_at = ${to === 'retracted' ? new Date().toISOString() : null}
    where claim_id = ${claimId} and revision = ${revision} and status = ${from} returning revision`;
  if (!rows.length) return false;
  const dataRevision = await bumpRevision(tx, scope.spaceId);
  await tx`update memory_revisions set data_revision = ${dataRevision}
    where claim_id = ${claimId} and revision = ${revision}`;
  await tx`update memory_profile set stale = true where space_id = ${scope.spaceId}`;
  await enqueue(tx, scope.spaceId, 'index', String(dataRevision));
  await enqueue(tx, scope.spaceId, 'markdown', String(dataRevision));
  await enqueue(tx, scope.spaceId, 'invalidate', `${claimId}:${revision}:${to}`);
  await invalidateDependencies(tx, scope, [claimId], dataRevision);
  return true;
}

export function stepView(step: RewindStep) {
  return {
    belief_id: step.claim_id,
    label: step.label,
    from: step.from.content,
    to: step.action === 'restore' ? step.to.content : null,
  };
}

function rewindView(row: Record<string, unknown>): MemoryRewind {
  return {
    id: String(row.id),
    label: String(row.label),
    created_at: iso(row.created_at as Date),
    undone_at: row.undone_at ? iso(row.undone_at as Date) : null,
    steps: ((row.steps as RewindStep[]) ?? []).map(stepView),
    skipped: ((row.skipped as string[]) ?? []).slice(0, 50),
  };
}

/** The window and wording a rewind target stands for, in the person's zone. */
export async function resolveTarget(
  sql: MemorySql,
  scope: MemoryScope,
  target: RewindTarget,
  timeZone: string,
): Promise<RewindWindow & { label: string }> {
  if ('day' in target) {
    const window = dayWindow(target.day, timeZone);
    return { ...window, label: `Undo what I learned on ${shortDate(window.start, timeZone)}` };
  }
  const [claim] = await sql`select id from memory_claims
    where id = ${target.belief_id} and space_id = ${scope.spaceId} and not hidden`;
  if (!claim) throw new MemoryError('claim_not_found');
  return {
    start: new Date(target.since),
    end: new Date(Date.now() + 60_000),
    claimIds: [target.belief_id],
    label: `Undo a change since ${shortDate(new Date(target.since), timeZone)}`,
  };
}

export async function previewRewind(sql: MemorySql, scope: MemoryScope, window: RewindWindow) {
  return sql.begin(async (tx) => {
    await lockSpace(tx, scope, false);
    const { steps, skipped } = await planSteps(tx, scope, window);
    return { steps: steps.map(stepView), skipped };
  });
}

/** Apply a rewind as one transaction and record it so it can be undone. */
export async function applyRewind(
  sql: MemorySql,
  scope: MemoryScope,
  window: RewindWindow & { label: string },
  target: unknown,
): Promise<MemoryRewind> {
  const row = await sql.begin(async (tx) => {
    await lockEventOrder(tx);
    await lockSpace(tx, scope);
    const { steps, skipped } = await planSteps(tx, scope, window);
    for (const step of steps) {
      const head = await getHead(tx, scope, step.claim_id);
      if (!head) continue;
      if (step.action === 'restore')
        step.produced = await republish(tx, scope, head, step.to, 'active');
      else
        await setStatus(
          tx,
          scope,
          step.claim_id,
          step.from.revision,
          step.from.status,
          'retracted',
        );
    }
    const [saved] = await tx`insert into memory_rewinds
      (id, space_id, label, target, window_start, window_end, steps, skipped)
      values (${newId('rwd')}, ${scope.spaceId}, ${window.label}, ${JSON.stringify(target)}::text::jsonb,
        ${window.start.toISOString()}, ${window.end.toISOString()}, ${JSON.stringify(steps)}::text::jsonb,
        ${JSON.stringify(skipped)}::text::jsonb) returning *`;
    return saved as Record<string, unknown>;
  });
  await notifyInvalidated(sql, scope.spaceId);
  return rewindView(row);
}

/** Undo a rewind: every belief it moved goes back to what it held just before it. */
export async function undoRewind(
  sql: MemorySql,
  scope: MemoryScope,
  id: string,
): Promise<MemoryRewind> {
  const row = await sql.begin(async (tx) => {
    await lockEventOrder(tx);
    await lockSpace(tx, scope);
    const [rewind] = await tx`select * from memory_rewinds
      where id = ${id} and space_id = ${scope.spaceId} for update`;
    if (!rewind) throw new MemoryError('rewind_not_found');
    if (rewind.undone_at) return rewind as Record<string, unknown>;
    const steps = (rewind.steps as RewindStep[]) ?? [];
    const skipped = [...((rewind.skipped as string[]) ?? [])];
    const undone: UndoStep[] = [];
    for (const step of [...steps].reverse()) {
      const head = await getHead(tx, scope, step.claim_id);
      if (step.action === 'restore') {
        if (!head || head.head_revision !== step.produced || head.current.status !== 'active') {
          skipped.push(`${step.label}: it changed again since, so it was left as it is.`);
          continue;
        }
        const status = step.from.status === 'disputed' ? 'disputed' : 'active';
        const produced = await republish(tx, scope, head, step.from, status);
        if (step.from.status === 'retracted')
          await setStatus(tx, scope, step.claim_id, produced, 'active', 'retracted');
        undone.push({ claim_id: step.claim_id, produced });
      } else {
        if (
          !head ||
          head.head_revision !== step.from.revision ||
          !(await setStatus(
            tx,
            scope,
            step.claim_id,
            step.from.revision,
            'retracted',
            step.from.status,
          ))
        ) {
          skipped.push(`${step.label}: it changed again since, so it was left as it is.`);
          continue;
        }
        undone.push({ claim_id: step.claim_id, produced: null });
      }
    }
    const [saved] = await tx`update memory_rewinds set undone_at = clock_timestamp(),
        undo_steps = ${JSON.stringify(undone)}::text::jsonb, skipped = ${JSON.stringify(skipped)}::text::jsonb
      where id = ${id} returning *`;
    return saved as Record<string, unknown>;
  });
  await notifyInvalidated(sql, scope.spaceId);
  return rewindView(row);
}

/**
 * What was learned, changed or corrected per local day, newest day first, with
 * the rewinds made on each day. Revisions a rewind published read as restored.
 */
export async function memoryTimeline(
  sql: MemorySql,
  scope: MemoryScope,
  timeZone: string,
  days: number,
  now = new Date(),
) {
  return sql.begin(async (tx) => {
    await lockSpace(tx, scope, false);
    const since = new Date(now.getTime() - days * 86_400_000);
    const produced = await rewindRevisions(tx, scope.spaceId);
    const rows =
      await tx`select r.claim_id, r.revision, r.status, r.recorded_at, r.protected, b.content,
        c.key, c.domain_key,
        (select b2.content from memory_revisions r2 join memory_revision_content b2
          on b2.claim_id = r2.claim_id and b2.revision = r2.revision
          where r2.claim_id = r.claim_id and r2.revision < r.revision and r2.status = any(${NOT_HISTORICAL})
          order by r2.revision desc limit 1) as previous,
        exists (select 1 from memory_references ref join memory_sources s on s.id = ref.source_id
          where ref.claim_id = r.claim_id and ref.revision = r.revision
            and (s.source_type = 'owner_edit' or s.stream = 'owner-corrections')) as corrected
      from memory_revisions r join memory_claims c on c.id = r.claim_id
      join memory_revision_content b on b.claim_id = r.claim_id and b.revision = r.revision
      where c.space_id = ${scope.spaceId} and not c.hidden and r.status = any(${NOT_HISTORICAL})
        and r.recorded_at >= ${since.toISOString()}
      order by r.recorded_at desc, r.claim_id limit 1000`;
    const rewinds = await tx`select * from memory_rewinds where space_id = ${scope.spaceId}
      and created_at >= ${since.toISOString()} order by created_at desc limit 100`;
    const byDay = new Map<string, { changes: BeliefChange[]; rewinds: MemoryRewind[] }>();
    const bucket = (day: string) => {
      let entry = byDay.get(day);
      if (!entry) {
        entry = { changes: [], rewinds: [] };
        byDay.set(day, entry);
      }
      return entry;
    };
    for (const row of rows) {
      const at = new Date(String(row.recorded_at));
      const restored = produced.has(`${row.claim_id}:${row.revision}`);
      const change: BeliefChange['change'] = restored
        ? 'restored'
        : row.previous === null
          ? 'learned'
          : row.corrected
            ? 'corrected'
            : 'changed';
      bucket(localDay(at, timeZone)).changes.push({
        belief_id: String(row.claim_id),
        label: subjectLabel(row.key as string | null, String(row.domain_key)),
        change,
        value: String(row.content),
        previous: row.previous === null ? null : String(row.previous),
        at: at.toISOString(),
      });
    }
    for (const rewind of rewinds)
      bucket(localDay(new Date(String(rewind.created_at)), timeZone)).rewinds.push(
        rewindView(rewind as Record<string, unknown>),
      );
    const today = localDay(now, timeZone);
    const yesterday = localDay(new Date(now.getTime() - 86_400_000), timeZone);
    return {
      time_zone: timeZone,
      days: [...byDay.entries()]
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([day, entry]) => ({
          day,
          label:
            day === today
              ? 'Today'
              : day === yesterday
                ? 'Yesterday'
                : shortDate(dayWindow(day, timeZone).start, timeZone),
          changes: entry.changes,
          rewinds: entry.rewinds,
        })),
    };
  });
}

/** The belief's current version, when it is still the value a change set. */
export const currentVersion = (head: ClaimHead | null, revision: number) =>
  head && head.head_revision === revision && ['active', 'disputed'].includes(head.current.status)
    ? beliefVersion(head.id, head.head_revision)
    : null;
