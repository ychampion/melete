/**
 * What the Daytona adapter's fixture and live tests share: where fixtures live,
 * what they say about their origin, a replay that keeps each answer's recorded
 * latency, and a transport control that loses the acknowledgement of a command
 * the way a dropped connection does.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type FixtureFile, ReplayFetch } from './fixtures.ts';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const DAYTONA_FIXTURE_DIR = fileURLToPath(new URL('./fixtures/daytona/', import.meta.url));

export const fixturePath = (name: string) =>
  `${DAYTONA_FIXTURE_DIR}${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}.json`;

export const DAYTONA_FIXTURE_API = {
  control:
    'Daytona REST API, libs/api-client-go/api/openapi.yaml, daytonaio/daytona v0.190.0 (01c502b)',
  toolbox:
    'Daytona toolbox API, libs/toolbox-api-client-go/api/openapi.yaml, daytonaio/daytona v0.190.0 (01c502b)',
  source:
    'apps/daemon/pkg/toolbox and apps/runner/pkg at v0.190.0, read for behaviour the specification leaves open',
};

export const AUTHORED_NOTE =
  'Authored from the published Daytona API and source before an account was available, not recorded from Daytona. ' +
  'Re-record with MELETE_SANDBOX_LIVE=daytona, DAYTONA_API_KEY and MELETE_SANDBOX_RECORD=1.';

export const RECORDED_NOTE = 'Recorded from Daytona by the live conformance run.';

/** How long after a command is sent its acknowledgement is cut. */
export const AFTER_START_CUT_MS = 1_000;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function bodyBytes(body: RequestInit['body']): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  throw new Error('fixtures replay only string and byte request bodies');
}

/**
 * Replay a fixture on its recorded timeline: each answer comes no sooner after
 * the first request than it came when recorded, and never sooner than its own
 * recorded latency. A command's duration is the time its polls take, so without
 * this a replay would run as fast as the replaying machine's timers allow, and
 * a timeout recorded at its deadline could come back before it.
 */
export async function latencyReplay(file: string) {
  const fixture = JSON.parse(await readFile(file, 'utf8')) as FixtureFile;
  const replay = new ReplayFetch(fixture);
  const used = fixture.exchanges.map(() => false);
  /** When the first request was made, here and in the recording. */
  let origin: { here: number; recorded: number } | null = null;
  const fetch: Fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const bodySha256 = sha256(bodyBytes(init.body));
    // The same choice the replay makes: the first unused exchange that matches.
    const index = fixture.exchanges.findIndex(
      (exchange, position) =>
        !used[position] &&
        exchange.request.method === method &&
        exchange.request.path === `${url.pathname}${url.search}` &&
        exchange.request.bodySha256 === bodySha256,
    );
    const response = await replay.fetch(input, init);
    if (index < 0) return response;
    used[index] = true;
    const { request, response: recorded } = fixture.exchanges[
      index
    ] as FixtureFile['exchanges'][number];
    origin ??= { here: performance.now(), recorded: request.atMs ?? 0 };
    const latency =
      request.atMs !== undefined && recorded.atMs !== undefined
        ? Math.max(
            recorded.atMs - request.atMs,
            origin.here + (recorded.atMs - origin.recorded) - performance.now(),
          )
        : 0;
    if (latency > 0)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, latency);
        init.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    return response;
  };
  return { fetch, assertConsumed: () => replay.assertConsumed() };
}

/**
 * Wrap a fetch so the next admitted command loses its answer: before the
 * request to run it in its session leaves, or a second after it was sent,
 * while the command runs on.
 */
export function acknowledgementControl(inner: Fetch) {
  let pending: 'before_start' | 'after_start' | null = null;
  const admitted = (url: URL, init: RequestInit) =>
    /\/process\/session\/[^/]+\/exec$/.test(url.pathname) &&
    typeof init.body === 'string' &&
    init.body.includes('melete-launch');
  const controlled: Fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (!pending || !admitted(url, init)) return inner(input, init);
    const loss = pending;
    pending = null;
    if (loss === 'before_start')
      throw new TypeError('fetch failed: the connection closed before any answer');
    // The request reaches the toolbox and the command runs; only its answer is lost.
    void inner(input, init).then(
      (response) => response.body?.cancel().catch(() => {}),
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, AFTER_START_CUT_MS));
    throw new TypeError('network connection lost');
  };
  return {
    fetch: controlled,
    lose(when: 'before_start' | 'after_start') {
      pending = when;
    },
  };
}
