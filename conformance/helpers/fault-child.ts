import { openDatabase } from '../../apps/melete/src/db/client.ts';
import { startQueue } from '../../apps/melete/src/jobs/queue.ts';
import { AttemptRunner } from '../../apps/melete/src/jobs/runner.ts';
import { JobService } from '../../apps/melete/src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../apps/melete/src/runtime/stub.ts';
import { fakeTool } from './fake-effects.ts';

const input = JSON.parse(await Bun.stdin.text()) as {
  url: string;
  jobId: string;
  mode: string;
  connectionId: string;
  key: string;
};
const handle = openDatabase(input.url, 2);
const queue = await startQueue(input.url);
const die = () => {
  process.stdout.write(`FAULT:${input.mode}\n`);
  process.exit(77);
};
const jobs = new JobService(
  handle.db,
  queue.boss,
  input.mode === 'transition' ? { afterTransitionBeforeEnqueue: die } : {},
);
if (input.mode === 'transition') {
  await jobs.transaction(async (tx) => {
    const row = await jobs.lock(tx, input.jobId);
    if (!row) throw new Error('Fault fixture job missing');
    await jobs.move(tx, row, { kind: 'timer_fired' }, { reason: 'timer' });
  });
} else {
  const runtime = new StubRuntimeAdapter({
    onStall: async () => die(),
    onTool: fakeTool(jobs, input.key, input.connectionId),
  });
  const runner = new AttemptRunner(jobs, runtime, { key: input.key });
  const row = await jobs.get(input.jobId);
  await runner.handleWake({
    job_id: row.id,
    expected_epoch: row.leaseEpoch,
    expected_version: row.stateVersion,
    reason: 'created',
  });
}
throw new Error('The requested fault point was not reached');
