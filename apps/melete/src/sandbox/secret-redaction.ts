/**
 * Keeps a sealed secret out of what a command in the agent's computer printed.
 *
 * A command given a secret has it in its environment, and anything it prints
 * may carry it. Every occurrence becomes `[redacted]` before the output is
 * hashed, previewed, stored or put on a receipt, so the value reaches neither
 * the conversation, the model, nor a row of the database.
 *
 * A background process is read in pieces: pages from a cursor, a wake's line,
 * the last line its helper reports. A value split across two pieces is still
 * found. A piece that may begin inside a value is read with the bytes before
 * it, one that may end inside one with the bytes after it, and the last bytes
 * of a running process that may begin a value wait for the next read, which
 * then holds it whole.
 */
import type { JsonValue } from '@melete/contracts';
import { ByteRedactor } from '../egress/redact.ts';
import type { ProcessComputer, ProcessFacts, ReadMeta } from './process-helper.ts';

const MARK = Buffer.from('[redacted]');
const EMPTY = Buffer.alloc(0);
/** The longest line the helper reports, in characters (`LINE_LIMIT` in deploy/sandbox/melete-proc). */
const HELPER_LINE_CHARS = 240;
/** How much of the end of the output the helper finds that line in (`Ring.last_line`). */
const HELPER_LINE_WINDOW = 4096;

/** The bytes with every occurrence of every value replaced. */
export function redactBytes(bytes: Uint8Array, values: readonly string[]): Uint8Array {
  if (!values.length || !bytes.byteLength) return bytes;
  const redactor = new ByteRedactor(values);
  return new Uint8Array(Buffer.concat([redactor.feed(bytes), redactor.end()]));
}

/**
 * The same for output that was cut off after `bytes`: its last bytes, when
 * they may be the start of a value, go too, so no part of one is left.
 */
export function redactCutBytes(bytes: Uint8Array, values: readonly string[]): Uint8Array {
  const redacted = redactBytes(bytes, values);
  const held = heldBack(Buffer.from(redacted), sealedBytes(values));
  return held ? redacted.subarray(0, redacted.byteLength - held) : redacted;
}

/** A body passed on as it arrives, with every occurrence replaced, across chunks too. */
export function redactStream(
  body: ReadableStream<Uint8Array>,
  values: readonly string[],
): ReadableStream<Uint8Array> {
  if (!values.length) return body;
  const redactor = new ByteRedactor(values);
  const pass = (bytes: Buffer, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (bytes.byteLength) controller.enqueue(new Uint8Array(bytes));
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => pass(redactor.feed(chunk), controller),
      flush: (controller) => pass(redactor.end(), controller),
    }),
  );
}

/** A receipt's detail, or any JSON, with every string in it redacted. */
export function redactJson<T extends JsonValue>(value: T, values: readonly string[]): T {
  if (!values.length) return value;
  const redactor = new ByteRedactor(values);
  const walk = (item: JsonValue): JsonValue => {
    if (typeof item === 'string') return redactor.text(item);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item).map(([key, inner]) => [redactor.text(key), walk(inner as JsonValue)]),
      );
    return item;
  };
  return walk(value) as T;
}

const sealedBytes = (values: readonly string[]): Buffer[] =>
  [...new Set(values.filter((value) => value.length > 0))].map((value) =>
    Buffer.from(value, 'utf8'),
  );

/** Where in `bytes` a value occurs, every occurrence, overlapping ones joined. */
function spans(bytes: Buffer, secrets: readonly Buffer[]): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  for (const secret of secrets)
    for (let at = bytes.indexOf(secret); at >= 0; at = bytes.indexOf(secret, at + 1))
      found.push([at, at + secret.length]);
  return joinSpans(found);
}

function joinSpans(found: Array<[number, number]>): Array<[number, number]> {
  found.sort((a, b) => a[0] - b[0]);
  const joined: Array<[number, number]> = [];
  for (const [start, end] of found) {
    const last = joined[joined.length - 1];
    if (last && start < last[1]) last[1] = Math.max(last[1], end);
    else joined.push([start, end]);
  }
  return joined;
}

/** `bytes[from, to)`, with each part a span covers replaced by one mark. */
function masked(bytes: Buffer, from: number, to: number, covered: Array<[number, number]>) {
  const parts: Buffer[] = [];
  let at = from;
  for (const [start, end] of covered) {
    if (end <= from || start >= to) continue;
    parts.push(bytes.subarray(at, Math.max(at, start)), MARK);
    at = Math.min(to, end);
  }
  parts.push(bytes.subarray(at, to));
  return Buffer.concat(parts);
}

/**
 * How many of the first bytes of `data` may lie inside a value that began
 * before it: they are a value's end, or all of `data` is within one. Zero
 * when it cannot begin inside one.
 */
function leadingInside(data: Buffer, secrets: readonly Buffer[]): number {
  let inside = 0;
  for (const secret of secrets)
    for (let skip = 1; skip < secret.length; skip++) {
      const length = Math.min(secret.length - skip, data.length);
      if (length > inside && secret.compare(data, 0, length, skip, skip + length) === 0)
        inside = length;
    }
  return inside;
}

/** The same at the end: how many last bytes may lie inside a value that goes on after it. */
function trailingInside(data: Buffer, secrets: readonly Buffer[]): number {
  let inside = 0;
  for (const secret of secrets)
    for (let upTo = 1; upTo < secret.length; upTo++) {
      const length = Math.min(upTo, data.length);
      if (
        length > inside &&
        secret.compare(data, data.length - length, data.length, upTo - length, upTo) === 0
      )
        inside = length;
    }
  return inside;
}

/** How many of the last bytes of `data` are the start of a value, at most. */
function heldBack(data: Buffer, secrets: readonly Buffer[]): number {
  let held = 0;
  for (const secret of secrets)
    for (let length = Math.min(secret.length - 1, data.length); length > held; length--)
      if (secret.compare(data, data.length - length, data.length, 0, length) === 0) {
        held = length;
        break;
      }
  return held;
}

/**
 * The last line a process reports, redacted. The helper cuts it twice before
 * the service sees it: at the start of the window it reads it from, and at
 * its length limit. A line it cut short loses what may be a value's start at
 * its end; a line that may have begun before the window, which only a line at
 * least as long as the limit can be, loses what may be a value's end at its
 * start, as output cut at the capture limit does.
 */
function sealedLine(process: ProcessFacts, line: string, secrets: readonly Buffer[]): string {
  const redacted = new ByteRedactor(secrets.map((secret) => secret.toString('utf8'))).text(line);
  if ([...line].length < HELPER_LINE_CHARS) return redacted;
  let bytes = Buffer.from(redacted, 'utf8');
  bytes = bytes.subarray(0, bytes.length - heldBack(bytes, secrets));
  if (Math.max(process.oldest, process.cursor - HELPER_LINE_WINDOW) > 0)
    bytes = bytes.subarray(leadingInside(bytes, secrets));
  return bytes.toString('utf8');
}

type Piece = { from: number; data: Uint8Array };

/**
 * One piece of a process's output, `[read.from, read.next)`, redacted with
 * what lies around it. Says the bytes to show and where the next read starts.
 */
async function sealedPiece(
  secrets: readonly Buffer[],
  read: ReadMeta,
  data: Uint8Array,
  live: boolean,
  around: (cursor: number, maxBytes: number) => Promise<Piece>,
): Promise<{ data: Uint8Array; next: number }> {
  const raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const keep = Math.max(0, ...secrets.map((secret) => secret.length - 1));
  let before = EMPTY;
  // The ring forgot bytes before this piece that a value in it may have begun with.
  let forgotten = false;
  if (keep > 0 && read.from > 0 && leadingInside(raw, secrets)) {
    const start = Math.max(0, read.from - keep);
    const got = await around(start, read.from - start);
    // Only bytes that run up to this piece are of use.
    if (got.from < read.from && got.from + got.data.byteLength >= read.from)
      before = Buffer.from(got.data.subarray(0, read.from - got.from));
    forgotten = got.from > start;
  }
  let after = EMPTY;
  let unread = false;
  if (keep > 0 && read.next < read.total && trailingInside(raw, secrets)) {
    const got = await around(read.next, keep);
    if (got.from === read.next) after = Buffer.from(got.data);
    else unread = true;
  }
  const joined = Buffer.concat([before, raw, after]);
  const begin = before.length;
  const found = spans(joined, secrets);
  // What cannot be told apart from part of a value, for want of the bytes beside it, is masked.
  if (forgotten) found.push([begin, Math.max(begin, leadingInside(joined, secrets))]);
  if (unread) found.push([begin + raw.length - trailingInside(raw, secrets), begin + raw.length]);
  const covered = joinSpans(found.filter(([start, stop]) => stop > start));
  let end = begin + raw.length;
  if (live && read.next + after.length >= read.total) {
    // What a running process printed last, from the end of the last value
    // found, may be a value it is still printing: it waits.
    const clear = covered.reduce((at, [, stop]) => Math.max(at, stop), 0);
    const held = heldBack(joined.subarray(Math.min(clear, joined.length)), secrets);
    end = Math.max(begin, Math.min(end, joined.length - held));
  }
  return {
    data: new Uint8Array(masked(joined, begin, end, covered)),
    next: read.next - (begin + raw.length - end),
  };
}

const running = (facts: ProcessFacts) => facts.state === 'starting' || facts.state === 'running';

/**
 * A process computer whose every answer has the space's sealed values kept
 * out: the output a start, a read or a wait gets, and the last line each
 * process reports. The values are read once, at the first answer.
 */
export function sealedComputer(
  computer: ProcessComputer,
  values: () => Promise<readonly string[]>,
): ProcessComputer {
  let loaded: Promise<Buffer[]> | null = null;
  const secrets = () => {
    loaded ??= values().then(sealedBytes);
    return loaded;
  };
  const facts = (process: ProcessFacts, sealed: readonly Buffer[]): ProcessFacts =>
    sealed.length && process.last_line
      ? { ...process, last_line: sealedLine(process, process.last_line, sealed) || null }
      : process;
  const around = (id: string, abort: AbortSignal) => async (cursor: number, maxBytes: number) => {
    const answer = await computer.read(id, cursor, maxBytes, 0, abort);
    return { from: answer.read.from, data: answer.data };
  };
  return {
    async start(request, abort) {
      const answer = await computer.start(request, abort);
      const sealed = await secrets();
      if (answer.outcome !== 'started' || !sealed.length) return answer;
      const piece = await sealedPiece(
        sealed,
        answer.read,
        answer.data,
        running(answer.process),
        around(request.id, abort),
      );
      return {
        ...answer,
        process: facts(answer.process, sealed),
        read: { ...answer.read, next: piece.next },
        data: piece.data,
      };
    },
    async status(ids, abort) {
      const answer = await computer.status(ids, abort);
      const sealed = await secrets();
      if (!sealed.length) return answer;
      return { ...answer, processes: answer.processes.map((each) => facts(each, sealed)) };
    },
    async read(id, cursor, maxBytes, waitMs, abort) {
      const answer = await computer.read(id, cursor, maxBytes, waitMs, abort);
      const sealed = await secrets();
      if (!sealed.length) return answer;
      const piece = await sealedPiece(
        sealed,
        answer.read,
        answer.data,
        running(answer.process),
        around(id, abort),
      );
      return {
        ...answer,
        process: facts(answer.process, sealed),
        read: { ...answer.read, next: piece.next },
        data: piece.data,
      };
    },
    write: (id, bytes, abort) => computer.write(id, bytes, abort),
    async signal(id, name, abort) {
      const answer = await computer.signal(id, name, abort);
      return { ...answer, process: facts(answer.process, await secrets()) };
    },
    async stop(id, graceMs, abort) {
      const answer = await computer.stop(id, graceMs, abort);
      return { ...answer, process: facts(answer.process, await secrets()) };
    },
  };
}
