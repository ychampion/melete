import { afterAll, describe, expect, test } from 'bun:test';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { CANARY_INTERVENTION } from '../../src/learning/canary.ts';
import { mountProcedures } from '../../src/learning/procedure-routes.ts';
import { episode, procedureCandidate, procedureTransition } from '../../src/learning/schema.ts';
import { newId } from '../../src/memory/db.ts';
import { principalContext } from '../../src/principals/authority.ts';
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

/** A candidate with no checks: nothing a check could read, so discrimination is `none`. */
async function uncheckedCandidate(spaceId: string, key: string) {
  if (!fixture) throw new Error('No fixture');
  const { episode } = await fixture.corrected(spaceId, key, SOURCE, CORRECTION);
  fixture.propose({ ...messageProposal(), checks: [] });
  const candidate = await fixture.proposer.generate(fixture.ownerId, spaceId, episode.id);
  expect(candidate.discrimination?.status).toBe('none');
  return candidate;
}

async function skillsFor(spaceId: string, objective: string, principal?: string) {
  if (!fixture) throw new Error('No fixture');
  const row = await fixture.create(spaceId, objective, principal ?? fixture.ownerId);
  const claim = await fixture.runner.claim(wake(row));
  const names = claim?.bundle.skills.map((skill) => skill.name) ?? [];
  await fixture.jobs.cancel(row.id);
  return names;
}

async function sharedSpace(withMember = false) {
  if (!fixture) throw new Error('No fixture');
  const spaceId = await fixture.createSpace();
  await fixture.handle
    .sql`update space set kind = 'shared', audience = 'space', owner_principal_id = ${fixture.ownerId} where id = ${spaceId}`;
  await fixture.handle
    .sql`insert into space_membership (space_id, principal_id, role) values (${spaceId}, ${fixture.ownerId}, 'owner')`;
  if (!withMember) return { spaceId, memberId: null };
  const memberId = newId('own');
  await fixture.handle
    .sql`insert into principal (id, email) values (${memberId}, ${`${memberId}@example.test`})`;
  await fixture.handle
    .sql`insert into space_membership (space_id, principal_id, role) values (${spaceId}, ${memberId}, 'member')`;
  return { spaceId, memberId };
}

(fixture ? describe : describe.skip)('the owner trial', () => {
  test('an owner trial binds the exact definition and delivers only to that owner in the origin space', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const candidate = await uncheckedCandidate(spaceId, 'trial-binds');
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('owner', {
        id: fixture.ownerId,
        email: 'owner@example.test',
        created_at: new Date().toISOString(),
      });
      await next();
    });
    mountProcedures(app, fixture.procedures);
    const response = await app.request(`/procedures/${candidate.id}/trial`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ space_id: spaceId, definition_hash: candidate.bodyHash }),
    });
    expect(response.status).toBe(200);
    const { candidate: trial } = (await response.json()) as {
      candidate: typeof candidate & { promotion: Record<string, unknown> };
    };
    expect(trial).toMatchObject({
      state: 'enabled_canary',
      canarySpaceId: spaceId,
      promotion: {
        scope: 'private',
        principal_id: fixture.ownerId,
        basis: 'owner_trial',
        definition_hash: candidate.bodyHash,
      },
    });
    const [transition] = await fixture.handle.db
      .select()
      .from(procedureTransition)
      .where(eq(procedureTransition.candidateId, candidate.id))
      .orderBy(desc(procedureTransition.createdAt))
      .limit(1);
    expect(transition).toMatchObject({ toState: 'enabled_canary', actor: fixture.ownerId });
    const name = `procedure:${candidate.id}`;
    expect(await skillsFor(spaceId, 'Draft a follow-up email to the plumber')).toContain(name);
    expect(await skillsFor(spaceId, 'Summarise the weekly project status report')).not.toContain(
      name,
    );
    const elsewhere = await fixture.createSpace();
    expect(await skillsFor(elsewhere, 'Draft a follow-up email to the plumber')).not.toContain(
      name,
    );
    const open = await principalContext.run(fixture.ownerId, () =>
      fixture.jobs.create({
        space_id: spaceId,
        title: 'Public',
        objective: 'Draft a follow-up email to the plumber',
        constraints: { public_compartment: true },
      }),
    );
    const openClaim = await fixture.runner.claim(wake(open));
    expect(openClaim?.bundle.skills.map((skill) => skill.name)).not.toContain(name);
    await fixture.jobs.cancel(open.id);
    // The approval names bytes: once it names different ones, nothing is delivered.
    await fixture.handle.db
      .update(procedureCandidate)
      .set({ promotion: { ...trial.promotion, definition_hash: 'f'.repeat(64) } })
      .where(eq(procedureCandidate.id, candidate.id));
    expect(await skillsFor(spaceId, 'Draft a follow-up email to the plumber')).not.toContain(name);
    await fixture.handle.db
      .update(procedureCandidate)
      .set({ promotion: trial.promotion })
      .where(eq(procedureCandidate.id, candidate.id));
    expect(await skillsFor(spaceId, 'Draft a follow-up email to the plumber')).toContain(name);
    // The trial is bound to its origin space as well as to the candidate's own.
    await fixture.handle.db
      .update(procedureCandidate)
      .set({ canarySpaceId: elsewhere })
      .where(eq(procedureCandidate.id, candidate.id));
    expect(await skillsFor(spaceId, 'Draft a follow-up email to the plumber')).not.toContain(name);
    await fixture.handle.db
      .update(procedureCandidate)
      .set({ canarySpaceId: spaceId })
      .where(eq(procedureCandidate.id, candidate.id));
    expect(await skillsFor(spaceId, 'Draft a follow-up email to the plumber')).toContain(name);
  }, 120000);

  test('an owner trial with a stale definition hash is refused', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const candidate = await uncheckedCandidate(spaceId, 'trial-stale');
    await rejectsWith(
      () => fixture.procedures.startTrial(fixture.ownerId, spaceId, candidate.id, 'a'.repeat(64)),
      'definition_hash_mismatch',
    );
    const [unchanged] = await fixture.handle.db
      .select()
      .from(procedureCandidate)
      .where(eq(procedureCandidate.id, candidate.id));
    expect(unchanged).toMatchObject({ state: 'candidate', canarySpaceId: null });
    expect(await skillsFor(spaceId, 'Draft a follow-up email to the plumber')).not.toContain(
      `procedure:${candidate.id}`,
    );
    // A rejected candidate cannot be tried either, even with its current hash.
    await fixture.procedures.reject(fixture.ownerId, spaceId, candidate.id, 'Not this one');
    await rejectsWith(
      () =>
        fixture.procedures.startTrial(fixture.ownerId, spaceId, candidate.id, candidate.bodyHash),
      'invalid_procedure_state',
    );
  }, 120000);

  test('a member of a shared space cannot start or receive an owner trial', async () => {
    if (!fixture) return;
    const { spaceId, memberId } = await sharedSpace(true);
    if (!memberId) throw new Error('No member');
    const candidate = await uncheckedCandidate(spaceId, 'trial-member');
    await rejectsWith(
      () => fixture.procedures.startTrial(memberId, spaceId, candidate.id, candidate.bodyHash),
      'scope_denied',
    );
    await fixture.procedures.startTrial(fixture.ownerId, spaceId, candidate.id, candidate.bodyHash);
    const name = `procedure:${candidate.id}`;
    expect(await skillsFor(spaceId, 'Draft a follow-up email to the plumber')).toContain(name);
    expect(
      await skillsFor(spaceId, 'Draft a follow-up email to the plumber', memberId),
    ).not.toContain(name);
    // Nor can the space owner try what someone else's correction taught.
    const borrowed = await uncheckedCandidate(spaceId, 'trial-borrowed');
    await fixture.handle.db
      .update(episode)
      .set({ actor: memberId })
      .where(eq(episode.id, borrowed.episodeId));
    await rejectsWith(
      () => fixture.procedures.startTrial(fixture.ownerId, spaceId, borrowed.id, borrowed.bodyHash),
      'trial_denied',
    );
  }, 120000);

  test('an owner trial cannot be activated for a space without sealed final evidence', async () => {
    if (!fixture) return;
    const { spaceId } = await sharedSpace();
    const candidate = await uncheckedCandidate(spaceId, 'trial-activate');
    await fixture.procedures.startTrial(fixture.ownerId, spaceId, candidate.id, candidate.bodyHash);
    // A clean trial job exists, so only the missing evaluation stands in the way.
    await fixture.run(await fixture.create(spaceId, 'Draft a follow-up email to the plumber'));
    for (const scope of ['space', 'private'] as const)
      await rejectsWith(
        () => fixture.procedures.activate(fixture.ownerId, spaceId, candidate.id, scope),
        'promotion_denied',
      );
    const [still] = await fixture.handle.db
      .select()
      .from(procedureCandidate)
      .where(eq(procedureCandidate.id, candidate.id));
    expect(still).toMatchObject({
      state: 'enabled_canary',
      promotion: { scope: 'private', basis: 'owner_trial' },
    });
  }, 120000);

  test('an owner intervention during an owner trial reverts it', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const candidate = await uncheckedCandidate(spaceId, 'trial-revert');
    await fixture.procedures.startTrial(fixture.ownerId, spaceId, candidate.id, candidate.bodyHash);
    const tried = await fixture.create(spaceId, 'Draft a follow-up email to the plumber');
    await fixture.run(tried);
    await fixture.episodes.intervene(fixture.ownerId, tried.id, {
      idempotency_key: 'trial-correction',
      kind: 'correction',
      text: 'No, not like that.',
    });
    const [reverted] = await fixture.handle.db
      .select()
      .from(procedureCandidate)
      .where(eq(procedureCandidate.id, candidate.id));
    expect(reverted).toMatchObject({ state: 'reverted', rejectionReason: CANARY_INTERVENTION });
    expect(await skillsFor(spaceId, 'Draft a follow-up email to the builder')).not.toContain(
      `procedure:${candidate.id}`,
    );
  }, 120000);
});
