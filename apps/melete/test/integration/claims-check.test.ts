/**
 * A saved answer keeps no sentence that claims a step no action in its turn
 * took, and an answer whose claims are backed is kept as it was.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { agentResponse, conversationResponse } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { session } from '../../src/db/auth-schema.ts';
import { experienceTurn, owner, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { freshAgent } from '../helpers/agents.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'claims-check-signing-key-32-bytes!!!',
      scopes: [],
    })
  : null;
const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      jobs: jobs ?? undefined,
      runner: runner ?? undefined,
      sql: handle.sql,
      checkDatabase: async () => 'ok',
    })
  : null;
const withDb = handle ? describe : describe.skip;

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('fixture unavailable');
  return value;
}

const ownerId = newId('own');
const spaceId = newId('sp');
const token = randomBytes(32).toString('base64url');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'claims@example.test' });
  await handle.sql`insert into principal (id, email, password_hash) select id, email, password_hash from owner where id = ${ownerId}`;
  await handle.db
    .insert(space)
    .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
  await handle.db.insert(session).values({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    ownerId,
    spaceId,
    expiresAt: new Date(Date.now() + 600000),
  });
}
const request = (path: string, method = 'GET', body?: unknown) =>
  required(app).request(path, {
    method,
    headers: {
      Cookie: `melete_session=${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

async function answered(summary: string) {
  const persona = agentResponse.parse(
    await (await request('/agents', 'POST', freshAgent())).json(),
  ).agent;
  const chat = conversationResponse.parse(
    await (
      await request('/conversations', 'POST', { title: 'Dinner', agent_id: persona.id })
    ).json(),
  ).conversation;
  expect(
    (await request(`/conversations/${chat.id}/messages`, 'POST', { text: 'Book dinner at 7.' }))
      .status,
  ).toBe(200);
  const row = await required(jobs).get(chat.id);
  const claimed = required(
    await required(runner).claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'input',
    }),
  );
  await required(runner).commitOutcome(claimed.claims, {
    kind: 'completed',
    summary,
    evidence: [],
  });
  const [turn] = await required(handle)
    .db.select()
    .from(experienceTurn)
    .where(eq(experienceTurn.jobId, chat.id));
  return required(turn).answer;
}

withDb('the claims check on a saved answer', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30_000);

  test('a booking no action made is taken out, and the rest of the answer stays', async () => {
    expect(
      await answered('Osteria Rio has a table at 7. I booked it for two. They close at 11.'),
    ).toBe('Osteria Rio has a table at 7. They close at 11.');
  });

  test('a working method no action backs is taken out too', async () => {
    expect(await answered('I checked in my browser. Osteria Rio has a table at 7.')).toBe(
      'Osteria Rio has a table at 7.',
    );
  });

  test('an answer that claims nothing is kept as it was', async () => {
    const text = 'Osteria Rio has a table at 7. Want me to book it?';
    expect(await answered(text)).toBe(text);
  });
});
