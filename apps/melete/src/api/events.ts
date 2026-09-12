import type { Hono } from 'hono';
import type { EventStream } from '../events/stream.ts';
import type { JobService } from '../jobs/service.ts';
import { requestPrincipal } from '../principals/authority.ts';
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
  const resync = (value?: string) => {
    if (value !== undefined && !['true', 'false', '1', '0'].includes(value))
      throw new ServiceError('invalid_request', 'Resync must be true or false.', 400);
    return value === 'true' || value === '1';
  };
  app.get('/jobs/:id/snapshot', async (c) => {
    await jobs.get(c.req.param('id'));
    return c.json(await events.protocol.snapshot(c.req.param('id'), requestPrincipal()));
  });
  app.get('/snapshot', async (c) =>
    c.json(await events.protocol.snapshot(undefined, requestPrincipal())),
  );
  app.get('/jobs/:id/events', async (c) => {
    const after = readEventCursor(c.req.header('Last-Event-ID'), c.req.query('after'));
    const jobId = c.req.param('id');
    await jobs.get(jobId);
    return events.response({
      principalId: requestPrincipal(),
      after,
      jobId,
      signal: c.req.raw.signal,
      epoch:
        c.req.query('epoch') === undefined
          ? undefined
          : readEventCursor(undefined, c.req.query('epoch')),
      resync: resync(c.req.query('resync')),
    });
  });
  app.get('/events', (c) =>
    events.response({
      principalId: requestPrincipal(),
      after: readEventCursor(c.req.header('Last-Event-ID'), c.req.query('after')),
      signal: c.req.raw.signal,
      resync: resync(c.req.query('resync')),
    }),
  );
}
