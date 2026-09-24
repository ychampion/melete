import type { SecureContextOptions } from 'node:tls';
import { ID_PREFIXES, prefixedId } from '@melete/contracts';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PgBoss } from 'pg-boss';
import type { Sql } from 'postgres';
import { createActionReadApi } from '../api/actions.ts';
import type { ArtifactRoots } from '../artifact/content.ts';
import { type ArtifactCritic, createArtifactRecorder } from '../artifact/record.ts';
import { schema } from '../db/schema.ts';
import { serviceTransaction } from '../db/transaction.ts';
import { createModelGateway, type GatewayOptions, type GatewayProvider } from '../gateway/index.ts';
import { EngineSkillService } from '../learning/engine-skills.ts';
import { learningRuntimeFetch } from '../learning/runtime-route.ts';
import { matchesServiceKey } from './capability.ts';
import { PostgresGatewayBudget } from './gateway-budget.ts';
import { createBrokerApp } from './http.ts';
import { type BrokerOptions, BrokerService } from './service.ts';

/** Both broker routes and model traffic share the runtime's one internal HTTP exit. */
export function createInternalServer(options: {
  sql: Sql;
  connectors: BrokerOptions['connectors'];
  capabilityKey: string;
  approvalKey: string;
  boss?: PgBoss;
  providers?: GatewayProvider[];
  defaultProvider?: string;
  defaultMaxTokens?: GatewayOptions['defaultMaxTokens'];
  dispatchTimeoutMs?: number;
  resolveAuthority?: BrokerOptions['resolveAuthority'];
  resolveTrust?: BrokerOptions['resolveTrust'];
  approvalTtlMs?: number;
  catalog?: BrokerOptions['catalog'];
  composeExecutor?: BrokerOptions['composeExecutor'];
  resolveStandingGrant?: BrokerOptions['resolveStandingGrant'];
  resolveScopedGrant?: BrokerOptions['resolveScopedGrant'];
  recordStandingScope?: BrokerOptions['recordStandingScope'];
  /** A broker the service already built, shared with its own routes. */
  broker?: BrokerService;
  gatewayFetch?: GatewayOptions['fetch'];
  /** The service runner finalizes its attempt before the job changes state. */
  deferApprovalWaitToRunner?: boolean;
  /** A scripted stand-in for the model, for the local end-to-end runs. */
  fake?: GatewayOptions['fake'];
  /** Advisory model review of a written artifact. Unset means none is run. */
  artifactCritic?: ArtifactCritic;
  artifactRoots?: ArtifactRoots;
  connectTls?: (host: string) => Pick<SecureContextOptions, 'key' | 'cert' | 'ca'> | undefined;
}) {
  const broker =
    options.broker ??
    new BrokerService({
      sql: options.sql,
      connectors: options.connectors,
      boss: options.boss,
      dispatchTimeoutMs: options.dispatchTimeoutMs,
      resolveAuthority: options.resolveAuthority,
      resolveTrust: options.resolveTrust,
      approvalTtlMs: options.approvalTtlMs,
      // A declared write becomes an artifact row with its checks beside it, in
      // the same transaction that persists the receipt.
      recordArtifact: createArtifactRecorder(options.artifactCritic, options.artifactRoots),
      estimateSpend: (action) => {
        const capability = options.connectors.get(action.connection_id)?.capability;
        return capability?.available && capability.kind === action.kind
          ? capability.unit_cost_usd
          : Number.NaN;
      },
      catalog: options.catalog,
      composeExecutor: options.composeExecutor,
      deferApprovalWaitToRunner: options.deferApprovalWaitToRunner,
      resolveStandingGrant: options.resolveStandingGrant,
      resolveScopedGrant: options.resolveScopedGrant,
      recordStandingScope: options.recordStandingScope,
    });
  const app = createBrokerApp({
    broker,
    capabilityKey: options.capabilityKey,
    approvalKey: options.approvalKey,
  });
  const budget = new PostgresGatewayBudget({
    sql: options.sql,
    capabilityKey: options.capabilityKey,
  });
  const reads = createActionReadApi({
    sql: options.sql,
    authorizeSpace: async (request) => {
      if (
        !matchesServiceKey(request.headers.get('authorization') ?? undefined, options.approvalKey)
      )
        return null;
      const space = prefixedId(ID_PREFIXES.space).safeParse(
        request.headers.get('x-melete-space-id'),
      );
      return space.success ? space.data : null;
    },
  });
  // The skills the engine writes arrive here from the plugin in its cell, under the
  // attempt's capability, and are admitted in the service's own transactions.
  const db = drizzle(options.sql, { schema });
  const catalogSkills = options.catalog?.skills;
  const skills = new EngineSkillService(
    { transaction: (operation) => serviceTransaction(db, operation) },
    catalogSkills
      ? async (spaceId) => (await catalogSkills(spaceId)).map((skill) => skill.frontmatter.name)
      : undefined,
  );
  const server = createModelGateway({
    authenticate: (token) => budget.authenticate(token),
    budget,
    providers: options.providers,
    defaultProvider: options.defaultProvider,
    defaultMaxTokens: options.defaultMaxTokens,
    fake: options.fake,
    connectTls: options.connectTls,
    fetch: options.gatewayFetch,
    brokerFetch: learningRuntimeFetch({
      sql: options.sql,
      capabilityKey: options.capabilityKey,
      broker,
      skills,
      onError: (error) =>
        process.stderr.write(
          `learning route: ${error instanceof Error ? error.message : 'unknown error'}\n`,
        ),
      fallback: (request) =>
        request.method === 'GET' && new URL(request.url).pathname === '/actions'
          ? reads.fetch(request)
          : app.fetch(request),
    }),
    onError: (error) => process.stderr.write(`model gateway: ${error.message}\n`),
  });
  return { server, broker, budget };
}
