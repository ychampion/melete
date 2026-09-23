/**
 * The whole journey from a chat to a lesson in use, as a person makes it: ask in
 * a conversation, get an answer, correct it, and see what the correction taught
 * applied to the next request, with the learning loop doing everything between.
 * Two ways of correcting are covered: a reply sent as a correction of the answer,
 * and the intervention route called on the conversation.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { ServiceError } from '../../src/api/errors.ts';
import { attempt, event } from '../../src/db/schema.ts';
import type { JobRow } from '../../src/jobs/service.ts';
import { SubmissionService } from '../../src/jobs/submissions.ts';
import { attachConversationCorrections } from '../../src/learning/conversation.ts';
import { learningModelCall } from '../../src/learning/proposal-schema.ts';
import { mountLearning } from '../../src/learning/routes.ts';
import { episode, procedureCandidate } from '../../src/learning/schema.ts';
import { applyLearned } from '../../src/learning/start.ts';
import { newId } from '../../src/memory/db.ts';
import { principalContext } from '../../src/principals/authority.ts';
import { wake } from './learning-fixtures.ts';
import {
  CORRECTION,
  generalLearningFixture,
  messageProposal,
} from './learning-general-fixtures.ts';

const fixture = await generalLearningFixture();
const submissions = fixture ? new SubmissionService(fixture.jobs) : null;
if (fixture && submissions) attachConversationCorrections(submissions, fixture.episodes);
afterAll(async () => {
  await fixture?.close();
}, 30000);

const ASK = 'Draft a follow-up email to the recruiter after the interview';
const LATER = 'Draft a follow-up email to the plumber about the leak';

async function say(jobId: string, text: string, corrects?: string) {
  if (!fixture || !submissions) throw new Error('No fixture');
  const service = submissions;
  const result = await principalContext.run(fixture.ownerId, () =>
    service.input(jobId, { text, ...(corrects ? { corrects } : {}) }, `sub_${newId('sub')}`),
  );
  expect(result.receipt.state).toBe('accepted');
}

/** A conversation the person starts by typing, as the chat surface records it. */
async function chat(spaceId: string, objective: string) {
  if (!fixture) throw new Error('No fixture');
  const row = await principalContext.run(fixture.ownerId, () =>
    fixture.jobs.transaction((tx) =>
      fixture.jobs.createInTransaction(
        tx,
        { space_id: spaceId, title: 'Chat', objective },
        { kind: 'chat' },
        'owner_request',
      ),
    ),
  );
  await say(row.id, objective);
  return row;
}

/** Runs the next turn to rest; returns the message id of its answer and the job's skills. */
async function turn(row: JobRow) {
  if (!fixture) throw new Error('No fixture');
  await fixture.runner.handleWake(wake(await fixture.jobs.get(row.id)));
  let current = await fixture.jobs.get(row.id);
  const deadline = Date.now() + 15000;
  while (['queued', 'running'].includes(current.state) && Date.now() < deadline) {
    await Bun.sleep(20);
    current = await fixture.jobs.get(row.id);
  }
  expect(current.state).toBe('waiting_for_input');
  const [latest] = await fixture.handle.db
    .select({ id: attempt.id })
    .from(attempt)
    .where(eq(attempt.jobId, row.id))
    .orderBy(desc(attempt.epoch))
    .limit(1);
  const [answer] = await fixture.handle.db
    .select({ seq: event.seq })
    .from(event)
    .where(and(eq(event.jobId, row.id), eq(event.attemptId, latest?.id ?? '')))
    .orderBy(desc(event.seq))
    .limit(1);
  if (!answer) throw new Error('No answer');
  return String(answer.seq);
}

/** The skills a new request in the space would be given. */
async function skillsFor(spaceId: string, objective: string) {
  if (!fixture) throw new Error('No fixture');
  const row = await fixture.create(spaceId, objective);
  const claim = await fixture.runner.claim(wake(row));
  const names = claim?.bundle.skills.map((skill) => skill.name) ?? [];
  await fixture.jobs.cancel(row.id);
  return names;
}

/** After the correction: judged by the next turn, proposed and tried by the loop. */
async function learnedFrom(spaceId: string, row: JobRow) {
  if (!fixture) throw new Error('No fixture');
  const [pending] = await fixture.handle.db
    .select()
    .from(episode)
    .where(and(eq(episode.jobId, row.id), isNotNull(episode.intervention)));
  expect(pending).toMatchObject({ judgement: 'pending', actor: fixture.ownerId });
  // The conversation answers the correction; that answer is what judges it.
  await turn(row);
  const [judged] = await fixture.handle.db
    .select()
    .from(episode)
    .where(eq(episode.id, pending?.id ?? ''));
  expect(judged).toMatchObject({ judgement: 'corrected', intervention: { text: CORRECTION } });
  expect(judged?.priorOutput).toBeTruthy();
  expect(judged?.correctedOutput).toBeTruthy();
  // The learning loop, as the service runs it: propose, then put it to work.
  fixture.propose(messageProposal());
  const tried = await applyLearned(fixture.proposer, fixture.procedures);
  const [call] = await fixture.handle.db
    .select()
    .from(learningModelCall)
    .where(eq(learningModelCall.episodeId, judged?.id ?? ''));
  expect(call?.errorCode ?? null).toBeNull();
  const lesson = tried.find((candidate) => candidate.episodeId === judged?.id);
  expect(lesson).toMatchObject({
    state: 'enabled_canary',
    canarySpaceId: spaceId,
    promotion: { basis: 'owner_trial', principal_id: fixture.ownerId },
  });
  if (!lesson) throw new Error('Nothing was tried');
  // The next similar request receives it; an unrelated one does not.
  expect(await skillsFor(spaceId, LATER)).toContain(`procedure:${lesson.id}`);
  expect(await skillsFor(spaceId, 'Summarise the weekly status report')).not.toContain(
    `procedure:${lesson.id}`,
  );
  const [stored] = await fixture.handle.db
    .select()
    .from(procedureCandidate)
    .where(eq(procedureCandidate.id, lesson.id));
  return stored;
}

(fixture ? describe : describe.skip)('from a chat to a lesson in use', () => {
  test('a reply sent as a correction of the answer becomes a lesson the next request uses', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const row = await chat(spaceId, ASK);
    const answer = await turn(row);
    await say(row.id, CORRECTION, answer);
    expect(await learnedFrom(spaceId, row)).toBeTruthy();
  }, 180000);

  test('a correction through the intervention route on a conversation becomes one too', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const row = await chat(spaceId, ASK);
    await turn(row);
    const app = new Hono();
    app.onError((error, c) => {
      if (error instanceof ServiceError)
        return c.json({ error: { code: error.code, message: error.message } }, error.status);
      throw error;
    });
    app.use('*', async (c, next) => {
      c.set('owner', {
        id: fixture.ownerId,
        email: `${fixture.ownerId}@example.test`,
        created_at: new Date().toISOString(),
      });
      await next();
    });
    mountLearning(app, fixture.episodes);
    const response = await app.request(`/jobs/${row.id}/interventions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotency_key: 'journey', kind: 'correction', text: CORRECTION }),
    });
    expect(response.status).toBe(201);
    // A conversation is not finished work: the correction continues it rather than
    // opening a corrective job beside it.
    const { episode: recorded } = (await response.json()) as {
      episode: { correctiveJobId: string | null };
    };
    expect(recorded.correctiveJobId ?? null).toBeNull();
    expect(await learnedFrom(spaceId, row)).toBeTruthy();
  }, 180000);
});
