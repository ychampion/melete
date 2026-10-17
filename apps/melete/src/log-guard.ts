/**
 * The last check on what the service writes to its own output, which Docker
 * keeps as its log and an operator may ship to a collector. Call sites already
 * write ids, codes and short reasons rather than anything a person wrote or a
 * model said (log-content.test.ts holds them to that); this catches a
 * credential an error message quoted on its way through.
 *
 * Only shapes that are always secret are taken out, so the ids, hashes and
 * container names an operator reads a log by stay as they are.
 */
import { formatWithOptions } from 'node:util';

const REDACTED = '[redacted]';

/** `scheme://user:password@host`: the user and password go, the host stays. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@'"]+@/gi;
/** `Bearer abc…`, `Basic abc…` and `Token abc…`, as a logged header carries them. */
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g;
/** A JSON Web Token. */
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
/** Provider keys that announce themselves by prefix, and Melete's device tokens. */
const PREFIXED_KEY =
  /\b(?:(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}|(?:sk|rk|pk|whsec)_(?:live_|test_)?[A-Za-z0-9]{16,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|glpat-[A-Za-z0-9_-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{12,}|AIza[A-Za-z0-9_-]{16,}|mdt_[A-Za-z0-9_-]{16,})/g;
/** A PEM private key, whole or cut off at the end of the line. */
const PRIVATE_KEY =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
/**
 * `password=…`, `token: …` and the like. A number after the name is a count
 * (`tokens: 512`), not a secret, and is kept; an authorization scheme's
 * credential was already taken out above.
 */
const SECRET_PAIR =
  /\b((?:password|passwd|passphrase|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|authorization|cookie|set-cookie|session)[A-Za-z_-]{0,64})(["']?\s*[:=]\s*["']?)(?!\d+\b|(?:Bearer|Basic|Token)\b|\[redacted\])([^\s"'&;,}]+)/gi;
/**
 * A random base64url run as long as a session, sign-in or invite token: 40 or
 * more characters mixing upper case, lower case and digits. Hex digests and
 * container ids are one case and stay.
 */
const RANDOM_RUN = /[A-Za-z0-9_-]{40,}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** One log line with every known secret shape and email address taken out. */
export function redactLogLine(text: string): string {
  return text
    .replace(PRIVATE_KEY, REDACTED)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(JWT, REDACTED)
    .replace(AUTH_SCHEME, (_, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(PREFIXED_KEY, REDACTED)
    .replace(SECRET_PAIR, (_, key: string, sep: string) => `${key}${sep}${REDACTED}`)
    .replace(RANDOM_RUN, (run) =>
      /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run) ? REDACTED : run,
    )
    .replace(EMAIL, '[email]');
}

type Write = typeof process.stdout.write;
let guarded = false;

function guardStream(stream: NodeJS.WriteStream): void {
  const write = stream.write.bind(stream) as Write;
  const decoder = new TextDecoder();
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    const text =
      typeof chunk === 'string'
        ? chunk
        : chunk instanceof Uint8Array
          ? decoder.decode(chunk)
          : String(chunk);
    // A string chunk keeps its own encoding argument; a decoded one is UTF-8.
    return (write as (...args: unknown[]) => boolean)(redactLogLine(text), ...rest);
  }) as Write;
}

/**
 * Send everything the process writes to its output, and everything `console`
 * prints (which in Bun does not pass through `process.stderr.write`), through
 * `redactLogLine`. Called once at the start of the service's own process.
 */
export function guardProcessLogs(): void {
  if (guarded) return;
  guarded = true;
  guardStream(process.stdout);
  guardStream(process.stderr);
  const print =
    (stream: NodeJS.WriteStream) =>
    (...args: unknown[]) => {
      stream.write(`${formatWithOptions({ colors: false }, ...args)}\n`);
    };
  console.log = print(process.stdout);
  console.info = print(process.stdout);
  console.debug = print(process.stdout);
  console.warn = print(process.stderr);
  console.error = print(process.stderr);
}
