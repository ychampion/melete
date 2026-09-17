import { afterAll, describe, expect, test } from 'bun:test';
import { desc, eq } from 'drizzle-orm';
import { appendEvent } from '../../src/events/store.ts';
import { CANARY_INTERVENTION } from '../../src/learning/canary.ts';
import { procedureCandidate, procedureTransition } from '../../src/learning/schema.ts';
import { selectProcedureSkills } from '../../src/learning/selection.ts';
import { publishRevision } from '../../src/memory/claims.ts';
import { lockSpace } from '../../src/memory/db.ts';
import { ingest } from '../../src/memory/evidence.ts';
import { rejectsWith, wake } from './learning-fixtures.ts';
import {
  CORRECTION,
  generalLearningFixture,
  messageProposal,
  SOURCE,
} from './learning-general-fixtures.ts';

const fixture = await generalLearningFixture();
afterAll(async () => {
  await fixture?.close();
}, 30000);

async function canary(
  spaceId: string,
  key: string,
  correction = CORRECTION,
  greeting = 'Hi there,',
) {
  if (!fixture) throw new Error('No fixture');
  const { episode } = await fixture.corrected(spaceId, key, SOURCE, correction);
  fixture.propose(messageProposal(correction, greeting));
  const candidate = await fixture.proposer.generate(fixture.ownerId, spaceId, episode.id);
  return fixture.evaluatedCanary(candidate);
}

const skillsFor = async (row: Awaited<ReturnType<NonNullable<typeof fixture>['create']>>) => {
  if (!fixture) throw new Error('No fixture');
  const claim = await fixture.runner.claim(wake(row));
  if (!claim) throw new Error('No claim');
  const names = claim.bundle.skills.map((skill) => skill.name);
  await fixture.jobs.cancel(row.id);
  return names;
};

(fixture ? describe : describe.skip)('trigger delivery, canary reverts and sharing', () => {
  test('a matching scope with no trigger match delivers nothing', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const candidate = await canary(spaceId, 'trigger-delivery');
    const name = `procedure:${candidate.id}`;
    // Same derived scope in the same space: only the trigger decides.
    expect(
      await skillsFor(await fixture.create(spaceId, 'Draft a follow-up email to the plumber')),
    ).toContain(name);
    expect(
      await skillsFor(await fixture.create(spaceId, 'Summarise the weekly project status report')),
    ).not.toContain(name);
    // The person's latest message counts as well as the objective.
    const asked = await fixture.create(spaceId, 'Answer the plumber');
    await fixture.jobs.transaction((tx) =>
      appendEvent(tx, {
        jobId: asked.id,
        type: 'notice',
        payload: { kind: 'user_message', text: 'Please make it a follow-up email.' },
        dedupKey: `${asked.id}:message`,
      }),
    );
    expect(await skillsFor(asked)).toContain(name);
    // A caller that supplies the latest message is taken at its word.
    const quiet = await fixture.create(spaceId, 'Answer the plumber');
    const model = { provider: 'fake', model: 'scripted-learning-v1', fallback: null };
    const explicit = await fixture.jobs.transaction((tx) =>
      selectProcedureSkills(tx, quiet, model, 'scripted-records/1', 'a follow-up email, please'),
    );
    expect(explicit.map((skill) => skill.name)).toEqual([name]);
    const none = await fixture.jobs.transaction((tx) =>
      selectProcedureSkills(tx, quiet, model, 'scripted-records/1', 'nothing relevant'),
    );
    expect(none).toEqual([]);
    await fixture.jobs.cancel(quiet.id);
  }, 120000);

  test('an owner intervention on a canary job reverts the candidate with a recorded reason', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const candidate = await canary(spaceId, 'canary-revert');
    const name = `procedure:${candidate.id}`;
    // A correction on a job the canary never reached leaves the canary alone.
    const unrelated = await fixture.create(spaceId, 'Summarise the weekly project status report');
    await fixture.run(unrelated);
    await fixture.episodes.intervene(fixture.ownerId, unrelated.id, {
      idempotency_key: 'unrelated-correction',
      kind: 'correction',
      text: 'Keep it under 30 words.',
    });
    const [untouched] = await fixture.handle.db
      .select()
      .from(procedureCandidate)
      .where(eq(procedureCandidate.id, candidate.id));
    expect(untouched?.state).toBe('enabled_canary');

    const delivered = await fixture.create(spaceId, 'Draft a follow-up email to the plumber');
    await fixture.run(delivered);
    const bundle = fixture.runtime.observed.find((entry) => entry.attempt.job_id === delivered.id);
    expect(bundle?.skills.map((skill) => skill.name)).toContain(name);
    const correction = await fixture.episodes.intervene(fixture.ownerId, delivered.id, {
      idempotency_key: 'canary-correction',
      kind: 'correction',
      text: 'That was still wrong.',
    });
    const [reverted] = await fixture.handle.db
      .select()
      .from(procedureCandidate)
      .where(eq(procedureCandidate.id, candidate.id));
    expect(reverted).toMatchObject({ state: 'reverted', rejectionReason: CANARY_INTERVENTION });
    const [last] = await fixture.handle.db
      .select()
      .from(procedureTransition)
      .where(eq(procedureTransition.candidateId, candidate.id))
      .orderBy(desc(procedureTransition.createdAt))
      .limit(1);
    expect(last).toMatchObject({ toState: 'reverted', actor: 'canary-monitor' });
    expect(last?.reason).toContain(correction.id);
    expect(
      await skillsFor(await fixture.create(spaceId, 'Draft a follow-up email to the builder')),
    ).not.toContain(name);
    // Rolling back what is already reverted stays a no-op.
    expect(
      (await fixture.procedures.rollback(fixture.ownerId, spaceId, candidate.id, 'Again')).state,
    ).toBe('reverted');
  }, 120000);

  test('a private contact name blocks space activation', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    await fixture.handle
      .sql`update space set kind = 'shared', audience = 'space', owner_principal_id = ${fixture.ownerId} where id = ${spaceId}`;
    await fixture.handle
      .sql`insert into space_membership (space_id, principal_id, role) values (${spaceId}, ${fixture.ownerId}, 'owner')`;
    const correction = 'Too formal. Use bullet points, and start with "Hi Priya," on its own line.';
    const candidate = await canary(spaceId, 'shared-name', correction, 'Hi Priya,');
    expect(candidate.body).toContain('Hi Priya,');
    const scope = {
      ownerId: fixture.ownerId,
      spaceId,
      publisher: 'owner',
      audience: 'private' as const,
      role: 'owner' as const,
    };
    const text = 'Priya prefers email at priya@example.test.';
    const accepted = await ingest(fixture.handle.sql, scope, {
      stream: 'chat',
      source_identity: 'contact-priya',
      source_version: '1',
      source_type: 'message',
      event_at: new Date().toISOString(),
      text,
    });
    const claim = await fixture.handle.sql.begin(async (tx) => {
      await lockSpace(tx, scope);
      return publishRevision(tx, scope, 'contact.priya.email', null, {
        content: 'priya@example.test',
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
    // A completed canary job, so activation reaches the sharing rule rather than stopping earlier.
    await fixture.run(await fixture.create(spaceId, 'Draft a follow-up email to the plumber'));
    let caught: unknown;
    try {
      await fixture.procedures.activate(fixture.ownerId, spaceId, candidate.id, 'space');
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'shareable_check_failed',
      message: 'shareable_check_failed:slug',
    });
    const [still] = await fixture.handle.db
      .select()
      .from(procedureCandidate)
      .where(eq(procedureCandidate.id, candidate.id));
    expect(still).toMatchObject({ state: 'enabled_canary', promotion: { scope: 'private' } });
    // The same body is shareable once the private claim is gone from memory.
    await fixture.handle.sql`update memory_claims set hidden = true where id = ${claim.claim_id}`;
    expect(
      (await fixture.procedures.activate(fixture.ownerId, spaceId, candidate.id, 'space'))
        .promotion,
    ).toMatchObject({ scope: 'space' });
    await rejectsWith(
      () => fixture.procedures.enableCanary(fixture.ownerId, spaceId, candidate.id),
      'promotion_denied',
    );
  }, 120000);
});
