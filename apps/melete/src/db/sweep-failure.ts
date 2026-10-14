/**
 * What a background sweep does when one of its items fails. Most failures
 * belong to that item (a broken row, a check it did not pass): the item is
 * logged and left, and the sweep goes on to the rest. A failure that means the
 * database itself is out of reach is different: every other item would fail
 * the same way, each with its own connection attempt and log line, so the
 * sweep stops there and the next one tries again.
 */
import { DrizzleQueryError } from 'drizzle-orm';
import { redactSecrets } from '../connectors/faults.ts';

/** Codes postgres.js and the socket under it give when the database cannot be reached at all. */
const UNREACHABLE = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
  'CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
]);

/** A failed Drizzle query wraps the driver's error; the driver's is the one that says why. */
function underlying(error: unknown): unknown {
  let failure = error;
  while (failure instanceof DrizzleQueryError) failure = failure.cause;
  return failure;
}

/** Whether `error` means the database is out of reach, rather than that one item failed. */
export function databaseUnreachable(error: unknown): boolean {
  const code = (underlying(error) as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== 'string') return false;
  // SQLSTATE class 08 is a connection exception; 57P01-57P03 a server shutting down or starting.
  return UNREACHABLE.has(code) || /^08[0-9A-Z]{3}$/.test(code) || /^57P0[123]$/.test(code);
}

/**
 * The failure as one log line may carry it: the error's own message, never the
 * statement or the values it was sent with. A failed Drizzle query quotes both,
 * and those values are people's titles, reports and results, so the driver's
 * message is used instead. Credentials a message may quote are taken out.
 */
export function failureMessage(error: unknown): string {
  const failure = underlying(error);
  const text =
    failure instanceof Error
      ? failure.message
      : failure === undefined
        ? 'query failed'
        : String(failure);
  return redactSecrets(text.replace(/\s*\n\s*/g, ' '), 300);
}
