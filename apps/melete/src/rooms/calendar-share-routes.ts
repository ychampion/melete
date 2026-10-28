import { roomCalendarShareUpdate } from '@melete/contracts';
import type { Hono } from 'hono';
import type { Database } from '../db/client.ts';
import { RoomCalendarShareService } from './calendar-shares.ts';

/** Mounted only when rooms are enabled; the caller can manage only their own consent. */
export function mountRoomCalendarShares(app: Hono, deps: { db: Database }) {
  const shares = new RoomCalendarShareService(deps);
  app.get('/rooms/:id/calendar-shares', async (c) =>
    c.json(await shares.list(c.req.param('id'), c.get('owner').id)),
  );
  app.put('/rooms/:id/calendar-shares', async (c) => {
    const input = roomCalendarShareUpdate.parse(await c.req.json());
    return c.json(
      await shares.put(c.req.param('id'), c.get('owner').id, input.connection_id, input.mode),
    );
  });
  app.delete('/rooms/:id/calendar-shares', async (c) =>
    c.json(await shares.revoke(c.req.param('id'), c.get('owner').id)),
  );
  return shares;
}
