/**
 * What the page remembers about its own recent trouble, so a problem report
 * can say more than the person saw: the last console errors and the last API
 * requests that failed. Both live only in memory, hold at most twenty entries,
 * and are redacted as they are recorded: no request or message body, cookie,
 * token or email is kept.
 */
import { redactText, redactUrl } from '@melete/contracts/redact';

export const RECENT_LIMIT = 20;

export type ConsoleEntry = { at: string; message: string };
export type FailedRequest = {
  at: string;
  method: string;
  url: string;
  status: number | null;
  code: string | null;
};

/** A fixed-size buffer that forgets the oldest entry first. */
export class Ring<T> {
  private items: T[] = [];
  constructor(private readonly size = RECENT_LIMIT) {}
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.size) this.items.splice(0, this.items.length - this.size);
  }
  list(): T[] {
    return [...this.items];
  }
  clear(): void {
    this.items = [];
  }
}

const consoleErrors = new Ring<ConsoleEntry>();
const failedRequests = new Ring<FailedRequest>();
let lastRoute = typeof window === 'undefined' ? '/' : window.location.hash || '#/';

const describe = (value: unknown): string => {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

export function recordConsoleError(parts: unknown[]): void {
  const message = redactText(parts.map(describe).join(' ').trim());
  if (message) consoleErrors.push({ at: new Date().toISOString(), message });
}

export function recordFailedRequest(entry: Omit<FailedRequest, 'at'>): void {
  failedRequests.push({
    at: new Date().toISOString(),
    method: entry.method.toUpperCase().slice(0, 10),
    url: redactUrl(entry.url),
    status: entry.status,
    code: entry.code ? redactText(entry.code, 80) : null,
  });
}

const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
const requestMethod = (input: RequestInfo | URL, init?: RequestInit): string =>
  init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');

/**
 * A fetch that behaves exactly like the one it wraps and notes the requests
 * that fail: an error status, with the service's error code when it gave one,
 * or no answer at all. Only the method, address, status and code are kept.
 */
export function recordingFetch(
  base: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = requestMethod(input, init);
    const url = requestUrl(input);
    let response: Response;
    try {
      response = await base(input, init);
    } catch (error) {
      // A request the page itself stopped did not fail.
      if (!(error instanceof Error && error.name === 'AbortError'))
        recordFailedRequest({ method, url, status: null, code: null });
      throw error;
    }
    if (response.status >= 400) {
      let code: string | null = null;
      if (response.headers.get('content-type')?.includes('application/json')) {
        const body = (await response
          .clone()
          .json()
          .catch(() => null)) as { error?: { code?: unknown } } | null;
        code = typeof body?.error?.code === 'string' ? body.error.code : null;
      }
      recordFailedRequest({ method, url, status: response.status, code });
    }
    return response;
  };
  return wrapped as typeof fetch;
}

let installed = false;

/** Start listening. Safe to call more than once. */
export function installDiagnostics(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const original = console.error.bind(console);
  console.error = (...parts: unknown[]) => {
    recordConsoleError(parts);
    original(...parts);
  };
  window.addEventListener('error', (event) => {
    recordConsoleError([event.error ?? event.message]);
  });
  window.addEventListener('unhandledrejection', (event) => {
    recordConsoleError(['Unhandled rejection:', event.reason]);
  });
  window.addEventListener('hashchange', (event) => {
    const previous = new URL(event.oldURL).hash || '#/';
    if (!previous.startsWith('#/feedback')) lastRoute = previous;
  });
}

/** The page the person was on, not the report form itself. */
export function currentRoute(): string {
  const hash = window.location.hash || '#/';
  return hash.startsWith('#/feedback') ? lastRoute : hash;
}

export type PageContext = {
  route: string;
  user_agent: string;
  language: string;
  time_zone: string;
  viewport: { width: number; height: number; pixel_ratio: number };
  color_scheme: 'light' | 'dark';
  console_errors: ConsoleEntry[];
  failed_requests: FailedRequest[];
};

/** Everything a report attaches when the person leaves "include details" on. */
export function pageContext(): PageContext {
  let timeZone = '';
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    // Left empty.
  }
  const dark =
    document.documentElement.dataset.theme === 'dark' ||
    (document.documentElement.dataset.theme !== 'light' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  return {
    route: redactUrl(currentRoute()),
    user_agent: navigator.userAgent.slice(0, 500),
    language: (navigator.language ?? '').slice(0, 35),
    time_zone: timeZone.slice(0, 64),
    viewport: {
      width: Math.round(window.innerWidth),
      height: Math.round(window.innerHeight),
      pixel_ratio: Math.round((window.devicePixelRatio || 1) * 100) / 100,
    },
    color_scheme: dark ? 'dark' : 'light',
    console_errors: consoleErrors.list(),
    failed_requests: failedRequests.list(),
  };
}

export const recentConsoleErrors = (): ConsoleEntry[] => consoleErrors.list();
export const recentFailedRequests = (): FailedRequest[] => failedRequests.list();

/** For tests. */
export function resetDiagnostics(): void {
  consoleErrors.clear();
  failedRequests.clear();
}
