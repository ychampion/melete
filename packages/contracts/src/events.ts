/**
 * The event stream clients read. Events are persisted first and streamed
 * second, so a client that reconnects with `Last-Event-ID` resumes from the
 * database rather than from a buffer that a restart would have lost.
 */
import { z } from 'zod';
import { ID_PREFIXES, prefixedId, timestamp } from './common.ts';
import { event, eventType } from './entities.ts';

export const apiEvent = event;
export type ApiEvent = z.infer<typeof apiEvent>;

/** `after` is the last `seq` the client already has. Zero means from the start. */
export const eventCursor = z.coerce.number().int().nonnegative().default(0);

export const eventQuery = z.object({
  after: eventCursor,
  limit: z.coerce.number().int().positive().max(1000).default(200),
  types: z.array(eventType).optional(),
});
export type EventQuery = z.infer<typeof eventQuery>;

export const eventPage = z.object({
  events: z.array(apiEvent),
  /** Pass this back as `after` to continue. */
  next_cursor: z.number().int().nonnegative(),
  has_more: z.boolean(),
});
export type EventPage = z.infer<typeof eventPage>;

/**
 * One SSE frame. The `id` is the event `seq`, which is exactly what the browser
 * sends back in `Last-Event-ID`, so resumption needs no extra bookkeeping.
 */
export function sseFrame(e: ApiEvent): string {
  const data = JSON.stringify({
    seq: e.seq,
    job_id: e.job_id,
    attempt_id: e.attempt_id,
    type: e.type,
    payload: e.payload,
    created_at: e.created_at,
  });
  return `id: ${e.seq}\nevent: ${e.type}\ndata: ${data}\n\n`;
}

/** Sent every 20 seconds so proxies do not close an idle stream. */
export const SSE_KEEPALIVE = ': keepalive\n\n';

export const notice = z.object({
  job_id: prefixedId(ID_PREFIXES.job).nullable(),
  level: z.enum(['info', 'attention', 'problem']),
  title: z.string().min(1),
  body: z.string(),
  created_at: timestamp,
});
export type Notice = z.infer<typeof notice>;
