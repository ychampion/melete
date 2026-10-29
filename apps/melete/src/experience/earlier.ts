/**
 * `conversations.search` and `conversations.read`: the agent looks in the
 * person's earlier conversations, mid-turn.
 *
 * Memory keeps what holds about the person, not every one-off: the plumber's
 * number from last week, the three vacuums found on Tuesday, the draft written
 * yesterday. A new chat that points back at one of those is answered from the
 * conversation itself, found by its words and read in a bounded excerpt.
 *
 * Only the person's own chats are searched, decided as Home decides it
 * (`ownJob`): never a room's, never another person's, and never the
 * conversation the turn is in. A conversation that must stay private is read
 * only into a turn that is itself private and stays on the person's own model,
 * as memory learned in private is recalled. What the person said there is their
 * own words; what Melete answered is not a verified fact, and nothing read here
 * vouches for a recipient, address or amount at admission: the broker's trust
 * rule finds no origin for it, and the person is asked.
 */
import type { CapabilityClaims } from '@melete/contracts';
import { estimateTokens } from '@melete/skills';
import { z } from 'zod';
import type { Query } from '../broker/records.ts';
import { lexicalQuery, lexicalTerms } from '../memory/recall.ts';
import { hideSecrets } from './answer-filter.ts';

/** How many hits a search returns when it is not told, and the most it ever returns. */
export const SEARCH_DEFAULT_LIMIT = 5;
export const SEARCH_MAX_LIMIT = 20;
/** The most an excerpt read from one conversation holds. */
export const READ_TOKENS = 2_000;
/** The most of one side of a turn an excerpt shows. */
const SIDE_CHARS = 2_400;
/** Each side of the matched words a snippet shows. */
const SNIPPET_CHARS = 140;
/** The person's latest sends and changes a search looks through for what Melete made. */
const RECENT_ACTIONS = 500;

export const conversationSearchInput = z.strictObject({
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).optional(),
});
export const conversationReadInput = z.strictObject({
  conversation_id: z.string().trim().min(1).max(100),
  around: z.union([z.number().int().min(1), z.string().trim().min(1).max(200)]).optional(),
});

export type EarlierOptions = {
  sql: Query;
  /**
   * Whether the conversation a job belongs to must stay private: its space or
   * agent is marked private, or it is about a sensitive topic.
   */
  keepsPrivate: (jobId: string) => Promise<boolean>;
  /**
   * Whether this attempt may be shown what a private conversation said: it is
   * private itself, and its requests stay on the person's own model. A private
   * turn the person let go to a cloud model redacted is not, since redaction
   * swaps details, not what a conversation was about.
   */
  readsPrivate: (jobId: string, attemptId: string) => Promise<boolean>;
};

export type ConversationHit = {
  conversation_id: string;
  title: string;
  when: string;
  snippet: string;
  /** `message`: the person's words. `answer`: Melete's. `made`: what Melete sent or made. */
  kind: 'message' | 'answer' | 'made';
  /** The turn it is in, counted from the conversation's first; `conversations.read` centres on it. */
  position: number | null;
};

export type ConversationSearchResult = {
  status: 'found' | 'nothing' | 'unavailable' | 'not_available_here';
  hits: ConversationHit[];
  /** Matches left out because their conversation stays private and this one does not. */
  withheld?: number;
  guidance: string;
};

export type ConversationReadResult = {
  status: 'found' | 'not_found' | 'withheld' | 'unavailable' | 'not_available_here';
  conversation_id?: string;
  title?: string;
  turns?: { position: number; when: string; said: string; answer: string }[];
  total_turns?: number;
  more_before?: boolean;
  more_after?: boolean;
  guidance: string;
};

const TRUST =
  'What the person said there (message) is their own words. What Melete answered (answer) is not a verified fact: check a recipient, address, number or amount taken from it with the person before you act on it.';

export const EARLIER_GUIDANCE = {
  found: `These are from the person's earlier conversations. ${TRUST} Read more around a hit with conversations.read.`,
  nothing:
    "Nothing in the person's earlier conversations matches these words. Try other words once if theirs might differ. If there is still nothing, say you could not find it in earlier chats; never say they never told you.",
  unavailable:
    'Earlier conversations could not be searched just now. Say you could not check; never say the conversation does not exist.',
  not_available_here:
    'This conversation does not read earlier ones, so nothing was searched. Do not say what they hold either way.',
  withheld:
    'Some matches are in conversations the person keeps private, and are not shown in this one. Do not guess what they say.',
  read: `This is part of an earlier conversation, in order. ${TRUST}`,
  not_found:
    "No earlier conversation of the person's has that id. Use a conversation_id from conversations.search.",
  private:
    'That conversation is kept private, and can only be read in a private conversation. Do not guess what it says.',
} as const;

type Turn = {
  conversation: string;
  space: string;
  person: string;
  /** Whether a private conversation's words may be shown to this attempt (`readsPrivate`). */
  private: boolean;
};

/**
 * The turn's conversation and whose it is, or null when earlier conversations
 * are not read here: a room's work, an agent set not to read memory, or
 * public research.
 */
async function turnOf(
  options: EarlierOptions,
  claims: Pick<CapabilityClaims, 'job_id' | 'attempt_id'>,
): Promise<Turn | null> {
  const jobId = claims.job_id;
  const [row] = await options.sql`select j.space_id,
      coalesce(j.experience_parent_id, j.id) as conversation_id,
      coalesce(j.principal_id, (select id from owner limit 1)) as person,
      j.constraints, a.reads_memory,
      (j.audience = 'room' or p.kind = 'room' or r.audience = 'room') as room
    from job j
    left join principal p on p.id = j.principal_id
    left join job r on r.id = j.experience_parent_id and r.space_id = j.space_id
    left join experience_turn t on t.id = j.current_turn_id
    left join agent a on a.id = coalesce(t.agent_id, j.agent_id) and a.space_id = j.space_id
    where j.id = ${jobId}`;
  if (!row || row.room === true || !row.person || row.reads_memory === false) return null;
  if ((row.constraints as { public_compartment?: boolean } | null)?.public_compartment === true)
    return null;
  return {
    conversation: String(row.conversation_id),
    space: String(row.space_id),
    person: String(row.person),
    private: await options.readsPrivate(jobId, claims.attempt_id),
  };
}

/** The person's own chats in this space, other than the one the turn is in (`ownJob`). */
const own = (sql: EarlierOptions['sql'], turn: Turn, alias: string) =>
  sql`${sql(alias)}.space_id = ${turn.space} and ${sql(alias)}.kind = 'chat'
    and ${sql(alias)}.audience = 'principal' and ${sql(alias)}.id <> ${turn.conversation}
    and coalesce(${sql(alias)}.principal_id, (select id from owner limit 1)) = ${turn.person}`;

/** How many of the query's words a text holds, matched the way the index matches them. */
function matches(text: string, terms: readonly string[]): number[] {
  const lower = text.toLowerCase();
  return terms
    .map((term) => lower.indexOf(term.length >= 5 ? stem(term) : term))
    .filter((at) => at >= 0);
}
const stem = (term: string) => {
  const cut = term.replace(/(?:ations?|ities|ies|ing|ic|es|ed|y|s)$/u, '');
  return cut.length >= 4 ? cut : term;
};

/** The part of a text around the first of the query's words in it, on one line. */
function snippet(text: string, terms: readonly string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const found = matches(flat, terms);
  const at = found.length ? Math.min(...found) : 0;
  const start = Math.max(0, at - SNIPPET_CHARS);
  const end = Math.min(flat.length, at + SNIPPET_CHARS);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

type Ranked = ConversationHit & { score: number };

/** Search the person's earlier conversations for an attempt. */
export async function searchConversations(
  options: EarlierOptions,
  claims: Pick<CapabilityClaims, 'job_id' | 'attempt_id'>,
  input: unknown,
): Promise<ConversationSearchResult> {
  const { query, limit = SEARCH_DEFAULT_LIMIT } = conversationSearchInput.parse(input);
  const none = (status: 'nothing' | 'unavailable' | 'not_available_here') => ({
    status,
    hits: [],
    guidance: EARLIER_GUIDANCE[status],
  });
  const turn = await turnOf(options, claims);
  if (!turn) return none('not_available_here');
  const tsquery = lexicalQuery(query);
  if (!tsquery) return none('nothing');
  const terms = lexicalTerms(query);
  const sql = options.sql;
  // Enough of each kind that the best still fill the answer once private ones are left out.
  const fetch = Math.min(limit * 3, 60);
  const ranked: Ranked[] = [];
  try {
    const turns = await sql`select t.text, t.answer, t.created_at, c.id as conversation_id, c.title,
        (select count(*) from experience_turn o where o.job_id = t.job_id
          and (o.created_at, o.id) <= (t.created_at, t.id)) as position,
        ts_rank_cd(to_tsvector('simple', t.text || ' ' || t.answer), to_tsquery('simple', ${tsquery})) as score
      from experience_turn t join job c on c.id = t.job_id
      where ${own(sql, turn, 'c')}
        and to_tsvector('simple', t.text || ' ' || t.answer) @@ to_tsquery('simple', ${tsquery})
      order by score desc, t.created_at desc limit ${fetch}`;
    for (const row of turns) {
      const said = hideSecrets(String(row.text ?? ''));
      const answer = hideSecrets(String(row.answer ?? ''));
      // The side that holds more of the words; an answer when both hold as many.
      const person = matches(said, terms).length > matches(answer, terms).length;
      ranked.push({
        conversation_id: String(row.conversation_id),
        title: String(row.title ?? ''),
        when: iso(row.created_at),
        snippet: snippet(person ? said : answer, terms),
        kind: person ? 'message' : 'answer',
        position: Number(row.position),
        score: Number(row.score),
      });
    }
    // A conversation whose title holds the words, shown by how it opened.
    const titled = await sql`select c.id, c.title, f.text, f.created_at,
        ts_rank_cd(to_tsvector('simple', c.title), to_tsquery('simple', ${tsquery})) as score
      from job c
      join lateral (select text, created_at from experience_turn
        where job_id = c.id order by created_at, id limit 1) f on true
      where ${own(sql, turn, 'c')}
        and to_tsvector('simple', c.title) @@ to_tsquery('simple', ${tsquery})
      order by score desc, c.updated_at desc limit ${fetch}`;
    for (const row of titled) {
      const id = String(row.id);
      if (ranked.some((hit) => hit.conversation_id === id && hit.position === 1)) continue;
      ranked.push({
        conversation_id: id,
        title: String(row.title ?? ''),
        when: iso(row.created_at),
        snippet: snippet(hideSecrets(String(row.text ?? '')), terms),
        kind: 'message',
        position: 1,
        score: Number(row.score),
      });
    }
    // What Melete sent or made there: a receipt's subject and its external reference.
    const made = await sql`with recent as (
        select a.kind, a.created_at, a.attempt_id, c.id as conversation_id, c.title,
          coalesce(a.canonical_payload->>'subject', a.canonical_payload->>'summary', '') as subject,
          coalesce(a.receipt->>'external_ref', '') as ref
        from action a
        join job aj on aj.id = a.job_id
        join job c on c.id = coalesce(aj.experience_parent_id, aj.id)
        where ${own(sql, turn, 'c')} and a.status = 'succeeded' and a.effect_class <> 'read'
        order by a.created_at desc limit ${RECENT_ACTIONS})
      select m.kind, m.created_at, m.conversation_id, m.title, m.subject, m.ref,
        (select count(*) from experience_turn o join experience_turn h on h.id = att.turn_id
          where o.job_id = h.job_id and (o.created_at, o.id) <= (h.created_at, h.id)) as position,
        ts_rank_cd(to_tsvector('simple', m.subject || ' ' || m.ref), to_tsquery('simple', ${tsquery})) as score
      from recent m left join attempt att on att.id = m.attempt_id
      where to_tsvector('simple', m.subject || ' ' || m.ref) @@ to_tsquery('simple', ${tsquery})
      order by score desc, m.created_at desc limit ${fetch}`;
    for (const row of made) {
      const subject = hideSecrets(String(row.subject ?? ''));
      const ref = String(row.ref ?? '');
      ranked.push({
        conversation_id: String(row.conversation_id),
        title: String(row.title ?? ''),
        when: iso(row.created_at),
        snippet: `${row.kind}: ${subject}${ref ? ` (ref ${ref})` : ''}`.slice(0, SNIPPET_CHARS * 2),
        kind: 'made',
        position: Number(row.position) > 0 ? Number(row.position) : null,
        score: Number(row.score),
      });
    }
  } catch (error) {
    // A database that cannot answer now is said as such, never as "nothing".
    process.stderr.write(`conversations.search: ${(error as Error).message}\n`);
    return none('unavailable');
  }
  ranked.sort((a, b) => b.score - a.score || (a.when < b.when ? 1 : a.when > b.when ? -1 : 0));
  // A private conversation's words go only into a turn that is itself private.
  const privacy = new Map<string, boolean>();
  const hits: ConversationHit[] = [];
  let withheld = 0;
  for (const { score: _score, ...hit } of ranked) {
    if (hits.length >= limit) break;
    if (!turn.private) {
      if (!privacy.has(hit.conversation_id))
        privacy.set(hit.conversation_id, await options.keepsPrivate(hit.conversation_id));
      if (privacy.get(hit.conversation_id)) {
        withheld += 1;
        continue;
      }
    }
    hits.push(hit);
  }
  if (!hits.length)
    return withheld
      ? { status: 'nothing', hits, withheld, guidance: EARLIER_GUIDANCE.withheld }
      : none('nothing');
  return {
    status: 'found',
    hits,
    ...(withheld ? { withheld } : {}),
    guidance: withheld
      ? `${EARLIER_GUIDANCE.found} ${EARLIER_GUIDANCE.withheld}`
      : EARLIER_GUIDANCE.found,
  };
}

const clip = (text: string, chars: number) =>
  text.length > chars ? `${text.slice(0, Math.max(0, chars - 1))}…` : text;

/** Read a bounded part of one of the person's earlier conversations. */
export async function readConversation(
  options: EarlierOptions,
  claims: Pick<CapabilityClaims, 'job_id' | 'attempt_id'>,
  input: unknown,
): Promise<ConversationReadResult> {
  const { conversation_id: id, around } = conversationReadInput.parse(input);
  const turn = await turnOf(options, claims);
  if (!turn) return { status: 'not_available_here', guidance: EARLIER_GUIDANCE.not_available_here };
  const sql = options.sql;
  let rows: readonly Record<string, unknown>[];
  let title: string;
  try {
    const [found] =
      await sql`select c.id, c.title from job c where c.id = ${id} and ${own(sql, turn, 'c')}`;
    if (!found) return { status: 'not_found', guidance: EARLIER_GUIDANCE.not_found };
    title = String(found.title ?? '');
    if (!turn.private && (await options.keepsPrivate(id)))
      return { status: 'withheld', guidance: EARLIER_GUIDANCE.private };
    rows = await sql`select text, answer, created_at from experience_turn
      where job_id = ${id} order by created_at, id`;
  } catch (error) {
    process.stderr.write(`conversations.read: ${(error as Error).message}\n`);
    return { status: 'unavailable', guidance: EARLIER_GUIDANCE.unavailable };
  }
  const turns = rows.map((row, index) => ({
    position: index + 1,
    when: iso(row.created_at),
    said: clip(hideSecrets(String(row.text ?? '')), SIDE_CHARS),
    answer: clip(hideSecrets(String(row.answer ?? '')), SIDE_CHARS),
  }));
  if (!turns.length)
    return {
      status: 'found',
      conversation_id: id,
      title,
      turns: [],
      total_turns: 0,
      more_before: false,
      more_after: false,
      guidance: EARLIER_GUIDANCE.read,
    };
  // The turn to centre on: the one asked for, the one holding most of a
  // phrase's words, or the latest.
  let centre = turns.length - 1;
  if (typeof around === 'number') centre = Math.min(around, turns.length) - 1;
  else if (around) {
    const phrase = around.toLowerCase();
    const terms = lexicalTerms(around);
    let best = -1;
    for (const [index, entry] of turns.entries()) {
      const text = `${entry.said}\n${entry.answer}`;
      const score =
        (text.toLowerCase().includes(phrase) ? terms.length + 1 : 0) + matches(text, terms).length;
      if (score > best) {
        best = score;
        centre = index;
      }
    }
  }
  const cost = (entry: (typeof turns)[number]) => estimateTokens(JSON.stringify(entry));
  let from = centre;
  let to = centre;
  let used = cost(turns[centre] as (typeof turns)[number]);
  // Out from the centre, one turn either side at a time, while the excerpt has room.
  for (let grew = true; grew; ) {
    grew = false;
    for (const next of [from - 1, to + 1]) {
      const entry = turns[next];
      if (!entry || used + cost(entry) > READ_TOKENS) continue;
      used += cost(entry);
      if (next < from) from = next;
      else to = next;
      grew = true;
    }
  }
  return {
    status: 'found',
    conversation_id: id,
    title,
    turns: turns.slice(from, to + 1),
    total_turns: turns.length,
    more_before: from > 0,
    more_after: to < turns.length - 1,
    guidance: EARLIER_GUIDANCE.read,
  };
}
