/**
 * The host side of the MCP Apps messages, for a page a connection shows in a
 * conversation.
 *
 * The page runs in a frame with an opaque origin and speaks JSON-RPC 2.0 over
 * `postMessage`. Melete answers a small part of the MCP Apps protocol:
 *
 * - `ui/initialize`: answered with the host's context (theme, inline display);
 *   when the theme changes later, the page gets
 *   `ui/notifications/host-context-changed`;
 * - `ui/notifications/initialized`: Melete then sends the tool call's input
 *   (`ui/notifications/tool-input`) and result (`ui/notifications/tool-result`);
 * - `ui/notifications/size-changed`: the frame takes the page's height;
 * - `ui/open-link`: a page on an origin its connection allows, opened in a new
 *   tab once the person agrees. Anything else is refused.
 *
 * Every other request is answered "method not found": a page cannot call
 * tools, post messages into the conversation or change what the model reads.
 * Nothing a page says settles it either; only its connection's server can,
 * with a signed report. A message counts only when it comes from the frame's
 * own window with the origin `null`, which is what a sandboxed page has.
 */

export const MCP_APPS_PROTOCOL = '2026-01-26';
export const MIN_PAGE_HEIGHT = 120;
export const MAX_PAGE_HEIGHT = 4_000;
const MAX_URL_LENGTH = 2048;

type Id = string | number;

export type PageRequest =
  | { kind: 'initialize'; id: Id }
  | { kind: 'initialized' }
  | { kind: 'size'; height: number }
  | { kind: 'open-link'; id: Id; url: string }
  | { kind: 'unsupported'; id: Id }
  | { kind: 'ignored' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validId = (value: unknown): value is Id =>
  (typeof value === 'string' && value.length > 0 && value.length <= 64) ||
  (typeof value === 'number' && Number.isSafeInteger(value));

/** One JSON-RPC message from a page, read field by field. */
export function readPageMessage(data: unknown): PageRequest {
  if (!isRecord(data) || data.jsonrpc !== '2.0' || typeof data.method !== 'string')
    return { kind: 'ignored' };
  const params = isRecord(data.params) ? data.params : {};
  const id = validId(data.id) ? data.id : null;
  switch (data.method) {
    case 'ui/initialize':
      return id === null ? { kind: 'ignored' } : { kind: 'initialize', id };
    case 'ui/notifications/initialized':
      return { kind: 'initialized' };
    case 'ui/notifications/size-changed':
      return typeof params.height === 'number' && Number.isFinite(params.height)
        ? {
            kind: 'size',
            height: Math.round(Math.min(MAX_PAGE_HEIGHT, Math.max(MIN_PAGE_HEIGHT, params.height))),
          }
        : { kind: 'ignored' };
    case 'ui/open-link':
      if (id === null) return { kind: 'ignored' };
      return typeof params.url === 'string'
        ? { kind: 'open-link', id, url: params.url }
        : { kind: 'unsupported', id };
    default:
      // A notification Melete does not handle is dropped; a request is told no.
      return id === null ? { kind: 'ignored' } : { kind: 'unsupported', id };
  }
}

/** The address to open, when it is on one of the allowed origins; null otherwise. */
export function allowedLink(value: string, origins: readonly string[]): string | null {
  if (value.length > MAX_URL_LENGTH || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.username || url.password) return null;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return origins.includes(url.origin) ? url.toString() : null;
}

export type PageHost = {
  theme: () => 'light' | 'dark';
  /** Calls back when the theme may have changed; returns the way to stop. */
  watchTheme?: (changed: () => void) => () => void;
  toolInput: Record<string, unknown>;
  toolResult: Record<string, unknown>;
  /** Origins the page may ask to open. */
  openOrigins: readonly string[];
  resize: (height: number) => void;
  /** Ask the person; resolves true when they opened it. */
  confirmLink: (url: string) => Promise<boolean>;
};

/**
 * Listen for one frame's messages. The frame is read at each message, so a
 * frame that reloads keeps its bridge. Returns the way to stop.
 */
export function connectPageBridge(
  frame: () => HTMLIFrameElement | null,
  host: PageHost,
  target: Window = window,
): () => void {
  let confirming = false;
  // The theme the page was last told, once it has been initialised.
  let told: 'light' | 'dark' | null = null;
  const unwatch = host.watchTheme?.(() => {
    const theme = host.theme();
    const source = frame()?.contentWindow;
    if (told === null || theme === told || !source) return;
    told = theme;
    source.postMessage(
      { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme } },
      '*',
    );
  });
  const onMessage = (event: MessageEvent) => {
    const source = frame()?.contentWindow ?? null;
    if (source === null || event.source !== source || event.origin !== 'null') return;
    const send = (message: Record<string, unknown>) => {
      if (frame()?.contentWindow === source)
        source.postMessage({ jsonrpc: '2.0', ...message }, '*');
    };
    const request = readPageMessage(event.data);
    switch (request.kind) {
      case 'initialize':
        told = host.theme();
        send({
          id: request.id,
          result: {
            protocolVersion: MCP_APPS_PROTOCOL,
            hostInfo: { name: 'Melete', version: '1' },
            hostCapabilities: { openLinks: {} },
            hostContext: {
              theme: told,
              displayMode: 'inline',
              availableDisplayModes: ['inline'],
            },
          },
        });
        return;
      case 'initialized':
        send({ method: 'ui/notifications/tool-input', params: { arguments: host.toolInput } });
        send({ method: 'ui/notifications/tool-result', params: host.toolResult });
        return;
      case 'size':
        host.resize(request.height);
        return;
      case 'open-link': {
        const url = allowedLink(request.url, host.openOrigins);
        if (!url || confirming) {
          send({
            id: request.id,
            error: {
              code: -32602,
              message: url ? 'Already asking.' : 'Not an address this page may open.',
            },
          });
          return;
        }
        // One question at a time: a page cannot stack prompts on the person.
        confirming = true;
        void host
          .confirmLink(url)
          .then((opened) =>
            send(
              opened
                ? { id: request.id, result: {} }
                : {
                    id: request.id,
                    error: { code: -32000, message: 'The person did not open it.' },
                  },
            ),
          )
          .finally(() => {
            confirming = false;
          });
        return;
      }
      case 'unsupported':
        send({ id: request.id, error: { code: -32601, message: 'Method not found' } });
        return;
      case 'ignored':
        return;
    }
  };
  target.addEventListener('message', onMessage);
  return () => {
    target.removeEventListener('message', onMessage);
    unwatch?.();
  };
}
