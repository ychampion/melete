import { describe, expect, test } from 'bun:test';
import type { RoomStreamFrame } from '@melete/contracts';
import { ServiceError } from '../api/errors.ts';
import { threadStream } from './routes.ts';
import type { RoomService } from './service.ts';
import { RoomGate, type RoomSurfaceDeps } from './surface.ts';

const frame = (seq: number) =>
  ({
    seq,
    kind: 'message',
    message: { id: `rmg_${seq}`, text: `m${seq}` },
  }) as unknown as RoomStreamFrame;

/** A room with a thread whose frames a test adds, and a person whose place it controls. */
function world(count = 0) {
  const state = {
    frames: Array.from({ length: count }, (_, index) => frame(index + 1)),
    member: true,
    checks: 0,
    fault: null as Error | null,
    listeners: new Set<() => void>(),
    unsubscribed: 0,
  };
  const rooms = {
    async frames(_room: string, _thread: string, _person: string, after: number) {
      if (state.fault) throw state.fault;
      return state.frames.filter((entry) => entry.seq > after);
    },
    async stillIn() {
      state.checks += 1;
      return state.member;
    },
  } as unknown as RoomService;
  const changes = {
    subscribe(listener: () => void) {
      state.listeners.add(listener);
      return () => {
        state.unsubscribed += 1;
        state.listeners.delete(listener);
      };
    },
  };
  const web = RoomGate.web({ db: null, rooms, changes } as unknown as RoomSurfaceDeps);
  const notify = () => {
    for (const listener of state.listeners) listener();
  };
  const open = async (after = 0) => {
    const stop = new AbortController();
    const response = threadStream(web, {
      spaceId: 'sp_room',
      threadId: 'rth_one',
      person: 'own_alice',
      after,
      first: await rooms.frames('sp_room', 'rth_one', 'own_alice', after),
      signal: stop.signal,
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const next = async () => {
      const read = await reader.read();
      return read.done ? null : decoder.decode(read.value);
    };
    return { stop: () => stop.abort(), next, response };
  };
  return { state, notify, open };
}

const seqOf = (chunk: string | null) => Number(/^id: (\d+)/.exec(chunk ?? '')?.[1] ?? -1);

describe('a thread stream on the web', () => {
  test('sends each frame once, in order, with its id, and lets go when the request ends', async () => {
    const { state, notify, open } = world(2);
    const stream = await open();
    expect(stream.response.headers.get('Content-Type')).toContain('text/event-stream');
    const first = await stream.next();
    expect(first).toBe(`id: 1\nevent: message\ndata: ${JSON.stringify(frame(1))}\n\n`);
    expect(seqOf(await stream.next())).toBe(2);
    state.frames.push(frame(3));
    notify();
    expect(seqOf(await stream.next())).toBe(3);
    stream.stop();
    expect(await stream.next()).toBeNull();
    expect(state.unsubscribed).toBe(1);
  });

  test('waits for its reader instead of reading ahead', async () => {
    const { state, open } = world(50);
    const stream = await open();
    await Bun.sleep(150);
    // One frame is queued for the reader; nothing past it is checked or sent.
    expect(state.checks).toBeLessThanOrEqual(3);
    const seen: number[] = [];
    for (let index = 0; index < 50; index += 1) seen.push(seqOf(await stream.next()));
    expect(seen).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
    stream.stop();
    expect(await stream.next()).toBeNull();
  });

  test('closes the moment its reader is no longer in the room', async () => {
    const { state, notify, open } = world(1);
    const stream = await open();
    expect(seqOf(await stream.next())).toBe(1);
    state.member = false;
    state.frames.push(frame(2));
    notify();
    expect(await stream.next()).toBeNull();
    expect(state.unsubscribed).toBe(1);
  });

  test('ends when the room refuses the reader, and errors on a fault', async () => {
    const refused = world(1);
    const closing = await refused.open();
    expect(seqOf(await closing.next())).toBe(1);
    refused.state.fault = new ServiceError('not_found', 'That room is not here.', 404);
    refused.notify();
    expect(await closing.next()).toBeNull();

    const broken = world(1);
    const failing = await broken.open();
    expect(seqOf(await failing.next())).toBe(1);
    broken.state.fault = new Error('the database went away');
    broken.notify();
    await expect(failing.next()).rejects.toThrow('the database went away');
    expect(broken.state.unsubscribed).toBe(1);
  });

  test('keeps an idle connection open', async () => {
    const { open } = world(0);
    const stream = await open();
    expect(await stream.next()).toBe(': keepalive\n\n');
    stream.stop();
  });
});
