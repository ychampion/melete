/**
 * The web server carries a call's WebSocket from ElevenLabs through to the API,
 * with the connection's proof and nothing else, and refuses one without it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { CALL_BRIDGE_MESSAGE_BYTES, createStaticServer } from './serve-static.ts';

const PATH = '/voice/call/upstream';
const AUTH = 'x-elevenlabs-speech-engine-authorization';

let base = '';
let api: Server<undefined>;
let web: ReturnType<typeof createStaticServer>;
const seen: { path: string; auth: string | null; cookie: string | null }[] = [];

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'melete-call-bridge-'));
  await mkdir(join(base, 'dist'));
  await writeFile(join(base, 'dist', 'index.html'), '<!doctype html><title>t</title>');
  // The API, faked: it answers every message by echoing it back, marked.
  api = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request, server) {
      const url = new URL(request.url);
      const auth = request.headers.get(AUTH);
      seen.push({ path: url.pathname, auth, cookie: request.headers.get('cookie') });
      // The real API refuses a connection whose proof does not check out.
      if (auth === 'Bearer forged') return new Response('no', { status: 401 });
      // A slow API, so the bridge has to hold what arrives before it is open.
      if (auth === 'Bearer slow') await Bun.sleep(400);
      return server.upgrade(request) ? undefined : new Response('no', { status: 400 });
    },
    websocket: {
      message(socket, message) {
        socket.send(`api:${String(message)}`);
      },
    },
  });
  web = createStaticServer({
    root: join(base, 'dist'),
    port: 0,
    hostname: '127.0.0.1',
    apiOrigin: `http://127.0.0.1:${api.port}`,
  });
});

afterAll(async () => {
  web?.stop(true);
  api?.stop(true);
  if (base) await rm(base, { recursive: true, force: true });
});

test('a call connection is carried both ways to the API, with its proof and nothing else', async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${web.port}/api${PATH}`, {
    headers: { [AUTH]: 'Bearer signed', cookie: 'melete_session=not-for-the-api' },
  } as unknown as string[]);
  const reply = await new Promise<string>((resolve, reject) => {
    socket.onopen = () => socket.send('{"type":"ping","event_id":1}');
    socket.onmessage = (event) => resolve(String(event.data));
    socket.onerror = () => reject(new Error('the bridge refused the call'));
  });
  socket.close();
  expect(reply).toBe('api:{"type":"ping","event_id":1}');
  expect(seen.at(-1)).toEqual({ path: PATH, auth: 'Bearer signed', cookie: null });
});

/** Open a call connection through the web server and wait for it to close. */
function closing(auth: string, onOpen: (socket: WebSocket) => void = () => {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${web.port}/api${PATH}`, {
    headers: { [AUTH]: auth },
  } as unknown as string[]);
  return new Promise<{ code: number; replies: string[] }>((resolve) => {
    const replies: string[] = [];
    socket.onopen = () => onOpen(socket);
    socket.onmessage = (event) => replies.push(String(event.data));
    socket.onclose = (event) => resolve({ code: event.code, replies });
  });
}

test('a connection the API refuses is closed, and nothing it sent reaches the API', async () => {
  const before = seen.length;
  const result = await closing('Bearer forged', (socket) => socket.send('{"type":"ping"}'));
  expect(result.code).toBe(1011);
  expect(result.replies).toEqual([]);
  expect(seen.slice(before).map((entry) => entry.auth)).toEqual(['Bearer forged']);
});

test('the bridge holds a little before the API answers, never a flood', async () => {
  const big = 'x'.repeat(1024 * 1024);
  const result = await closing('Bearer slow', (socket) => {
    for (let i = 0; i < 4; i++) socket.send(big);
  });
  expect(result.code).toBe(1009);
  expect(result.replies).toEqual([]);
});

test('one message larger than the limit closes the connection', async () => {
  const result = await closing('Bearer signed', (socket) =>
    socket.send('x'.repeat(CALL_BRIDGE_MESSAGE_BYTES + 1)),
  );
  // The server drops the connection at once (the client reads 1006) and carries nothing on.
  expect([1006, 1009]).toContain(result.code);
  expect(result.replies).toEqual([]);
});

test('a connection without the proof is refused at the door', async () => {
  const response = await fetch(`http://127.0.0.1:${web.port}/api${PATH}`, {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
    },
  });
  expect(response.status).toBe(401);
});
