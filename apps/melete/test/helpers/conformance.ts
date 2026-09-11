import type { Action, CapabilityClaims, DispatchResult, JsonObject } from '@melete/contracts';
import { PgBoss } from 'pg-boss';
import { recordId } from '../../src/broker/records.ts';
import {
  type BrokerOptions,
  BrokerService,
  type StandingGrantResolver,
} from '../../src/broker/service.ts';
import type { TrustResolver } from '../../src/broker/trust.ts';
import { createTestConnector, initializeTestLedger } from '../../src/connectors/test.ts';
import type { Connector, ConnectorContext } from '../../src/connectors/types.ts';
import { QUEUES } from '../../src/jobs/queue.ts';
import { seedJob } from './broker.ts';
import { createPostgresFixture, type PostgresFixtureOptions } from './postgres.ts';

export function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Each scenario file owns its database, queue, and destination ledger. */
export async function createConformanceFixture(options: PostgresFixtureOptions = {}) {
  const fixture = await createPostgresFixture(options);
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
        /** Where the values in a payload came from; absent means nobody asks. */
        resolveTrust?: TrustResolver;
        /** Whether a standing grant covers the effect; absent means none does. */
        resolveStandingGrant?: StandingGrantResolver;
        /** Re-open an output that failed validation; absent means none can be. */
        reviseOutput?: BrokerOptions['reviseOutput'];
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
          resolveTrust: options.resolveTrust,
          resolveStandingGrant: options.resolveStandingGrant,
          reviseOutput: options.reviseOutput,
        });
      const broker = restart();
      /**
       * End the live attempt the way a kill does and open the next one at the
       * bumped epoch. The job, its revision and its connection are unchanged,
       * so a proposal of the same payload is the same intended effect.
       */
      const nextAttempt = async (): Promise<CapabilityClaims> => {
        await fixture.sql`update attempt set outcome = 'fenced', ended_at = now()
          where job_id = ${seed.claims.job_id} and outcome is null`;
        const [job] = await fixture.sql`update job set lease_epoch = lease_epoch + 1
          where id = ${seed.claims.job_id} returning lease_epoch, revision`;
        const attemptId = recordId('att');
        await fixture.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
          values (${attemptId}, ${seed.claims.job_id}, ${job?.lease_epoch}, 'fake', 'fake', 'scripted')`;
        return {
          ...seed.claims,
          attempt_id: attemptId,
          epoch: job?.lease_epoch as number,
          revision: job?.revision as number,
        };
      };
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
        /** The bare destination, for a control that deliberately skips the policy. */
        destination,
        broker,
        restart,
        approve,
        send,
        nextAttempt,
        executions: () => executions,
      };
    },
  };
}
