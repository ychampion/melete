/**
 * The web server carries a call's WebSocket from ElevenLabs through to the API,
 * with the connection's proof and nothing else, and refuses one without it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { createStaticServer } from './serve-static.ts';

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
    fetch(request, server) {
      const url = new URL(request.url);
      seen.push({
        path: url.pathname,
        auth: request.headers.get(AUTH),
        cookie: request.headers.get('cookie'),
      });
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
