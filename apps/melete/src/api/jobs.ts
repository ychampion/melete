import { cancelJobRequest, jobListQuery, jobState } from '@melete/contracts';
import type { Hono } from 'hono';
import type { JobService } from '../jobs/service.ts';
import { jobView } from '../jobs/service.ts';
import { SubmissionService } from '../jobs/submissions.ts';
import { ServiceError } from './errors.ts';

export function mountJobs(app: Hono, jobs?: JobService, submissions?: SubmissionService): void {
  const service = () => {
    if (!jobs) throw new ServiceError('service_unavailable', 'Configure the job service.', 503);
    return jobs;
  };
  const admissions = () => submissions ?? new SubmissionService(service());
  for (const path of ['/jobs', '/responsibilities'])
    app.post(path, async (c) => {
      const result = await admissions().create(await c.req.json(), c.req.header('Idempotency-Key'));
      return c.json(
        {
          job: result.job ? jobView(result.job) : null,
          receipt: result.receipt,
          ...(result.error ? { error: result.error } : {}),
        },
        result.status,
      );
    });
  app.get('/submissions/:id', async (c) =>
    c.json({ receipt: await admissions().get(c.req.param('id')) }),
  );
  app.get('/jobs', async (c) => {
    const query = jobListQuery.parse(c.req.query());
    if (query.state) jobState.parse(query.state);
    return c.json({ jobs: (await service().list(query)).map(jobView) });
  });
  app.get('/jobs/:id', async (c) =>
    c.json({ job: jobView(await service().get(c.req.param('id'))) }),
  );
  // /messages is the frozen API spelling; /input is an accepted alias.
  for (const path of ['/jobs/:id/input', '/jobs/:id/messages']) {
    app.post(path, async (c) => {
      const result = await admissions().input(
        c.req.param('id') ?? '',
        await c.req.json(),
        c.req.header('Idempotency-Key'),
      );
      return c.json(
        {
          job: result.job ? jobView(result.job) : null,
          receipt: result.receipt,
          ...(result.error ? { error: result.error } : {}),
        },
        result.status,
      );
    });
  }
  app.post('/jobs/:id/cancel', async (c) => {
    const text = await c.req.text();
    const input = cancelJobRequest.parse(text ? JSON.parse(text) : {});
    return c.json({ job: jobView(await service().cancel(c.req.param('id'), input.reason)) });
  });
}
