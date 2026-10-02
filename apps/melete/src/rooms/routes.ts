/**
 * The room routes. Each names its room in the path and checks, on every
 * request, that the signed-in person is in it now. A room's requests are
 * read and steered here and nowhere else: every personal surface keeps its
 * own-job filter, and a room's jobs belong to the room's principal.
 */
import {
  addRoomMemberRequest,
  createRoomRequest,
  createRoomThreadRequest,
  handoffDecision,
  handoffResultDecision,
  peopleQuery,
  postRoomMessageRequest,
  type RoomStreamFrame,
  roomConnectionUpdate,
  roomPermissionDecision,
  roomPolicyUpdate,
  sandboxComputerList,
  updateMeRequest,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import { readEventCursor } from '../api/events.ts';
import type { Env } from '../env.ts';
import type { EventChanges } from '../experience/events.ts';
import type { TriggerService } from '../jobs/triggers.ts';
import type { MemoryRouteOptions } from '../memory/routes.ts';
import { HandoffService } from './handoffs.ts';
import { InviteService, mountInvites } from './invites.ts';
import { mountRoomMemory } from './memory.ts';
import { releaseAll, releaseOnTransition, releaseThread } from './release.ts';
import { type RoomDeps, RoomService } from './service.ts';

/** How long a thread stream waits for new frames when nothing says one was committed. */
export const ROOM_POLL_MS = 1000;

export function mountRooms(
  app: Hono,
  deps: RoomDeps & {
    changes?: EventChanges;
    memory?: MemoryRouteOptions;
    env?: Env;
    /** Wakes a room's request when a handoff it waits on ends. */
    triggers?: TriggerService;
  },
): RoomService {
  const service = new RoomService(deps);
  const handoffs = new HandoffService({ db: deps.db, jobs: deps.jobs, triggers: deps.triggers });
  // A person's work that a room handed them settles its handoff when it ends.
  if (Array.isArray(deps.jobs.afterMove)) deps.jobs.afterMove.push(handoffs.afterMove());
  // A request that stops holding its thread lets the thread's next ask go:
  // when it changes state, when an attempt the broker parked ends, and on
  // startup for anything a stopped process left waiting.
  if (Array.isArray(deps.jobs.afterMove)) deps.jobs.afterMove.push(releaseOnTransition(deps));
  const runner = deps.runner;
  if (runner && Array.isArray(runner.onFinished)) {
    runner.onFinished.push(async (tx, row, outcome) => {
      if (row.audience === 'room' && row.roomThreadId)
        await releaseThread(tx, deps, row.roomThreadId);
      else await handoffs.settle(tx, row, outcome);
    });
    const previous = runner.afterRecovery;
    runner.afterRecovery = async () => {
      await previous?.();
      await releaseAll(deps.db, deps);
      await handoffs.expireDue();
    };
  }
  const actor = (c: Context) => c.get('owner').id;
  const param = (c: Context, name: string) => c.req.param(name) ?? '';

  app.get('/rooms', async (c) => c.json(await service.list(actor(c))));
  app.post('/rooms', async (c) => {
    const input = createRoomRequest.parse(await c.req.json());
    const id = await service.create(actor(c), input.name, input.purpose);
    // The room is furnished with its own tools once this request has answered.
    c.set('createdSpaceId', id);
    return c.json(await service.detail(id, actor(c)), 201);
  });
  app.get('/rooms/:id', async (c) => c.json(await service.detail(param(c, 'id'), actor(c))));
  app.post('/rooms/:id/members', async (c) => {
    const input = addRoomMemberRequest.parse(await c.req.json());
    return c.json(await service.addMember(param(c, 'id'), actor(c), input.principal_id), 201);
  });
  app.delete('/rooms/:id/members/:principalId', async (c) =>
    c.json(await service.removeMember(param(c, 'id'), actor(c), param(c, 'principalId'))),
  );
  app.get('/people', async (c) => {
    const query = peopleQuery.parse(c.req.query());
    return c.json(await service.people(actor(c), query.query));
  });
  app.patch('/me', async (c) => {
    const input = updateMeRequest.parse(await c.req.json());
    return c.json(await service.rename(actor(c), input.display_name));
  });
  app.get('/rooms/:id/threads', async (c) =>
    c.json(await service.threads(param(c, 'id'), actor(c))),
  );
  app.post('/rooms/:id/threads', async (c) => {
    const input = createRoomThreadRequest.parse(await c.req.json());
    return c.json(
      await service.post(param(c, 'id'), actor(c), input, {
        title: input.title,
        askAgent: input.ask_agent,
      }),
      201,
    );
  });
  app.get('/rooms/:id/threads/:threadId', async (c) =>
    c.json(await service.thread(param(c, 'id'), param(c, 'threadId'), actor(c))),
  );
  app.post('/rooms/:id/threads/:threadId/messages', async (c) => {
    const input = postRoomMessageRequest.parse(await c.req.json());
    return c.json(
      await service.post(param(c, 'id'), actor(c), input, { threadId: param(c, 'threadId') }),
    );
  });
  app.get('/rooms/:id/threads/:threadId/events', async (c) => {
    const spaceId = param(c, 'id');
    const threadId = param(c, 'threadId');
    const person = actor(c);
    const after = readEventCursor(c.req.header('Last-Event-ID'), c.req.query('after'));
    const first = await service.frames(spaceId, threadId, person, after);
    if (!c.req.header('Accept')?.includes('text/event-stream'))
      return c.json({ frames: first, next_cursor: first.at(-1)?.seq ?? after });
    return threadStream(service, deps.changes, {
      spaceId,
      threadId,
      person,
      after,
      first,
      signal: c.req.raw.signal,
    });
  });
  app.post('/rooms/:id/requests/:jobId/stop', async (c) => {
    const result = await service.stop(param(c, 'id'), param(c, 'jobId'), actor(c));
    return result instanceof Response ? result : c.json(result);
  });
  app.get('/rooms/:id/requests/:jobId/computers', async (c) =>
    c.json(
      sandboxComputerList.parse(
        await service.computers(param(c, 'id'), param(c, 'jobId'), actor(c)),
      ),
    ),
  );
  app.get('/rooms/:id/policy', async (c) => c.json(await service.policy(param(c, 'id'), actor(c))));
  app.put('/rooms/:id/policy', async (c) => {
    const input = roomPolicyUpdate.parse(await c.req.json());
    return c.json(await service.setPolicy(param(c, 'id'), actor(c), input));
  });
  app.post('/rooms/:id/approvals/:approvalId', async (c) => {
    const input = roomPermissionDecision.parse(await c.req.json());
    const result = await service.decide(param(c, 'id'), param(c, 'approvalId'), actor(c), input);
    return result instanceof Response ? result : c.json(result);
  });
  app.get('/rooms/:id/connections', async (c) =>
    c.json(await service.connections(param(c, 'id'), actor(c))),
  );
  app.put('/rooms/:id/connections/:connectionId', async (c) => {
    const input = roomConnectionUpdate.parse(await c.req.json());
    return c.json(
      await service.setConnection(
        param(c, 'id'),
        actor(c),
        param(c, 'connectionId'),
        input.shared_use,
      ),
    );
  });
  app.post('/rooms/:id/presence', async (c) =>
    c.json(await service.presence(param(c, 'id'), actor(c))),
  );
  // What the room remembers, and what its people shared into it.
  mountRoomMemory(app, service, deps.memory);
  // Guests: invites an owner sends, and the public routes that accept them.
  if (deps.env)
    mountInvites(
      app,
      new InviteService({
        db: deps.db,
        jobs: deps.jobs,
        principals: deps.principals,
        rooms: service,
        publicUrl: deps.env.MELETE_PUBLIC_URL,
      }),
      deps.env,
    );
  // Work a room asked the signed-in person to run with their own setup.
  app.get('/handoffs', async (c) => c.json(await handoffs.list(actor(c))));
  app.post('/handoffs/:id', async (c) => {
    const input = handoffDecision.parse(await c.req.json());
    return c.json(await handoffs.decide(param(c, 'id'), actor(c), input));
  });
  app.post('/handoffs/:id/result', async (c) => {
    const input = handoffResultDecision.parse(await c.req.json());
    return c.json(await handoffs.result(param(c, 'id'), actor(c), input));
  });
  return service;
}

/**
 * A thread's live stream. Before each frame it checks the person is still in
 * the room, and closes the stream the moment they are not: removing someone
 * ends what they can read at once, not on their next request.
 */
function threadStream(
  service: RoomService,
  changes: EventChanges | undefined,
  start: {
    spaceId: string;
    threadId: string;
    person: string;
    after: number;
    first: RoomStreamFrame[];
    signal: AbortSignal;
  },
): Response {
  const { spaceId, threadId, person, signal } = start;
  let cursor = start.after;
  let buffered = start.first;
  let closed = false;
  let changed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  let lastWrite = Date.now();
  const encoder = new TextEncoder();
  const unsubscribe = changes?.subscribe(() => {
    changed = true;
    wake?.();
  });
  const close = () => {
    closed = true;
    if (timer) clearTimeout(timer);
    unsubscribe?.();
    wake?.();
    signal.removeEventListener('abort', close);
  };
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) close();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        while (!closed) {
          const next = buffered.shift();
          if (next) {
            if (!(await service.stillIn(spaceId, person))) {
              close();
              break;
            }
            cursor = next.seq;
            controller.enqueue(
              encoder.encode(
                `id: ${next.seq}\nevent: ${next.kind}\ndata: ${JSON.stringify(next)}\n\n`,
              ),
            );
            lastWrite = Date.now();
            return;
          }
          if (!changed)
            await new Promise<void>((resolve) => {
              wake = resolve;
              timer = setTimeout(resolve, ROOM_POLL_MS);
            });
          wake = undefined;
          if (timer) clearTimeout(timer);
          if (closed) break;
          changed = false;
          if (!(await service.stillIn(spaceId, person))) {
            close();
            break;
          }
          buffered = await service.frames(spaceId, threadId, person, cursor).catch(() => {
            close();
            return [];
          });
          if (!buffered.length && Date.now() - lastWrite >= ROOM_POLL_MS) {
            controller.enqueue(encoder.encode(': keepalive\n\n'));
            lastWrite = Date.now();
            return;
          }
        }
        controller.close();
      },
      cancel: close,
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
