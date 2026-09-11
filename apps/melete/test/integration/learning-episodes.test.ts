import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { action, artifact, connection } from '../../src/db/schema.ts';
import { expireEpisodes } from '../../src/learning/retention.ts';
import { mountLearning } from '../../src/learning/routes.ts';
import { episode } from '../../src/learning/schema.ts';
import { newId } from '../../src/memory/db.ts';
import { forgetMemory } from '../../src/memory/forget.ts';
import type { RestrictionJournal, RestrictionRecord } from '../../src/memory/restore.ts';
import { learningFixture, rejectsWith, wake } from './learning-fixtures.ts';

const fixture = await learningFixture();
afterAll(async () => fixture?.close(), 15000);
(fixture ? describe : describe.skip)('learning episode capture', () => {
  test('a correction during a job creates exactly one episode with intervention and receipts', async () => {
    if (!fixture) return;
    const { jobs, runner, episodes, ownerId, spaceId, handle } = fixture;
    const row = await fixture.create();
    const claimed = await runner.claim(wake(row));
    if (!claimed) throw new Error('No attempt');
    const change = {
      idempotency_key: 'owner-correction-1',
      kind: 'correction',
      text: 'Sort amounts as numbers. Private account: PLANTED-SECRET-319.',
      signal: 'typed_ordering',
    };
    const first = await episodes.intervene(ownerId, row.id, change);
    const replay = await episodes.intervene(ownerId, row.id, change);
    expect(replay.id).toBe(first.id);
    await rejectsWith(
      () => episodes.intervene(ownerId, row.id, { ...change, text: 'different' }),
      'idempotency_conflict',
    );
    await rejectsWith(
      () =>
        runner.commitOutcome(claimed.claims, { kind: 'completed', summary: 'stale', evidence: [] }),
      'stale_epoch',
    );
    const corrected = await runner.claim(wake(await jobs.get(row.id)));
    if (!corrected) throw new Error('No corrected attempt');
    const connectionId = newId('conn');
    const actionId = newId('act');
    const artifactId = newId('art');
    await handle.db
      .insert(connection)
      .values({ id: connectionId, spaceId, provider: 'test', label: 'Test' });
    await handle.db.insert(action).values({
      id: actionId,
      jobId: row.id,
      attemptId: corrected.claims.attempt_id,
      connectionId,
      kind: 'test.effect',
      effectClass: 'write_reversible',
      canonicalPayload: {},
      payloadHash: 'a'.repeat(64),
      idempotencyKey: actionId,
      status: 'succeeded',
      receipt: { id: 'receipt-one', verified: true },
    });
    await handle.db.insert(artifact).values({
      id: artifactId,
      jobId: row.id,
      spaceId,
      path: 'sorted.csv',
      contentHash: 'b'.repeat(64),
      mime: 'text/csv',
      size: 12,
    });
    await runner.commitOutcome(corrected.claims, {
      kind: 'completed',
      summary: 'Sorted correctly',
      evidence: [
        { kind: 'artifact', artifact_id: artifactId },
        { kind: 'action', action_id: actionId },
      ],
    });
    const rows = (await episodes.list(ownerId, spaceId)).filter((saved) => saved.jobId === row.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.intervention?.text).toBe(change.text);
    expect(rows[0]?.judgement).toBe('corrected');
    expect(rows[0]?.receipts[0]).toMatchObject({
      action_id: actionId,
      receipt: { id: 'receipt-one' },
    });
    expect(rows[0]?.artifacts[0]).toMatchObject({ id: artifactId });
    expect(rows[0]?.versions).toHaveLength(2);
    expect(rows[0]?.versions[1]).toMatchObject({
      provider: 'fake',
      model_requested: 'scripted-learning-v1',
      runtime: 'stub/1',
    });
  }, 15000);

  test('completed jobs have an episode; a note alone is not an intervention', async () => {
    if (!fixture) return;
    const row = await fixture.create('plain-job');
    const claimed = await fixture.runner.claim(wake(row));
    if (!claimed) throw new Error('No attempt');
    await fixture.runner.commitOutcome(claimed.claims, {
      kind: 'completed',
      summary: 'Finished',
      evidence: [],
    });
    const rows = await fixture.episodes.list(fixture.ownerId, fixture.spaceId);
    expect(rows.find((saved) => saved.jobId === row.id)).toMatchObject({
      judgement: 'completed',
      intervention: null,
    });
  });

  test('GET /episodes and deletion bind every row to the requested authenticated space', async () => {
    if (!fixture) return;
    const other = await fixture.createSpace();
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('owner', {
        id: fixture.ownerId,
        email: 'test@example.test',
        created_at: new Date().toISOString(),
      });
      await next();
    });
    mountLearning(app, fixture.episodes);
    const response = await app.request(`/episodes?space_id=${other}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ episodes: [] });
    const [saved] = await fixture.episodes.list(fixture.ownerId, fixture.spaceId);
    if (!saved) throw new Error('No episode');
    await rejectsWith(() => fixture.episodes.remove(fixture.ownerId, other, saved.id), 'not_found');
    await rejectsWith(() => fixture.episodes.list(newId('own'), fixture.spaceId), 'scope_denied');
  });

  test('retention and the existing memory forget path erase episode evidence', async () => {
    if (!fixture) return;
    const row = await fixture.create('retention');
    const saved = await fixture.episodes.intervene(fixture.ownerId, row.id, {
      idempotency_key: 'retention',
      kind: 'takeover',
      text: 'PRIVATE-RETENTION-MATERIAL',
    });
    await fixture.handle.db
      .update(episode)
      .set({ expiresAt: new Date(0) })
      .where(eq(episode.id, saved.id));
    expect(await expireEpisodes(fixture.handle.sql)).toBe(1);
    const [expired] = await fixture.handle.db
      .select()
      .from(episode)
      .where(eq(episode.id, saved.id));
    expect(expired).toMatchObject({ restricted: true, intervention: null, receipts: [] });
    const records: RestrictionRecord[] = [];
    const journal: RestrictionJournal = {
      read: async () => records,
      append: async (record) => {
        records.push(record);
      },
    };
    await forgetMemory(
      fixture.handle.sql,
      {
        ownerId: fixture.ownerId,
        spaceId: fixture.spaceId,
        publisher: 'owner',
        audience: 'private',
        role: 'owner',
      },
      { all: true },
      journal,
    );
    expect(await fixture.episodes.list(fixture.ownerId, fixture.spaceId)).toEqual([]);
    const remaining = await fixture.handle.db.select().from(episode);
    expect(
      remaining.every((saved) => saved.intervention === null && saved.receipts.length === 0),
    ).toBe(true);
  });
});
