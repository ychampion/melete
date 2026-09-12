/**
 * The delta brief. An attempt is disposable and the responsibility is not, so
 * the next wake needs one thing the last one knew: what happened while it was
 * not running. Every assertion here reads it back from durable rows.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { renderSinceLast } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import {
  action,
  approval,
  artifact,
  attempt,
  connection,
  job,
  question,
  space,
} from '../../src/db/schema.ts';
import { serviceTransaction } from '../../src/db/transaction.ts';
import { newId } from '../../src/ids.ts';
import { buildBundle } from '../../src/jobs/bundle.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
let spaceId = '';

function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}

const identity = (id: string) => ({ id, epoch: 2, revision: 0, token: 'fixture-only' });
const model = { provider: 'fake', model: 'scripted-v1', fallback: null };

withDb('the delta brief', () => {
  let jobId = '';
  let connectionId = '';
  let firstAttempt = '';

  /** One finished attempt, so the next one has something to be a delta from. */
  const seed = async () => {
    const { handle, jobs } = fixture();
    const row = await jobs.create({
      space_id: spaceId,
      title: 'Chase the heating repair',
      objective: 'Ask the building manager for a date an engineer is booked.',
    });
    jobId = row.id;
    connectionId = newId('conn');
    await handle.db.insert(connection).values({
      id: connectionId,
      spaceId,
      provider: 'test',
      label: 'test destination',
      scopes: ['test.send'],
    });
    firstAttempt = newId('att');
    await handle.db.insert(attempt).values({
      id: firstAttempt,
      jobId,
      epoch: 1,
      runtimeVersion: 'stub/1',
      provider: 'fake',
      model: 'scripted-v1',
      startedAt: new Date(Date.now() - 120_000),
      endedAt: new Date(Date.now() - 60_000),
      outcome: 'completed',
      outcomeDetail: { kind: 'completed', summary: 'Sent the first note.', evidence: [] },
    });
    await handle.db.update(job).set({ leaseEpoch: 1 }).where(eq(job.id, jobId));
  };

  beforeEach(async () => {
    const { handle } = fixture();
    await handle.sql`truncate "owner", "space", event_retention cascade`;
    spaceId = newId('sp');
    await handle.db
      .insert(space)
      .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
    await seed();
  });

  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  test('after a completed send the next bundle names the receipt, and the model-facing text says it', async () => {
    const { handle } = fixture();
    const actionId = newId('act');
    await handle.db.insert(action).values({
      id: actionId,
      jobId,
      attemptId: firstAttempt,
      connectionId,
      kind: 'test.send',
      effectClass: 'write_external',
      canonicalPayload: { body: 'Any date this week works.' },
      payloadHash: 'a'.repeat(64),
      status: 'succeeded',
      idempotencyKey: actionId,
      dispatchedAt: new Date(Date.now() - 30_000),
      resolvedAt: new Date(Date.now() - 29_000),
      receipt: {
        action_id: actionId,
        connection_id: connectionId,
        external_ref: 'message-id-7731@example.test',
        detail: {},
        received_at: new Date(Date.now() - 29_000).toISOString(),
        late: false,
      },
    });

    const row = await fixture().jobs.get(jobId);
    const bundle = await serviceTransaction(handle.db, (tx) =>
      buildBundle(tx, row, identity(newId('att')), model, 0),
    );

    expect(bundle.since_last.attempt_id).toBe(firstAttempt);
    const sent = bundle.since_last.actions.find((entry) => entry.action_id === actionId);
    expect(sent?.status).toBe('succeeded');
    expect(sent?.receipt_ref).toBe('message-id-7731@example.test');

    const text = renderSinceLast(bundle.since_last);
    expect(text).toContain('message-id-7731@example.test');
    expect(text).toContain(actionId);
    expect(text).toContain(firstAttempt);
  }, 60_000);

  test('artifacts and knowledge written since the last attempt arrive as evidence handles', async () => {
    const { handle } = fixture();
    const artifactId = newId('art');
    await handle.db.insert(artifact).values({
      id: artifactId,
      spaceId,
      jobId,
      path: 'artifacts/heating-note.md',
      contentHash: 'b'.repeat(64),
      mime: 'text/markdown',
      size: 42,
    });

    const row = await fixture().jobs.get(jobId);
    const bundle = await serviceTransaction(handle.db, (tx) =>
      buildBundle(tx, row, identity(newId('att')), model, 0),
    );
    const handles = bundle.since_last.evidence.map((entry) => entry.handle);
    expect(handles).toContain(`artifact:${artifactId}`);
    expect(renderSinceLast(bundle.since_last)).toContain('artifacts/heating-note.md');
  }, 60_000);

  test('a question already asked and an approval still waiting are both in the brief', async () => {
    const { handle } = fixture();
    const questionId = newId('qst');
    await handle.db.insert(question).values({
      id: questionId,
      jobId,
      attemptId: firstAttempt,
      text: 'Which address should the engineer be sent to?',
      because: [`job:${jobId}`],
      ifIgnored: 'Nobody is let in and the slot is lost.',
      state: 'open',
    });
    const actionId = newId('act');
    await handle.db.insert(action).values({
      id: actionId,
      jobId,
      attemptId: firstAttempt,
      connectionId,
      kind: 'test.send',
      effectClass: 'write_external',
      canonicalPayload: { body: 'Confirm Thursday.' },
      payloadHash: 'c'.repeat(64),
      status: 'needs_approval',
      idempotencyKey: actionId,
    });
    const approvalId = newId('apr');
    await handle.db.insert(approval).values({
      id: approvalId,
      actionId,
      jobRevision: 0,
      payloadHash: 'c'.repeat(64),
    });

    const row = await fixture().jobs.get(jobId);
    const bundle = await serviceTransaction(handle.db, (tx) =>
      buildBundle(tx, row, identity(newId('att')), model, 0),
    );
    expect(bundle.since_last.pending_questions.map((entry) => entry.id)).toContain(questionId);
    expect(bundle.since_last.pending_approvals.map((entry) => entry.approval_id)).toContain(
      approvalId,
    );
    const text = renderSinceLast(bundle.since_last);
    expect(text).toContain('Which address should the engineer be sent to?');
    expect(text).toContain(approvalId);
  }, 60_000);

  test('a first wake has no prior work to name, and says so rather than inventing some', async () => {
    const { handle, jobs } = fixture();
    const fresh = await jobs.create({
      space_id: spaceId,
      title: 'A new responsibility',
      objective: 'Nothing has happened yet.',
    });
    const bundle = await serviceTransaction(handle.db, (tx) =>
      buildBundle(tx, fresh, identity(newId('att')), model, 0),
    );
    expect(bundle.since_last.attempt_id).toBeNull();
    expect(bundle.since_last.actions).toEqual([]);
    expect(renderSinceLast(bundle.since_last)).toBe('This is the first attempt on this job.');
  }, 60_000);
});
