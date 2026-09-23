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
import { configuredProviders, providerSignIn } from '../gateway/configured.ts';
import type { GatewayOptions } from '../gateway/index.ts';
import type { GatewayProvider } from '../gateway/types.ts';
import type { JobService } from '../jobs/service.ts';
import type { TriggerService } from '../jobs/triggers.ts';
import type { CompanyExtractor, ScanExtractor } from './extract.ts';
import { DEFAULT_EXTRACTION_MODEL, openExtractionGateway } from './gateway.ts';
import { playbookHandler } from './handler.ts';
import { connectorMailbox, MAILBOX_READ_LIMIT, type ScanMailbox } from './mailbox.ts';
import { type Owner, PostgresCompanyStore } from './repository.ts';
import type { CompaniesDeps } from './routes.ts';
import { scriptedExtractor } from './scripted.ts';

/** Calls one scan's gateway admits: one per message, and a scan reads at most this many. */
export const SCAN_CALL_CEILING = MAILBOX_READ_LIMIT;

/**
 * The live extractor. Each scan opens a gateway of its own with its own call
 * budget and closes it when the scan ends, as `openExtractionGateway` is built
 * to be used, so one person's scans can never spend another's. A call made
 * outside a scan gets a gateway for that call alone.
 */
export function gatewayExtractor(options: {
  provider: string;
  model: string;
  providers: GatewayProvider[];
  fetch?: GatewayOptions['fetch'];
}): CompanyExtractor {
  const open = async (): Promise<ScanExtractor> => {
    const gateway = await openExtractionGateway({
      provider: options.provider,
      model: options.model,
      providers: options.providers,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      maxCalls: SCAN_CALL_CEILING,
    });
    return {
      extract: (request) => gateway.extractor.extract(request),
      close: gateway.close,
      unanswered: gateway.unanswered,
    };
  };
  return {
    async extract(request) {
      const once = await open();
      try {
        return await once.extract(request);
      } finally {
        await once.close();
      }
    },
    forScan: open,
  };
}

/** Model calls one person's scans may make in a day when the operator sets none. */
export const DEFAULT_DAILY_SCAN_CALLS = 500;

/**
 * The daily allowance of model calls per person, when a live model runs.
 * `MELETE_COMPANIES_DAILY_CALLS` sets it; a scripted scan spends nothing and has none.
 */
export function configuredDailyCalls(): number | undefined {
  if (!process.env.MELETE_COMPANIES_MODEL?.trim()) return undefined;
  const raw = Number(process.env.MELETE_COMPANIES_DAILY_CALLS);
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_DAILY_SCAN_CALLS;
}

/**
 * Which extractor this deployment runs. `MELETE_COMPANIES_MODEL` is the switch:
 * absent, the scan is scripted and deterministic, which is what a demonstration
 * and every test want.
 */
export function configuredExtractor(env: Env, sql?: Sql): CompanyExtractor {
  const model = process.env.MELETE_COMPANIES_MODEL?.trim();
  if (!model) return scriptedExtractor();
  const provider = process.env.MELETE_COMPANIES_PROVIDER?.trim() ?? env.MELETE_DEFAULT_PROVIDER;
  return gatewayExtractor({
    provider,
    model: model === 'default' ? DEFAULT_EXTRACTION_MODEL : model,
    providers: configuredProviders(env, () => {}, sql ? providerSignIn(sql, env) : undefined),
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

/**
 * The mail connection a space sends from, if it has one: its own active
 * connection holding the `email.send` scope, chosen the way sign-in already
 * chooses one. A space with nothing to send from still gets a job and a draft;
 * the job simply has no deliverable, and the person is not told otherwise.
 */
export function spaceSendConnection(options: { sql: Sql }) {
  return async (owner: Owner): Promise<string | null> => {
    const rows = await options.sql`select id from connection
      where space_id = ${owner.spaceId} and status = 'active' and scopes ? 'email.send'
      order by id limit 1`;
    const id = rows[0]?.id;
    return id ? String(id) : null;
  };
}

/** Everything the routes need, from what the service already built. */
export function companiesDeps(options: {
  db: Database;
  sql?: Sql;
  registry?: ConnectorRegistry;
  env: Env;
  jobs?: JobService;
  triggers?: TriggerService;
}): CompaniesDeps {
  const { jobs, triggers } = options;
  return {
    db: options.db,
    store: new PostgresCompanyStore(options.db),
    mailbox:
      options.sql && options.registry
        ? spaceMailbox({ sql: options.sql, registry: options.registry })
        : () => null,
    extractor: configuredExtractor(options.env, options.sql),
    ...(configuredDailyCalls() === undefined ? {} : { dailyCalls: configuredDailyCalls() }),
    // Without a job service there is nothing to create a job on, and the route's
    // stub refuses. The route records `job_id` and `handling` itself once this
    // returns an id, so the handler is given no `onStatusChange` of its own.
    ...(jobs
      ? {
          handler: playbookHandler({
            createJob: (input) => jobs.create(input),
            ...(triggers ? { createTrigger: (id, spec) => triggers.create(id, spec) } : {}),
          }),
        }
      : {}),
    ...(options.sql ? { sendConnection: spaceSendConnection({ sql: options.sql }) } : {}),
  };
}
