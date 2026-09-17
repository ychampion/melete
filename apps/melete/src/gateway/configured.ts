import type { Env } from '../env.ts';
import { fakeProvider } from './fake.ts';
import {
  providerAddressProblem,
  providerKeyProblem,
  providerSelectionProblem,
  providersFromEnv,
} from './providers.ts';
import type { GatewayProvider } from './types.ts';

/**
 * The providers this service will route to. A selection that can never answer
 * stops start-up here, in the operator's terms; otherwise the first sign is a
 * refused model call inside an attempt.
 */
export function configuredProviders(
  env: Env,
  warn: (message: string) => void = (message) => process.stderr.write(`WARNING: ${message}\n`),
): GatewayProvider[] {
  const providers = [
    ...providersFromEnv({
      FIREWORKS_API_KEY: env.FIREWORKS_API_KEY,
      OPENAI_API_KEY: env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      GOOGLE_API_KEY: env.GOOGLE_API_KEY,
      OPENAI_COMPAT_BASE_URL: env.OPENAI_COMPAT_BASE_URL,
      OPENAI_COMPAT_API_KEY: env.OPENAI_COMPAT_API_KEY,
    }),
    ...(env.MELETE_ENABLE_FAKE_PROVIDER ? [fakeProvider] : []),
  ];
  const problem =
    providerSelectionProblem(env.MELETE_DEFAULT_PROVIDER, providers) ??
    providers.map(providerAddressProblem).find((found) => found !== null);
  if (problem) throw new Error(problem);
  const missingKey = providerKeyProblem(env.MELETE_DEFAULT_PROVIDER, providers);
  if (missingKey) warn(missingKey);
  return providers;
}
