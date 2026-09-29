/**
 * Redaction for what a problem report carries besides the person's own words:
 * console lines, request addresses and the page route. The browser applies it
 * before anything leaves the page, and the service applies it again before it
 * stores anything, so a client that skips it still stores nothing it should not.
 *
 * Kept free of imports so the web bundle can take it without the rest of the
 * contracts package.
 */

export const REDACTED = '[redacted]';
export const REDACTED_EMAIL = '[email]';

/** Query and form keys whose value is a credential, a code or a personal detail. */
const SENSITIVE_KEY =
  /^(?:.*(?:token|secret|password|passwd|pwd|session|cookie|auth|credential|signature|api[-_]?key|private)|key|code|state|sig|otp|nonce|email|e-?mail|phone|name|q|query|search|text|message|body|content)$/i;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HAS_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
/** A JSON Web Token: three base64url parts, the first starting with `eyJ`. */
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
/** `Bearer abc…` and `Basic abc…` in a logged header. */
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi;
/** `name=value` or `name: value` where the name says the value is sensitive. */
const SENSITIVE_PAIR =
  /\b([A-Za-z_-]*(?:token|secret|password|passwd|session|cookie|authorization|api[-_]?key|credential)[A-Za-z_-]*)(["']?\s*[:=]\s*["']?)([^\s"'&;,}]+)/gi;
/** A long run of key-like characters: session ids, API keys, hex digests. */
const LONG_TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g;

/** Redact free text: emails, bearer credentials, JWTs, sensitive pairs and long tokens. */
export function redactText(value: string, max = 1000): string {
  const redacted = value
    .replace(JWT, REDACTED)
    .replace(AUTH_SCHEME, (_, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(SENSITIVE_PAIR, (_, key: string, sep: string) => `${key}${sep}${REDACTED}`)
    .replace(EMAIL, REDACTED_EMAIL)
    .replace(LONG_TOKEN, REDACTED);
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

function redactSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A malformed escape is judged as written.
  }
  if (HAS_EMAIL.test(decoded)) return REDACTED_EMAIL;
  if (/^[A-Za-z0-9_.~-]{32,}$/.test(decoded) || /^eyJ/.test(decoded)) return REDACTED;
  return segment;
}

function redactQuery(query: string): string {
  if (!query) return '';
  return query
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const [rawKey = '', ...rest] = pair.split('=');
      if (rest.length === 0) return redactSegment(rawKey);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey);
      } catch {
        // Kept as written.
      }
      return SENSITIVE_KEY.test(key)
        ? `${rawKey}=${REDACTED}`
        : `${rawKey}=${redactSegment(rest.join('='))}`;
    })
    .join('&');
}

/**
 * Redact an address or a hash route. The origin and path structure stay, so a
 * report still says which endpoint failed; a user name and password, a
 * fragment, emails and tokens in the path, and the value of any sensitive
 * query key are replaced.
 */
export function redactUrl(value: string, max = 500): string {
  let rest = value.trim();
  let origin = '';
  const scheme = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)/i.exec(rest);
  if (scheme) {
    const authority = (scheme[2] ?? '').replace(/^[^@]*@/, '');
    origin = `${scheme[1]}${authority}`;
    rest = rest.slice(scheme[0].length);
  }
  // A hash route (`#/chat/c_1?x=y`) is itself a path and a query.
  const hashRoute = rest.startsWith('#/');
  if (hashRoute) rest = rest.slice(1);
  const hashAt = rest.indexOf('#');
  const hadFragment = hashAt >= 0;
  if (hadFragment) rest = rest.slice(0, hashAt);
  const queryAt = rest.indexOf('?');
  const path = queryAt >= 0 ? rest.slice(0, queryAt) : rest;
  const query = queryAt >= 0 ? rest.slice(queryAt + 1) : '';
  const cleanPath = path.split('/').map(redactSegment).join('/');
  const cleanQuery = redactQuery(query);
  const out = `${origin}${hashRoute ? '#' : ''}${cleanPath}${cleanQuery ? `?${cleanQuery}` : ''}${
    hadFragment ? '#…' : ''
  }`;
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}
