/**
 * A space's rules, end to end on Postgres: who may read and change them, the
 * model an attempt runs on falling back to an allowed one or ending with the
 * reason, the tools offered and admitted, and a connection of a denied kind
 * refused at installation. A space with no rules is unchanged throughout.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import type { DispatchResult } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { BrokerService } from '../../src/broker/service.ts';
import { emailManifest } from '../../src/connectors/email.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { attempt } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { ModelSettingsService, serviceModelSource } from '../../src/gateway/model-settings.ts';
import { NO_ROUTING } from '../../src/gateway/routing.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { RuntimeCatalog } from '../../src/knowledge/catalog.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { triageModelSource } from '../../src/triage/classifier.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const describeWithDb = handle && queue ? describe : describe.skip;
const masterKey = randomBytes(32).toString('hex');
const password = 'my-test-password';

const PRIMARY = 'accounts/fireworks/models/deepseek-v4p1-flash';
const OTHER = 'accounts/fireworks/models/fixture-other';
const FAST = 'accounts/fireworks/models/fixture-fast';
const ENV = { FIREWORKS_API_KEY: 'fw-fixture-key-9a1b' };

function database() {
  if (!handle) throw new Error('Postgres is unavailable');
  return handle;
}

// biome-ignore lint/suspicious/noExplicitAny: test bodies are asserted field by field.
type Json = Record<string, any>;

function service() {
  const env = loadEnv({ NODE_ENV: 'test', MELETE_MASTER_KEY: masterKey, ...ENV });
  const settings = new ModelSettingsService({ db: database().db, env });
  const built = createApp({
    env,
    db: database().db,
    sql: database().sql,
    registry: new ConnectorRegistry(),
    modelSettings: settings,
    checkDatabase: async () => 'ok',
  });
  return {
    settings,
    async call(path: string, cookie: string, init: RequestInit = {}) {
      const response = await built.request(path, {
        ...init,
        headers: { 'Content-Type': 'application/json', cookie, ...(init.headers ?? {}) },
      });
      const text = await response.text();
      return { status: response.status, body: text ? (JSON.parse(text) as Json) : {} };
    },
    request: built.request.bind(built),
  };
}

const sessionOf = (response: Response) =>
  response.headers.get('set-cookie')?.split(';')[0] ?? 'missing';
const put = (body: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(body) });
const rules = (
  partial: Partial<{
    allowed_models: string[];
    denied_connector_kinds: string[];
    denied_tool_kinds: string[];
  }>,
) => ({ allowed_models: [], denied_connector_kinds: [], denied_tool_kinds: [], ...partial });

/** The setup owner, two more people, and a room the first of them owns with the second in it. */
async function people(api: ReturnType<typeof service>) {
  const setup = await api.request('/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', password }),
  });
  expect(setup.status).toBe(201);
  const owner = sessionOf(setup);
  const signIn = async (email: string) => {
    const made = await api.call('/principals', owner, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    expect(made.status).toBe(201);
    const login = await api.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(login.status).toBe(200);
    return sessionOf(login);
  };
  const lead = await signIn('lead@example.test');
  const member = await signIn('member@example.test');
  const sql = database().sql;
  const id = async (email: string) =>
    String((await sql`select id from principal where email = ${email}`)[0]?.id);
  const ownerId = await id('owner@example.test');
  const leadId = await id('lead@example.test');
  const memberId = await id('member@example.test');
  const [space] = await sql`select id from space where owner_principal_id = ${ownerId}
    order by created_at limit 1`;
  const room = newId('sp');
  await sql`insert into space (id, name, git_path, kind, owner_principal_id)
    values (${room}, 'Team', ${`test/${room}`}, 'shared', ${leadId})`;
  await sql`insert into space_membership (principal_id, space_id, role) values
    (${leadId}, ${room}, 'owner'), (${memberId}, ${room}, 'member')`;
  return {
    owner: { cookie: owner, id: ownerId, spaceId: String(space?.id) },
    lead: { cookie: lead, id: leadId },
    member: { cookie: member, id: memberId },
    room,
  };
}

/** One attempt of a fresh job in the space, claimed with the model the settings choose. */
async function claimIn(settings: ModelSettingsService, spaceId: string) {
  if (!queue) throw new Error('the job queue is unavailable');
  const jobs = new JobService(database().db, queue.boss);
  const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
    key: 'space-policy-signing-key-32-chars!!',
    scopes: [],
    resolveModel: (tx, row, usageClass) =>
      settings.routedChoice(NO_ROUTING, tx, { spaceId: row.spaceId, usageClass }),
  });
  const job = await jobs.create({ space_id: spaceId, title: 'Rules', objective: 'model check' });
  const claimed = await runner.claim({
    job_id: job.id,
    expected_epoch: job.leaseEpoch,
    expected_version: job.stateVersion,
    reason: 'created',
  });
  const [row] = await database().db.select().from(attempt).where(eq(attempt.jobId, job.id));
  return { claimed, attempt: row };
}

describeWithDb('rules for what a space may use', () => {
  beforeEach(async () => {
    await resetTestRows(database().sql);
  }, 15_000);

  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 30_000);

  test('a space with no rules restricts nothing, and only owners and the setup owner change them', async () => {
    const api = service();
    const p = await people(api);
    const empty = await api.call(`/spaces/${p.owner.spaceId}/policy`, p.owner.cookie);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({
      policy: { ...rules({}), space_id: p.owner.spaceId, updated_by: null },
      can_change: true,
    });
    expect(empty.body.policy.updated_at).toBeNull();

    // A member reads the room's rules but cannot change them; its owner can.
    const read = await api.call(`/spaces/${p.room}/policy`, p.member.cookie);
    expect(read.body.can_change).toBe(false);
    const refused = await api.call(
      `/spaces/${p.room}/policy`,
      p.member.cookie,
      put(rules({ denied_tool_kinds: ['email.send'] })),
    );
    expect(refused.status).toBe(403);
    const set = await api.call(
      `/spaces/${p.room}/policy`,
      p.lead.cookie,
      put(rules({ denied_tool_kinds: ['email.send', 'Email.Send'], allowed_models: [] })),
    );
    expect(set.status).toBe(200);
    // Written once, in lower case.
    expect(set.body.policy.denied_tool_kinds).toEqual(['email.send']);

    // The setup owner sets the rules of a room they are not in.
    const admin = await api.call(
      `/spaces/${p.room}/policy`,
      p.owner.cookie,
      put(rules({ allowed_models: [`fireworks/${OTHER}`], denied_connector_kinds: ['mcp'] })),
    );
    expect(admin.status).toBe(200);
    expect(admin.body.policy).toMatchObject({
      allowed_models: [`fireworks/${OTHER}`],
      denied_connector_kinds: ['mcp'],
      denied_tool_kinds: [],
      updated_by: p.owner.id,
    });

    // Nobody else reaches a space that does not admit them.
    expect((await api.call(`/spaces/${p.owner.spaceId}/policy`, p.lead.cookie)).status).toBe(403);
    expect(
      (
        await api.call(
          `/spaces/${p.owner.spaceId}/policy`,
          p.lead.cookie,
          put(rules({ denied_tool_kinds: ['web'] })),
        )
      ).status,
    ).toBe(403);
    // A model is written provider/model.
    expect(
      (
        await api.call(
          `/spaces/${p.room}/policy`,
          p.lead.cookie,
          put(rules({ allowed_models: ['just-a-model'] })),
        )
      ).status,
    ).toBe(400);
  }, 180_000);

  test('an attempt falls back to an allowed model, or ends saying why none can be used', async () => {
    const api = service();
    const p = await people(api);
    const spaceId = p.owner.spaceId;
    const set = (body: ReturnType<typeof rules>) =>
      api.call(`/spaces/${spaceId}/policy`, p.owner.cookie, put(body));

    // No rules: the installation's model, as before.
    expect((await claimIn(api.settings, spaceId)).attempt?.model).toBe(PRIMARY);

    // Its model left out: the first allowed one whose provider is connected.
    await set(rules({ allowed_models: ['anthropic/fixture-model', `fireworks/${OTHER}`] }));
    const fell = await claimIn(api.settings, spaceId);
    expect(fell.claimed?.bundle.model.model).toBe(OTHER);
    expect(fell.attempt?.provider).toBe('fireworks');

    // None connected: no engine starts, and the turn ends on the reason.
    await set(rules({ allowed_models: ['anthropic/fixture-model'] }));
    const none = await claimIn(api.settings, spaceId);
    expect(none.claimed).toBeNull();
    expect(none.attempt?.outcome).toBe('budget_exhausted');
    expect(none.attempt?.outcomeDetail).toMatchObject({
      kind: 'budget_exhausted',
      summary: expect.stringContaining('anthropic/fixture-model'),
    });

    // A side call's fast model the rules leave out is not taken.
    const routed = await api.settings.routingFor(spaceId, {
      ...NO_ROUTING,
      fast: { provider: 'fireworks', model: FAST },
      fallback: [{ provider: 'fireworks', model: OTHER }],
    });
    expect(routed.fast).toBeNull();
    expect(routed.fallback).toEqual([]);
    expect(
      await api.settings.allowedModelFor(spaceId, { provider: 'fireworks', model: FAST }),
    ).toMatchObject({ refused: expect.stringContaining("This space's rules") });

    // A side call carries the list its space allows, so its fallbacks keep to
    // it, and a model the operator pinned for one use is held to it as well.
    const only = [`fireworks/${PRIMARY}`];
    await set(rules({ allowed_models: only }));
    const env = { MELETE_DEFAULT_PROVIDER: 'fireworks', MELETE_DEFAULT_MODEL: PRIMARY };
    expect(await serviceModelSource({ env, settings: api.settings }).current({ spaceId })).toEqual({
      provider: 'fireworks',
      model: PRIMARY,
      allowed: only,
    });
    const triage = triageModelSource({
      env: { ...env, MELETE_MODEL_TRIAGE: `fireworks/${FAST}` },
      settings: api.settings,
      routing: NO_ROUTING,
    });
    expect(await triage.current(spaceId)).toEqual({
      provider: 'fireworks',
      model: PRIMARY,
      allowed: only,
    });

    // Cleared, everything is allowed again.
    await set(rules({}));
    expect((await claimIn(api.settings, spaceId)).attempt?.model).toBe(PRIMARY);
  }, 180_000);

  test('a connection of a denied kind is not installed', async () => {
    const api = service();
    const p = await people(api);
    const spaceId = p.owner.spaceId;
    await api.call(
      `/spaces/${spaceId}/policy`,
      p.owner.cookie,
      put(rules({ denied_connector_kinds: ['caldav'] })),
    );
    const before = await database().sql`select count(*)::int as n from connection`;
    const refused = await api.call('/connections', p.owner.cookie, {
      method: 'POST',
      body: JSON.stringify({
        provider: 'caldav',
        label: 'Team feed',
        space_id: spaceId,
        ics: { url: 'https://feeds.example.test/team.ics' },
      }),
    });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain("This space's rules do not allow caldav");
    const after = await database().sql`select count(*)::int as n from connection`;
    expect(after[0]?.n).toBe(before[0]?.n);
  }, 180_000);

  test('denied connector and tool kinds are neither offered nor admitted', async () => {
    const sql = database().sql;
    const read = emailManifest.tools.find((tool) => tool.name === 'email.search');
    if (!read) throw new Error('no read tool');
    const manifest = {
      ...emailManifest,
      provider: 'test' as const,
      tools: [
        { ...read, name: 'test.read', required_scopes: ['test.read'] },
        { ...read, name: 'test.lookup', required_scopes: ['test.lookup'] },
      ],
    };
    const seed = await seedJob(sql, { provider: 'test', scopes: ['test.read', 'test.lookup'] });
    const connector: Connector = {
      manifest,
      async execute(action): Promise<DispatchResult> {
        return {
          outcome: 'succeeded',
          receipt: {
            action_id: action.id,
            connection_id: action.connection_id,
            external_ref: action.id,
            late: false,
            received_at: new Date().toISOString(),
            detail: {},
          },
        };
      },
      async verify() {
        return { decision: 'unsupported', reason: 'fixture' };
      },
      async health() {
        return { status: 'ok', detail: 'fixture', checked_at: new Date().toISOString() };
      },
    };
    const registry = new ConnectorRegistry().register(seed.connectionId, connector);
    const broker = new BrokerService({ sql, connectors: registry });
    const runtime = new RuntimeCatalog(database().db, registry);
    const offered = async () => (await broker.catalog(seed.claims)).map((tool) => tool.name);
    const bundled = async () =>
      (await runtime.toolsForSpace(seed.claims.space_id)).map((tool) => tool.name);
    const run = (kind: string) =>
      broker.propose(seed.claims, {
        connection_id: seed.connectionId,
        kind,
        payload: { query: 'trains' },
      });
    const deny = (tools: string[], connectors: string[] = []) =>
      sql`insert into space_policy (space_id, denied_tool_kinds, denied_connector_kinds)
        values (${seed.claims.space_id}, ${JSON.stringify(tools)}::jsonb, ${JSON.stringify(connectors)}::jsonb)
        on conflict (space_id) do update set denied_tool_kinds = excluded.denied_tool_kinds,
          denied_connector_kinds = excluded.denied_connector_kinds`;

    expect(await offered()).toEqual(expect.arrayContaining(['test.read', 'test.lookup']));
    expect(await bundled()).toEqual(expect.arrayContaining(['test.read', 'test.lookup']));

    // One tool by name: the other stays.
    await deny(['test.lookup']);
    expect(await offered()).toContain('test.read');
    expect(await offered()).not.toContain('test.lookup');
    expect(await bundled()).not.toContain('test.lookup');
    expect(await rejectionOf(run('test.lookup'))).toMatchObject({
      code: 'scope_denied',
      message: "This space's rules do not allow test.lookup.",
    });
    expect(await run('test.read')).toMatchObject({ action_id: expect.any(String) });

    // The whole kind of connection: none of its tools.
    await deny([], ['test']);
    expect(await offered()).not.toContain('test.read');
    expect(await bundled()).not.toContain('test.read');
    expect(await rejectionOf(run('test.read'))).toMatchObject({ code: 'scope_denied' });

    // A family by its prefix.
    await deny(['test']);
    expect(await offered()).not.toEqual(expect.arrayContaining(['test.read']));
    await deny([]);
    expect(await offered()).toEqual(expect.arrayContaining(['test.read', 'test.lookup']));
  }, 180_000);
});
