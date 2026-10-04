import type { BrokerErrorCode } from '@melete/contracts';
import type { ZodError } from 'zod';

export class BrokerFault extends Error {
  constructor(
    public readonly code: BrokerErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}

/** Issues named in one refusal; the rest are found on the next try. */
const NAMED_ISSUES = 3;

/**
 * What was wrong with a tool's arguments, field by field, so the model can
 * correct the call instead of repeating it. It names fields and what each
 * needs, never the values sent.
 */
export function inputProblem(error: ZodError): string {
  const named = error.issues.slice(0, NAMED_ISSUES).map((issue) => {
    const field = issue.path.join('.') || 'input';
    const missing = issue.code === 'invalid_type' && /received undefined$/.test(issue.message);
    return `${field}: ${missing ? 'missing' : issue.message}`;
  });
  return named.length ? `The arguments were not accepted. ${named.join('; ')}` : 'Invalid input.';
}
