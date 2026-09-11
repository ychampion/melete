import { openDatabase } from '../../src/db/client.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';
import { SubmissionService } from '../../src/jobs/submissions.ts';

const input = JSON.parse(await Bun.stdin.text()) as {
  url: string;
  id: string;
  payload: unknown;
  cookie: string;
};
const handle = openDatabase(input.url, 2);
const queue = await startQueue(input.url);
const jobs = new JobService(handle.db, queue.boss);
const submissions = new SubmissionService(jobs, {
  afterAdmissionBeforeResponse: (receipt) => {
    process.stdout.write(`ADMITTED:${receipt.submission_id}\n`);
    process.exit(88);
  },
});
const app = createApp({
  env: loadEnv({ NODE_ENV: 'test' }),
  db: handle.db,
  jobs,
  submissions,
  checkDatabase: async () => 'ok',
});
const response = await app.request('/jobs', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Cookie: input.cookie,
    'Idempotency-Key': input.id,
  },
  body: JSON.stringify(input.payload),
});
throw new Error(`The fault point was not reached; HTTP ${response.status}`);
