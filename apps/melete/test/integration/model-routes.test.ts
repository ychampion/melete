/**
 * Routes per kind of work (MELETE_MODEL_ROUTES), end to end on Postgres: what
 * an attempt is about is read from its job's events and its space when it is
 * claimed, and decides its model; the owner's choice in the app still wins.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { loadEnv } from '../../src/env.ts';
import { ModelSettingsService } from '../../src/gateway/model-settings.ts';
import { routingFromEnv } from '../../src/gateway/routing.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { attemptWorkKinds } from '../../src/jobs/work-signals.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const describeWithDb = handle && queue ? describe : describe.skip;
const masterKey = randomBytes(32).toString('hex');
const password = 'my-test-password';

const PRIMARY = 'accounts/fireworks/models/deepseek-v4p1-flash';
const ENV = {
  MELETE_DEFAULT_PROVIDER: 'fireworks',
  MELETE_DEFAULT_MODEL: PRIMARY,
  FIREWORKS_API_KEY: 'fw-fixture-key-5e6f',
  OPENAI_API_KEY: 'sk-fixture-key-7a8b',
  MELETE_MODEL_ROUTES: [
    'team=openai/gpt-team',
    'computer=openai/gpt-computer',
    'browser=openai/gpt-browser',
    'long=openai/gpt-long',
    'files=openai/gpt-files',
    'research=anthropic/claude-research',
    'chat=openai/gpt-chat',
  ].join('; '),
};

function database() {
  if (!handle) throw new Error('Postgres is unavailable');
  return handle;
}

function service() {
  const env = loadEnv({ NODE_ENV: 'test', MELETE_MASTER_KEY: masterKey, ...ENV });
  const settings = new ModelSettingsService({ db: database().db, env });
  const built = createApp({
    env,
    db: database().db,
    sql: database().sql,
    modelSettings: settings,
    checkDatabase: async () => 'ok',
  });
  return { env, settings, request: built.request.bind(built) };
}

async function ownerOf(api: ReturnType<typeof service>) {
  const setup = await api.request('/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', password }),
  });
  expect(setup.status).toBe(201);
  const sql = database().sql;
  const [ownerRow] = await sql`select id from principal where email = 'owner@example.test'`;
  const [space] = await sql`select id from space where owner_principal_id = ${ownerRow?.id}
    order by created_at limit 1`;
  return { id: String(ownerRow?.id), spaceId: String(space?.id) };
}

type Setup = (jobId: string) => Promise<void>;

/** The model a chat's next attempt is claimed on, after `setup` shapes its history. */
async function attemptModel(
  api: ReturnType<typeof service>,
  spaceId: string,
  personId: string,
  message: Record<string, unknown>,
  setup: Setup = async () => {},
) {
  if (!queue) throw new Error('the job queue is unavailable');
  const routing = routingFromEnv(api.env);
  const jobs = new JobService(database().db, queue.boss);
  const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
    key: 'model-routes-signing-key-32-chars-!!',
    scopes: [],
    resolveModel: (tx, row, usageClass) =>
      api.settings.routedChoice(routing, tx, {
        spaceId: row.spaceId,
        usageClass,
        kinds: (otherwise) => attemptWorkKinds(tx, row, usageClass, otherwise),
      }),
  });
  const job = await jobs.create({ space_id: spaceId, title: 'chat', objective: 'model check' });
  const sql = database().sql;
  await sql`update job set kind = 'chat', principal_id = ${personId} where id = ${job.id}`;
  await setup(job.id);
  await sql`insert into event (job_id, type, payload, dedup_key)
    values (${job.id}, 'notice', ${JSON.stringify({ kind: 'user_message', principal_id: personId, ...message })}::jsonb,
      ${`${job.id}:input:1`})`;
  const claimed = await runner.claim({
    job_id: job.id,
    expected_epoch: job.leaseEpoch,
    expected_version: job.stateVersion,
    reason: 'created',
  });
  if (!claimed) throw new Error('attempt was not claimed');
  return `${claimed.bundle.model.provider}/${claimed.bundle.model.model}`;
}

describeWithDb('routes per kind of work', () => {
  beforeEach(async () => {
    await resetTestRows(database().sql);
  }, 15_000);

  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 30_000);

  test('what a chat is about picks its model', async () => {
    const api = service();
    const { id, spaceId } = await ownerOf(api);
    const sql = database().sql;
    expect(await attemptModel(api, spaceId, id, { text: 'hello' })).toBe('openai/gpt-chat');
    expect(
      await attemptModel(api, spaceId, id, { text: 'open https://example.com in your browser' }),
    ).toBe('openai/gpt-browser');
    // Research has a route, but its provider has no key: the next kind takes it.
    expect(await attemptModel(api, spaceId, id, { text: 'compare these with sources' })).toBe(
      'openai/gpt-chat',
    );
    const csv = { id: 'file_abc123', name: 'q3.csv', kind: 'csv', size: 2048, pages: null };
    expect(await attemptModel(api, spaceId, id, { text: 'thoughts?', attachments: [csv] })).toBe(
      'openai/gpt-files',
    );
    // An earlier attempt of the job used the computer.
    expect(
      await attemptModel(api, spaceId, id, { text: 'and again' }, async (jobId) => {
        const attemptId = newId('att');
        await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
          values (${attemptId}, ${jobId}, 0, 'test', 'fireworks', ${PRIMARY})`;
        await sql`insert into event (job_id, attempt_id, type, payload, dedup_key)
          values (${jobId}, ${attemptId}, 'tool_call_proposed',
            ${JSON.stringify({ call_id: 'c1', tool: 'computer.click', arguments: {} })}::jsonb,
            ${`${attemptId}:c1`})`;
      }),
    ).toBe('openai/gpt-computer');
    // Earlier messages already summarised: a long conversation.
    expect(
      await attemptModel(api, spaceId, id, { text: 'and then?' }, async (jobId) => {
        await sql`insert into event (job_id, type, payload, dedup_key)
          values (${jobId}, 'notice', ${JSON.stringify({ kind: 'history_summary', text: 'earlier' })}::jsonb,
            ${`${jobId}:summary:1`})`;
      }),
    ).toBe('openai/gpt-long');
  }, 60_000);

  test('a shared space is team work, ahead of the rest', async () => {
    const api = service();
    const { id, spaceId } = await ownerOf(api);
    const sql = database().sql;
    const other = newId('own');
    await sql`insert into principal (id, email) values (${other}, 'friend@example.test')`;
    await sql`insert into space_membership (principal_id, space_id, role)
      values (${other}, ${spaceId}, 'member')`;
    expect(
      await attemptModel(api, spaceId, id, { text: 'open https://example.com in your browser' }),
    ).toBe('openai/gpt-team');
  }, 60_000);

  test('the model the owner chose in the app wins over every route', async () => {
    const api = service();
    const { id, spaceId } = await ownerOf(api);
    await database()
      .sql`insert into model_default (id, provider, model, owner_id) values ('installation', 'fireworks', 'accounts/fireworks/models/owner-pick', ${id})`;
    expect(
      await attemptModel(api, spaceId, id, { text: 'open https://example.com in your browser' }),
    ).toBe('fireworks/accounts/fireworks/models/owner-pick');
  }, 60_000);
});
