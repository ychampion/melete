import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  agentTemplateList,
  connectionListResponse,
  experienceConnectionList,
  type JsonObject,
  suggestedConnections,
} from '@melete/contracts';
import { renderInstructions } from '@melete/runtime-hermes';
import { BrokerService } from '../../src/broker/service.ts';
import { emailManifest } from '../../src/connectors/email.ts';
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
  'files.delete',
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
      MELETE_PREVIEW_MULTIPLAYER: 'true',
      NODE_ENV: 'test',
      DATABASE_URL: url,
      MELETE_CAPABILITY_KEY: 'default-connections-key'.repeat(2),
      MELETE_RUNTIME_ADAPTER: 'stub',
      MELETE_SPACES_DIR: root,
      MELETE_WORK_DIR: root,
      ...extra,
    }),
  });

async function claimIn(
  running: Awaited<ReturnType<typeof service>>,
  spaceId: string,
  objective = 'Use what a new installation offers',
) {
  if (!running.jobs || !running.runner) throw new Error('Missing runtime service');
  const row = await running.jobs.create({ space_id: spaceId, title: 'Defaults', objective });
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
const journey = late ? await database() : null;

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
      expect(listed.map((row) => row.provider).sort()).toEqual([
        'apps',
        'artifacts',
        'files',
        'notes',
        'room',
        'skills',
        'web',
      ]);
      expect(listed.every((row) => row.builtin === true && row.status === 'active')).toBe(true);
      // Settings is told which connections the service keeps, so it offers no removal for them.
      type Shown = {
        connections: Array<{
          id: string;
          label: string;
          builtin?: boolean;
          status: string;
          problem?: { kind: string; detail: string };
        }>;
      };
      const shown = (await (
        await running.app.request('/experience/connections', { headers: { cookie } })
      ).json()) as Shown;
      expect(shown.connections.map((row) => [row.label, row.builtin])).toEqual([
        ['Apps', true],
        ['Files', true],
        ['Notes', true],
        ['Rooms', true],
        ['Saved results', true],
        ['Skills', true],
        ['Web', true],
      ]);
      // Each runs here, so each is shown connected, with nothing wrong.
      expect(shown.connections.every((row) => row.status === 'connected' && !row.problem)).toBe(
        true,
      );

      // A default Speech row left behind by a provider this service no longer
      // has is installed but runs nowhere: it says so, not Connected.
      const speechId = newId('conn');
      await fixture.sql`insert into connection (id, space_id, provider, label, scopes, status,
          health, setup_state, configuration)
        values (${speechId}, ${space.id}, 'generation', 'Speech', '["audio.synthesize"]'::jsonb,
          'active', 'ok', 'connected', '{"builtin":"generation"}'::jsonb)`;
      const after = (await (
        await running.app.request('/experience/connections', { headers: { cookie } })
      ).json()) as Shown;
      expect(after.connections.find((row) => row.id === speechId)).toMatchObject({
        status: 'error',
        problem: { kind: 'not_running' },
      });
      await fixture.sql`delete from connection where id = ${speechId}`;

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
      // The core catalog is chosen by relevance to the job's own words under a
      // token budget, so a default tool is reachable rather than always resident:
      // a workspace read is in the core, and whatever stays outside it is named
      // in the index load_tool carries and can be loaded by that exact name.
      const core = await broker.catalog(claimed.claims);
      const resident = names(core);
      expect(resident).toEqual(expect.arrayContaining(['search_tools', 'load_tool', 'files.read']));
      const index = core.find((tool) => tool.name === 'load_tool')?.description ?? '';
      expect(names(await broker.discovery.available(claimed.claims))).toEqual(
        expect.arrayContaining(DEFAULT_TOOLS),
      );
      expect(await broker.discovery.search(claimed.claims, 'publish artifact')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'artifact.publish', effect_class: 'write_external' }),
        ]),
      );
      for (const tool of DEFAULT_TOOLS.filter((name) => !resident.includes(name))) {
        expect(index).toContain(tool);
        expect((await broker.discovery.load(claimed.claims, tool)).tool.name).toBe(tool);
      }
      expect(names(await broker.catalog(claimed.claims))).toEqual(
        expect.arrayContaining(DEFAULT_TOOLS),
      );
      // A job whose own words name a default's verb is handed it in the core.
      const writing = await claimIn(running, space.id, 'Write the note file in the workspace');
      expect(names(await broker.catalog(writing.claims))).toContain('files.write');
      const files = listed.find((row) => row.provider === 'files');
      if (!files) throw new Error('Missing default files connection');
      const written = await broker.propose(claimed.claims, {
        connection_id: files.id,
        kind: 'files.write',
        payload: { path: 'note.txt', content: 'kept in the job workspace' },
      });
      expect(written.status).toBe('succeeded');
      // A new file in the person's own Files goes through, with its receipt;
      // saving over one of theirs or taking one out of their Files asks.
      const propose = (kind: string, payload: JsonObject) =>
        broker.propose(claimed.claims, { connection_id: files.id, kind, payload });
      const saved = await propose('files.write', {
        path: 'imgtest.png',
        area: 'artifacts',
        content: 'new',
      });
      expect(saved.status).toBe('succeeded');
      const movedIn = await propose('files.move', {
        from: 'note.txt',
        to: 'note.txt',
        to_area: 'artifacts',
      });
      expect(movedIn.status).toBe('succeeded');
      for (const [kind, payload] of [
        ['files.write', { path: 'imgtest.png', area: 'artifacts', content: 'replaced' }],
        ['files.move', { from: 'note.txt', to: 'back.txt', area: 'artifacts', to_area: 'work' }],
        ['files.move', { from: 'note.txt', to: 'renamed.txt', area: 'artifacts' }],
      ] as const)
        expect((await propose(kind, payload)).status).toBe('needs_approval');
      // A standing permission to save files covers saving over one of theirs.
      const ruled = new BrokerService({
        sql: fixture.sql,
        connectors: running.registry,
        resolveStandingGrant: async () => true,
      });
      const replaced = await ruled.propose(claimed.claims, {
        connection_id: files.id,
        kind: 'files.write',
        payload: { path: 'imgtest.png', area: 'artifacts', content: 'replaced by rule' },
      });
      expect(replaced.status).toBe('succeeded');
      const reread = await propose('files.read', { path: 'imgtest.png', area: 'artifacts' });
      const [row] = await fixture.sql`select receipt from action where id = ${reread.action_id}`;
      expect(row?.receipt?.detail?.content).toBe('replaced by rule');
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
      // Speech and transcription are two rows of the generation provider.
      const expected = [
        'apps',
        'artifacts',
        'files',
        'generation',
        'generation',
        'notes',
        'room',
        'skills',
        'web',
      ];
      expect(await providers(personal)).toEqual(expected);
      // A grant the owner already made is kept as it is, never doubled.
      expect(await providers(seeded)).toEqual(expected);
      const seededFiles =
        await fixture.sql`select id, scopes from connection where space_id = ${seeded} and provider = 'files'`;
      expect(seededFiles.map((row) => [row.id, row.scopes])).toEqual([[handmade, ['files.read']]]);
      expect(await providers(evaluation)).toEqual([]);

      const claimed = await claimIn(upgraded, personal);
      // Every default is granted; the first catalog holds as many as it can,
      // and the rest are found through the catalog's search.
      expect(claimed.claims.scopes).toEqual(
        expect.arrayContaining([...DEFAULT_TOOLS, 'audio.synthesize', 'audio.transcribe']),
      );
      expect(names(claimed.bundle.tools)).toEqual(
        expect.arrayContaining(['audio.synthesize', 'audio.transcribe']),
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
      // Files, the web, saved results, apps, the agent's own notes, the person's own skills and room tools.
      expect(ownerConnections).toHaveLength(7);

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
        ['Apps', true],
        ['Files', true],
        ['Notes', true],
        ['Rooms', true],
        ['Saved results', true],
        ['Skills', true],
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

(late ? test : test.skip)(
  'a request furnishes the one space it made and leaves every other space alone',
  async () => {
    const fixture = late;
    if (!fixture) throw new Error('Postgres unavailable');
    const running = await service(fixture.url);
    const providers = async (spaceId: string) =>
      (
        await fixture.sql`select provider from connection where space_id = ${spaceId} order by provider`
      ).map((row) => row.provider);
    // Which defaults a space has, and what each of its room tools grants.
    const defaults = async (spaceId: string) =>
      (
        await fixture.sql`select configuration->>'builtin' as key, scopes from connection
          where space_id = ${spaceId} order by key`
      ).map((row) =>
        ['apps', 'rooms', 'room_handoff'].includes(String(row.key))
          ? [row.key, row.scopes]
          : row.key,
      );
    try {
      const signIn = async (email: string) => {
        const response = await running.app.request('/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: 'late-space-password' }),
        });
        expect(response.status).toBe(200);
        return response.headers.get('set-cookie')?.split(';')[0] ?? '';
      };
      const cookie = await signIn('owner@example.test');

      // A space that is deliberately bare: nothing but the request that made a
      // space of its own may reach into it.
      const bare = newId('sp');
      const [account] = await fixture.sql`select id from owner limit 1`;
      if (!account) throw new Error('Missing owner');
      await fixture.sql`insert into space (id, name, git_path, owner_principal_id, kind, audience)
        values (${bare}, 'Kept bare', ${join(root, bare)}, ${account.id}, 'shared', 'space')`;

      const shared = await running.app.request('/spaces/shared', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Together' }),
      });
      expect(shared.status).toBe(201);
      const made = ((await shared.json()) as { space: { id: string } }).space.id;
      expect(await providers(made)).toEqual(['apps', 'artifacts', 'files', 'room', 'web']);
      // A room's space gets Apps and the hand-off to a person, never a person's room tools.
      expect(await defaults(made)).toEqual([
        ['apps', expect.arrayContaining(['apps.publish'])],
        'artifacts',
        'files',
        ['room_handoff', ['room.handoff']],
        'web',
      ]);
      expect(await providers(bare)).toEqual([]);

      // A provisioned account is furnished in its own personal space, and only there.
      const provisioned = await running.app.request('/principals', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'third@example.test', password: 'late-space-password' }),
      });
      expect(provisioned.status).toBe(201);
      const account3 = ((await provisioned.json()) as { principal: { id: string } }).principal.id;
      const [theirs] =
        await fixture.sql`select id from space where owner_principal_id = ${account3}`;
      if (!theirs) throw new Error('A provisioned account has no space');
      expect(await providers(theirs.id)).toEqual([
        'apps',
        'artifacts',
        'files',
        'notes',
        'room',
        'skills',
        'web',
      ]);
      // A person's own space gets Apps, the agent's own notes and their own room tools, and no hand-off.
      expect(await defaults(theirs.id)).toEqual([
        ['apps', expect.arrayContaining(['apps.publish'])],
        'artifacts',
        'files',
        'notes',
        ['rooms', ['room.list', 'room.post', 'room.add_file']],
        'skills',
        'web',
      ]);
      expect(await providers(bare)).toEqual([]);

      // What it was given is its own, and its first attempt is handed the tools.
      const third = await signIn('third@example.test');
      const shown = (await (
        await running.app.request('/experience/connections', { headers: { cookie: third } })
      ).json()) as { connections: Array<{ id: string }> };
      expect(
        (await fixture.sql`select id from connection where space_id = ${theirs.id} order by id`)
          .map((row) => row.id)
          .sort(),
      ).toEqual(shown.connections.map((row) => row.id).sort());
      expect(names((await claimIn(running, theirs.id)).bundle.tools)).toEqual(
        expect.arrayContaining(DEFAULT_TOOLS),
      );
    } finally {
      await running.close();
    }
  },
  180_000,
);

const skilled = late ? await database() : null;

(skilled ? test : test.skip)(
  'a first attempt reads the skill its words call for, and a skill it cannot use takes no place',
  async () => {
    const fixture = skilled;
    if (!fixture) throw new Error('Postgres unavailable');
    const running = await service(fixture.url);
    try {
      const setup = await running.app.request('/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'skills@example.test', password: 'skills-install-password' }),
      });
      expect(setup.status).toBe(201);
      const [space] = await fixture.sql`select id, git_path from space where kind = 'personal'`;
      if (!space) throw new Error('Missing personal space');
      const skillNames = (claimed: Awaited<ReturnType<typeof claimIn>>) =>
        claimed.bundle.skills.map((skill) => skill.name);

      // The default tools are enough for research, so the built-in skill arrives.
      const researching = await claimIn(
        running,
        space.id,
        'Research standing desks and cite sources',
      );
      expect(skillNames(researching)).toEqual(['research-with-sources']);
      // Every other skill the attempt can use is named in its index, one line each and no body.
      const indexed = (researching.bundle.skill_index ?? []).map((entry) => entry.name);
      expect(indexed).toEqual(
        expect.arrayContaining(['summarize-a-source', 'write-a-draft', 'plan-a-responsibility']),
      );
      expect(indexed).not.toContain('research-with-sources');
      // A skill needing a mailbox this space lacks is not offered at all.
      expect(indexed).not.toContain('triage-the-inbox');
      // The conversation is told, as a tool entry, which skill the attempt follows.
      const traced = await fixture.sql`select payload from event
        where attempt_id = ${researching.claims.attempt_id} and type = 'notice'
          and payload->>'kind' = 'tool_trace'`;
      expect(traced.map((row) => row.payload.call)).toEqual([
        expect.objectContaining({
          id: `skills:${researching.claims.attempt_id}`,
          kind: 'skill',
          title: 'Used the skill: Research with sources',
          status: 'done',
        }),
      ]);

      // A skill that waits on a trigger is usable: the lifecycle wait is the broker's own tool.
      const skills = join(space.git_path, 'skills');
      await mkdir(skills, { recursive: true });
      const put = (name: string, triggers: string[], tools: string[]) =>
        writeFile(
          join(skills, `${name}.md`),
          `---\nname: ${name}\ndescription: A skill this person wrote for themselves.\ntriggers:\n${triggers
            .map((trigger) => `  - ${trigger}\n`)
            .join('')}tools:\n${tools.map((tool) => `  - ${tool}\n`).join('')}---\n\nDo it.\n`,
        );
      await put('watch-a-page', ['watch the page'], ['web.fetch', 'job.wait']);
      expect(
        skillNames(await claimIn(running, space.id, 'Watch the page for a price drop')),
      ).toEqual(['watch-a-page']);

      // Three better matches that need a mailbox this space lacks leave room for the one it can use.
      for (const name of ['desk-mail-one', 'desk-mail-two', 'desk-mail-three'])
        await put(name, ['research', 'standing desks'], ['email.send']);
      expect(
        skillNames(await claimIn(running, space.id, 'Research standing desks and cite sources')),
      ).toEqual(['research-with-sources']);
    } finally {
      await running.close();
    }
  },
  120_000,
);

(journey ? test : test.skip)(
  'a new agent reaches the files the space set up, and a later mailbox once ticked',
  async () => {
    const fixture = journey;
    if (!fixture) throw new Error('Postgres unavailable');
    const running = await service(fixture.url);
    try {
      const setup = await running.app.request('/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'journey@example.test',
          password: 'journey-install-password',
        }),
      });
      expect(setup.status).toBe(201);
      const cookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';
      const call = async (path: string, method = 'GET', body?: unknown) =>
        running.app.request(path, {
          method,
          headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      // A template grants nothing itself; its draft starts with the connections it
      // works best with ticked, and the person creates it as it is.
      const { templates } = agentTemplateList.parse(await (await call('/agents/templates')).json());
      const review = templates.find((template) => template.id === 'weekly-review');
      if (!review) throw new Error('Missing weekly review template');
      expect(review.agent.allowed_connection_ids).toEqual([]);
      const listed = experienceConnectionList.parse(
        await (await call('/experience/connections')).json(),
      );
      const ticked = suggestedConnections(review.works_best_with, listed.connections);
      expect(ticked.length).toBeGreaterThan(0);
      const made = await call('/agents', 'POST', {
        ...review.agent,
        allowed_connection_ids: ticked,
      });
      expect(made.status).toBeLessThan(300);
      const { agent } = (await made.json()) as { agent: { id: string } };
      if (!running.registry || !running.jobs || !running.runner) throw new Error('Missing runtime');
      const broker = new BrokerService({ sql: fixture.sql, connectors: running.registry });
      const ask = async (text: string) => {
        const started = await call('/conversations', 'POST', { title: text, agent_id: agent.id });
        const { conversation } = (await started.json()) as { conversation: { id: string } };
        expect(
          (await call(`/conversations/${conversation.id}/messages`, 'POST', { text })).status,
        ).toBeLessThan(300);
        const row = await running.jobs?.get(conversation.id);
        if (!row) throw new Error('Missing conversation job');
        const claimed = await running.runner?.claim({
          job_id: row.id,
          expected_epoch: row.leaseEpoch,
          expected_version: row.stateVersion,
          reason: 'input',
        });
        if (!claimed) throw new Error('Turn was not claimed');
        return names(await broker.discovery.available(claimed.claims));
      };
      expect(await ask('List my files')).toContain('files.list');

      const [space] = await fixture.sql`select id from space where kind = 'personal'`;
      const mailbox = newId('conn');
      running.registry.register(mailbox, {
        manifest: emailManifest,
        async execute() {
          throw new Error('not dispatched here');
        },
        async verify() {
          return { decision: 'unsupported', reason: 'fixture' };
        },
        async health() {
          return { status: 'ok', detail: 'fixture', checked_at: new Date().toISOString() };
        },
      });
      await fixture.sql`insert into connection (id, space_id, provider, label, scopes, status)
        values (${mailbox}, ${space?.id}, ${emailManifest.provider}, 'Mail',
          ${JSON.stringify(emailManifest.tools.map((tool) => tool.name))}::jsonb, 'active')`;
      // A mailbox connected later is not reached until the person ticks it.
      expect(await ask('Draft a note to Alex')).not.toContain('email.draft');
      expect(
        (
          await call(`/agents/${agent.id}`, 'PATCH', {
            ...review.agent,
            allowed_connection_ids: [...ticked, mailbox],
          })
        ).status,
      ).toBeLessThan(300);
      expect(await ask('Draft a note to Alex')).toContain('email.draft');
    } finally {
      await running.close();
    }
  },
  120_000,
);

const demo = late ? await database() : null;

(demo ? test : test.skip)(
  'the test connector adds its grants beside the default tools instead of replacing them',
  async () => {
    const fixture = demo;
    if (!fixture) throw new Error('Postgres unavailable');
    const running = await service(fixture.url, { MELETE_ENABLE_TEST_CONNECTOR: 'true' });
    try {
      const setup = await running.app.request('/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'demo@example.test', password: 'demo-install-password' }),
      });
      expect(setup.status).toBe(201);
      const [space] = await fixture.sql`select id from space where kind = 'personal'`;
      if (!space) throw new Error('Missing personal space');
      const claimed = await claimIn(running, space.id, 'Research standing desks and cite sources');
      expect(claimed.claims.scopes).toEqual(
        expect.arrayContaining([...DEFAULT_TOOLS, 'job.wait', 'test.send', 'test.read']),
      );
      expect(claimed.bundle.skills.map((skill) => skill.name)).toContain('research-with-sources');
    } finally {
      await running.close();
    }
  },
  120_000,
);

const accounts = journey ? await database() : null;

(accounts ? test : test.skip)(
  "a GitHub account the computer's command line reaches is named to the agent and found by search",
  async () => {
    const fixture = accounts;
    if (!fixture) throw new Error('Postgres unavailable');
    const running = await service(fixture.url);
    try {
      const setup = await running.app.request('/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'github@example.test', password: 'github-install-password' }),
      });
      expect(setup.status).toBe(201);
      const [space] = await fixture.sql`select id from space where kind = 'personal'`;
      if (!space) throw new Error('Missing personal space');
      // As connecting GitHub for the agent's computer makes it: no tool, only the relay's grants.
      await fixture.sql`insert into connection (id, space_id, provider, label, scopes, status,
          health, setup_state, configuration)
        values (${newId('conn')}, ${space.id}, 'command_line', 'GitHub',
          '["egress.github_read","egress.github_write"]'::jsonb, 'active', 'ok', 'connected',
          '{"kind":"command_line","adapter":"github"}'::jsonb)`;

      const claimed = await claimIn(running, space.id, 'List the open issues in my repository');
      const named = claimed.bundle.connected_accounts ?? [];
      expect(named).toHaveLength(1);
      // This installation runs no computer, so the agent is told where the account is reached.
      expect(named[0]).toStartWith("GitHub: reached only from your computer's terminal");
      // The defaults every space has are not listed again.
      expect(named.join(' ')).not.toContain('Files');
      expect(renderInstructions(claimed.bundle)).toContain(
        `# Connected accounts\n\nThe person connected these.`,
      );

      if (!running.registry) throw new Error('Missing registry');
      const broker = new BrokerService({ sql: fixture.sql, connectors: running.registry });
      const found = await broker.discovery.find(claimed.claims, 'github issues');
      expect(found.hint).toContain('GitHub (run git or gh with terminal.run');
      const unrelated = await broker.discovery.find(claimed.claims, 'weather forecast');
      expect(unrelated.hint ?? '').not.toContain('GitHub');
    } finally {
      await running.close();
    }
  },
  120_000,
);
