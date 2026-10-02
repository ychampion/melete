/**
 * The bridge between a framed app and the Melete page around it.
 *
 * An app runs with an opaque origin and can reach nothing on its own: no
 * session, no API, no other site. What it may ask for, it asks this page by
 * `postMessage`, and the page answers with only what it fetched for this
 * viewer:
 *
 * - `{type:'melete.data', id, name}`: a data binding the publish approval listed;
 * - `{type:'melete.submit', id, collection, record}`: a response for a declared collection;
 * - `{type:'melete.link', url}`: open an https link, after the person confirms it;
 * - `{type:'melete.size', height}`: how tall the app would like its frame.
 *
 * A message counts only when it comes from the frame's own window with the
 * origin `null`, which is what a sandboxed page has. Replies go back to that
 * window with `{type:'melete.reply', id, ok, value | error}`. The window is
 * the frame's, whatever page it holds, so this rests on the frame holding
 * only the app's own pages: Melete's pages are served with `frame-src 'self'`,
 * and every page under the view path needs a token issued for this viewer.
 */

export const BINDING_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** The largest record one submission may carry, as the service stores it. */
export const MAX_RECORD_BYTES = 16 * 1024;
const MAX_URL_LENGTH = 2048;
export const MIN_HEIGHT = 160;
export const MAX_HEIGHT = 20_000;
/** Answers still owed to one frame; past this, new requests are dropped. */
const MAX_IN_FLIGHT = 16;

type Id = string | number;

export type BridgeRequest =
  | { type: 'melete.data'; id: Id; name: string }
  | { type: 'melete.submit'; id: Id; collection: string; record: Record<string, unknown> }
  | { type: 'melete.link'; url: string }
  | { type: 'melete.size'; height: number };

export type BridgeReply =
  | { type: 'melete.reply'; id: Id; ok: true; value: unknown }
  | { type: 'melete.reply'; id: Id; ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const validId = (value: unknown): value is Id =>
  (typeof value === 'string' && value.length > 0 && value.length <= 64) ||
  (typeof value === 'number' && Number.isSafeInteger(value));

/** An https address an app may ask to open, or null for anything else. */
export function linkTarget(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH || !URL.canParse(value))
    return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return url.toString();
}

/** A message from an app, checked field by field, or null when it is not one. */
export function parseRequest(data: unknown): BridgeRequest | null {
  if (!isRecord(data) || typeof data.type !== 'string') return null;
  switch (data.type) {
    case 'melete.data':
      return validId(data.id) && typeof data.name === 'string' && BINDING_NAME.test(data.name)
        ? { type: data.type, id: data.id, name: data.name }
        : null;
    case 'melete.submit': {
      if (
        !validId(data.id) ||
        typeof data.collection !== 'string' ||
        !BINDING_NAME.test(data.collection) ||
        !isRecord(data.record)
      )
        return null;
      let size: number;
      try {
        size = new TextEncoder().encode(JSON.stringify(data.record)).byteLength;
      } catch {
        return null;
      }
      return size <= MAX_RECORD_BYTES
        ? { type: data.type, id: data.id, collection: data.collection, record: data.record }
        : null;
    }
    case 'melete.link': {
      const url = linkTarget(data.url);
      return url ? { type: data.type, url } : null;
    }
    case 'melete.size':
      return typeof data.height === 'number' && Number.isFinite(data.height)
        ? {
            type: data.type,
            height: Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, data.height))),
          }
        : null;
    default:
      return null;
  }
}

/** What the page around the frame does for it. Each answer is for this viewer only. */
export type BridgeHost = {
  data: (name: string) => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;
  submit: (
    collection: string,
    record: Record<string, unknown>,
  ) => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;
  /** Ask the person; resolves true only when they choose to open it. */
  confirmLink: (url: string) => Promise<boolean>;
  resize: (height: number) => void;
};

/**
 * Listen for one frame's requests. The frame is read at each message, so a
 * frame that loads a new version keeps its bridge. Returns the way to stop.
 */
export function connectBridge(
  frame: () => HTMLIFrameElement | null,
  host: BridgeHost,
  target: Window = window,
): () => void {
  let inFlight = 0;
  let confirming = false;
  const onMessage = (event: MessageEvent) => {
    const source = frame()?.contentWindow ?? null;
    if (source === null || event.source !== source || event.origin !== 'null') return;
    const request = parseRequest(event.data);
    if (!request) return;
    const reply = (message: BridgeReply) => {
      // This catches a frame that was replaced (a new version mounts a new one),
      // not one that navigated: a frame's window stays the same object across
      // its own navigations. What keeps any page but the app's own out of the
      // frame is Melete's `frame-src 'self'` and the token in every view
      // address; the bridge relies on both.
      if (frame()?.contentWindow === source) source.postMessage(message, '*');
    };
    const answer = (
      id: Id,
      work: () => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>,
    ) => {
      if (inFlight >= MAX_IN_FLIGHT) {
        reply({ type: 'melete.reply', id, ok: false, error: 'Too many requests at once.' });
        return;
      }
      inFlight += 1;
      work()
        .catch(() => ({ ok: false as const, error: 'Couldn’t reach Melete.' }))
        .then((result) => {
          inFlight -= 1;
          reply(
            result.ok
              ? { type: 'melete.reply', id, ok: true, value: result.value }
              : { type: 'melete.reply', id, ok: false, error: result.error },
          );
        });
    };
    switch (request.type) {
      case 'melete.data':
        answer(request.id, () => host.data(request.name));
        return;
      case 'melete.submit':
        answer(request.id, () => host.submit(request.collection, request.record));
        return;
      case 'melete.size':
        host.resize(request.height);
        return;
      case 'melete.link':
        // One question at a time: an app cannot stack prompts on the person.
        if (confirming) return;
        confirming = true;
        void host
          .confirmLink(request.url)
          .then((open) => {
            if (open) window.open(request.url, '_blank', 'noopener,noreferrer');
          })
          .finally(() => {
            confirming = false;
          });
        return;
    }
  };
  target.addEventListener('message', onMessage);
  return () => target.removeEventListener('message', onMessage);
}
