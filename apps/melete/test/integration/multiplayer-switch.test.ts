/**
 * Rooms, shared spaces, guests and hand-offs sit behind one operator switch,
 * `MELETE_PREVIEW_MULTIPLAYER`, off by default. An installation that used rooms
 * with the switch on and starts again with it off keeps every row it had, but
 * answers the room routes with 404 `not_available`, offers no room tool to an
 * agent, gives a new person's space no room tools, and runs a personal chat
 * exactly as before.
 */

import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AttemptBundle, JobConstraints, RuntimeAdapter } from '@melete/contracts';
import type { Hono } from 'hono';
import { loadEnv } from '../../src/env.ts';
import { bootstrap } from '../../src/index.ts';
import { StubRuntimeAdapter, type StubStep } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const root = await mkdtemp(join(await realpath(tmpdir()), 'melete-multiplayer-'));
const fixture = await testDatabase();
afterAll(async () => {
  await fixture?.close();
  if (dirname(await realpath(root)) !== (await realpath(tmpdir())))
    throw new Error('Unexpected fixture root');
  await rm(root, { recursive: true, force: true });
}, 60_000);

const ANSWER = 'Here is the plan for Friday.';
const ROOM_TOOLS = ['room.list', 'room.post', 'room.add_file', 'room.handoff'];

/** The stub runtime, answering every turn with one line and finishing it. */
function scripted(): RuntimeAdapter {
  const stub = new StubRuntimeAdapter();
  const script: StubStep[] = [
    { type: 'text_delta', text: ANSWER },
    { type: 'outcome', outcome: { kind: 'completed', summary: ANSWER, evidence: [] } },
  ];
  return {
    capabilities: () => stub.capabilities(),
    start: (bundle: AttemptBundle, sink, signal) =>
      stub.start(
        {
          ...bundle,
          job: {
            ...bundle.job,
            constraints: { ...bundle.job.constraints, script } as unknown as JobConstraints,
          },
        },
        sink,
        signal,
      ),
  };
}

const service = (url: string, multiplayer: boolean | null) =>
  bootstrap({
    workers: false,
    runtime: scripted(),
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: url,
      MELETE_CAPABILITY_KEY: 'multiplayer-switch-capability-key-32chars',
      MELETE_RUNTIME_ADAPTER: 'stub',
      MELETE_SPACES_DIR: join(root, 'spaces'),
      MELETE_WORK_DIR: join(root, 'work'),
      // Left out, the switch takes its default.
      ...(multiplayer === null ? {} : { MELETE_PREVIEW_MULTIPLAYER: String(multiplayer) }),
    }),
  });

(fixture ? test : test.skip)(
  'switched off, rooms answer 404 and offer no tools, and a personal chat runs as before',
  async () => {
    if (!fixture) throw new Error('Postgres unavailable');
    let cookie = '';
    const call = (app: Hono, path: string, method = 'GET', body?: unknown) =>
      app.request(path, {
        method,
        headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const roomRows = async () =>
      (
        await fixture.sql`select id, space_id, configuration->>'builtin' as builtin, status
          from connection where provider = 'room' order by id`
      ).map((row) => ({ ...row }));

    // With the switch on, the person sets up, makes a room, and gets the room tools.
    const on = await service(fixture.url, true);
    let roomId = '';
    try {
      expect(await (await call(on.app, '/setup')).json()).toEqual({
        needed: true,
        multiplayer: true,
        code_required: false,
        email_sign_in: false,
      });
      const setup = await call(on.app, '/setup', 'POST', {
        email: 'solo@example.test',
        password: 'a-solo-person-password',
      });
      expect(setup.status).toBe(201);
      cookie =
        setup.headers
          .getSetCookie()
          .map((value) => value.split(';')[0] ?? '')
          .find((value) => value.startsWith('melete_session=')) ?? '';
      const made = await call(on.app, '/rooms', 'POST', { name: 'Family' });
      expect(made.status).toBe(201);
      roomId = ((await made.json()) as { room: { id: string } }).room.id;
      expect((await call(on.app, `/rooms/${roomId}`)).status).toBe(200);
      // Switched on, each room connection is served with its tools.
      const served = await fixture.sql`select id from connection where provider = 'room'`;
      expect(served).toHaveLength(2);
      for (const row of served)
        expect(on.registry?.get(String(row.id))?.manifest.tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(ROOM_TOOLS),
        );
    } finally {
      await on.close();
    }
    const before = await roomRows();
    expect(before.map((row) => row.builtin).sort()).toEqual(['room_handoff', 'rooms']);

    // Started again with the switch left at its default: off.
    const off = await service(fixture.url, null);
    try {
      const app = off.app;
      expect(await (await call(app, '/setup')).json()).toEqual({
        needed: false,
        multiplayer: false,
        code_required: false,
        email_sign_in: false,
      });

      // Making, reading, inviting to and posting in a room, accepting an
      // invite, a hand-off and a shared space: each answers 404 not_available.
      for (const [path, method, body] of [
        ['/rooms', 'POST', { name: 'Another' }],
        ['/rooms', 'GET'],
        [`/rooms/${roomId}`, 'GET'],
        [`/rooms/${roomId}/invites`, 'POST', { email: 'guest@example.test' }],
        [`/rooms/${roomId}/threads`, 'POST', { text: 'Hello', submission_id: 'switch-1' }],
        ['/invites/accept', 'POST', { token: 'unused', password: 'a-guest-password' }],
        ['/handoffs', 'GET'],
        ['/handoffs/hof_01M2000000000000000000000A', 'POST', { decision: 'accept' }],
        ['/me/linked-accounts', 'GET'],
        ['/spaces/shared', 'POST', { name: 'Team' }],
      ] as const) {
        const answer = await call(app, path, method, body);
        expect([method, path, answer.status]).toEqual([method, path, 404]);
        expect(((await answer.json()) as { error: { code: string } }).error.code).toBe(
          'not_available',
        );
      }

      // Nothing stored was changed or removed.
      expect(await roomRows()).toEqual(before);
      expect(await fixture.sql`select id from space where id = ${roomId}`).toHaveLength(1);

      // A new person's space is given no room tools.
      const added = await call(app, '/principals', 'POST', {
        email: 'second@example.test',
        password: 'a-second-person-password',
      });
      expect(added.status).toBe(201);
      const second = ((await added.json()) as { principal: { id: string } }).principal.id;
      const [space] = await fixture.sql`select id from space
        where kind = 'personal' and owner_principal_id = ${second}`;
      if (!space) throw new Error('The new person has no space');
      const furnished = await fixture.sql`select provider from connection
        where space_id = ${space.id}`;
      expect(furnished.length).toBeGreaterThan(0);
      expect(furnished.map((row) => row.provider)).not.toContain('room');

      // A personal chat runs one turn to its end.
      const started = await call(app, '/conversations', 'POST', { title: 'Friday' });
      expect(started.status).toBeLessThan(300);
      const { conversation } = (await started.json()) as { conversation: { id: string } };
      const asked = await call(app, `/conversations/${conversation.id}/messages`, 'POST', {
        text: 'Plan Friday for me',
      });
      expect(asked.status).toBeLessThan(300);
      const row = await off.jobs?.get(conversation.id);
      if (!row || !off.runner || !off.jobs) throw new Error('Missing conversation job');
      await off.runner.handleWake({
        job_id: row.id,
        expected_epoch: row.leaseEpoch,
        expected_version: row.stateVersion,
        reason: 'input',
      });
      const turns = (await (
        await call(app, `/conversations/${conversation.id}/messages`)
      ).json()) as { turns: Array<{ status: string; answer: string }> };
      expect(turns.turns.at(-1)).toMatchObject({ status: 'done', answer: ANSWER });

      // Work in the person's own space, which still holds its room row, is offered no room tool.
      const [own] = await fixture.sql`select id from space
        where kind = 'personal' and id <> ${space.id}`;
      if (!own) throw new Error('Missing the first personal space');
      expect(before.some((entry) => entry.space_id === own.id)).toBe(true);
      const work = await off.jobs.create({
        space_id: String(own.id),
        title: 'Tools',
        objective: 'Say which tools there are',
      });
      const claimed = await off.runner.claim({
        job_id: work.id,
        expected_epoch: work.leaseEpoch,
        expected_version: work.stateVersion,
        reason: 'created',
      });
      if (!claimed) throw new Error('The work was not claimed');
      const offered = claimed.bundle.tools.map((tool) => tool.name);
      expect(offered).toEqual(expect.arrayContaining(['files.read']));
      for (const tool of ROOM_TOOLS) expect(offered).not.toContain(tool);
      // Nor can one be found later: neither room connection is served at all.
      for (const entry of before) expect(off.registry?.get(String(entry.id))).toBeUndefined();
    } finally {
      await off.close();
    }
  },
  180_000,
);
