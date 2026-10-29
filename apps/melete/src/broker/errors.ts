import type { BrokerErrorCode } from '@melete/contracts';
import type { ErrorObject } from 'ajv';
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

/**
 * What a tool's input schema refused, in the same words as `inputProblem`:
 * the field and what it needs, from the schema, never the value sent.
 */
export function schemaProblem(errors: readonly ErrorObject[] | null | undefined): string {
  const named = (errors ?? []).slice(0, NAMED_ISSUES).map((issue) => {
    const at = issue.instancePath.split('/').filter(Boolean).join('.');
    const params = issue.params as Record<string, unknown>;
    if (issue.keyword === 'required')
      return `${[at, String(params.missingProperty)].filter(Boolean).join('.')}: missing`;
    if (issue.keyword === 'additionalProperties')
      return `${[at, String(params.additionalProperty)].filter(Boolean).join('.')}: not a field this tool takes`;
    const field = at || 'input';
    if (issue.keyword === 'enum' && Array.isArray(params.allowedValues))
      return `${field}: must be one of ${params.allowedValues.map(String).join(', ')}`;
    return `${field}: ${issue.message ?? 'not accepted'}`;
  });
  return named.length ? `The arguments were not accepted. ${named.join('; ')}` : 'Invalid input.';
}
