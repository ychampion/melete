import {
  type ExtractionProposal,
  extractionChangeSet,
  isMemoryKey,
  type RejectionReason,
  type SourceEvent,
  type SourceRef,
} from '@melete/contracts';
import { blockedSubjects, isBlocked } from './beliefs.ts';
import {
  addReferences,
  type ClaimHead,
  getHead,
  historyInTransaction,
  publishRevision,
  revisionTrustFor,
} from './claims.ts';
import { keyPrecedence, recordContradiction, resolveKeyedHead } from './contradictions.ts';
import {
  bumpRevision,
  enqueue,
  lockSpace,
  MemoryError,
  type MemoryScope,
  type MemorySql,
  type MemoryTx,
  stableEntityId,
  stableId,
} from './db.ts';
import { toSource } from './evidence.ts';
import { detailWords, listKey, sameWording } from './extract.ts';
import { invalidateDependencies, lockEventOrder, notifyInvalidated } from './invalidate.ts';
import {
  GENERIC_HEADS,
  memberSubject,
  olderOwnSubjects,
  PERSON_HEADS,
  relatedSubject,
  SELF,
  sameWhose,
  TOPICS,
  twoPeople,
  whoseDetail,
} from './labels.ts';
import { assertMemoryDomain, eventTime, resolveMeaning, sourceIdentity } from './resolve.ts';
import { memorySeams } from './seams.ts';
import { type Tier1Rejection, validateTier1 } from './validate.ts';
import { checkLease, type ExtractionBatch, finishWork, retryWork } from './work.ts';

type Validated = {
  proposal: ExtractionProposal;
  head: ClaimHead | null;
  sources: SourceEvent[];
  refs: SourceRef[];
};

/**
 * Who said the words a change rests on: in a room, the member who said them;
 * otherwise the person, recorded as no one.
 */
type Author = { id: string | null; part: string };
async function authorOf(tx: MemoryTx, batch: ExtractionBatch): Promise<Author> {
  const [row] =
    await tx`select author_principal_id from memory_sources where id = ${batch.source.source_id}`;
  const id = (row?.author_principal_id as string | null | undefined) ?? null;
  return { id, part: stableId('member', id ?? 'owner').slice(0, 12) };
}

/**
 * The claim held under a subject, and whether everything it rests on was said
 * by this author. One room member's detail is never taken as another's.
 */
async function heldUnder(
  tx: MemoryTx,
  scope: MemoryScope,
  batch: ExtractionBatch,
  author: Author,
  domainKey: string,
): Promise<{ head: ClaimHead; theirs: boolean } | null> {
  const [row] = await tx`select c.id, not exists (select 1 from memory_references said
      join memory_sources who on who.id = said.source_id
      where said.claim_id = c.id and said.revision = c.head_revision
        and who.author_principal_id is distinct from ${author.id}) as theirs
    from memory_claims c where c.space_id = ${scope.spaceId} and c.audience = ${batch.source.audience}
      and c.domain_key = ${domainKey} and not c.hidden`;
  if (!row) return null;
  const head = await getHead(tx, scope, String(row.id));
  if (!head) throw new MemoryError('stale_revision');
  return { head, theirs: Boolean(row.theirs) };
}

/** Whether everything a claim's current wording rests on was said by this author. */
async function saidBy(tx: MemoryTx, head: ClaimHead, author: Author): Promise<boolean> {
  const [other] = await tx`select 1 from memory_references said
    join memory_sources who on who.id = said.source_id
    where said.claim_id = ${head.id} and said.revision = ${head.head_revision}
      and who.author_principal_id is distinct from ${author.id} limit 1`;
  return !other;
}

/**
 * The subject a change is kept under when the claim held where it was
 * proposed is about someone else: another person of the same name ("Brother
 * Sam" where "Friend Sam" is held) or the owner of something ("The owner of
 * my flat lives in Porto", where the person's own city was proposed). Null
 * when it is about the same someone, or memory cannot tell.
 */
function apartFrom(
  held: ClaimHead,
  proposed: { domain_key: string; content: string },
): string | null {
  const content = held.current.content;
  if (!content || held.domain_key.includes(':exception:')) return null;
  const before = whoseDetail(held.domain_key, content);
  const now = whoseDetail(proposed.domain_key, proposed.content);
  if (before.kind === 'other' && now.kind === 'other') {
    if (!twoPeople(before, content, now, proposed.content)) return null;
    const subject = relatedSubject(proposed.domain_key, now, proposed.content);
    return subject && subject !== held.domain_key ? subject : null;
  }
  // The person's own detail, where the owner of something is held.
  if (before.kind === 'other' && before.who === 'owner' && now.kind === 'self') {
    const parts = proposed.domain_key.split('.');
    if (!PERSON_HEADS.has(parts[0] ?? '') || parts.length < 3) return null;
    return ['self', ...parts.slice(2)].join('.');
  }
  return null;
}

/**
 * A claim that already says this new detail in the same words (ignoring case,
 * spacing and a closing full stop), under another subject, about the same
 * someone. The extractor is shown the details most related to a message, not
 * all of them, so a detail it was not shown comes back under a subject of its
 * own: "Can be home Thursday afternoon if that works for the repair" was kept
 * twice. Only plain details are matched; a registry key, a list's item and a
 * temporary exception keep their own rules. A message from an ordinary
 * conversation never lands on a detail learned only in a private one.
 */
async function heldInTheseWords(
  tx: MemoryTx,
  scope: MemoryScope,
  batch: ExtractionBatch,
  author: Author,
  proposal: Extract<ExtractionProposal, { op: 'add' }>,
): Promise<ClaimHead | null> {
  const wording = sameWording(proposal.content);
  if (!wording) return null;
  const fromPrivate = batch.private_origin !== null;
  const rows = await tx`select c.id from memory_claims c
    join memory_revision_content b on b.claim_id = c.id and b.revision = c.head_revision
    where c.space_id = ${scope.spaceId} and c.audience = ${batch.source.audience} and not c.hidden
      and c.key is null and c.domain_key <> ${proposal.domain_key}
      and position(':exception:' in c.domain_key) = 0
      and lower(btrim(regexp_replace(regexp_replace(b.content, '[[:space:]]+', ' ', 'g'),
        '[[:space:].!]+$', ''))) = ${wording}
      and (${fromPrivate} or not exists (select 1 from memory_references ref
        join memory_sources p on p.id = ref.source_id
        where ref.claim_id = c.id and ref.revision = c.head_revision and p.private_origin is not null))
      and not exists (select 1 from memory_references said join memory_sources who
        on who.id = said.source_id where said.claim_id = c.id and said.revision = c.head_revision
          and who.author_principal_id is distinct from ${author.id})
    order by c.id limit 8`;
  const whose = whoseDetail(proposal.domain_key, proposal.content);
  for (const row of rows) {
    const head = await getHead(tx, scope, String(row.id));
    const content = head?.current.content;
    if (!head || !content || listKey(head.domain_key)) continue;
    if (sameWhose(whoseDetail(head.domain_key, content), content, whose, proposal.content))
      return head;
  }
  return null;
}

/** Words in a subject that do not say what it is about: "person.preference.flights.aisle_seat". */
const VAGUE = new Set([
  ...GENERIC_HEADS,
  ...'instruction instructions note notes status profile personal location current'.split(' '),
]);
/** The words of what a subject is about, past its heading: "person.location.city" is city. */
const subjectWords = (domainKey: string) =>
  detailWords(
    domainKey
      .split(/[._-]+/)
      .filter(
        (part, index) =>
          !SELF.has(part) && !VAGUE.has(part) && (index > 0 || !PERSON_HEADS.has(part)),
      )
      .join(' '),
  );

/** A subject an older extraction gave a detail of the person's own: a person heading naming no one. */
const olderOwnSubject = (domainKey: string) =>
  PERSON_HEADS.has(domainKey.split('.')[0] ?? '') && whoseDetail(domainKey).kind !== 'other';

/** Words that say what kind of detail something is ("flights", "health"), as a subject's words are compared. */
const TOPIC_WORDS = detailWords([...TOPICS].join(' '));

/**
 * Whether the person blocked this detail of their own under the subject an
 * older extraction gave it. A block on person.allergy.peanuts still holds
 * when the allergy is proposed as health.allergy: every word of what the
 * blocked subject is about is in the new subject or its sentence. One word
 * saying what kind of detail it was may be missing when at least two others
 * are there: a block on person.preference.flights.aisle_seat holds for
 * "Always book aisle seats" under travel.seat. A shellfish allergy, someone
 * else's peanut allergy, or "Loves peanut butter" is not blocked by it.
 */
function blockedUnderOlderSubject(
  blocked: { domains: Set<string> },
  proposal: { domain_key: string; content: string },
): boolean {
  if (whoseDetail(proposal.domain_key, proposal.content).kind !== 'self') return false;
  const said = new Set([...subjectWords(proposal.domain_key), ...detailWords(proposal.content)]);
  return [...blocked.domains].some((domain) => {
    if (!olderOwnSubject(domain)) return false;
    const words = [...subjectWords(domain)];
    const missing = words.filter((word) => !said.has(word));
    if (!words.length) return false;
    if (!missing.length) return true;
    const [only = ''] = missing;
    return missing.length === 1 && words.length >= 3 && TOPIC_WORDS.has(only);
  });
}

/**
 * Whether a change proposed under a topic is to the person's own detail held
 * under the subject an older extraction gave it: "Lives in Delhi" proposed as
 * home.city for the claim held as person.location.city. Both subjects must be
 * about the same thing (city), and the held one must not name someone else.
 */
function ownDetailRenamed(held: string, proposed: string, heldContent: string | null): boolean {
  if (held.includes(':exception:') || proposed.includes(':exception:')) return false;
  if (!olderOwnSubject(held) || whoseDetail(proposed).kind !== 'self') return false;
  if (whoseDetail(held, heldContent).kind === 'other') return false;
  const before = subjectWords(held);
  return [...subjectWords(proposed)].some((word) => before.has(word));
}

/**
 * The claim that holds the person's own detail under an older subject (see
 * `olderOwnSubjects`), said by this author. A detail about the owner of
 * something, saved under "owner", is not theirs.
 */
async function heldUnderOlderSubject(
  tx: MemoryTx,
  scope: MemoryScope,
  batch: ExtractionBatch,
  author: Author,
  domainKey: string,
): Promise<ClaimHead | null> {
  const older = olderOwnSubjects(domainKey);
  if (!older.length) return null;
  const rows = await tx`select c.id from memory_claims c where c.space_id = ${scope.spaceId}
    and c.audience = ${batch.source.audience} and not c.hidden and c.key is null
    and c.domain_key = any(${older})
    and not exists (select 1 from memory_references said join memory_sources who
      on who.id = said.source_id where said.claim_id = c.id and said.revision = c.head_revision
        and who.author_principal_id is distinct from ${author.id})
    order by c.id limit 8`;
  for (const row of rows) {
    const head = await getHead(tx, scope, String(row.id));
    if (head && whoseDetail(head.domain_key, head.current.content).kind !== 'other') return head;
  }
  return null;
}

async function validateProposal(
  tx: MemoryTx,
  scope: MemoryScope,
  batch: ExtractionBatch,
  author: Author,
  proposal: ExtractionProposal,
): Promise<Validated> {
  /** The proposal as it is published: filed under a held detail it says again. */
  let filed = proposal;
  let head: ClaimHead | null = null;
  /**
   * Keep a new detail under its own subject, apart from the claim held where
   * it was proposed: on this author's claim already held there, or as a new one.
   */
  const keepApart = async (
    change: Extract<ExtractionProposal, { op: 'add' | 'supersede' }>,
    domainKey: string,
  ) => {
    const {
      key: _key,
      claim_id: _claim,
      ...rest
    } = change as typeof change & {
      key?: string;
      claim_id?: string;
    };
    const at = await heldUnder(tx, scope, batch, author, domainKey);
    // A claim held there that rests on someone else's words is not added to.
    if (at && !at.theirs) {
      filed = { op: 'no-op', sources: change.sources };
      head = null;
      return;
    }
    filed = {
      ...rest,
      op: 'add',
      expected_revision: null,
      domain_key: domainKey,
    } as ExtractionProposal;
    head = at?.head ?? null;
  };
  if (proposal.op === 'supersede' || proposal.op === 'retract') {
    head = await getHead(tx, scope, proposal.claim_id);
    if (!head || head.head_revision !== proposal.expected_revision)
      throw new MemoryError('stale_revision');
    if (
      !batch.claims.some((c) => c.id === head?.id && c.head_revision === proposal.expected_revision)
    )
      throw new MemoryError('target_not_in_snapshot');
    if (proposal.op === 'supersede' && head.audience !== batch.source.audience)
      throw new MemoryError('target_mismatch');
    // One room member never changes or takes back another's detail.
    if (!(await saidBy(tx, head, author))) throw new MemoryError('target_mismatch');
    if (proposal.op === 'supersede' && head.domain_key !== proposal.domain_key) {
      if (!ownDetailRenamed(head.domain_key, proposal.domain_key, head.current.content))
        throw new MemoryError('target_mismatch');
      // The person's own detail, changed under the topic it is filed under
      // now: the change lands on the claim, under the subject it is held as.
      filed = { ...proposal, domain_key: head.domain_key };
    } else if (proposal.op === 'supersede') {
      // Brother Sam is not Friend Sam: the change is a detail of his own.
      const apart = apartFrom(head, proposal);
      if (apart) await keepApart(proposal, apart);
    }
    if (proposal.op === 'retract' && head.current.protected)
      throw new MemoryError('protected_correction');
  }
  if (proposal.op === 'add' || proposal.op === 'supersede') {
    assertMemoryDomain(proposal.domain_key);
    if (proposal.valid_until && new Date(proposal.valid_until) < new Date(proposal.valid_from))
      throw new MemoryError('invalid_validity');
    const key = typeof proposal.key === 'string' && isMemoryKey(proposal.key) ? proposal.key : null;
    /** Where this room member's detail is kept apart from another member's under the same subject. */
    const theirs = (domainKey: string) => memberSubject(domainKey, author.part);
    if (proposal.op === 'add') {
      if (key) {
        // A second candidate for an occupied key is a contradiction to resolve,
        // not a collision to refuse. The key's current head is loaded here so the
        // precedence table can decide which of the two holds the active slot.
        const [occupant] =
          await tx`select id from memory_claims where space_id = ${scope.spaceId} and audience = ${batch.source.audience} and key = ${key} and not hidden`;
        if (occupant) head = await getHead(tx, scope, occupant.id as string);
        // Another room member's detail holds the key: this one is kept apart,
        // as this member's own, never weighed against theirs.
        if (head && !(await saidBy(tx, head, author))) await keepApart(proposal, theirs(key));
      } else {
        // Saying something already recorded is the commonest thing a person
        // does. The existing claim is loaded so meaning resolution can attach,
        // ignore or update it, rather than failing the whole change set.
        const own =
          author.id === null
            ? null
            : await heldUnder(tx, scope, batch, author, theirs(proposal.domain_key));
        const existing =
          own?.theirs === true
            ? own
            : await heldUnder(tx, scope, batch, author, proposal.domain_key);
        if (existing?.theirs) {
          head = existing.head;
          if (head.domain_key !== proposal.domain_key)
            filed = { ...proposal, domain_key: head.domain_key };
          // Someone of the same name the person relates differently, or the
          // owner of something, is held there: this is a detail of another one.
          const apart = apartFrom(head, proposal);
          if (apart)
            await keepApart(
              proposal,
              head.domain_key === proposal.domain_key ? apart : theirs(apart),
            );
        } else if (existing) {
          // Another room member's detail holds this subject.
          await keepApart(proposal, theirs(proposal.domain_key));
        } else {
          // The person's own detail, held under the subject an older
          // extraction gave it: said again or changed, it lands on that claim.
          const older = await heldUnderOlderSubject(tx, scope, batch, author, proposal.domain_key);
          if (older) {
            head = older;
            filed = { ...proposal, domain_key: older.domain_key };
          } else if (
            proposal.kind !== 'exception' &&
            proposal.kind !== 'historical' &&
            !listKey(proposal.domain_key)
          ) {
            // Said again in the words of a detail held under another subject:
            // it is more evidence for that detail, on that one claim.
            const said = await heldInTheseWords(tx, scope, batch, author, proposal);
            if (said?.current.content) {
              head = said;
              filed = { ...proposal, domain_key: said.domain_key, content: said.current.content };
            }
          }
        }
      }
    }
  }
  const sources: SourceEvent[] = [];
  const refs: SourceRef[] = [];
  for (const span of proposal.sources) {
    // Only evidence delivered to this invocation may be cited, even if another source is nearby.
    if (
      !memorySeams().acceptForeignCitation &&
      (span.source_id !== batch.source.source_id ||
        span.source_version !== batch.source.source_version ||
        span.start < batch.work.segment_start ||
        span.end > batch.work.segment_end ||
        span.start >= span.end)
    )
      throw new MemoryError('invalid_source_span');
    const [row] =
      await tx`select s.*, b.content from memory_sources s join memory_source_content b on b.source_id = s.id
      where s.id = ${span.source_id} and s.space_id = ${scope.spaceId} and s.state = 'active' and s.source_version = ${span.source_version}`;
    if (!row || (row.content as string).slice(span.start, span.end) !== span.quote)
      throw new MemoryError('invalid_source_span');
    const [suppressed] =
      await tx`select id from memory_suppressions where space_id = ${scope.spaceId} and
      ((source_id = ${span.source_id} and (start is null or (start < ${span.end} and "end" > ${span.start})))
        or (operation = 'clear' and eligibility_cutoff >= ${row.eligibility_generation})) limit 1`;
    if (suppressed) throw new MemoryError('source_suppressed');
    sources.push(toSource(row));
    refs.push({
      source_id: span.source_id,
      source_version: span.source_version,
      start: span.start,
      end: span.end,
    });
  }
  if (proposal.op === 'add' || proposal.op === 'supersede') {
    if (sources.every((s) => s.source_type === 'assistant'))
      throw new MemoryError('unsupported_attribution');
    if (
      ['user_statement', 'preference', 'exception'].includes(proposal.kind) &&
      !sources.some(isOwnWords)
    )
      throw new MemoryError('unsupported_attribution');
    const observed = sources.every(
      (s) => s.source_type === 'observation' || s.source_type === 'receipt',
    );
    // A checked fact is what a connector saw. Tier 0 makes these from a structured
    // observation on a registry key; the older calendar domain keeps its own path.
    if (
      proposal.kind === 'checked_fact' &&
      !(
        observed &&
        (proposal.domain_key.startsWith('calendar.') || isMemoryKey(proposal.domain_key))
      )
    )
      throw new MemoryError('unsupported_checked_fact');
    if (proposal.factual_status === 'checked' && proposal.kind !== 'checked_fact')
      throw new MemoryError('unsupported_checked_fact');
  }
  return { proposal: filed, head, sources, refs };
}
/**
 * Whether a source holds the person's own words, so a statement or preference
 * can be attributed to them: something they said or edited, or a document they
 * added and declared their own. A document somebody else wrote is not.
 */
export function isOwnWords(source: Pick<SourceEvent, 'source_type' | 'author'>): boolean {
  if (source.source_type === 'message' || source.source_type === 'owner_edit') return true;
  return source.source_type === 'document' && source.author === 'owner';
}

/** How a refused change set is recorded at /memory/rejections: a reason and a readable line. */
export function changeSetRejection(code: string): { reason: RejectionReason; detail: string } {
  if (code === 'unsupported_attribution')
    return {
      reason: 'unsupported_attribution',
      detail: 'A statement or preference must rest on something the person said or wrote.',
    };
  return {
    reason: 'change_set_refused',
    detail: `The proposed change could not be kept (${code.slice(0, 120)}).`,
  };
}
export type CommitResult = {
  status: 'committed' | 'duplicate' | 'retry' | 'rejected' | 'review';
  claim_ids: string[];
  reason?: string;
};

/** A rejection is a durable record with a reason, readable at /memory/rejections. */
async function recordRejections(
  sql: MemorySql | MemoryTx,
  scope: MemoryScope,
  batch: ExtractionBatch,
  rejected: readonly Tier1Rejection[],
) {
  for (const item of rejected) {
    const id = `mr_${stableId(scope.spaceId, batch.work.id, item.index, item.reason)}`;
    await sql`insert into memory_rejections (id, space_id, work_id, proposal_index, key, reason, detail)
      values (${id}, ${scope.spaceId}, ${batch.work.id}, ${item.index}, ${item.key}, ${item.reason}, ${item.detail})
      on conflict do nothing`;
  }
}
type KeyedPublication = {
  proposal: Extract<ExtractionProposal, { op: 'add' | 'supersede' }>;
  key: string;
  head: ClaimHead | null;
  refs: SourceRef[];
  sources: SourceEvent[];
  headEventAt: string;
};

/**
 * E2. Publish one keyed proposal. The precedence table decides which candidate
 * holds the single active slot; when neither wins, both revisions are committed,
 * the key enters `contradictions`, and one owner question is queued.
 */
async function publishKeyed(
  tx: MemoryTx,
  scope: MemoryScope,
  batch: ExtractionBatch,
  input: KeyedPublication,
): Promise<string | null> {
  const { proposal, key, head, refs, sources } = input;
  const audience = batch.source.audience;
  const draft = {
    content: proposal.content,
    kind: proposal.kind,
    factual_status: proposal.factual_status,
    protected: false,
    valid_from: proposal.valid_from,
    valid_until: proposal.valid_until,
    sources: refs,
    key,
    confidence: proposal.confidence ?? null,
  };
  const identity = stableEntityId('k', batch.work.id, key);
  // A belief a rewind set aside holds no value to weigh against: saying it
  // again learns it again, on the same claim.
  if (head && head.current.status === 'retracted') {
    const revision = await publishRevision(tx, { ...scope, audience }, key, head, draft, 'active');
    await invalidateDependencies(tx, scope, [head.id], revision.data_revision);
    return head.id;
  }
  if (!head) {
    const revision = await publishRevision(
      tx,
      { ...scope, audience },
      key,
      null,
      draft,
      'active',
      identity,
    );
    return revision.claim_id;
  }
  const proposalTrust = await revisionTrustFor(tx, proposal.kind, refs);
  const table = resolveKeyedHead(
    {
      precedence: keyPrecedence({
        origin_trust: proposalTrust,
        protected: false,
        kind: proposal.kind,
      }),
      event_at: eventTime(sources),
      content: proposal.content,
      explicit_supersede: proposal.op === 'supersede',
    },
    {
      precedence: keyPrecedence({
        origin_trust: head.current.origin_trust,
        protected: head.current.protected,
        kind: head.current.kind,
      }),
      event_at: input.headEventAt,
      content: head.current.content ?? '',
    },
  );
  const decision = memorySeams().keyedHeadDecision?.(table) ?? table;
  if (decision.decision === 'no-op') return null;
  if (decision.decision === 'historical') {
    await publishRevision(tx, { ...scope, audience }, key, head, draft, 'historical');
    return head.id;
  }
  if (decision.decision === 'publish') {
    const revision = await publishRevision(tx, { ...scope, audience }, key, head, draft, 'active');
    await invalidateDependencies(tx, scope, [head.id], revision.data_revision);
    return head.id;
  }
  if (decision.decision === 'dispute') {
    // The newer statement takes the slot and is marked disputed; the previous one
    // stays in history as the alternative the question is about.
    const revision = await publishRevision(
      tx,
      { ...scope, audience },
      key,
      head,
      { ...draft, factual_status: 'disputed' },
      'disputed',
    );
    await recordContradiction(tx, scope, {
      key,
      audience,
      claimId: head.id,
      head: {
        revision: revision.revision,
        content: proposal.content,
        event_at: eventTime(sources),
      },
      alternative: {
        revision: head.head_revision,
        content: head.current.content ?? '',
        event_at: input.headEventAt,
      },
    });
    await invalidateDependencies(tx, scope, [head.id], revision.data_revision);
    return head.id;
  }
  // Equal event time: import order is not an authority, so the slot does not move.
  const revision = await publishRevision(
    tx,
    { ...scope, audience },
    key,
    head,
    draft,
    'historical',
  );
  await tx`update memory_revisions set status = 'disputed', factual_status = 'disputed'
    where claim_id = ${head.id} and revision = ${head.head_revision} and status = 'active'`;
  await recordContradiction(tx, scope, {
    key,
    audience,
    claimId: head.id,
    head: {
      revision: head.head_revision,
      content: head.current.content ?? '',
      event_at: input.headEventAt,
    },
    alternative: {
      revision: revision.revision,
      content: proposal.content,
      event_at: eventTime(sources),
    },
  });
  return head.id;
}

/** Internal failure-schedule seam; no request, model, or queue payload can install a hook. */
export type PublicationHooks = {
  beforeLock?: () => Promise<void>;
  beforePublication?: () => Promise<void>;
};
/** Validate every operation before publishing any revision, edge, cursor or invalidation. */
export async function commitExtraction(
  sql: MemorySql,
  scope: MemoryScope,
  batch: ExtractionBatch,
  raw: unknown,
  reviewed = false,
  hooks: PublicationHooks = {},
): Promise<CommitResult> {
  // Which proposal a refusal of the whole set came from, when one did.
  let failedIndex = 0;
  let failedKey: string | null = null;
  try {
    const parsed = extractionChangeSet.parse(raw);
    // E3. Structural validation runs before anything is published and before the
    // whole-set rules below: a proposal whose span is not verbatim, whose key is
    // not in the registry, or whose value Tier 0 cannot find in the evidence it
    // cited is rejected here with a reason. It is never attached to a nearby
    // message. Proposals with no key are untouched and keep their existing path.
    const { accepted, rejected } = validateTier1(parsed.proposals, {
      source: batch.source,
      text: batch.text,
      segmentStart: batch.work.segment_start,
      segmentEnd: batch.work.segment_end,
      timeZone: batch.time_zone ?? undefined,
    });
    if (rejected.length) await recordRejections(sql, scope, batch, rejected);
    await hooks.beforeLock?.();
    const result = await sql.begin(async (tx) => {
      await lockEventOrder(tx);
      const space = await lockSpace(tx, scope);
      // A subject the person asked not to be learned again is refused here, with
      // its reason recorded, whichever extractor proposed it. The blocks are read
      // under the space lock a block is written under, so one written a moment
      // ago is seen.
      const blocked = await blockedSubjects(tx, scope.spaceId);
      const proposals: ExtractionProposal[] = [];
      const refused: Tier1Rejection[] = [];
      for (const [index, proposal] of accepted.entries()) {
        if (
          (proposal.op === 'add' || proposal.op === 'supersede') &&
          // A subject blocked under the name an earlier extraction gave it stays blocked.
          ([
            proposal,
            ...olderOwnSubjects(proposal.domain_key).map((domain_key) => ({ domain_key })),
          ].some((subject) => isBlocked(blocked, subject)) ||
            blockedUnderOlderSubject(blocked, proposal))
        )
          refused.push({
            index,
            key: typeof proposal.key === 'string' ? proposal.key : null,
            reason: 'blocked_by_person',
            detail: 'The person asked not to learn this again.',
          });
        else proposals.push(proposal);
      }
      if (refused.length) await recordRejections(tx, scope, batch, refused);
      const [prior] =
        await tx`select status, fence from memory_work where id = ${batch.work.id} and space_id = ${scope.spaceId}`;
      if (prior?.status === 'done') return { status: 'duplicate', claim_ids: [] } as CommitResult;
      const work = await checkLease(tx, scope, batch);
      if (
        space.policy_generation !== batch.snapshot.policy_generation ||
        space.access_generation !== batch.snapshot.access_generation
      )
        throw new MemoryError('stale_policy');
      if (
        work.segment_start !== batch.work.segment_start ||
        work.segment_end !== batch.work.segment_end
      )
        throw new MemoryError('invalid_batch');
      const [source] =
        await tx`select state from memory_sources where id = ${batch.source.source_id}`;
      if (source?.state !== 'active') throw new MemoryError('source_suppressed');
      const author = await authorOf(tx, batch);
      const validated: Validated[] = [];
      const targets = new Set<string>();
      /** Details said again in a held detail's words, filed under it (see `heldInTheseWords`). */
      const restated: number[] = [];
      for (const proposal of proposals) {
        failedIndex = Math.max(0, parsed.proposals.indexOf(proposal));
        failedKey = 'key' in proposal && typeof proposal.key === 'string' ? proposal.key : null;
        const item = await validateProposal(tx, scope, batch, author, proposal);
        if (item.proposal !== proposal && item.proposal.op === 'add')
          restated.push(validated.length);
        else if (proposal.op !== 'no-op') {
          const target =
            proposal.op === 'add' ? `key:${proposal.domain_key}` : `id:${proposal.claim_id}`;
          if (targets.has(target)) throw new MemoryError('conflicting_changeset');
          targets.add(target);
        }
        validated.push(item);
      }
      // A detail said again beside a change to that same detail, or twice in
      // one message, adds nothing; it never refuses the rest of the message.
      for (const index of restated) {
        const item = validated[index];
        if (item?.proposal.op !== 'add') continue;
        const touched = [
          `key:${item.proposal.domain_key}`,
          ...(item.head ? [`id:${item.head.id}`] : []),
        ];
        if (touched.some((target) => targets.has(target)))
          validated[index] = { ...item, proposal: { op: 'no-op', sources: item.proposal.sources } };
        else for (const target of touched) targets.add(target);
      }
      failedIndex = 0;
      failedKey = null;
      if (space.require_review && !reviewed && validated.some((v) => v.proposal.op !== 'no-op')) {
        await tx`insert into memory_proposals (id, space_id, work_id, fence, payload) values (${batch.work.id}, ${scope.spaceId}, ${batch.work.id}, ${batch.work.fence}, ${JSON.stringify({ batch, proposals })}::text::jsonb)
          on conflict (id) do update set fence = excluded.fence, payload = excluded.payload, status = 'pending'`;
        await tx`update memory_work set status = 'review', lease_until = null where id = ${batch.work.id}`;
        await enqueue(tx, scope.spaceId, 'proposal', batch.work.id);
        return { status: 'review', claim_ids: [] } as CommitResult;
      }
      const claimIds: string[] = [];
      await hooks.beforePublication?.();
      for (const { proposal, head, sources, refs } of validated) {
        if (proposal.op === 'no-op') continue;
        if (proposal.op === 'retract') {
          if (!head) throw new MemoryError('claim_not_found');
          const dataRevision = await bumpRevision(tx, scope.spaceId);
          await tx`update memory_claims set hidden = true where id = ${head.id}`;
          await tx`update memory_revisions set status = 'retracted', superseded_at = clock_timestamp() where claim_id = ${head.id} and revision = ${head.head_revision}`;
          await enqueue(tx, scope.spaceId, 'invalidate', `${head.id}:${dataRevision}`);
          await enqueue(tx, scope.spaceId, 'index', String(dataRevision));
          await enqueue(tx, scope.spaceId, 'markdown', String(dataRevision));
          await invalidateDependencies(tx, scope, [head.id], dataRevision);
          claimIds.push(head.id);
          continue;
        }
        const sourceRows = head
          ? await tx`select distinct s.* from memory_references ref join memory_sources s on s.id = ref.source_id where ref.claim_id = ${head.id} and ref.revision = ${head.head_revision}`
          : [];
        const key =
          typeof proposal.key === 'string' && isMemoryKey(proposal.key) ? proposal.key : null;
        if (key) {
          const published = await publishKeyed(tx, scope, batch, {
            proposal,
            key,
            head,
            refs,
            sources,
            headEventAt: eventTime(sourceRows.map(toSource)),
          });
          if (published) claimIds.push(published);
          continue;
        }
        const history = head ? await historyInTransaction(tx, scope, head.id) : null;
        const existing =
          head && history
            ? {
                current: head.current,
                eventAt: eventTime(sourceRows.map(toSource)),
                sourceIdentities: sourceRows.map((r) => sourceIdentity(toSource(r))),
                history: history.revisions,
              }
            : undefined;
        // A belief a rewind set aside is learned again as new, on the same claim.
        const resolution =
          head?.current.status === 'retracted'
            ? ({ decision: 'publish', reason: 'set_aside_by_rewind' } as ReturnType<
                typeof resolveMeaning
              >)
            : resolveMeaning(proposal, sources, existing);
        if (resolution.decision === 'no-op') continue;
        if (resolution.decision === 'attach' && head && resolution.revision) {
          await addReferences(tx, scope.spaceId, head.id, resolution.revision, refs);
          const dataRevision = await bumpRevision(tx, scope.spaceId);
          await tx`update memory_revisions set data_revision = ${dataRevision} where claim_id = ${head.id} and revision = ${resolution.revision}`;
          await enqueue(tx, scope.spaceId, 'index', String(dataRevision));
          claimIds.push(head.id);
          continue;
        }
        const exception = resolution.decision === 'exception';
        const domain = exception
          ? `${proposal.domain_key}:exception:${proposal.valid_from}:${proposal.valid_until}`
          : proposal.domain_key;
        const draft = {
          content: proposal.content,
          kind: proposal.kind,
          factual_status: proposal.factual_status,
          protected: false,
          valid_from: proposal.valid_from,
          valid_until: proposal.valid_until,
          sources: refs,
        };
        if (resolution.decision === 'dispute' && head) {
          // Both alternatives remain explicit; only the selected head occupies the active slot.
          await publishRevision(
            tx,
            { ...scope, audience: head.audience },
            domain,
            head,
            { ...head.current, factual_status: 'disputed' },
            'disputed',
          );
          draft.factual_status = 'disputed';
        }
        const historical =
          resolution.decision === 'historical' || resolution.decision === 'dispute';
        const revision = await publishRevision(
          tx,
          { ...scope, audience: batch.source.audience },
          domain,
          exception ? null : head,
          draft,
          historical ? 'historical' : 'active',
          stableEntityId('k', batch.work.id, domain),
        );
        claimIds.push(revision.claim_id);
        if (head && !historical && !exception)
          await invalidateDependencies(tx, scope, [head.id], revision.data_revision);
      }
      await finishWork(tx, batch);
      return { status: 'committed', claim_ids: [...new Set(claimIds)] } as CommitResult;
    });
    await notifyInvalidated(sql, scope.spaceId);
    return result;
  } catch (error) {
    const code =
      error instanceof MemoryError
        ? error.code
        : error instanceof Error && error.message === 'not_memory_authority'
          ? error.message
          : 'invalid_proposal';
    if (['stale_revision', 'stale_policy', 'stale_lease'].includes(code)) {
      await retryWork(sql, scope, batch, code);
      return { status: 'retry', claim_ids: [], reason: code };
    }
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      await retryWork(sql, scope, batch, 'stale_revision');
      return { status: 'retry', claim_ids: [], reason: 'stale_revision' };
    }
    // Rejections contain operational codes only, never source or forgotten plaintext.
    await sql.begin(async (tx) => {
      await lockSpace(tx, scope);
      const [work] =
        await tx`select status, fence from memory_work where id = ${batch.work.id} and space_id = ${scope.spaceId}`;
      if (work?.status === 'leased' && work.fence === batch.work.fence) {
        await finishWork(tx, batch, 'rejected', code);
        // The whole set was refused: the person can read why at /memory/rejections.
        const { reason, detail } = changeSetRejection(code);
        await recordRejections(tx, scope, batch, [
          { index: failedIndex, key: failedKey, reason, detail },
        ]);
      }
    });
    return { status: 'rejected', claim_ids: [], reason: code };
  }
}
