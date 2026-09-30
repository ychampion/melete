/**
 * How a connector says what went wrong.
 *
 * Connectors throw `ConnectorFaultError`. The broker's repair policy reads the
 * class off the error rather than matching on a message, so the difference
 * between a socket that closed before the request left and a destination that
 * accepted the request and lost its acknowledgement is a field, not a guess.
 *
 * Anything thrown that is not one of these is treated as `unclassified` and is
 * never retried, which is the same thing the broker did before this file
 * existed. Typing a fault can only make a failure more repairable, never less.
 */
import {
  type ConnectorFault,
  type ConnectorFaultKind,
  connectorFault,
  type EffectClass,
  type JsonObject,
} from '@melete/contracts';

export class ConnectorFaultError extends Error {
  readonly fault: ConnectorFault;

  constructor(input: {
    kind: ConnectorFaultKind;
    detail: string;
    may_have_committed?: boolean;
    retry_after?: number | null;
  }) {
    super(input.detail);
    this.name = 'ConnectorFaultError';
    this.fault = connectorFault.parse({
      kind: input.kind,
      detail: input.detail,
      may_have_committed: input.may_have_committed ?? false,
      retry_after: input.retry_after ?? null,
    });
  }
}

/** A fault raised by an interface the broker does not own reads as unclassified. */
export function asConnectorFault(error: unknown): ConnectorFault | null {
  if (error instanceof ConnectorFaultError) return error.fault;
  if (error && typeof error === 'object' && 'fault' in error) {
    const parsed = connectorFault.safeParse((error as { fault: unknown }).fault);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * The honest default for a failure nobody classified.
 *
 * `may_have_committed` is true because it has to be: an untyped throw says
 * nothing about whether the request left, so the effect is treated as one that
 * might have landed. The policy therefore never retries it and never invents a
 * verdict for it; the action rests at unknown and reconciliation is a separate,
 * deliberate step, which is what the broker did before faults were typed.
 */
export const UNCLASSIFIED_DETAIL = 'The destination did not return a confirmed acknowledgement';

/**
 * A read changes nothing, so "it may have landed" is never true of one. An
 * untyped throw from a read is a failed read with its reason, which the model
 * can act on; only an effect that changes something can be left uncertain.
 */
export function unclassifiedFault(error: unknown, effectClass?: EffectClass): ConnectorFault {
  if (effectClass === 'read')
    return connectorFault.parse({
      kind: 'unclassified',
      detail: describeFailure(error),
      may_have_committed: false,
      retry_after: null,
    });
  return connectorFault.parse({
    kind: 'unclassified',
    detail: UNCLASSIFIED_DETAIL,
    may_have_committed: true,
    retry_after: null,
  });
}

/**
 * The fault a read reports, whoever classified it. Nothing a read does can
 * have committed, and an uncertain outcome of a read is just a read to repeat.
 */
export function readFault(fault: ConnectorFault): ConnectorFault {
  if (fault.kind === 'uncertain_outcome')
    return { ...fault, kind: 'transient_before_dispatch', may_have_committed: false };
  return fault.may_have_committed ? { ...fault, may_have_committed: false } : fault;
}

const SYSTEM_FAILURES: Record<string, string> = {
  ENOENT: 'not found',
  ENOTDIR: 'not a folder',
  EISDIR: 'a folder, not a file',
  EACCES: 'permission denied',
  EPERM: 'permission denied',
  ETIMEDOUT: 'timed out',
  ECONNREFUSED: 'the destination refused the connection',
  ECONNRESET: 'the connection was reset',
  ENOTFOUND: 'the address could not be found',
  EAI_AGAIN: 'the address could not be looked up',
};

/**
 * One short line saying why a read failed, safe to show the model and to keep
 * on the record: system errors by their code, anything else by the first line
 * of its message with host paths and address query strings taken out.
 */
export function describeFailure(error: unknown): string {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  const known = SYSTEM_FAILURES[code];
  if (known) return known;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
    return 'timed out';
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const line = (message.split(/\r?\n/, 1)[0] ?? '')
    .replace(/(?<=^|[\s'"(=])(?:[A-Za-z]:)?[\\/][^\s'"]*/g, '<path>')
    .replace(/(https?:\/\/[^\s'"?#]+)[?#][^\s'"]*/g, '$1')
    .trim()
    .slice(0, 200);
  return line || 'the read failed';
}

/**
 * What one execution of a connector is told about its own repair history: which
 * attempt this is, which authorized route the policy chose, and the mapping
 * already applied to the payload it was handed. Nothing here can change the
 * recipient, the amount or the resource; those live in the action, which the
 * policy is not allowed to rewrite.
 */
export type RepairAttemptContext = {
  attempt: number;
  route: string | null;
  mapping: Record<string, string> | null;
};

/**
 * What re-discovery found. A connector answers `describe()` with the shape the
 * destination wants now; the policy compares it with the shape that was sent
 * and proposes a mapping, which is a record, not a change.
 */
export type ConnectorDescription = {
  /** Fields the destination requires now, in its own spelling. */
  required: string[];
  /** Fields it accepts and does not require, so they are not read as surplus. */
  optional?: string[];
  /**
   * Renames the connector itself vouches for: old field name to new field name,
   * same meaning. A repair may apply only what is declared here. Nothing infers
   * an equivalence from two field names lining up, because two field names
   * lining up is what a recipient and a memo look like from outside.
   */
  equivalent_fields?: Record<string, string>;
  /** The full schema, carried opaquely for the candidate record. */
  schema?: JsonObject;
};
