/**
 * Beliefs: saved details seen from the person's side. Each is grouped by what
 * it is about, says where it came from in plain words, links to the message or
 * receipt it came from when there is one, and carries its trust level. The
 * mapping from sources to words lives here as pure functions, so it is tested
 * without a database; the reads below only gather the facts it maps.
 */
import { createHash } from 'node:crypto';
import type {
  Belief,
  BeliefCategory,
  BeliefSource,
  BeliefTrust,
  OriginTrust,
} from '@melete/contracts';
import { type ClaimHead, eligibleRevision, getHead, listClaims } from './claims.ts';
import {
  lockSpace,
  MemoryError,
  type MemoryScope,
  type MemorySql,
  type MemoryTx,
  newId,
} from './db.ts';
import { forgetMemory } from './forget.ts';
import type { RestrictionJournal } from './restore.ts';
import { shortDate } from './zoned.ts';

/** The facts about one source that decide how it is described. */
export type SourceFacts = {
  publisher: string;
  stream: string;
  source_type: string;
  author: string;
  event_at: string;
};

const MAIL = /\b(mail|email|e-mail|gmail|outlook|imap|inbox|mailbox)\b/;
const CALENDAR = /\b(calendar|caldav|ical|ics|events?)\b/;
const CONTACTS = /\b(contacts?|carddav|address ?book|people)\b/;
/** Publishers that write through the memory API on a person's behalf: connected assistants. */
const API_PUBLISHERS = new Set(['authenticated-principal', 'authenticated-owner']);

const words = (value: string) => value.toLowerCase().replace(/[._:/-]+/g, ' ');

/** Which kind of source this is, from how the bytes arrived. */
export function sourceKind(source: SourceFacts): BeliefSource['kind'] {
  const stream = words(source.stream);
  if (source.source_type === 'owner_edit' || source.stream === 'owner-corrections')
    return 'correction';
  if (source.stream === 'onboarding') return 'setup';
  if (source.stream === 'import') return 'import';
  if (source.publisher === 'chat') return source.author === 'owner' ? 'chat' : 'message';
  if (source.source_type === 'assistant') return 'worked_out';
  if (source.source_type === 'receipt') return 'receipt';
  if (MAIL.test(stream)) return 'email';
  if (CALENDAR.test(stream)) return 'calendar';
  if (CONTACTS.test(stream)) return 'contacts';
  if (source.source_type === 'observation') return 'connected';
  if (source.source_type === 'message' && source.author === 'external') return 'message';
  if (source.source_type === 'document') return 'document';
  if (API_PUBLISHERS.has(source.publisher)) return 'assistant';
  return source.author === 'owner' ? 'chat' : 'message';
}

/** "you told me in chat, Sep 29", "from your email, Mar 3". */
export function describeSource(source: SourceFacts, timeZone: string): string {
  const day = shortDate(new Date(source.event_at), timeZone);
  switch (sourceKind(source)) {
    case 'setup':
      return `you told me during setup, ${day}`;
    case 'chat':
      return `you told me in chat, ${day}`;
    case 'correction':
      return `you corrected this, ${day}`;
    case 'import':
      return `you imported this, ${day}`;
    case 'email':
      return source.author === 'external'
        ? `from an email someone sent you, ${day}`
        : `from your email, ${day}`;
    case 'calendar':
      return `from your calendar, ${day}`;
    case 'contacts':
      return `from your contacts, ${day}`;
    case 'connected':
      return `from an account you connected, ${day}`;
    case 'receipt':
      return `from a receipt, ${day}`;
    case 'message':
      return `from a message someone sent you, ${day}`;
    case 'document':
      return `from a document, ${day}`;
    case 'assistant':
      return `an assistant you connected saved this, ${day}`;
    case 'worked_out':
      return `I worked this out, ${day}`;
  }
}

/** The trust level a person reads, from the revision's weakest source. */
export function beliefTrustOf(origin: OriginTrust | string, kind?: string): BeliefTrust {
  if (kind === 'inferred') return 'worked_out';
  if (origin === 'owner') return 'yours';
  if (origin === 'verified_connector') return 'connected';
  if (origin === 'external_content') return 'outside';
  return 'worked_out';
}
export const TRUST_LABEL: Record<BeliefTrust, string> = {
  yours: 'Your own words',
  connected: 'From an account you connected',
  outside: 'From someone else, not checked',
  worked_out: 'Worked out by me, not confirmed',
};

const GENERIC_HEADS = new Set([
  'fact',
  'facts',
  'user',
  'owner',
  'me',
  'my',
  'self',
  'info',
  'detail',
  'details',
  'general',
  'misc',
  'imported',
  'memory',
]);
const PERSON_HEADS = new Set([
  'person',
  'people',
  'contact',
  'contacts',
  'family',
  'friend',
  'friends',
]);
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** A plain name for what a belief is about, from its registry key or its subject. */
export function subjectLabel(key: string | null, domainKey: string): string {
  if (key) {
    const [kind, subject, field] = key.split('.');
    const name = capitalize((subject ?? '').replaceAll('-', ' '));
    const leaf = (field ?? '').replaceAll('-', ' ');
    if (kind === 'contact') return `${name}'s ${leaf}`;
    if (kind === 'event') return `${name} ${leaf}`;
    if (kind === 'pref') return `${name}: ${leaf}`;
    if (kind === 'constraint') return `${name}: ${leaf}`;
  }
  const parts = (domainKey.split(':exception:')[0] ?? domainKey)
    .split(/[.:]/)
    .map((part) => part.replaceAll(/[_-]+/g, ' ').trim())
    .filter(Boolean);
  if (!parts.length) return 'Something you shared';
  const [head, ...rest] = parts as [string, ...string[]];
  if (PERSON_HEADS.has(head.toLowerCase()) && rest.length >= 2)
    return `${capitalize(rest[0] ?? '')}'s ${rest.slice(1).join(' ')}`.slice(0, 200);
  const meaningful = GENERIC_HEADS.has(head.toLowerCase()) && rest.length ? rest : parts;
  return capitalize(meaningful.join(' ')).slice(0, 200);
}

const CATEGORY_WORDS: [BeliefCategory, RegExp][] = [
  [
    'accounts',
    /\b(accounts?|bills?|billing|subscriptions?|bank|banking|card|credit|debit|payments?|pay|paid|rent|mortgage|insurance|utilit(y|ies)|invoices?|renewals?|fees?|tax|taxes|loan|electricity|internet|broadband|membership|plan price|refund)\b/,
  ],
  [
    'people',
    /\b(person|people|contacts?|family|friends?|partner|wife|husband|spouse|son|daughter|kids?|child|children|mother|mom|mum|father|dad|brother|sister|parents?|grand(ma|pa|mother|father)|boyfriend|girlfriend|birthday|anniversary|neighbou?r)\b/,
  ],
  [
    'work',
    /\b(work|job|employer|company|office|projects?|clients?|team|colleagues?|coworkers?|boss|manager|deadline|role|career|standup|quarterly|okrs?)\b/,
  ],
  [
    'routines',
    /\b(routines?|schedule|habits?|daily|weekly|monthly|every|mornings?|evenings?|nights?|gym|workout|runs?|running|commute|weekdays?|weekends?|appointments?|events?|calendar|bedtime|wake)\b/,
  ],
  [
    'preferences',
    /\b(pref|prefers?|preferences?|likes?|loves?|favou?rites?|dislikes?|hates?|diet|allergic|allerg(y|ies)|vegetarian|vegan|style|tone|language|seat|coffee|tea)\b/,
  ],
];

/** Which group a belief belongs in: people, preferences, accounts and bills, routines, work. */
export function beliefCategoryOf(input: {
  key: string | null;
  domainKey: string;
  kind: string;
  content: string;
  sourceKinds?: readonly BeliefSource['kind'][];
}): BeliefCategory {
  const key = input.key ?? '';
  if (key.startsWith('contact.')) return 'people';
  if (key.startsWith('pref.')) return 'preferences';
  if (key.startsWith('event.')) return 'routines';
  if (key.startsWith('constraint.')) return 'work';
  if (input.sourceKinds?.includes('receipt')) return 'accounts';
  const subject = words(input.domainKey);
  for (const [category, pattern] of CATEGORY_WORDS) if (pattern.test(subject)) return category;
  if (input.kind === 'preference') return 'preferences';
  const content = input.content.toLowerCase();
  for (const [category, pattern] of CATEGORY_WORDS) if (pattern.test(content)) return category;
  return 'other';
}

/** The version a correction must name, shared with the saved-detail routes. */
export const beliefVersion = (id: string, revision: number) =>
  createHash('sha256').update(`${id}:${revision}`).digest('hex');

type SourceRow = SourceFacts & { id: string; job_id: string | null; title: string | null };

/** The sources a revision cites, oldest first, with the conversation each was said in. */
async function revisionSources(tx: MemoryTx, claimId: string, revision: number) {
  const rows = await tx`select s.id, s.publisher, s.stream, s.source_type, s.author, s.event_at,
      s.source_identity, cap.job_id, j.title
    from memory_references r join memory_sources s on s.id = r.source_id
    left join lateral (select c.job_id from memory_capture c where c.source_id = s.id
      order by c.event_seq limit 1) cap on true
    left join job j on j.id = cap.job_id and j.space_id = s.space_id
    where r.claim_id = ${claimId} and r.revision = ${revision}
    order by s.event_at, s.id`;
  return rows.map((row) => ({
    id: String(row.id),
    publisher: String(row.publisher),
    stream: String(row.stream),
    source_type: String(row.source_type),
    author: String(row.author),
    event_at: new Date(String(row.event_at)).toISOString(),
    job_id: row.job_id ? String(row.job_id) : null,
    title: row.title ? String(row.title) : null,
    identity: String(row.source_identity),
  }));
}

/** A receipt source names the action it came from; its conversation is where the receipt shows. */
async function receiptConversation(tx: MemoryTx, spaceId: string, identity: string) {
  const [row] = await tx`select coalesce(j.experience_parent_id, j.id) as conversation, a.kind
    from action a join job j on j.id = a.job_id
    where a.id = ${identity.replace(/^action:/, '')} and j.space_id = ${spaceId}`;
  return row ? String(row.conversation) : null;
}

export async function sourceView(
  tx: MemoryTx,
  spaceId: string,
  sources: (SourceRow & { identity: string })[],
  fallbackAt: string,
  timeZone: string,
): Promise<BeliefSource> {
  const primary = sources[0];
  if (!primary)
    return {
      kind: 'worked_out',
      text: `I worked this out, ${shortDate(new Date(fallbackAt), timeZone)}`,
      at: fallbackAt,
      link: null,
    };
  const kind = sourceKind(primary);
  let link: BeliefSource['link'] = null;
  if (primary.job_id)
    link = {
      kind: 'conversation',
      id: primary.job_id,
      label: primary.title ? `Open “${primary.title.slice(0, 120)}”` : 'Open the conversation',
    };
  else if (kind === 'receipt') {
    const conversation = await receiptConversation(tx, spaceId, primary.identity);
    if (conversation) link = { kind: 'receipt', id: conversation, label: 'Open the receipt' };
  }
  return { kind, text: describeSource(primary, timeZone), at: primary.event_at, link };
}

/** One belief, read under the caller's lock. Null when it is not something to show. */
export async function beliefFromHead(
  tx: MemoryTx,
  scope: MemoryScope,
  head: ClaimHead,
  timeZone: string,
): Promise<Belief | null> {
  if (!['active', 'disputed'].includes(head.current.status) || head.current.content === null)
    return null;
  const sources = await revisionSources(tx, head.id, head.head_revision);
  const [history] = await tx`select min(recorded_at) as learned_at,
      count(*) filter (where revision < ${head.head_revision} and status in ('superseded','active','disputed'))::int as earlier
    from memory_revisions where claim_id = ${head.id}`;
  const [used] = await tx`select max(o.created_at) as last_used from memory_output_uses u
    join memory_outputs o on o.id = u.output_row_id where u.claim_id = ${head.id} and o.space_id = ${scope.spaceId}`;
  const source = await sourceView(tx, scope.spaceId, sources, head.current.recorded_at, timeZone);
  const trust = beliefTrustOf(head.current.origin_trust, head.current.kind);
  return {
    id: head.id,
    label: subjectLabel(head.key, head.domain_key),
    value: head.current.content,
    category: beliefCategoryOf({
      key: head.key,
      domainKey: head.domain_key,
      kind: head.current.kind,
      content: head.current.content,
      sourceKinds: sources.map(sourceKind),
    }),
    source,
    trust,
    trust_label: TRUST_LABEL[trust],
    learned_at: history?.learned_at
      ? new Date(String(history.learned_at)).toISOString()
      : head.current.recorded_at,
    changed_at: head.current.recorded_at,
    last_used: used?.last_used ? new Date(String(used.last_used)).toISOString() : null,
    corrected: source.kind === 'correction',
    disputed: head.current.status === 'disputed',
    earlier: Number(history?.earlier ?? 0),
    version: beliefVersion(head.id, head.head_revision),
  };
}

/** Every belief the person can see, newest change first. */
export async function listBeliefs(sql: MemorySql, scope: MemoryScope, timeZone: string) {
  const heads: ClaimHead[] = [];
  let after: string | null = null;
  // Ten pages is two thousand beliefs, more than any one page should draw.
  for (let page = 0; page < 10; page++) {
    const { claims, next } = await listClaims(sql, scope, { after });
    heads.push(...claims);
    if (!next) break;
    after = next;
  }
  const beliefs = await sql.begin(async (tx) => {
    await lockSpace(tx, scope, false);
    const views: Belief[] = [];
    for (const head of heads) {
      const view = await beliefFromHead(tx, scope, head, timeZone);
      if (view) views.push(view);
    }
    return views;
  });
  return beliefs.sort(
    (a, b) => b.changed_at.localeCompare(a.changed_at) || a.id.localeCompare(b.id),
  );
}

/** Every version a belief has had that the person can still see, newest first. */
export async function beliefHistory(
  sql: MemorySql,
  scope: MemoryScope,
  id: string,
  timeZone: string,
) {
  return sql.begin(async (tx) => {
    await lockSpace(tx, scope, false);
    const head = await getHead(tx, scope, id);
    if (!head) throw new MemoryError('claim_not_found');
    const rows = await tx`select r.revision, r.status, r.recorded_at, b.content
      from memory_revisions r join memory_revision_content b on b.claim_id = r.claim_id and b.revision = r.revision
      where r.claim_id = ${id} and r.status in ('superseded','active','disputed')
      order by r.revision desc limit 100`;
    const versions = [];
    for (const row of rows) {
      if (!(await eligibleRevision(tx, scope, id, Number(row.revision)))) continue;
      const at = new Date(String(row.recorded_at)).toISOString();
      versions.push({
        value: String(row.content),
        at,
        source: await sourceView(
          tx,
          scope.spaceId,
          await revisionSources(tx, id, Number(row.revision)),
          at,
          timeZone,
        ),
        current: Number(row.revision) === head.head_revision,
      });
    }
    return { label: subjectLabel(head.key, head.domain_key), versions };
  });
}

/** Subjects the person asked Melete not to learn again. */
export async function blockedSubjects(sql: MemorySql | MemoryTx, spaceId: string) {
  const rows = await sql`select domain_key, key from memory_blocks
    where space_id = ${spaceId} and removed_at is null`;
  return {
    domains: new Set(rows.map((row) => String(row.domain_key))),
    keys: new Set(rows.flatMap((row) => (row.key ? [String(row.key)] : []))),
  };
}
export const isBlocked = (
  blocked: { domains: Set<string>; keys: Set<string> },
  subject: { domain_key: string; key?: string | null },
) =>
  blocked.domains.has(subject.domain_key) ||
  (typeof subject.key === 'string' && blocked.keys.has(subject.key));

/**
 * Forget a belief and stop learning its subject again. The block is written
 * before the forget, so a message being read at the same moment cannot bring
 * the subject back in between.
 */
export async function blockBelief(
  sql: MemorySql,
  scope: MemoryScope,
  id: string,
  journal: RestrictionJournal,
) {
  const head = await sql.begin(async (tx) => {
    await lockSpace(tx, scope);
    const found = await getHead(tx, scope, id);
    if (!found) throw new MemoryError('claim_not_found');
    const domain = found.domain_key.split(':exception:')[0] ?? found.domain_key;
    await tx`insert into memory_blocks (id, space_id, domain_key, key, label)
      values (${newId('blk')}, ${scope.spaceId}, ${domain}, ${found.key}, ${subjectLabel(found.key, found.domain_key)})
      on conflict (space_id, domain_key) where removed_at is null do nothing`;
    return found;
  });
  await forgetMemory(sql, scope, { claim_id: head.id }, journal);
  return { status: 'ok' as const };
}
export async function listBlocks(sql: MemorySql, scope: MemoryScope) {
  const rows = await sql`select id, label, created_at from memory_blocks
    where space_id = ${scope.spaceId} and removed_at is null order by created_at desc limit 500`;
  return {
    blocks: rows.map((row) => ({
      id: String(row.id),
      label: String(row.label),
      created_at: new Date(String(row.created_at)).toISOString(),
    })),
  };
}
export async function removeBlock(sql: MemorySql, scope: MemoryScope, id: string) {
  const rows = await sql`update memory_blocks set removed_at = clock_timestamp()
    where id = ${id} and space_id = ${scope.spaceId} and removed_at is null returning id`;
  if (!rows.length) throw new MemoryError('block_not_found');
  return { status: 'ok' as const };
}
