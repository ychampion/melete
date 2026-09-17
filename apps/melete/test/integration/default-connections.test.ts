import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { connectionListResponse } from '@melete/contracts';
import { BrokerService } from '../../src/broker/service.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { bootstrap } from '../../src/index.ts';
import { testDatabase } from '../helpers/database.ts';

const root = await mkdtemp(join(await realpath(tmpdir()), 'melete-defaults-'));
const fixtures: NonNullable<Awaited<ReturnType<typeof testDatabase>>>[] = [];
afterAll(async () => {
  for (const fixture of fixtures) await fixture.close();
  if (dirname(await realpath(root)) !== (await realpath(tmpdir())))
    throw new Error('Unexpected fixture root');
  await rm(root, { recursive: true, force: true });
}, 60_000);

const DEFAULT_TOOLS = [
  'artifact.publish',
  'files.list',
  'files.move',
  'files.read',
  'files.write',
  'web.fetch',
];

async function database() {
  const fixture = await testDatabase();
  if (fixture) fixtures.push(fixture);
  return fixture;
}

const service = (url: string, extra: Record<string, string> = {}) =>
  bootstrap({
    workers: false,
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: url,
      MELETE_CAPABILITY_KEY: 'default-connections-key'.repeat(2),
      MELETE_RUNTIME_ADAPTER: 'stub',
      MELETE_SPACES_DIR: root,
      MELETE_WORK_DIR: root,
      ...extra,
    }),
  });

async function claimIn(running: Awaited<ReturnType<typeof service>>, spaceId: string) {
  if (!running.jobs || !running.runner) throw new Error('Missing runtime service');
  const row = await running.jobs.create({
    space_id: spaceId,
    title: 'Defaults',
    objective: 'Use what a new installation offers',
  });
  const claimed = await running.runner.claim({
    job_id: row.id,
    expected_epoch: row.leaseEpoch,
    expected_version: row.stateVersion,
    reason: 'created',
  });
  if (!claimed) throw new Error('Attempt was not claimed');
  return claimed;
}

const names = (tools: readonly { name: string }[]) => tools.map((tool) => tool.name);

const fresh = await database();
const existing = fresh ? await database() : null;
const late = existing ? await database() : null;

(fresh ? test : test.skip)(
  'a fresh installation offers a useful catalog without any hand-made connection',
  async () => {
    const fixture = fresh;
    if (!fixture) throw new Error('Postgres unavailable');
    const running = await service(fixture.url);
    try {
      expect(await fixture.sql`select id from connection`).toHaveLength(0);
      const setup = await running.app.request('/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'fresh@example.test', password: 'fresh-install-password' }),
      });
      expect(setup.status).toBe(201);
      // Setup is rate limited and hands back a session and a device cookie; the
      // defaults are still made for the space that answering it created.
      expect(
        setup.headers
          .getSetCookie()
          .map((value) => value.split('=')[0])
          .sort(),
      ).toEqual(['melete_device', 'melete_session']);
      const cookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';
      const [space] = await fixture.sql`select id from space where kind = 'personal'`;
      if (!space) throw new Error('Missing personal space');

      const listed = connectionListResponse.parse(
        await (await running.app.request('/connections', { headers: { cookie } })).json(),
      ).connections;
      expect(listed.map((row) => row.provider).sort()).toEqual(['artifacts', 'files', 'web']);
      expect(listed.every((row) => row.builtin === true && row.status === 'active')).toBe(true);
      // Settings is told which connections the service keeps, so it offers no removal for them.
      const shown = (await (
        await running.app.request('/experience/connections', { headers: { cookie } })
      ).json()) as { connections: Array<{ label: string; builtin?: boolean }> };
      expect(shown.connections.map((row) => [row.label, row.builtin])).toEqual([
        ['Files', true],
        ['Finished work', true],
        ['Web', true],
      ]);

      // A second setup is refused before it reads a password, and refusing it
      // makes nothing: the defaults stay the rows the first setup created.
      const installed = (await fixture.sql`select id from connection order by id`).map(
        (row) => row.id,
      );
      const repeated = await running.app.request('/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'second@example.test',
          password: 'another-install-password',
        }),
      });
      expect(repeated.status).toBe(409);
      expect(repeated.headers.getSetCookie()).toEqual([]);
      expect(
        (await fixture.sql`select id from connection order by id`).map((row) => row.id),
      ).toEqual(installed);

      const claimed = await claimIn(running, space.id);
      expect(names(claimed.bundle.tools)).toEqual(expect.arrayContaining(DEFAULT_TOOLS));
      expect(claimed.claims.scopes).toEqual(expect.arrayContaining([...DEFAULT_TOOLS, 'job.wait']));
      // In-cell execution is a default only where the cell is a container.
      expect(names(claimed.bundle.tools)).not.toContain('exec.run');
      expect(names(claimed.bundle.tools)).not.toContain('audio.synthesize');

      // The same registry answers the broker, and the broker's rules are unchanged:
      // a workspace write is admitted, a publication still waits for approval.
      if (!running.registry) throw new Error('Missing registry');
      const broker = new BrokerService({ sql: fixture.sql, connectors: running.registry });
      expect(names(await broker.catalog(claimed.claims))).toEqual(
        expect.arrayContaining(['files.read', 'files.write']),
      );
      expect(names(await broker.discovery.available(claimed.claims))).toEqual(
        expect.arrayContaining(DEFAULT_TOOLS),
      );
      expect(await broker.discovery.search(claimed.claims, 'publish artifact')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'artifact.publish', effect_class: 'write_external' }),
        ]),
      );
      const files = listed.find((row) => row.provider === 'files');
      if (!files) throw new Error('Missing default files connection');
      const written = await broker.propose(claimed.claims, {
        connection_id: files.id,
        kind: 'files.write',
        payload: { path: 'note.txt', content: 'kept in the job workspace' },
      });
      expect(written.status).toBe('succeeded');
    } finally {
      await running.close();
    }
  },
  120_000,
);

(existing ? test : test.skip)(
  'an existing installation gains the default tools once, and a removal stays removed',
  async () => {
    const fixture = existing;
    if (!fixture) throw new Error('Postgres unavailable');
    // The rows an earlier release left behind: an owner, a space, no connections.
    const ownerId = newId('own');
    const personal = newId('sp');
    const seeded = newId('sp');
    const evaluation = newId('sp');
    const handmade = newId('conn');
    const hash = await Bun.password.hash('upgrade-password', { algorithm: 'argon2id' });
    await fixture.sql`insert into owner (id, email, password_hash) values (${ownerId}, 'upgrade@example.test', ${hash})`;
    await fixture.sql`insert into principal (id, email, password_hash) values (${ownerId}, 'upgrade@example.test', ${hash})`;
    await fixture.sql`insert into space (id, name, git_path, owner_principal_id, kind, audience) values
      (${personal}, 'Personal', ${join(root, personal)}, ${ownerId}, 'personal', 'owner'),
      (${seeded}, 'Seeded', ${join(root, seeded)}, ${ownerId}, 'personal', 'owner'),
      (${evaluation}, 'Procedure evaluation: baseline', ${`evaluation/${evaluation}`}, ${ownerId}, 'personal', 'owner')`;
    await fixture.sql`insert into connection (id, space_id, provider, label, scopes) values
      (${handmade}, ${seeded}, 'files', 'Hand-made files', '["files.read"]'::jsonb)`;

    const providers = async (spaceId: string) =>
      (
        await fixture.sql`select provider from connection where space_id = ${spaceId} order by provider`
      ).map((row) => row.provider);

    const upgraded = await service(fixture.url, { MELETE_ENABLE_FAKE_PROVIDER: 'true' });
    let webId = '';
    try {
      expect(await providers(personal)).toEqual(['artifacts', 'files', 'generation', 'web']);
      // A grant the owner already made is kept as it is, never doubled.
      expect(await providers(seeded)).toEqual(['artifacts', 'files', 'generation', 'web']);
      const seededFiles =
        await fixture.sql`select id, scopes from connection where space_id = ${seeded} and provider = 'files'`;
      expect(seededFiles.map((row) => [row.id, row.scopes])).toEqual([[handmade, ['files.read']]]);
      expect(await providers(evaluation)).toEqual([]);

      const claimed = await claimIn(upgraded, personal);
      expect(names(claimed.bundle.tools)).toEqual(
        expect.arrayContaining([...DEFAULT_TOOLS, 'audio.synthesize']),
      );

      const login = await upgraded.app.request('/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'upgrade@example.test', password: 'upgrade-password' }),
      });
      const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
      const [web] =
        await fixture.sql`select id, generation from connection where space_id = ${personal} and provider = 'web'`;
      if (!web) throw new Error('Missing default web connection');
      webId = web.id;
      const revoked = await upgraded.app.request(`/connections/${web.id}/lifecycle`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'revoke', expected_generation: web.generation }),
      });
      expect(revoked.status).toBe(200);
      expect(names((await claimIn(upgraded, personal)).bundle.tools)).not.toContain('web.fetch');
    } finally {
      await upgraded.close();
    }

    const rows = async () =>
      (await fixture.sql`select id, status from connection order by id`).map((row) => [
        row.id,
        row.status,
      ]);
    const before = await rows();
    const again = await service(fixture.url, { MELETE_ENABLE_FAKE_PROVIDER: 'true' });
    try {
      expect(await rows()).toEqual(before);
      expect(before).toContainEqual([webId, 'revoked']);
      const tools = names((await claimIn(again, personal)).bundle.tools);
      expect(tools).not.toContain('web.fetch');
      expect(tools).toEqual(expect.arrayContaining(['files.read', 'artifact.publish']));
      expect(again.registry?.get(webId)).toBeUndefined();
    } finally {
      await again.close();
    }
  },
  180_000,
);

(late ? test : test.skip)(
  'an account whose own space is made on its first request finds the default tools in it',
  async () => {
    const fixture = late;
    if (!fixture) throw new Error('Postgres unavailable');
    // An installation whose owner has a space, and a second account that has none.
    const ownerId = newId('own');
    const memberId = newId('own');
    const ownerSpace = newId('sp');
    const hash = await Bun.password.hash('late-space-password', { algorithm: 'argon2id' });
    await fixture.sql`insert into owner (id, email, password_hash) values (${ownerId}, 'owner@example.test', ${hash})`;
    await fixture.sql`insert into principal (id, email, password_hash) values
      (${ownerId}, 'owner@example.test', ${hash}),
      (${memberId}, 'later@example.test', ${hash})`;
    await fixture.sql`insert into space (id, name, git_path, owner_principal_id, kind, audience)
      values (${ownerSpace}, 'Personal', ${join(root, ownerSpace)}, ${ownerId}, 'personal', 'owner')`;

    const running = await service(fixture.url);
    try {
      const theirs = await fixture.sql`select id from space where owner_principal_id = ${memberId}`;
      expect(theirs).toHaveLength(0);
      const ownerConnections = (
        await fixture.sql`select id from connection where space_id = ${ownerSpace} order by id`
      ).map((row) => row.id);
      expect(ownerConnections).toHaveLength(3);

      const login = await running.app.request('/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'later@example.test', password: 'late-space-password' }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';

      // The first request is what makes the space, and it is furnished at once.
      const shown = (await (
        await running.app.request('/experience/connections', { headers: { cookie } })
      ).json()) as { connections: Array<{ id: string; label: string; builtin?: boolean }> };
      expect(shown.connections.map((row) => [row.label, row.builtin])).toEqual([
        ['Files', true],
        ['Finished work', true],
        ['Web', true],
      ]);
      // Settings reads the space the session speaks for, never another account's.
      for (const row of shown.connections) expect(ownerConnections).not.toContain(row.id);

      const [own] = await fixture.sql`select id from space where owner_principal_id = ${memberId}`;
      if (!own) throw new Error('The first request made no space');
      expect(
        (await fixture.sql`select id from connection where space_id = ${own.id} order by id`)
          .map((row) => row.id)
          .sort(),
      ).toEqual(shown.connections.map((row) => row.id).sort());

      const claimed = await claimIn(running, own.id);
      expect(names(claimed.bundle.tools)).toEqual(expect.arrayContaining(DEFAULT_TOOLS));
    } finally {
      await running.close();
    }
  },
  180_000,
);
