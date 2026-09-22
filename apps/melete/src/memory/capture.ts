/**
 * Automatic memory from chat.
 *
 * What a person types into a conversation or a job is evidence about them, and
 * it is the only chat text that is: assistant answers, pages, mail and tool
 * output never become facts about the person here. Each message is offered to
 * memory once, in the speaker's own memory for that space, and nothing else is
 * asked of the person. Three things they can say in plain words are acted on
 * directly:
 *
 * - "remember that ..." is kept as the person's own statement, at owner trust;
 * - "forget that" / "don't remember that" removes what was learned from their
 *   previous message, and "forget <something>" removes the saved details that
 *   name it, through the same removal path and journal as every other forget;
 * - "don't remember this: ..." is simply not kept.
 *
 * Every message the loop looks at leaves one `memory_capture` row, so a restart
 * neither repeats nor loses one. A message from a member of a shared space is
 * not kept: memory in a space belongs to its owner, and a member's words are
 * never written into it.
 */
import type { PgBoss } from 'pg-boss';
import { MemoryError, type MemoryScope, type MemorySql } from './db.ts';
import { persistEvidence } from './evidence.ts';
import { deleteMemorySource, forgetMemory } from './forget.ts';
import { lexicalTerms } from './recall.ts';
import type { RestrictionJournal } from './restore.ts';
import { appendMemoryTraces, type MemoryTrace, memoryTrace } from './trace.ts';
import { MEMORY_EXTRACT_QUEUE } from './work.ts';

export const CHAT_PUBLISHER = 'chat';
export const CHAT_STREAM = 'chat';
/** A request to forget is short; a long message that starts with "forget" is ordinary text. */
const COMMAND_LIMIT = 300;
/** Saved details one "forget <something>" may remove, so a vague request cannot empty memory. */
const FORGET_LIMIT = 5;
/** A claim left pending this long by a stopped process is picked up again. */
const PENDING_LEASE = '5 minutes';

export type ChatIntent =
  | { kind: 'message'; explicit: boolean }
  | { kind: 'forget'; target: string | null }
  | { kind: 'skip' };

/**
 * The words people use for a detail, against the words its saved key uses:
 * "Maya's number" is the claim on `contact.maya.phone`.
 */
const SAME_THING: Record<string, string[]> = {
  number: ['phone'],
  mobile: ['phone'],
  cell: ['phone'],
  phone: ['number'],
  mail: ['email'],
  address: ['email', 'location'],
  birthday: ['date'],
  place: ['location'],
};
const REFERS_BACK = /^(?:that|this|it|what i (?:just )?(?:said|told you|wrote))[\s.!]*$/i;

/** What a message asks of memory, read from its opening words alone. */
export function chatIntent(text: string): ChatIntent {
  const trimmed = text.trim();
  if (trimmed.length <= COMMAND_LIMIT) {
    const dont =
      /^(?:please\s+)?(?:don'?t|do not|never)\s+(?:remember|keep|save|store)\s+(that|this|it)\b\s*([,:;-]\s*)?(.*)$/is.exec(
        trimmed,
      );
    if (dont) {
      // "Don't remember this: ..." says what follows is not to be kept;
      // "don't remember that" on its own reaches back to the previous message.
      if ((dont[3] ?? '').trim()) return { kind: 'skip' };
      return { kind: 'forget', target: null };
    }
    if (/^off the record\b/i.test(trimmed)) return { kind: 'skip' };
    const forget =
      /^(?:please\s+)?(?:forget|erase|stop remembering)\s+(?:about\s+)?(.+?)\s*[.!]*$/is.exec(
        trimmed,
      );
    if (forget) {
      const target = (forget[1] ?? '').trim();
      return { kind: 'forget', target: REFERS_BACK.test(target) ? null : target };
    }
  }
  return {
    kind: 'message',
    explicit: /^(?:please\s+)?(?:remember|keep in mind|note)\b/i.test(trimmed),
  };
}

export type CaptureOptions = {
  sql: MemorySql;
  boss?: PgBoss;
  journal: RestrictionJournal;
  /** The speaker's memory scope for a job, from server authority; throws when there is none. */
  scopeForJob: (jobId: string) => Promise<MemoryScope>;
  onError?: (code: string) => void;
};

type Pending = {
  seq: number;
  job_id: string;
  space_id: string;
  principal_id: string;
  text: string;
  created_at: Date;
};

/** Offer every new chat message to memory once. Returns how many were looked at. */
export async function captureChat(options: CaptureOptions, limit = 50): Promise<number> {
  const { sql } = options;
  const rows =
    await sql`select e.seq, e.job_id, e.created_at, e.payload->>'text' as text, j.space_id,
      coalesce(j.principal_id, (select id from owner limit 1)) as principal_id
    from event e join job j on j.id = e.job_id
    where e.seq > (select coalesce(max(event_seq), 0) from memory_capture where outcome <> 'pending')
      and e.type = 'notice' and e.payload->>'kind' = 'user_message'
      and not exists (select 1 from memory_capture c where c.event_seq = e.seq)
    union all
    select e.seq, e.job_id, e.created_at, e.payload->>'text' as text, j.space_id,
      coalesce(j.principal_id, (select id from owner limit 1)) as principal_id
    from memory_capture c join event e on e.seq = c.event_seq join job j on j.id = e.job_id
    where c.outcome = 'pending' and c.created_at < clock_timestamp() - ${PENDING_LEASE}::interval
    order by seq limit ${limit}`;
  let seen = 0;
  for (const row of rows as unknown as Pending[]) {
    // Claiming the row first keeps two service processes from acting on one message twice.
    const [claimed] =
      await sql`insert into memory_capture (event_seq, job_id, space_id, outcome) values (${row.seq}, ${row.job_id}, ${row.space_id}, 'pending')
      on conflict (event_seq) do update set created_at = clock_timestamp()
        where memory_capture.outcome = 'pending' and memory_capture.created_at < clock_timestamp() - ${PENDING_LEASE}::interval
      returning event_seq`;
    if (!claimed) continue;
    seen++;
    let outcome: string;
    let sourceId: string | null = null;
    try {
      ({ outcome, sourceId } = await captureOne(options, row));
    } catch (error) {
      outcome = `failed:${error instanceof MemoryError ? error.code : 'capture_failed'}`;
      options.onError?.(outcome);
    }
    if (outcome !== 'pending')
      await sql`update memory_capture set outcome = ${outcome}, source_id = ${sourceId} where event_seq = ${row.seq}`;
  }
  return seen;
}

async function captureOne(
  options: CaptureOptions,
  row: Pending,
): Promise<{ outcome: string; sourceId: string | null }> {
  const { sql } = options;
  const text = (row.text ?? '').trim();
  if (!text) return { outcome: 'empty', sourceId: null };
  let scope: MemoryScope;
  try {
    scope = { ...(await options.scopeForJob(row.job_id)), publisher: CHAT_PUBLISHER };
  } catch (error) {
    // A space still replaying its removals is only waiting: the message stays
    // claimed and is picked up again once the claim lapses.
    if (error instanceof MemoryError && error.code === 'restore_pending')
      return { outcome: 'pending', sourceId: null };
    if (error instanceof MemoryError && error.code === 'scope_denied')
      return { outcome: 'skipped:scope_denied', sourceId: null };
    throw error;
  }
  if (scope.role !== 'owner' || scope.principalId !== row.principal_id)
    return { outcome: 'skipped:member', sourceId: null };
  const intent = chatIntent(text);
  if (intent.kind === 'skip') return { outcome: 'skipped:asked', sourceId: null };
  // A message that only looks like a request to forget, and names nothing
  // saved, is an ordinary message and is kept like one.
  if (intent.kind === 'forget' && (await forgetFromChat(options, scope, row, intent.target)))
    return { outcome: 'forgot', sourceId: null };
  const [settings] =
    await sql`select capture from memory_settings where principal_id = ${row.principal_id}`;
  if (settings && !settings.capture) return { outcome: 'skipped:off', sourceId: null };
  const evidence = await sql.begin((tx) =>
    persistEvidence(
      tx,
      scope,
      {
        stream: CHAT_STREAM,
        source_identity: `event:${row.seq}`,
        source_version: '1',
        source_type: 'message',
        author: 'owner',
        event_at: new Date(row.created_at).toISOString(),
        text: text.slice(0, 64000),
      },
      // "Remember that ..." is the person's own statement, kept at owner trust.
      intent.kind === 'message' && intent.explicit,
    ),
  );
  if (evidence.source.state !== 'active')
    return { outcome: 'skipped:suppressed', sourceId: evidence.source.source_id };
  if (options.boss) {
    const work =
      await sql`select id from memory_work where source_id = ${evidence.source.source_id} and status = 'pending'`;
    for (const item of work)
      await options.boss.send(
        MEMORY_EXTRACT_QUEUE,
        { work_id: item.id, space_id: scope.spaceId },
        { singletonKey: item.id as string, singletonSeconds: 1 },
      );
  }
  return { outcome: 'remembered', sourceId: evidence.source.source_id };
}

/**
 * "Forget that" removes what the previous kept message in this conversation
 * taught memory, source and all. "Forget <something>" removes the saved details
 * in this space whose words include every meaningful word of <something>, and
 * returns false when nothing saved matched, so the message is kept as ordinary
 * text instead.
 */
async function forgetFromChat(
  options: CaptureOptions,
  scope: MemoryScope,
  row: Pending,
  target: string | null,
): Promise<boolean> {
  const { sql } = options;
  const at = new Date();
  const traces: MemoryTrace[] = [];
  if (target === null) {
    const [previous] = await sql`select source_id from memory_capture
      where job_id = ${row.job_id} and event_seq < ${row.seq} and outcome = 'remembered' and source_id is not null
      order by event_seq desc limit 1`;
    if (previous) {
      const named = await sql`select distinct c.id, c.key from memory_references ref
        join memory_claims c on c.id = ref.claim_id
        where ref.source_id = ${previous.source_id} and c.space_id = ${scope.spaceId} and not c.hidden`;
      await deleteMemorySource(sql, scope, previous.source_id as string, options.journal);
      for (const claim of named.slice(0, 3))
        traces.push(
          memoryTrace({
            change: 'forgot',
            id: `memory-forget:${row.seq}:${claim.id}`,
            key: (claim.key as string | null) ?? null,
            value: null,
            claimId: null,
            at,
          }),
        );
    }
  } else {
    const terms = lexicalTerms(target);
    const query = terms
      .map(
        (term) => `(${[term, ...(SAME_THING[term] ?? [])].map((word) => `'${word}'`).join(' | ')})`,
      )
      .join(' & ');
    const matches = terms.length
      ? await sql`select c.id, c.key from memory_claims c
          join memory_revisions r on r.claim_id = c.id and r.revision = c.head_revision
          join memory_revision_content b on b.claim_id = r.claim_id and b.revision = r.revision
          where c.space_id = ${scope.spaceId} and not c.hidden
            and to_tsvector('simple', replace(replace(c.domain_key, '.', ' '), ':', ' ') || ' ' || b.content)
              @@ to_tsquery('simple', ${query})
          order by r.data_revision desc limit ${FORGET_LIMIT}`
      : [];
    for (const claim of matches) {
      await forgetMemory(sql, scope, { claim_id: claim.id }, options.journal);
      traces.push(
        memoryTrace({
          change: 'forgot',
          id: `memory-forget:${row.seq}:${claim.id}`,
          key: (claim.key as string | null) ?? null,
          value: null,
          claimId: null,
          at,
        }),
      );
    }
  }
  if (target !== null && !traces.length) return false;
  if (!traces.length)
    traces.push({
      ...memoryTrace({
        change: 'forgot',
        id: `memory-forget:${row.seq}`,
        key: null,
        value: null,
        claimId: null,
        at,
      }),
      output_summary: { text: 'Nothing saved matched that' },
    });
  await appendMemoryTraces(sql, row.job_id, traces);
  return true;
}

/**
 * After extraction commits a chat message, tell its conversation what memory
 * now holds because of it: one entry per saved detail whose current value
 * cites that message.
 */
export async function traceChatExtraction(sql: MemorySql, sourceId: string) {
  const [capture] =
    await sql`select job_id from memory_capture where source_id = ${sourceId} and outcome = 'remembered'`;
  if (!capture?.job_id) return;
  const claims =
    await sql`select distinct c.id, c.key, c.head_revision, b.content from memory_references ref
    join memory_claims c on c.id = ref.claim_id and ref.revision = c.head_revision
    join memory_revisions r on r.claim_id = c.id and r.revision = c.head_revision
    join memory_revision_content b on b.claim_id = r.claim_id and b.revision = r.revision
    where ref.source_id = ${sourceId} and not c.hidden and r.status in ('active','disputed')
    order by c.id limit 5`;
  const at = new Date();
  await appendMemoryTraces(
    sql,
    capture.job_id as string,
    claims.map((claim) =>
      memoryTrace({
        change: (claim.head_revision as number) > 1 ? 'updated' : 'remembered',
        id: `memory:${claim.id}@${claim.head_revision}`,
        key: (claim.key as string | null) ?? null,
        value: claim.content as string,
        claimId: claim.id as string,
        at,
      }),
    ),
  );
}

/** A capture loop that never overlaps itself. */
export function startChatCapture(options: CaptureOptions, intervalMs = 1000) {
  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (running) return;
    running = captureChat(options)
      .then(() => undefined)
      .catch(() => options.onError?.('memory_capture_failed'))
      .finally(() => {
        running = undefined;
      });
  }, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
