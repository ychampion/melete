import type { OperationRegistration } from '@melete/contracts';
import { openDatabase } from '../../src/db/client.ts';
import { OperationService } from '../../src/jobs/operations.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';

const input = JSON.parse(await Bun.stdin.text()) as {
  url: string;
  jobId: string;
  registration: OperationRegistration;
  phase: string;
};
const handle = openDatabase(input.url, 2);
const queue = await startQueue(input.url);
const service = new OperationService(new JobService(handle.db, queue.boss));
let row = await service.register(input.jobId, input.registration);
if (input.phase !== 'registration') {
  const claimed = await service.claim(row.id, row.version);
  if (!claimed) throw new Error('Fault operation not claimed');
  row = claimed;
}
if (input.phase === 'rearm') row = await service.rearm(row.id, row.version, new Date());
if (input.phase === 'settlement')
  row = await service.settle(row.id, row.version, { finished: true });
process.stdout.write(`OPERATION:${row.id}\n`);
process.exit(90);
