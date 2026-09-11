import type { Hono } from 'hono';
import type { EventStream } from '../events/stream.ts';
import type { JobService } from '../jobs/service.ts';
import { ServiceError } from './errors.ts';

/** Last-Event-ID wins on browser reconnect; an invalid present header is refused. */
export function readEventCursor(
  lastEventId: string | undefined,
  after: string | undefined,
): number {
  const source = lastEventId ?? after ?? '0';
  if (!/^\d+$/.test(source)) {
    throw new ServiceError('invalid_request', 'Event cursor must be a nonnegative integer.', 400);
  }
  const cursor = Number(source);
  if (!Number.isSafeInteger(cursor)) {
    throw new ServiceError('invalid_request', 'Event cursor is outside the supported range.', 400);
  }
  return cursor;
}

export function mountEvents(app: Hono, events: EventStream, jobs: JobService): void {
  app.get('/jobs/:id/events', async (c) => {
    const after = readEventCursor(c.req.header('Last-Event-ID'), c.req.query('after'));
    const jobId = c.req.param('id');
    await jobs.get(jobId);
    return events.response({ after, jobId, signal: c.req.raw.signal });
  });
  app.get('/events', (c) =>
    events.response({
      after: readEventCursor(c.req.header('Last-Event-ID'), c.req.query('after')),
      signal: c.req.raw.signal,
    }),
  );
}
