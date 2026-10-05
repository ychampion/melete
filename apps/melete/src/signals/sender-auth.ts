/**
 * Whether a message's sender is who its From header says, by the receiving
 * server's own Authentication-Results header (RFC 8601).
 *
 * Anyone can write any From address, and anyone can write an
 * Authentication-Results header too: a sender may put one in the message
 * itself. Only the receiving server's record counts, and the receiving server
 * adds its header above everything the message already carried, so only the
 * topmost Authentication-Results is read; every one below it is ignored.
 *
 * The sender counts as authenticated for the From domain when that header
 * says, for the same organisational domain as every From address:
 *
 * - `dmarc=pass` with `header.from` in that domain; or
 * - `dkim=pass` with `header.d` (or `header.i`) in that domain; or
 * - `spf=pass` with `smtp.mailfrom` in that domain.
 *
 * `dmarc=fail` is a failure whatever else the header says. A header with
 * results but none aligned is a failure too; no header, or one with no
 * DMARC, DKIM or SPF result, is `none`.
 */
import { registrableDomain } from '../companies/replies.ts';

export type SenderAuth = 'pass' | 'fail' | 'none';

export type AuthResult = {
  method: string;
  result: string;
  props: Record<string, string>;
};

/** Text with RFC 5322 comments removed, nested ones included; quoted strings are kept. */
function withoutComments(value: string): string {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index] as string;
    if (char === '\\' && index + 1 < value.length) {
      if (depth === 0) out += char + value[index + 1];
      index++;
      continue;
    }
    if (depth === 0 && char === '"') quoted = !quoted;
    if (!quoted && char === '(') {
      depth++;
      continue;
    }
    if (!quoted && char === ')' && depth > 0) {
      depth--;
      out += ' ';
      continue;
    }
    if (depth === 0) out += char;
  }
  return out;
}

const PAIR = /([A-Za-z0-9_.-]+(?:\/[0-9]+)?)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s;"]+))/g;

/**
 * The results in one Authentication-Results value. The authserv-id leads the
 * value and is skipped; some servers (Exchange Online among them) leave it out
 * and start with the first result.
 */
export function parseAuthenticationResults(value: string): AuthResult[] {
  const results: AuthResult[] = [];
  const parts = withoutComments(value).split(';');
  for (const [index, part] of parts.entries()) {
    // The authserv-id is a host, maybe with a version, and never starts as `name=`.
    if (index === 0 && !/^\s*[A-Za-z0-9_.-]+(?:\/[0-9]+)?\s*=/.test(part)) continue;
    const pairs = [...part.matchAll(PAIR)];
    const first = pairs[0];
    if (!first) continue;
    const props: Record<string, string> = {};
    for (const pair of pairs.slice(1))
      props[(pair[1] as string).toLowerCase()] = (pair[2] ?? pair[3] ?? '').trim();
    results.push({
      method: (first[1] as string).toLowerCase().replace(/\/[0-9]+$/, ''),
      result: (first[2] ?? first[3] ?? '').trim().toLowerCase(),
      props,
    });
  }
  return results;
}

/** The domain an identity is in: an address, `@domain`, or a bare domain. */
const domainOf = (identity: string | undefined): string | null =>
  identity ? registrableDomain(identity.replace(/^.*@/, '')) : null;

/**
 * Whether the topmost Authentication-Results header authenticates the sender
 * for the domain of every From address.
 */
export function senderAuthentication(
  topmost: string | null | undefined,
  fromAddresses: readonly string[],
): SenderAuth {
  if (!topmost || fromAddresses.length === 0) return 'none';
  const domains = new Set(fromAddresses.map((address) => registrableDomain(address)));
  const [domain] = [...domains];
  if (domains.size !== 1 || !domain) return 'none';
  const results = parseAuthenticationResults(topmost).filter((entry) =>
    ['dmarc', 'dkim', 'spf'].includes(entry.method),
  );
  if (results.length === 0) return 'none';
  if (results.some((entry) => entry.method === 'dmarc' && entry.result === 'fail')) return 'fail';
  const aligned = (identity: string | undefined) => domainOf(identity) === domain;
  const pass = results.some(
    (entry) =>
      entry.result === 'pass' &&
      ((entry.method === 'dmarc' && aligned(entry.props['header.from'])) ||
        (entry.method === 'dkim' &&
          (aligned(entry.props['header.d']) || aligned(entry.props['header.i']))) ||
        (entry.method === 'spf' && aligned(entry.props['smtp.mailfrom']))),
  );
  return pass ? 'pass' : 'fail';
}
