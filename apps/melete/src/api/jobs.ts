import {
  cancelJobRequest,
  createJobRequest,
  jobListQuery,
  jobState,
  postMessageRequest,
} from '@melete/contracts';
import type { Hono } from 'hono';
import type { JobService } from '../jobs/service.ts';
import { jobView } from '../jobs/service.ts';
import { ServiceError } from './errors.ts';

export function mountJobs(app: Hono, jobs?: JobService): void {
  const service = () => {
    if (!jobs) throw new ServiceError('service_unavailable', 'Configure the job service.', 503);
    return jobs;
  };
  app.post('/jobs', async (c) => {
    const input = createJobRequest.parse(await c.req.json());
    return c.json({ job: jobView(await service().create(input)) }, 201);
  });
  app.get('/jobs', async (c) => {
    const query = jobListQuery.parse(c.req.query());
    if (query.state) jobState.parse(query.state);
    return c.json({ jobs: (await service().list(query)).map(jobView) });
  });
  app.get('/jobs/:id', async (c) =>
    c.json({ job: jobView(await service().get(c.req.param('id'))) }),
  );
  // /messages is the frozen API spelling; /input is the lane brief's alias.
  for (const path of ['/jobs/:id/input', '/jobs/:id/messages']) {
    app.post(path, async (c) => {
      const input = postMessageRequest.parse(await c.req.json());
      return c.json({ job: jobView(await service().input(c.req.param('id') ?? '', input.text)) });
    });
  }
  app.post('/jobs/:id/cancel', async (c) => {
    const text = await c.req.text();
    const input = cancelJobRequest.parse(text ? JSON.parse(text) : {});
    return c.json({ job: jobView(await service().cancel(c.req.param('id'), input.reason)) });
  });
}
