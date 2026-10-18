/**
 * What pages, identity assertions and entitlements need from the environment,
 * in one place, so the connectors that hand out report keys and the routes
 * that check them derive them alike.
 */
import { randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import type { McpCallServices } from '../connectors/mcp-connector.ts';
import type { Env } from '../env.ts';
import { IdentitySigner } from '../identity/assertion.ts';
import { DEFAULT_GATE_MESSAGE, entitlementsOf } from '../principals/entitlements.ts';
import { openPage, pageReportKey } from './service.ts';

/** Used when the installation has no key of its own: keys then last as long as the process. */
const PROCESS_SECRET = randomBytes(32).toString('hex');

type Keys = Pick<Env, 'MELETE_MASTER_KEY' | 'MELETE_CAPABILITY_KEY'>;

/** The installation's secret that page report keys, page views and identity keys come from. */
export function pageSecret(env: Partial<Keys>): string {
  return env.MELETE_MASTER_KEY || env.MELETE_CAPABILITY_KEY || PROCESS_SECRET;
}

/** Where a connection's server reaches this installation's API. */
export function reportBase(env: Partial<Pick<Env, 'MELETE_PUBLIC_URL' | 'PORT'>>): string {
  const pub = env.MELETE_PUBLIC_URL?.trim().replace(/\/+$/, '');
  return pub ? `${pub}/api` : `http://127.0.0.1:${env.PORT ?? 8787}`;
}

/**
 * Who signs identity assertions: the installation's API address, so a server
 * finds the keys at `<iss>/.well-known/jwks.json`.
 */
export function identityIssuer(env: Partial<Pick<Env, 'MELETE_PUBLIC_URL' | 'PORT'>>): string {
  return reportBase(env);
}

export function mcpServicesFromEnv(
  sql: Sql,
  env: Partial<Keys & Pick<Env, 'MELETE_PUBLIC_URL' | 'PORT' | 'MELETE_GATE_MESSAGE'>>,
): McpCallServices {
  const secret = pageSecret(env);
  return {
    pages: {
      reportBase: reportBase(env),
      reportKey: (pageId) => pageReportKey(secret, pageId),
      open: (input) => openPage(sql, input),
    },
    identity: new IdentitySigner(secret, identityIssuer(env)),
    entitlements: (query, principalId) => entitlementsOf(query, principalId),
    gateMessage: env.MELETE_GATE_MESSAGE ?? DEFAULT_GATE_MESSAGE,
  };
}
