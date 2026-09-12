import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { browserControlResponse, type JsonObject } from '@melete/contracts';
import { PgBoss } from 'pg-boss';
import { loadAction, recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createTableTrustResolver } from '../../src/broker/trust.ts';
import { browserManifest, createBrowserConnector } from '../../src/connectors/browser.ts';
import {
  configuredBrowserSessions,
  configuredConnectors,
} from '../../src/connectors/configured.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { QUEUES } from '../../src/jobs/queue.ts';
import { browserArtifactSink } from '../../src/workers/browser/artifacts.ts';
import { BrowserWorkerClient } from '../../src/workers/browser/client.ts';
import {
  type BrowserRecipeCandidate,
  PostgresBrowserRecipeStore,
  type VisibleSchema,
} from '../../src/workers/browser/recipes.ts';
import { BrowserSessionService } from '../../src/workers/browser/routes.ts';
import type { BrowserSession } from '../../src/workers/browser/sessions.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;
const boss = fixture ? new PgBoss({ connectionString: fixture.url, max: 2 }) : null;
if (boss) {
  boss.on('error', () => {});
  await boss.start();
  await boss.createQueue(QUEUES.attempt);
}
const tempParent = await realpath(tmpdir());
const spaces = await mkdtemp(join(tempParent, 'melete-browser-broker-'));
const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(async () => {
  for (const server of servers) await server.stop(true);
  await boss?.stop({ graceful: true });
  await fixture?.close();
  const absolute = resolve(spaces);
  if (
    dirname(absolute) !== tempParent ||
    !basename(absolute).startsWith('melete-browser-broker-') ||
    (await realpath(absolute)) !== absolute
  )
    throw new Error('Refusing to remove an unverified browser test directory');
  await rm(absolute, { recursive: true, force: true });
}, 20_000);

async function setup() {
  if (!fixture) throw new Error('Postgres unavailable');
  const seed = await seedJob(fixture.sql, {
    provider: 'web',
    scopes: browserManifest.tools.map((tool) => tool.name),
    constraints: { allowed_domains: ['fixture.example'] },
  });
  const session: BrowserSession = {
    id: `brws_${recordId('session')}`,
    space_id: seed.claims.space_id,
    job_id: seed.claims.job_id,
    control_epoch: 0,
    control: 'automation',
    profile_dir: '/never-return-this-path',
    warm_until: Date.now() + 300_000,
  };
  let effects = 0;
  let refusedInputs = 0;
  let observedEpoch: number | null = null;
  const recordedSchema: VisibleSchema = [
    { label: 'Name', role: 'textbox', required: true, sensitive: false },
    { label: 'Contact email', role: 'textbox', required: false, sensitive: false },
    { label: 'Save', role: 'button', required: false, sensitive: false },
  ];
  let visibleSchema = structuredClone(recordedSchema);
  const calls: JsonObject[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as JsonObject;
      const path = new URL(request.url).pathname;
      if (path === '/lease') return Response.json(session);
      if (path === '/takeover' || path === '/handback') {
        session.control_epoch++;
        session.control = path === '/takeover' ? 'human' : 'automation';
        observedEpoch = null;
        return Response.json(session);
      }
      calls.push(body);
      const operation = body.operation as JsonObject;
      if (body.control_epoch !== session.control_epoch) {
        refusedInputs++;
        return Response.json({ error: 'stale_control_epoch' }, { status: 409 });
      }
      if (session.control !== 'automation')
        return Response.json({ error: 'human_control' }, { status: 409 });
      if (operation.kind === 'observe') {
        observedEpoch = session.control_epoch;
        return Response.json({
          session_id: session.id,
          control_epoch: session.control_epoch,
          observation: {
            id: `obs_${calls.length}`,
            url: 'https://fixture.example/form',
            tree: 'a private accessibility capture',
            screenshot: 'iVBORw0KGgo=',
            schema: visibleSchema,
          },
        });
      }
      if (observedEpoch !== session.control_epoch)
        return Response.json({ error: 'fresh_observation_required' }, { status: 409 });
      if (operation.kind === 'submit') effects++;
      return Response.json({
        session_id: session.id,
        control_epoch: session.control_epoch,
        result: { effect_count: effects },
      });
    },
  });
  servers.push(server);
  const client = new BrowserWorkerClient(server.url.href, 'x'.repeat(32));
  const sessions = new BrowserSessionService(fixture.sql, { get: async () => client });
  const recipes = new PostgresBrowserRecipeStore(fixture.sql);
  const connector = createBrowserConnector({
    sessions,
    artifacts: browserArtifactSink(fixture.sql, spaces),
    recipes,
    spaceId: seed.claims.space_id,
  });
  const broker = new BrokerService({
    sql: fixture.sql,
    boss: boss ?? undefined,
    connectors: { get: (id) => (id === seed.connectionId ? connector : undefined) },
    resolveTrust: createTableTrustResolver(
      {
        'https://fixture.example/save': {
          origin_trust: 'external_content',
          handle: 'browser:observed-form',
        },
        'alice@example.test': {
          origin_trust: 'external_content',
          handle: 'browser:observed-contact-field',
        },
      },
      { fallback: 'owner' },
    ),
  });
  const propose = (kind: string, payload: JsonObject) =>
    broker.propose(seed.claims, {
      kind: `browser.${kind}`,
      connection_id: seed.connectionId,
      payload,
    });
  await propose('observe', {});
  const planned = { session_id: session.id, control_epoch: 0 };
  const intent = {
    url: 'https://fixture.example/save',
    method: 'POST',
    role: 'button',
    name: 'Save',
    form_hash: 'a'.repeat(64),
    body_sha256: 'b'.repeat(64),
    fields: { 'Contact email': 'alice@example.test' },
  };
  return {
    ...seed,
    sql: fixture.sql,
    db: fixture.db,
    broker,
    sessions,
    session,
    calls,
    propose,
    planned,
    intent,
    client,
    recipes,
    recordedSchema,
    setSchema: (schema: VisibleSchema) => {
      visibleSchema = schema;
    },
    effects: () => effects,
    refusedInputs: () => refusedInputs,
  };
}

async function checkedRecipe(s: Awaited<ReturnType<typeof setup>>) {
  const candidate: BrowserRecipeCandidate = {
    id: 'recipe_contact',
    space_id: s.claims.space_id,
    version: 1,
    state: 'candidate',
    schema: s.recordedSchema,
    steps: [
      { action: 'fill', label: 'Name', value_key: 'name' },
      { action: 'fill', label: 'Contact email', value_key: 'email' },
      { action: 'submit', role: 'button', name: 'Save' },
    ],
    safe_aliases: { Name: 'Full name' },
    reason: 'recorded',
  };
  await s.recipes.save(candidate);
  return s.recipes.save({ ...candidate, state: 'validated' });
}

async function observeRecipe(s: Awaited<ReturnType<typeof setup>>, after = 'obs_1') {
  const proposal = await s.propose('observe', {
    ...s.planned,
    after_observation: after,
    recipe_id: 'recipe_contact',
    recipe_version: 1,
  });
  const stored = await loadAction(s.sql, proposal.action_id);
  const detail = stored.receipt?.detail as JsonObject | undefined;
  const result = detail?.result;
  if (!result || typeof result !== 'object' || Array.isArray(result) || !result.recipe)
    throw new Error('Expected a recipe plan in the observation receipt');
  return result.recipe as JsonObject;
}

describe('browser broker authority and durable control', () => {
  databaseTest(
    'fresh observed state distinguishes a new page edit without adding a submit replay key',
    async () => {
      const s = await setup();
      const edit = { ...s.planned, after_observation: 'obs_1', label: 'Name', value: 'Alice' };
      const first = await s.propose('fill', edit);
      const retry = await s.propose('fill', edit);
      expect(retry.action_id).toBe(first.action_id);
      expect(s.calls).toHaveLength(2);
      await s.propose('observe', { ...s.planned, after_observation: 'obs_1' });
      const fresh = await s.propose('fill', { ...edit, after_observation: 'obs_3' });
      expect(fresh.action_id).not.toBe(first.action_id);
      expect(s.calls).toHaveLength(4);
      expect(s.calls[3]?.operation).toEqual(s.calls[1]?.operation);
      expect(
        await rejectionOf(
          s.propose('submit', { ...s.planned, after_observation: 'obs_3', intent: s.intent }),
        ),
      ).toMatchObject({ code: 'payload_invalid' });
      expect(s.effects()).toBe(0);
    },
  );

  databaseTest(
    'broker recipe reuse checks the fresh schema and resolves only the reviewed alias',
    async () => {
      const s = await setup();
      await checkedRecipe(s);
      s.setSchema([...s.recordedSchema].reverse());
      const reordered = await observeRecipe(s);
      expect(reordered).toEqual(
        expect.objectContaining({ disposition: 'reuse', reason: 'matched_schema' }),
      );
      s.setSchema(
        s.recordedSchema.map((control) => ({
          ...control,
          label: control.label === 'Name' ? 'Full name' : control.label,
        })),
      );
      const renamed = await observeRecipe(s, 'obs_2');
      expect(renamed).toEqual(
        expect.objectContaining({ disposition: 'reuse', reason: 'safe_alias' }),
      );
      expect(renamed.steps).toEqual(
        expect.arrayContaining([{ action: 'fill', label: 'Full name', value_key: 'name' }]),
      );
      expect(s.calls[1]?.operation).toEqual({ kind: 'observe' });
      expect(s.calls[2]?.operation).toEqual({ kind: 'observe' });
      expect(await s.recipes.list(s.claims.space_id)).toHaveLength(1);
      expect(s.effects()).toBe(0);
    },
  );

  databaseTest(
    'schema mismatch creates an immutable repair candidate and returns no executable steps',
    async () => {
      const s = await setup();
      const original = await checkedRecipe(s);
      s.setSchema([
        ...s.recordedSchema,
        { label: 'Nickname', role: 'textbox', required: false, sensitive: false },
      ]);
      const plan = await observeRecipe(s);
      expect(plan).toEqual(
        expect.objectContaining({ disposition: 'fallback', reason: 'schema_mismatch', steps: [] }),
      );
      const candidate = await s.recipes.get(s.claims.space_id, original.id);
      expect(candidate).toEqual(
        expect.objectContaining({
          version: 2,
          state: 'candidate',
          reason: 'schema_mismatch',
          steps: original.steps,
        }),
      );
      expect(await s.recipes.get(s.claims.space_id, original.id, 1)).toEqual(original);
      const [job] = await s.sql`select state from job where id = ${s.claims.job_id}`;
      expect(job?.state).toBe('running');
      expect(JSON.stringify(candidate)).not.toContain('alice@example.test');
      expect(s.effects()).toBe(0);
    },
  );

  databaseTest(
    'unknown required and ambiguous controls park before recipe inputs or effects',
    async () => {
      for (const reason of ['unknown_required_field', 'ambiguous_control']) {
        const s = await setup();
        await checkedRecipe(s);
        s.setSchema([
          ...s.recordedSchema,
          reason === 'unknown_required_field'
            ? { label: 'Unrequested field', role: 'textbox', required: true, sensitive: false }
            : { label: 'Save', role: 'button', required: false, sensitive: false },
        ]);
        const plan = await observeRecipe(s);
        expect(plan).toEqual(expect.objectContaining({ disposition: 'stop', reason, steps: [] }));
        const [job] = await s.sql`select state from job where id = ${s.claims.job_id}`;
        expect(job?.state).toBe('waiting_for_input');
        expect((await s.recipes.get(s.claims.space_id, 'recipe_contact'))?.state).toBe('candidate');
        expect(s.calls.every((call) => (call.operation as JsonObject).kind === 'observe')).toBe(
          true,
        );
        expect(s.effects()).toBe(0);
      }
    },
  );

  databaseTest(
    'credential schema is never saved as a repair candidate and recipe lookup is space scoped',
    async () => {
      const s = await setup();
      await checkedRecipe(s);
      s.setSchema([
        ...s.recordedSchema,
        { label: 'Password', role: 'textbox', required: true, sensitive: true },
      ]);
      expect(await observeRecipe(s)).toEqual(
        expect.objectContaining({ disposition: 'stop', reason: 'sensitive_control', steps: [] }),
      );
      const stored = await s.recipes.list(s.claims.space_id);
      expect(stored).toHaveLength(1);
      expect(JSON.stringify(stored)).not.toContain('Password');
      const other = await setup();
      const plan = await observeRecipe(other);
      expect(plan).toEqual(
        expect.objectContaining({ disposition: 'stop', reason: 'recipe_not_found', steps: [] }),
      );
      expect(await other.recipes.list(other.claims.space_id)).toHaveLength(0);
    },
  );

  databaseTest(
    'configured browser connections require an isolated endpoint in production',
    async () => {
      const s = await setup();
      const connections = [{ kind: 'browser' as const, id: s.connectionId }];
      expect(
        String(
          await rejectionOf(
            configuredBrowserSessions({
              sql: s.sql,
              env: loadEnv({ NODE_ENV: 'production' }),
              connections,
            }),
          ),
        ),
      ).toContain('isolated worker endpoint');
      const configured = await configuredBrowserSessions({
        sql: s.sql,
        connections,
        env: loadEnv({
          NODE_ENV: 'production',
          MELETE_BROWSER_SPACE: s.claims.space_id,
          MELETE_BROWSER_URL: s.client.url,
          MELETE_BROWSER_TOKEN: 'x'.repeat(32),
          MELETE_SPACES_DIR: spaces,
        }),
      });
      if (!configured) throw new Error('Expected configured browser sessions');
      try {
        expect(configured.pool.options.allowLocalProcess).toBe(false);
        const registry = await configuredConnectors({
          sql: s.sql,
          connections,
          spacesRoot: spaces,
          workRoot: spaces,
          browserSessions: configured.sessions,
        });
        expect(registry.get(s.connectionId)?.manifest).toMatchObject({
          name: 'browser',
          provider: 'web',
        });
        expect(
          registry
            .get(s.connectionId)
            ?.manifest.tools.some((tool) => tool.name === 'browser.submit'),
        ).toBe(true);
      } finally {
        await configured.pool.close();
      }
    },
  );

  databaseTest(
    'a new observation refresh key reaches the worker while a retry reuses its receipt',
    async () => {
      const s = await setup();
      const initial = await s.propose('observe', {});
      expect(initial.repeated).toBe(true);
      expect(s.calls).toHaveLength(1);
      const refreshed = await s.propose('observe', { ...s.planned, after_observation: 'obs_1' });
      expect(refreshed.action_id).not.toBe(initial.action_id);
      expect(s.calls).toHaveLength(2);
      expect(s.calls[1]?.operation).toEqual({ kind: 'observe' });
      const retry = await s.propose('observe', { ...s.planned, after_observation: 'obs_1' });
      expect(retry.action_id).toBe(refreshed.action_id);
      expect(s.calls).toHaveLength(2);
      const receipt = (await s.broker.get(s.claims, refreshed.action_id)).receipt;
      expect((receipt?.detail as JsonObject | undefined)?.observation).toEqual(
        expect.objectContaining({ id: 'obs_2' }),
      );
    },
  );

  databaseTest(
    'an unapproved submit has no external effects and its warning identifies the observed destination',
    async () => {
      const s = await setup();
      const proposal = await s.propose('submit', { ...s.planned, intent: s.intent });
      expect(proposal.status).toBe('needs_approval');
      expect(proposal.origin_warnings).toContainEqual(
        expect.objectContaining({
          field: 'intent.url',
          origin_trust: 'external_content',
          handle: 'browser:observed-form',
        }),
      );
      expect(proposal.origin_warnings).toContainEqual(
        expect.objectContaining({
          field: 'intent.fields.Contact email',
          origin_trust: 'external_content',
          handle: 'browser:observed-contact-field',
        }),
      );
      expect(
        await rejectionOf(s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash)),
      ).toMatchObject({ code: 'untrusted_recipient_origin' });
      expect(s.effects()).toBe(0);
      expect(
        s.calls.filter((call) => (call.operation as JsonObject).kind === 'submit'),
      ).toHaveLength(0);
    },
  );

  databaseTest(
    'approval binds the exact browser intent and repeated proposals dispatch one effect',
    async () => {
      const s = await setup();
      const proposal = await s.propose('submit', { ...s.planned, intent: s.intent });
      await s.broker.decide(proposal.action_id, {
        decision: 'approved',
        payload_hash: proposal.payload_hash,
      });
      await s.broker.admit(s.claims, proposal.action_id, proposal.payload_hash);
      const sent = await s.broker.dispatch(proposal.action_id);
      expect(sent.status).toBe('succeeded');
      const repeat = await s.propose('submit', { ...s.planned, intent: s.intent });
      expect(repeat.action_id).toBe(proposal.action_id);
      expect(repeat.intent_key).toBe(proposal.intent_key);
      expect(repeat.repeated).toBe(true);
      expect(s.effects()).toBe(1);
      const changed = await s.propose('submit', {
        ...s.planned,
        intent: { ...s.intent, fields: { 'Contact email': 'other@example.test' } },
      });
      expect(changed.status).toBe('needs_approval');
      expect(changed.intent_key).not.toBe(proposal.intent_key);
      expect(s.effects()).toBe(1);
    },
  );

  databaseTest(
    'a stale dispatched input is refused by the controller and durably fences the job',
    async () => {
      const s = await setup();
      const interrupted: string[] = [];
      s.sessions.onPark = (_jobId, attemptIds) => {
        interrupted.push(...attemptIds);
      };
      const first = await s.propose('fill', {
        ...s.planned,
        after_observation: 'obs_1',
        label: 'Name',
        value: 'Alice',
      });
      expect(first.status).toBe('succeeded');
      await s.client.takeover(s.session.id);
      const second = await s.propose('fill', {
        ...s.planned,
        after_observation: 'obs_1',
        label: 'Email',
        value: 'alice@example.test',
      });
      expect(second.status).toBe('failed');
      expect(s.refusedInputs()).toBe(1);
      const [job] =
        await s.sql`select state, lease_epoch, wait, next_wake_at from job where id = ${s.claims.job_id}`;
      expect(job?.state).toBe('waiting_for_input');
      expect(job?.lease_epoch).toBe(2);
      expect(job?.wait.question).toContain('stale_control_epoch');
      expect(job?.next_wake_at).toBeNull();
      const [attempt] =
        await s.sql`select outcome, lease_status from attempt where id = ${s.claims.attempt_id}`;
      expect(attempt).toEqual({ outcome: 'fenced', lease_status: 'ended' });
      expect(interrupted).toEqual([s.claims.attempt_id]);
      expect(s.effects()).toBe(0);
      await s.sessions.control(s.session.id, 'handback');
      const [stillWaiting] = await s.sql`select state from job where id = ${s.claims.job_id}`;
      expect(stillWaiting?.state).toBe('waiting_for_input');
      expect(
        await rejectionOf(
          s.client.request('/command', {
            session_id: s.session.id,
            job_id: s.claims.job_id,
            control_epoch: 2,
            operation: { kind: 'fill', label: 'Email', value: 'alice@example.test' },
          }),
        ),
      ).toMatchObject({ reason: 'fresh_observation_required' });
    },
  );

  databaseTest(
    'owner takeover verifies stored authority and captures persist as scoped artifact handles',
    async () => {
      const s = await setup();
      const app = createApp({
        env: loadEnv({ NODE_ENV: 'test' }),
        db: s.db,
        checkDatabase: async () => 'ok',
        browserSessions: s.sessions,
      });
      const route = `/browser/sessions/${s.session.id}/takeover`;
      expect((await app.request(route, { method: 'POST' })).status).toBe(401);
      const token = randomBytes(32).toString('base64url');
      const ownerId = recordId('own');
      await s.sql`insert into owner (id,email) values (${ownerId}, 'browser-owner@example.test') on conflict do nothing`;
      const [owner] = await s.sql`select id from owner limit 1`;
      await s.sql`insert into session (token_hash,owner_id,expires_at) values (${createHash('sha256').update(token).digest('hex')}, ${owner?.id}, now() + interval '1 hour')`;
      const headers = { cookie: `melete_session=${token}` };
      expect(
        (
          await app.request(route, {
            method: 'POST',
            headers: { ...headers, Origin: 'https://evil.example' },
          })
        ).status,
      ).toBe(403);
      expect(s.session.control_epoch).toBe(0);
      expect(
        (await app.request('/browser/sessions/brws_invented/takeover', { method: 'POST', headers }))
          .status,
      ).toBe(404);
      const takeover = await app.request(route, { method: 'POST', headers });
      expect(takeover.status).toBe(200);
      expect(browserControlResponse.parse(await takeover.json())).toMatchObject({
        session_id: s.session.id,
        control: 'human',
        control_epoch: 1,
        fresh_observation_required: true,
      });
      expect(s.session.control_epoch).toBe(1);
      const handback = await app.request(`/browser/sessions/${s.session.id}/handback`, {
        method: 'POST',
        headers,
      });
      expect(handback.status).toBe(200);
      expect(browserControlResponse.parse(await handback.json())).toMatchObject({
        control: 'automation',
        control_epoch: 2,
        fresh_observation_required: true,
      });
      const artifacts = await s.sql`select * from artifact where job_id = ${s.claims.job_id}`;
      expect(artifacts).toHaveLength(2);
      for (const artifact of artifacts) {
        expect(artifact.space_id).toBe(s.claims.space_id);
        const bytes = await readFile(join(spaces, s.claims.space_id, 'artifacts', artifact.path));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.content_hash);
      }
      const [observe] =
        await s.sql`select receipt from action where job_id = ${s.claims.job_id} and kind = 'browser.observe'`;
      expect(JSON.stringify(observe?.receipt)).not.toContain('a private accessibility capture');
      expect(JSON.stringify(observe?.receipt)).not.toContain('iVBORw0KGgo=');
      expect(JSON.stringify(observe?.receipt)).not.toContain('/never-return-this-path');
    },
  );

  databaseTest(
    'takeover fences automation without hiding an existing uncertain effect',
    async () => {
      const s = await setup();
      const wait = { kind: 'user_input', question: 'Check the uncertain site receipt.' };
      await s.sql`update job set state = 'needs_reconciliation', wait = ${JSON.stringify(wait)}::jsonb where id = ${s.claims.job_id}`;
      await s.sessions.control(s.session.id, 'takeover');
      const [job] =
        await s.sql`select state,wait,lease_epoch from job where id = ${s.claims.job_id}`;
      expect(job).toMatchObject({ state: 'needs_reconciliation', wait, lease_epoch: 2 });
      expect(s.effects()).toBe(0);
    },
  );

  databaseTest(
    'a late refusal from the old attempt cannot fence a freshly resumed attempt',
    async () => {
      const s = await setup();
      await s.sessions.control(s.session.id, 'takeover');
      await s.sessions.control(s.session.id, 'handback');
      const replacement = recordId('att');
      await s.sql`update job set state = 'running', lease_epoch = 3 where id = ${s.claims.job_id}`;
      await s.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model) values (${replacement}, ${s.claims.job_id}, 3, 'fake', 'fake', 'scripted')`;
      await s.sessions.park(s.claims, s.session.id, 'stale_control_epoch', s.claims.attempt_id);
      const [job] = await s.sql`select state,lease_epoch from job where id = ${s.claims.job_id}`;
      const [execution] =
        await s.sql`select outcome,ended_at from attempt where id = ${replacement}`;
      expect(job).toEqual({ state: 'running', lease_epoch: 3 });
      expect(execution).toEqual({ outcome: null, ended_at: null });
    },
  );
});
