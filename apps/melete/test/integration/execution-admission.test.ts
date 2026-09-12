import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { signCapability } from '../../src/broker/capability.ts';
import { createBrokerApp } from '../../src/broker/http.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createExecConnector } from '../../src/connectors/exec.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const db = await testDatabase();
const databaseTest = db ? test : test.skip;
afterAll(async () => {
  await db?.close();
}, 15_000);

async function setup(max_actions = 20) {
  if (!db) throw new Error('Postgres unavailable');
  const seed = await seedJob(db.sql, {
    provider: 'exec',
    scopes: ['exec.python'],
    budget: { max_actions },
  });
  const root = await mkdtemp(join(tmpdir(), 'melete-admission-'));
  const work = join(root, seed.claims.job_id);
  await Bun.write(join(work, '.keep'), '');
  const broker = new BrokerService({
    sql: db.sql,
    connectors: new ConnectorRegistry().register(
      seed.connectionId,
      createExecConnector({ workRoot: root }),
    ),
  });
  return { ...seed, work, broker, sql: db.sql };
}

for (const reason of ['stale_epoch', 'budget_exceeded']) {
  databaseTest(
    `admission_before_execution: real broker ${reason}`,
    async () => {
      const ctx = await setup(reason === 'budget_exceeded' ? 0 : 20);
      const catalog = await ctx.broker.catalog(ctx.claims);
      if (reason === 'stale_epoch')
        await ctx.sql`update job set lease_epoch = lease_epoch + 1 where id = ${ctx.claims.job_id}`;
      const key = 'test-execution-capability-key-000000';
      const app = createBrokerApp({
        broker: ctx.broker,
        capabilityKey: key,
        approvalKey: 'test-execution-approval-key-00000000',
      });
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
      try {
        const process = Bun.spawn(
          [
            'python',
            '-c',
            "import json,os,sys; sys.path.insert(0,os.environ['PLUGIN_ROOT']); from melete_plugin import build_handler; from melete_plugin.broker import BrokerClient; print(json.dumps(build_handler(BrokerClient(),json.loads(os.environ['TOOL']))(code=\"open('marker','w').write('ran')\")))",
          ],
          {
            env: {
              ...Bun.env,
              PLUGIN_ROOT: resolve('packages/runtime-hermes'),
              TOOL: JSON.stringify(catalog[0]),
              MELETE_WORK_DIR: ctx.work,
              MELETE_BROKER_URL: `http://127.0.0.1:${server.port}`,
              MELETE_ATTEMPT_TOKEN: signCapability(ctx.claims, key),
            },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const output = await new Response(process.stdout).text();
        expect(await process.exited).toBe(0);
        expect(JSON.parse(output).error.code).toBe(reason);
        expect(await Bun.file(join(ctx.work, 'marker')).exists()).toBe(false);
      } finally {
        server.stop(true);
      }
    },
    30_000,
  );
}

databaseTest(
  'admission reserves once, claims once, and accepts only its matching late result',
  async () => {
    const ctx = await setup();
    const request = {
      kind: 'exec.python',
      connection_id: ctx.connectionId,
      payload: { intent: { code: "print('ok')" } },
      client_ref: 'stable-intent',
    };
    const proposal = await ctx.broker.propose(ctx.claims, request);
    expect(proposal.status).toBe('admitted');
    const repeat = await ctx.broker.propose(ctx.claims, request);
    expect(repeat.action_id).toBe(proposal.action_id);
    expect((await ctx.broker.startExecution(ctx.claims, proposal.action_id)).execute).toBe(true);
    expect((await ctx.broker.startExecution(ctx.claims, proposal.action_id)).execute).toBe(false);
    const [reservation] =
      await ctx.sql`select count(*)::int as count, sum(reserved)::int as reserved from budget_ledger where action_id = ${proposal.action_id}`;
    expect(reservation).toMatchObject({ count: 1, reserved: 1 });
    await ctx.sql`update job set lease_epoch = lease_epoch + 1 where id = ${ctx.claims.job_id}`;
    const result = {
      record: {
        language: 'python' as const,
        command: "print('ok')",
        cwd: '.',
        exit_code: 0,
        signal: null,
        timed_out: false,
        duration_ms: 10,
        output_digest: 'a'.repeat(64),
        output_bytes: 3,
        truncated: false,
        output_path: null,
      },
    };
    expect(
      await rejectionOf(
        ctx.broker.settleExecution(ctx.claims, proposal.action_id, {
          record: { ...result.record, command: 'different' },
        }),
      ),
    ).toMatchObject({ code: 'payload_invalid' });
    const action = await ctx.broker.settleExecution(ctx.claims, proposal.action_id, result);
    expect(action.status).toBe('succeeded');
    expect(action.receipt?.late).toBe(true);
    expect(action.canonical_payload).toEqual(request.payload);
    expect(await readFile(join(ctx.work, '.keep'), 'utf8')).toBe('');
  },
  30_000,
);
