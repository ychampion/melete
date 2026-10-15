import type { ProviderFailure } from '@melete/contracts';
import { GatewayError } from './types.ts';

/**
 * A provider's refusal, read for its class alone. The provider's text is read
 * here to tell, say, a spent account from a busy one, and goes no further: the
 * engine and the person get the class and a status that says the same thing.
 */
export function classifyProviderFailure(status: number, text: string): ProviderFailure | null {
  const said = text.toLowerCase();
  // Spent credit is reported as 429 by some providers and 400 or 403 by others.
  if (
    status === 402 ||
    /insufficient_quota|exceeded your current quota|credit balance|insufficient (?:credits|funds|balance)|out of credits/.test(
      said,
    )
  )
    return 'quota';
  if (status === 401 || status === 403) return 'key_refused';
  if (status === 429) return 'rate_limited';
  if (
    status === 413 ||
    /context[_ ]length|context window|maximum context|prompt is too long|too many tokens|input is too long|reduce the length/.test(
      said,
    )
  )
    return 'context_too_long';
  if (
    status === 404 ||
    /model[_ ]not[_ ]found|model .{0,80}(?:does not exist|not found|is not available)|invalid model|unknown model|no such model|has been deprecated/.test(
      said,
    )
  )
    return 'model_not_found';
  if (status === 408 || status >= 500) return 'provider_down';
  return null;
}

/**
 * What the engine is told for each class. The status is one its own retry
 * rules read the right way: a refused key, a spent account and a missing model
 * are not tried again, a long conversation is compacted, and a busy or failing
 * provider is waited on.
 */
const STATUS: Record<ProviderFailure, number> = {
  key_refused: 401,
  quota: 402,
  rate_limited: 429,
  model_not_found: 404,
  context_too_long: 413,
  provider_down: 502,
};

/** The code the engine sees; the adapter reads the class back out of it. */
export const providerFailureCode = (failure: ProviderFailure) =>
  failure === 'provider_down' ? 'provider_down' : `provider_${failure}`;

export function providerFailureError(failure: ProviderFailure): GatewayError {
  return new GatewayError(STATUS[failure], providerFailureCode(failure));
}
