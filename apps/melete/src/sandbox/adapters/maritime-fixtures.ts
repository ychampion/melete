/**
 * What the Maritime adapter's fixture and live tests share: where fixtures
 * live, what they say about their origin, and a transport control that loses
 * the acknowledgement of a command's launch the way a dropped connection does.
 * Replay keeps each answer's recorded latency, as the Daytona fixtures do.
 */
import { fileURLToPath } from 'node:url';

export { latencyReplay } from './daytona-fixtures.ts';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const MARITIME_FIXTURE_DIR = fileURLToPath(new URL('./fixtures/maritime/', import.meta.url));

export const fixturePath = (name: string) =>
  `${MARITIME_FIXTURE_DIR}${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}.json`;

export const MARITIME_FIXTURE_API = {
  control: 'Maritime computers API, https://api.maritime.sh/openapi.json (/api/v1/computers)',
  docs: 'https://maritime.sh/docs/computers, read 2026-10-18 for behaviour the schema leaves open',
};

export const AUTHORED_NOTE =
  'Authored from the published Maritime API before a live run, not recorded from Maritime. ' +
  'Re-record with MELETE_MARITIME_API_KEY and MELETE_SANDBOX_RECORD=1.';

export const RECORDED_NOTE = 'Recorded from Maritime by the live conformance run.';

/** How long after a launch is sent its acknowledgement is cut. */
export const AFTER_START_CUT_MS = 1_000;

/**
 * Wrap a fetch so the next admitted command loses its answer: before the
 * launch request leaves, or a second after it was sent, while the command
 * runs on.
 */
export function acknowledgementControl(inner: Fetch) {
  let pending: 'before_start' | 'after_start' | null = null;
  const admitted = (url: URL, init: RequestInit) =>
    url.pathname.endsWith('/exec') &&
    typeof init.body === 'string' &&
    init.body.includes('melete-launch');
  const controlled: Fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (!pending || !admitted(url, init)) return inner(input, init);
    const loss = pending;
    pending = null;
    if (loss === 'before_start')
      throw new TypeError('fetch failed: the connection closed before any answer');
    // The request reaches the computer and the command runs; only its answer is lost.
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
