/**
 * One case file, start to finish.
 *
 * The cheap refusals — no paste, too much paste, out of turns for today, the
 * page out of budget — answer straight away with their own status code. Once
 * the work is actually going to happen the reply becomes a stream of lines,
 * one per stage, written at the moment that stage begins. That is the only
 * honest way to show progress for something that takes a minute, and it keeps
 * bytes moving so the connection is never dropped out from under a person who
 * is waiting.
 *
 * Nothing pasted is written down. There is no database and no store; the log
 * line carries how many characters arrived, how long it took and how it ended,
 * and never a word of what was in it.
 */
import type { Limiter } from './limiter.ts';
import type { Limits } from './limits.ts';
import { checkInput } from './limits.ts';
import type { CaseFileProvider } from './provider.ts';
import { ProviderError } from './provider.ts';
import type { CaseFile } from './schema.ts';
import { gate, parseDraft } from './validate.ts';

export type Outcome =
  | 'ok'
  | 'bad_request'
  | 'empty_input'
  | 'too_long'
  | 'rate_limited'
  | 'busy'
  | 'timeout'
  | 'upstream'
  | 'refused'
  | 'malformed';

/** What a run is worth recording. Sizes, timings and an outcome. Never content. */
export type LogLine = {
  event: 'case_file';
  outcome: Outcome;
  chars: number;
  ms: number;
  provider: string;
  searches: number;
  quotesDropped: number;
  urlsDropped: number;
};

export type Deps = {
  provider: CaseFileProvider;
  limiter: Limiter;
  limits: Limits;
  now?: () => number;
  log?: (line: LogLine) => void;
  /** Mixed into the counter's key, so an address cannot be searched for. */
  salt?: string;
  /** Sent between stages so a long wait keeps the connection warm. */
  heartbeatMs?: number;
};

/** What the page is told, for every ending. Plain, and never someone else's fault. */
export const WORDS: Record<Exclude<Outcome, 'ok'>, string> = {
  bad_request: 'Something went wrong sending that. Try again.',
  empty_input: 'Paste a bit more and it will have something to work from.',
  too_long: 'That is longer than one email. Paste the part that matters and try again.',
  rate_limited: 'That is all the case files for today on this connection. Come back tomorrow.',
  busy: 'A lot of people are trying this right now. Give it an hour and come back.',
  timeout: 'This one took longer than it should have.',
  upstream: 'The model is not answering right now. Try again in a minute.',
  refused: 'It would not take this one on. Try a different email.',
  malformed: 'That came back in a shape it could not use. Try again.',
};

export type Stage =
  | { stage: 'reading' }
  | { stage: 'model'; provider: string }
  | { stage: 'waiting'; ms: number }
  | { stage: 'checking'; searches: number };

export type Done =
  | {
      ok: true;
      caseFile: CaseFile;
      meta: { ms: number; searches: number; quotesDropped: number; urlsDropped: number };
    }
  | { ok: false; code: Exclude<Outcome, 'ok'>; message: string };

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const refuse = (code: Exclude<Outcome, 'ok'>, status: number): Response =>
  json({ ok: false, code, message: WORDS[code] } satisfies Done, status);

/**
 * Read a request body only as far as it is allowed to be, and give up the
 * moment it is over. Nothing here trusts what the request said about its own
 * size: the budget holds on the bytes that actually turn up, so a body sent
 * with no length, or a lying one, costs a few kilobytes rather than however
 * much someone cares to send.
 *
 * Null means it was too big. The rest of the body is never read.
 */
export async function readWithin(
  body: ReadableStream<Uint8Array> | null,
  budget: number,
): Promise<string | null> {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let seen = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      seen += value.byteLength;
      if (seen > budget) return null;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}

/**
 * What the counter is told instead of an address.
 *
 * It has to tell one visitor from another for a day, and it does not have to
 * know who they are. The day goes into the digest, so the same person is a
 * different value tomorrow and nothing in storage can be lined up against
 * yesterday. An address is a small space to search, so this alone obscures
 * rather than conceals: set `TRYIT_COUNTER_SALT` and it becomes one-way in
 * earnest. Nothing reads the value back — it is only ever compared.
 */
export async function counterKey(ip: string, day: string, salt = ''): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}:${day}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Cloudflare puts the caller's address here. The rest are fallbacks for local runs. */
export function clientIp(request: Request): string {
  const direct = request.headers.get('cf-connecting-ip');
  if (direct) return direct;
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first && first !== '' ? first : 'unknown';
}

/**
 * The part of an address that stands for one visitor.
 *
 * An IPv6 connection is handed a /64 at the least, and every address in it
 * belongs to whoever holds it, so counting each one separately would give
 * them a fresh allowance per address. An IPv6 address is therefore cut to its
 * /64, and one that only carries an IPv4 address (`::ffff:a.b.c.d`) is that
 * IPv4 address. Anything that does not parse is kept as it came.
 *
 * An IPv6 visitor also gets the /48 around them as `block`, which is counted
 * too: a household handed a /56 or a /48 holds hundreds of /64s or more.
 */
export function visitorOf(address: string): { key: string; block?: string } {
  const bare = address
    .trim()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/%.*$/, '')
    .toLowerCase();
  if (!bare.includes(':')) return { key: bare };
  const groups = hextets(bare);
  if (groups === null) return { key: bare };
  const [, , , , , , high = 0, low = 0] = groups;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return { key: [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.') };
  }
  const prefix = (count: number) =>
    groups
      .slice(0, count)
      .map((group) => group.toString(16))
      .join(':');
  return { key: `${prefix(4)}::/64`, block: `${prefix(3)}::/48` };
}

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function hextets(address: string): number[] | null {
  let text = address;
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.slice(1).map(Number);
    if ([a, b, c, d].some((byte) => byte > 255)) return null;
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const split = (part: string | undefined) => (part ? part.split(':') : []);
  const head = split(halves[0]);
  const tail = split(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

const today = (now: number): string => new Date(now).toISOString().slice(0, 10);

export async function caseFileRoute(request: Request, deps: Deps): Promise<Response> {
  const now = deps.now ?? Date.now;
  const started = now();
  const limits = deps.limits;
  const record = (line: Omit<LogLine, 'event' | 'ms' | 'provider'>) =>
    deps.log?.({ event: 'case_file', ms: now() - started, provider: deps.provider.name, ...line });

  const bare = { chars: 0, searches: 0, quotesDropped: 0, urlsDropped: 0 };

  if (request.method !== 'POST') {
    record({ ...bare, outcome: 'bad_request' });
    return refuse('bad_request', 405);
  }

  // A browser will send `text/plain` to another origin without asking first,
  // so accepting it would let any site spend a visitor's turns, and the day's
  // budget, from inside their browser with nothing on screen. Insisting on
  // JSON forces a preflight, and this Worker answers none.
  if (!(request.headers.get('content-type') ?? '').includes('application/json')) {
    record({ ...bare, outcome: 'bad_request' });
    return refuse('bad_request', 415);
  }

  // The declared length is the cheap check. It is also the one an attacker
  // omits, so it decides nothing on its own: a body with no length, or a
  // nonsense one, falls through to the budget below and is stopped there.
  const budget = limits.maxInputChars * 4 + 2048;
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > budget) {
    record({ ...bare, outcome: 'too_long' });
    return refuse('too_long', 413);
  }

  const raw = await readWithin(request.body, budget);
  if (raw === null) {
    record({ ...bare, outcome: 'too_long' });
    return refuse('too_long', 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    record({ ...bare, outcome: 'bad_request' });
    return refuse('bad_request', 400);
  }

  const pasted = (body as { text?: unknown } | null)?.text;
  const checked = checkInput(pasted, limits);
  if (!checked.ok) {
    record({
      ...bare,
      chars: typeof pasted === 'string' ? pasted.length : 0,
      outcome: checked.code,
    });
    return refuse(checked.code, checked.code === 'too_long' ? 413 : 400);
  }
  const chars = checked.text.length;

  // The address is turned into a key here and goes no further, so neither the
  // counter nor its storage ever sees one.
  const visitor = visitorOf(clientIp(request));
  const ip = await counterKey(visitor.key, today(started), deps.salt ?? '');
  const block =
    visitor.block === undefined
      ? undefined
      : await counterKey(visitor.block, today(started), deps.salt ?? '');
  const turn = await deps.limiter.take(ip, block);
  if (!turn.allowed) {
    const outcome = turn.reason === 'ip' ? 'rate_limited' : 'busy';
    record({ ...bare, chars, outcome });
    return refuse(outcome, turn.reason === 'ip' ? 429 : 503);
  }

  return stream(async (send) => {
    await send({ stage: 'reading' });
    await send({ stage: 'model', provider: deps.provider.name });

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), limits.requestTimeoutMs);
    const beat = deps.heartbeatMs
      ? setInterval(() => void send({ stage: 'waiting', ms: now() - started }), deps.heartbeatMs)
      : null;

    try {
      const result = await deps.provider.run({
        pasted: checked.text,
        today: today(started),
        signal: controller.signal,
      });
      await send({ stage: 'checking', searches: result.searches });

      const draft = parseDraft(result.json);
      if (!draft) {
        // The model answered, so the call was paid for. The turn is spent even
        // though there is nothing to show for it.
        record({ ...bare, chars, outcome: 'malformed' });
        return { ok: false, code: 'malformed', message: WORDS.malformed };
      }

      const { file, counts } = gate(draft, checked.text, result.sources);
      record({
        chars,
        outcome: 'ok',
        searches: result.searches,
        quotesDropped: counts.quotesDropped,
        urlsDropped: counts.urlsDropped,
      });
      return {
        ok: true,
        caseFile: file,
        meta: {
          ms: now() - started,
          searches: result.searches,
          quotesDropped: counts.quotesDropped,
          urlsDropped: counts.urlsDropped,
        },
      };
    } catch (error) {
      const code = failureOf(error, controller.signal);
      // A turn goes back only when the failure proves the model was never paid
      // for. Anything else — a refusal, a reply that stopped early, a request
      // given up on after it was sent — has already cost tokens, and refunding
      // it would let anyone who can provoke one have the key for nothing.
      if (!wasBilled(error)) await deps.limiter.giveBack(ip, block);
      record({ ...bare, chars, outcome: code });
      return { ok: false, code, message: WORDS[code] };
    } finally {
      clearTimeout(deadline);
      if (beat) clearInterval(beat);
    }
  });
}

/**
 * Only a provider that says so proves nothing was paid for. A failure from
 * anywhere else is unexplained, and an unexplained failure is assumed to have
 * cost something.
 */
const wasBilled = (error: unknown): boolean =>
  error instanceof ProviderError ? error.billed : true;

const failureOf = (error: unknown, signal: AbortSignal): Exclude<Outcome, 'ok'> => {
  if (signal.aborted) return 'timeout';
  if (error instanceof ProviderError) return error.code;
  return 'upstream';
};

/**
 * One JSON object per line: the stages as they happen, then exactly one
 * closing object carrying the case file or the reason there is not one.
 */
function stream(run: (send: (stage: Stage) => Promise<void>) => Promise<Done>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const write = (value: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        } catch {
          open = false; // the person closed the tab; there is nobody to tell
        }
      };
      let done: Done;
      try {
        done = await run(async (stage) => write(stage));
      } catch {
        done = { ok: false, code: 'upstream', message: WORDS.upstream };
      }
      write(done);
      open = false;
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/** Read a whole stream back into its stages and its ending. For tests and for the page. */
export async function readStream(
  response: Response,
): Promise<{ stages: Stage[]; done: Done | null }> {
  const text = await response.text();
  const stages: Stage[] = [];
  let done: Done | null = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const value = JSON.parse(line) as Stage | Done;
    if ('ok' in value) done = value;
    else stages.push(value);
  }
  return { stages, done };
}
