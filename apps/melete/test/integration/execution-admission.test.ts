import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { signCapability } from '../../src/broker/capability.ts';
import { createBrokerApp } from '../../src/broker/http.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { grantedToolCatalog } from '../../src/connectors/catalog.ts';
import { createExecConnector } from '../../src/connectors/exec.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { resolvePython } from '../../src/runtime/python.ts';
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
  const connector = createExecConnector({ workRoot: root });
  const broker = new BrokerService({
    sql: db.sql,
    connectors: new ConnectorRegistry().register(seed.connectionId, connector),
  });
  return { ...seed, work, broker, connector, sql: db.sql };
}

for (const reason of ['stale_epoch', 'budget_exceeded']) {
  databaseTest(
    `admission_before_execution: real broker ${reason}`,
    async () => {
      const ctx = await setup(reason === 'budget_exceeded' ? 0 : 20);
      // The catalog leads with discovery tools; the plugin is handed the in-cell one.
      const tool = (await ctx.broker.catalog(ctx.claims)).find((t) => t.name === 'exec.python');
      if (!tool) throw new Error('exec.python absent from the catalog');
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
            resolvePython(),
            '-c',
            "import json,os,sys; sys.path.insert(0,os.environ['PLUGIN_ROOT']); from melete_plugin import build_handler; from melete_plugin.broker import BrokerClient; print(json.dumps(build_handler(BrokerClient(),json.loads(os.environ['TOOL']))(code=\"open('marker','w').write('ran')\")))",
          ],
          {
            env: {
              ...Bun.env,
              PLUGIN_ROOT: resolve('packages/runtime-hermes'),
              TOOL: JSON.stringify(tool),
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
  'two concurrent execution settlements produce one durable result',
  async () => {
    const ctx = await setup();
    const proposal = await ctx.broker.propose(ctx.claims, {
      kind: 'exec.python',
      connection_id: ctx.connectionId,
      payload: { intent: { code: "print('settled')" } },
      client_ref: 'concurrent-settlement',
    });
    expect(proposal.status).toBe('admitted');
    expect((await ctx.broker.startExecution(ctx.claims, proposal.action_id)).execute).toBe(true);

    let checkedCount = 0;
    let release!: () => void;
    const bothChecked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = ctx.connector.execute;
    ctx.connector.execute = async (action, context) => {
      const checked = await execute(action, context);
      // Both callers must observe a dispatched action before either can persist
      // its result, so a sequential retry cannot accidentally satisfy the test.
      checkedCount += 1;
      if (checkedCount === 2) release();
      await bothChecked;
      return checked;
    };

    const settlements = await Promise.all(
      [10, 20].map((duration_ms) =>
        ctx.broker.settleExecution(ctx.claims, proposal.action_id, {
          record: {
            language: 'python',
            command: "print('settled')",
            cwd: '.',
            exit_code: 0,
            signal: null,
            timed_out: false,
            duration_ms,
            output_digest: 'a'.repeat(64),
            output_bytes: 8,
            truncated: false,
            output_path: null,
          },
        }),
      ),
    );
    expect(checkedCount).toBe(2);
    expect(settlements.map((action) => action.status)).toEqual(['succeeded', 'succeeded']);
    expect(settlements[0]?.receipt).not.toBeNull();
    expect(settlements[0]?.receipt).toEqual(settlements[1]?.receipt);
    const events = await ctx.sql`select payload from event where job_id = ${ctx.claims.job_id}
      and type = 'notice' and payload->>'phase' = 'receipt'
      and payload->>'action_id' = ${proposal.action_id}`;
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.outcome).toBe('succeeded');
    const [budget] = await ctx.sql`select count(*)::int as count,
      sum(reserved)::int as reserved, sum(settled)::int as settled
      from budget_ledger where action_id = ${proposal.action_id}`;
    expect(budget).toMatchObject({ count: 1, reserved: 1, settled: 1 });
  },
  30_000,
);

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

databaseTest(
  "a space with a sandbox connection is neither offered nor admitted the cell's exec",
  async () => {
    const ctx = await setup();
    const registry = new ConnectorRegistry().register(ctx.connectionId, ctx.connector);
    const granted = async () =>
      grantedToolCatalog(
        (
          await ctx.sql`select id, provider, scopes from connection
            where space_id = ${ctx.claims.space_id} and status = 'active'`
        ).map((row) => ({
          id: String(row.id),
          provider: String(row.provider),
          scopes: row.scopes as string[],
        })),
        registry,
      ).map((tool) => tool.name);
    const offered = async () => (await ctx.broker.catalog(ctx.claims)).map((tool) => tool.name);
    const request = (client_ref: string) => ({
      kind: 'exec.python',
      connection_id: ctx.connectionId,
      payload: { intent: { code: "open('marker','w').write('ran')" } },
      client_ref,
    });
    // While the cell is the space's only backend, it is offered and admits.
    expect(await granted()).toContain('exec.python');
    expect(await offered()).toContain('exec.python');
    const early = await ctx.broker.propose(ctx.claims, request('before-the-sandbox'));
    expect(early.status).toBe('admitted');

    await ctx.sql`insert into connection (id, space_id, provider, label, scopes)
      values (${recordId('conn')}, ${ctx.claims.space_id}, 'sandbox', 'Remote sandbox',
        ${JSON.stringify(['terminal.run'])}::jsonb)`;
    // Now the space runs its commands in the sandbox: the attempt's bundle and
    // the broker's catalog both leave the cell's exec out,
    expect(await granted()).not.toContain('exec.python');
    expect(await offered()).not.toContain('exec.python');
    // the broker refuses a new proposal,
    expect(
      await rejectionOf(ctx.broker.propose(ctx.claims, request('after-the-sandbox'))),
    ).toMatchObject({ code: 'connector_unavailable' });
    // and the one admitted before is refused at the start of execution.
    expect((await ctx.broker.startExecution(ctx.claims, early.action_id)).execute).toBe(false);
    const [action] = await ctx.sql`select status from action where id = ${early.action_id}`;
    expect(action?.status).toBe('failed');
    expect(await Bun.file(join(ctx.work, 'marker')).exists()).toBe(false);
  },
  30_000,
);
