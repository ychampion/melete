import { openDatabase } from '../../src/db/client.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';

const input = JSON.parse(await Bun.stdin.text()) as { url: string; jobId: string; key: string };
const handle = openDatabase(input.url, 2);
const queue = await startQueue(input.url);
const jobs = new JobService(handle.db, queue.boss);
const runtime = new StubRuntimeAdapter({
  onStall: async () => {
    process.stdout.write('QUIET_CHECK_INTERRUPTED\n');
    process.exit(89);
  },
});
const runner = new AttemptRunner(jobs, runtime, { key: input.key });
const row = await jobs.get(input.jobId);
await runner.handleWake({
  job_id: row.id,
  expected_epoch: row.leaseEpoch,
  expected_version: row.stateVersion,
  reason: 'created',
});
throw new Error('Quiet fault point not reached');
