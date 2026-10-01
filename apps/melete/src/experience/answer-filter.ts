/**
 * What may be shown of text a model or an outside source wrote.
 *
 * The filter works on spans, never on whole strings: a credential is replaced
 * where it stands and the words around it are kept, so one match can never
 * blank an answer. Model ids, file paths, links, domains and addresses are
 * ordinary prose and pass untouched.
 *
 * Hidden:
 * - keys, tokens and passwords (`Bearer …`, `sk-…`, `password: …`, signed
 *   capability tokens, private key blocks, a password inside a link);
 * - approval hashes (64 hex characters) and the service's own record ids;
 * - a whole internal record, such as a tool call written out as JSON outside a
 *   code block, which is removed rather than replaced.
 *
 * A streamed answer is filtered by the same rules: `answerStream` gives the
 * part of the text so far that later text can no longer change, so the pieces
 * shown while it streams add up to exactly `answerText` of the whole.
 */

export const HIDDEN = '[hidden]';

/** Longest JSON record, in characters, that is taken out as internal. */
const RECORD_LIMIT = 8000;
/**
 * How many places that could start a record are looked at in one line.
 * Counting per line keeps a streamed answer and its saved copy looking at
 * the same places, and bounds the work on text full of braces.
 */
const RECORD_CANDIDATES = 200;

/**
 * Each pattern matches only the secret itself: a label in front of it ("Bearer ",
 * "password: ", a key file's first line) stays readable, and a streamed answer
 * never has to take back a label it already showed.
 */
const SECRET_PATTERNS: RegExp[] = [
  // An authorization header's credential.
  /(?<=\b(?:Bearer|Basic|Token)[ \t]{1,4})[A-Za-z0-9._~+/=-]{8,}/gi,
  // Provider keys with a known prefix.
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{12,}/g,
  /(?<![A-Za-z0-9])fw_[A-Za-z0-9]{16,}/g,
  /(?<![A-Za-z0-9])gh[opsu]_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g,
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/g,
  /(?<![A-Za-z0-9])sealed-box-v1:[A-Za-z0-9+/=._:-]+/g,
  // Signed tokens, the service's capability tokens among them: base64 JSON, dot, more.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g,
  // The value after a secret-sounding label: `password: …`, `api_key="…"`, `?token=…`.
  /(?<=(?<![A-Za-z])[A-Za-z_-]{0,40}(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)["']?[ \t]{0,4}[:=][ \t]{0,4}["']?)[^\s"'`,;&)}\]]{6,}/gi,
  // The password in a link's user part: https://user:password@host.
  /(?<=\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/@:]{1,128}:)[^\s/@]+(?=@)/gi,
  // The body of a private key block; the lines naming it stay.
  /(?<=-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----)[\s\S]*?(?=-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g,
  // An approval hash: a sha256 in lowercase hex.
  /(?<![0-9A-Za-z])[0-9a-f]{64}(?![0-9A-Za-z])/g,
  // The service's own record ids: a known prefix and a 26-character time-ordered id.
  /(?<![A-Za-z0-9_])(?:job|att|act|apr|sec|turn)_[0-9A-HJKMNP-TV-Z]{26}(?![A-Za-z0-9_])/g,
];
/** A long random run mixing upper case, lower case and digits, outside a link. */
const RANDOM_RUN =
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
const LINK = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s<>"'`]+/gi;

/** Keys only a tool call or one of the service's own records carries. */
const RECORD_KEYS = new Set([
  'tool',
  'tool_name',
  'tool_call',
  'tool_calls',
  'tool_use',
  'function_call',
  'canonical_payload',
  'payload_hash',
  'action_id',
  'approval_id',
  'attempt_id',
  'job_id',
  'capability',
  'effect_class',
]);

type Span = { start: number; end: number; replacement: string };

function isRecordValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every(isRecordValue);
  if (!value || typeof value !== 'object') return false;
  const keys = Object.keys(value);
  return (
    keys.some((key) => RECORD_KEYS.has(key)) ||
    (keys.includes('name') && (keys.includes('arguments') || keys.includes('parameters'))) ||
    ['function', 'tool_use', 'tool_call'].includes(String((value as { type?: unknown }).type))
  );
}

/** A whole JSON value that is an internal record rather than something said. */
export function isInternalRecord(text: string): boolean {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return false;
  try {
    return isRecordValue(JSON.parse(trimmed));
  } catch {
    return false;
  }
}

/** Where each fenced code block starts and ends; one still open runs to the end. */
function fences(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let open = -1;
  const line = /^[ \t]{0,3}(?:```|~~~)/gm;
  for (let match = line.exec(text); match; match = line.exec(text)) {
    if (open < 0) open = match.index;
    else {
      const close = text.indexOf('\n', match.index);
      ranges.push([open, close < 0 ? text.length : close]);
      open = -1;
    }
  }
  if (open >= 0) ranges.push([open, text.length]);
  return ranges;
}

/** True where a line begins. */
const lineStart = (text: string, index: number) => index > 0 && text[index - 1] === '\n';
const SPACE = /\s/;

const RECORD_START = /\{\s*(?:"|$)|\[\s*(?:\{\s*(?:"|$)|$)/y;

/** The end of the JSON value starting at `start`, or -1 when it has not closed yet. */
function closing(text: string, start: number, limit: number): number {
  let depth = 0;
  let quoted = false;
  for (let index = start; index < limit; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '\\') index++;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{' || character === '[') depth++;
    else if (character === '}' || character === ']') {
      depth--;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/**
 * Internal records outside code blocks, and where the earliest one that may
 * still be arriving begins (Infinity when none can be).
 */
function records(text: string): { spans: Span[]; open: number } {
  const spans: Span[] = [];
  let open = Number.POSITIVE_INFINITY;
  const fenced = fences(text);
  let fence = 0;
  let candidates = 0;
  for (let index = 0; index < text.length; index++) {
    if (lineStart(text, index)) candidates = 0;
    while (fence < fenced.length && (fenced[fence]?.[1] ?? 0) <= index) fence++;
    const range = fenced[fence];
    if (range && range[0] <= index) {
      index = range[1] - 1;
      continue;
    }
    const character = text[index];
    if (character !== '{' && character !== '[') continue;
    RECORD_START.lastIndex = index;
    if (!RECORD_START.test(text) || candidates >= RECORD_CANDIDATES) continue;
    candidates++;
    const limit = Math.min(text.length, index + RECORD_LIMIT);
    const end = closing(text, index, limit);
    if (end < 0) {
      // Still arriving and short enough to become a record: hold it.
      if (text.length - index < RECORD_LIMIT) {
        open = index;
        break;
      }
      continue;
    }
    if (isInternalRecord(text.slice(index, end))) {
      spans.push({ start: index, end, replacement: '' });
      index = end - 1;
    }
  }
  return { spans, open };
}

function matches(pattern: RegExp, text: string): [number, number][] {
  const found: [number, number][] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (!match[0].length) {
      pattern.lastIndex++;
      continue;
    }
    found.push([match.index, match.index + match[0].length]);
  }
  return found;
}

/** Every span to hide or remove, in order and not overlapping. */
function spans(text: string): { spans: Span[]; open: number; fenced: [number, number][] } {
  const found: Span[] = [];
  for (const pattern of SECRET_PATTERNS)
    for (const [start, end] of matches(pattern, text))
      found.push({ start, end, replacement: HIDDEN });
  const links = matches(LINK, text);
  for (const [start, end] of matches(RANDOM_RUN, text))
    if (!links.some(([from, to]) => from <= start && end <= to))
      found.push({ start, end, replacement: HIDDEN });
  const record = records(text);
  found.push(...record.spans);
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const span of found) {
    const last = merged.at(-1);
    if (last && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
      if (span.replacement === '') last.replacement = '';
    } else merged.push({ ...span });
  }
  return { spans: merged, open: record.open, fenced: fences(text) };
}

function apply(text: string, list: Span[]): string {
  let out = '';
  let at = 0;
  for (const span of list) {
    out += text.slice(at, span.start) + span.replacement;
    at = span.end;
  }
  return out + text.slice(at);
}

/** Text with its secrets hidden and its internal records removed, everything else kept. */
export function hideSecrets(text: string): string {
  return apply(text, spans(text).spans);
}

/** Answer text, whole: what the person may read of everything the model wrote. */
export function answerText(value: unknown): string {
  return typeof value === 'string' ? hideSecrets(value) : '';
}

/**
 * How far an answer still streaming may be shown (`shown`), and the last line
 * start before that point where filtering may begin afresh (`restart`, 0 when
 * there is none): nothing hidden and no record runs across it, so the text
 * before it (`settled`) filters the same whatever follows. A restart inside a
 * code block carries the block's opening line (`context`) so the rest is still
 * read as code.
 */
function streamCut(value: string): {
  shown: string;
  restart: number;
  settled: string;
  context: string;
} {
  const found = spans(value);
  let cut = value.length;
  while (cut > 0 && !SPACE.test(value[cut - 1] ?? '')) cut--;
  cut = Math.min(cut, found.open);
  for (let index = found.spans.length - 1; index >= 0; index--) {
    const span = found.spans[index];
    if (span && span.start < cut && (span.end > cut || span.end >= value.length)) cut = span.start;
  }
  const shown = apply(
    value.slice(0, cut),
    found.spans.filter((span) => span.end <= cut),
  );
  for (let at = cut; at > 0; at--) {
    if (!lineStart(value, at)) continue;
    if (found.spans.some((span) => span.start < at && at < span.end)) continue;
    // A block still open runs to the end of the text, the end included.
    const fence = found.fenced.find(([from, to]) => from < at && at <= to);
    let context = '';
    if (fence) {
      const close = value.indexOf('\n', fence[0]);
      context = value.slice(fence[0], close + 1);
      if (found.spans.some((span) => span.start < close + 1 && fence[0] < span.end)) continue;
    }
    return {
      shown,
      restart: at,
      settled: apply(
        value.slice(0, at),
        found.spans.filter((span) => span.end <= at),
      ),
      context,
    };
  }
  return { shown, restart: 0, settled: '', context: '' };
}

/**
 * The part of an answer still streaming that may be shown now: everything up
 * to the last word, which may still be growing into a key, and up to any
 * secret or record that may still be arriving. It only ever grows as text is
 * added, and once the answer is whole `answerText` adds the rest.
 */
export function answerStream(value: string): string {
  return streamCut(value).shown;
}

/**
 * One stream of text cut into pieces: each piece shows what has become safe to
 * show, and `end` shows the rest. Joined, the pieces equal `answerText` of the
 * whole text. Lines already settled are not read again, so a long answer costs
 * about as much as its lines.
 */
export class AnswerStream {
  /** What the settled text reads as. */
  private settled = '';
  /** Raw text not yet settled, after `context` (a code block's opening line, when inside one). */
  private open = '';
  private context = '';
  private shown = '';
  constructor(raw = '') {
    if (raw) this.push(raw);
  }
  push(text: string): string {
    this.open += text;
    const cut = streamCut(this.open);
    // The context reads as itself, since nothing in it is hidden.
    const next = this.settled + cut.shown.slice(this.context.length);
    const piece = next.startsWith(this.shown) ? next.slice(this.shown.length) : '';
    if (piece) this.shown = next;
    if (cut.restart > this.context.length) {
      this.settled += cut.settled.slice(this.context.length);
      this.open = cut.context + this.open.slice(cut.restart);
      this.context = cut.context;
    }
    return piece;
  }
  end(): string {
    const whole = this.settled + hideSecrets(this.open).slice(this.context.length);
    const piece = whole.startsWith(this.shown) ? whole.slice(this.shown.length) : '';
    this.settled = '';
    this.open = '';
    this.context = '';
    this.shown = '';
    return piece;
  }
}
