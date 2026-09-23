import { afterAll, describe, expect, test } from 'bun:test';
import { THUMBS_DOWN, THUMBS_UP } from '@melete/contracts';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { attempt, event } from '../../src/db/schema.ts';
import { ReactionService } from '../../src/jobs/reactions.ts';
import { ReplyService } from '../../src/jobs/replies.ts';
import type { JobRow } from '../../src/jobs/service.ts';
import { SubmissionService } from '../../src/jobs/submissions.ts';
import {
  attachConversationCorrections,
  PAIRING_WINDOW_MS,
} from '../../src/learning/conversation.ts';
import { episode } from '../../src/learning/schema.ts';
import { newId } from '../../src/memory/db.ts';
import { principalContext } from '../../src/principals/authority.ts';
import { wake } from './learning-fixtures.ts';
import {
  CORRECTION,
  generalLearningFixture,
  messageProposal,
  SOURCE,
} from './learning-general-fixtures.ts';

const fixture = await generalLearningFixture();
const submissions = fixture ? new SubmissionService(fixture.jobs) : null;
const reactions = fixture ? new ReactionService(fixture.jobs) : null;
if (fixture && submissions) {
  attachConversationCorrections(submissions, fixture.episodes);
  // Constructed afterwards, as the service does at boot: it must add to the
  // accepted-input chain, never replace what learning attached first.
  new ReplyService(fixture.jobs, submissions);
}
afterAll(async () => {
  await fixture?.close();
}, 30000);

/** A conversation, as the chat surface creates one, and the person's first message. */
async function conversation(spaceId: string, principal?: string) {
  if (!fixture) throw new Error('No fixture');
  const row = await principalContext.run(principal ?? fixture.ownerId, () =>
    fixture.jobs.transaction((tx) =>
      fixture.jobs.createInTransaction(
        tx,
        { space_id: spaceId, title: 'Chat', objective: SOURCE },
        { kind: 'chat' },
        // What the chat surface records for a conversation the person started by typing.
        'owner_request',
      ),
    ),
  );
  await say(row.id, SOURCE, { principal });
  return row;
}

/** Runs the job's next turn to rest and returns the message id of the answer it gave. */
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
  // An answer is an event its attempt wrote; the attempt's end carries its output.
  const [answer] = await fixture.handle.db
    .select({ seq: event.seq })
    .from(event)
    .where(and(eq(event.jobId, row.id), eq(event.attemptId, latest?.id ?? '')))
    .orderBy(desc(event.seq))
    .limit(1);
  if (!answer) throw new Error('No answer to react to');
  return String(answer.seq);
}

/** What the person does: a glyph on the answer. */
async function react(spaceId: string, answer: string, emoji: string, principal?: string) {
  if (!fixture || !reactions) throw new Error('No fixture');
  const service = reactions;
  const who = principal ?? fixture.ownerId;
  await principalContext.run(who, () =>
    service.add({ spaceId, principalId: who }, answer, { emoji, by: 'person' }),
  );
}

async function say(
  jobId: string,
  text: string,
  options: { principal?: string; corrects?: string; key?: string } = {},
) {
  if (!fixture || !submissions) throw new Error('No fixture');
  const service = submissions;
  return principalContext.run(options.principal ?? fixture.ownerId, () =>
    service.input(
      jobId,
      { text, ...(options.corrects ? { corrects: options.corrects } : {}) },
      options.key ?? `sub_${newId('sub')}`,
    ),
  );
}

const corrections = async (jobId: string) => {
  if (!fixture) throw new Error('No fixture');
  return fixture.handle.db
    .select()
    .from(episode)
    .where(and(eq(episode.jobId, jobId), isNotNull(episode.intervention)));
};

(fixture ? describe : describe.skip)('a correction made in the conversation', () => {
  test('a thumbs-down and the message that follows it become a correction', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const row = await conversation(spaceId);
    const answer = await turn(row);
    await react(spaceId, answer, THUMBS_DOWN);
    const receipt = await say(row.id, CORRECTION);
    expect(receipt.receipt.state).toBe('accepted');
    const [recorded] = await corrections(row.id);
    expect(recorded).toMatchObject({
      actor: fixture.ownerId,
      judgement: 'pending',
      intervention: { kind: 'correction', text: CORRECTION },
    });
    expect(recorded?.segmentKey).toMatch(/^intervention:conversation:[0-9]+$/);
    // The message the person sent is on the stream once, not twice.
    const messages = await fixture.handle.db
      .select()
      .from(event)
      .where(and(eq(event.jobId, row.id), eq(event.type, 'notice')));
    expect(
      messages.filter((entry) => (entry.payload as { text?: string }).text === CORRECTION),
    ).toHaveLength(1);
  }, 120000);

  test('a reply sent as a correction of the latest answer is a correction without a thumbs-down', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const row = await conversation(spaceId);
    const answer = await turn(row);
    await say(row.id, CORRECTION, { corrects: answer });
    const [recorded] = await corrections(row.id);
    expect(recorded?.intervention).toMatchObject({ kind: 'correction', text: CORRECTION });
    // What the person said it corrects is recorded on their message, as they sent it.
    const [sent] = await fixture.handle.db
      .select({ payload: event.payload })
      .from(event)
      .where(
        and(
          eq(event.jobId, row.id),
          eq(event.type, 'notice'),
          eq(event.dedupKey, `${row.id}:input:${(await fixture.jobs.get(row.id)).stateVersion}`),
        ),
      );
    expect(sent?.payload).toMatchObject({ kind: 'user_message', corrects: answer });
  }, 120000);

  test('a message with nothing marked wrong before it is not a correction', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const row = await conversation(spaceId);
    await turn(row);
    await say(row.id, 'Now send the same thing to the plumber.');
    expect(await corrections(row.id)).toHaveLength(0);
    // A thumbs-up is not a complaint either.
    const next = await turn(row);
    await react(spaceId, next, THUMBS_UP);
    await say(row.id, 'Now the dentist too.');
    expect(await corrections(row.id)).toHaveLength(0);
  }, 120000);

  test('only the message that follows the thumbs-down is the correction', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const row = await conversation(spaceId);
    const answer = await turn(row);
    await react(spaceId, answer, THUMBS_DOWN);
    await say(row.id, CORRECTION);
    await turn(row);
    await say(row.id, 'And send it before five.');
    const recorded = await corrections(row.id);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.intervention?.text).toBe(CORRECTION);
  }, 120000);

  test('marking an earlier answer corrects nothing, because what is recorded as wrong is the latest', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const row = await conversation(spaceId);
    const first = await turn(row);
    await say(row.id, 'Now the dentist too.');
    await turn(row);
    await react(spaceId, first, THUMBS_DOWN);
    await say(row.id, CORRECTION);
    expect(await corrections(row.id)).toHaveLength(0);
    await turn(row);
    await say(row.id, CORRECTION, { corrects: first });
    expect(await corrections(row.id)).toHaveLength(0);
  }, 120000);

  test('a correction is recorded once however often the message is resent', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const row = await conversation(spaceId);
    const answer = await turn(row);
    await react(spaceId, answer, THUMBS_DOWN);
    const key = `sub_${newId('sub')}`;
    for (let attempt = 0; attempt < 2; attempt += 1) await say(row.id, CORRECTION, { key });
    expect(await corrections(row.id)).toHaveLength(1);
  }, 120000);

  test('a member of a shared space corrects nothing, and their message still lands', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    await fixture.handle
      .sql`update space set kind = 'shared', audience = 'space', owner_principal_id = ${fixture.ownerId} where id = ${spaceId}`;
    await fixture.handle
      .sql`insert into space_membership (space_id, principal_id, role) values (${spaceId}, ${fixture.ownerId}, 'owner')`;
    const memberId = newId('own');
    await fixture.handle
      .sql`insert into principal (id, email) values (${memberId}, ${`${memberId}@example.test`})`;
    await fixture.handle
      .sql`insert into space_membership (space_id, principal_id, role) values (${spaceId}, ${memberId}, 'member')`;
    const row = await conversation(spaceId, memberId);
    const answer = await turn(row);
    await react(spaceId, answer, THUMBS_DOWN, memberId);
    const receipt = await say(row.id, CORRECTION, { principal: memberId });
    expect(receipt.receipt.state).toBe('accepted');
    expect(await corrections(row.id)).toHaveLength(0);
  }, 120000);

  test('a member replying to the owner’s latest answer as a correction corrects nothing', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    await fixture.handle
      .sql`update space set kind = 'shared', audience = 'space', owner_principal_id = ${fixture.ownerId} where id = ${spaceId}`;
    await fixture.handle
      .sql`insert into space_membership (space_id, principal_id, role) values (${spaceId}, ${fixture.ownerId}, 'owner')`;
    const memberId = newId('own');
    await fixture.handle
      .sql`insert into principal (id, email) values (${memberId}, ${`${memberId}@example.test`})`;
    await fixture.handle
      .sql`insert into space_membership (space_id, principal_id, role) values (${spaceId}, ${memberId}, 'member')`;
    // The owner's own conversation: the speaker, not the job's owner, decides whose words these are.
    const row = await conversation(spaceId);
    const answer = await turn(row);
    await say(row.id, CORRECTION, { principal: memberId, corrects: answer });
    expect(await corrections(row.id)).toHaveLength(0);
  }, 120000);

  test('a message long after the thumbs-down is a new request, not its answer', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const row = await conversation(spaceId);
    const answer = await turn(row);
    await react(spaceId, answer, THUMBS_DOWN);
    // The thumbs-down was left in an earlier sitting.
    await fixture.handle
      .sql`update event set created_at = created_at - ${`${PAIRING_WINDOW_MS + 60_000} milliseconds`}::interval
        where job_id = ${row.id} and type = 'reaction'`;
    await say(row.id, CORRECTION);
    expect(await corrections(row.id)).toHaveLength(0);
  }, 120000);

  test('a job learning does not follow teaches nothing', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const row = await conversation(spaceId);
    const answer = await turn(row);
    // A job with no learning registration is one learning does not follow.
    await fixture.handle.sql`delete from learning_job where job_id = ${row.id}`;
    await react(spaceId, answer, THUMBS_DOWN);
    await say(row.id, CORRECTION);
    expect(await corrections(row.id)).toHaveLength(0);
  }, 120000);

  test('a conversation correction reaches the proposal pipeline with the answer it marked', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const row = await conversation(spaceId);
    const answer = await turn(row);
    const [marked] = await fixture.handle.db
      .select({ outcome: attempt.outcomeDetail })
      .from(attempt)
      .where(eq(attempt.jobId, row.id))
      .orderBy(desc(attempt.epoch))
      .limit(1);
    await react(spaceId, answer, THUMBS_DOWN);
    await say(row.id, CORRECTION);
    // The next turn answers the correction, and that is what judges the episode.
    await turn(row);
    const [judged] = await corrections(row.id);
    expect(judged?.judgement).toBe('corrected');
    const wrong = (marked?.outcome as { summary?: string } | undefined)?.summary;
    expect(wrong).toBeTruthy();
    expect(judged?.priorOutput).toBe(wrong ?? '');
    expect(judged?.correctedOutput).toBeTruthy();
    expect(judged?.correctedOutput).not.toBe(judged?.priorOutput);
    if (!judged) throw new Error('No episode');
    fixture.propose(messageProposal());
    const candidate = await fixture.proposer.generate(fixture.ownerId, spaceId, judged.id);
    expect(candidate).toMatchObject({ episodeId: judged.id, state: 'candidate' });
    expect(candidate.rejectionReason).toBeNull();
  }, 120000);
});
