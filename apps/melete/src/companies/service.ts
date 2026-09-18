/**
 * What the service needs to serve a company map, built from what it already
 * has: the database it runs on, the connector registry it built at start-up,
 * and the environment that decides whether a real model is available.
 *
 * The extractor is chosen here and nowhere else. Without a configured model and
 * a provider key the scan uses the scripted extractor, which needs no network
 * and returns the same map twice; with them it uses the gateway, which holds the
 * key. Both answer the same interface, so nothing downstream knows which ran.
 */

import type { Sql } from 'postgres';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import type { Database } from '../db/client.ts';
import type { Env } from '../env.ts';
import { configuredProviders } from '../gateway/configured.ts';
import type { CompanyExtractor } from './extract.ts';
import { DEFAULT_EXTRACTION_MODEL, openExtractionGateway } from './gateway.ts';
import { connectorMailbox, type ScanMailbox } from './mailbox.ts';
import { type Owner, PostgresCompanyStore } from './repository.ts';
import type { CompaniesDeps } from './routes.ts';
import { scriptedExtractor } from './scripted.ts';

/** Calls one process will admit before it must be restarted. A scan reads at most fifty messages. */
const GATEWAY_CALL_CEILING = 5_000;

/**
 * The live extractor, opened on the first call and kept for the process. A
 * gateway is a loopback listener; opening one per scan would be a listener per
 * click, and closing one mid-scan would fail the call in flight.
 */
function lazyGatewayExtractor(options: {
  provider: string;
  model: string;
  env: Env;
}): CompanyExtractor {
  let opened: Promise<{ extractor: CompanyExtractor }> | undefined;
  return {
    async extract(request) {
      opened ??= openExtractionGateway({
        provider: options.provider,
        model: options.model,
        providers: configuredProviders(options.env, () => {}),
        maxCalls: GATEWAY_CALL_CEILING,
      });
      return (await opened).extractor.extract(request);
    },
  };
}

/**
 * Which extractor this deployment runs. `MELETE_COMPANIES_MODEL` is the switch:
 * absent, the scan is scripted and deterministic, which is what a demonstration
 * and every test want.
 */
export function configuredExtractor(env: Env): CompanyExtractor {
  const model = process.env.MELETE_COMPANIES_MODEL?.trim();
  if (!model) return scriptedExtractor();
  const provider = process.env.MELETE_COMPANIES_PROVIDER?.trim() ?? env.MELETE_DEFAULT_PROVIDER;
  return lazyGatewayExtractor({
    provider,
    model: model === 'default' ? DEFAULT_EXTRACTION_MODEL : model,
    env,
  });
}

/**
 * The mailbox a space has, if it has one: its own active IMAP connection, read
 * through the connector the owner installed. A space with no mail connected has
 * no mailbox, and the scan route says so rather than scanning nothing.
 */
export function spaceMailbox(options: { sql: Sql; registry: ConnectorRegistry }) {
  return async (owner: Owner): Promise<ScanMailbox | null> => {
    const rows = await options.sql`select id from connection
      where space_id = ${owner.spaceId} and provider = 'imap' and status = 'active'
      order by id limit 1`;
    const id = rows[0]?.id;
    if (!id) return null;
    return connectorMailbox({
      registry: options.registry,
      connectionId: String(id),
      spaceId: owner.spaceId,
      undatedAt: new Date().toISOString(),
    });
  };
}

/** Everything the routes need, from what the service already built. */
export function companiesDeps(options: {
  db: Database;
  sql?: Sql;
  registry?: ConnectorRegistry;
  env: Env;
}): CompaniesDeps {
  return {
    db: options.db,
    store: new PostgresCompanyStore(options.db),
    mailbox:
      options.sql && options.registry
        ? spaceMailbox({ sql: options.sql, registry: options.registry })
        : () => null,
    extractor: configuredExtractor(options.env),
  };
}
