/**
 * Adding an agent from the library makes that one agent and nothing else: its
 * starter routine is offered, not created, and the answers to its questions
 * become the person's own saved details on the agent's purpose keys.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  agentList,
  agentResponse,
  agentTemplateList,
  automationList,
  libraryAnswers,
  libraryRoutine,
  memoryItemList,
} from '@melete/contracts';
import { session } from '../../src/db/auth-schema.ts';
import { owner, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { provisionMemorySpace } from '../../src/memory/db.ts';
import type { RestrictionJournal, RestrictionRecord } from '../../src/memory/restore.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const forgotten: RestrictionRecord[] = [];
const journal: RestrictionJournal = {
  read: async () => forgotten,
  append: async (record) => {
    forgotten.push(record);
  },
};
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'library-fixture-signing-key-32-bytes!',
    })
  : null;
const triggers = jobs && runner ? new TriggerService(jobs, runner) : undefined;
const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      jobs: jobs ?? undefined,
      runner: runner ?? undefined,
      triggers,
      sql: handle.sql,
      memory: { sql: handle.sql, journal },
      checkDatabase: async () => 'ok',
    })
  : null;
const spaceId = newId('sp');
const ownerId = newId('own');
const token = randomBytes(32).toString('base64url');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'library@example.test' });
  await handle.sql`insert into principal (id, email, password_hash) select id, email, password_hash from owner where id = ${ownerId}`;
  await handle.db
    .insert(space)
    .values([{ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` }]);
  await handle.db.insert(session).values({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    ownerId,
    spaceId,
    expiresAt: new Date(Date.now() + 600000),
  });
  await provisionMemorySpace(handle.sql, ownerId, spaceId);
  await handle.sql`update memory_spaces set restore_ready = true where space_id = ${spaceId}`;
}
const withDb = handle ? describe : describe.skip;

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture');
  return value;
}
async function request(path: string, method = 'GET', body?: unknown, key?: string) {
  return required(app).request(path, {
    method,
    headers: {
      Cookie: `melete_session=${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function json(path: string, method = 'GET', body?: unknown) {
  const response = await request(path, method, body);
  const text = await response.text();
  // A route that is not connected answers 200 with `unavailable`; that is a failure here.
  if (response.status !== 200 || text.includes('"unavailable"'))
    throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return JSON.parse(text) as unknown;
}

withDb('adding an agent from the library', () => {
  afterAll(async () => {
    await triggers?.stop();
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  test('makes one agent with no connections, offers the routine and saves answers to its keys', async () => {
    const { templates } = agentTemplateList.parse(await json('/agents/templates'));
    const template = required(templates.find((entry) => entry.id === 'inbox-triage'));
    expect(template.starter_routine).not.toBeNull();
    expect(template.questions.length).toBeGreaterThanOrEqual(2);
    const before = agentList.parse(await json('/agents')).agents;
    const routinesBefore = automationList.parse(await json('/automations')).automations;

    // The draft as the library hands it over, saved without changes.
    const made = agentResponse.parse(await json('/agents', 'POST', template.agent)).agent;
    const after = agentList.parse(await json('/agents')).agents;
    expect(after.length).toBe(before.length + 1);
    expect(after.filter((agent) => agent.name === template.agent.name)).toHaveLength(1);
    expect(made.allowed_connection_ids).toEqual([]);
    expect(made.standing_instruction).toBe(template.agent.standing_instruction);

    // Offered, not created: nothing is scheduled until the person says yes.
    expect(automationList.parse(await json('/automations')).automations).toHaveLength(
      routinesBefore.length,
    );

    const [first, second, third] = template.questions;
    const details = libraryAnswers(template.questions, {
      [required(first).id]: '  My manager and the school  ',
      [required(second).id]: 'Short and friendly',
      [required(third).id]: '',
    });
    expect(details.map((detail) => detail.key)).toEqual([
      required(first).memory_key,
      required(second).memory_key,
    ]);
    for (const detail of details) await json('/memory/items', 'POST', detail);
    const { items } = memoryItemList.parse(await json('/memory/items'));
    const saved = items.filter((item) => item.key.startsWith('inbox: '));
    expect(saved.map((item) => [item.key, item.value, item.source]).sort()).toEqual([
      ['inbox: important senders', 'My manager and the school', 'onboarding'],
      ['inbox: reply voice', 'Short and friendly', 'onboarding'],
    ]);

    // Saying yes makes exactly one routine.
    const routine = required(template.starter_routine);
    await json('/automations', 'POST', libraryRoutine(routine, made.id));
    expect(automationList.parse(await json('/automations')).automations).toHaveLength(
      routinesBefore.length + 1,
    );
  });
});
