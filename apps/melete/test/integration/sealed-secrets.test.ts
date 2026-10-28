/**
 * A secret the agent asks for is typed into a sealed field and never enters
 * the conversation: the answer is sealed in the space by name, the chat keeps
 * only that it was given, memory never sees it, and the next attempt hears
 * only that it is saved. A command that names it gets it for that command and
 * its output and receipt come back redacted; a name this space has not sealed,
 * another space's secret of the same name, and a deleted one are refused
 * before anything runs. After all of it, the value is in no row of any table
 * and no line the service wrote.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type Action,
  agentResponse,
  type CapabilityClaims,
  canonicalizePayload,
  conversationResponse,
  experienceOperations,
} from '@melete/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { requestPersonQuestion } from '../../src/broker/ask-person.ts';
import { createSandboxExecConnector } from '../../src/connectors/sandbox-exec.ts';
import { PostgresSecretRepository, SealedSecretStore } from '../../src/connectors/secrets.ts';
import { SpaceSecrets } from '../../src/connectors/space-secrets.ts';
import type { ConnectorContext } from '../../src/connectors/types.ts';
import { session } from '../../src/db/auth-schema.ts';
import { event, owner, question, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { AGENT_TEMPLATES } from '../../src/experience/agents.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { sealedNotice } from '../../src/jobs/questions.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { captureChat } from '../../src/memory/capture.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { FakeSandboxProvider } from '../../src/sandbox/fake.ts';
import { seedSessionScope } from '../../src/sandbox/session-fixtures.ts';
import { SandboxSessions } from '../../src/sandbox/sessions.ts';
import { rejectionOf } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const KEY = randomBytes(32).toString('hex');
/** What the person types. Long and odd enough that a match anywhere is this value. */
const SECRET = `wk-live-${randomBytes(12).toString('hex')}-Planted`;
const OTHER_SPACE_SECRET = `wk-other-${randomBytes(12).toString('hex')}-Planted`;
const NAME = 'WEATHER_API_KEY';

/** Every line the service writes while the test runs, to look for the value in. */
const written: string[] = [];
const keep =
  (write: typeof process.stderr.write) =>
  (chunk: unknown, ...rest: unknown[]): boolean => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString());
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
  };
const stderrWrite = process.stderr.write.bind(process.stderr);
const stdoutWrite = process.stdout.write.bind(process.stdout);
process.stderr.write = keep(stderrWrite) as typeof process.stderr.write;
process.stdout.write = keep(stdoutWrite) as typeof process.stdout.write;

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'sealed-secret-fixture-signing-key-32b',
    })
  : null;
const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test', MELETE_MASTER_KEY: KEY }),
      jobs: jobs ?? undefined,
      runner: runner ?? undefined,
      sql: handle.sql,
      checkDatabase: async () => 'ok',
    })
  : null;
const spaceId = newId('sp');
const ownerId = newId('own');
const token = randomBytes(32).toString('base64url');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'sealed@example.test' });
  await handle.sql`insert into principal (id, email) select id, email from owner where id = ${ownerId}`;
  await handle.db.insert(space).values({ id: spaceId, name: 'Personal', gitPath: `/s/${spaceId}` });
  await handle.db.insert(session).values({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    ownerId,
    spaceId,
    expiresAt: new Date(Date.now() + 600000),
  });
}
const withDb = handle ? describe : describe.skip;
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture');
  return value;
}
const sql = () => required(handle).sql;
const secrets = () =>
  new SpaceSecrets(sql(), new SealedSecretStore(new PostgresSecretRepository(sql()), () => KEY));

async function request(path: string, method = 'GET', body?: unknown) {
  const response = await required(app).request(path, {
    method,
    headers: {
      Cookie: `melete_session=${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  written.push(await response.clone().text());
  return response;
}

async function claim(jobId: string) {
  const row = await required(jobs).get(jobId);
  return required(
    await required(runner).claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'input',
    }),
  );
}

/** A chat whose first turn is claimed and running. */
async function chatTurn(text: string) {
  const agent = agentResponse.parse(
    await (await request('/agents', 'POST', AGENT_TEMPLATES.templates[0]?.agent)).json(),
  ).agent.id;
  const created = await request('/conversations', 'POST', { title: 'Weather', agent_id: agent });
  const chat = conversationResponse.parse(await created.json()).conversation;
  expect((await request(`/conversations/${chat.id}/messages`, 'POST', { text })).status).toBe(200);
  return { id: chat.id, claims: (await claim(chat.id)).claims };
}

const ask = (claims: CapabilityClaims, input: unknown) =>
  requestPersonQuestion(sql(), claims, input);

/** Every table, in every schema the service writes, whose rows hold `value` anywhere. */
async function tablesHolding(value: string): Promise<string[]> {
  const tables = await sql()`select table_schema, table_name from information_schema.tables
    where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')`;
  const found: string[] = [];
  for (const table of tables) {
    const name = `${table.table_schema}.${table.table_name}`;
    const [hit] = await sql()`select 1 from ${sql()(String(table.table_schema))}.${sql()(
      String(table.table_name),
    )} t where strpos(t::text, ${value}) > 0 limit 1`;
    if (hit) found.push(name);
  }
  return found;
}

withDb('a secret given through a sealed field', () => {
  let workRoot = '';
  afterAll(async () => {
    process.stderr.write = stderrWrite as typeof process.stderr.write;
    process.stdout.write = stdoutWrite as typeof process.stdout.write;
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
    if (workRoot) await rm(workRoot, { recursive: true, force: true });
  }, 30000);

  test('is asked for by name, sealed, and only said to have been given', async () => {
    const { id, claims } = await chatTurn('What will the weather be tomorrow?');
    // A name the computer uses itself, and choices beside a secret, are refused.
    expect(
      await rejectionOf(
        ask(claims, { question: 'Key?', secret: { name: 'PATH', purpose: 'weather' } }),
      ),
    ).toMatchObject({ code: 'payload_invalid' });
    expect(
      await rejectionOf(
        ask(claims, {
          question: 'Key?',
          choices: ['a'],
          secret: { name: NAME, purpose: 'weather' },
        }),
      ),
    ).toMatchObject({ code: 'payload_invalid' });
    const asked = await ask(claims, {
      question: 'Could you give me your weather service API key?',
      secret: { name: NAME, purpose: 'Reading the forecast from the weather service' },
    });
    expect(asked.instruction).toContain(`${NAME} is saved`);
    await required(runner).commitOutcome(claims, {
      kind: 'completed',
      summary: 'I need a key for the weather service.',
      evidence: [],
    });
    const cards = experienceOperations['GET /quick-answers'].response.parse(
      await (await request('/quick-answers')).json(),
    ).questions;
    const card = required(cards.find((entry) => entry.conversation_id === id));
    expect(card).toMatchObject({
      free_text: false,
      secret: { name: NAME, purpose: 'Reading the forecast from the weather service', host: null },
    });
    // Words never answer it, on either API.
    expect((await request(`/quick-answers/${card.id}`, 'POST', { text: SECRET })).status).toBe(409);
    expect((await request(`/questions/${card.id}/answer`, 'POST', { text: SECRET })).status).toBe(
      409,
    );
    const answered = await request(`/quick-answers/${card.id}/secret`, 'POST', { value: SECRET });
    expect(answered.status).toBe(200);
    expect((await required(jobs).get(id)).state).toBe('queued');

    // The conversation keeps the notice, marked as no words of the person's.
    const rows = await required(handle)
      .db.select({ seq: event.seq, payload: event.payload })
      .from(event)
      .where(and(eq(event.jobId, id), eq(event.type, 'notice')))
      .orderBy(desc(event.seq));
    const notice = required(
      rows.find((row) => (row.payload as { kind?: string }).kind === 'user_message'),
    );
    const [closed] = await required(handle)
      .db.select()
      .from(question)
      .where(eq(question.jobId, id));
    expect(notice.payload).toMatchObject({
      text: sealedNotice(NAME),
      sealed: { question_id: required(closed).id, name: NAME },
    });
    expect(closed).toMatchObject({ state: 'answered', answer: sealedNotice(NAME) });

    // The next attempt hears that it is saved, and how to use it.
    const next = await claim(id);
    const said = next.bundle.inputs.new_user_messages.map((message) => message.content);
    expect(said).toHaveLength(1);
    expect(said[0]).toStartWith(`${NAME} is saved.`);
    expect(JSON.stringify(next.bundle)).not.toContain(SECRET);

    // Memory never takes the notice up.
    await captureChat(
      {
        sql: sql(),
        journal: { read: async () => [], append: async () => {} },
        scopeForJob: async () => {
          throw new Error('no scope in this fixture');
        },
        privacyOrigin: async () => null,
      },
      10_000,
    );
    expect(await sql()`select 1 from memory_capture where event_seq = ${notice.seq}`).toHaveLength(
      0,
    );

    // Settings list it by name and purpose alone.
    const listed = experienceOperations['GET /secrets'].response.parse(
      await (await request('/secrets')).json(),
    );
    expect(listed.secrets.map((each) => [each.name, each.purpose, each.host])).toEqual([
      [NAME, 'Reading the forecast from the weather service', null],
    ]);
  });

  test('is given to a command that names it, and redacted from all it prints', async () => {
    const scope = await seedSessionScope(sql());
    // The same name in another space holds another value, which is never used.
    await secrets().save({ spaceId, name: 'SITE_TOKEN', purpose: 'elsewhere' }, OTHER_SPACE_SECRET);
    await secrets().save({ spaceId: scope.spaceId, name: NAME, purpose: 'forecast' }, SECRET);
    await secrets().save(
      { spaceId: scope.spaceId, name: 'SITE_PASSWORD', purpose: 'one site', host: 'example.com' },
      'host-bound-value',
    );
    workRoot = await mkdtemp(path.join(tmpdir(), 'melete-sealed-'));
    await mkdir(path.join(workRoot, scope.jobId), { recursive: true });
    const provider = new FakeSandboxProvider();
    const connector = createSandboxExecConnector({
      sessions: new SandboxSessions(sql(), { leaseSeconds: 300, workspaceRetentionSeconds: 3_600 }),
      provider,
      config: {
        adapter: 'e2b',
        image: 'base',
        egress: 'deny_all',
        persistence: 'ephemeral',
        lifetime_seconds: 600,
      },
      connectionId: scope.connectionId,
      spaceId: scope.spaceId,
      project: 'sealed-secrets-test',
      workRoot,
      sql: sql(),
      secrets: secrets(),
    });
    const attemptId = await scope.attempt();
    const run = async (payload: Record<string, unknown>) => {
      const id = await scope.action(attemptId);
      const canonical = canonicalizePayload(payload);
      await sql()`update action set canonical_payload = ${JSON.stringify(canonical.canonical)}::jsonb
        where id = ${id}`;
      const action = {
        id,
        job_id: scope.jobId,
        attempt_id: attemptId,
        connection_id: scope.connectionId,
        kind: 'terminal.run',
        effect_class: 'write_reversible',
        canonical_payload: canonical.canonical,
        payload_hash: canonical.hash,
        intent_key: null,
        status: 'dispatched',
        authorization_ref: null,
        budget_reservation: null,
        idempotency_key: id,
        dispatched_at: new Date().toISOString(),
        receipt: null,
        resolved_at: null,
        reconciliation: null,
        repair_trace: [],
        repair_counters: {},
        repair_disposition: null,
        retry_after_at: null,
        created_at: new Date().toISOString(),
      } as Action;
      const ctx: ConnectorContext = {
        job_id: scope.jobId,
        space_id: scope.spaceId,
        idempotency_key: id,
        constraints: {
          deliverable: { kind: 'none' },
          allowed_domains: [],
          public_compartment: false,
        },
      };
      const result = await connector.execute(action, ctx);
      // Kept as the broker keeps it, so the database check below sees it.
      if (result.outcome === 'succeeded')
        await sql()`update action set receipt = ${JSON.stringify(result.receipt)}::jsonb
          where id = ${id}`;
      return result;
    };

    const echoed = await run({
      command: `echo "key=$${NAME}"; echo "$${NAME}" > /tmp/kept`,
      secrets: [NAME],
    });
    if (echoed.outcome !== 'succeeded') throw new Error(JSON.stringify(echoed));
    expect(echoed.receipt.detail).toMatchObject({
      output: 'key=[redacted]\n',
      secrets_used: [NAME],
      exit_code: 0,
    });
    expect(JSON.stringify(echoed)).not.toContain(SECRET);
    expect(JSON.stringify(echoed)).not.toContain(OTHER_SPACE_SECRET);
    // A command that names none still has the space's values kept out of what it prints.
    const plain = await run({ command: 'cat /tmp/kept' });
    if (plain.outcome !== 'succeeded') throw new Error(JSON.stringify(plain));
    expect(plain.receipt.detail.output).toBe('[redacted]\n');
    expect(plain.receipt.detail.secrets_used).toBeUndefined();
    // The agent's terminal passes the names a command refers to: the sealed one
    // is given, and the computer's own variables, and another space's, are not.
    const referred = await run({
      command: `echo "$${NAME}"`,
      secret_refs: [NAME, 'HOME', 'SITE_TOKEN', 'SITE_PASSWORD'],
    });
    if (referred.outcome !== 'succeeded') throw new Error(JSON.stringify(referred));
    expect(referred.receipt.detail).toMatchObject({ output: '[redacted]\n', secrets_used: [NAME] });

    // Refused before any computer opens: a name this space never sealed (another
    // space's own included), and one kept for a single host.
    const creates = provider.calls.create;
    const unknown = await run({ command: 'echo "$SITE_TOKEN"', secrets: ['SITE_TOKEN'] });
    expect(unknown).toMatchObject({ outcome: 'failed', retryable: false });
    expect((unknown as { reason: string }).reason).toContain(
      'SITE_TOKEN is not saved in this space',
    );
    const bound = await run({ command: 'echo "$SITE_PASSWORD"', secrets: ['SITE_PASSWORD'] });
    expect(bound).toMatchObject({ outcome: 'failed', retryable: false });
    expect((bound as { reason: string }).reason).toContain('kept for example.com only');
    expect(provider.calls.create).toBe(creates);

    // Deleted, it is refused with the reason, and its sealed record is gone.
    expect(await secrets().remove(scope.spaceId, NAME)).toBe(true);
    const gone = await run({ command: `echo "$${NAME}"`, secrets: [NAME] });
    expect(gone).toMatchObject({ outcome: 'failed', retryable: false });
    expect((gone as { reason: string }).reason).toContain(`${NAME} is not saved in this space`);

    // Nothing the service stored in the job workspace holds it either.
    const files = await readdir(path.join(workRoot, scope.jobId), { recursive: true });
    for (const file of files) {
      const full = path.join(workRoot, scope.jobId, String(file));
      const text = await readFile(full, 'utf8').catch(() => '');
      expect([file, text.includes(SECRET)]).toEqual([file, false]);
    }
  });

  test('is in no table, response or line the service wrote', async () => {
    // The sealed store holds it only as ciphertext.
    for (const value of [SECRET, OTHER_SPACE_SECRET])
      expect([value, await tablesHolding(value)]).toEqual([value, []]);
    const lines = written.join('\n');
    expect(lines).not.toContain(SECRET);
    expect(lines).not.toContain(OTHER_SPACE_SECRET);
  });
});
