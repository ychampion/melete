/**
 * Automatic memory from chat.
 *
 * What a person types into a conversation or a job is evidence about them, and
 * it is the only chat text that is: assistant answers, pages, mail and tool
 * output never become facts about the person here. The first objective of a
 * job the person typed themselves counts the same way. Each piece is offered
 * to memory once, in the speaker's own memory for that space, and nothing else
 * is asked of the person. What they can say in plain words is acted on
 * directly:
 *
 * - "remember that …" / "keep in mind …", at the start of their own words, is
 *   kept as their own statement at owner trust; quoted or forwarded text never is;
 * - "forget that" / "don't remember that" removes what their previous kept
 *   message in the conversation taught memory;
 * - "forget <someone's something>" removes the one saved detail that names that
 *   subject. With no subject named, or several details matching, it asks which
 *   one instead, and when nothing matches it says so. A request to forget is
 *   never itself kept;
 * - "don't remember this" and "off the record" keep that one message out.
 *
 * Every piece the loop looks at leaves one `memory_capture` row, so a restart
 * neither repeats nor loses one. A message from a member of a shared space is
 * not kept: memory in a space belongs to its owner, and a member's words are
 * never written into it.
 *
 * A room is different: what anyone in it says there is the room's own
 * material. Each person's message in a room is kept in the room's memory, at
 * the trust of something another person said, under the name of the person
 * who said it, and only there (`captureRoom`). Their own words are what they
 * may later forget from it.
 */
import type { PgBoss } from 'pg-boss';
import { memoryKeyLabel } from '../experience/evidence.ts';
import { MemoryError, type MemoryScope, type MemorySql } from './db.ts';
import { persistEvidence } from './evidence.ts';
import { deleteMemorySource, forgetMemory, mayForgetRoomClaim } from './forget.ts';
import { lexicalTerms, stemTerm, tsqueryTerm } from './recall.ts';
import type { RestrictionJournal } from './restore.ts';
import { appendMemoryNotices, memoryNotice, memoryReply } from './trace.ts';
import { MEMORY_EXTRACT_QUEUE } from './work.ts';

export const CHAT_PUBLISHER = 'chat';
export const CHAT_STREAM = 'chat';
/** A request to forget is short; a long message that starts with "forget" is ordinary text. */
const COMMAND_LIMIT = 300;
/** A forget request names one thing; more words than this is a sentence about something else. */
const TARGET_WORDS = 8;
/** Details one reply may name when asking which one to forget. */
const ASK_LIMIT = 4;
/** A claim left pending this long by a stopped process is picked up again. */
const PENDING_LEASE = '5 minutes';

export type ChatIntent =
  | { kind: 'message'; explicit: boolean }
  | { kind: 'forget'; target: string | null }
  | { kind: 'skip' };

/**
 * The words people use for the field of a detail, against the words its saved
 * key uses: "Maya's number" is the claim on `contact.maya.phone`. A field word
 * alone never names whose detail it is.
 */
const FIELD_WORDS: Record<string, string[]> = {
  number: ['phone', 'number'],
  mobile: ['phone', 'mobile'],
  cell: ['phone', 'cell'],
  phone: ['phone', 'number'],
  email: ['email'],
  mail: ['email', 'mail'],
  address: ['email', 'location', 'address'],
  birthday: ['date', 'birthday'],
  date: ['date'],
  place: ['location', 'place'],
  location: ['location'],
  contact: ['contact'],
  details: [],
  detail: [],
  info: [],
};
const REFERS_BACK = /^(?:that|it|what i (?:just )?(?:said|told you|wrote))$/i;
/** Text the person pasted or passed on, not said: a quotation, a forward, a reply chain. */
export const QUOTED = /^\s*(?:>|["“‘'`]|-{3,}|fwd?:|forwarded message|begin forwarded)/i;
export const FORWARDED = /^-{2,}\s*forwarded message|^on .{3,80} wrote:$/im;

/** What a message asks of memory, read from its opening words alone. */
export function chatIntent(text: string): ChatIntent {
  const trimmed = text.trim();
  const quoted = QUOTED.test(trimmed) || FORWARDED.test(trimmed);
  if (trimmed.length <= COMMAND_LIMIT && !quoted) {
    // "Don't remember this" keeps this one message out, whatever follows it.
    if (
      /^(?:please\s+)?(?:don'?t|do not|never)\s+(?:remember|keep|save|store)\s+this\b/i.test(
        trimmed,
      )
    )
      return { kind: 'skip' };
    if (/^off the record\b/i.test(trimmed)) return { kind: 'skip' };
    // "Don't remember that" on its own reaches back to the previous message.
    if (/^(?:please\s+)?(?:don'?t|do not)\s+(?:remember|keep)\s+(?:that|it)[\s.!]*$/i.test(trimmed))
      return { kind: 'forget', target: null };
    const target =
      /^(?:please\s+)?(?:forget|stop remembering)\s+(?:about\s+)?(.+?)[\s.!]*$/is.exec(
        trimmed,
      )?.[1] ??
      /^(?:please\s+)?(?:erase|delete|remove)\s+(.+?)\s+from\s+(?:your\s+)?memory[\s.!]*$/is.exec(
        trimmed,
      )?.[1];
    if (target !== undefined) {
      const named = target.trim();
      if (REFERS_BACK.test(named)) return { kind: 'forget', target: null };
      // "Forget it, just book the train" is about the train. A request to forget
      // names one thing and says nothing else.
      if (!/[,;:?]/.test(named) && named.split(/\s+/).length <= TARGET_WORDS)
        return { kind: 'forget', target: named };
    }
  }
  return {
    kind: 'message',
    explicit:
      !quoted && /^(?:please\s+)?(?:remember(?:\s+that)?|keep\s+in\s+mind)\b/i.test(trimmed),
  };
}

export type CaptureOptions = {
  sql: MemorySql;
  boss?: PgBoss;
  journal: RestrictionJournal;
  /** The speaker's memory scope for a job, from server authority; throws when there is none. */
  scopeForJob: (jobId: string) => Promise<MemoryScope>;
  /**
   * Why a message said in this job is private, or null: the privacy router's
   * answer, recorded on the source so what memory learns from it stays out of
   * cloud requests. Required: capture has no view of its own on privacy.
   */
  privacyOrigin: (jobId: string, text: string) => Promise<string | null>;
  /**
   * A room's memory as the service holds it, provisioned on first use. Left
   * out, together with `roomPrivacyOrigin`, nothing said in a room is kept.
   */
  roomScope?: (spaceId: string) => Promise<MemoryScope>;
  /** Why a message said in a room is private, or null: the privacy router's answer. */
  roomPrivacyOrigin?: (spaceId: string, text: string) => Promise<string | null>;
  onError?: (code: string) => void;
};

type Pending = {
  seq: number;
  job_id: string;
  space_id: string;
  principal_id: string;
  /** Who said it, as the service recorded it; absent on older events. */
  speaker_id: string | null;
  text: string;
  created_at: Date;
  /** False when the agent it was said to keeps nothing in memory; null with no agent. */
  writes_memory: boolean | null;
};

/**
 * Offer every new message, and every new job objective the person typed, to
 * memory once. Returns how many were looked at.
 */
export async function captureChat(options: CaptureOptions, limit = 50): Promise<number> {
  const { sql } = options;
  const rows = await sql`with fresh as (
      select e.seq from event e
      where e.seq > (select coalesce(max(event_seq), 0) from memory_capture where outcome <> 'pending')
        and not exists (select 1 from memory_capture c where c.event_seq = e.seq)
      union all
      select c.event_seq from memory_capture c
      where c.outcome = 'pending' and c.created_at < clock_timestamp() - ${PENDING_LEASE}::interval)
    select e.seq, e.job_id, e.created_at, j.space_id,
      coalesce(j.principal_id, (select id from owner limit 1)) as principal_id,
      case when e.type = 'job_created' then j.objective else e.payload->>'text' end as text,
      case when e.type = 'job_created' then j.principal_id else e.payload->>'principal_id' end as speaker_id,
      a.writes_memory
    from fresh f join event e on e.seq = f.seq join job j on j.id = e.job_id
    -- The agent the message was said to; an older message names none and was said to the chat's.
    left join agent a on a.id = coalesce(e.payload->>'agent_id', j.agent_id) and a.space_id = j.space_id
    -- An option the agent offered and the person picked is a choice, not their own words.
    where (e.type = 'notice' and e.payload->>'kind' = 'user_message' and e.payload->'chosen' is null)
      -- A job's first objective is the person's own words only when they typed it.
      or (e.type = 'job_created' and j.kind <> 'chat' and j.objective_origin = 'owner_request')
    order by e.seq limit ${limit}`;
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
  // Memory in a space is its owner's, and a message is theirs only when the
  // service recorded them as its speaker. A job's owner is not proof of who
  // typed into it, so a message with no recorded speaker is not kept, and
  // neither is one typed by anyone else or on anyone else's job.
  const [space] =
    await sql`select coalesce(s.owner_principal_id, (select id from owner limit 1)) as owner_id
      from space s where s.id = ${row.space_id}`;
  if (
    scope.role !== 'owner' ||
    !row.speaker_id ||
    row.speaker_id !== space?.owner_id ||
    space?.owner_id !== row.principal_id ||
    (scope.principalId !== undefined && scope.principalId !== row.principal_id)
  )
    return { outcome: 'skipped:member', sourceId: null };
  const intent = chatIntent(text);
  if (intent.kind === 'skip') return { outcome: 'skipped:asked', sourceId: null };
  // A request to forget is acted on, or answered, and is never itself kept.
  if (intent.kind === 'forget')
    return { outcome: await forgetFromChat(options, scope, row, intent.target), sourceId: null };
  const [settings] =
    await sql`select capture from memory_settings where principal_id = ${row.principal_id}`;
  if (settings && !settings.capture) return { outcome: 'skipped:off', sourceId: null };
  // An agent the person set not to keep memory keeps nothing said to it.
  if (row.writes_memory === false) return { outcome: 'skipped:agent', sourceId: null };
  // Read before anything is kept, so a message is never stored without it.
  const privateOrigin = await options.privacyOrigin(row.job_id, text);
  const evidence = await sql.begin(async (tx) => {
    // Everything the person types is kept at owner trust, "Remember that …"
    // included. Asking to remember states a fact; it does not correct one, so it
    // is never recorded as an owner edit.
    const saved = await persistEvidence(tx, scope, {
      stream: CHAT_STREAM,
      source_identity: `event:${row.seq}`,
      source_version: '1',
      source_type: 'message',
      author: 'owner',
      event_at: new Date(row.created_at).toISOString(),
      text: text.slice(0, 64000),
    });
    if (privateOrigin)
      await tx`update memory_sources set private_origin = ${privateOrigin}
        where id = ${saved.source.source_id} and private_origin is null`;
    return saved;
  });
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

/** The subject a saved detail about the person themselves is filed under. */
const OWN_SUBJECTS = ['me', 'my', 'self', 'mine', 'owner'];
/**
 * Words in a request to forget that say how, not what: "forget my shellfish
 * allergy entirely" names the allergy. Left in, they had to appear in the
 * detail too, and a request that plainly named one matched nothing.
 */
const FORGET_FILLER = new Set([
  'entirely',
  'completely',
  'totally',
  'fully',
  'permanently',
  'forever',
  'everything',
  'anything',
  'all',
  'now',
  'saved',
  'stored',
  'remembered',
  'info',
  'information',
  'stuff',
  'thing',
  'things',
  'fact',
  'facts',
  'record',
  'records',
  'memory',
]);
/**
 * The saved details a "forget …" names. A named subject ("Maya's number") means
 * that subject only; "my …" means the person's own details only, which is
 * everything saved except what is about another person (a contact other than
 * the person themselves): "my gym locker number" is a detail learned as
 * `gym.equinox.locker_number`, with no "me" in it; and when a
 * field is named ("number", "email") the detail must be that field. A request
 * that names neither a subject nor "my" names nothing, and null says so.
 */
async function namedDetails(sql: MemorySql, scope: MemoryScope, target: string) {
  const terms = lexicalTerms(target).filter((term) => !FORGET_FILLER.has(term));
  const subject = terms.filter((term) => !(term in FIELD_WORDS));
  const own = /\b(?:my|mine|me)\b/i.test(target);
  if (!subject.length && !own) return null;
  const fields = terms.filter((term) => term in FIELD_WORDS && FIELD_WORDS[term]?.length);
  const query = [
    ...subject.map(stemTerm),
    ...fields.map((term) => `(${(FIELD_WORDS[term] ?? []).map(tsqueryTerm).join(' | ')})`),
  ].join(' & ');
  return sql`select c.id, c.key from memory_claims c
    join memory_revisions r on r.claim_id = c.id and r.revision = c.head_revision
    join memory_revision_content b on b.claim_id = r.claim_id and b.revision = r.revision
    where c.space_id = ${scope.spaceId} and not c.hidden
      and (${!own} or split_part(c.domain_key, '.', 1) <> 'contact'
        or split_part(c.domain_key, '.', 2) = any(${OWN_SUBJECTS}))
      and (${query === ''} or to_tsvector('simple', replace(replace(c.domain_key, '.', ' '), ':', ' ') || ' ' || b.content)
        @@ to_tsquery('simple', ${query || "'x'"}))
    order by r.data_revision desc limit ${ASK_LIMIT + 1}`;
}

/**
 * "Forget that" removes what the previous kept message in this conversation
 * taught memory, source and all. "Forget <something>" removes the one saved
 * detail it names. Anything less certain is answered in the conversation
 * rather than guessed at. Returns the capture outcome.
 */
async function forgetFromChat(
  options: CaptureOptions,
  scope: MemoryScope,
  row: Pending,
  target: string | null,
): Promise<string> {
  const { sql } = options;
  const at = new Date();
  const tell = (reply: Parameters<typeof memoryReply>[0]) =>
    appendMemoryNotices(sql, row.job_id, [memoryReply(reply)]).catch(() =>
      options.onError?.('memory_trace_failed'),
    );
  if (target === null) {
    const [previous] = await sql`select source_id from memory_capture
      where job_id = ${row.job_id} and event_seq < ${row.seq} and outcome = 'remembered' and source_id is not null
      order by event_seq desc limit 1`;
    if (!previous) {
      await tell({ id: `forget:${row.seq}`, text: 'Nothing was saved from your last message', at });
      return 'forgot:none';
    }
    const named = await sql`select distinct c.id, c.key from memory_references ref
      join memory_claims c on c.id = ref.claim_id
      where ref.source_id = ${previous.source_id} and c.space_id = ${scope.spaceId} and not c.hidden`;
    await deleteMemorySource(sql, scope, previous.source_id as string, options.journal);
    await notifyForgotten(options, row, named, at);
    return 'forgot';
  }
  const matches = await namedDetails(sql, scope, target);
  if (matches === null) {
    await tell({
      id: `forget:${row.seq}`,
      text: `Say whose ${target.replace(/^my\s+/i, '')} to forget, for example "forget Ana's email"`,
      quote: target,
      at,
    });
    return 'forgot:ask';
  }
  if (!matches.length) {
    await tell({ id: `forget:${row.seq}`, text: 'Nothing saved matched', quote: target, at });
    return 'forgot:none';
  }
  if (matches.length > 1) {
    const labels = matches
      .slice(0, ASK_LIMIT)
      .map((claim) => memoryKeyLabel(claim.key as string | null));
    await tell({
      id: `forget:${row.seq}`,
      text: `More than one saved detail matched: ${labels.join(', ')}. Say which one to forget`,
      quote: target,
      at,
    });
    return 'forgot:ask';
  }
  const [only] = matches;
  if (!only) return 'forgot:none';
  await forgetMemory(sql, scope, { claim_id: only.id }, options.journal);
  await notifyForgotten(options, row, [only], at);
  return 'forgot';
}

async function notifyForgotten(
  options: CaptureOptions,
  row: Pending,
  claims: readonly Record<string, unknown>[],
  at: Date,
) {
  if (!claims.length) return;
  await appendMemoryNotices(options.sql, row.job_id, [
    memoryNotice({
      op: 'forget',
      id: `forget:${row.seq}`,
      keys: claims.map((claim) => (claim.key as string | null) ?? null),
      value: null,
      claimId: null,
      at,
    }),
  ]).catch(() => options.onError?.('memory_trace_failed'));
}

/**
 * After extraction commits a chat message, tell its conversation what memory
 * now holds because of it: one notice per saved detail whose current value
 * cites that message, "write" for a new one and "correct" for a changed one.
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
    order by c.key, c.id limit 5`;
  const at = new Date();
  await appendMemoryNotices(
    sql,
    capture.job_id as string,
    claims.map((claim) => {
      const op = (claim.head_revision as number) > 1 ? 'correct' : 'write';
      return memoryNotice({
        op,
        id: `${op}:${claim.id}@${claim.head_revision}`,
        keys: [(claim.key as string | null) ?? null],
        value: claim.content as string,
        claimId: claim.id as string,
        at,
      });
    }),
  );
}

/** A capture loop that never overlaps itself. */
export function startChatCapture(options: CaptureOptions, intervalMs = 1000) {
  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (running) return;
    running = captureChat(options)
      .then(() => captureRoom(options))
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

export const ROOM_PUBLISHER = 'room';
export const ROOM_STREAM = 'room';
/** The source a room message is kept as: one per message, so deleting it finds it. */
export const roomSourceIdentity = (messageId: string) => `room_message:${messageId}`;

type RoomPending = {
  id: string;
  space_id: string;
  thread_id: string;
  author_principal_id: string;
  text: string;
  created_at: Date;
};

/**
 * Offer every new message said in a room to that room's memory once, whoever
 * said it. Returns how many were looked at. Without a room scope and a privacy
 * answer for rooms, nothing said in a room is kept.
 */
export async function captureRoom(options: CaptureOptions, limit = 50): Promise<number> {
  const { sql } = options;
  if (!options.roomScope || !options.roomPrivacyOrigin) return 0;
  const rows =
    await sql`select m.id, m.space_id, m.thread_id, m.author_principal_id, m.text, m.created_at
    from room_message m join space s on s.id = m.space_id
    where m.redacted_at is null and m.kind in ('person', 'handoff_result')
      and s.kind = 'shared' and s.removed_at is null
      and not exists (select 1 from memory_room_capture c where c.message_id = m.id
        and (c.outcome <> 'pending' or c.created_at >= clock_timestamp() - ${PENDING_LEASE}::interval))
    order by m.created_at, m.id limit ${limit}`;
  let seen = 0;
  for (const row of rows as unknown as RoomPending[]) {
    const [claimed] =
      await sql`insert into memory_room_capture (message_id, space_id, outcome) values (${row.id}, ${row.space_id}, 'pending')
      on conflict (message_id) do update set created_at = clock_timestamp()
        where memory_room_capture.outcome = 'pending' and memory_room_capture.created_at < clock_timestamp() - ${PENDING_LEASE}::interval
      returning message_id`;
    if (!claimed) continue;
    seen++;
    let outcome: string;
    let sourceId: string | null = null;
    try {
      ({ outcome, sourceId } = await captureRoomOne(options, row));
    } catch (error) {
      outcome = `failed:${error instanceof MemoryError ? error.code : 'capture_failed'}`;
      options.onError?.(outcome);
    }
    if (outcome !== 'pending')
      await sql`update memory_room_capture set outcome = ${outcome}, source_id = ${sourceId} where message_id = ${row.id}`;
  }
  return seen;
}

async function captureRoomOne(
  options: CaptureOptions,
  row: RoomPending,
): Promise<{ outcome: string; sourceId: string | null }> {
  const { sql } = options;
  const text = (row.text ?? '').trim();
  if (!text) return { outcome: 'empty', sourceId: null };
  let scope: MemoryScope;
  try {
    const room = await options.roomScope?.(row.space_id);
    if (room?.audience !== 'space') return { outcome: 'skipped:scope_denied', sourceId: null };
    scope = { ...room, publisher: ROOM_PUBLISHER };
  } catch (error) {
    if (error instanceof MemoryError && error.code === 'restore_pending')
      return { outcome: 'pending', sourceId: null };
    if (error instanceof MemoryError && error.code === 'scope_denied')
      return { outcome: 'skipped:scope_denied', sourceId: null };
    throw error;
  }
  const intent = chatIntent(text);
  if (intent.kind === 'skip') return { outcome: 'skipped:asked', sourceId: null };
  if (intent.kind === 'forget')
    return { outcome: await forgetFromRoom(options, scope, row, intent.target), sourceId: null };
  const [settings] =
    await sql`select capture from memory_settings where principal_id = ${row.author_principal_id}`;
  if (settings && !settings.capture) return { outcome: 'skipped:off', sourceId: null };
  const privateOrigin = await options.roomPrivacyOrigin?.(row.space_id, text);
  const evidence = await sql.begin(async (tx) => {
    // A message its author deleted while this one was read is not kept: the
    // deletion holds this row while it removes what was kept of it.
    const [current] = await tx`select redacted_at from room_message where id = ${row.id} for share`;
    if (!current || current.redacted_at) return null;
    const saved = await persistEvidence(tx, scope, {
      stream: ROOM_STREAM,
      source_identity: roomSourceIdentity(row.id),
      source_version: '1',
      source_type: 'message',
      author: 'member',
      author_principal_id: row.author_principal_id,
      event_at: new Date(row.created_at).toISOString(),
      text: text.slice(0, 64000),
    });
    if (privateOrigin)
      await tx`update memory_sources set private_origin = ${privateOrigin}
        where id = ${saved.source.source_id} and private_origin is null`;
    return saved;
  });
  if (!evidence) return { outcome: 'skipped:deleted', sourceId: null };
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
 * "Forget that" in a room removes what the speaker's previous kept message in
 * that thread taught the room. "Forget <something>" removes the one saved
 * detail it names, when the speaker may forget it here: a room's owner any
 * detail, anyone else only one that rests on their own words alone. Nothing
 * less certain is acted on, and a request to forget is never itself kept.
 */
async function forgetFromRoom(
  options: CaptureOptions,
  scope: MemoryScope,
  row: RoomPending,
  target: string | null,
): Promise<string> {
  const { sql } = options;
  if (target === null) {
    const [previous] = await sql`select c.source_id from memory_room_capture c
      join room_message m on m.id = c.message_id
      where m.thread_id = ${row.thread_id} and m.author_principal_id = ${row.author_principal_id}
        and (m.created_at, m.id) < (${row.created_at}, ${row.id})
        and c.outcome = 'remembered' and c.source_id is not null
      order by m.created_at desc, m.id desc limit 1`;
    if (!previous) return 'forgot:none';
    await deleteMemorySource(sql, scope, previous.source_id as string, options.journal);
    return 'forgot';
  }
  const matches = await namedDetails(sql, scope, target);
  if (matches === null) return 'forgot:ask';
  const allowed: Record<string, unknown>[] = [];
  for (const claim of matches)
    if (await mayForgetRoomClaim(sql, scope.spaceId, claim.id as string, row.author_principal_id))
      allowed.push(claim);
  if (allowed.length !== 1) return allowed.length ? 'forgot:ask' : 'forgot:none';
  const [only] = allowed;
  if (!only) return 'forgot:none';
  await forgetMemory(sql, scope, { claim_id: only.id }, options.journal);
  return 'forgot';
}
