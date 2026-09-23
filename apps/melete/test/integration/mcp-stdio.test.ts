/**
 * A stdio MCP server installed through the API, with the fake launcher in
 * place of containers: the sealed variables reach only the server, its tools
 * are admitted by the broker like any other connector's, it runs only when a
 * call needs it, it stops with its revocation, and a crashing server is not
 * restarted in a loop. The container itself is proved by conformance 9.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  connectionCheckResponse,
  connectionKindListResponse,
  connectionResponse,
  installPluginResponse,
  type JsonObject,
  PLUGIN_CATALOG,
  pluginEntry,
  pluginListResponse,
  receipt,
} from '@melete/contracts';
import { loadAction } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import {
  ConnectorFactory,
  configuredConnectors,
  useConnectorFactory,
} from '../../src/connectors/configured.ts';
import { STDIO_REFUSALS } from '../../src/connectors/mcp-stdio.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { RuntimeCatalog } from '../../src/knowledge/catalog.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { DISHONEST_TOOLS, FakeStdioLauncher } from '../fixtures/stdio-launcher.ts';
import { testDatabase } from '../helpers/database.ts';

const MASTER_KEY = '5a'.repeat(32);
const SECRET = 'notes-token-sealed-and-never-returned';

const fixture = await testDatabase();
const queue = fixture ? await startQueue(fixture.url) : null;
const registry = new ConnectorRegistry();
const launcher = new FakeStdioLauncher();
const registries: ConnectorRegistry[] = [registry];
afterAll(async () => {
  for (const item of registries) await item.close();
  await queue?.stop();
  await fixture?.close();
}, 30_000);

const installation = (id: string) => ({
  provider: 'mcp',
  label: 'Notes server',
  mcp_stdio: {
    id,
    runner: 'npx',
    source: '@example/notes-server@1.0.0',
    args: ['/data'],
    secret_env: [{ name: 'NOTES_TOKEN', value: SECRET }],
    allowed_scopes: [`mcp_${id}.lookup`, `mcp_${id}.publish`],
    audience: 'owner',
    tools: [
      {
        name: 'lookup',
        alias: 'lookup',
        required_scopes: [`mcp_${id}.lookup`],
        effect_class: 'read',
      },
      // Left unclassified, the server's own readOnlyHint notwithstanding.
      { name: 'publish', alias: 'publish', required_scopes: [`mcp_${id}.publish`] },
    ],
  },
});

async function harness() {
  if (!fixture || !queue) throw new Error('Postgres unavailable');
  const env = loadEnv({ NODE_ENV: 'test', MELETE_MASTER_KEY: MASTER_KEY });
  const options = {
    sql: fixture.sql,
    workRoot: 'unused',
    spacesRoot: 'unused',
    masterKey: MASTER_KEY,
    stdioLauncher: launcher,
  };
  useConnectorFactory(registry, new ConnectorFactory(options));
  const jobs = new JobService(fixture.db, queue.boss);
  const catalog = new RuntimeCatalog(fixture.db, registry, 'unused');
  const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
    key: 'stdio-mcp-capability-key-at-least-32-bytes',
    liveConnectionScopes: true,
    loadCatalog: catalog.forAttempt,
  });
  const broker = new BrokerService({ sql: fixture.sql, connectors: registry, boss: queue.boss });
  const app = createApp({
    env,
    db: fixture.db,
    sql: fixture.sql,
    registry,
    jobs,
    checkDatabase: async () => 'ok',
  });
  // The same database behind a factory with no launcher, as a service without containers runs.
  const bare = new ConnectorRegistry();
  registries.push(bare);
  useConnectorFactory(bare, new ConnectorFactory({ ...options, stdioLauncher: undefined }));
  const withoutLauncher = createApp({
    env,
    db: fixture.db,
    sql: fixture.sql,
    registry: bare,
    jobs,
    checkDatabase: async () => 'ok',
  });
  const as = (cookie: string, body?: unknown): RequestInit => ({
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setup = await app.request(
    '/setup',
    as('', { email: 'stdio-owner@example.test', password: 'stdio-owner-password' }),
  );
  const cookie = setup.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error(`Setup failed: ${setup.status}`);
  const [space] = await fixture.sql`select id from space where kind = 'personal'`;
  if (!space) throw new Error('Missing personal space');
  const spaceId: string = space.id;

  /** A new attempt's tools, and its claims to act with. */
  const attempt = async (brokerService = broker) => {
    const row = await jobs.create({
      space_id: spaceId,
      title: 'Stdio MCP',
      objective: 'Use the notes server',
    });
    const claimed = await runner.claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'created',
    });
    if (!claimed) throw new Error('Attempt was not claimed');
    return {
      claims: claimed.claims,
      bundle: claimed.bundle.tools.map((tool) => tool.name),
      brokered: (await brokerService.discovery.available(claimed.claims)).map((tool) => tool.name),
    };
  };
  const install = async (body: unknown, target = app) => {
    const response = await target.request('/connections', as(cookie, body));
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) };
  };
  const revoke = async (id: string) => {
    const current = connectionResponse.parse(
      await (await app.request(`/connections/${id}`, as(cookie))).json(),
    ).connection;
    return app.request(
      `/connections/${id}/lifecycle`,
      as(cookie, { kind: 'revoke', expected_generation: current.generation }),
    );
  };
  return { app, withoutLauncher, broker, as, cookie, spaceId, attempt, install, revoke };
}

const h = fixture ? await harness() : null;
const withDb = fixture ? describe : describe.skip;

withDb('a stdio MCP server installed by its owner', () => {
  test('sealed variables reach only the server; its tools are admitted by the broker like any other', async () => {
    if (!h || !fixture) throw new Error('Postgres unavailable');
    const kinds = connectionKindListResponse.parse(
      await (await h.app.request('/connection-kinds', h.as(h.cookie))).json(),
    );
    expect(kinds.kinds.map((kind) => kind.kind)).toContain('mcp_stdio');

    const body = installation('notes');
    for (const invalid of [
      { ...body, scopes: ['mcp_notes.lookup'] },
      { ...body, credentials: { NOTES_TOKEN: SECRET } },
      { ...body, mcp_stdio: { ...body.mcp_stdio, allowed_scopes: ['mcp_notes.publish'] } },
      { ...body, mcp_stdio: { ...body.mcp_stdio, source: 'git+https://example.test/x.git' } },
      { ...body, mcp_stdio: { ...body.mcp_stdio, secret_env: [{ name: 'PATH', value: '/x' }] } },
    ]) {
      const refused = await h.install(invalid);
      expect(refused.status).toBe(400);
      expect(refused.text).not.toContain(SECRET);
    }
    expect(launcher.starts).toHaveLength(0);

    const created = await h.install(body);
    expect(created.status).toBe(201);
    const installed = connectionResponse.parse(created.json);
    expect(installed.connection).toMatchObject({ provider: 'mcp', status: 'active' });
    expect(installed.check?.code).toBe('ok');
    const id = installed.connection.id;
    // Installing starts the server once, so the owner sees its tools, with exactly its variables.
    expect(launcher.starts).toHaveLength(1);
    expect(launcher.starts[0]).toMatchObject({ connectionId: id, env: { NOTES_TOKEN: SECRET } });

    // The value is sealed; everything readable keeps only its name.
    const [row] = await fixture.sql`select c.configuration, s.ciphertext from connection c
      join secret s on s.id = c.secret_ref where c.id = ${id}`;
    const stored = JSON.stringify(row?.configuration);
    expect(stored).not.toContain(SECRET);
    expect(String(row?.ciphertext)).not.toContain(SECRET);
    expect(row?.configuration.server.endpoint.launch.secret_env_names).toEqual(['NOTES_TOKEN']);
    // The catalog is recorded as the server described it at installation, and only the named tools.
    expect(row?.configuration.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'lookup',
      'publish',
    ]);
    expect(stored).not.toContain('readOnlyHint');
    const readable = await Promise.all(
      ['/connections', `/connections/${id}`, '/experience/connections'].map(async (path) =>
        (await h.app.request(path, h.as(h.cookie))).text(),
      ),
    );
    for (const text of [created.text, ...readable]) expect(text).not.toContain(SECRET);
    expect((await h.install(body)).status).toBe(409);

    const offered = await h.attempt();
    for (const tools of [offered.bundle, offered.brokered]) {
      expect(tools).toContain('mcp_notes.lookup');
      expect(tools).toContain('mcp_notes.publish');
      expect(tools).not.toContain('mcp_notes.grant_everything');
    }

    const read = await h.broker.propose(offered.claims, {
      kind: 'mcp_notes.lookup',
      connection_id: id,
      payload: { q: 'meeting' },
    });
    expect(read.status).toBe('succeeded');
    const action = await loadAction(fixture.sql, read.action_id);
    const acknowledgement = receipt.parse(action.receipt);
    // What the server said, including a claim to speak for the owner, stays external content.
    expect(acknowledgement.detail.origin_trust).toBe('external_content');
    const said = (acknowledgement.detail.result as JsonObject).structuredContent as JsonObject;
    expect(said.environment_names).toEqual(['NOTES_TOKEN']);

    // readOnlyHint on the server does not remove the approval its policy requires.
    const calls = launcher.calls.length;
    const write = await h.broker.propose(offered.claims, {
      kind: 'mcp_notes.publish',
      connection_id: id,
      payload: { body: 'one external effect' },
    });
    expect(write.status).toBe('needs_approval');
    expect(write.effect_class).toBe('write_external');
    expect(launcher.calls).toHaveLength(calls);
    await h.broker.decide(write.action_id, {
      decision: 'approved',
      payload_hash: write.payload_hash,
    });
    await h.broker.admit(offered.claims, write.action_id, write.payload_hash);
    expect((await h.broker.dispatch(write.action_id)).status).toBe('succeeded');
    expect(launcher.calls.map((call) => call.name).slice(calls)).toEqual(['publish']);
  }, 120_000);

  test('a restarted service offers the recorded tools and starts nothing until a call needs it', async () => {
    if (!h || !fixture) throw new Error('Postgres unavailable');
    const booted = new FakeStdioLauncher();
    const restarted = await configuredConnectors({
      sql: fixture.sql,
      workRoot: 'unused',
      spacesRoot: 'unused',
      masterKey: MASTER_KEY,
      stdioLauncher: booted,
    });
    registries.push(restarted);
    const [row] = await fixture.sql`select id from connection
      where provider = 'mcp' and status = 'active' and configuration->'server'->>'id' = 'notes'`;
    const id = String(row?.id);
    expect(
      restarted
        .get(id)
        ?.manifest.tools.map((tool) => tool.name)
        .sort(),
    ).toEqual(['mcp_notes.lookup', 'mcp_notes.publish']);
    expect(booted.starts).toHaveLength(0);

    const broker = new BrokerService({
      sql: fixture.sql,
      connectors: restarted,
      boss: queue?.boss,
    });
    const offered = await h.attempt(broker);
    const read = await broker.propose(offered.claims, {
      kind: 'mcp_notes.lookup',
      connection_id: id,
      payload: { q: 'after restart' },
    });
    expect(read.status).toBe('succeeded');
    expect(booted.starts).toHaveLength(1);
    expect(booted.starts[0]?.env).toEqual({ NOTES_TOKEN: SECRET });
  }, 60_000);

  test('a server that crashes on every start is refused without starting, until its owner tests it', async () => {
    if (!h || !fixture) throw new Error('Postgres unavailable');
    const created = await h.install(installation('flaky'));
    expect(created.status).toBe(201);
    const id = connectionResponse.parse(created.json).connection.id;
    launcher.behaviour.crashOnStart = true;
    launcher.crash();
    const offered = await h.attempt();
    const statuses: string[] = [];
    for (let index = 0; index < 6; index++) {
      const outcome = await h.broker.propose(offered.claims, {
        kind: 'mcp_flaky.lookup',
        connection_id: id,
        payload: { q: `try ${index}` },
      });
      statuses.push(outcome.status);
    }
    expect(new Set(statuses)).toEqual(new Set(['failed']));
    const flakyStarts = () => launcher.starts.filter((start) => start.connectionId === id).length;
    // One start at installation, then starts until the budget is spent, then none at all.
    const spent = flakyStarts();
    expect(spent).toBeLessThanOrEqual(3);
    const refused = await h.broker.propose(offered.claims, {
      kind: 'mcp_flaky.lookup',
      connection_id: id,
      payload: { q: 'once more' },
    });
    expect(refused.status).toBe('failed');
    const [action] =
      await fixture.sql`select receipt, reconciliation from action where id = ${refused.action_id}`;
    expect(JSON.stringify(action)).toContain(STDIO_REFUSALS.crashLoop);
    expect(flakyStarts()).toBe(spent);

    // The owner's test is the retry.
    launcher.behaviour.crashOnStart = false;
    const tested = connectionCheckResponse.parse(
      await (await h.app.request(`/connections/${id}/health`, h.as(h.cookie, {}))).json(),
    );
    expect(tested.check.code).toBe('ok');
    expect(flakyStarts()).toBe(spent + 1);
    expect((await h.revoke(id)).status).toBe(200);
  }, 60_000);

  test('a plugin is added with one tap from the catalog, with only the values it asks for', async () => {
    if (!h || !fixture) throw new Error('Postgres unavailable');
    const list = async () =>
      pluginListResponse.parse(await (await h.app.request('/plugins', h.as(h.cookie))).json())
        .plugins;
    const catalog = await list();
    expect(catalog.map((plugin) => plugin.id)).toEqual(PLUGIN_CATALOG.map((entry) => entry.id));
    expect(catalog.every((plugin) => plugin.installed === null)).toBe(true);
    const github = catalog.find((plugin) => plugin.id === 'github');
    expect(github?.fields).toEqual([
      expect.objectContaining({
        name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        secret: true,
        required: true,
      }),
    ]);
    expect(github?.tools.find((tool) => tool.effect_class === 'write_external')?.asks_first).toBe(
      true,
    );

    // The time plugin needs nothing from the person: one tap.
    const time = pluginEntry('time');
    if (!time) throw new Error('Missing catalog entry');
    launcher.behaviour.tools = time.tools.map((tool) => ({
      name: tool.name,
      inputSchema: { type: 'object' },
    }));
    const tapped = await h.app.request('/plugins/time', h.as(h.cookie, {}));
    expect(tapped.status).toBe(201);
    const added = installPluginResponse.parse(await tapped.json());
    expect(added.connection).toMatchObject({ label: time.title, status: 'active' });
    expect(added.check?.code).toBe('ok');
    const [row] =
      await fixture.sql`select configuration from connection where id = ${added.connection.id}`;
    expect(row?.configuration.plugin).toEqual({ id: 'time', version: time.version });
    expect(row?.configuration.server.endpoint.launch).toMatchObject({
      runner: 'uvx',
      source: time.launch.source,
      egress: [],
    });
    expect((await list()).find((plugin) => plugin.id === 'time')?.installed).toBe(
      added.connection.id,
    );
    expect((await h.app.request('/plugins/time', h.as(h.cookie, {}))).status).toBe(409);
    expect((await h.attempt()).bundle).toContain('mcp_time.now');

    // What is missing or wrong is said in plain words, before anything is stored or started.
    const starts = launcher.starts.length;
    for (const [id, values, words] of [
      ['github', {}, 'GitHub token is needed.'],
      ['fetch', { sites: '10.0.0.1' }, 'is not a host name'],
      ['fetch', { sites: 'docs.example.com', extra: 'x' }, 'does not take extra'],
    ] as const) {
      const refused = await h.app.request(`/plugins/${id}`, h.as(h.cookie, { values }));
      expect(refused.status).toBe(400);
      expect(await refused.text()).toContain(words);
    }
    expect((await h.app.request('/plugins/nothing', h.as(h.cookie, {}))).status).toBe(404);
    expect(launcher.starts).toHaveLength(starts);
  }, 60_000);

  test('a plugin moves to the version a release pins, and stays put if that version will not start', async () => {
    if (!h || !fixture) throw new Error('Postgres unavailable');
    const time = pluginEntry('time');
    if (!time) throw new Error('Missing catalog entry');
    const [row] = await fixture.sql`select id, space_id, configuration from connection
      where provider = 'mcp' and status = 'active' and configuration->'plugin'->>'id' = 'time'`;
    if (!row) throw new Error('The time plugin is not installed');
    // As an earlier release would have left it.
    const older = {
      ...row.configuration,
      plugin: { id: 'time', version: '2025.1.1' },
      server: {
        ...row.configuration.server,
        endpoint: {
          transport: 'container',
          launch: {
            ...row.configuration.server.endpoint.launch,
            source: 'mcp-server-time==2025.1.1',
          },
        },
      },
    };
    await fixture.sql`update connection set configuration = ${JSON.stringify(older)}::jsonb where id = ${row.id}`;
    const open = async (booted: FakeStdioLauncher) => {
      const restarted = await configuredConnectors({
        sql: fixture.sql,
        workRoot: 'unused',
        spacesRoot: 'unused',
        masterKey: MASTER_KEY,
        stdioLauncher: booted,
      });
      registries.push(restarted);
      const [current] =
        await fixture.sql`select configuration from connection where id = ${row.id}`;
      return { restarted, configuration: current?.configuration };
    };

    // A new version that will not start leaves the plugin on the one it had, still offered.
    const failing = new FakeStdioLauncher();
    failing.behaviour.failStart = true;
    const stayed = await open(failing);
    expect(stayed.configuration.plugin.version).toBe('2025.1.1');
    expect(stayed.configuration.server.endpoint.launch.source).toBe('mcp-server-time==2025.1.1');
    expect(stayed.restarted.get(row.id)?.manifest.tools.map((tool) => tool.name)).toContain(
      'mcp_time.now',
    );

    const working = new FakeStdioLauncher();
    working.behaviour.tools = time.tools.map((tool) => ({
      name: tool.name,
      description: 'a newer description',
      inputSchema: { type: 'object' },
    }));
    const moved = await open(working);
    expect(moved.configuration.plugin.version).toBe(time.version);
    expect(moved.configuration.server.endpoint.launch.source).toBe(time.launch.source);
    expect(working.starts.map((start) => start.launch.source)).toEqual([time.launch.source]);
    // The catalog is recorded again from the version that now runs.
    expect(moved.configuration.tools[0].description).toBe('a newer description');
    launcher.behaviour.tools = DISHONEST_TOOLS;
  }, 60_000);

  test('an upgrade keeps where a plugin may reach, and never opens a narrowed one to every site', async () => {
    if (!h || !fixture) throw new Error('Postgres unavailable');
    const fetchEntry = pluginEntry('fetch');
    if (!fetchEntry) throw new Error('Missing catalog entry');
    launcher.behaviour.tools = fetchEntry.tools.map((tool) => ({
      name: tool.name,
      inputSchema: { type: 'object' },
    }));
    const added = await h.app.request(
      '/plugins/fetch',
      h.as(h.cookie, { values: { sites: 'docs.example.com' } }),
    );
    expect(added.status).toBe(201);
    const id = installPluginResponse.parse(await added.json()).connection.id;
    const [row] =
      await fixture.sql`select space_id, configuration from connection where id = ${id}`;
    if (!row) throw new Error('The fetch plugin is not installed');
    // The person's choice is recorded with the plugin; the launch holds only the named site.
    expect(row.configuration.plugin).toEqual({
      id: 'fetch',
      version: fetchEntry.version,
      values: { sites: 'docs.example.com' },
    });
    expect(row.configuration.server.endpoint.launch.egress).toEqual(['docs.example.com']);

    const older = (plugin: Record<string, unknown>) => ({
      ...row.configuration,
      plugin,
      server: {
        ...row.configuration.server,
        endpoint: {
          transport: 'container',
          launch: {
            ...row.configuration.server.endpoint.launch,
            source: 'mcp-server-fetch==2025.1.1',
          },
        },
      },
    });
    const upgraded = async (plugin: Record<string, unknown>) => {
      await fixture.sql`update connection set configuration = ${JSON.stringify(older(plugin))}::jsonb
        where id = ${id}`;
      const booted = new FakeStdioLauncher();
      booted.behaviour.tools = launcher.behaviour.tools;
      registries.push(
        await configuredConnectors({
          sql: fixture.sql,
          workRoot: 'unused',
          spacesRoot: 'unused',
          masterKey: MASTER_KEY,
          stdioLauncher: booted,
        }),
      );
      const [after] = await fixture.sql`select configuration from connection where id = ${id}`;
      return { configuration: after?.configuration, starts: booted.starts };
    };

    // Rebuilt from the recorded choice: the same one site, at the new version.
    const recorded = await upgraded({
      id: 'fetch',
      version: '2025.1.1',
      values: { sites: 'docs.example.com' },
    });
    expect(recorded.configuration.plugin.version).toBe(fetchEntry.version);
    expect(recorded.configuration.server.endpoint.launch).toMatchObject({
      source: fetchEntry.launch.source,
      egress: ['docs.example.com'],
    });
    expect(recorded.starts.map((start) => start.launch.egress)).toEqual([['docs.example.com']]);

    // A record from before choices were kept would rebuild as every site; it is cut back to
    // what the installed version could already reach.
    const unrecorded = await upgraded({ id: 'fetch', version: '2025.1.1' });
    expect(unrecorded.configuration.server.endpoint.launch.egress).toEqual([]);
    expect(JSON.stringify(unrecorded.configuration.server)).not.toContain('"*"');
    expect((await h.revoke(id)).status).toBe(200);
    launcher.behaviour.tools = DISHONEST_TOOLS;
  }, 60_000);

  test('revoking the connection stops its server and removes what it kept', async () => {
    if (!h || !fixture) throw new Error('Postgres unavailable');
    const [row] = await fixture.sql`select id from connection
      where provider = 'mcp' and status = 'active' and configuration->'server'->>'id' = 'notes'`;
    const id = String(row?.id);
    const offered = await h.attempt();
    await h.broker.propose(offered.claims, {
      kind: 'mcp_notes.lookup',
      connection_id: id,
      payload: { q: 'before revocation' },
    });
    expect(launcher.runningFor(id)).toBe(1);

    expect((await h.revoke(id)).status).toBe(200);
    expect(launcher.runningFor(id)).toBe(0);
    expect(launcher.destroyed).toContain(id);
    const after = await h.attempt();
    expect(after.bundle).not.toContain('mcp_notes.lookup');
    expect(after.brokered).not.toContain('mcp_notes.lookup');
    const starts = launcher.starts.length;
    const late = await h.broker
      .propose(offered.claims, {
        kind: 'mcp_notes.lookup',
        connection_id: id,
        payload: { q: 'after revocation' },
      })
      .catch((error: unknown) => error);
    expect(late).not.toMatchObject({ status: 'succeeded' });
    expect(launcher.starts).toHaveLength(starts);
  }, 60_000);

  test('a service without a container launcher neither offers nor installs stdio servers', async () => {
    if (!h) throw new Error('Postgres unavailable');
    const kinds = connectionKindListResponse.parse(
      await (await h.withoutLauncher.request('/connection-kinds', h.as(h.cookie))).json(),
    );
    expect(kinds.kinds.map((kind) => kind.kind)).not.toContain('mcp_stdio');
    const refused = await h.install(installation('elsewhere'), h.withoutLauncher);
    expect(refused.status).toBe(400);
    expect(refused.text).toContain('supervises containers');
  });
});
