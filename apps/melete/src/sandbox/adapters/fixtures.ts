/**
 * HTTP fixtures for sandbox adapters.
 *
 * `RecordingFetch` sits between an adapter and a provider and writes down each
 * exchange as the adapter consumed it: the request's method, path and body
 * hash, and the response's status and body chunks with their timing. It never
 * writes a request header that could authenticate (`X-API-Key`,
 * `Authorization`, any access token), it replaces access tokens in JSON
 * answers, and it refuses to save a fixture in which any known secret still
 * appears.
 *
 * `ReplayFetch` answers from a fixture. A request is matched on method, path
 * and body hash, and a request with no match fails the call and the test, so an
 * adapter cannot quietly start making a call its fixtures never saw. Chunks are
 * replayed at their recorded times, so a timeout in a fixture is a timeout.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONNECT_STREAM, decodeEnvelopes } from './connect.ts';

export type FixtureSource = 'authored-from-documented-api' | 'recorded';

export type FixtureExchange = {
  request: {
    /** When the request was made, on the recording's own clock. */
    atMs?: number;
    method: string;
    url: string;
    path: string;
    bodySha256: string;
    headers: Record<string, string>;
    body?: unknown;
  };
  response: {
    /** When the answer arrived, on the recording's own clock. */
    atMs?: number;
    status: number;
    headers: Record<string, string>;
    /** `atMs` counts from the answer's arrival. */
    chunks: { atMs: number; base64: string }[];
    end: 'complete' | 'cancelled' | 'error';
    body?: unknown;
  };
};

export type FixtureFile = {
  fixture: string;
  source: FixtureSource;
  note: string;
  api: Record<string, string>;
  exchanges: FixtureExchange[];
};

const REQUEST_HEADERS = [
  'content-type',
  'connect-protocol-version',
  'connect-timeout-ms',
  'keepalive-ping-interval',
  'e2b-sandbox-id',
  'e2b-sandbox-port',
];
const RESPONSE_HEADERS = ['content-type', 'x-next-token'];
const TOKEN_FIELDS = new Set(['envdAccessToken', 'trafficAccessToken']);
const NULL_BODY = new Set([101, 204, 205, 304]);

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pathOf = (url: URL) => `${url.pathname}${url.search}`;

function requestBytes(body: RequestInit['body']): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new Error('fixtures record only string and byte request bodies');
}

/** A readable view of a body for people reviewing a fixture; never used to match. */
function describe(contentType: string | null, bytes: Uint8Array): unknown {
  if (!contentType || bytes.byteLength === 0) return undefined;
  try {
    if (contentType.startsWith(CONNECT_STREAM))
      return decodeEnvelopes(bytes).map((item) =>
        item.end ? { end: item.message } : item.message,
      );
    if (contentType.startsWith('application/json'))
      return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  return { bytes: bytes.byteLength };
}

function redactTokens(value: unknown, found: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => redactTokens(item, found));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (TOKEN_FIELDS.has(key) && typeof item === 'string' && item) {
          found.add(item);
          return [key, 'redacted'];
        }
        return [key, redactTokens(item, found)];
      }),
    );
  }
  return value;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class RecordingFetch {
  private readonly exchanges: FixtureExchange[] = [];
  private readonly pending = new Set<Promise<void>>();
  private readonly learned = new Set<string>();
  private readonly origin = performance.now();

  constructor(
    private readonly inner: Fetch,
    private readonly options: {
      fixture: string;
      source: FixtureSource;
      note: string;
      api: Record<string, string>;
      secrets: readonly string[];
    },
  ) {}

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    if (input instanceof Request) throw new Error('fixtures record only URL requests');
    const url = new URL(String(input));
    const bytes = requestBytes(init.body);
    const headers = new Headers(init.headers);
    const exchange: FixtureExchange = {
      request: {
        atMs: Math.round(performance.now() - this.origin),
        method: (init.method ?? 'GET').toUpperCase(),
        url: `${url.origin}${url.pathname}`,
        path: pathOf(url),
        bodySha256: sha256(bytes),
        headers: Object.fromEntries(
          REQUEST_HEADERS.flatMap((name) => {
            const value = headers.get(name);
            return value === null ? [] : [[name, value]];
          }),
        ),
        body: describe(headers.get('content-type'), bytes),
      },
      response: { status: 0, headers: {}, chunks: [], end: 'complete' },
    };
    this.exchanges.push(exchange);
    const response = await this.inner(input, init);
    exchange.response.atMs = Math.round(performance.now() - this.origin);
    exchange.response.status = response.status;
    exchange.response.headers = Object.fromEntries(
      RESPONSE_HEADERS.flatMap((name) => {
        const value = response.headers.get(name);
        return value === null ? [] : [[name, value]];
      }),
    );
    const contentType = response.headers.get('content-type');
    if (!response.body) return response;
    if (contentType?.startsWith('application/json')) {
      // Whole JSON answers are small; they are read here so tokens can be replaced.
      const text = await response.text();
      const redacted = text ? JSON.stringify(redactTokens(JSON.parse(text), this.learned)) : '';
      const body = new TextEncoder().encode(redacted);
      exchange.response.chunks.push({ atMs: 0, base64: Buffer.from(body).toString('base64') });
      exchange.response.body = describe(contentType, body);
      return new Response(text, { status: response.status, headers: response.headers });
    }
    const started = performance.now();
    const reader = response.body.getReader();
    const collected: Uint8Array[] = [];
    let settle: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.pending.add(done);
    let finished = false;
    const finish = (end: FixtureExchange['response']['end']) => {
      if (finished) return;
      finished = true;
      exchange.response.end = end;
      const total = new Uint8Array(collected.reduce((sum, chunk) => sum + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of collected) {
        total.set(chunk, offset);
        offset += chunk.byteLength;
      }
      exchange.response.body = describe(contentType, total);
      this.pending.delete(done);
      settle();
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done: ended, value } = await reader.read();
          if (finished) return;
          if (ended) {
            finish('complete');
            controller.close();
            return;
          }
          collected.push(value);
          exchange.response.chunks.push({
            atMs: Math.round(performance.now() - started),
            base64: Buffer.from(value).toString('base64'),
          });
          controller.enqueue(value);
        } catch (error) {
          finish('error');
          controller.error(error);
        }
      },
      async cancel(reason) {
        finish('cancelled');
        await reader.cancel(reason);
      },
    });
    return new Response(NULL_BODY.has(response.status) ? null : body, {
      status: response.status,
      headers: response.headers,
    });
  };

  async save(file: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (this.pending.size && Date.now() < deadline) await Promise.race([...this.pending]);
    const fixture: FixtureFile = {
      fixture: this.options.fixture,
      source: this.options.source,
      note: this.options.note,
      api: this.options.api,
      exchanges: this.exchanges,
    };
    const text = `${JSON.stringify(fixture, null, 2)}\n`;
    for (const secret of [...this.options.secrets, ...this.learned]) {
      if (secret && text.includes(secret))
        throw new Error('a secret reached a fixture; nothing was written');
    }
    if (/"(x-api-key|authorization|x-access-token|e2b-traffic-access-token)"/i.test(text))
      throw new Error('an authenticating header reached a fixture; nothing was written');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

export class ReplayFetch {
  private readonly used: boolean[];
  private readonly failures: string[] = [];

  constructor(private readonly file: FixtureFile) {
    this.used = file.exchanges.map(() => false);
  }

  static async load(file: string): Promise<ReplayFetch> {
    return new ReplayFetch(JSON.parse(await readFile(file, 'utf8')) as FixtureFile);
  }

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    if (input instanceof Request) throw new Error('fixtures replay only URL requests');
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const bodySha256 = sha256(requestBytes(init.body));
    const index = this.file.exchanges.findIndex(
      (exchange, position) =>
        !this.used[position] &&
        exchange.request.method === method &&
        exchange.request.path === pathOf(url) &&
        exchange.request.bodySha256 === bodySha256,
    );
    if (index < 0) {
      const failure = `unmatched request: ${method} ${pathOf(url)} (body sha256 ${bodySha256})`;
      this.failures.push(failure);
      throw new Error(failure);
    }
    this.used[index] = true;
    init.signal?.throwIfAborted();
    const { response } = this.file.exchanges[index] as FixtureExchange;
    const signal = init.signal;
    let stopped = false;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const opened = performance.now();
        signal?.addEventListener(
          'abort',
          () => {
            stopped = true;
            try {
              controller.error(signal.reason ?? new DOMException('aborted', 'AbortError'));
            } catch {}
          },
          { once: true },
        );
        void (async () => {
          for (const chunk of response.chunks) {
            const wait = opened + chunk.atMs - performance.now();
            if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
            if (response.atMs !== undefined) await this.caughtUp(response.atMs + chunk.atMs);
            if (stopped) return;
            try {
              controller.enqueue(new Uint8Array(Buffer.from(chunk.base64, 'base64')));
            } catch {
              return;
            }
          }
          if (stopped) return;
          try {
            if (response.end === 'complete') controller.close();
            if (response.end === 'error')
              controller.error(new TypeError('the recorded connection failed here'));
            // A cancelled recording stays open until the reader cancels again.
          } catch {}
        })();
      },
      cancel() {
        stopped = true;
      },
    });
    return new Response(NULL_BODY.has(response.status) ? null : body, {
      status: response.status,
      headers: response.headers,
    });
  };

  /**
   * A recorded answer that arrived after some request was made is not replayed
   * before that request is made again: the order of cause and effect in the
   * recording holds, whatever the timers do. A request that never comes is
   * waited for briefly and then reported as unused.
   */
  private async caughtUp(atMs: number): Promise<void> {
    const deadline = performance.now() + 10_000;
    const earlier = this.file.exchanges
      .map((exchange, index) => ({ exchange, index }))
      .filter(
        ({ exchange }) => exchange.request.atMs !== undefined && exchange.request.atMs < atMs,
      );
    while (earlier.some(({ index }) => !this.used[index]) && performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 2));
  }

  /** Every recorded exchange was used and nothing unrecorded was asked for. */
  assertConsumed(): void {
    const unused = this.file.exchanges
      .map((exchange, index) =>
        this.used[index] ? null : `${exchange.request.method} ${exchange.request.path}`,
      )
      .filter((item): item is string => item !== null);
    if (this.failures.length || unused.length)
      throw new Error(
        `the fixture was not replayed exactly: ${[...this.failures, ...unused.map((item) => `unused: ${item}`)].join('; ')}`,
      );
  }
}
