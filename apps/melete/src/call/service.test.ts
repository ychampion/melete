import { describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { ServiceError } from '../api/errors.ts';
import type { CallVoice } from '../connectors/speech-engine.ts';
import type { CallScope } from './chat.ts';
import { CallService, type CallUsage, type Upstream } from './service.ts';
import type { CallChat } from './session.ts';

const scope: CallScope = {
  spaceId: 'sp_1',
  principalId: 'prn_1',
  conversationId: 'job_1',
  agentId: null,
};

/** ElevenLabs' token endpoint, faked: each call gets its own id, good for a minute. */
function fakeVoice(clock: { now: number }): CallVoice & { started: number } {
  const voice = {
    started: 0,
    async start() {
      voice.started += 1;
      return {
        token: `token-${voice.started}`,
        conversationId: `conv_${voice.started}`,
        expiresAt: new Date(clock.now + 60_000),
      };
    },
    verify: (header: string | null | undefined) => header === 'Bearer good',
  };
  return voice;
}

/** An upstream WebSocket as the service sees it, with what it was sent. */
function fakeSocket() {
  const sent: string[] = [];
  let closed: number | null = null;
  const socket = {
    data: {} as Upstream,
    send: (text: string) => sent.push(text),
    close: (code?: number) => {
      closed = code ?? 1000;
    },
  };
  return {
    socket: socket as unknown as ServerWebSocket<Upstream>,
    sent,
    get closed() {
      return closed;
    },
  };
}

const chat: CallChat = {
  say: async () => ({ turnId: 'turn_1' }),
  running: async () => null,
  turn: async () => ({ status: 'done', answer: 'Hello.' }),
  waiting: async () => null,
  control: async () => {},
};

function service(options: { usage?: CallUsage; monthlyMinutes?: number } = {}) {
  const clock = { now: Date.UTC(2026, 9, 18, 12) };
  const voice = fakeVoice(clock);
  const bound: CallScope[] = [];
  const calls = new CallService({
    voice,
    chat: (bind) => {
      bound.push(bind);
      return chat;
    },
    now: () => clock.now,
    timing: { pollMs: 1, fillerMs: 1000, stillMs: 10_000, holdMs: 10_000 },
    ...options,
  });
  return { calls, clock, voice, bound };
}

const open = async (calls: CallService, id: string) => {
  const upstream = fakeSocket();
  calls.websocket.open?.(upstream.socket);
  await calls.websocket.message(
    upstream.socket,
    JSON.stringify({ type: 'init', conversation_id: id }),
  );
  // The binding is awaited inside the session.
  await new Promise((resolve) => setTimeout(resolve, 5));
  return upstream;
};

describe('starting a call', () => {
  test('the browser gets a token that expires within minutes, and the call is bound once', async () => {
    const { calls, clock, bound } = service();
    const started = await calls.start(scope);
    expect(started.token).toBe('token-1');
    expect(Date.parse(started.expires_at) - clock.now).toBeLessThanOrEqual(2 * 60_000);
    expect(started.minutes_left).toBeNull();
    const first = await open(calls, 'conv_1');
    expect(first.closed).toBeNull();
    expect(bound).toEqual([scope]);
    // The same call named again is not taken a second time.
    const replay = await open(calls, 'conv_1');
    expect(replay.closed).toBe(1000);
    expect(bound).toHaveLength(1);
  });

  test('a token used after it expired starts no call', async () => {
    const { calls, clock, bound } = service();
    await calls.start(scope);
    clock.now += 61_000;
    const late = await open(calls, 'conv_1');
    expect(late.closed).toBe(1000);
    expect(bound).toEqual([]);
  });

  test('uncapped by default; an operator cap refuses once the month is used', async () => {
    const used = { seconds: 0 };
    const usage: CallUsage = {
      used: async () => used.seconds,
      begin: async () => 'use_1',
      record: async () => {},
    };
    const { calls } = service({ usage, monthlyMinutes: 10 });
    used.seconds = 9 * 60;
    expect((await calls.start(scope)).minutes_left).toBe(1);
    used.seconds = 10 * 60;
    const refused = await calls.start(scope).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ServiceError);
    expect((refused as ServiceError).status).toBe(429);
  });

  test('a call’s time is recorded when it ends', async () => {
    const records: { seconds: number; ended: boolean }[] = [];
    const usage: CallUsage = {
      used: async () => 0,
      begin: async () => 'use_1',
      record: async (_id, seconds, ended) => {
        records.push({ seconds, ended });
      },
    };
    const { calls, clock } = service({ usage });
    await calls.start(scope);
    const upstream = await open(calls, 'conv_1');
    clock.now += 90_000;
    calls.websocket.close?.(upstream.socket, 1000, '');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(records).toEqual([{ seconds: 90, ended: true }]);
  });
});

describe('the upstream WebSocket', () => {
  const upgrader = (result: boolean) => ({ upgrade: () => result }) as never;
  const request = (path: string, headers: Record<string, string> = {}) =>
    new Request(`http://melete.test${path}`, { headers });

  test('another path is not this route’s', () => {
    expect(service().calls.upgrade(request('/voice'), upgrader(true))).toBeNull();
  });

  test('only a connection that proves it is from ElevenLabs is taken', async () => {
    const { calls } = service();
    const plain = calls.upgrade(request('/voice/call/upstream'), upgrader(true));
    expect(plain?.status).toBe(400);
    const unsigned = calls.upgrade(
      request('/voice/call/upstream', { upgrade: 'websocket' }),
      upgrader(true),
    );
    expect(unsigned?.status).toBe(401);
    const forged = calls.upgrade(
      request('/voice/call/upstream', {
        upgrade: 'websocket',
        'x-elevenlabs-speech-engine-authorization': 'Bearer forged',
      }),
      upgrader(true),
    );
    expect(forged?.status).toBe(401);
    const genuine = calls.upgrade(
      request('/voice/call/upstream', {
        upgrade: 'websocket',
        'x-elevenlabs-speech-engine-authorization': 'Bearer good',
      }),
      upgrader(true),
    );
    expect(genuine).toBeUndefined();
  });
});
