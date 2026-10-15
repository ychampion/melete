/**
 * "Don't learn this again", held to the detail the person forgot rather than
 * to the subject a model happened to file it under. Models file one detail
 * under different subjects from one message to the next ("Prefers aisle
 * seats" as preference.flights.seat, then as travel.seat; "the peanut
 * allergy" inside an instruction for restaurants), and different details
 * under one subject ("Allergic to peanuts" and "Allergic to shellfish" both
 * as health.allergy).
 *
 * So a block keeps, beside its subject, a keyed tag for each word of what was
 * forgotten. It never keeps the words: that would undo the forget. The tags
 * are made with this install's key and the space, so without the key they
 * say nothing, and the same word reads differently in every space. A block
 * made without a key, or before blocks kept tags, holds for its subject and
 * for the same subject filed under an older or variant heading.
 *
 * The person chooses how far a block reaches. By default it holds for
 * anything about the subject, the narrower subjects under it included, and
 * also for the forgotten detail filed under any other subject of theirs. Or it holds for
 * just that detail, so a different detail under the same subject ("Lives in
 * Porto" after "Lives in Lisbon") can still be learned.
 */
import { createHmac, hkdfSync } from 'node:crypto';
import { detailWords } from './extract.ts';
import {
  GENERIC_HEADS,
  memberSubject,
  olderOwnSubject,
  olderOwnSubjects,
  ownTopicRun,
  PERSON_HEADS,
  RELATIONS,
  SELF,
  TOPICS,
  whoseDetail,
  withoutMember,
} from './labels.ts';

/** Where a block's tags start in its stored subject: "health.allergy:detail:…". */
const DETAIL = ':detail:';
/**
 * Before a block's tag check, it says the block holds for its whole subject
 * too: "health.allergy:detail:all<check>.<tag>…". A reader that does not know
 * it sees a check that never matches, and so holds the block for its subject.
 */
const WHOLE = 'all';
/** How far a block reaches: anything about its subject, or just the detail forgotten. */
export type BlockScope = 'topic' | 'detail';
const MEMBER = /\.member_([0-9a-f]{12})(?=$|[.:])/;
/**
 * A letter of a script whose words are not compared here: they have no
 * stems, and some have no spaces between words. A detail written in one is
 * blocked for its whole subject, and one said in one under a blocked subject
 * is held, so a forgotten detail said again in other words, or in another
 * language, is not learned again.
 */
const UNCOMPARED = /(?!\p{Script=Latin})\p{L}/u;

/** The words of a stemmed word list, as `detailWords` makes them. */
const stems = (words: string) => detailWords(words);
const stem = (word: string) => [...stems(word)][0] ?? word;

/**
 * Words real models use for one thing in other words (plurals and endings
 * are already one word): a seat "when flying" or "on planes" is one "on
 * flights"; someone who "lives in", "is based in"
 * or "resides in" a city has a home there; "doesn't eat meat" and "veggie"
 * say vegetarian.
 */
const SAME_WORD: Record<string, string> = {
  flying: 'flight',
  fly: 'flight',
  flies: 'flight',
  plane: 'flight',
  planes: 'flight',
  airplane: 'flight',
  airplanes: 'flight',
  airline: 'flight',
  airlines: 'flight',
  live: 'home',
  lives: 'home',
  living: 'home',
  lived: 'home',
  based: 'home',
  reside: 'home',
  resides: 'home',
  residence: 'home',
  dietary: 'diet',
  veggie: 'vegetarian',
  veg: 'vegetarian',
  meat: 'vegetarian',
};
/**
 * The topic each kind of detail is filed under today, so the older headings
 * real models gave a detail of the person's own still name it:
 * preference.flights.seat is a travel seat, person.diet.vegetarian a food
 * diet, person.allergy.peanuts a health allergy.
 */
const TOPIC_OF: Record<string, string> = Object.fromEntries(
  Object.entries({
    flight: 'travel',
    seat: 'travel',
    diet: 'food',
    vegetarian: 'food',
    vegan: 'food',
    allergy: 'health',
    home: 'home',
  }).map(([word, topic]) => [stem(word), topic]),
);
/** Older headings that say where a detail belongs: person.location.city is a home city. */
const HEADING: Record<string, string> = { location: 'home', locations: 'home' };

/** Words that only say what kind of detail it is, never which one: "seat", "allergy", "city". */
const KIND = stems(
  'allergy diet seat home city travel food health work preference preferences instruction ' +
    'instructions rule rules note notes info detail details general personal profile status',
);
/** Words that say how much or how often, not what: "always", "prefers", "only". */
const FILLER = stems(
  'always usually often generally only also please really just prefer prefers preferred ' +
    'like likes liked love loves want wants wanted need needs needed book books booking ' +
    'booked take takes pick picks choose chooses get gets make makes keep keeps sure mind ' +
    'remember every time times any anything something each when whenever while about there ' +
    'then than what which where how if because',
);
/** Words that say what kind of detail something is, as a missing one may be. */
const TOPIC_WORDS = new Set([...stems([...TOPICS].join(' ')), ...Object.values(TOPIC_OF)]);

/** The meaningful words of a text, each in one form, with the topic each kind of detail implies. */
function wordsOf(text: string): Set<string> {
  const said = stems(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}']+/u)
      .map((word) => SAME_WORD[word] ?? word)
      .join(' '),
  );
  for (const word of [...said]) {
    const topic = TOPIC_OF[word];
    if (topic) said.add(topic);
  }
  for (const word of FILLER) said.delete(word);
  return said;
}

/**
 * The words of what a subject is about: no heading that names the person or
 * says nothing ("person", "user", "preference"), no room member's part, and an
 * older heading read as the topic it is today.
 */
function subjectSays(domainKey: string): Set<string> {
  const parts = withoutMember(domainKey.split(':exception:')[0] ?? domainKey)
    .split('.')
    .filter(Boolean);
  const kept = parts.flatMap((part, index) => {
    if (index === 0 && PERSON_HEADS.has(part)) return [];
    if (SELF.has(part) || GENERIC_HEADS.has(part)) return [];
    return [HEADING[part] ?? part];
  });
  return wordsOf(kept.join(' ').replace(/[_-]+/g, ' '));
}

/**
 * Words that name someone, in a detail about someone: "sam" and "friend" in
 * person.friend.sam.city. None in the person's own detail, nor in one an
 * older extraction saved as one run of words ("person.peanut_allergy").
 */
function personWords(domainKey: string, content = ''): Set<string> {
  const whose = whoseDetail(domainKey);
  if (whose.kind !== 'other' || ownTopicRun(domainKey, content)) return new Set();
  return stems([whose.who, whose.name ?? '', whose.relation ?? '', ...RELATIONS].join(' '));
}

type Key = { tag: (word: string) => string; check: string };
/**
 * This install's key for one space's block tags, or null when the install has
 * no master key. Read when it is needed, so a test or a restart that sets it
 * is seen.
 */
function blockKey(spaceId: string): Key | null {
  const master = process.env.MELETE_MASTER_KEY;
  if (!master) return null;
  const base = Buffer.from(hkdfSync('sha256', master, 'melete', 'memory block detail v1', 32));
  const space = createHmac('sha256', base).update(spaceId).digest();
  const tag = (word: string) => createHmac('sha256', space).update(word).digest('hex').slice(0, 10);
  return { tag, check: tag('\u0000check').slice(0, 6) };
}

/** A block as it is matched: its subject, registry key, and the tags of what was forgotten. */
export type Block = {
  subject: string;
  key: string | null;
  /** Tags of every word the forgotten detail said; null when the block holds for its subject. */
  tags: Set<string> | null;
  /** The tag check it was made with; tags made with another key are not read. */
  check: string | null;
  /** It holds for anything about its subject, not just the detail forgotten. */
  whole: boolean;
};
export type Blocks = { list: Block[]; key: Key | null };

/**
 * How far each of a space's blocks reaches, as `blockedDetail` holds it.
 * Blocks kept for their subject reach all of it, and so does a block on a
 * detail whose tags were made with a key this install no longer has: its
 * detail can no longer be told apart.
 */
export function storedScopes(blocks: Blocks): BlockScope[] {
  return blocks.list.map((block) =>
    block.tags && !block.whole && blocks.key && block.check === blocks.key.check
      ? 'detail'
      : 'topic',
  );
}

/** Read the blocks of one space, as stored. */
export function readBlocks(spaceId: string, rows: readonly Record<string, unknown>[]): Blocks {
  return {
    key: blockKey(spaceId),
    list: rows.map((row) => {
      const stored = String(row.domain_key);
      const at = stored.indexOf(DETAIL);
      const key = row.key ? String(row.key) : null;
      if (at < 0) return { subject: stored, key, tags: null, check: null, whole: true };
      const [check = '', ...tags] = stored.slice(at + DETAIL.length).split('.');
      const whole = check.startsWith(WHOLE);
      return {
        subject: stored.slice(0, at),
        key,
        tags: new Set(tags),
        check: whole ? check.slice(WHOLE.length) : check,
        whole,
      };
    }),
  };
}

/**
 * The subject a block on this detail is stored under, and how far it ended up
 * reaching. When the detail says something of its own and the install has a
 * key, the tags of its words are kept beside the subject; a block on anything
 * about the subject marks them so. A detail that says nothing beyond its kind
 * ("Has an allergy"), or is written in a script whose words are not compared,
 * is blocked for its whole subject whichever was asked for.
 */
export function blockedSubject(
  spaceId: string,
  domainKey: string,
  content: string | null,
  scope: BlockScope,
): { subject: string; scope: BlockScope } {
  const key = blockKey(spaceId);
  const words = wordsOf(content ?? '');
  const named = personWords(domainKey, content ?? '');
  const distinct = [...words].filter((word) => !KIND.has(word) && !named.has(word));
  if (!key || !distinct.length || UNCOMPARED.test(content ?? ''))
    return { subject: domainKey, scope: 'topic' };
  const tags = [...new Set([...words].map(key.tag))].sort();
  const check = scope === 'topic' ? `${WHOLE}${key.check}` : key.check;
  return { subject: `${domainKey}${DETAIL}${[check, ...tags].join('.')}`, scope };
}

/** What a proposal says, as blocks are compared with it. */
export type Said = { domain_key: string; content: string; key?: unknown };

/**
 * Whether the person asked not to learn this detail again. `member` is the
 * part of a room member's subject (see `memberSubject`) for the one who said
 * it, or null for the person in their own memory.
 *
 * - A registry key or the same subject, under any name an older extraction
 *   gave it or the member's own tag, matches a block kept for its subject;
 *   so does a narrower subject under it (travel.seat.window for travel.seat).
 * - A block that kept what was forgotten matches a detail that says all of
 *   it again, under any subject of the person's own ("Tell restaurants about
 *   the peanut allergy" for "Allergic to peanuts"); or, under the same subject
 *   or one that narrows or widens it, a detail that says nothing the
 *   forgotten one did not ("Aisle seats only" for "Always books an aisle seat
 *   on flights"). A window seat on trains, extra legroom, a shellfish allergy
 *   or no alcohol is another detail, not blocked by it, unless the block is
 *   on anything about its subject: then it also holds as one kept for its
 *   subject does, below.
 * - A block on an older subject with no tags holds for the person's own detail
 *   that says every word of it, or all but one word of its kind when the new
 *   detail adds nothing of its own: a block on
 *   person.preference.flights.aisle_seat holds for "Always book aisle seats"
 *   under travel.seat, not for an aisle seat on trains.
 * - Someone else's detail is never blocked by the person's own block, nor the
 *   person's by a block on someone else's; one room member's block never
 *   holds for another member.
 */
export function blockedDetail(blocks: Blocks, said: Said, member: string | null): boolean {
  if (!blocks.list.length) return false;
  const subjects = new Set([
    said.domain_key,
    ...olderOwnSubjects(said.domain_key),
    ...(member ? [memberSubject(said.domain_key, member)] : []),
  ]);
  const own = whoseDetail(said.domain_key, said.content).kind === 'self';
  const proposalSays = subjectSays(said.domain_key);
  const words = new Set([...proposalSays, ...wordsOf(said.content)]);
  const others = personWords(said.domain_key, said.content);
  const distinct = [...words].filter((word) => !KIND.has(word) && !others.has(word));
  const key = blocks.key;
  const tagged = key ? new Set([...words].map(key.tag)) : null;
  return blocks.list.some((block) => {
    if (block.key && typeof said.key === 'string' && block.key === said.key) return true;
    const same = subjects.has(block.subject);
    // Anything about a subject is about the narrower subjects under it too:
    // travel.seat.window is about the travel seat.
    const under = !same && block.whole && narrower(subjects, block.subject);
    // A room member's block is only that member's.
    const blockMember = MEMBER.exec(block.subject)?.[1] ?? null;
    if (blockMember && blockMember !== (member ?? '').slice(0, 12) && !same) return false;
    if (under) return true;
    const blockOwn =
      olderOwnSubject(block.subject) ||
      ownTopicRun(block.subject, said.content) ||
      whoseDetail(block.subject).kind === 'self';
    const sameWhose = same || (own && blockOwn);
    if (!sameWhose) return false;
    const readable = block.tags && key && block.check === key.check && tagged ? block.tags : null;
    if (!readable) {
      // Tags made with a key this install no longer has hold for their subject.
      if (same) return true;
      return untaggedOwnBlock(block.subject, said, words, proposalSays, distinct);
    }
    if (same && (block.whole || UNCOMPARED.test(said.content))) return true;
    // Who a detail about someone is about is in its subject; their name or
    // relation need not be said again ("Sam", "friend").
    const named = new Set([...personWords(block.subject)].map((word) => key?.tag(word)));
    // Everything the forgotten detail said, said again.
    if ([...readable].every((tag) => named.has(tag) || tagged?.has(tag))) return true;
    // Under its subject, or one that narrows or widens it, nothing it did not say.
    const blockSays = subjectSays(block.subject);
    const related =
      same ||
      [...blockSays].every((word) => proposalSays.has(word)) ||
      [...proposalSays].every((word) => blockSays.has(word));
    if (related && distinct.length && key && distinct.every((word) => readable.has(key.tag(word))))
      return true;
    // A block on anything about its subject also holds wherever one kept for
    // its subject alone would.
    return block.whole && untaggedOwnBlock(block.subject, said, words, proposalSays, distinct);
  });
}

/**
 * Whether one of these subjects sits under `wider`: travel.seat.window and
 * travel.seat.window.member_… under travel.seat. A heading that names nothing
 * ("general", "person", "self") is no topic to reach under.
 */
function narrower(subjects: ReadonlySet<string>, wider: string): boolean {
  const base = withoutMember(wider);
  if (!subjectSays(base).size) return false;
  return [...subjects].some((subject) => withoutMember(subject).startsWith(`${base}.`));
}

/** An own block kept for its subject, matched against the person's own detail under another. */
function untaggedOwnBlock(
  subject: string,
  said: Said,
  words: Set<string>,
  proposalSays: Set<string>,
  distinct: string[],
): boolean {
  // "person.peanut_allergy" reads as the words "peanut allergy".
  const blockSays = subjectSays(subject);
  if (!blockSays.size) return false;
  // Read across subjects, a block under a topic heading holds for that topic,
  // not for one it narrows to: preference.flights.seat is not a block on
  // travel.seat.train.
  if (
    !olderOwnSubject(subject) &&
    !ownTopicRun(subject, said.content) &&
    ![...proposalSays].every((word) => blockSays.has(word))
  )
    return false;
  const missing = [...blockSays].filter((word) => !words.has(word));
  if (!missing.length) return true;
  const [only = ''] = missing;
  return (
    missing.length === 1 &&
    blockSays.size >= 3 &&
    TOPIC_WORDS.has(only) &&
    distinct.every((word) => blockSays.has(word))
  );
}
