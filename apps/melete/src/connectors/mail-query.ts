/**
 * A mail search query, read the same way for every kind of mailbox.
 *
 * Words must all appear, a phrase in double quotes appears as written, OR
 * between them gives alternatives, and parentheses group. The result is a
 * list of alternatives, each a list of terms that must all match, which every
 * mailbox can then write in its own syntax.
 *
 * Anything else a query carries is not something every mailbox can do, so it
 * is set aside and the plain terms around it are searched: AND is implied,
 * NOT and a leading minus drop what they apply to, a field name before a colon
 * (`from:`, `subject:`) is taken off its value, and a filter with no text to
 * search (`is:unread`, `after:2026/01/01`) is dropped. A query never matches
 * nothing just because of how it was written. A query left with no terms
 * lists the newest mail, as an empty one does.
 *
 * One search runs a bounded number of alternatives. Those past the bound are
 * never dropped silently: the search result names them, so they can be
 * searched next.
 */

/** Alternatives, each a list of terms that must all appear. Empty: no condition. */
export type MailQuery = string[][];

/** Most alternatives one search runs; a mailbox without OR runs each one. */
export const MAX_ALTERNATIVES = 8;
/** Most alternatives past that bound that a search names back, so they can be searched next. */
export const MAX_LEFT_OUT = 16;
const LISTED = MAX_ALTERNATIVES + MAX_LEFT_OUT;
/** Most terms one alternative needs to match. */
const MAX_TERMS = 8;
const MAX_DEPTH = 8;

/** Field names whose value is a filter, not text to look for. */
const FILTERS = new Set([
  'is',
  'has',
  'in',
  'label',
  'labels',
  'category',
  'after',
  'before',
  'older',
  'newer',
  'older_than',
  'newer_than',
  'since',
  'until',
  'on',
  'date',
  'received',
  'sent',
  'size',
  'larger',
  'smaller',
  'deliveredto',
  'list',
  'rfc822msgid',
  'importance',
  'kind',
  'hasattachment',
  'isread',
  'isflagged',
]);

type Token =
  | { kind: 'term'; text: string }
  | { kind: 'or' | 'open' | 'close' }
  /** Applies to the next term or group: `drop` sets it aside, `keep` is a field name. */
  | { kind: 'drop' | 'keep' };

const QUOTES = /["\u201c\u201d\u201e]/;
/** Punctuation around a word that no mailbox searches for. */
const EDGES = /^[^\p{L}\p{N}@#]+|[^\p{L}\p{N}]+$/gu;

function tokens(query: string): Token[] {
  const out: Token[] = [];
  let at = 0;
  while (at < query.length) {
    const char = query[at] as string;
    if (/\s/.test(char)) {
      at++;
    } else if (QUOTES.test(char)) {
      let end = at + 1;
      while (end < query.length && !QUOTES.test(query[end] as string)) end++;
      const text = query
        .slice(at + 1, end)
        .replace(/\s+/g, ' ')
        .trim();
      if (text) out.push({ kind: 'term', text });
      at = end + 1;
    } else if (char === '(' || char === ')') {
      out.push({ kind: char === '(' ? 'open' : 'close' });
      at++;
    } else {
      let end = at;
      while (end < query.length && !/[\s()"\u201c\u201d\u201e]/.test(query[end] as string)) end++;
      out.push(...word(query.slice(at, end)));
      at = end;
    }
  }
  return out;
}

/** One unquoted word as the tokens it stands for. */
function word(raw: string): Token[] {
  const upper = raw.toUpperCase();
  if (upper === 'OR' || raw === '|' || raw === '||') return [{ kind: 'or' }];
  if (upper === 'AND' || raw === '&' || raw === '&&' || raw === '+') return [];
  if (upper === 'NOT' || raw === '-' || raw === '!') return [{ kind: 'drop' }];
  if (raw.startsWith('-') || raw.startsWith('!')) return [{ kind: 'drop' }, ...word(raw.slice(1))];
  const field = /^([A-Za-z_]+):(.*)$/.exec(raw);
  if (field) {
    const modifier: Token = {
      kind: FILTERS.has((field[1] as string).toLowerCase()) ? 'drop' : 'keep',
    };
    return [modifier, ...(field[2] ? word(field[2]) : [])];
  }
  const text = raw.replace(/\*+$/, '').replace(EDGES, '');
  return text ? [{ kind: 'term', text }] : [];
}

/**
 * Alternatives in reading order, as many as are kept for searching or for
 * naming back, and whether the query had more than that.
 */
type Reading = { list: MailQuery; cut: boolean };

const unit = (): Reading => ({ list: [[]], cut: false });

const bounded = (list: MailQuery, cut: boolean): Reading =>
  list.length > LISTED ? { list: list.slice(0, LISTED), cut: true } : { list, cut };

/** Every pairing of one alternative from each side: AND, in alternatives. */
function both(left: Reading, right: Reading): Reading {
  const out: MailQuery = [];
  for (const a of left.list)
    for (const b of right.list) {
      if (out.length === LISTED) return { list: out, cut: true };
      out.push([...a, ...b]);
    }
  return { list: out, cut: left.cut || right.cut };
}

/**
 * A query as the alternatives one search runs, and those past the bound
 * that it does not. `more` says the query had still others, too many to name.
 */
export type MailQueryReading = { alternatives: MailQuery; leftOut: MailQuery; more: boolean };

/** Read a query into alternatives of terms, saying what a search leaves out. */
export function readMailQuery(query: string): MailQueryReading {
  const items = tokens(query);
  let at = 0;
  // expression := conjunction (OR conjunction)*
  const expression = (depth: number): Reading => {
    let out: Reading = { list: [], cut: false };
    for (;;) {
      const part = conjunction(depth);
      out = bounded([...out.list, ...part.list], out.cut || part.cut);
      if (items[at]?.kind !== 'or') return out;
      at++;
    }
  };
  // conjunction := factor*, up to an OR, a closing parenthesis or the end
  const conjunction = (depth: number): Reading => {
    let out = unit();
    for (;;) {
      const next = items[at];
      if (!next || next.kind === 'or') return out;
      if (next.kind === 'close') {
        if (depth > 0) return out;
        at++; // A stray closing parenthesis is set aside.
        continue;
      }
      out = both(out, factor(depth));
    }
  };
  // factor := (drop | keep) factor | "(" expression ")" | term
  const factor = (depth: number): Reading => {
    const next = items[at++];
    if (!next) return unit();
    if (next.kind === 'drop' || next.kind === 'keep') {
      const following = items[at];
      if (!following || following.kind === 'or' || following.kind === 'close') return unit();
      const inner = factor(depth);
      return next.kind === 'drop' ? unit() : inner;
    }
    if (next.kind === 'open') {
      // Nesting this deep says nothing a search needs; the parenthesis is set aside.
      if (depth >= MAX_DEPTH) return unit();
      const inner = expression(depth + 1);
      if (items[at]?.kind === 'close') at++;
      return inner.list.length ? inner : unit();
    }
    if (next.kind === 'term') return { list: [[next.text]], cut: false };
    return unit();
  };
  const whole = expression(0);
  const seen = new Set<string>();
  const out: MailQuery = [];
  for (const alternative of whole.list) {
    const terms: string[] = [];
    const lower = new Set<string>();
    for (const term of alternative) {
      const key = term.toLowerCase();
      if (lower.has(key) || terms.length >= MAX_TERMS) continue;
      lower.add(key);
      terms.push(term);
    }
    // An alternative left with nothing to look for would match everything; the others still say something.
    if (!terms.length) continue;
    const key = [...lower].sort().join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(terms);
  }
  return {
    alternatives: out.slice(0, MAX_ALTERNATIVES),
    leftOut: out.slice(MAX_ALTERNATIVES),
    more: whole.cut,
  };
}

/** The alternatives one search runs. */
export function parseMailQuery(query: string): MailQuery {
  return readMailQuery(query).alternatives;
}

/** An alternative written back as a query the model can search with next. */
export function mailQueryText(terms: string[]): string {
  return terms.map((term) => (/\s/.test(term) ? `"${term}"` : term)).join(' ');
}

/** What each email.search query understands, said to the model in the tool description. */
export const MAIL_QUERY_HELP =
  'Query: words that must all appear, "a phrase" in quotes, OR between alternatives; empty for the newest.';

/** The query as Gmail's search box reads it. Empty when there is nothing to look for. */
export function gmailQuery(query: MailQuery): string {
  const term = (text: string) =>
    /^[\p{L}\p{N}][\p{L}\p{N}@._'+-]*$/u.test(text) && !/^(?:OR|AND|NOT|AROUND)$/.test(text)
      ? text
      : `"${text.replace(/"/g, '')}"`;
  const alternative = (terms: string[]) => terms.map(term).join(' ');
  if (query.length === 1) return alternative(query[0] as string[]);
  return query
    .map((terms) => (terms.length > 1 ? `(${alternative(terms)})` : alternative(terms)))
    .join(' OR ');
}

/** An IMAP SEARCH for the query, in imapflow's query object. */
export function imapQuery(query: MailQuery): Record<string, unknown> {
  if (!query.length) return { all: true };
  // imapflow writes an `or` of a single condition as that condition alone,
  // which is how a second TEXT key joins the first: both must match.
  const alternative = (terms: string[]): Record<string, unknown> =>
    terms.length > 1 ? { text: terms[0], or: [alternative(terms.slice(1))] } : { text: terms[0] };
  return query.length === 1 ? alternative(query[0] as string[]) : { or: query.map(alternative) };
}

/**
 * One Graph `$search` value per alternative. Graph reads a value as KQL, and
 * how it reads a quoted phrase or an OR inside one is not documented for
 * messages, so each alternative goes as its own search of plain words and
 * the results are joined.
 */
export function graphSearches(query: MailQuery): string[] {
  return query.map((terms) => `"${terms.join(' ').replace(/["\\]/g, '')}"`);
}
