import { afterAll, describe, expect, test } from 'bun:test';
import { estimateTokens } from '@melete/skills';
import { eq } from 'drizzle-orm';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { RuntimeCatalog } from '../../src/knowledge/catalog.ts';
import { CANARY_INTERVENTION } from '../../src/learning/canary.ts';
import { ENGINE_SKILL_TOKENS } from '../../src/learning/engine-scan.ts';
import { bodyDigest } from '../../src/learning/engine-skills.ts';
import { definitionHash } from '../../src/learning/procedure.ts';
import { restrictEpisodes } from '../../src/learning/retention.ts';
import { procedureCandidate } from '../../src/learning/schema.ts';
import { MAX_DELIVERED_SKILLS, RESERVED_CATALOG_SLOTS } from '../../src/learning/selection.ts';
import { newId } from '../../src/memory/db.ts';
import {
  DIGEST_BODY,
  engineSkillFixture,
  externalItem,
  ownerItem,
} from './engine-skill-fixtures.ts';
import { rejectsWith, wake } from './learning-fixtures.ts';

const fixture = await engineSkillFixture();
afterAll(async () => {
  await fixture?.close();
}, 30000);

const skill = (name: string, body = DIGEST_BODY) => ({
  name,
  description: 'Write the weekly digest.',
  body,
});

const stored = async (id: string) => {
  if (!fixture) throw new Error('No fixture');
  const [row] = await fixture.handle.db
    .select()
    .from(procedureCandidate)
    .where(eq(procedureCandidate.id, id));
  if (!row) throw new Error('No skill row');
  return row;
};

const WEEKLY_NOTES_BODY = '# Weekly notes\n\n1. Keep one line per task.\n2. Mark what is done.';
const COVER_LETTER_BODY = '# Cover letters\n\n1. Open with the role.\n2. Keep it to one page.';
const MONTHLY_BODY = '# Monthly digest\n\n1. Keep the month under 300 words.';

/** A prohibition holds for its person in every space, so a test lifts what it placed. */
async function liftAll() {
  if (!fixture) return;
  const spaceId = await fixture.createSpace();
  for (const row of await fixture.engine.prohibitions(fixture.ownerId, spaceId))
    await fixture.engine.lift(fixture.ownerId, spaceId, row.id);
}

/** A live engine skill written by a clean-origin job of this owner. */
async function liveSkill(
  spaceId: string,
  name: string,
  items = [ownerItem()],
  body = DIGEST_BODY,
  extra: { description?: string } = {},
) {
  if (!fixture) throw new Error('No fixture');
  const writer = await fixture.writing(spaceId, { items });
  const admission = await fixture.engine.intake(writer.claims, {
    ...skill(name, body),
    ...extra,
  });
  expect(admission.state).toBe('live');
  return { ...admission, writer, claimId: items[0]?.claim_id ?? '' };
}

(fixture ? describe : describe.skip)('delivering and ending an engine-written skill', () => {
  test('pausing an engine skill stops delivery at the next attempt', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const live = await liveSkill(spaceId, 'weekly-digest');
    expect(await fixture.deliveredTo(spaceId, 'Write up this week')).toEqual(['weekly-digest']);
    const paused = await fixture.engine.pause(fixture.ownerId, spaceId, live.candidateId);
    expect(paused.state).toBe('paused');
    expect(await fixture.deliveredTo(spaceId, 'Write up this week')).toEqual([]);
    expect(await stored(live.candidateId)).toMatchObject({ state: 'enabled_canary' });
    const resumed = await fixture.engine.resume(fixture.ownerId, spaceId, live.candidateId);
    expect(resumed.state).toBe('live');
    expect(await fixture.deliveredTo(spaceId, 'Write up this week')).toEqual(['weekly-digest']);
    // Deleting it stops delivery and leaves nothing of the body behind.
    const deleted = await fixture.engine.remove(fixture.ownerId, spaceId, live.candidateId);
    expect(deleted).toMatchObject({ state: 'reverted', reason: 'owner_deleted', body: '' });
    expect(await fixture.deliveredTo(spaceId, 'Write up this week')).toEqual([]);
    expect(await stored(live.candidateId)).toMatchObject({ body: '', description: '' });
  }, 180000);

  test('an owner intervention reverts a live engine skill', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const live = await liveSkill(spaceId, 'weekly-digest');
    const tried = await fixture.create(spaceId, 'Write up this week');
    await fixture.run(tried);
    const delivered = fixture.runtime.observed.find((bundle) => bundle.attempt.job_id === tried.id);
    expect(delivered?.skills.map((entry) => entry.name)).toEqual(['weekly-digest']);
    await fixture.episodes.intervene(fixture.ownerId, tried.id, {
      idempotency_key: 'engine-correction',
      kind: 'correction',
      text: 'No, not like that.',
    });
    expect(await stored(live.candidateId)).toMatchObject({
      state: 'reverted',
      rejectionReason: CANARY_INTERVENTION,
    });
    expect(await fixture.deliveredTo(spaceId, 'Write up this week')).toEqual([]);
    // A skill nobody objected to is untouched by that correction.
    const other = await liveSkill(spaceId, 'monthly-digest');
    const quiet = await fixture.create(spaceId, 'Write up the month');
    await fixture.run(quiet);
    await fixture.episodes.intervene(fixture.ownerId, tried.id, {
      idempotency_key: 'engine-correction-two',
      kind: 'correction',
      text: 'Still not like that.',
    });
    expect(await stored(other.candidateId)).toMatchObject({ state: 'enabled_canary' });
  }, 180000);

  test('an engine skill cannot be shared to a space without sealed final evidence', async () => {
    if (!fixture) return;
    const { spaceId, memberId } = await fixture.sharedSpace(true);
    if (!memberId) throw new Error('No member');
    const live = await liveSkill(spaceId, 'weekly-digest');
    // Activation is the correction road: an engine skill has no correction behind it,
    // so there it reads as absent, whichever scope is asked for.
    for (const scope of ['space', 'private'] as const)
      await rejectsWith(
        () => fixture.procedures.activate(fixture.ownerId, spaceId, live.candidateId, scope),
        'not_found',
      );
    expect(await stored(live.candidateId)).toMatchObject({
      state: 'enabled_canary',
      promotion: { scope: 'private', basis: 'engine_live' },
    });
    // Still private to its owner: the other member of the shared space receives nothing.
    expect(await fixture.deliveredTo(spaceId, 'Write up this week', memberId)).toEqual([]);
    expect(await fixture.deliveredTo(spaceId, 'Write up this week')).toEqual(['weekly-digest']);
    // The correction road is closed to it as well, in either direction.
    const current = await stored(live.candidateId);
    for (const action of [
      () => fixture.procedures.enableCanary(fixture.ownerId, spaceId, live.candidateId),
      () =>
        fixture.procedures.startTrial(fixture.ownerId, spaceId, live.candidateId, current.bodyHash),
    ])
      await rejectsWith(action, 'invalid_procedure_state');
  }, 180000);

  test('forgetting the inputs of the job that wrote an engine skill restricts it', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const item = ownerItem();
    const live = await liveSkill(spaceId, 'weekly-digest', [item]);
    expect((await stored(live.candidateId)).inputRefs).toContain(item.handle);
    expect(await fixture.deliveredTo(spaceId, 'Write up this week')).toEqual(['weekly-digest']);
    await fixture.handle.sql.begin(async (tx) =>
      restrictEpisodes(
        tx,
        {
          id: newId('sup'),
          owner_id: fixture.ownerId,
          space_id: spaceId,
          operation: 'forget',
          all: false,
          claim_ids: [item.claim_id],
          targets: [],
          eligibility_cutoff: 0,
          access_generation: 1,
          recorded_at: new Date().toISOString(),
        },
        [item.claim_id],
      ),
    );
    expect(await stored(live.candidateId)).toMatchObject({
      state: 'reverted',
      rejectionReason: 'inputs_forgotten',
      body: '',
      inputRefs: [],
    });
    expect(await fixture.deliveredTo(spaceId, 'Write up this week')).toEqual([]);
    expect(await fixture.engine.list(fixture.ownerId, spaceId)).toMatchObject([
      { state: 'reverted', reason: 'inputs_forgotten', body: '' },
    ]);
  }, 180000);

  test('a later attempt writing the same skill name supersedes the earlier one', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const first = await liveSkill(spaceId, 'weekly-digest');
    const writer = await fixture.writing(spaceId, { items: [ownerItem()] });
    const second = await fixture.engine.intake(writer.claims, {
      name: 'weekly-digest',
      description: 'Write the weekly digest.',
      body: `${DIGEST_BODY}\n4. Name the owner of each decision.`,
    });
    expect(second.state).toBe('live');
    expect(await stored(first.candidateId)).toMatchObject({ state: 'superseded' });
    // One file under that name, and it is the newer text.
    const row = await fixture.create(spaceId, 'Write up this week');
    const claim = await fixture.runner.claim(wake(row));
    expect(claim?.bundle.skills.map((entry) => entry.name)).toEqual(['weekly-digest']);
    expect(claim?.bundle.skills[0]?.body).toContain('Name the owner of each decision.');
    await fixture.jobs.cancel(row.id);
  }, 180000);

  test('engine skills never take the last skill slot in a bundle', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    for (const name of ['weekly-digest', 'monthly-digest', 'quarterly-digest'])
      await liveSkill(spaceId, name);
    // Three are live; the bundle merges these ahead of the catalog skills a job’s own
    // words select, so one slot stays for those however many the engine has written.
    const delivered = await fixture.deliveredTo(spaceId, 'Write up this week');
    expect(delivered).toHaveLength(MAX_DELIVERED_SKILLS - RESERVED_CATALOG_SLOTS);
    expect(delivered).toEqual(['quarterly-digest', 'monthly-digest']);
  }, 180000);

  test('a skill past the per-skill budget is held, and one far past it is refused', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const sentence = (count: number) =>
      Array.from({ length: count }, () => 'Keep the digest short and plain.').join(' ');
    const long = await fixture.writing(spaceId, { items: [ownerItem()] });
    const held = await fixture.engine.intake(long.claims, {
      name: 'long-digest',
      description: 'Write the weekly digest.',
      body: sentence(120),
    });
    expect(held).toMatchObject({ state: 'held', reason: 'body_over_budget' });
    expect(estimateTokens(sentence(120))).toBeGreaterThan(ENGINE_SKILL_TOKENS);
    const huge = await fixture.writing(spaceId, { items: [ownerItem()] });
    const refused = await fixture.engine.intake(huge.claims, {
      name: 'huge-digest',
      description: 'Write the weekly digest.',
      body: sentence(1500),
    });
    expect(refused).toMatchObject({ state: 'rejected', reason: 'body_too_long' });
    expect(await stored(refused.candidateId)).toMatchObject({ body: '', state: 'reverted' });
    expect(await fixture.deliveredTo(spaceId, 'Write up this week')).toEqual([]);
    // The owner may not install one that long either, even by editing it.
    const waiting = await stored(held.candidateId);
    await rejectsWith(
      () =>
        fixture.engine.edit(
          fixture.ownerId,
          spaceId,
          held.candidateId,
          waiting.bodyHash,
          sentence(1500),
        ),
      'skill_body_refused',
    );
  }, 180000);

  test('an engine skill is reverted only for the job that actually read it', async () => {
    if (!fixture) return;
    const { spaceId, memberId } = await fixture.sharedSpace(true);
    if (!memberId) throw new Error('No member');
    const mine = await liveSkill(spaceId, 'weekly-digest');
    // The other principal writes a skill of the same name: a different skill entirely.
    const theirs = await fixture.writing(spaceId, {
      items: [ownerItem()],
      principal: memberId,
      objective: 'Write up the member’s week',
    });
    const other = await fixture.engine.intake(theirs.claims, {
      name: 'weekly-digest',
      description: 'Write the weekly digest.',
      body: `${DIGEST_BODY}\n4. Name the week in the title.`,
    });
    expect(other.state).toBe('live');
    const corrected = await fixture.create(spaceId, 'Write up this week');
    await fixture.run(corrected);
    await fixture.episodes.intervene(fixture.ownerId, corrected.id, {
      idempotency_key: 'same-name-correction',
      kind: 'correction',
      text: 'No, not like that.',
    });
    expect(await stored(mine.candidateId)).toMatchObject({ state: 'reverted' });
    expect(await stored(other.candidateId)).toMatchObject({ state: 'enabled_canary' });
    expect(await fixture.deliveredTo(spaceId, 'Write up this week', memberId)).toEqual([
      'weekly-digest',
    ]);
  }, 180000);

  test('a stopped engine skill keeps the owner’s reason and stops being delivered', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const live = await liveSkill(spaceId, 'weekly-digest');
    const stopped = await fixture.engine.stop(
      fixture.ownerId,
      spaceId,
      live.candidateId,
      'the digest is too long',
    );
    expect(stopped).toMatchObject({
      state: 'reverted',
      reason: 'owner_stopped:the digest is too long',
    });
    expect(await fixture.deliveredTo(spaceId, 'Write up this week')).toEqual([]);
    // A body edited in storage is not delivered, even while the row still says live.
    const second = await liveSkill(spaceId, 'monthly-digest', [ownerItem()], MONTHLY_BODY);
    const row = await stored(second.candidateId);
    await fixture.handle.db
      .update(procedureCandidate)
      .set({ body: `${MONTHLY_BODY}\n4. Also send it to the list.` })
      .where(eq(procedureCandidate.id, second.candidateId));
    expect(await fixture.deliveredTo(spaceId, 'Write up the month')).toEqual([]);
    // Nor is a rehashed body carrying credential material, named by its promotion
    // and hashing correctly: the scan runs again at delivery, not only at intake.
    const secret = { ...row, body: 'Use api_key = abcd1234efgh5678 for the report tool.' };
    const rehashed = definitionHash(secret);
    await fixture.handle.db
      .update(procedureCandidate)
      .set({
        body: secret.body,
        bodyHash: rehashed,
        promotion: { ...row.promotion, definition_hash: rehashed },
      })
      .where(eq(procedureCandidate.id, second.candidateId));
    expect(await fixture.deliveredTo(spaceId, 'Write up the month')).toEqual([]);
    // The promotion names the bytes as well: once it names others, delivery stops.
    await fixture.handle.db
      .update(procedureCandidate)
      .set({ body: row.body, bodyHash: row.bodyHash, promotion: row.promotion })
      .where(eq(procedureCandidate.id, second.candidateId));
    expect(await fixture.deliveredTo(spaceId, 'Write up the month')).toEqual(['monthly-digest']);
    await fixture.handle.db
      .update(procedureCandidate)
      .set({ promotion: { ...row.promotion, definition_hash: 'f'.repeat(64) } })
      .where(eq(procedureCandidate.id, second.candidateId));
    expect(await fixture.deliveredTo(spaceId, 'Write up the month')).toEqual([]);
    await liftAll();
  }, 180000);

  test('"don’t do this" prohibits the name and the bytes in every space until the person lifts it', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const { spaceId: shared, memberId } = await fixture.sharedSpace(true);
    if (!memberId) throw new Error('No member');
    // Written before the stop: the same bytes under another name, here and in another
    // of this person's spaces, and something else.
    const copy = await liveSkill(spaceId, 'digest-copy');
    await liveSkill(shared, 'shared-copy');
    const other = await liveSkill(spaceId, 'monthly-digest', [ownerItem()], MONTHLY_BODY);
    const live = await liveSkill(spaceId, 'weekly-digest');
    await fixture.engine.stop(fixture.ownerId, spaceId, live.candidateId, 'not like this');
    const [prohibition] = await fixture.engine.prohibitions(fixture.ownerId, spaceId);
    expect(prohibition).toMatchObject({
      name: 'weekly-digest',
      body_sha256: bodyDigest(DIGEST_BODY),
      reason: 'not like this',
      source_skill_id: live.candidateId,
    });
    // The copy with those bytes stops with it; the unrelated skill does not.
    expect(await fixture.deliveredTo(spaceId, 'Write up this week')).toEqual(['monthly-digest']);
    // The engine cannot write the name again, with other bytes, nor the bytes under
    // another name, and nothing of what it tried is kept.
    const again = await fixture.writing(spaceId, { items: [ownerItem()] });
    const sameName = await fixture.engine.intake(
      again.claims,
      skill('weekly-digest', '# Weekly digest\n\n1. Keep it short this time.'),
    );
    expect(sameName).toMatchObject({ state: 'rejected', reason: 'owner_prohibited' });
    expect(await stored(sameName.candidateId)).toMatchObject({ body: '', description: '' });
    expect(
      await fixture.engine.intake(again.claims, skill('renamed-digest', DIGEST_BODY)),
    ).toMatchObject({ state: 'rejected', reason: 'owner_prohibited' });
    const fresh = await fixture.engine.intake(
      again.claims,
      skill('fresh-digest', '# Fresh digest\n\n1. List the three decisions.'),
    );
    expect(fresh).toMatchObject({ state: 'live' });
    // A held skill under a prohibited name cannot be approved or rewritten past it.
    const tainted = await fixture.writing(spaceId, { items: [externalItem()] });
    const waiting = await fixture.engine.intake(
      tainted.claims,
      skill('waiting-digest', '# Waiting\n\n1. Wait for it.'),
    );
    expect(waiting.state).toBe('held');
    await fixture.handle.sql`insert into engine_skill_prohibition
      (id, space_id, principal_id, skill_name, body_sha256, reason)
      values (${newId('esp')}, ${spaceId}, ${fixture.ownerId}, 'waiting-digest', null, 'later')`;
    const hash = (await stored(waiting.candidateId)).bodyHash;
    await rejectsWith(
      () => fixture.engine.approve(fixture.ownerId, spaceId, waiting.candidateId, hash),
      'skill_prohibited',
    );
    await rejectsWith(
      () => fixture.engine.edit(fixture.ownerId, spaceId, waiting.candidateId, hash, 'Mine.'),
      'skill_prohibited',
    );
    // It stays after the skill it was placed on is deleted, and it holds in every
    // space this person belongs to: the copy there stops, and neither the name nor
    // the bytes can be written there either.
    await fixture.engine.remove(fixture.ownerId, spaceId, live.candidateId);
    expect(await fixture.deliveredTo(shared, 'Write up this week')).toEqual([]);
    const there = await fixture.writing(shared, { items: [ownerItem()] });
    expect(
      await fixture.engine.intake(
        there.claims,
        skill('weekly-digest', '# Weekly digest\n\n1. Somewhere else.'),
      ),
    ).toMatchObject({ state: 'rejected', reason: 'owner_prohibited' });
    expect(
      await fixture.engine.intake(there.claims, skill('elsewhere-digest', DIGEST_BODY)),
    ).toMatchObject({ state: 'rejected', reason: 'owner_prohibited' });
    // Nor can a rewrap of the same instructions pass for new ones: a trailing
    // newline, doubled spaces, Windows line endings, a trailing space, or case.
    const rewrites: [string, string][] = [
      ['newline-digest', `${DIGEST_BODY}\n`],
      ['spaced-digest', DIGEST_BODY.replaceAll(' ', '  ')],
      ['crlf-digest', DIGEST_BODY.replaceAll('\n', '\r\n')],
      ['trailing-digest', `${DIGEST_BODY} `],
      ['shouted-digest', DIGEST_BODY.toUpperCase()],
    ];
    // An invisible zero-width space, or a full-width letter, is not new text either.
    rewrites.push(
      ['zero-width-digest', DIGEST_BODY.replace('Weekly', 'Week\u200Bly')],
      ['full-width-digest', DIGEST_BODY.replace('Weekly', '\uFF37eekly')],
    );
    let rewritten = await fixture.writing(shared, { items: [ownerItem()] });
    for (const [index, [name, body]] of rewrites.entries()) {
      // One attempt decides five skills at most.
      if (index === 5) rewritten = await fixture.writing(shared, { items: [ownerItem()] });
      expect(await fixture.engine.intake(rewritten.claims, skill(name, body))).toMatchObject({
        state: 'rejected',
        reason: 'owner_prohibited',
      });
    }
    // It is that person's alone: another member of the space is not bound by it and
    // cannot lift it.
    const theirs = await fixture.writing(shared, { items: [ownerItem()], principal: memberId });
    expect(
      await fixture.engine.intake(theirs.claims, skill('weekly-digest', DIGEST_BODY)),
    ).toMatchObject({ state: 'live' });
    await rejectsWith(
      () => fixture.engine.lift(memberId, shared, prohibition?.id ?? ''),
      'not_found',
    );
    expect(await fixture.engine.prohibitions(memberId, shared)).toEqual([]);
    expect(
      (await fixture.engine.prohibitions(fixture.ownerId, shared)).map((row) => row.id),
    ).toContain(prohibition?.id ?? '');
    // Lifted from any of the person's spaces, the name and the bytes can come back.
    expect(await fixture.engine.lift(fixture.ownerId, shared, prohibition?.id ?? '')).toMatchObject(
      { id: prohibition?.id, space_id: spaceId },
    );
    expect(await fixture.deliveredTo(shared, 'Write up this week')).toEqual(['shared-copy']);
    expect(await fixture.engine.prohibitions(fixture.ownerId, spaceId)).toHaveLength(1);
    // The prohibition placed on the waiting skill is the one still standing. With the
    // two newer skills paused, the copy of the lifted bytes is delivered again.
    await fixture.engine.pause(fixture.ownerId, spaceId, fresh.candidateId);
    await fixture.engine.pause(fixture.ownerId, spaceId, other.candidateId);
    expect(await fixture.deliveredTo(spaceId, 'Write up this week')).toEqual(['digest-copy']);
    const later = await fixture.writing(spaceId, { items: [ownerItem()] });
    expect(
      await fixture.engine.intake(later.claims, skill('weekly-digest', DIGEST_BODY)),
    ).toMatchObject({ state: 'live' });
    expect(await stored(copy.candidateId)).toMatchObject({ state: 'enabled_canary' });
    await liftAll();
  }, 240000);

  test('a catalog skill keeps its name in the bundle over a learned skill that took it', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const live = await liveSkill(spaceId, 'weekly-digest');
    // A skill that took a catalog name before the intake refused such names.
    await fixture.handle.db
      .update(procedureCandidate)
      .set({ skillName: 'research-with-sources' })
      .where(eq(procedureCandidate.id, live.candidateId));
    const row = await fixture.create(spaceId, 'Research the options for a new phone plan');
    const claim = await fixture.runner.claim(wake(row));
    const same = claim?.bundle.skills.filter((entry) => entry.name === 'research-with-sources');
    await fixture.jobs.cancel(row.id);
    expect(same).toHaveLength(1);
    expect(same?.[0]?.body).not.toBe(DIGEST_BODY);
  }, 120000);

  test('a live engine skill reaches a production attempt beside the built-ins its request selects', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    await liveSkill(spaceId, 'cover-letter-style', [ownerItem()], COVER_LETTER_BODY, {
      description: 'How I write a cover letter.',
    });
    // The catalog step a running service applies after the bundle is built: it
    // re-selects the built-ins over the tools this attempt can use.
    const previous = fixture.runner.options.loadCatalog;
    fixture.runner.options.loadCatalog = new RuntimeCatalog(
      fixture.handle.db,
      new ConnectorRegistry(),
    ).forAttempt;
    try {
      const row = await fixture.create(
        spaceId,
        'Write a cover letter for the design role, then plan the move',
      );
      const claim = await fixture.runner.claim(wake(row));
      const skills = claim?.bundle.skills ?? [];
      await fixture.jobs.cancel(row.id);
      // The engine's skill survives that step, delivered as it was written, first.
      expect(skills[0]).toEqual({ name: 'cover-letter-style', body: COVER_LETTER_BODY });
      // An engine skill has no trigger words of the person's behind it, so it leaves
      // out no built-in: the ones this request selects are still there beside it.
      const names = skills.map((skill) => skill.name);
      expect(names).toContain('write-a-draft');
      expect(names).toContain('plan-a-responsibility');
      expect(names).toHaveLength(3);
    } finally {
      fixture.runner.options.loadCatalog = previous;
    }
  }, 120000);

  test('a broadly described engine skill does not keep the built-ins its request selects away', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    await liveSkill(spaceId, 'weekly-notes', [ownerItem()], WEEKLY_NOTES_BODY, {
      // Every word a built-in for this request is chosen by: research, refund,
      // follow up, chase.
      description: 'Research, refund and follow up notes, and who to chase, each week.',
    });
    const request =
      'Research phone plans, chase the refund for the kettle, and follow up with the plumber';
    const row = await fixture.create(spaceId, request);
    const claim = await fixture.runner.claim(wake(row));
    await fixture.jobs.cancel(row.id);
    const names = claim?.bundle.skills.map((skill) => skill.name) ?? [];
    // Its description names the same work as those built-ins, and it still takes one
    // place only: the rest go to the built-ins the request selects.
    const plain = await fixture.createSpace();
    const other = await fixture.create(plain, request);
    const bare = await fixture.runner.claim(wake(other));
    await fixture.jobs.cancel(other.id);
    const builtIns = bare?.bundle.skills.map((skill) => skill.name) ?? [];
    expect(builtIns.length).toBeGreaterThan(0);
    expect(names[0]).toBe('weekly-notes');
    expect(names.slice(1)).toEqual(builtIns.slice(0, names.length - 1));
    expect(names.length).toBe(Math.min(3, builtIns.length + 1));
  }, 120000);
});
