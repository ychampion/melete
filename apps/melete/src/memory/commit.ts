import {
  type ExtractionProposal,
  extractionChangeSet,
  isMemoryKey,
  type RejectionReason,
  type SourceEvent,
  type SourceRef,
} from '@melete/contracts';
import { blockedSubjects } from './beliefs.ts';
import { blockedDetail } from './blocks.ts';
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
import {
  aboutSubject,
  detailWords,
  listKey,
  ownSubject,
  sameDetail,
  sameWayRound,
  sameWording,
  saysNoMore,
} from './extract.ts';
import { invalidateDependencies, lockEventOrder, notifyInvalidated } from './invalidate.ts';
import {
  aboutThem,
  GENERIC_HEADS,
  memberSubject,
  nameOf,
  namesIn,
  olderOwnSubject,
  olderOwnSubjects,
  ownDetailNow,
  PERSON_HEADS,
  relatedSubject,
  relationsIn,
  relativeOf,
  relativeSubject,
  SELF,
  sameOwnDetail,
  sameWhose,
  saysRelation,
  subjectRelative,
  themselfSubject,
  twoPeople,
  type Whose,
  whoseDetail,
  withoutMember,
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
 * Sam" where "Friend Sam" is held), a relative of theirs ("Sam's brother"
 * where Brother Sam is held, see `relativeApart`) or the owner of something
 * ("The owner of my flat lives in Porto", where the person's own city was
 * proposed). Null when it is about the same someone, or memory cannot tell.
 * How the person relates someone is read from the claim's latest words that
 * say it, so a change that left the relation out ("Brother Sam lives in
 * Madrid", then "Sam lives in Porto") still holds the brother; and for the
 * change, from its own words, or the person's words it cites when its own
 * leave the relation out ("Sam lives in Faro", citing "My friend Sam just
 * moved to Faro"). A change is proposed under the held subject, so a relation
 * that subject names ("person.brother.sam.city") is the held one's, not the
 * change's.
 */
async function apartFrom(
  tx: MemoryTx,
  held: ClaimHead,
  proposed: { domain_key: string; content: string; sources?: readonly { quote: string }[] },
): Promise<string | null> {
  const content = held.current.content;
  if (!content || held.domain_key.includes(':exception:')) return null;
  const before = whoseDetail(held.domain_key, content);
  const whose = whoseDetail(proposed.domain_key, proposed.content);
  if (before.kind === 'other' && whose.kind === 'other') {
    const relative = await relativeApart(tx, held, nameOf(before), proposed);
    if (relative) return relative.apart;
    // Who the change is about, by name, without the relation its subject names.
    const now: Whose = whose.name ? { kind: 'other', who: whose.who, name: whose.name } : whose;
    const related = saysRelation(before, content)
      ? content
      : ((await earlierWords(tx, held)).find((words) => saysRelation(before, words)) ?? content);
    const relating = saysRelation(now, proposed.content)
      ? proposed.content
      : (relatedInQuotes(now, proposed.sources ?? []) ?? proposed.content);
    if (!twoPeople(before, related, now, relating)) return null;
    const subject = relatedSubject(proposed.domain_key, now, relating);
    return subject && subject !== held.domain_key ? subject : null;
  }
  // The person's own detail, where the owner of something is held.
  if (before.kind === 'other' && before.who === 'owner' && whose.kind === 'self') {
    const parts = proposed.domain_key.split('.');
    if (!PERSON_HEADS.has(parts[0] ?? '') || parts.length < 3) return null;
    return ['self', ...parts.slice(2)].join('.');
  }
  return null;
}

/**
 * How the person's words a change cites relate the someone it is about, read
 * only beside their name (see `relationsIn`), as "friend sam": "My friend Sam
 * just moved to Faro" says a friend; "My friend told me Sam moved to Faro" and
 * "My sister says Sam lives in Faro" say nothing of who Sam is.
 */
function relatedInQuotes(whose: Whose, sources: readonly { quote: string }[]): string | null {
  if (whose.kind !== 'other') return null;
  const name = whose.name ?? whose.who;
  for (const { quote } of sources) {
    const [found] = relationsIn(quote, name, true);
    if (found) return `${found} ${name}`;
  }
  return null;
}

/**
 * The subject a change is kept under when it is about a relative of the
 * someone held, not them: "Sam's brother lives in Faro" proposed as a change
 * to Brother Sam. The relative is read from the change's words, or from the
 * person's words it cites when its own took the relative's relation for the
 * person's: "Brother Sam lives in Faro", citing "My friend Sam's brother
 * moved to Faro". The other way round, the held detail is a relative's
 * ("Sam's brother lives in Faro" under "person.sam.brother.city") and the
 * change is about the someone themself ("My brother Sam moved to Lagos"): it
 * is kept as theirs. Null when relatives do not decide it; `apart` is null
 * when the change is about the relative the held detail is about.
 */
async function relativeApart(
  tx: MemoryTx,
  held: ClaimHead,
  name: string | null,
  proposed: { domain_key: string; content: string; sources?: readonly { quote: string }[] },
): Promise<{ apart: string | null } | null> {
  if (!name) return null;
  const quotes = (proposed.sources ?? []).map(({ quote }) => quote);
  const words = [held.current.content ?? '', ...(await earlierWords(tx, held))];
  // The held detail is a relative's, by its subject and its own words.
  const heldRelative = subjectRelative(held.domain_key, name);
  if (heldRelative && words.some((text) => relativeOf(text, name) === heldRelative)) {
    const texts = [proposed.content, ...quotes];
    if (texts.some((text) => relativeOf(text, name) === heldRelative)) {
      // The same relative, unless the person's words say whose relative it is
      // and that someone is not the one held: "My cousin Sam's brother".
      const [knows] = quotes.flatMap((quote) => [...relationsIn(quote, name, true)]);
      const content = held.current.content ?? '';
      const them: Whose = { kind: 'other', who: name, name };
      if (
        !knows ||
        !twoPeople(whoseDetail(held.domain_key, content), content, them, `${knows} ${name}`)
      )
        return { apart: null };
      return { apart: relativeSubject(held.domain_key, name, heldRelative, knows) };
    }
    if (relativeOf(proposed.content, name) === null && texts.some((text) => namesIn(text, name))) {
      const [related] = [
        ...relationsIn(proposed.content, name),
        ...quotes.flatMap((quote) => [...relationsIn(quote, name, true)]),
      ];
      const subject = themselfSubject(held.domain_key, name, related);
      return { apart: subject !== withoutMember(held.domain_key) ? subject : null };
    }
  }
  const said = relationsIn(proposed.content, name);
  const relative =
    relativeOf(proposed.content, name) ??
    quotes
      .map((quote) => relativeOf(quote, name))
      .find(
        (found, index) =>
          found !== null &&
          said.has(found) &&
          !relationsIn(quotes[index] ?? '', name, true).has(found),
      ) ??
    null;
  if (!relative || heldRelative === relative) return null;
  if (words.some((text) => relativeOf(text, name) === relative)) return null;
  // How the person knows the someone whose relative this is, as their own words say it.
  const related = [...quotes.flatMap((quote) => [...relationsIn(quote, name, true)]), ...said].find(
    (found) => found !== relative,
  );
  const subject = relativeSubject(proposed.domain_key, name, relative, related);
  return subject !== withoutMember(held.domain_key) ? { apart: subject } : null;
}

/** A claim's earlier wordings, latest first. Forgotten ones are gone and never read. */
async function earlierWords(tx: MemoryTx, held: ClaimHead): Promise<string[]> {
  const rows = await tx`select b.content from memory_revisions r
    join memory_revision_content b on b.claim_id = r.claim_id and b.revision = r.revision
    where r.claim_id = ${held.id} and r.revision < ${held.head_revision}
    order by r.revision desc limit 16`;
  return rows.map((row) => String(row.content ?? '')).filter(Boolean);
}

/**
 * The person's own detail, proposed as a change to a detail about the owner
 * of something: "I moved to Braga" as a change to "The owner of my flat lives
 * in Porto". It is kept as the person's own, and the owner's detail as it was.
 */
function ownBesideOwnerOf(held: ClaimHead, proposed: { domain_key: string; content: string }) {
  if (held.domain_key.includes(':exception:') || proposed.domain_key.includes(':exception:'))
    return false;
  const before = whoseDetail(held.domain_key, held.current.content);
  return (
    before.kind === 'other' &&
    before.who === 'owner' &&
    whoseDetail(proposed.domain_key, proposed.content).kind === 'self'
  );
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
 * `olderOwnSubjects`) or another name for it (see `sameOwnDetail`), said by
 * this author. A detail about the owner of something, saved under "owner",
 * is not theirs. Only a detail of how things are now is held under another
 * name: a city the person used to live in, or someone's city filed as
 * home.city, never lands on the city they live in.
 */
async function heldUnderOlderSubject(
  tx: MemoryTx,
  scope: MemoryScope,
  batch: ExtractionBatch,
  author: Author,
  proposal: Extract<ExtractionProposal, { op: 'add' }>,
): Promise<ClaimHead | null> {
  const domainKey = proposal.domain_key;
  const names = ownDetailNow(proposal) ? sameOwnDetail(domainKey) : [];
  const older = [
    ...olderOwnSubjects(domainKey),
    ...names.flatMap((name) => [name, memberSubject(name, author.part), ...olderOwnSubjects(name)]),
  ];
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

/**
 * The person's own detail filed under them alone (see `aboutSubject`), or as
 * "self" by an older extraction, that this new one says again in other
 * words: "Owns two cats" for "Has two cats". It names no topic to be found
 * by, and the extractor is not always shown it. Said by this author only; a
 * message from an ordinary conversation never lands on a detail learned only
 * in a private one.
 */
async function heldAboutThem(
  tx: MemoryTx,
  scope: MemoryScope,
  batch: ExtractionBatch,
  author: Author,
  proposal: Extract<ExtractionProposal, { op: 'add' }>,
): Promise<ClaimHead | null> {
  if (
    !aboutThem(proposal.domain_key) ||
    proposal.kind === 'exception' ||
    proposal.kind === 'historical'
  )
    return null;
  const fromPrivate = batch.private_origin !== null;
  const rows = await tx`select c.id, c.domain_key, b.content from memory_claims c
    join memory_revision_content b on b.claim_id = c.id and b.revision = c.head_revision
    where c.space_id = ${scope.spaceId} and c.audience = ${batch.source.audience} and not c.hidden
      and c.key is null and c.domain_key <> ${proposal.domain_key}
      and (c.domain_key in ('self', 'self.about') or c.domain_key like 'self.about.%'
        or c.domain_key like 'self.member%')
      and position(':exception:' in c.domain_key) = 0
      and (${fromPrivate} or not exists (select 1 from memory_references ref
        join memory_sources p on p.id = ref.source_id
        where ref.claim_id = c.id and ref.revision = c.head_revision and p.private_origin is not null))
      and not exists (select 1 from memory_references said join memory_sources who
        on who.id = said.source_id where said.claim_id = c.id and said.revision = c.head_revision
          and who.author_principal_id is distinct from ${author.id})
    order by c.id limit 500`;
  const subject = aboutSubject(proposal.content);
  for (const row of rows) {
    const content = String(row.content ?? '');
    if (!content || !aboutThem(String(row.domain_key))) continue;
    if (
      aboutSubject(content) !== subject &&
      !(sameDetail(content, proposal.content) && sameWayRound(content, proposal.content))
    )
      continue;
    const head = await getHead(tx, scope, String(row.id));
    if (head?.current.content) return head;
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
    subject: string,
  ) => {
    const {
      key: _key,
      claim_id: _claim,
      ...rest
    } = change as typeof change & {
      key?: string;
      claim_id?: string;
    };
    let domainKey = subject;
    let at = await heldUnder(tx, scope, batch, author, domainKey);
    // Another room member's detail holds that subject too ("Brother Sam" of
    // theirs): this member's is kept under their own, not dropped.
    if (at && !at.theirs && memberSubject(subject, author.part) !== subject) {
      domainKey = memberSubject(subject, author.part);
      at = await heldUnder(tx, scope, batch, author, domainKey);
    }
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
      if (ownBesideOwnerOf(head, proposal)) {
        const { claim_id: _claim, expected_revision: _revision, ...change } = proposal;
        return validateProposal(tx, scope, batch, author, {
          ...change,
          op: 'add',
          expected_revision: null,
          domain_key: ownSubject(proposal.domain_key, 'the_person', proposal.content),
        });
      }
      // This author's own detail (see `saidBy`), proposed without the part
      // that keeps it apart from another room member's, or the person's own
      // detail changed under the topic it is filed under now or under another
      // name for it (home.city for self.city): the change lands on the claim,
      // under the subject it is held as.
      if (
        withoutMember(head.domain_key) !== withoutMember(proposal.domain_key) &&
        !sameOwnDetail(withoutMember(head.domain_key)).includes(
          withoutMember(proposal.domain_key),
        ) &&
        !ownDetailRenamed(head.domain_key, proposal.domain_key, head.current.content)
      )
        throw new MemoryError('target_mismatch');
      filed = { ...proposal, domain_key: head.domain_key };
    }
    if (proposal.op === 'supersede') {
      // Brother Sam is not Friend Sam, under whichever subject the change was
      // proposed: the change is a detail of his own.
      const apart = await apartFrom(tx, head, proposal);
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
          const apart = await apartFrom(tx, head, proposal);
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
          const older = await heldUnderOlderSubject(tx, scope, batch, author, proposal);
          const again = older ? null : await heldAboutThem(tx, scope, batch, author, proposal);
          if (older) {
            head = older;
            filed = { ...proposal, domain_key: older.domain_key };
          } else if (again?.current.content) {
            // The person's own detail about them alone, said again in other
            // words: it lands on that claim. Said with less ("Speaks English"
            // after "Speaks Portuguese and English"), it is more evidence for
            // the held wording.
            head = again;
            filed = {
              ...proposal,
              domain_key: again.domain_key,
              content: saysNoMore(proposal.content, again.current.content)
                ? again.current.content
                : proposal.content,
            };
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

/**
 * Refusals of one change that say nothing about the rest of its message: it
 * is aimed at a detail it may not change, or at one it was not shown, or its
 * dates end before they start. That change is refused with its reason, and
 * the message's other details are kept. A refusal that says the reading of
 * the message cannot be trusted (words cited that the message does not hold,
 * a statement resting on words that are not the person's, a check claimed,
 * a change outside memory's domain, or words the person asked memory to
 * forget) still refuses the whole message; a stale snapshot is retried as a
 * whole; and two changes to one detail are refused together.
 */
const REFUSED_ALONE = new Set([
  'target_mismatch',
  'target_not_in_snapshot',
  'protected_correction',
  'invalid_validity',
]);

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
      // In a room, a member's block holds for what that member says.
      const speaker = await authorOf(tx, batch);
      const proposals: ExtractionProposal[] = [];
      const refused: Tier1Rejection[] = [];
      for (const [index, proposal] of accepted.entries()) {
        if (
          (proposal.op === 'add' || proposal.op === 'supersede') &&
          blockedDetail(blocked, proposal, speaker.id ? speaker.part : null)
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
      /** Changes refused on their own (see `REFUSED_ALONE`), and the first one's error. */
      const refusedAlone: Tier1Rejection[] = [];
      /** The changes left once those are refused: what review puts to the person. */
      const reviewable: ExtractionProposal[] = [];
      let firstRefusal: { error: MemoryError; index: number; key: string | null } | null = null;
      /** Whether anything but a no-op is kept from this message. */
      let keeps = false;
      for (const proposal of proposals) {
        failedIndex = Math.max(0, parsed.proposals.indexOf(proposal));
        failedKey = 'key' in proposal && typeof proposal.key === 'string' ? proposal.key : null;
        let item: Validated;
        try {
          item = await validateProposal(tx, scope, batch, author, proposal);
        } catch (error) {
          if (!(error instanceof MemoryError) || !REFUSED_ALONE.has(error.code)) throw error;
          firstRefusal ??= { error, index: failedIndex, key: failedKey };
          refusedAlone.push({
            index: failedIndex,
            key: failedKey,
            ...changeSetRejection(error.code),
          });
          continue;
        }
        reviewable.push(proposal);
        if (proposal.op !== 'no-op') keeps = true;
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
      if (firstRefusal) {
        // Nothing else to keep: the message is refused as a whole, as before,
        // so its reason stays on the message.
        if (!keeps) {
          failedIndex = firstRefusal.index;
          failedKey = firstRefusal.key;
          throw firstRefusal.error;
        }
        await recordRejections(tx, scope, batch, refusedAlone);
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
        await tx`insert into memory_proposals (id, space_id, work_id, fence, payload) values (${batch.work.id}, ${scope.spaceId}, ${batch.work.id}, ${batch.work.fence}, ${JSON.stringify({ batch, proposals: reviewable })}::text::jsonb)
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
