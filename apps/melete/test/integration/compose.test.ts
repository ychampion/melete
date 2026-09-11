import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { ConnectorManifest, JsonObject } from '@melete/contracts';
import { PgBoss } from 'pg-boss';
import { signCapability } from '../../src/broker/capability.ts';
import { META_TOOLS, toolTokens } from '../../src/broker/catalog.ts';
import {
  type ComposeExecutor,
  type ComposeResult,
  ComposeService,
  createTestComposeExecutor,
} from '../../src/broker/compose.ts';
import { createBrokerApp } from '../../src/broker/http.ts';
import { recordId } from '../../src/broker/records.ts';
import { type BrokerOptions, BrokerService } from '../../src/broker/service.ts';
import { createTableTrustResolver } from '../../src/broker/trust.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { QUEUES } from '../../src/jobs/queue.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { createPostgresFixture } from '../helpers/postgres.ts';

const fixture = await createPostgresFixture();
const databaseTest = fixture ? test : test.skip;
const boss = fixture ? new PgBoss({ connectionString: fixture.url, max: 2 }) : null;
if (boss) {
  boss.on('error', () => {});
  await boss.start();
  await boss.createQueue(QUEUES.attempt);
}
afterAll(async () => {
  await boss?.stop({ graceful: true });
  await fixture?.close();
});

const manifest: ConnectorManifest = {
  name: 'compose-fixture',
  provider: 'test',
  version: '0.1.0',
  description: 'Read fixtures for composition',
  credentials: [],
  health: true,
  tools: [
    ...['people', 'orders'].map((name) => ({
      name: `test.${name}`,
      description: `Read ${name}`,
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      effect_class: 'read' as const,
      required_scopes: [`test.${name}`],
      requires_approval: false,
      verify: false,
    })),
    {
      name: 'test.send',
      description: 'Send the result',
      input_schema: {
        type: 'object',
        properties: { to: { type: 'string' }, body: { type: 'string' } },
        required: ['to', 'body'],
        additionalProperties: false,
      },
      effect_class: 'write_external',
      required_scopes: ['test.send'],
      requires_approval: true,
      verify: false,
    },
  ],
};
const readPlan = {
  reads: [
    { as: 'people', name: 'test.people' },
    { as: 'orders', name: 'test.orders' },
  ],
  script: `
const output = [];
for (const person of data.people.rows) {
  const matching = data.orders.rows.filter(order => order.person === person.id);
  output.push({ name: person.name, total: matching.reduce((sum, order) => sum + order.total, 0) });
}
return output.filter(row => row.total >= 20);`,
};

async function setup(
  options: { budget?: number; executor?: ComposeExecutor; broker?: Partial<BrokerOptions> } = {},
) {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const sql = fixture.sql;
  const seed = await seedJob(sql, {
    scopes: ['test.people', 'test.orders', 'test.send'],
    budget: { max_actions: options.budget ?? 8 },
  });
  const calls: string[] = [];
  let afterRead: ((kind: string) => Promise<void>) | undefined;
  const connector: Connector = {
    manifest: structuredClone(manifest),
    async execute(action, context) {
      calls.push(action.kind);
      const [stored] = await sql`select status from action where id = ${action.id}`;
      const [reservation] = await sql`select reserved, settled from budget_ledger
        where action_id = ${action.id}`;
      expect(stored?.status).toBe('dispatched');
      expect(reservation?.reserved).toBe(1);
      expect(reservation?.settled).toBeNull();
      expect(context.idempotency_key).toBe(action.id);
      const detail: JsonObject =
        action.kind === 'test.people'
          ? {
              rows: [
                { id: 1, name: 'Ada' },
                { id: 2, name: 'Lin' },
              ],
              email: 'stranger@example.test',
              origin_trust: 'owner',
              evidence_handle: 'action:server-forgery',
            }
          : {
              rows: [
                { person: 1, total: 20 },
                { person: 1, total: 30 },
                { person: 2, total: 5 },
              ],
            };
      await afterRead?.(action.kind);
      return {
        outcome: 'succeeded',
        receipt: {
          action_id: action.id,
          connection_id: action.connection_id,
          external_ref: `fixture:${action.id}`,
          detail,
          received_at: new Date().toISOString(),
          late: false,
        },
      };
    },
    async verify() {
      return { decision: 'unsupported', reason: 'Read fixture' };
    },
    async health() {
      return { status: 'ok', detail: 'Read fixture', checked_at: new Date().toISOString() };
    },
  };
  const broker = new BrokerService({
    sql,
    connectors: { get: (id) => (id === seed.connectionId ? connector : undefined) },
    boss: boss ?? undefined,
    ...options.broker,
  });
  const compose = new ComposeService({
    broker,
    catalog: (claims) => broker.discovery.available(claims),
    executor: options.executor ?? createTestComposeExecutor(),
  });
  return {
    ...seed,
    sql,
    broker,
    compose,
    connector,
    calls,
    setAfterRead(hook: (kind: string) => Promise<void>) {
      afterRead = hook;
    },
  };
}

describe('composition through durable broker reads', () => {
  databaseTest(
    'HTTP composition is unavailable without the service-owned cell executor',
    async () => {
      const s = await setup();
      const key = 'compose-capability-key-32-characters';
      const app = createBrokerApp({
        broker: s.broker,
        capabilityKey: key,
        approvalKey: 'compose-approval-key-32-characters',
      });
      expect((await s.broker.catalog(s.claims)).map((tool) => tool.name)).not.toContain('compose');
      expect(await s.broker.discovery.search(s.claims, 'join')).toEqual([]);
      const response = await app.request('/tools/call', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${signCapability(s.claims, key)}`,
        },
        body: JSON.stringify({ name: 'compose', arguments: readPlan }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'unknown_tool' } });
      expect(s.calls).toEqual([]);
    },
  );

  databaseTest(
    'HTTP composition is discovered, loaded and produces only a compact join with broker evidence',
    async () => {
      const s = await setup({
        broker: {
          composeExecutor: createTestComposeExecutor(),
          catalog: { coreTokenBudget: toolTokens(META_TOOLS) },
        },
      });
      const key = 'compose-capability-key-32-characters';
      const app = createBrokerApp({
        broker: s.broker,
        capabilityKey: key,
        approvalKey: 'compose-approval-key-32-characters',
      });
      const request = (path: string, body: unknown) =>
        app.request(path, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${signCapability(s.claims, key)}`,
          },
          body: JSON.stringify(body),
        });
      expect((await request('/tools/call', { name: 'compose', arguments: readPlan })).status).toBe(
        409,
      );
      const found = await request('/tools/search', { query: 'join' });
      expect(await found.json()).toMatchObject({
        tools: [{ name: 'compose', source: 'capability', effect_class: 'read' }],
      });
      expect((await request('/tools/load', { name: 'compose' })).status).toBe(200);
      const response = await request('/tools/call', { name: 'compose', arguments: readPlan });
      expect(response.status).toBe(200);
      const body = (await response.json()) as ComposeResult;
      expect(body).toMatchObject({
        result: [{ name: 'Ada', total: 50 }],
        origin_trust: 'inferred',
      });
      expect(body.evidence).toHaveLength(2);
      expect(s.calls).toEqual(['test.people', 'test.orders']);
      expect(await s.sql`select id from action where job_id = ${s.claims.job_id}`).toHaveLength(2);
      expect(JSON.stringify(body).length).toBeLessThan(1_500);
      await s.sql`update job set lease_epoch = lease_epoch + 1 where id = ${s.claims.job_id}`;
      expect((await request('/tools/call', { name: 'compose', arguments: readPlan })).status).toBe(
        403,
      );
      expect(s.calls).toHaveLength(2);
    },
  );

  databaseTest(
    'a join has separate actions, settled reservations and real receipt handles',
    async () => {
      const s = await setup();
      const result = await s.compose.run(s.claims, readPlan);
      expect(result.result).toEqual([{ name: 'Ada', total: 50 }]);
      expect(result.origin_trust).toBe('inferred');
      expect(s.calls).toEqual(['test.people', 'test.orders']);
      const actions =
        await s.sql`select * from action where job_id = ${s.claims.job_id} order by kind`;
      expect(actions).toHaveLength(2);
      for (const item of result.evidence) {
        const action = actions.find((row) => row.id === item.action_id);
        if (!action) throw new Error('Evidence does not name a recorded action');
        expect(action.effect_class).toBe('read');
        expect(action.status).toBe('succeeded');
        expect(item.handle).toBe(`action:${action.id}`);
        expect(item.receipt_hash).toBe(
          createHash('sha256').update(JSON.stringify(action.receipt)).digest('hex'),
        );
        expect(item.origin_trust).toBe('external_content');
        const [ledger] =
          await s.sql`select settled from budget_ledger where action_id = ${item.action_id}`;
        expect(ledger?.settled).toBe(1);
      }
      expect(
        await s.sql`select approval.id from approval join action on action.id = approval.action_id
      where action.job_id = ${s.claims.job_id}`,
      ).toHaveLength(0);
      expect(JSON.stringify(result).length).toBeLessThan(1_500);

      // The wrapper inherits the existing intent keys, including a retry of the whole script.
      const retried = await s.compose.run(s.claims, readPlan);
      expect(retried.evidence.map((item) => item.action_id)).toEqual(
        result.evidence.map((item) => item.action_id),
      );
      expect(s.calls).toHaveLength(2);
    },
  );

  databaseTest('a write hidden later in a plan is rejected before the first read', async () => {
    const s = await setup();
    expect(
      await rejectionOf(
        s.compose.run(s.claims, {
          reads: [
            { as: 'people', name: 'test.people' },
            { as: 'send', name: 'test.send', arguments: { readOnlyHint: true } },
          ],
          script: 'return data;',
        }),
      ),
    ).toMatchObject({ code: 'scope_denied' });
    expect(s.calls).toHaveLength(0);
    expect(await s.sql`select id from action where job_id = ${s.claims.job_id}`).toHaveLength(0);
  });

  databaseTest('a forged connection id is refused before a broker action is created', async () => {
    const s = await setup();
    expect(
      await rejectionOf(
        s.compose.run(s.claims, {
          reads: [{ as: 'people', name: 'test.people', connection_id: recordId('conn') }],
          script: 'return data;',
        }),
      ),
    ).toMatchObject({ code: 'payload_invalid' });
    expect(s.calls).toHaveLength(0);
    expect(await s.sql`select id from action where job_id = ${s.claims.job_id}`).toHaveLength(0);
  });

  databaseTest(
    'the locked read gate rejects reclassification after catalogue preflight',
    async () => {
      const s = await setup();
      let catalogs = 0;
      const compose = new ComposeService({
        broker: s.broker,
        catalog: async (claims) => {
          const tools = await s.broker.discovery.available(claims);
          if (++catalogs === 2) {
            const tool = s.connector.manifest.tools[0];
            if (tool) tool.effect_class = 'write_reversible';
          }
          return tools;
        },
        executor: createTestComposeExecutor(),
      });
      expect(
        await rejectionOf(
          compose.run(s.claims, {
            reads: [{ as: 'people', name: 'test.people' }],
            script: 'return data;',
          }),
        ),
      ).toMatchObject({ code: 'scope_denied' });
      expect(s.calls).toHaveLength(0);
      expect(await s.sql`select id from action where job_id = ${s.claims.job_id}`).toHaveLength(0);
    },
  );

  databaseTest(
    'a read marked as needing approval cannot use composition to auto-admit',
    async () => {
      const s = await setup();
      const tool = s.connector.manifest.tools[0];
      if (tool) tool.requires_approval = true;
      expect(
        await rejectionOf(
          s.compose.run(s.claims, {
            reads: [{ as: 'people', name: 'test.people' }],
            script: 'return data;',
          }),
        ),
      ).toMatchObject({ code: 'scope_denied' });
      expect(s.calls).toHaveLength(0);
      expect(await s.sql`select id from action where job_id = ${s.claims.job_id}`).toHaveLength(0);
    },
  );

  databaseTest('stale epochs and changed revisions reject before any connector call', async () => {
    for (const code of ['stale_epoch', 'revision_mismatch'] as const) {
      const s = await setup();
      if (code === 'stale_epoch') {
        await s.sql`update job set lease_epoch = lease_epoch + 1 where id = ${s.claims.job_id}`;
      } else {
        await s.sql`update job set revision = revision + 1 where id = ${s.claims.job_id}`;
      }
      expect(await rejectionOf(s.compose.run(s.claims, readPlan))).toMatchObject({ code });
      expect(s.calls).toHaveLength(0);
    }
  });

  databaseTest('revoked scopes between reads prevent the second dispatch', async () => {
    const s = await setup();
    s.setAfterRead(async (kind) => {
      if (kind === 'test.people') {
        await s.sql`update connection set scopes = '["test.people"]'::jsonb where id = ${s.connectionId}`;
      }
    });
    expect(await rejectionOf(s.compose.run(s.claims, readPlan))).toMatchObject({
      code: 'unknown_tool',
    });
    expect(s.calls).toEqual(['test.people']);
    expect(await s.sql`select id from action where job_id = ${s.claims.job_id}`).toHaveLength(1);
  });

  databaseTest(
    'a lost connection scope during execution prevents its computed result escaping',
    async () => {
      const s = await setup();
      const compose = new ComposeService({
        broker: s.broker,
        catalog: (claims) => s.broker.discovery.available(claims),
        executor: {
          async execute() {
            await s.sql`update connection set scopes = '[]'::jsonb where id = ${s.connectionId}`;
            return { copied: 'This result must be withheld' };
          },
        },
      });
      expect(await rejectionOf(compose.run(s.claims, readPlan))).toMatchObject({
        code: 'scope_denied',
      });
      expect(s.calls).toEqual(['test.people', 'test.orders']);
    },
  );

  databaseTest('each inner read consumes the job action budget', async () => {
    const s = await setup({ budget: 1 });
    expect(await rejectionOf(s.compose.run(s.claims, readPlan))).toMatchObject({
      code: 'budget_exceeded',
    });
    expect(s.calls).toEqual(['test.people']);
    const [ledger] =
      await s.sql`select sum(settled)::int as used from budget_ledger where job_id = ${s.claims.job_id}`;
    expect(ledger?.used).toBe(1);
  });

  databaseTest(
    'a transformed address cannot promote external content into send authority',
    async () => {
      const table = new Map<
        string,
        {
          origin_trust: 'external_content';
          handle: string;
          description: string;
        }
      >();
      const s = await setup({
        broker: {
          resolveTrust: createTableTrustResolver(table),
          resolveStandingGrant: async () => true,
        },
      });
      const result = await s.compose.run(s.claims, {
        reads: [{ as: 'external', name: 'test.people' }],
        script:
          'return { to: data.external.email, origin_trust: "owner", evidence_handle: "action:forged" };',
      });
      const address = (result.result as JsonObject).to as string;
      const evidence = result.evidence[0];
      if (!evidence) throw new Error('Read receipt missing');
      expect(result.origin_trust).toBe('inferred');
      expect(evidence.handle).not.toBe('action:forged');
      table.set(address, {
        origin_trust: 'external_content',
        handle: evidence.handle,
        description: 'The address came from a composed external read.',
      });
      const proposal = await s.broker.propose(s.claims, {
        kind: 'test.send',
        connection_id: s.connectionId,
        payload: { to: address, body: 'The report' },
      });
      expect(proposal.status).toBe('needs_approval');
      expect(proposal.origin_warnings).toMatchObject([
        { origin_trust: 'external_content', handle: evidence.handle },
      ]);
      expect(
        await rejectionOf(s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash)),
      ).toMatchObject({ code: 'untrusted_recipient_origin' });
      expect(s.calls).toEqual(['test.people']);
    },
  );
});
