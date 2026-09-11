import type { Action, DispatchResult, JsonObject } from '@melete/contracts';
import { PgBoss } from 'pg-boss';
import { BrokerService } from '../../src/broker/service.ts';
import { createTestConnector, initializeTestLedger } from '../../src/connectors/test.ts';
import type { Connector, ConnectorContext } from '../../src/connectors/types.ts';
import { QUEUES } from '../../src/jobs/queue.ts';
import { seedJob } from './broker.ts';
import { createPostgresFixture } from './postgres.ts';

export function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Each scenario file owns its database, queue, and destination ledger. */
export async function createConformanceFixture() {
  const fixture = await createPostgresFixture();
  if (!fixture) return null;
  const boss = new PgBoss({ connectionString: fixture.url, max: 2 });
  boss.on('error', () => {});
  try {
    await initializeTestLedger(fixture.sql);
    await boss.start();
    await boss.createQueue(QUEUES.attempt);
  } catch (error) {
    await boss.stop({ graceful: true, timeout: 5_000 });
    await fixture.close();
    throw error;
  }
  return {
    sql: fixture.sql,
    boss,
    async close() {
      try {
        await boss.stop({ graceful: true, timeout: 5_000 });
      } finally {
        await fixture.close();
      }
    },
    async setup(
      options: {
        verify?: boolean;
        dispatchTimeoutMs?: number;
        execute?: (
          action: Action,
          ctx: ConnectorContext,
          destination: Connector,
        ) => Promise<DispatchResult>;
      } = {},
    ) {
      const seed = await seedJob(fixture.sql, { scopes: ['test.send'] });
      const destination = createTestConnector(fixture.sql, { verify: options.verify });
      let executions = 0;
      const connector: Connector = {
        ...destination,
        async execute(action, ctx) {
          executions += 1;
          return options.execute
            ? options.execute(action, ctx, destination)
            : destination.execute(action, ctx);
        },
      };
      const resolver = { get: (id: string) => (id === seed.connectionId ? connector : undefined) };
      const restart = () =>
        new BrokerService({
          sql: fixture.sql,
          connectors: resolver,
          boss,
          dispatchTimeoutMs: options.dispatchTimeoutMs,
        });
      const broker = restart();
      const approve = async (payload: JsonObject, clientRef?: string) => {
        const proposal = await broker.propose(seed.claims, {
          kind: 'test.send',
          connection_id: seed.connectionId,
          payload,
          ...(clientRef ? { client_ref: clientRef } : {}),
        });
        await broker.decide(proposal.action_id, {
          decision: 'approved',
          payload_hash: proposal.payload_hash,
        });
        return proposal;
      };
      const send = async (payload: JsonObject, clientRef?: string) => {
        const proposed = await approve(payload, clientRef);
        await broker.admit(seed.claims, proposed.action_id, proposed.payload_hash);
        return broker.dispatch(proposed.action_id);
      };
      return {
        ...seed,
        sql: fixture.sql,
        broker,
        restart,
        approve,
        send,
        executions: () => executions,
      };
    },
  };
}
