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

export function unclassifiedFault(_error: unknown): ConnectorFault {
  return connectorFault.parse({
    kind: 'unclassified',
    detail: UNCLASSIFIED_DETAIL,
    may_have_committed: true,
    retry_after: null,
  });
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
  /** The full schema, carried opaquely for the candidate record. */
  schema?: JsonObject;
};
