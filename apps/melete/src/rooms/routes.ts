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
import { RoomGate, type RoomOutbound, type RoomSurface } from './surface.ts';

export { ROOM_POLL_MS } from './surface.ts';

export function mountRooms(
  app: Hono,
  deps: RoomDeps & {
    changes?: EventChanges;
    memory?: MemoryRouteOptions;
    env?: Env;
    /** Wakes a room's request when a handoff it waits on ends. */
    triggers?: TriggerService;
    /** Chat platforms rooms can be talked to from, besides the web. */
    surfaces?: RoomSurface[];
  },
): RoomService {
  const service = new RoomService(deps);
  const surfaceDeps = { db: deps.db, rooms: service, changes: deps.changes };
  // The web is a surface like any other: its messages, answers and stream go
  // through the same doors a chat platform's do.
  const web = RoomGate.web(surfaceDeps);
  const providers = new Set<string>();
  for (const surface of deps.surfaces ?? []) {
    if (providers.has(surface.provider))
      throw new Error(`Two chat platforms are named "${surface.provider}"`);
    providers.add(surface.provider);
    surface.attach(RoomGate.platform(surfaceDeps, surface));
  }
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
      await web.postRoomMessage({
        room: param(c, 'id'),
        author: actor(c),
        text: input.text,
        submission_id: input.submission_id,
        title: input.title,
        ask_agent: input.ask_agent,
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
      await web.postRoomMessage({
        room: param(c, 'id'),
        thread: param(c, 'threadId'),
        author: actor(c),
        text: input.text,
        submission_id: input.submission_id,
      }),
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
    return threadStream(web, {
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
    const result = await web.decideRoomApproval({
      room: param(c, 'id'),
      approval: param(c, 'approvalId'),
      principal: actor(c),
      ...input,
    });
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
 * A thread's live stream: the web's follower of a thread. Before each frame
 * the follower checks the person is still in the room, and the stream closes
 * the moment they are not: removing someone ends what they can read at once,
 * not on their next request.
 */
function threadStream(
  web: RoomGate,
  start: {
    spaceId: string;
    threadId: string;
    person: string;
    after: number;
    first: Awaited<ReturnType<RoomService['frames']>>;
    signal: AbortSignal;
  },
): Response {
  const stop = new AbortController();
  const abort = () => stop.abort();
  start.signal.addEventListener('abort', abort, { once: true });
  if (start.signal.aborted) abort();
  // A frame waits until the reader has taken the one before it.
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
        const send = (out: RoomOutbound) =>
          write(
            `id: ${out.frame.seq}\nevent: ${out.frame.kind}\ndata: ${JSON.stringify(out.frame)}\n\n`,
          );
        web
          .follow({
            room: start.spaceId,
            thread: start.threadId,
            viewer: start.person,
            after: start.after,
            first: start.first,
            signal: stop.signal,
            deliver: send,
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
