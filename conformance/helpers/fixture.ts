import { fileURLToPath } from 'node:url';
import { connection, space } from '../../apps/melete/src/db/schema.ts';
import { newId } from '../../apps/melete/src/ids.ts';
import { type AttemptWake, startQueue } from '../../apps/melete/src/jobs/queue.ts';
import { AttemptRunner } from '../../apps/melete/src/jobs/runner.ts';
import { type JobRow, JobService } from '../../apps/melete/src/jobs/service.ts';
import { StubRuntimeAdapter, type StubStep } from '../../apps/melete/src/runtime/stub.ts';
import { testDatabase } from '../../apps/melete/test/helpers/database.ts';

export const CONFORMANCE_KEY = 'conformance-scripted-capability-key-32-bytes';
export function wake(row: JobRow): AttemptWake {
  return {
    job_id: row.id,
    expected_epoch: row.leaseEpoch,
    expected_version: row.stateVersion,
    reason: 'timer',
  };
}
export async function conformanceFixture() {
  const handle = await testDatabase();
  if (!handle) return null;
  const queue = await startQueue(handle.url);
  const jobs = new JobService(handle.db, queue.boss);
  const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key: CONFORMANCE_KEY });
  const spaceId = newId('sp');
  const connectionId = newId('conn');
  await handle.db
    .insert(space)
    .values({ id: spaceId, name: 'Conformance', gitPath: `/spaces/${spaceId}` });
  await handle.db
    .insert(connection)
    .values({ id: connectionId, spaceId, provider: 'test', label: 'Scripted destination' });
  await handle.sql`create table fake_effect_counter (job_id text primary key, calls integer not null)`;
  return {
    handle,
    queue,
    jobs,
    runner,
    connectionId,
    spaceId,
    create: (script: StubStep[]) =>
      jobs.create({
        space_id: spaceId,
        title: 'Durable conformance',
        objective: 'Survive a process dying',
        constraints: { notes: JSON.stringify({ script }) },
      }),
    close: async () => {
      await runner.stop();
      await queue.stop();
      await handle.close();
    },
  };
}
export type ConformanceFixture = NonNullable<Awaited<ReturnType<typeof conformanceFixture>>>;

/** The fault is a real process exit with an open connection, not a thrown rollback fixture. */
export async function killAtFault(
  fixture: ConformanceFixture,
  jobId: string,
  mode: 'transition' | 'mid-stream' | 'after-tool',
) {
  const child = Bun.spawn({
    cmd: [process.execPath, fileURLToPath(new URL('./fault-child.ts', import.meta.url))],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      FIREWORKS_API_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      GOOGLE_API_KEY: '',
    },
  });
  child.stdin.write(
    JSON.stringify({
      url: fixture.handle.url,
      jobId,
      mode,
      connectionId: fixture.connectionId,
      key: CONFORMANCE_KEY,
    }),
  );
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 77)
      throw new Error(`Fault child exited ${code}: ${stderr.slice(-2000)} ${stdout.slice(-2000)}`);
    return { code, marker: stdout.trim() };
  } finally {
    clearTimeout(timer);
  }
}
export async function eventually(check: () => Promise<boolean>, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Conformance condition timed out');
    await Bun.sleep(25);
  }
}
