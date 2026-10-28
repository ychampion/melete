import { createHash, createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { BrowserContext, Frame, Request, Route } from 'playwright';
import { isPublicAddress, type ResolvedAddress } from '../../connectors/web.ts';
import {
  hostOf,
  type LiveNetworkBudget,
  type LiveNotify,
  type LiveSiteScope,
  siteOf,
} from './live-protocol.ts';
import { downloadName } from './teach.ts';

export type BrowserNetworkPolicy = {
  public_compartment: boolean;
  allowed_domains: string[];
  /** Any public address, for a job with no domain list whose space reads the public web. */
  public_web?: boolean;
};

/**
 * `sign_in` is a saved sign-in being filled and sent: pages load as they do when
 * opened, and only the site the sign-in was saved for, the page's own origin
 * when it began, may be sent anything; a request that would send elsewhere is
 * held back, and a form that posts elsewhere ends it.
 */
export type BrowserNetworkMode = 'navigate' | 'reversible' | 'commit' | 'human' | 'sign_in';

/**
 * The most requests that change something one sign-in step may send to its own site. Past it,
 * what the page's script sends is held back and the step goes on; a page's own document ends it.
 */
export const SIGN_IN_MUTATIONS = 16;

/** How long a page asks for nothing before it is taken to have finished answering. */
export const SETTLE_QUIET_MS = 500;

/**
 * A secret shorter than this is looked for only as a whole part of what is sent. Sites are
 * expected to ask for at least 8 characters (NIST SP 800-63B's floor), so anything shorter is
 * a PIN or a word, and words and numbers that short sit inside a site's own addresses by chance:
 * `github` in github.com/login, `123456` in a cache-buster's timestamp. From 8 characters on, a
 * secret of mixed kinds of characters is found anywhere it appears.
 */
export const WHOLE_SECRET_BELOW = 8;

/** What splits text into parts when a secret is looked for whole: any field break of a form, JSON, multipart body or address. */
const PART_BREAKS = /[\s&=?#/;:,"'{}[\]<>()]+/;

/**
 * Whether a secret is looked for only as a whole part (an address's path segment, query or
 * fragment key or value, or a body's field): one that is short, or of letters alone or digits
 * alone, which an ordinary word or number holds. One that a part break would cut in two is
 * looked for anywhere, so the narrower match never misses it.
 */
function wholeOnly(secret: string): boolean {
  if (PART_BREAKS.test(secret)) return false;
  return secret.length < WHOLE_SECRET_BELOW || /^\d+$/.test(secret) || /^\p{L}+$/u.test(secret);
}

/**
 * Percent escapes decoded one UTF-8 character at a time, so an escape that is no character (a
 * stray `%`, or a password's own `%a5`) stays as written and hides nothing around it; `+` as a
 * space when asked.
 */
function percentDecoded(text: string, plus: boolean): string {
  const spaced = plus ? text.replace(/\+/g, ' ') : text;
  return spaced.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    let decoded = '';
    for (let index = 0; index < run.length; ) {
      const lead = Number.parseInt(run.slice(index + 1, index + 3), 16);
      const size =
        lead < 0x80 ? 1 : lead < 0xc2 ? 0 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf5 ? 4 : 0;
      if (size && index + size * 3 <= run.length)
        try {
          decoded += decodeURIComponent(run.slice(index, index + size * 3));
          index += size * 3;
          continue;
        } catch {}
      decoded += run.slice(index, index + 3);
      index += 3;
    }
    return decoded;
  });
}

/** Percent escapes read as single bytes, as a page that is not UTF-8 encodes a form. */
const latin1Decoded = (text: string, plus: boolean) =>
  (plus ? text.replace(/\+/g, ' ') : text).replace(/%([0-9a-f]{2})/gi, (_hex, byte: string) =>
    String.fromCharCode(Number.parseInt(byte, 16)),
  );

const JSON_ESCAPES: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const jsonUnescaped = (text: string) =>
  text.replace(/\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g, (_all, hex?: string, escaped?: string) =>
    hex
      ? String.fromCharCode(Number.parseInt(hex, 16))
      : (JSON_ESCAPES[escaped ?? ''] ?? escaped ?? ''),
  );

/** How many readings of one text are tried, and how many rounds of decoding. */
const MAX_READINGS = 32;
const DECODE_ROUNDS = 3;

/**
 * Every way the text can be read back, decoded up to three times over: as it is, with percent
 * escapes as UTF-8 or as single bytes, each with `+` kept or read as a space (a script that
 * joins a password into an address leaves `+` as it is, a form turns a space into one), and
 * with JSON escapes undone. So a password written once, twice, or by a mix of these is read.
 */
function readings(text: string): string[] {
  const seen = new Set([text]);
  let round = [text];
  for (let pass = 0; pass < DECODE_ROUNDS && round.length; pass++) {
    const next: string[] = [];
    for (const value of round) {
      const reads: string[] = [];
      if (value.includes('%'))
        reads.push(
          percentDecoded(value, false),
          percentDecoded(value, true),
          latin1Decoded(value, false),
          latin1Decoded(value, true),
        );
      else if (value.includes('+')) reads.push(value.replace(/\+/g, ' '));
      if (value.includes('\\')) reads.push(jsonUnescaped(value));
      for (const read of reads)
        if (!seen.has(read) && seen.size < MAX_READINGS) {
          seen.add(read);
          next.push(read);
        }
    }
    round = next;
  }
  return [...seen];
}

/**
 * The parts of a text a whole secret is matched against: an address's credentials, path
 * segments, and the keys and values of its query and fragment (never its host, which names the
 * site); a body's fields, split at every break of a form, JSON or multipart body.
 */
function partsOf(text: string): string[] {
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      const fields = (list: string) =>
        list.split('&').flatMap((pair) => {
          const at = pair.indexOf('=');
          return at < 0 ? [pair] : [pair.slice(0, at), pair.slice(at + 1)];
        });
      const fragment = url.hash.slice(1);
      return [
        url.username,
        url.password,
        ...url.pathname.split('/'),
        ...fields(url.search.slice(1)),
        fragment,
        ...fields(fragment),
      ].filter(Boolean);
    } catch {}
  }
  return text.split(PART_BREAKS).filter(Boolean);
}

/**
 * The secret as base64 writes it, at each of the three places it can start within what is
 * encoded, so `btoa(password)` or `btoa(user + ':' + password)` is found too; standard and URL
 * alphabets. Only the characters the secret's bytes alone decide are kept.
 */
function base64Forms(secret: string): string[] {
  const encodings = [Buffer.from(secret, 'utf8')];
  if (!/[Ā-￿]/.test(secret) && /[\x80-\xff]/.test(secret))
    encodings.push(Buffer.from(secret, 'latin1'));
  const forms = new Set<string>();
  for (const bytes of encodings)
    for (const [lead, start] of [
      [0, 0],
      [1, 2],
      [2, 3],
    ] as const) {
      const encoded = Buffer.concat([Buffer.alloc(lead), bytes]).toString('base64');
      const piece = encoded.slice(start, Math.floor(((lead + bytes.length) * 8) / 6));
      if (piece.length >= WHOLE_SECRET_BELOW)
        forms.add(piece).add(piece.replace(/\+/g, '-').replace(/\//g, '_'));
    }
  return [...forms];
}

/**
 * Whether text a page would send, an address or a body, holds a secret, however the page wrote
 * it there: as typed, percent-encoded (as UTF-8 or single bytes), form-encoded, JSON-escaped,
 * base64, or any mix of these up to three times over. A short secret, or one of letters or
 * digits alone, counts only as a whole part of the text (see `wholeOnly`).
 */
export function carriesSecret(text: string, secret: string): boolean {
  if (!secret || !text) return false;
  const forms = secretForms(secret);
  if (wholeOnly(secret))
    return partsOf(text).some((part) => readings(part).some((read) => forms.includes(read)));
  if (text.includes(secret)) return true;
  return readings(text).some((read) => forms.some((form) => read.includes(form)));
}

/**
 * The forms a secret is looked for in: itself, each reading of it (so a password holding its
 * own `%41` or `+` is read back as the text it was joined into is), the same without the spaces
 * at its ends that an address drops when it ends with them, and its base64 forms. Looked for
 * anywhere, a reading of fewer than four characters besides spaces is left out: `%20%20` read
 * as two spaces would be found in everything.
 */
function secretForms(secret: string): string[] {
  const trimmed = secret.trim();
  const reads = new Set([
    ...readings(secret),
    ...(trimmed && trimmed !== secret ? readings(trimmed) : []),
  ]);
  if (wholeOnly(secret)) return [...reads];
  // Hex, as a script that writes bytes out (`toString(16)`, a TextEncoder's bytes) leaves them.
  const hex = Buffer.from(secret, 'utf8').toString('hex');
  return [
    ...[...reads].filter((read) => read === secret || read.trim().length >= 4),
    ...base64Forms(secret),
    hex,
    hex.toUpperCase(),
  ];
}

/**
 * What a sign-in step leaves behind of a password, so a later look at the page can tell an
 * address that carries it without the password being kept: a keyed hash of each form the
 * password is looked for in (itself, and its base64 forms), under a key made for this print
 * alone. A cheap rolling hash of each form finds the places worth hashing; the keyed hash
 * decides. Neither gives the password back.
 */
export type SecretPrint = {
  whole: boolean;
  key: Buffer;
  base: number;
  forms: Array<{ length: number; roll: number; digest: string }>;
};

const keyedHash = (key: Buffer, text: string) =>
  createHmac('sha256', key).update(text, 'utf8').digest('hex');

/** A polynomial hash of `text`'s UTF-16 units, modulo 2^32, with an odd base. */
function rollOf(text: string, base: number): number {
  let hash = 0;
  for (let index = 0; index < text.length; index++)
    hash = (Math.imul(hash, base) + text.charCodeAt(index)) >>> 0;
  return hash;
}

export function secretPrint(secret: string): SecretPrint {
  const key = randomBytes(32);
  const base = (key.readUInt32LE(0) | 1) >>> 0;
  const whole = wholeOnly(secret);
  const forms = secretForms(secret);
  return {
    whole,
    key,
    base,
    forms: forms.map((form) => ({
      length: form.length,
      roll: rollOf(form, base),
      digest: keyedHash(key, form),
    })),
  };
}

/** Whether `text` holds the printed secret, read exactly as `carriesSecret` reads it. */
export function printCarried(text: string, print: SecretPrint): boolean {
  if (!text) return false;
  const matches = (candidate: string, form: SecretPrint['forms'][number]) =>
    keyedHash(print.key, candidate) === form.digest;
  if (print.whole)
    return partsOf(text).some((part) =>
      readings(part).some((read) =>
        print.forms.some((form) => read.length === form.length && matches(read, form)),
      ),
    );
  for (const read of readings(text))
    for (const form of print.forms) {
      const length = form.length;
      if (read.length < length) continue;
      // The base to the power of the window's length, to take its first unit off again.
      let top = 1;
      for (let index = 0; index < length; index++) top = Math.imul(top, print.base) >>> 0;
      let hash = rollOf(read.slice(0, length), print.base);
      for (let start = 0; ; start++) {
        if (hash === form.roll && matches(read.slice(start, start + length), form)) return true;
        if (start + length >= read.length) break;
        hash =
          (Math.imul(hash, print.base) +
            read.charCodeAt(start + length) -
            Math.imul(read.charCodeAt(start), top)) >>>
          0;
      }
    }
  return false;
}

/** A person's live channel: any method inside the takeover's site scope, nothing outside it. */
export type BrowserHumanWindow = {
  scope: Pick<LiveSiteScope, 'admits' | 'follow'>;
  budget: LiveNetworkBudget;
  /** Redirect hops one navigation chain may follow before it is refused. */
  redirectHops: number;
  notice: LiveNotify;
  /** A download the person asked for, by file name and type, for a teaching takeover's steps. */
  downloaded?: (file: string, type: string) => void;
};

export type BrowserCommitBinding = {
  url: string;
  method: 'POST';
  body_sha256: string;
};

export type BrowserNetworkResponse = {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
};

export type BrowserNetworkTransport = (
  url: URL,
  address: ResolvedAddress,
  options: {
    method: string;
    headers: Record<string, string>;
    body: Buffer | null;
    signal: AbortSignal;
    maxBytes: number;
    maxHeaderBytes: number;
    timeoutMs: number;
  },
) => Promise<BrowserNetworkResponse>;

export type BrowserNetworkOptions = {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  transport?: BrowserNetworkTransport;
  /** Test dependency only: literal loopback origins, never configuration or tool input. */
  fixtureOrigins?: readonly string[];
  maxRequests?: number;
  maxRedirects?: number;
  maxBytes?: number;
  maxRequestBytes?: number;
  maxHeaderBytes?: number;
  timeoutMs?: number;
};

export class BrowserNetworkError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserNetworkError';
  }
}

/** A checked redirect must become a fresh controller navigation, with a new epoch check. */
export class BrowserRedirect extends BrowserNetworkError {
  constructor(
    readonly target_url: string,
    readonly status: number,
    readonly after_commit: boolean,
  ) {
    super('browser_redirect', 'browser document redirect requires a fresh controller navigation');
    this.name = 'BrowserRedirect';
  }
}

/** A page's own address that could not be loaded, said plainly with the host it names. */
export const SITE_FAILURES = new Set([
  'site_not_found',
  'site_unreachable',
  'site_certificate_invalid',
  'site_timeout',
]);
const DNS_FAILURES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_NODATA', 'EAI_FAIL']);
const CONNECT_FAILURES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EPIPE',
  'ETIMEDOUT',
]);
/** Ways a host can fail to serve what was asked of it, as opposed to a request being refused. */
const SERVE_FAILURES = new Set([
  'request_timeout',
  'response_too_large',
  'invalid_response',
  'invalid_headers',
  'headers_too_large',
]);

/**
 * A request that failed because its host could not be reached or did not serve it, put plainly;
 * undefined for anything else, including every refusal the guard makes. The size and header
 * checks also refuse what a page asks to send, so they count only once the request went out.
 */
function siteFailure(error: unknown, host: string, sent: boolean): BrowserNetworkError | undefined {
  if (error instanceof BrowserNetworkError) {
    if (!SERVE_FAILURES.has(error.code)) return undefined;
    if (!sent && error.code !== 'request_timeout') return undefined;
    return error.code === 'request_timeout'
      ? new BrowserNetworkError('site_timeout', `${host} timed out without answering.`)
      : error;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return undefined;
  if (DNS_FAILURES.has(code))
    return new BrowserNetworkError('site_not_found', `${host} could not be found.`);
  if (CONNECT_FAILURES.has(code))
    return new BrowserNetworkError('site_unreachable', `${host} did not answer.`);
  if (/CERT|SSL|TLS|UNABLE_TO_VERIFY/.test(code))
    return new BrowserNetworkError(
      'site_certificate_invalid',
      `${host} has a security certificate that could not be checked.`,
    );
  return undefined;
}

/** A resource or a frame's document; the top-level page's own document is not one. */
function subresource(request: Request): boolean {
  if (request.resourceType() !== 'document') return true;
  try {
    return request.frame().parentFrame() !== null;
  } catch {
    return false;
  }
}

const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * How a page's own script sends in the background: an XHR, a fetch or a beacon. An opened page
 * sends these as it draws itself (a page its script builds asks its server what to show), and
 * they go; from the signed-in profile, a write among them goes without the person's sign-in (see
 * relay). A form the browser submits is a document instead, a page's or a frame's, and only an
 * approved submit sends one.
 */
const SCRIPT_SENDS = new Set(['xhr', 'fetch', 'ping']);

function scriptSend(request: Request): boolean {
  return SCRIPT_SENDS.has(request.resourceType()) && !request.isNavigationRequest();
}
/** Refusals of a person's navigation that leave them on the page they were on. */
const STAY_ON_PAGE = new Set([
  'off_scope',
  'redirect_limit',
  'redirect_mutation',
  'download_refused',
  'live_budget',
  'non_public_address',
  'url_not_allowed',
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'alt-svc',
]);

function networkError(code: string, message: string): never {
  throw new BrowserNetworkError(code, message);
}

function positiveLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid browser network limit');
  return limit;
}

function hostname(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function parseUrl(raw: string): URL {
  if (raw.length > 16_384) networkError('url_not_allowed', 'browser URL exceeds the size limit');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return networkError('url_not_allowed', 'browser URL is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    networkError('url_not_allowed', 'only HTTP(S) browser URLs without credentials are allowed');
  }
  return url;
}

function attribute(value: string): string {
  return value.replace(/[&"'<>]/g, (character) => `&#${character.charCodeAt(0)};`);
}

/**
 * Where a request stands: a top-level navigation and the document it leaves, or the top-level
 * document a resource or frame belongs to. A request with no frame (a worker's) has neither.
 */
type RequestPlace = { navigation?: { initiator?: string }; top?: string };

async function requestPlace(request: Request, referer?: string): Promise<RequestPlace> {
  let frame: Frame;
  try {
    frame = request.frame();
  } catch {
    // A popup's first navigation is requested before its page exists. Chromium's referrer then
    // names the document that opened it; without one, only an in-scope target is admitted.
    return request.isNavigationRequest()
      ? { navigation: { initiator: referer }, top: request.url() }
      : {};
  }
  if (!request.isNavigationRequest() || frame.parentFrame())
    return { top: frame.page().mainFrame().url() };
  const current = frame.url();
  if (/^https?:/i.test(current)) return { navigation: { initiator: current }, top: request.url() };
  // A popup's first document is started by the page that opened it.
  const opener = await frame
    .page()
    .opener()
    .catch(() => null);
  return { navigation: { initiator: opener?.url() }, top: request.url() };
}

/** A request for another site than the top-level document's; a top-level navigation never is. */
function thirdParty(url: URL, place: RequestPlace): boolean {
  if (place.navigation) return false;
  const top = place.top === undefined ? undefined : hostOf(place.top);
  return top === undefined || siteOf(top) !== siteOf(hostname(url));
}

function fixtureOrigin(raw: string): string {
  const url = parseUrl(raw);
  const name = hostname(url);
  if (
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !((isIP(name) === 4 && name.startsWith('127.')) || name === '::1')
  ) {
    throw new Error('browser fixture origins must be exact literal loopback origins');
  }
  return url.origin;
}

/** Headers cannot smuggle a second request or select another relay destination. */
function relayHeaders(
  input: Record<string, string | string[]>,
  maxBytes: number,
  request: boolean,
): Record<string, string> {
  const result: Record<string, string> = {};
  const denied = new Set(HOP_HEADERS);
  if (request) denied.add('host');
  for (const [key, raw] of Object.entries(input)) {
    if (key.toLowerCase() === 'connection') {
      for (const value of Array.isArray(raw) ? raw : [raw]) {
        for (const token of value.split(',')) denied.add(token.trim().toLowerCase());
      }
    }
  }
  let size = 0;
  for (const [key, raw] of Object.entries(input)) {
    const name = key.toLowerCase();
    const values = Array.isArray(raw) ? raw : [raw];
    if (!/^[!#$%&'*+.^_`|~\da-z-]+$/.test(name)) {
      networkError('invalid_headers', 'browser network header name is invalid');
    }
    for (const value of values) {
      if (/[\r\n\0]/.test(value)) {
        networkError('invalid_headers', 'browser network header value is invalid');
      }
      size += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    }
    if (size > maxBytes) networkError('headers_too_large', 'browser headers exceed the size limit');
    if (denied.has(name)) continue;
    if (name === 'location' && values.length !== 1) {
      networkError('invalid_redirect', 'browser response has ambiguous redirect locations');
    }
    // Playwright uses a newline for multiple Set-Cookie values; ordinary headers use commas.
    result[name] = values.join(name === 'set-cookie' ? '\n' : ', ');
  }
  return result;
}

/** Node resolves only the already checked address; Host and TLS SNI retain the URL host. */
export const pinnedBrowserRequest: BrowserNetworkTransport = (url, address, options) =>
  new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const name = hostname(url);
    const req = request(
      url,
      {
        agent: false,
        method: options.method,
        signal: options.signal,
        maxHeaderSize: options.maxHeaderBytes,
        servername: isIP(name) ? undefined : name,
        lookup: (_name, lookupOptions, callback) =>
          lookupOptions.all
            ? callback(null, [address])
            : callback(null, address.address, address.family),
        headers: {
          ...options.headers,
          ...(options.body ? { 'content-length': String(options.body.length) } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            response.destroy(
              new BrowserNetworkError(
                'response_too_large',
                'browser response exceeds the size limit',
              ),
            );
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.once('error', reject);
        response.once('end', () => {
          const headers: BrowserNetworkResponse['headers'] = {};
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            const key = response.rawHeaders[index]?.toLowerCase();
            const value = response.rawHeaders[index + 1];
            if (key === undefined || value === undefined) continue;
            const previous = headers[key];
            headers[key] =
              previous === undefined
                ? value
                : [...(Array.isArray(previous) ? previous : [previous]), value];
          }
          resolve({ status: response.statusCode ?? 502, headers, body: Buffer.concat(chunks) });
        });
      },
    );
    const timer = setTimeout(
      () =>
        req.destroy(
          new BrowserNetworkError('request_timeout', 'browser network request timed out'),
        ),
      options.timeoutMs,
    );
    req.once('upgrade', (_response, socket) => {
      socket.destroy();
      reject(new BrowserNetworkError('websocket_denied', 'browser protocol upgrades are denied'));
    });
    req.once('close', () => clearTimeout(timer));
    req.once('error', reject);
    req.end(options.body);
  });

/** A write a sign-in step held back, and whether it may have been the sign-in itself. */
export type HeldSignInWrite = {
  method: string;
  host: string;
  /** Held only because the step had sent its budget of writes. */
  budget: boolean;
  /** Its body held the password, the username or the code, or its address is named for signing in. */
  credentials: boolean;
};

/** An address's path named for signing in: where a site's script sends a sign-in. */
const SIGN_IN_PATH =
  /(^|[^a-z])(log.?in|log.?on|sign.?in|sign.?on|session|sessions|auth|oauth2?|authenticate|token|sso|password|passwd|credentials?|identity|identifier|verify|mfa|otp)([^a-z]|$)/i;

/** Whether a write's body carries the password or what else the step typed. */
function carriesTyped(operation: Operation, body: Buffer | null): boolean {
  if (!body?.length) return false;
  const text = body.toString('utf8');
  return [operation.secret, ...operation.typed].some(
    (value) => value !== undefined && carriesSecret(text, value),
  );
}

/** Whether a write a sign-in step held back may have been the sign-in itself. */
function maySignIn(operation: Operation, url: URL, body: Buffer | null): boolean {
  return carriesTyped(operation, body) || SIGN_IN_PATH.test(url.pathname);
}

type Operation = {
  mode: BrowserNetworkMode;
  human: BrowserHumanWindow | undefined;
  /** Redirect hops already followed to reach each target, per navigation chain. */
  hops: Map<string, number>;
  origin: string | undefined;
  commit: BrowserCommitBinding | undefined;
  guard: (() => void) | undefined;
  /** A sign-in step's password: never in any address, and never in a body to another origin. */
  secret: string | undefined;
  /** What else the step typed (the username, a code): a body holding it is the sign-in itself. */
  typed: readonly string[];
  requests: number;
  mutations: number;
  pending: Set<Promise<void>>;
  abort: AbortController;
  error: Error | undefined;
  ending: boolean;
  /**
   * An opening whose page has its document. What the page's script asks for from then on, as it
   * draws itself, goes under the same checks, and one they refuse is left out instead of ending
   * the opening, as one asked for after the opening ended is.
   */
  loaded: boolean;
  /** When a request of this operation last started or finished, for how long it has been quiet. */
  lastActivity: number;
  /** Cuts off each request for a part of the page still in flight. */
  cuts: Set<() => void>;
};

async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export type BrowserEgress = ReturnType<typeof createBrowserEgress>;

/**
 * One controller operation owns the network window. Late page scripts cannot inherit
 * an approval, and a second simultaneous POST cannot race the mutation counter.
 * The caller must block service workers and direct Chromium egress before install.
 */
export function createBrowserEgress(
  policy: BrowserNetworkPolicy,
  options: BrowserNetworkOptions = {},
) {
  const publicCompartment = policy.public_compartment;
  const domains = new Set(
    policy.allowed_domains.map((value) => value.toLowerCase().replace(/\.$/, '')),
  );
  // Which addresses a page may reach. A domain list, when a job has one, is the whole of it; the
  // compartment alone decides whose cookies go with a request.
  const anyPublic = publicCompartment || (policy.public_web === true && domains.size === 0);
  const fixtures = new Set((options.fixtureOrigins ?? []).map(fixtureOrigin));
  const resolve =
    options.resolve ??
    (async (name: string) =>
      (await lookup(name, { all: true, verbatim: true })) as ResolvedAddress[]);
  const transport = options.transport ?? pinnedBrowserRequest;
  const maxRequests = positiveLimit(options.maxRequests, 128);
  const maxRedirects = positiveLimit(options.maxRedirects, 5);
  const maxBytes = positiveLimit(options.maxBytes, 8 * 1024 * 1024);
  const maxRequestBytes = positiveLimit(options.maxRequestBytes, 1024 * 1024);
  const maxHeaderBytes = positiveLimit(options.maxHeaderBytes, 32 * 1024);
  const timeoutMs = positiveLimit(options.timeoutMs, 10_000);
  let context: BrowserContext | undefined;
  let active: Operation | undefined;
  let closed = false;
  let commitDispatched = false;
  /** Hosts whose resources failed while a page loaded, until the controller takes them. */
  const unreachable = new Set<string>();
  /**
   * Requests that would change something which a page sent while it loaded, as `METHOD host`,
   * each held back, until the controller takes them.
   */
  const dropped = new Set<string>();
  /** The writes a sign-in step held back, until the controller takes them. */
  const signInHeld: HeldSignInWrite[] = [];

  async function checkAddress(
    url: URL,
    signal: AbortSignal,
    human = false,
  ): Promise<ResolvedAddress> {
    const name = hostname(url);
    // A takeover's site scope starts from these domains and admits its hosts instead; the
    // public-address, DNS and pinning checks below apply to a person exactly as to automation.
    if (!human && !anyPublic && !domains.has(name)) {
      networkError('domain_not_allowed', 'private-context browser cannot access this domain');
    }
    const family = isIP(name);
    const addresses = family
      ? [{ address: name, family: family as 4 | 6 }]
      : await untilAborted(resolve(name), signal);
    const fixture = fixtures.has(url.origin);
    if (
      !addresses.length ||
      addresses.some(
        (address) =>
          isIP(address.address) !== address.family ||
          (!fixture && !isPublicAddress(address.address)),
      )
    ) {
      networkError('non_public_address', 'browser URL resolves to a non-public address');
    }
    const pinned = addresses[0];
    if (!pinned) return networkError('non_public_address', 'browser URL did not resolve');
    return pinned;
  }

  function requireOperation(operation: Operation | undefined): asserts operation is Operation {
    if (closed) networkError('network_closed', 'browser network guard is closed');
    if (!operation || operation !== active || operation.ending) {
      networkError('network_idle', 'browser network requires an active controller operation');
    }
    if (operation.error) throw operation.error;
  }

  function admitRequest(
    operation: Operation,
    url: URL,
    request: Request,
    body: Buffer | null,
    headers: Record<string, string>,
    place: RequestPlace,
  ): void {
    const human = operation.human;
    if (human) {
      if (!human.budget.request()) {
        human.notice('live_budget');
        networkError('live_budget', 'the takeover has used its browser request budget');
      }
      const host = hostname(url);
      const top = place.top === undefined ? undefined : hostOf(place.top);
      // The scope keeps the person's navigation on the sites they chose. The resources and
      // frames an in-scope page is built from may come from any public address.
      const admitted = place.navigation
        ? human.scope.admits(host) ||
          ['in_scope', 'admitted'].includes(
            human.scope.follow(url.href, place.navigation.initiator),
          )
        : top !== undefined && human.scope.admits(top);
      if (!admitted) {
        human.notice('off_scope', host);
        networkError('off_scope', 'browser request is outside the takeover site scope');
      }
      return;
    }
    operation.requests += 1;
    if (operation.requests > maxRequests) {
      networkError('request_limit', 'browser operation exceeds the request limit');
    }
    const read = READ_METHODS.has(request.method());
    if (operation.mode === 'navigate' && !read && !scriptSend(request)) {
      networkError('mutation_requires_commit', 'browser mutation requires an approved submit');
    }
    // A step's input (a fill, a click, a choice) changes the page and sends nothing: what the
    // page's script reads in answer, such as the towns for a ZIP code, goes, and a write it tries
    // or a page it opens does not.
    if (
      operation.mode === 'reversible' &&
      !(read && request.resourceType() !== 'document' && !request.isNavigationRequest())
    ) {
      networkError(
        'network_reversible',
        "reversible browser input sends nothing but the page script's reads",
      );
    }
    const secret = operation.mode === 'sign_in' ? operation.secret : undefined;
    // An address is logged, shown and kept, by the browser and by every site it passes: a form
    // or a script that puts the password in one is refused, whatever its method or site.
    if (secret && carriesSecret(url.href, secret))
      networkError('sign_in_secret_in_url', 'a saved password is never sent in an address');
    if (operation.mode === 'sign_in' && !read) {
      // A saved sign-in is sent to the site it was saved for and nowhere else. A request that
      // carries the password elsewhere ends the step; it is never quietly held back as a beacon.
      if (url.origin !== operation.origin)
        networkError(
          secret && body && carriesSecret(body.toString('utf8'), secret)
            ? 'sign_in_secret_elsewhere'
            : 'sign_in_origin',
          'a saved sign-in is sent only to its own site',
        );
      operation.mutations += 1;
      // The sign-in itself is never held back for the budget, however busy the page was before
      // it: a write whose body carries what the step typed goes.
      if (operation.mutations > SIGN_IN_MUTATIONS && !carriesTyped(operation, body))
        networkError('sign_in_budget', 'a sign-in step sent more requests than a sign-in needs');
    }
    if (operation.mode === 'commit') {
      if (url.origin !== operation.origin) {
        networkError('commit_origin', 'browser submit cannot leave the current page origin');
      }
      if (read) {
        networkError(
          'commit_read_type',
          'browser submit document reads require a fresh controller navigation',
        );
      } else {
        const commit = operation.commit;
        if (
          !commit ||
          request.method() !== commit.method ||
          url.href !== commit.url ||
          createHash('sha256')
            .update(body ?? Buffer.alloc(0))
            .digest('hex') !== commit.body_sha256 ||
          headers['content-type']?.split(';')[0]?.trim().toLowerCase() !==
            'application/x-www-form-urlencoded'
        ) {
          networkError(
            'commit_payload_mismatch',
            'browser submit request does not match the approved payload',
          );
        }
        operation.mutations += 1;
        if (operation.mutations > 1) {
          networkError('commit_budget', 'browser submit permits at most one mutation request');
        }
      }
    }
    let redirects = 0;
    for (let previous = request.redirectedFrom(); previous; previous = previous.redirectedFrom()) {
      redirects += 1;
      if (redirects > maxRedirects) {
        networkError('redirect_limit', 'browser redirect limit exceeded');
      }
    }
  }

  /**
   * Chromium does not route the next hop of a fulfilled redirect, so a person's checked document
   * redirect continues as a navigation from a no-store document that carries this hop's cookies.
   */
  async function humanRedirect(
    route: Route,
    request: Request,
    source: URL,
    target: URL,
    status: number,
    headers: Record<string, string>,
    operation: Operation,
    human: BrowserHumanWindow,
    place: RequestPlace,
  ): Promise<void> {
    if (!place.navigation) {
      human.notice('redirect_refused');
      networkError(
        'subresource_redirect_unsupported',
        'browser subresource redirects are not supported',
      );
    }
    if (!READ_METHODS.has(request.method()) && [307, 308].includes(status)) {
      human.notice('redirect_refused');
      networkError('redirect_mutation', 'browser redirect cannot replay a mutation');
    }
    const hops = (operation.hops.get(source.href) ?? 0) + 1;
    if (hops > human.redirectHops) {
      human.notice('redirect_refused');
      networkError('redirect_limit', 'browser redirect chain exceeds the hop limit');
    }
    if (!['in_scope', 'admitted'].includes(human.scope.follow(target.href, source.href))) {
      human.notice('off_scope', hostname(target));
      networkError('off_scope', 'browser redirect is outside the takeover site scope');
    }
    operation.hops.set(target.href, hops);
    const oldest = operation.hops.keys().next().value;
    if (operation.hops.size > 256 && oldest !== undefined) operation.hops.delete(oldest);
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        ...(headers['set-cookie'] ? { 'set-cookie': headers['set-cookie'] } : {}),
      },
      body: `<!doctype html><meta http-equiv="refresh" content="0;url=${attribute(target.href)}">`,
    });
  }

  async function relay(route: Route, operation: Operation | undefined): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let place: RequestPlace = {};
    let url: URL | undefined;
    let sent = false;
    const abort = new AbortController();
    const abortOperation = () => abort.abort(operation?.abort.signal.reason);
    // A part of the page still on its way when the page is looked at is cut off, so a stream or
    // a slow host does not hold up the look; the page stands without it.
    const cut = () =>
      abort.abort(
        new BrowserNetworkError('network_idle', 'the page was looked at before this arrived'),
      );
    if (operation && subresource(route.request())) operation.cuts.add(cut);
    operation?.abort.signal.addEventListener('abort', abortOperation, { once: true });
    try {
      requireOperation(operation);
      timer = setTimeout(
        () =>
          abort.abort(
            new BrowserNetworkError('request_timeout', 'browser network request timed out'),
          ),
        timeoutMs,
      );
      const request = route.request();
      url = parseUrl(request.url());
      const body = request.postDataBuffer();
      if (body && body.length > maxRequestBytes) {
        networkError('request_too_large', 'browser request exceeds the size limit');
      }
      const headers = relayHeaders(
        await untilAborted(request.allHeaders(), abort.signal),
        maxHeaderBytes,
        true,
      );
      requireOperation(operation);
      const human = operation.human;
      if (human || !publicCompartment)
        place = await untilAborted(requestPlace(request, headers.referer), abort.signal);
      requireOperation(operation);
      admitRequest(operation, url, request, body, headers, place);
      // The persistent profile sends no cookies to a site other than the page's own, so a page
      // cannot ride the person's other signed-in sessions through cross-site requests.
      const crossSite = !publicCompartment && thirdParty(url, place);
      // Opening a page changes nothing of the person's, whatever address it was opened at: a write
      // its script sends as it opens goes as no one, without their cookies or authorization, and
      // what its answer would set is dropped, so it can neither act for them nor sign them out.
      // Only an approved submit acts as them. A research browser holds nothing of theirs.
      const anonymous =
        !publicCompartment && operation.mode === 'navigate' && !READ_METHODS.has(request.method());
      if (crossSite || anonymous) delete headers.cookie;
      if (anonymous) delete headers.authorization;
      const address = await checkAddress(url, abort.signal, Boolean(human));
      requireOperation(operation);
      // DNS and header reads yielded after the input was planned. The controller
      // rechecks takeover here, synchronously adjacent to the actual dispatch.
      operation.guard?.();
      if (operation.mode === 'commit' && request.method() === 'POST') commitDispatched = true;
      sent = true;
      const response = await untilAborted(
        transport(url, address, {
          method: request.method(),
          headers,
          body,
          signal: abort.signal,
          maxBytes,
          maxHeaderBytes,
          timeoutMs,
        }),
        abort.signal,
      );
      if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599) {
        networkError('invalid_response', 'browser relay received an unsupported response status');
      }
      if (response.body.length > maxBytes) {
        networkError('response_too_large', 'browser response exceeds the size limit');
      }
      if (human && !human.budget.transfer((body?.length ?? 0) + response.body.length)) {
        human.notice('live_budget');
        networkError('live_budget', 'the takeover has used its browser byte budget');
      }
      const responseHeaders = relayHeaders(response.headers, maxHeaderBytes, false);
      if (crossSite || anonymous) delete responseHeaders['set-cookie'];
      if (human && /^\s*attachment/i.test(responseHeaders['content-disposition'] ?? '')) {
        human.downloaded?.(
          downloadName(responseHeaders['content-disposition'], url.href),
          responseHeaders['content-type'] ?? '',
        );
        human.notice('download_refused');
        networkError('download_refused', 'browser downloads are refused during a takeover');
      }
      if (REDIRECT_STATUSES.has(response.status) && responseHeaders.location) {
        let target: URL;
        try {
          target = parseUrl(new URL(responseHeaders.location, url).href);
          await checkAddress(target, abort.signal, Boolean(human));
        } catch (error) {
          human?.notice('redirect_refused');
          throw error;
        }
        if (human) {
          await humanRedirect(
            route,
            request,
            url,
            target,
            response.status,
            responseHeaders,
            operation,
            human,
            place,
          );
          return;
        }
        if (operation.mode === 'commit' && target.origin !== operation.origin) {
          networkError(
            'commit_origin',
            'browser submit redirect cannot leave the current page origin',
          );
        }
        if (!READ_METHODS.has(request.method()) && [307, 308].includes(response.status)) {
          networkError('redirect_mutation', 'browser submit redirect cannot replay a mutation');
        }
        // A frame's document is a part of the page too: its redirect never moves the page.
        if (subresource(request)) {
          networkError(
            'subresource_redirect_unsupported',
            'browser subresource redirects are not supported',
          );
        }
        if (
          ((operation.mode === 'navigate' || operation.mode === 'sign_in') &&
            READ_METHODS.has(request.method())) ||
          ((operation.mode === 'commit' || operation.mode === 'sign_in') &&
            request.method() === 'POST' &&
            [302, 303].includes(response.status))
        ) {
          // Chromium can bypass Playwright routing on automatic redirect hops. The
          // dead proxy blocks that hop; fulfill preserves original-origin cookies,
          // and the controller follows this signal through a fresh guarded goto.
          operation.error = new BrowserRedirect(
            target.href,
            response.status,
            operation.mode === 'commit' ||
              (operation.mode === 'sign_in' && !READ_METHODS.has(request.method())),
          );
        } else {
          networkError(
            'redirect_unsupported',
            'browser redirect requires an unsupported method transition',
          );
        }
      }
      await route.fulfill({
        status: response.status,
        headers: responseHeaders,
        body: response.body,
      });
    } catch (error) {
      const failed = url && siteFailure(error, hostname(url), sent);
      // A resource whose host is down or broken is left out and the page loads without it, as a
      // browser would load it; the look after says which hosts. Every refusal still ends the
      // operation, and so does a failure of the page's own document, by a plain name.
      const pageResource =
        (operation?.mode === 'navigate' ||
          operation?.mode === 'sign_in' ||
          operation?.mode === 'reversible') &&
        !operation.abort.signal.aborted &&
        subresource(route.request());
      if (pageResource && failed) {
        if (url) unreachable.add(hostname(url));
      } else if (
        pageResource &&
        operation.ending &&
        error instanceof BrowserNetworkError &&
        error.code === 'network_idle'
      ) {
        // A resource asked for once the page had loaded is refused, and the load stands.
      } else if (
        (pageResource || operation?.loaded) &&
        error instanceof BrowserNetworkError &&
        (error.code === 'mutation_requires_commit' ||
          error.code === 'sign_in_origin' ||
          error.code === 'sign_in_budget' ||
          (error.code === 'network_reversible' &&
            !READ_METHODS.has(route.request().method()) &&
            !route.request().isNavigationRequest()))
      ) {
        // A form a page or its frame submits by itself as it loads is held back, as every form
        // is outside an approved submit, and the page loads without it; so is a write the page's
        // script tries during a step's input. The look after says what was held back. So is what
        // a page's script sends past a sign-in step's budget; the sign-in itself is never among
        // it (see admitRequest).
        if (url) {
          dropped.add(`${route.request().method()} ${hostname(url)}`);
          if (operation?.mode === 'sign_in')
            signInHeld.push({
              method: route.request().method(),
              host: hostname(url),
              budget: error.code === 'sign_in_budget',
              credentials: maySignIn(operation, url, route.request().postDataBuffer()),
            });
        }
      } else if (
        (operation?.loaded ||
          (pageResource &&
            operation?.mode === 'reversible' &&
            !route.request().isNavigationRequest())) &&
        !operation.abort.signal.aborted &&
        error instanceof BrowserNetworkError
      ) {
        // Once the page has its document, or during a step's input, a request of its script's
        // that is refused is left out and the page stands. A page a step's input would open
        // still ends the step, in the page or in one of its frames.
      } else if (operation && operation.mode !== 'human' && !operation.error) {
        // A person's refused request fails alone; it never ends the takeover's network window.
        operation.error =
          failed || (error instanceof Error ? error : new Error('browser network request failed'));
      }
      // A refused navigation answers 204, so Chromium stays on the current page instead of
      // committing an error page; the person's notice says why nothing happened.
      if (
        operation?.mode === 'human' &&
        place.navigation &&
        error instanceof BrowserNetworkError &&
        STAY_ON_PAGE.has(error.code)
      )
        await route.fulfill({ status: 204 }).catch(() => route.abort('blockedbyclient'));
      else await route.abort('blockedbyclient').catch(() => {});
    } finally {
      if (timer) clearTimeout(timer);
      operation?.abort.signal.removeEventListener('abort', abortOperation);
      operation?.cuts.delete(cut);
    }
  }

  return {
    /** Whether a URL is one of the loopback origins a test fixture was given. */
    fixture(target: string): boolean {
      try {
        return fixtures.has(new URL(target).origin);
      } catch {
        return false;
      }
    },

    get commitDispatched(): boolean {
      return commitDispatched;
    },

    /** Whether the running operation has already met what ends it: a refusal or a redirect. */
    get settling(): boolean {
      return Boolean(active?.error);
    },

    /** The hosts resources could not be loaded from since the last call, then forgets them. */
    takeUnreachable(): string[] {
      const hosts = [...unreachable].sort();
      unreachable.clear();
      return hosts;
    },

    /** The writes sign-in steps held back since the last call, in order, then forgets them. */
    takeSignInHeld(): HeldSignInWrite[] {
      return signInHeld.splice(0);
    },

    /**
     * Says the page an opening loaded has its document, so the opening stays open while the page's
     * script draws the rest of it (see Operation.loaded). Only an opening is changed.
     */
    pageLoaded(): void {
      if (active?.mode === 'navigate' && !active.ending) active.loaded = true;
    },

    /**
     * Waits while the running operation's page is still asking for things: until none of its
     * requests has started or finished for `quietMs`, or `limitMs` has passed, or the operation
     * has met what ends it.
     */
    async settle(limitMs: number, quietMs = SETTLE_QUIET_MS): Promise<void> {
      const operation = active;
      if (!operation) return;
      const end = Date.now() + limitMs;
      while (active === operation && !operation.error && !operation.ending) {
        const now = Date.now();
        const quietFor = now - operation.lastActivity;
        if (!operation.pending.size && quietFor >= quietMs) return;
        if (now >= end) return;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(10, Math.min(100, end - now, quietMs - quietFor))),
        );
      }
    },

    /** The requests held back while a page loaded since the last call, then forgets them. */
    takeDropped(): string[] {
      const requests = [...dropped].sort();
      dropped.clear();
      return requests;
    },

    get idle(): boolean {
      return Boolean(context) && !closed && !active;
    },

    async install(target: BrowserContext): Promise<void> {
      if (context || closed)
        networkError('network_closed', 'browser network guard cannot be installed twice');
      if (
        target.serviceWorkers().length ||
        target.pages().some((page) => page.url() !== 'about:blank')
      ) {
        networkError(
          'network_late_install',
          'browser network guard must be installed before browsing',
        );
      }
      context = target;
      await target.route('**/*', (route) => {
        const operation = active;
        if (operation) operation.lastActivity = Date.now();
        const pending = relay(route, operation);
        operation?.pending.add(pending);
        void pending.finally(() => {
          operation?.pending.delete(pending);
          if (operation) operation.lastActivity = Date.now();
        });
        return pending;
      });
      await target.routeWebSocket('**/*', async (socket) => {
        if (active?.human) active.human.notice('websocket_refused');
        else if (active && !active.error && !active.loaded && active.mode !== 'reversible') {
          active.error = new BrowserNetworkError(
            'websocket_denied',
            'browser WebSockets are denied',
          );
        }
        await socket.close({ code: 1008, reason: 'browser WebSockets are denied' });
      });
    },

    async run<T>(
      mode: BrowserNetworkMode,
      operation: () => Promise<T>,
      commit?: BrowserCommitBinding,
      guard?: () => void,
      human?: BrowserHumanWindow,
      /** A sign-in step's password, which no request may carry in its address. */
      secret?: string,
      /** What else a sign-in step typed: a write that carries it is never held for the budget. */
      typed: readonly string[] = [],
    ): Promise<T> {
      if (!context || closed)
        networkError('network_closed', 'browser network guard is not available');
      if (active) networkError('network_busy', 'browser network operation is already running');
      if (!['navigate', 'reversible', 'commit', 'human', 'sign_in'].includes(mode)) {
        networkError('invalid_mode', 'browser network operation mode is invalid');
      }
      if ((mode === 'human') !== Boolean(human)) {
        networkError('invalid_mode', 'a person holds the browser network only with a site scope');
      }
      if (mode === 'commit') commitDispatched = false;
      const pageUrl = context.pages()[0]?.url();
      const origin = pageUrl && /^https?:/.test(pageUrl) ? parseUrl(pageUrl).origin : undefined;
      if (mode === 'sign_in' && !origin)
        networkError('sign_in_origin', 'a sign-in starts on a page of the site it is for');
      let binding: BrowserCommitBinding | undefined;
      if (mode === 'commit') {
        if (commit?.method !== 'POST' || !/^[a-f\d]{64}$/.test(commit.body_sha256)) {
          networkError('commit_payload_mismatch', 'browser submit requires a bound POST payload');
        }
        const target = parseUrl(commit.url);
        target.hash = '';
        if (target.origin !== origin) {
          networkError('commit_origin', 'browser submit cannot leave the current page origin');
        }
        binding = { ...commit, url: target.href };
      }
      const current: Operation = {
        mode,
        human: mode === 'human' ? human : undefined,
        hops: new Map(),
        origin,
        commit: binding,
        guard,
        secret: mode === 'sign_in' ? secret : undefined,
        typed: mode === 'sign_in' ? typed.filter(Boolean) : [],
        requests: 0,
        mutations: 0,
        pending: new Set(),
        abort: new AbortController(),
        error: undefined,
        ending: false,
        loaded: false,
        lastActivity: Date.now(),
        cuts: new Set(),
      };
      active = current;
      try {
        const result = await operation();
        current.ending = true;
        // The page is looked at as it stands: what it still asks for is left out, as what it
        // asks for later is.
        if (mode === 'navigate' || mode === 'reversible') for (const cut of current.cuts) cut();
        while (current.pending.size) await Promise.all([...current.pending]);
        if (current.error) throw current.error;
        if (mode === 'commit' && current.mutations !== 1) {
          networkError(
            'commit_not_dispatched',
            'browser submit did not dispatch its approved request',
          );
        }
        return result;
      } catch (error) {
        current.ending = true;
        current.abort.abort(error);
        while (current.pending.size) await Promise.all([...current.pending]);
        throw current.error ?? error;
      } finally {
        current.ending = true;
        active = undefined;
      }
    },

    async close(): Promise<void> {
      closed = true;
      const operation = active;
      operation?.abort.abort(
        new BrowserNetworkError('network_closed', 'browser network guard is closed'),
      );
      // Keep the deny route installed: removing it would restore direct browser networking.
      if (operation) while (operation.pending.size) await Promise.all([...operation.pending]);
    },
  };
}
