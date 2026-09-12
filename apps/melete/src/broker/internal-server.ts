import type { SecureContextOptions } from 'node:tls';
import { ID_PREFIXES, prefixedId } from '@melete/contracts';
import type { PgBoss } from 'pg-boss';
import type { Sql } from 'postgres';
import { createActionReadApi } from '../api/actions.ts';
import type { ArtifactRoots } from '../artifact/content.ts';
import { type ArtifactCritic, createArtifactRecorder } from '../artifact/record.ts';
import { createModelGateway, type GatewayOptions, type GatewayProvider } from '../gateway/index.ts';
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
  dispatchTimeoutMs?: number;
  resolveAuthority?: BrokerOptions['resolveAuthority'];
  resolveTrust?: BrokerOptions['resolveTrust'];
  approvalTtlMs?: number;
  catalog?: BrokerOptions['catalog'];
  composeExecutor?: BrokerOptions['composeExecutor'];
  gatewayFetch?: GatewayOptions['fetch'];
  /** A scripted stand-in for the model, for the local end-to-end runs. */
  fake?: GatewayOptions['fake'];
  /** Advisory model review of a written artifact. Unset means none is run. */
  artifactCritic?: ArtifactCritic;
  artifactRoots?: ArtifactRoots;
  connectTls?: (host: string) => Pick<SecureContextOptions, 'key' | 'cert' | 'ca'> | undefined;
}) {
  const broker = new BrokerService({
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
  const server = createModelGateway({
    authenticate: (token) => budget.authenticate(token),
    budget,
    providers: options.providers,
    defaultProvider: options.defaultProvider,
    fake: options.fake,
    connectTls: options.connectTls,
    fetch: options.gatewayFetch,
    brokerFetch: (request) =>
      request.method === 'GET' && new URL(request.url).pathname === '/actions'
        ? reads.fetch(request)
        : app.fetch(request),
    onError: (error) => process.stderr.write(`model gateway: ${error.message}\n`),
  });
  return { server, broker, budget };
}
