/**
 * What the E2B adapter's fixture and live tests share: where fixtures live,
 * what they say about their origin, and a transport control that loses the
 * acknowledgement of a command the way a dropped connection does.
 */
import { fileURLToPath } from 'node:url';
import { MARKER_ROOT } from '../marker.ts';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const E2B_FIXTURE_DIR = fileURLToPath(new URL('./fixtures/e2b/', import.meta.url));

export const fixturePath = (name: string) =>
  `${E2B_FIXTURE_DIR}${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}.json`;

export const E2B_FIXTURE_API = {
  control: 'E2B REST API, spec/openapi.yml, e2b-dev/E2B at 3e5a48b',
  envd: 'envd process and filesystem Connect services and /files, spec/envd, e2b-dev/E2B at 3e5a48b',
  sdk: 'e2b 2.50.0 (JavaScript SDK), read for request shapes',
};

export const AUTHORED_NOTE =
  'Authored from the documented E2B API before an account was available, not recorded from E2B. ' +
  'Re-record with MELETE_SANDBOX_LIVE=e2b, E2B_API_KEY and MELETE_SANDBOX_RECORD=1.';

export const RECORDED_NOTE = 'Recorded from E2B by the live conformance run.';

/** How long after a command starts its acknowledgement is cut. */
export const AFTER_START_CUT_MS = 1_000;

/**
 * Wrap a fetch so the next marked command loses its answer: before anything
 * comes back, or once the command has started and before it ends.
 */
export function acknowledgementControl(inner: Fetch) {
  let pending: 'before_start' | 'after_start' | null = null;
  const marked = (url: URL, init: RequestInit) =>
    url.pathname === '/process.Process/Start' &&
    init.body instanceof Uint8Array &&
    new TextDecoder().decode(init.body.subarray(5)).includes(MARKER_ROOT);
  const controlled: Fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (!pending || !marked(url, init)) return inner(input, init);
    const loss = pending;
    pending = null;
    if (loss === 'before_start')
      throw new TypeError('fetch failed: the connection closed before any answer');
    const response = await inner(input, init);
    if (!response.body) return response;
    const reader = response.body.getReader();
    let cut: ReturnType<typeof setTimeout> | undefined;
    let severed = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (severed) return;
        if (done) {
          clearTimeout(cut);
          controller.close();
          return;
        }
        controller.enqueue(value);
        cut ??= setTimeout(() => {
          severed = true;
          controller.error(new TypeError('network connection lost'));
          void reader.cancel().catch(() => {});
        }, AFTER_START_CUT_MS);
      },
      cancel(reason) {
        clearTimeout(cut);
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  };
  return {
    fetch: controlled,
    lose(when: 'before_start' | 'after_start') {
      pending = when;
    },
  };
}
