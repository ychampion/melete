/** How the service builds its privacy router from its database and environment. */
import type { Sql } from 'postgres';
import type { Env } from '../env.ts';
import { modelApiMode, protocolForApiMode, providersFromEnv } from '../gateway/providers.ts';
import type { LocalModel } from './local.ts';
import type { Protocol } from './redact.ts';
import { PrivacyRouter } from './router.ts';
import { PostgresPrivacyStore } from './store.ts';

/** A local model named in the environment, until the owner saves one of their own. */
export function localModelFromEnv(env: Env): LocalModel | null {
  if (!env.MELETE_LOCAL_MODEL_URL || !env.MELETE_LOCAL_MODEL) return null;
  return {
    baseUrl: env.MELETE_LOCAL_MODEL_URL,
    model: env.MELETE_LOCAL_MODEL,
    ...(env.MELETE_LOCAL_MODEL_KEY ? { apiKey: env.MELETE_LOCAL_MODEL_KEY } : {}),
  };
}

export function servicePrivacyRouter(sql: Sql, env: Env): PrivacyRouter {
  return new PrivacyRouter({
    store: new PostgresPrivacyStore(sql, () => env.MELETE_MASTER_KEY),
    fallbackLocal: localModelFromEnv(env),
    onError: (error) => process.stderr.write(`privacy router: ${error.message}\n`),
  });
}

/** The protocol the engine speaks to the gateway for the configured model. */
export function engineProtocol(env: Env): Protocol {
  return protocolForApiMode(modelApiMode(env.MELETE_DEFAULT_PROVIDER, env.MELETE_DEFAULT_MODEL));
}

/** The configured provider's address, when the environment names one. */
export function providerAddress(env: Env): string | undefined {
  return providersFromEnv(env as unknown as Record<string, string | undefined>).find(
    (provider) => provider.name === env.MELETE_DEFAULT_PROVIDER,
  )?.baseUrl;
}

/**
 * How an attempt's own model is reached, for the privacy checks made before it
 * starts: the protocol it speaks and its address, from the address the owner
 * connected in the app when there is one, else the environment's.
 */
export function attemptEngine(
  env: Env,
  addresses?: { providerAddress(provider: string): Promise<string | undefined> },
): (model: { provider: string; model: string }) => Promise<{
  protocol: Protocol;
  providerUrl?: string;
}> {
  const configured = providersFromEnv(env as unknown as Record<string, string | undefined>);
  return async (model) => ({
    protocol: protocolForApiMode(modelApiMode(model.provider, model.model)),
    providerUrl:
      (await addresses?.providerAddress(model.provider)) ??
      configured.find((provider) => provider.name === model.provider)?.baseUrl,
  });
}
