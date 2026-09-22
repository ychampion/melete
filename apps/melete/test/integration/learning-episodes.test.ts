import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { action, artifact, connection } from '../../src/db/schema.ts';
import { MAX_RECORDED_OUTPUT } from '../../src/learning/episodes.ts';
import { learningTrial } from '../../src/learning/evaluation-schema.ts';
import { compileProcedure, definitionHash } from '../../src/learning/procedure.ts';
import { ProcedureService } from '../../src/learning/procedures.ts';
import { expireEpisodes } from '../../src/learning/retention.ts';
import { mountLearning } from '../../src/learning/routes.ts';
import {
  episode,
  procedureCandidate,
  procedureEvaluation,
  procedureTransition,
} from '../../src/learning/schema.ts';
import { publishRevision } from '../../src/memory/claims.ts';
import { assembleAttemptKnowledge } from '../../src/memory/context.ts';
import { lockSpace, newId } from '../../src/memory/db.ts';
import { ingest } from '../../src/memory/evidence.ts';
import { applyRestriction, forgetMemory } from '../../src/memory/forget.ts';
import type { RestrictionJournal, RestrictionRecord } from '../../src/memory/restore.ts';
import { buildViews } from '../../src/memory/views.ts';
import { learningFixture, learningScope, rejectsWith, wake } from './learning-fixtures.ts';

const fixture = await learningFixture();
afterAll(async () => fixture?.close(), 15000);
(fixture ? describe : describe.skip)('learning episode capture', () => {
  test.each(['owner deletion', 'retention', 'memory removal'] as const)(
    '%s erases derived candidates, evaluations and canary history',
    async (removal) => {
      if (!fixture) return;
      const { handle, ownerId, spaceId, episodes } = fixture;
      const row = await fixture.create(`derived-removal-${removal.replaceAll(' ', '-')}`);
      const source = await episodes.intervene(ownerId, row.id, {
        idempotency_key: removal,
        kind: 'correction',
        text: 'Use typed ordering.',
        signal: 'typed_ordering',
      });
      const definition = {
        ...compileProcedure({
          target: 'skill_body',
          steps: ['sort-typed-values'],
          test: 'ordering-and-shape',
        }),
        scope: learningScope,
        compatibleModels: ['fake/scripted-learning-v1'],
      };
      const id = newId('pc');
      const evaluationId = newId('pe');
      await handle.db.insert(procedureCandidate).values({
        ...definition,
        id,
        episodeId: source.id,
        spaceId,
        bodyHash: definitionHash(definition),
        state: 'enabled_canary',
        canarySpaceId: spaceId,
      });
      await handle.db.insert(procedureEvaluation).values({
        id: evaluationId,
        candidateId: id,
        bodyHash: definitionHash(definition),
        phase: 'sealed_final',
        suiteHash: 'removal-fixture',
        evidence: {},
        budget: {},
        passed: true,
      });
      await handle.db.insert(procedureTransition).values({
        id: newId('pt'),
        candidateId: id,
        fromState: 'evaluated',
        toState: 'enabled_canary',
        actor: ownerId,
        reason: 'Removal fixture canary',
      });
      await handle.db.insert(learningTrial).values({
        jobId: row.id,
        candidateId: id,
        evaluationId,
        bodyHash: definitionHash(definition),
        useCandidate: true,
        expiresAt: new Date(Date.now() + 60000),
      });
      const service = new ProcedureService(fixture.jobs);
      const before = await service.inspect(ownerId, spaceId, id);
      expect(before.candidate.canarySpaceId).toBe(spaceId);
      expect(before.evaluations).toHaveLength(1);
      expect(before.history).toHaveLength(1);
      if (removal === 'owner deletion') await episodes.remove(ownerId, spaceId, source.id);
      else if (removal === 'retention') {
        await handle.db
          .update(episode)
          .set({ expiresAt: new Date(0) })
          .where(eq(episode.id, source.id));
        await expireEpisodes(handle.sql);
      } else
        await forgetMemory(
          handle.sql,
          { ownerId, spaceId, publisher: 'owner', audience: 'private', role: 'owner' },
          { all: true },
          { read: async () => [], append: async () => {} },
        );
      expect(
        await handle.db.select().from(procedureCandidate).where(eq(procedureCandidate.id, id)),
      ).toEqual([]);
      expect(
        await handle.db
          .select()
          .from(procedureEvaluation)
          .where(eq(procedureEvaluation.candidateId, id)),
      ).toEqual([]);
      expect(
        await handle.db
          .select()
          .from(procedureTransition)
          .where(eq(procedureTransition.candidateId, id)),
      ).toEqual([]);
      expect(
        await handle.db.select().from(learningTrial).where(eq(learningTrial.candidateId, id)),
      ).toEqual([]);
      await rejectsWith(() => service.inspect(ownerId, spaceId, id), 'not_found');
    },
  );

  test('a correction during a job creates exactly one episode with intervention and receipts', async () => {
    if (!fixture) return;
    const { jobs, runner, episodes, ownerId, spaceId, handle } = fixture;
    const row = await fixture.create();
    expect(
      (
        await episodes.setScope(ownerId, row.id, {
          scope: learningScope,
          template_id: 'training-invoices',
        })
      ).jobId,
    ).toBe(row.id);
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

  test('a cleared job cannot recreate evidence on a later completion or correction', async () => {
    if (!fixture) return;
    const row = await fixture.create('late-after-clear');
    const claimed = await fixture.runner.claim(wake(row));
    if (!claimed) throw new Error('No attempt');
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
      { read: async () => [], append: async () => {} },
    );
    const next = await fixture.jobs.get(row.id);
    const reclaimed = await fixture.runner.claim(wake(next));
    if (!reclaimed) throw new Error('No resumed attempt');
    await fixture.runner.commitOutcome(reclaimed.claims, {
      kind: 'completed',
      summary: 'Late operational completion',
      evidence: [],
    });
    expect((await fixture.jobs.get(row.id)).state).toBe('completed');
    expect(
      (await fixture.episodes.list(fixture.ownerId, fixture.spaceId)).filter(
        (saved) => saved.jobId === row.id,
      ),
    ).toHaveLength(0);
    await rejectsWith(
      () =>
        fixture.episodes.intervene(fixture.ownerId, row.id, {
          idempotency_key: 'after-clear',
          kind: 'correction',
          text: 'Do not recover old evidence.',
        }),
      'evidence_unavailable',
    );
    const fresh = await fixture.create('fresh-after-clear');
    const freshAttempt = await fixture.runner.claim(wake(fresh));
    if (!freshAttempt) throw new Error('No fresh attempt');
    await fixture.runner.commitOutcome(freshAttempt.claims, {
      kind: 'completed',
      summary: 'New evidence after the clear',
      evidence: [],
    });
    expect(
      (await fixture.episodes.list(fixture.ownerId, fixture.spaceId)).some(
        (saved) => saved.jobId === fresh.id,
      ),
    ).toBe(true);
  }, 15000);

  test('forgetting waits for a completing job and erases the episode committed during that wait', async () => {
    if (!fixture) return;
    const row = await fixture.create('completion-racing-clear');
    const claimed = await fixture.runner.claim(wake(row));
    if (!claimed) throw new Error('No attempt');
    let release!: () => void;
    let reached!: () => void;
    let planned!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const captured = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const plannedRemoval = new Promise<void>((resolve) => {
      planned = resolve;
    });
    const holdCompletion = async () => {
      reached();
      await held;
    };
    fixture.runner.onFinished.push(holdCompletion);
    const completion = fixture.runner.commitOutcome(claimed.claims, {
      kind: 'completed',
      summary: 'An episode is still uncommitted',
      evidence: [],
    });
    let removal: ReturnType<typeof forgetMemory> | undefined;
    try {
      await captured;
      removal = forgetMemory(
        fixture.handle.sql,
        {
          ownerId: fixture.ownerId,
          spaceId: fixture.spaceId,
          publisher: 'owner',
          audience: 'private',
          role: 'owner',
        },
        { all: true },
        {
          read: async () => [],
          append: async () => {
            planned();
          },
        },
      );
      await plannedRemoval;
      let waiting = false;
      const deadline = Date.now() + 5000;
      while (!waiting && Date.now() < deadline) {
        const blocked = await fixture.handle.sql`select 1 from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and query like '%select j.id from job j%'`;
        waiting = blocked.length > 0;
        if (!waiting) await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
    } finally {
      release();
      await completion;
      await removal;
      fixture.runner.onFinished.splice(fixture.runner.onFinished.indexOf(holdCompletion), 1);
    }
    const [saved] = await fixture.handle.db.select().from(episode).where(eq(episode.jobId, row.id));
    expect(saved).toMatchObject({ restricted: true, versions: [], receipts: [] });
    expect(
      (await fixture.episodes.list(fixture.ownerId, fixture.spaceId)).some(
        (value) => value.jobId === row.id,
      ),
    ).toBe(false);
  }, 15000);

  test('a partially forgotten source handle cannot become fresh learning evidence', async () => {
    if (!fixture) return;
    const scope = {
      ownerId: fixture.ownerId,
      spaceId: fixture.spaceId,
      publisher: 'owner',
      audience: 'private' as const,
      role: 'owner' as const,
    };
    const accepted = await ingest(fixture.handle.sql, scope, {
      stream: 'chat',
      source_identity: 'partial-learning-source',
      source_version: '1',
      source_type: 'message',
      event_at: new Date().toISOString(),
      text: 'Retain this introduction. PRIVATE-FRAGMENT. Retain this ending.',
    });
    const learning = {
      scope: learningScope,
      template_id: 'partial-source',
      input_refs: [`${accepted.source.source_id}@1`],
    };
    const row = await fixture.jobs.create({
      space_id: fixture.spaceId,
      title: 'Source-backed job',
      objective: 'Arrange the records',
      learning,
    });
    const claimed = await fixture.runner.claim(wake(row));
    if (!claimed) throw new Error('No source-backed attempt');
    const [generation] = await fixture.handle.sql`select eligibility_generation, access_generation
      from memory_spaces where space_id = ${fixture.spaceId}`;
    const record: RestrictionRecord = {
      id: newId('sup'),
      owner_id: fixture.ownerId,
      space_id: fixture.spaceId,
      operation: 'forget',
      all: false,
      claim_ids: [],
      targets: [
        {
          source_id: accepted.source.source_id,
          publisher: 'owner',
          stream: 'chat',
          source_identity: 'partial-learning-source',
          start: 25,
          end: 41,
          suppression_id: newId('sup'),
        },
      ],
      eligibility_cutoff: Number(generation?.eligibility_generation),
      access_generation: Number(generation?.access_generation) + 1,
      recorded_at: new Date().toISOString(),
    };
    await fixture.handle.sql.begin((tx) => applyRestriction(tx, record));
    const [source] = await fixture.handle
      .sql`select state from memory_sources where id = ${accepted.source.source_id}`;
    expect(source?.state).toBe('active');
    await rejectsWith(
      () =>
        fixture.jobs.create({
          space_id: fixture.spaceId,
          title: 'Unavailable source',
          objective: 'Arrange records',
          learning,
        }),
      'scope_denied',
    );
    const next = await fixture.runner.claim(wake(await fixture.jobs.get(row.id)));
    if (!next) throw new Error('No resumed source-backed attempt');
    await fixture.runner.commitOutcome(next.claims, {
      kind: 'completed',
      summary: 'Operational completion after partial forgetting',
      evidence: [],
    });
    expect(
      (await fixture.episodes.list(fixture.ownerId, fixture.spaceId)).some(
        (value) => value.jobId === row.id,
      ),
    ).toBe(false);
  }, 15000);

  test('delivered memory handles are captured and forgetting their claim removes the episode', async () => {
    if (!fixture) return;
    const scope = {
      ownerId: fixture.ownerId,
      spaceId: fixture.spaceId,
      publisher: 'owner',
      audience: 'private' as const,
      role: 'owner' as const,
    };
    const text = 'Use typed ordering for my records. PRIVATE-CONTEXT-CLAIM.';
    const accepted = await ingest(fixture.handle.sql, scope, {
      stream: 'chat',
      source_identity: 'delivered-learning-context',
      source_version: '1',
      source_type: 'message',
      event_at: new Date().toISOString(),
      text,
    });
    const claim = await fixture.handle.sql.begin(async (tx) => {
      await lockSpace(tx, scope);
      return publishRevision(tx, scope, 'pref.records.ordering', null, {
        content: 'Use typed ordering for records',
        kind: 'user_statement',
        factual_status: 'attributed',
        protected: false,
        valid_from: new Date().toISOString(),
        valid_until: null,
        sources: [
          { source_id: accepted.source.source_id, source_version: '1', start: 0, end: text.length },
        ],
      });
    });
    await buildViews(fixture.handle.sql, scope);
    const row = await fixture.create('delivered-context');
    const attempt = await fixture.runner.claim(wake(row));
    if (!attempt) throw new Error('No context attempt');
    const delivered = await assembleAttemptKnowledge(
      fixture.handle.sql,
      scope,
      attempt.claims.attempt_id,
      row.id,
      'typed ordering records',
    );
    expect(delivered.context.items.some((item) => item.claim_id === claim.claim_id)).toBe(true);
    const saved = await fixture.episodes.intervene(fixture.ownerId, row.id, {
      idempotency_key: 'consumed-context',
      kind: 'correction',
      text: 'Keep the typed record order. PRIVATE-OWNER-CONTEXT.',
    });
    expect(saved.inputRefs).toContain(`${claim.claim_id}@1`);
    expect(saved.inputRefs).toContain(`${accepted.source.source_id}@1`);
    await forgetMemory(
      fixture.handle.sql,
      scope,
      { claim_id: claim.claim_id },
      {
        read: async () => [],
        append: async () => {},
      },
    );
    const [restricted] = await fixture.handle.db
      .select()
      .from(episode)
      .where(eq(episode.id, saved.id));
    expect(restricted).toMatchObject({ restricted: true, intervention: null, inputRefs: [] });
    await rejectsWith(
      () =>
        fixture.episodes.intervene(fixture.ownerId, row.id, {
          idempotency_key: 'forgotten-context',
          kind: 'correction',
          text: 'Try the old context again.',
        }),
      'scope_denied',
    );
  }, 15000);

  test('a correction records the prior and corrected outputs', async () => {
    if (!fixture) return;
    const { jobs, runner, episodes, ownerId, spaceId, handle } = fixture;
    const row = await fixture.create('prior-and-corrected');
    const first = await runner.claim(wake(row));
    if (!first) throw new Error('No attempt');
    const connectionId = newId('conn');
    const actionId = newId('act');
    await handle.db
      .insert(connection)
      .values({ id: connectionId, spaceId, provider: 'test', label: 'Test' });
    await handle.db.insert(action).values({
      id: actionId,
      jobId: row.id,
      attemptId: first.claims.attempt_id,
      connectionId,
      kind: 'records.write',
      effectClass: 'write_reversible',
      canonicalPayload: {},
      payloadHash: 'c'.repeat(64),
      idempotencyKey: actionId,
      status: 'succeeded',
      receipt: { id: 'receipt-prior' },
    });
    await runner.commitOutcome(first.claims, {
      kind: 'completed',
      summary: 'Amounts as text: 10, 2, 9.',
      evidence: [],
    });
    const source = await episodes.intervene(ownerId, row.id, {
      idempotency_key: 'prior-and-corrected',
      kind: 'correction',
      text: 'Sort the amounts as numbers.',
      signal: 'typed_ordering',
    });
    expect(source.priorOutput).toBe('Amounts as text: 10, 2, 9.');
    expect(source.correctedOutput).toBeNull();
    // An action-kind check needs the kind and the effect class, not just a receipt.
    expect(source.receipts[0]).toMatchObject({
      action_id: actionId,
      kind: 'records.write',
      effect_class: 'write_reversible',
    });
    if (!source.correctiveJobId) throw new Error('No corrective job');
    const corrective = await jobs.get(source.correctiveJobId);
    const second = await runner.claim(wake(corrective));
    if (!second) throw new Error('No corrective attempt');
    await runner.commitOutcome(second.claims, {
      kind: 'completed',
      summary: 'Amounts as numbers: 2, 9, 10.',
      evidence: [],
    });
    const [saved] = await handle.db.select().from(episode).where(eq(episode.id, source.id));
    expect(saved).toMatchObject({
      judgement: 'corrected',
      priorOutput: 'Amounts as text: 10, 2, 9.',
      correctedOutput: 'Amounts as numbers: 2, 9, 10.',
    });
    // A completion that was never objected to keeps no outputs to compare.
    const plain = await fixture.create('no-correction-no-outputs');
    const only = await runner.claim(wake(plain));
    if (!only) throw new Error('No plain attempt');
    await runner.commitOutcome(only.claims, {
      kind: 'completed',
      summary: 'Nothing to correct here.',
      evidence: [],
    });
    const [untouched] = await handle.db.select().from(episode).where(eq(episode.jobId, plain.id));
    expect(untouched).toMatchObject({ priorOutput: null, correctedOutput: null });
  }, 20000);

  test('a recorded output is capped before it is stored', async () => {
    if (!fixture) return;
    const { runner, episodes, ownerId, handle } = fixture;
    const row = await fixture.create('capped-output');
    const first = await runner.claim(wake(row));
    if (!first) throw new Error('No attempt');
    await runner.commitOutcome(first.claims, {
      kind: 'completed',
      summary: 'x'.repeat(MAX_RECORDED_OUTPUT + 500),
      evidence: [],
    });
    const source = await episodes.intervene(ownerId, row.id, {
      idempotency_key: 'capped-output',
      kind: 'correction',
      text: 'Keep it much shorter.',
    });
    expect(source.priorOutput?.length).toBe(MAX_RECORDED_OUTPUT);
    const [saved] = await handle.db.select().from(episode).where(eq(episode.id, source.id));
    expect(saved?.priorOutput?.length).toBe(MAX_RECORDED_OUTPUT);
  }, 20000);

  test('forgetting erases the recorded outputs, including after a restore', async () => {
    if (!fixture) return;
    const { jobs, runner, episodes, ownerId, spaceId, handle } = fixture;
    const scope = {
      ownerId,
      spaceId,
      publisher: 'owner',
      audience: 'private' as const,
      role: 'owner' as const,
    };
    const made = async (key: string) => {
      const row = await fixture.create(key);
      const first = await runner.claim(wake(row));
      if (!first) throw new Error('No attempt');
      await runner.commitOutcome(first.claims, {
        kind: 'completed',
        summary: `PRIOR-OUTPUT-${key}`,
        evidence: [],
      });
      const saved = await episodes.intervene(ownerId, row.id, {
        idempotency_key: key,
        kind: 'correction',
        text: 'Use the other order.',
      });
      if (!saved.correctiveJobId) throw new Error('No corrective job');
      const second = await runner.claim(wake(await jobs.get(saved.correctiveJobId)));
      if (!second) throw new Error('No corrective attempt');
      await runner.commitOutcome(second.claims, {
        kind: 'completed',
        summary: `CORRECTED-OUTPUT-${key}`,
        evidence: [],
      });
      const [stored] = await handle.db.select().from(episode).where(eq(episode.id, saved.id));
      expect(stored?.priorOutput).toBe(`PRIOR-OUTPUT-${key}`);
      expect(stored?.correctedOutput).toBe(`CORRECTED-OUTPUT-${key}`);
      return saved.id;
    };
    const erased = async (id: string, key: string) => {
      const [saved] = await handle.db.select().from(episode).where(eq(episode.id, id));
      expect(saved).toMatchObject({ priorOutput: null, correctedOutput: null, restricted: true });
      const surviving = await handle.sql`select id from episode
        where prior_output like ${`%${key}%`} or corrected_output like ${`%${key}%`}`;
      expect(surviving).toHaveLength(0);
    };
    const deleted = await made('forget-by-owner');
    await episodes.remove(ownerId, spaceId, deleted);
    await erased(deleted, 'forget-by-owner');
    const expired = await made('forget-by-retention');
    await handle.db
      .update(episode)
      .set({ expiresAt: new Date(0) })
      .where(eq(episode.id, expired));
    await expireEpisodes(handle.sql);
    await erased(expired, 'forget-by-retention');
    const forgotten = await made('forget-by-memory');
    const records: RestrictionRecord[] = [];
    const journal: RestrictionJournal = {
      read: async () => records,
      append: async (record) => {
        records.push(record);
      },
    };
    await forgetMemory(handle.sql, scope, { all: true }, journal);
    await erased(forgotten, 'forget-by-memory');
    // Replaying the same record, as a restore does, erases them again on the restored rows.
    const replayed = records[records.length - 1];
    if (!replayed) throw new Error('No restriction record to replay');
    await handle.db
      .update(episode)
      .set({
        restricted: false,
        priorOutput: 'PRIOR-OUTPUT-forget-by-memory',
        correctedOutput: 'CORRECTED-OUTPUT-forget-by-memory',
      })
      .where(eq(episode.id, forgotten));
    await handle.sql.begin((tx) => applyRestriction(tx, replayed));
    await erased(forgotten, 'forget-by-memory');
  }, 30000);

  test('an opaque source version can complete its job without creating unrepresentable learning evidence', async () => {
    if (!fixture) return;
    const scope = {
      ownerId: fixture.ownerId,
      spaceId: fixture.spaceId,
      publisher: 'owner',
      audience: 'private' as const,
      role: 'owner' as const,
    };
    const version = 'opaque version@1';
    const text = 'Use typed ordering for opaque source records.';
    const accepted = await ingest(fixture.handle.sql, scope, {
      stream: 'chat',
      source_identity: 'opaque-learning-context',
      source_version: version,
      source_type: 'message',
      event_at: new Date().toISOString(),
      text,
    });
    const claim = await fixture.handle.sql.begin(async (tx) => {
      await lockSpace(tx, scope);
      return publishRevision(tx, scope, 'pref.records.opaque', null, {
        content: 'Use typed ordering for opaque records',
        kind: 'user_statement',
        factual_status: 'attributed',
        protected: false,
        valid_from: new Date().toISOString(),
        valid_until: null,
        sources: [
          {
            source_id: accepted.source.source_id,
            source_version: version,
            start: 0,
            end: text.length,
          },
        ],
      });
    });
    await buildViews(fixture.handle.sql, scope);
    const row = await fixture.create('opaque-context');
    const attempt = await fixture.runner.claim(wake(row));
    if (!attempt) throw new Error('No opaque-source attempt');
    const delivered = await assembleAttemptKnowledge(
      fixture.handle.sql,
      scope,
      attempt.claims.attempt_id,
      row.id,
      'typed ordering opaque records',
    );
    expect(delivered.context.items.some((item) => item.claim_id === claim.claim_id)).toBe(true);
    await fixture.runner.commitOutcome(attempt.claims, {
      kind: 'completed',
      summary: 'Operational completion with an opaque source version',
      evidence: [],
    });
    expect((await fixture.jobs.get(row.id)).state).toBe('completed');
    expect(
      (await fixture.episodes.list(fixture.ownerId, fixture.spaceId)).some(
        (value) => value.jobId === row.id,
      ),
    ).toBe(false);
  }, 15000);
});
