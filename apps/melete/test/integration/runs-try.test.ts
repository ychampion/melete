/**
 * Tries the harness measures itself: `run.try` runs its commands in the
 * space's sandbox through the broker, as a model's own command would go, and
 * the service writes the try from what the command really printed.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CapabilityClaims,
  runExportResponse,
  runRecordResponse,
  runResponse,
  type SandboxConnectionConfig,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { signCapability } from '../../src/broker/capability.ts';
import { BrokerFault } from '../../src/broker/errors.ts';
import { createBrokerApp } from '../../src/broker/http.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { createSandboxExecConnector } from '../../src/connectors/sandbox-exec.ts';
import { session } from '../../src/db/auth-schema.ts';
import { action, agent, connection, job, owner, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { runBrief } from '../../src/runs/record.ts';
import { attachRuns, RunService } from '../../src/runs/service.ts';
import { metricValue, patternValue, tryCommand } from '../../src/runs/try.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { FakeSandboxEngine, FakeSandboxProvider } from '../../src/sandbox/fake.ts';
import { SandboxSessions } from '../../src/sandbox/sessions.ts';
import { rejectionOf } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const KEY = 'runs-try-fixture-signing-key-32-bytes';
const runner = jobs ? new AttemptRunner(jobs, new StubRuntimeAdapter(), { key: KEY }) : null;
const runs = jobs ? new RunService(jobs) : null;
if (runner && runs) attachRuns(runner, runs);
const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      jobs: jobs ?? undefined,
      runner: runner ?? undefined,
      runs: runs ?? undefined,
      sql: handle.sql,
      checkDatabase: async () => 'ok',
    })
  : null;
const spaceId = newId('sp');
const ownerId = newId('own');
const sandboxId = newId('conn');
const token = randomBytes(32).toString('base64url');
const workRoot = await mkdtemp(join(tmpdir(), 'melete-tries-'));
const config: SandboxConnectionConfig = {
  adapter: 'e2b',
  image: 'base',
  egress: 'deny_all',
  persistence: 'ephemeral',
  lifetime_seconds: 600,
};
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'tries@example.test' });
  await handle.sql`insert into principal (id, email) select id, email from owner where id = ${ownerId}`;
  await handle.db.insert(space).values({ id: spaceId, name: 'Personal', gitPath: `/s/${spaceId}` });
  await handle.db.insert(session).values({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    ownerId,
    spaceId,
    expiresAt: new Date(Date.now() + 600000),
  });
  await handle.db.insert(connection).values({
    id: sandboxId,
    spaceId,
    label: 'Computer',
    provider: 'sandbox',
    scopes: ['terminal.run'],
  });
}
const provider = new FakeSandboxProvider({ engine: new FakeSandboxEngine() });
const registry = handle
  ? new ConnectorRegistry().register(
      sandboxId,
      createSandboxExecConnector({
        sessions: new SandboxSessions(handle.sql, {
          leaseSeconds: 300,
          workspaceRetentionSeconds: 3_600,
        }),
        provider,
        config,
        connectionId: sandboxId,
        spaceId,
        project: 'runs-try-test',
        workRoot,
        sql: handle.sql,
      }),
    )
  : new ConnectorRegistry();
const broker =
  handle && runs ? new BrokerService({ sql: handle.sql, connectors: registry, runs }) : null;

const withDb = handle ? describe : describe.skip;
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture');
  return value;
}
async function request(path: string) {
  return required(app).request(path, { headers: { Cookie: `melete_session=${token}` } });
}
async function start(body: Record<string, unknown>) {
  const response = await required(app).request('/runs', {
    method: 'POST',
    headers: { Cookie: `melete_session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return runResponse.parse(await response.json()).run;
}
const view = async (id: string) =>
  runResponse.parse(await (await request(`/runs/${id}`)).json()).run;

/** Claims the job's next shift, with the sandbox's terminal granted as the space grants it. */
async function claim(id: string) {
  await required(handle)
    .db.update(job)
    .set({ nextWakeAt: new Date(Date.now() - 1000) })
    .where(eq(job.id, id));
  const current = await required(jobs).get(id);
  const claimed = required(
    await required(runner).claim({
      job_id: id,
      expected_epoch: current.leaseEpoch,
      expected_version: current.stateVersion,
      reason: 'timer',
    }),
  );
  await mkdir(join(workRoot, id), { recursive: true });
  const claims: CapabilityClaims = {
    ...claimed.claims,
    scopes: [...new Set([...claimed.claims.scopes, 'terminal.run'])],
  };
  return { ...claimed, claims };
}

type Tried = {
  status: string;
  new_best: boolean;
  best: number | null;
  tries: {
    title: string;
    value: number | null;
    outcome?: string;
    error?: string;
    status?: string;
    action_id?: string;
  }[];
};
const measure = async (claims: CapabilityClaims, input: unknown) =>
  (await required(broker).runTool(claims, 'run.try', input)) as Tried;
const record = async (id: string) =>
  runRecordResponse
    .parse(await (await request(`/runs/${id}/record`)).json())
    .entries.filter((entry) => entry.kind === 'experiment');

withDb('tries the harness measures', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  test('a try writes its files, runs, and is recorded with the value it printed', async () => {
    const run = await start({ goal: 'Tune it', metric: { name: 'accuracy', direction: 'higher' } });
    const shift = await claim(run.id);

    const first = await measure(shift.claims, {
      title: 'Baseline',
      hypothesis: 'The defaults are a fair start.',
      files: { 'conf/settings.txt': "rate=0.1\nit's the default\n" },
      command: "cat conf/settings.txt && printf 'METRIC accuracy=0.81\\n'",
    });
    expect(first.tries).toEqual([
      expect.objectContaining({ title: 'Baseline', value: 0.81, outcome: 'kept' }),
    ]);
    expect(first.new_best).toBe(true);
    expect(first.best).toBe(0.81);

    const [entry] = await record(run.id);
    expect(entry?.data).toMatchObject({
      measured: true,
      checked: true,
      value: 0.81,
      outcome: 'kept',
      exit_code: 0,
      metric: 'accuracy',
      command: "cat conf/settings.txt && printf 'METRIC accuracy=0.81\\n'",
      files: { 'conf/settings.txt': "rate=0.1\nit's the default\n" },
    });
    expect(String(entry?.data.output_tail)).toContain("it's the default");
    // The receipt is the broker's own: one succeeded sandbox command.
    const evidence = (entry?.data.evidence as string[] | undefined)?.[0] ?? '';
    const [ran] = await required(handle).db.select().from(action).where(eq(action.id, evidence));
    expect(ran).toMatchObject({ kind: 'terminal.run', status: 'succeeded', jobId: run.id });

    // Worse than the best so far: recorded, not kept.
    const worse = await measure(shift.claims, {
      title: 'Higher rate',
      command: "printf 'METRIC accuracy=0.7\\n'",
    });
    expect(worse.tries[0]).toMatchObject({ value: 0.7, outcome: 'discarded' });
    expect(worse).toMatchObject({ new_best: false, best: 0.81 });

    // A value only claimed does not outrank a measured one.
    await required(runs).call(shift.claims, 'run.log', {
      kind: 'experiment',
      title: 'Claimed',
      value: 0.99,
    });
    const after = await view(run.id);
    expect(after.experiments.best).toMatchObject({ title: 'Baseline', value: 0.81, checked: true });

    // The next shift reads the tries with their commands.
    const brief = await required(jobs).transaction(async (tx) =>
      runBrief(tx, await required(jobs).get(run.id)),
    );
    expect(brief).toContain('Baseline = 0.81 (kept, measured)');
    expect(brief).toContain("command: printf 'METRIC accuracy=0.7\\n'");
    expect(brief).toContain('Print a line `METRIC accuracy=<number>`');

    // The export is a notebook someone can run again.
    const markdown = runExportResponse.parse(
      await (await request(`/runs/${run.id}/export`)).json(),
    ).markdown;
    expect(markdown).toContain('Measured: Baseline');
    expect(markdown).toContain('## Run the best try again');
    expect(markdown).toContain('`conf/settings.txt`:');
    expect(markdown).toContain("rate=0.1\nit's the default");
    expect(markdown.split('## Run the best try again')[1]).toContain(
      "cat conf/settings.txt && printf 'METRIC accuracy=0.81\\n'",
    );
  });

  test('a pattern reads the value, the metric direction picks the best, failures carry why', async () => {
    const run = await start({
      goal: 'Lower the loss',
      metric: { name: 'loss', direction: 'lower' },
    });
    const shift = await claim(run.id);
    const pattern = 'loss: ([0-9.]+)';
    const one = await measure(shift.claims, {
      title: 'One',
      command: "printf 'epoch 1\\nloss: 0.42\\n'",
      value_pattern: pattern,
    });
    expect(one.tries[0]).toMatchObject({ value: 0.42, outcome: 'kept' });
    const two = await measure(shift.claims, {
      title: 'Two',
      command: "printf 'loss: 0.5\\n'",
      value_pattern: pattern,
    });
    expect(two.tries[0]).toMatchObject({ value: 0.5, outcome: 'discarded' });
    const three = await measure(shift.claims, {
      title: 'Three',
      command: "printf 'loss: 0.3\\n'",
      value_pattern: pattern,
    });
    expect(three).toMatchObject({ new_best: true, best: 0.3 });

    // A nonzero exit is a failed try, even with a value printed.
    const crashed = await measure(shift.claims, {
      title: 'Crashes',
      command: "printf 'METRIC loss=0.01\\nboom\\n' && exit 3",
    });
    expect(crashed.tries[0]).toMatchObject({ value: null, outcome: 'failed' });
    expect(crashed.tries[0]?.error).toContain('status 3');
    // No value found is a failed try that says what was looked for.
    const silent = await measure(shift.claims, { title: 'Silent', command: "printf 'done\\n'" });
    expect(silent.tries[0]).toMatchObject({ value: null, outcome: 'failed' });
    expect(silent.tries[0]?.error).toContain('METRIC loss=<number>');
    expect(silent).toMatchObject({ new_best: false, best: 0.3 });

    const entries = await record(run.id);
    const failed = entries.find((entry) => entry.title === 'Crashes');
    expect(failed?.data).toMatchObject({ measured: true, checked: false, exit_code: 3 });
    expect(String(failed?.data.output_tail)).toContain('boom');
    expect((await view(run.id)).experiments.best).toMatchObject({ title: 'Three', value: 0.3 });
  });

  test('variants run alongside and only the best of them is kept', async () => {
    const run = await start({
      goal: 'Pick a cache',
      metric: { name: 'hits', direction: 'higher' },
    });
    const shift = await claim(run.id);
    const before = provider.calls.exec;
    const result = await measure(shift.claims, {
      title: 'Cache size',
      command: "printf 'METRIC hits=50\\n'",
      variants: [
        { label: 'small', command: "printf 'METRIC hits=60\\n'" },
        { label: 'large', command: "printf 'METRIC hits=90\\n'" },
        { label: 'broken', command: 'exit 1' },
      ],
    });
    expect(provider.calls.exec - before).toBe(4);
    expect(result.tries.map((entry) => [entry.title, entry.value, entry.outcome])).toEqual([
      ['Cache size', 50, 'discarded'],
      ['Cache size: small', 60, 'discarded'],
      ['Cache size: large', 90, 'kept'],
      ['Cache size: broken', null, 'failed'],
    ]);
    expect(result).toMatchObject({ new_best: true, best: 90 });
    const entries = await record(run.id);
    expect(entries).toHaveLength(4);
    expect(entries.find((entry) => entry.title === 'Cache size: large')?.data).toMatchObject({
      variant: 'large',
      command: "printf 'METRIC hits=90\\n'",
    });
  });

  test('variants are not run when the first command did not run through', async () => {
    const run = await start({ goal: 'Time the build' });
    const shift = await claim(run.id);
    const variants = [
      { label: 'fast', command: "printf 'METRIC score=2\\n'" },
      { label: 'faster', command: "printf 'METRIC score=3\\n'" },
    ];
    const before = provider.calls.exec;
    const slow = await measure(shift.claims, {
      title: 'Slow start',
      command: 'sleep 5',
      timeout_seconds: 1,
      variants,
    });
    expect(provider.calls.exec - before).toBe(1);
    expect(slow.tries).toHaveLength(1);
    expect(slow.tries[0]).toMatchObject({ title: 'Slow start', outcome: 'failed' });
    expect(JSON.stringify(slow)).toContain('variants were not run');
    expect(JSON.stringify(slow)).toContain('ran past its time limit');
    expect(await record(run.id)).toHaveLength(1);

    const agentId = newId('agent');
    await required(handle).db.insert(agent).values({
      id: agentId,
      spaceId,
      name: 'Asks first',
      role: 'Researcher',
      colour: '#336699',
      surface: 'rounded',
      eyeColour: '#222222',
      tone: 'plain',
      standingInstruction: '',
      asksBeforeActing: true,
    });
    const careful = await start({ goal: 'Careful timing', agent_id: agentId });
    const asked = await claim(careful.id);
    const waiting = await measure(asked.claims, {
      title: 'Asked first',
      command: "printf 'METRIC score=1\\n'",
      variants,
    });
    // One question for the person, not one per variant.
    expect(waiting.tries).toEqual([
      expect.objectContaining({ title: 'Asked first', status: 'waiting_for_approval' }),
    ]);
    expect(JSON.stringify(waiting)).toContain('waits for the person’s approval');
    const parked = await required(handle)
      .db.select()
      .from(action)
      .where(eq(action.jobId, careful.id));
    expect(parked).toHaveLength(1);
  });

  test('a command the person must approve waits, and runs when the try is asked again', async () => {
    const agentId = newId('agent');
    await required(handle).db.insert(agent).values({
      id: agentId,
      spaceId,
      name: 'Careful',
      role: 'Researcher',
      colour: '#336699',
      surface: 'rounded',
      eyeColour: '#222222',
      tone: 'plain',
      standingInstruction: '',
      asksBeforeActing: true,
    });
    const run = await start({ goal: 'Careful work', agent_id: agentId });
    const shift = await claim(run.id);
    const input = { title: 'Asked first', command: "printf 'METRIC score=1\\n'" };
    const waiting = await measure(shift.claims, input);
    expect(waiting.tries).toEqual([
      expect.objectContaining({ title: 'Asked first', status: 'waiting_for_approval' }),
    ]);
    expect(JSON.stringify(waiting)).toContain('run.try again with the same arguments');
    expect(await record(run.id)).toHaveLength(0);
    const parked = waiting.tries[0]?.action_id ?? '';
    const [pending] = await required(handle).db.select().from(action).where(eq(action.id, parked));
    expect(pending?.status).toBe('needs_approval');

    // Approved, the next shift asks for the same try: that command runs, once.
    await required(broker).decide(parked, {
      decision: 'approved',
      payload_hash: required(pending).payloadHash,
    });
    const next = await claim(run.id);
    const ran = await measure(next.claims, input);
    expect(ran.tries[0]).toMatchObject({ title: 'Asked first', value: 1, outcome: 'kept' });
    const [settled] = await required(handle).db.select().from(action).where(eq(action.id, parked));
    expect(settled?.status).toBe('succeeded');
    expect((await record(run.id))[0]?.data.evidence).toEqual([parked]);
  });

  test('without a sandbox the try is refused with what to do instead', async () => {
    const bare = new BrokerService({
      sql: required(handle).sql,
      connectors: new ConnectorRegistry(),
      runs: required(runs),
    });
    const run = await start({ goal: 'Somewhere bare' });
    const shift = await claim(run.id);
    const refused = await rejectionOf(
      bare.runTool(shift.claims, 'run.try', { title: 'x', command: 'true' }),
    );
    expect(refused).toBeInstanceOf(BrokerFault);
    expect((refused as BrokerFault).code).toBe('connector_unavailable');
    expect((refused as BrokerFault).message).toContain('run.log');
  });

  test('through the broker: runs and helpers are offered run.try, a conversation is not', async () => {
    const brokerApp = createBrokerApp({
      broker: required(broker),
      capabilityKey: KEY,
      approvalKey: 'runs-try-fixture-approval-key-32-b!',
    });
    const as = (claims: CapabilityClaims) => ({
      authorization: `Bearer ${signCapability(claims, KEY)}`,
      'content-type': 'application/json',
    });
    const tools = async (claims: CapabilityClaims) =>
      (
        (await (await brokerApp.request('/tools', { headers: as(claims) })).json()) as {
          tools: { name: string }[];
        }
      ).tools.map((entry) => entry.name);
    const call = (claims: CapabilityClaims, args: unknown) =>
      brokerApp.request('/tools/call', {
        method: 'POST',
        headers: as(claims),
        body: JSON.stringify({ name: 'run.try', arguments: args }),
      });

    const run = await start({ goal: 'Over HTTP', metric: { name: 'ms', direction: 'lower' } });
    const shift = await claim(run.id);
    expect(shift.claims.scopes).toContain('run.try');
    expect(await tools(shift.claims)).toContain('run.try');
    const answered = await call(shift.claims, {
      title: 'Fast path',
      command: "printf 'METRIC ms=12\\n'",
    });
    expect(answered.status).toBe(200);
    expect(((await answered.json()) as Tried).tries[0]).toMatchObject({ value: 12 });
    // A wrong argument is readable.
    const wrong = await call(shift.claims, {
      title: 'Bad pattern',
      command: 'true',
      value_pattern: 'no group',
    });
    expect(wrong.status).toBe(409);
    expect(JSON.stringify(await wrong.json())).toContain('capture group');

    const helper = (await required(runs).call(shift.claims, 'run.delegate', {
      task: 'Measure more',
    })) as { helper_id: string };
    const helperShift = await claim(helper.helper_id);
    expect(helperShift.claims.scopes).toContain('run.try');

    const chat = await required(jobs).transaction((tx) =>
      required(jobs).createInTransaction(
        tx,
        { space_id: spaceId, title: 'Chat', objective: 'Chat' },
        { kind: 'chat' },
      ),
    );
    await required(jobs).input(chat.id, 'Hello');
    const turn = await claim(chat.id);
    expect(turn.claims.scopes).not.toContain('run.try');
    expect(await tools(turn.claims)).not.toContain('run.try');
    const refused = await call(turn.claims, { title: 'x', command: 'true' });
    expect(refused.status).not.toBe(200);
  });
});

describe('reading a try', () => {
  test('a METRIC line names the value; the last one for the metric wins', () => {
    expect(metricValue('METRIC acc=0.5\nMETRIC loss=2\nMETRIC acc=0.75\n', 'acc')).toBe(0.75);
    expect(metricValue('metric Load MS = 12.5', 'load ms')).toBe(12.5);
    expect(metricValue('METRIC other=3', 'acc')).toBeNull();
    expect(metricValue('METRIC other=3', null)).toBe(3);
    expect(metricValue('the METRIC acc=1 inline', 'acc')).toBeNull();
  });

  test('a pattern that never finishes is stopped, not waited on', async () => {
    expect(await patternValue('score 7.5 of 10', 'score ([0-9.]+)')).toBe(7.5);
    expect(await patternValue('nothing here', 'score ([0-9.]+)')).toBeNull();
    const started = Date.now();
    const error = await rejectionOf(patternValue(`${'a'.repeat(40)}!`, '(a+)+$'));
    expect(String(error)).toContain('too long');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test('files are written exactly as given before the command', () => {
    expect(tryCommand('make', {})).toBe('make');
    expect(tryCommand('make', { 'a/b.txt': "it's" })).toBe(
      "mkdir -p 'a' && printf '%s' 'it'\\''s' > 'a/b.txt' && (\nmake\n)",
    );
  });
});
