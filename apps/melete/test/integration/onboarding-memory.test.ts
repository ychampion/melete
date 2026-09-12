/**
 * Four answers given during setup become four saved details the person can
 * read back, each on its own key with owner trust, and the first message's
 * attempt bundle carries the one it is about.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  agentResponse,
  conversationResponse,
  memoryItemList,
  memoryItemResponse,
  messageAcceptance,
} from '@melete/contracts';
import { session } from '../../src/db/auth-schema.ts';
import { owner, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { AGENT_TEMPLATES } from '../../src/experience/agents.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { buildBundle } from '../../src/jobs/bundle.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { type MemoryScope, provisionMemorySpace } from '../../src/memory/db.ts';
import type { RestrictionJournal, RestrictionRecord } from '../../src/memory/restore.ts';
import { buildViews } from '../../src/memory/views.ts';
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
      key: 'onboarding-fixture-signing-key-32-bytes',
    })
  : null;
const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      jobs: jobs ?? undefined,
      runner: runner ?? undefined,
      sql: handle.sql,
      memory: { sql: handle.sql, journal },
      checkDatabase: async () => 'ok',
    })
  : null;
const spaceId = newId('sp');
const ownerId = newId('own');
const token = randomBytes(32).toString('base64url');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'setup@example.test' });
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

const answers = [
  {
    key: 'pref.home.city',
    value: 'New York',
    statement: 'Where are you based? New York.',
  },
  {
    key: 'pref.people.names',
    value: 'Alex and Priya',
    statement: 'Who should I know by name? Alex and Priya.',
  },
  {
    key: 'pref.focus.this-month',
    value: 'A launch at work',
    statement: 'What eats your week right now? A launch at work.',
  },
  {
    key: 'pref.checkins.style',
    value: 'Morning brief at 8:30',
    statement: 'How should I check in? Morning brief at 8:30.',
  },
];

withDb('setup answers as saved details', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  test('four answers become four onboarding items with owner trust, one per key', async () => {
    const created = [];
    for (const answer of answers) {
      const response = await request('/memory/items', 'POST', answer);
      const body = await response.text();
      if (response.status !== 200 || !body.includes('"item"'))
        throw new Error(`${answer.key}: ${response.status} ${body}`);
      created.push(memoryItemResponse.parse(JSON.parse(body)).item);
    }
    expect(created.map((item) => item.source)).toEqual([
      'onboarding',
      'onboarding',
      'onboarding',
      'onboarding',
    ]);
    expect(created.map((item) => item.value)).toEqual(answers.map((answer) => answer.value));
    expect(created[0]?.key).toBe('home: city');

    const listed = memoryItemList.parse(await (await request('/memory/items')).json());
    expect(listed.items).toHaveLength(4);
    expect(listed.items.every((item) => item.source === 'onboarding' && item.editable)).toBe(true);

    const sql = required(handle).sql;
    const trust = await sql`select r.origin_trust, r.protected, c.key from memory_revisions r
      join memory_claims c on c.id = r.claim_id where c.space_id = ${spaceId} and r.revision = c.head_revision order by c.key`;
    expect(trust).toHaveLength(4);
    expect(trust.every((row) => row.origin_trust === 'owner' && row.protected === true)).toBe(true);
    expect(trust.map((row) => row.key)).toEqual(answers.map((answer) => answer.key).sort());

    // The same statement again is the same item; a new answer on a key replaces it.
    const repeated = memoryItemResponse.parse(
      await (await request('/memory/items', 'POST', answers[0])).json(),
    ).item;
    expect(repeated.id).toBe(required(created[0]).id);
    const moved = memoryItemResponse.parse(
      await (
        await request('/memory/items', 'POST', {
          key: 'pref.home.city',
          value: 'Lisbon',
          statement: 'Where are you based? Lisbon.',
        })
      ).json(),
    ).item;
    expect(moved.id).toBe(required(created[0]).id);
    expect(moved.value).toBe('Lisbon');
    const after = memoryItemList.parse(await (await request('/memory/items')).json());
    expect(after.items).toHaveLength(4);
    expect(after.items.find((item) => item.id === moved.id)?.value).toBe('Lisbon');
    const revisions =
      await sql`select count(*)::int as n from memory_revisions where claim_id = ${moved.id}`;
    expect(revisions[0]?.n).toBe(2);
  });

  test('the first message after setup carries the answer it is about', async () => {
    const persona = agentResponse.parse(
      await (await request('/agents', 'POST', AGENT_TEMPLATES.templates[0]?.agent)).json(),
    ).agent;
    const chat = conversationResponse.parse(
      await (
        await request('/conversations', 'POST', { title: 'Getting started', agent_id: persona.id })
      ).json(),
    ).conversation;
    const accepted = messageAcceptance.parse(
      await (
        await request(
          `/conversations/${chat.id}/messages`,
          'POST',
          { text: 'Set up the launch at work as a plan.' },
          'first-message',
        )
      ).json(),
    );
    expect(accepted.receipt.status).toBe('accepted');
    const row = await required(jobs).get(chat.id);
    const claimed = required(
      await required(runner).claim({
        job_id: row.id,
        expected_epoch: row.leaseEpoch,
        expected_version: row.stateVersion,
        reason: 'input',
      }),
    );
    const scope: MemoryScope = {
      ownerId,
      spaceId,
      publisher: 'experience',
      audience: 'private',
      role: 'owner',
    };
    // Publishing marks the index and profile stale and queues the rebuild the
    // memory worker performs; here it runs inline, as the worker would have.
    await buildViews(required(handle).sql, scope);
    const built = await buildBundle(claimed.bundle, {
      sql: required(handle).sql,
      scope,
      catalog: async () => [],
    });
    const texts = built.bundle.knowledge.map((entry) => JSON.stringify(entry));
    expect(texts.some((entry) => entry.includes('A launch at work'))).toBe(true);
    expect(texts.some((entry) => entry.includes('pref.focus.this-month'))).toBe(true);
    await required(runner).commitOutcome(claimed.claims, {
      kind: 'completed',
      summary: 'The plan is set up.',
      evidence: [],
    });
  });
});
