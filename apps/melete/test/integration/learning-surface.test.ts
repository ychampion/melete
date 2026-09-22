import { afterAll, describe, expect, test } from 'bun:test';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { ServiceError } from '../../src/api/errors.ts';
import { event } from '../../src/db/schema.ts';
import { CANARY_INTERVENTION } from '../../src/learning/canary.ts';
import { LearnedService } from '../../src/learning/learned.ts';
import { mountLearned } from '../../src/learning/learned-routes.ts';
import {
  episode,
  learnedChange,
  learningNotice,
  procedureCandidate,
  procedureTransition,
} from '../../src/learning/schema.ts';
import { newId } from '../../src/memory/db.ts';
import { rejectsWith, wake } from './learning-fixtures.ts';
import {
  CORRECTION,
  generalLearningFixture,
  messageProposal,
  SOURCE,
} from './learning-general-fixtures.ts';

const fixture = await generalLearningFixture();
const learned = fixture
  ? new LearnedService(fixture.jobs, fixture.procedures, fixture.episodes)
  : null;
afterAll(async () => {
  await fixture?.close();
}, 30000);

const LATER = 'Draft a follow-up email to the plumber';

/** The parts of a response body these tests read. */
type Reply = {
  item?: { id: string; state: string } | null;
  change?: { id: string } | null;
  notice?: unknown;
  notices?: { id: string }[];
  items?: ({ id: string } & Record<string, unknown>)[];
  last_change?: { id: string } | null;
  episode_id?: string;
  error?: { code: string };
};

/** The HTTP surface, signed in as `principal`. */
function app(principal: string) {
  if (!fixture || !learned) throw new Error('No fixture');
  const server = new Hono();
  // The same mapping the service mounts: a refusal is a status and a code, not a throw.
  server.onError((error, c) => {
    if (error instanceof ServiceError)
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    throw error;
  });
  server.use('*', async (c, next) => {
    c.set('owner', {
      id: principal,
      email: `${principal}@example.test`,
      created_at: new Date().toISOString(),
    });
    await next();
  });
  mountLearned(server, learned);
  return async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const response = await server.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Reply };
  };
}

/** A proposed procedure with no checks, learned from one of the owner's corrections. */
async function proposed(spaceId: string, key: string) {
  if (!fixture) throw new Error('No fixture');
  const { episode: source } = await fixture.corrected(spaceId, key, SOURCE, CORRECTION);
  fixture.propose({ ...messageProposal(), checks: [] });
  return fixture.proposer.generate(fixture.ownerId, spaceId, source.id);
}

/** On trial: tried through the list, as the person would. */
async function onTrial(spaceId: string, key: string) {
  const candidate = await proposed(spaceId, key);
  if (!fixture) throw new Error('No fixture');
  const call = app(fixture.ownerId);
  const tried = await call('POST', `/learned/${candidate.id}/try`, {
    space_id: spaceId,
    definition_hash: candidate.bodyHash,
  });
  expect(tried.status).toBe(200);
  expect(tried.body.item).toMatchObject({ id: candidate.id, state: 'trial' });
  return candidate;
}

async function delivered(spaceId: string, candidateId: string, principal?: string) {
  if (!fixture) throw new Error('No fixture');
  const row = await fixture.create(spaceId, LATER, principal ?? fixture.ownerId);
  const claim = await fixture.runner.claim(wake(row));
  const names = claim?.bundle.skills.map((skill) => skill.name) ?? [];
  await fixture.jobs.cancel(row.id);
  return names.includes(`procedure:${candidateId}`);
}

/** A job that uses the trial and finishes without a correction. */
async function usedIt(spaceId: string) {
  if (!fixture) throw new Error('No fixture');
  const row = await fixture.create(spaceId, LATER);
  await fixture.run(row);
  return row;
}

const candidateRow = async (id: string) => {
  if (!fixture) throw new Error('No fixture');
  const [row] = await fixture.handle.db
    .select()
    .from(procedureCandidate)
    .where(eq(procedureCandidate.id, id));
  if (!row) throw new Error('No candidate');
  return row;
};

/** A shared space the owner owns, with a member when asked for. */
async function sharedSpace(member?: string) {
  if (!fixture) throw new Error('No fixture');
  const spaceId = await fixture.createSpace();
  await fixture.handle
    .sql`update space set kind = 'shared', audience = 'space', owner_principal_id = ${fixture.ownerId} where id = ${spaceId}`;
  await fixture.handle
    .sql`insert into space_membership (space_id, principal_id, role) values (${spaceId}, ${fixture.ownerId}, 'owner')`;
  if (member) {
    await fixture.handle
      .sql`insert into principal (id, email) values (${member}, ${`${member}@example.test`})`;
    await fixture.handle
      .sql`insert into space_membership (space_id, principal_id, role) values (${spaceId}, ${member}, 'member')`;
  }
  return spaceId;
}

const questionsFor = async (candidateId: string) => {
  if (!fixture) throw new Error('No fixture');
  return fixture.handle.db
    .select()
    .from(learningNotice)
    .where(
      and(eq(learningNotice.candidateId, candidateId), eq(learningNotice.kind, 'keep_question')),
    );
};

(fixture ? describe : describe.skip)('what a person taught, in the product', () => {
  test('a job that used a trial earns one templated question, and only one', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const candidate = await onTrial(spaceId, 'surface-ask');
    expect(await questionsFor(candidate.id)).toHaveLength(0);
    const job = await usedIt(spaceId);
    const call = app(fixture.ownerId);
    const { body } = await call('GET', `/learning/notices?space_id=${spaceId}`);
    expect(body.notices).toEqual([
      expect.objectContaining({
        kind: 'keep_question',
        item_id: candidate.id,
        name: 'Follow-up email',
        text: 'I followed what you taught me about "Follow-up email" on this job. Keep doing this?',
        job_id: job.id,
        state: 'open',
        options: [
          { id: 'yes', label: 'Yes, keep doing this' },
          { id: 'no', label: 'No, stop' },
          { id: 'change', label: 'Change it' },
        ],
      }),
    ]);
    // The job's own stream carries it, for a person watching that job.
    const announced = await fixture.handle.db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.jobId, job.id));
    expect(announced.map((entry) => entry.payload)).toContainEqual(
      expect.objectContaining({ kind: 'learning_question', procedure_id: candidate.id }),
    );
    // A second job that uses it adds no second question.
    await usedIt(spaceId);
    expect(await questionsFor(candidate.id)).toHaveLength(1);
    // A job that did not use it asks nothing either.
    const other = await proposed(spaceId, 'surface-ask-untried');
    expect(await questionsFor(other.id)).toHaveLength(0);
  }, 180000);

  test('a canary earned by evaluation asks nothing: the question is about the person’s own trial', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const candidate = await fixture.evaluatedCanary(await proposed(spaceId, 'surface-evaluated'));
    expect(await delivered(spaceId, candidate.id)).toBe(true);
    await usedIt(spaceId);
    expect(await questionsFor(candidate.id)).toHaveLength(0);
  }, 180000);

  test('yes keeps it for that person, and sharing it still needs sealed evidence', async () => {
    if (!fixture) return;
    const spaceId = await sharedSpace();
    const candidate = await onTrial(spaceId, 'surface-yes');
    await usedIt(spaceId);
    const [question] = await questionsFor(candidate.id);
    if (!question) throw new Error('No question');
    const call = app(fixture.ownerId);
    const answered = await call('POST', `/learning/notices/${question.id}/answer`, {
      space_id: spaceId,
      answer: 'yes',
    });
    expect(answered.status).toBe(200);
    expect(answered.body.notice).toMatchObject({ state: 'answered', answer: 'yes' });
    expect(answered.body.item).toMatchObject({ state: 'active', actions: ['pause', 'remove'] });
    const kept = await candidateRow(candidate.id);
    expect(kept).toMatchObject({
      state: 'active',
      promotion: {
        scope: 'private',
        principal_id: fixture.ownerId,
        basis: 'owner_confirmed',
        definition_hash: candidate.bodyHash,
      },
    });
    expect(await delivered(spaceId, candidate.id)).toBe(true);
    // Still private to its owner and its origin space.
    expect(await delivered(await fixture.createSpace(), candidate.id)).toBe(false);
    // Answering again the same way is the same answer; a different one is too late.
    expect(
      (
        await call('POST', `/learning/notices/${question.id}/answer`, {
          space_id: spaceId,
          answer: 'yes',
        })
      ).status,
    ).toBe(200);
    const late = await call('POST', `/learning/notices/${question.id}/answer`, {
      space_id: spaceId,
      answer: 'no',
    });
    expect(late).toMatchObject({ status: 409, body: { error: { code: 'question_closed' } } });
    // Sharing is the evaluation road's: an owner's yes is not evidence.
    await rejectsWith(
      () => fixture.procedures.activate(fixture.ownerId, spaceId, candidate.id, 'space'),
      'invalid_procedure_state',
    );
    // The approval named bytes: a changed definition is no longer delivered.
    await fixture.handle.db
      .update(procedureCandidate)
      .set({ promotion: { ...kept.promotion, definition_hash: 'f'.repeat(64) } })
      .where(eq(procedureCandidate.id, candidate.id));
    expect(await delivered(spaceId, candidate.id)).toBe(false);
  }, 180000);

  test('no stops it with the reason recorded, and a notice says why in plain words', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const candidate = await onTrial(spaceId, 'surface-no');
    const job = await usedIt(spaceId);
    const [question] = await questionsFor(candidate.id);
    if (!question) throw new Error('No question');
    const call = app(fixture.ownerId);
    const answered = await call('POST', `/learning/notices/${question.id}/answer`, {
      space_id: spaceId,
      answer: 'no',
      reason: 'The plumber prefers full sentences.',
    });
    expect(answered.status).toBe(200);
    expect(answered.body.item).toMatchObject({
      state: 'reverted',
      reason_code: 'owner_declined',
      reason: 'You said not to keep doing it.',
      actions: ['remove'],
    });
    expect(await candidateRow(candidate.id)).toMatchObject({
      state: 'reverted',
      rejectionReason: 'owner_declined',
    });
    const [transition] = await fixture.handle.db
      .select()
      .from(procedureTransition)
      .where(eq(procedureTransition.candidateId, candidate.id))
      .orderBy(desc(procedureTransition.createdAt))
      .limit(1);
    expect(transition).toMatchObject({
      toState: 'reverted',
      actor: fixture.ownerId,
      reason: 'The owner said not to keep it: The plumber prefers full sentences.',
    });
    expect(await delivered(spaceId, candidate.id)).toBe(false);
    const { body } = await call('GET', `/learning/notices?space_id=${spaceId}`);
    expect(body.notices).toEqual([
      expect.objectContaining({
        kind: 'reverted',
        item_id: candidate.id,
        reason_code: 'owner_declined',
        text: 'I stopped using "Follow-up email". You said not to keep doing it.',
        job_id: job.id,
        state: 'open',
      }),
    ]);
    // Read, it leaves the list of things to see.
    const notice = body.notices?.[0];
    expect(
      (await call('POST', `/learning/notices/${notice?.id}/read`, { space_id: spaceId })).body
        .notice,
    ).toMatchObject({ state: 'read' });
    expect((await call('GET', `/learning/notices?space_id=${spaceId}`)).body.notices).toEqual([]);
  }, 180000);

  test('change turns the person’s words into a correction of the job that used it', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const candidate = await onTrial(spaceId, 'surface-change');
    const job = await usedIt(spaceId);
    const [question] = await questionsFor(candidate.id);
    if (!question) throw new Error('No question');
    const words = 'Keep the bullet points, but start with "Hello," instead.';
    const answered = await app(fixture.ownerId)('POST', `/learning/notices/${question.id}/answer`, {
      space_id: spaceId,
      answer: 'change',
      text: words,
    });
    expect(answered.status).toBe(200);
    expect(answered.body.notice).toMatchObject({ state: 'answered', answer: 'change' });
    const [correction] = await fixture.handle.db
      .select()
      .from(episode)
      .where(eq(episode.id, answered.body.episode_id ?? ''));
    // The person's own words, recorded as theirs, on the job the question was about.
    expect(correction).toMatchObject({
      jobId: job.id,
      actor: fixture.ownerId,
      judgement: 'pending',
      intervention: { kind: 'correction', text: words },
    });
    expect(correction?.correctiveJobId).toBeTruthy();
    // Correcting a job that used it stops it, and says so.
    expect(await candidateRow(candidate.id)).toMatchObject({
      state: 'reverted',
      rejectionReason: CANARY_INTERVENTION,
    });
    const reverted = await fixture.handle.db
      .select()
      .from(learningNotice)
      .where(
        and(eq(learningNotice.candidateId, candidate.id), eq(learningNotice.kind, 'reverted')),
      );
    expect(reverted).toEqual([
      expect.objectContaining({ reasonCode: CANARY_INTERVENTION, principalId: fixture.ownerId }),
    ]);
  }, 180000);

  test('a correction on a job that used a trial stops it, withdraws the question and says why', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const candidate = await onTrial(spaceId, 'surface-revert');
    const job = await usedIt(spaceId);
    await fixture.episodes.intervene(fixture.ownerId, job.id, {
      idempotency_key: 'surface-revert',
      kind: 'correction',
      text: 'No, not like that.',
    });
    const [question] = await questionsFor(candidate.id);
    expect(question?.state).toBe('withdrawn');
    const call = app(fixture.ownerId);
    const { body } = await call('GET', `/learning/notices?space_id=${spaceId}`);
    expect(body.notices).toEqual([
      expect.objectContaining({
        kind: 'reverted',
        reason_code: CANARY_INTERVENTION,
        text: 'I stopped using "Follow-up email". You corrected a job that used it, so I stopped.',
      }),
    ]);
    const answered = await call('POST', `/learning/notices/${question?.id}/answer`, {
      space_id: spaceId,
      answer: 'yes',
    });
    expect(answered).toMatchObject({ status: 409, body: { error: { code: 'question_closed' } } });
    const announced = await fixture.handle.db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.jobId, job.id));
    expect(announced.map((entry) => entry.payload)).toContainEqual(
      expect.objectContaining({ kind: 'learning_reverted', reason_code: CANARY_INTERVENTION }),
    );
  }, 180000);

  test('the list says what each one does in the person’s words, where it applies, and its state', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const waiting = await proposed(spaceId, 'surface-list-proposed');
    const trying = await onTrial(spaceId, 'surface-list-trial');
    const { body } = await app(fixture.ownerId)('GET', `/learned?space_id=${spaceId}`);
    const byId = Object.fromEntries((body.items ?? []).map((item) => [item.id, item]));
    expect(byId[waiting.id]).toEqual({
      id: waiting.id,
      source: 'correction',
      name: 'Follow-up email',
      does: ['Use bullet points.', 'Start with "Hi there," on its own line.'],
      applies_when: ['follow-up email'],
      space_id: spaceId,
      shared: false,
      state: 'proposed',
      reason: null,
      reason_code: null,
      definition_hash: waiting.bodyHash,
      learned_at: waiting.createdAt.toISOString(),
      actions: ['try', 'remove'],
    });
    expect(byId[trying.id]).toMatchObject({ state: 'trial', actions: ['pause', 'remove'] });
    // A rejected candidate was never learned and is not listed.
    await fixture.procedures.reject(fixture.ownerId, spaceId, waiting.id, 'Not this one');
    const after = await app(fixture.ownerId)('GET', `/learned?space_id=${spaceId}`);
    expect((after.body.items ?? []).map((item) => item.id)).toEqual([trying.id]);
  }, 180000);

  test('pause, resume and remove change delivery, and undo restores exactly the last change', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const candidate = await onTrial(spaceId, 'surface-controls');
    const call = app(fixture.ownerId);
    expect(await delivered(spaceId, candidate.id)).toBe(true);
    const paused = await call('POST', `/learned/${candidate.id}/pause`, { space_id: spaceId });
    expect(paused.body.item).toMatchObject({ state: 'paused', actions: ['resume', 'remove'] });
    expect(paused.body.change).toMatchObject({ action: 'pause', name: 'Follow-up email' });
    expect(await delivered(spaceId, candidate.id)).toBe(false);
    const resumed = await call('POST', `/learned/${candidate.id}/resume`, { space_id: spaceId });
    expect(resumed.body.item).toMatchObject({ state: 'trial' });
    expect(await delivered(spaceId, candidate.id)).toBe(true);
    const removed = await call('POST', `/learned/${candidate.id}/remove`, { space_id: spaceId });
    expect(removed.body.item).toBeNull();
    expect(await delivered(spaceId, candidate.id)).toBe(false);
    const listed = await call('GET', `/learned?space_id=${spaceId}`);
    expect(listed.body.items).toEqual([]);
    expect(listed.body.last_change).toMatchObject({
      id: removed.body.change?.id,
      action: 'remove',
      item_id: candidate.id,
      name: 'Follow-up email',
    });
    // Nothing brings a removed procedure back but undo.
    await rejectsWith(
      () =>
        fixture.procedures.startTrial(fixture.ownerId, spaceId, candidate.id, candidate.bodyHash),
      'procedure_removed',
    );
    // Undo names the change the person saw: an older one is refused.
    const older = await call('POST', '/learned/undo', {
      space_id: spaceId,
      change_id: paused.body.change?.id,
    });
    expect(older).toMatchObject({ status: 409, body: { error: { code: 'undo_stale' } } });
    const undone = await call('POST', '/learned/undo', {
      space_id: spaceId,
      change_id: removed.body.change?.id,
    });
    expect(undone.status).toBe(200);
    expect(undone.body.item).toMatchObject({ id: candidate.id, state: 'trial' });
    expect(await delivered(spaceId, candidate.id)).toBe(true);
    // The latest change is now the resume, which undoes to paused.
    const next = await call('GET', `/learned?space_id=${spaceId}`);
    expect(next.body.last_change).toMatchObject({ action: 'resume' });
    await call('POST', '/learned/undo', {
      space_id: spaceId,
      change_id: next.body.last_change?.id,
    });
    expect((await candidateRow(candidate.id)).pausedAt).not.toBeNull();
    expect(await delivered(spaceId, candidate.id)).toBe(false);
  }, 180000);

  test('undo never overwrites what happened since, and undoing a no brings the trial back', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const candidate = await onTrial(spaceId, 'surface-undo');
    const call = app(fixture.ownerId);
    const paused = await call('POST', `/learned/${candidate.id}/pause`, { space_id: spaceId });
    // Something else moves it on: the pause can no longer be undone.
    await fixture.procedures.rollback(fixture.ownerId, spaceId, candidate.id, 'Stop it');
    const stale = await call('POST', '/learned/undo', {
      space_id: spaceId,
      change_id: paused.body.change?.id,
    });
    expect(stale).toMatchObject({ status: 409, body: { error: { code: 'undo_stale' } } });
    expect(await candidateRow(candidate.id)).toMatchObject({ state: 'reverted' });

    const second = await onTrial(spaceId, 'surface-undo-no');
    await usedIt(spaceId);
    const [question] = await questionsFor(second.id);
    const declined = await call('POST', `/learning/notices/${question?.id}/answer`, {
      space_id: spaceId,
      answer: 'no',
    });
    expect(declined.body.item).toMatchObject({ state: 'reverted' });
    const latest = await call('GET', `/learned?space_id=${spaceId}`);
    expect(latest.body.last_change).toMatchObject({ action: 'decline', item_id: second.id });
    const undone = await call('POST', '/learned/undo', {
      space_id: spaceId,
      change_id: latest.body.last_change?.id,
    });
    expect(undone.body.item).toMatchObject({ state: 'trial' });
    expect(await candidateRow(second.id)).toMatchObject({
      state: 'enabled_canary',
      rejectionReason: null,
      promotion: { basis: 'owner_trial' },
    });
    expect(await delivered(spaceId, second.id)).toBe(true);
    // Each undo is recorded as undone, so it cannot be applied twice.
    const changes = await fixture.handle.db
      .select()
      .from(learnedChange)
      .where(eq(learnedChange.candidateId, second.id));
    expect(changes.map((change) => [change.action, change.undoneAt !== null])).toEqual([
      ['decline', true],
    ]);
  }, 180000);

  test('another person sees none of it and can change none of it', async () => {
    if (!fixture) return;
    const memberId = newId('own');
    const spaceId = await sharedSpace(memberId);
    const candidate = await onTrial(spaceId, 'surface-member');
    await usedIt(spaceId);
    const [question] = await questionsFor(candidate.id);
    const member = app(memberId);
    for (const [method, path, body] of [
      ['GET', `/learned?space_id=${spaceId}`, undefined],
      ['GET', `/learning/notices?space_id=${spaceId}`, undefined],
      ['POST', `/learned/${candidate.id}/pause`, { space_id: spaceId }],
      ['POST', `/learning/notices/${question?.id}/answer`, { space_id: spaceId, answer: 'no' }],
    ] as const) {
      const response = await member(method, path, body);
      expect([method, path, response.status]).toEqual([method, path, 403]);
    }
    // The member's own jobs never receive the owner's trial.
    expect(await delivered(spaceId, candidate.id, memberId)).toBe(false);
    expect(await candidateRow(candidate.id)).toMatchObject({ state: 'enabled_canary' });
  }, 180000);
});
