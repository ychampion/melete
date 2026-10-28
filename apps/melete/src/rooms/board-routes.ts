/**
 * The board routes: a room's board, its live stream, claiming, completing
 * and answering, and the boards of every room the signed-in person is in.
 * Each checks, on every request, that the person is in the room now, and
 * reads only what their place in it lets them see.
 */
import { type BoardStreamFrame, boardAnswerRequest, boardQuery } from '@melete/contracts';
import type { Context, Hono } from 'hono';
import { ServiceError } from '../api/errors.ts';
import { readEventCursor } from '../api/events.ts';
import type { Database } from '../db/client.ts';
import type { EventChanges } from '../experience/events.ts';
import { BoardService } from './board.ts';
import type { RoomService } from './service.ts';
import { ROOM_POLL_MS } from './surface.ts';

export function mountBoard(
  app: Hono,
  deps: { db: Database; rooms: RoomService; changes?: EventChanges },
): BoardService {
  const board = new BoardService({ db: deps.db, rooms: deps.rooms });
  const actor = (c: Context) => c.get('owner').id;
  const param = (c: Context, name: string) => c.req.param(name) ?? '';

  app.get('/board', async (c) => {
    const query = boardQuery.parse(c.req.query());
    return c.json(
      await board.across(actor(c), {
        mine: query.mine === '1',
        ...(query.from ? { from: new Date(query.from) } : {}),
        ...(query.to ? { to: new Date(query.to) } : {}),
      }),
    );
  });
  app.get('/rooms/:id/board', async (c) => c.json(await board.list(param(c, 'id'), actor(c))));
  app.get('/rooms/:id/board/events', async (c) => {
    const spaceId = param(c, 'id');
    const person = actor(c);
    const after = readEventCursor(c.req.header('Last-Event-ID'), c.req.query('after'));
    const first = await board.frames(spaceId, person, after);
    if (!c.req.header('Accept')?.includes('text/event-stream'))
      return c.json({ frames: first, next_cursor: first.at(-1)?.seq ?? after });
    return boardStream(board, {
      spaceId,
      person,
      after,
      first,
      signal: c.req.raw.signal,
      ...(deps.changes ? { changes: deps.changes } : {}),
    });
  });
  app.post('/rooms/:id/board/:itemId/claim', async (c) =>
    c.json(await board.claim(param(c, 'id'), param(c, 'itemId'), actor(c))),
  );
  app.post('/rooms/:id/board/:itemId/done', async (c) =>
    c.json(await board.done(param(c, 'id'), param(c, 'itemId'), actor(c))),
  );
  app.post('/rooms/:id/board/:itemId/answer', async (c) => {
    const input = boardAnswerRequest.parse(await c.req.json());
    return c.json(await board.answer(param(c, 'id'), param(c, 'itemId'), actor(c), input.answer));
  });
  return board;
}

type BoardReader = Pick<BoardService, 'frames' | 'stillIn'>;

/**
 * Follow a room's board for one person: every item that changed after
 * `after`, as they may see it now, in commit order. Before each frame it
 * checks they are still in the room, and it stops the moment they are not.
 */
export async function followBoard(input: {
  board: BoardReader;
  spaceId: string;
  person: string;
  after: number;
  first: BoardStreamFrame[];
  signal: AbortSignal;
  changes?: EventChanges;
  deliver: (frame: BoardStreamFrame) => Promise<void>;
  idle: () => Promise<void>;
}): Promise<'stopped' | 'left'> {
  const { board, spaceId, person, signal } = input;
  let cursor = input.after;
  let buffered = input.first;
  let changed = false;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = input.changes?.subscribe(() => {
    changed = true;
    wake?.();
  });
  const stop = () => wake?.();
  signal.addEventListener('abort', stop, { once: true });
  let lastWrite = Date.now();
  try {
    while (!signal.aborted) {
      for (const frame of buffered) {
        if (signal.aborted) return 'stopped';
        if (!(await board.stillIn(spaceId, person))) return 'left';
        await input.deliver(frame);
        cursor = frame.seq;
        lastWrite = Date.now();
      }
      if (!changed)
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, ROOM_POLL_MS);
        });
      wake = undefined;
      if (timer) clearTimeout(timer);
      if (signal.aborted) return 'stopped';
      changed = false;
      if (!(await board.stillIn(spaceId, person))) return 'left';
      // Refused now means the person may no longer read the room; anything
      // else is a fault, and is reported as one.
      const next = await board.frames(spaceId, person, cursor).catch((error: unknown) => {
        if (error instanceof ServiceError) return null;
        throw error;
      });
      if (!next) return 'left';
      buffered = next;
      if (!buffered.length && Date.now() - lastWrite >= ROOM_POLL_MS) {
        await input.idle();
        lastWrite = Date.now();
      }
    }
    return 'stopped';
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe?.();
    signal.removeEventListener('abort', stop);
  }
}

/** A board's live stream on the web, closed the moment its reader leaves the room. */
export function boardStream(
  board: BoardReader,
  start: {
    spaceId: string;
    person: string;
    after: number;
    first: BoardStreamFrame[];
    signal: AbortSignal;
    changes?: EventChanges;
  },
): Response {
  const stop = new AbortController();
  const abort = () => stop.abort();
  start.signal.addEventListener('abort', abort, { once: true });
  if (start.signal.aborted) abort();
  let drained: (() => void) | undefined;
  stop.signal.addEventListener('abort', () => drained?.(), { once: true });
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const write = async (chunk: string) => {
          if (stop.signal.aborted) return;
          controller.enqueue(encoder.encode(chunk));
          if ((controller.desiredSize ?? 1) > 0) return;
          await new Promise<void>((resolve) => {
            drained = resolve;
          });
          drained = undefined;
        };
        followBoard({
          board,
          spaceId: start.spaceId,
          person: start.person,
          after: start.after,
          first: start.first,
          signal: stop.signal,
          ...(start.changes ? { changes: start.changes } : {}),
          deliver: (frame) =>
            write(`id: ${frame.seq}\nevent: ${frame.kind}\ndata: ${JSON.stringify(frame)}\n\n`),
          idle: () => write(': keepalive\n\n'),
        })
          .then(
            () => {
              try {
                controller.close();
              } catch {
                // The reader went away first.
              }
            },
            (error: unknown) => {
              try {
                controller.error(error);
              } catch {
                // The reader went away first.
              }
            },
          )
          .finally(() => start.signal.removeEventListener('abort', abort));
      },
      pull() {
        drained?.();
      },
      cancel: abort,
    },
    { highWaterMark: 1 },
  );
  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
