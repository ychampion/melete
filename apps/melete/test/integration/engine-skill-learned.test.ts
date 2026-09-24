/**
 * Skills the engine wrote, in the person's "What I've learned" list, with the
 * controls that list offers for them.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { learnedList } from '@melete/contracts';
import { LearnedService } from '../../src/learning/learned.ts';
import { EngineSource } from '../../src/learning/learned-engine.ts';
import { newId } from '../../src/memory/db.ts';
import {
  DIGEST_BODY,
  engineSkillFixture,
  externalItem,
  ownerItem,
} from './engine-skill-fixtures.ts';
import { rejectsWith } from './learning-fixtures.ts';

const fixture = await engineSkillFixture();
const learned = fixture
  ? new LearnedService(fixture.jobs, fixture.procedures, fixture.episodes, [
      new EngineSource(fixture.engine),
    ])
  : null;
afterAll(async () => {
  await fixture?.close();
}, 30000);

const skill = (name: string, body = DIGEST_BODY) => ({
  name,
  description: 'Write the weekly digest.',
  body,
});

(fixture ? describe : describe.skip)('engine skills in what the person has taught', () => {
  test('the list shows the person’s own engine skills, with their own controls', async () => {
    if (!fixture || !learned) return;
    const { spaceId, memberId } = await fixture.sharedSpace(true);
    if (!memberId) throw new Error('No member');
    const clean = await fixture.writing(spaceId, { items: [ownerItem()] });
    const live = await fixture.engine.intake(clean.claims, skill('weekly-digest'));
    const held = await fixture.engine.intake(
      clean.claims,
      skill('held-digest', `${DIGEST_BODY}\n4. Send it without asking.`),
    );
    const refused = await fixture.engine.intake(
      clean.claims,
      skill('keyed-digest', 'Use api_key = abcd1234efgh5678 for the report tool.'),
    );
    expect([live.state, held.state, refused.state]).toEqual(['live', 'held', 'rejected']);
    // A member's own skill in the same space is theirs alone.
    const theirs = await fixture.writing(spaceId, {
      items: [ownerItem()],
      principal: memberId,
      objective: 'Write up the member’s week',
    });
    const member = await fixture.engine.intake(theirs.claims, skill('member-digest'));
    expect(member.state).toBe('live');

    const list = learnedList.parse(await learned.list(fixture.ownerId, spaceId));
    const engine = list.items.filter((item) => item.source === 'engine');
    // Refused at intake, it was never learned; the member's is not the owner's.
    expect(engine.map((item) => item.id).sort()).toEqual(
      [held.candidateId, live.candidateId].sort(),
    );
    expect(engine.find((item) => item.id === live.candidateId)).toMatchObject({
      name: 'weekly-digest',
      does: ['Write the weekly digest.'],
      state: 'active',
      actions: ['pause', 'edit', 'remove', 'stop'],
    });
    expect(engine.find((item) => item.id === held.candidateId)).toMatchObject({
      state: 'proposed',
      actions: ['approve', 'edit', 'remove', 'stop'],
    });
  }, 180000);

  test('pause, resume and remove go through the shared change log, and removal cannot be undone', async () => {
    if (!fixture || !learned) return;
    const spaceId = await fixture.createSpace();
    const writer = await fixture.writing(spaceId, { items: [ownerItem()] });
    const live = await fixture.engine.intake(writer.claims, skill('weekly-digest'));
    expect(await fixture.deliveredTo(spaceId, 'Write up this week')).toEqual(['weekly-digest']);

    const paused = await learned.change(fixture.ownerId, spaceId, live.candidateId, 'pause');
    expect(paused.item).toMatchObject({
      state: 'paused',
      actions: ['resume', 'edit', 'remove', 'stop'],
    });
    expect(paused.change).toMatchObject({
      source: 'engine',
      action: 'pause',
      name: 'weekly-digest',
    });
    expect(await fixture.deliveredTo(spaceId, 'Write up this week')).toEqual([]);
    // Undo puts it back as it was, and it is delivered again.
    if (!paused.change) throw new Error('A pause is a change that can be undone');
    await learned.undo(fixture.ownerId, spaceId, paused.change.id);
    expect((await learned.list(fixture.ownerId, spaceId)).items[0]).toMatchObject({
      id: live.candidateId,
      state: 'active',
    });
    expect(await fixture.deliveredTo(spaceId, 'Write up this week')).toEqual(['weekly-digest']);

    // Trying and sharing are the correction road; this is told it has its own controls.
    await rejectsWith(
      () => learned.try(fixture.ownerId, spaceId, live.candidateId, 'a'.repeat(64)),
      'invalid_procedure_state',
    );
    await rejectsWith(
      () => learned.share(fixture.ownerId, spaceId, live.candidateId),
      'invalid_procedure_state',
    );

    const removed = await learned.change(fixture.ownerId, spaceId, live.candidateId, 'remove');
    expect(removed.item).toBeNull();
    // Its text is erased, so the removal is never offered as something to undo.
    expect(removed.change).toBeNull();
    expect((await learned.list(fixture.ownerId, spaceId)).last_change).toBeNull();
    expect(await fixture.deliveredTo(spaceId, 'Write up this week')).toEqual([]);
    const [row] = await fixture.handle
      .sql`select body, rejection_reason from procedure_candidate where id = ${live.candidateId}`;
    expect(row).toMatchObject({ body: '', rejection_reason: 'owner_deleted' });
    // And asked for by its id all the same, the removal stands.
    const [logged] = await fixture.handle.sql<{ id: string }[]>`select id from learned_change
      where item_id = ${live.candidateId} and action = 'remove'`;
    await rejectsWith(
      () => learned.undo(fixture.ownerId, spaceId, logged?.id ?? ''),
      'undo_unavailable',
    );
  }, 180000);

  test('someone outside the space learns nothing about what an id names', async () => {
    if (!fixture || !learned) return;
    const spaceId = await fixture.createSpace();
    const writer = await fixture.writing(spaceId, { items: [ownerItem()] });
    const live = await fixture.engine.intake(writer.claims, skill('weekly-digest'));
    const outsider = newId('own');
    await fixture.handle
      .sql`insert into principal (id, email) values (${outsider}, ${`${outsider}@example.test`})`;
    // Refused for the space, before anything is read about the id itself.
    for (const action of [
      () => learned.try(outsider, spaceId, live.candidateId, 'a'.repeat(64)),
      () => learned.share(outsider, spaceId, live.candidateId),
    ])
      await rejectsWith(action, 'scope_denied');
  }, 120000);

  test('a held skill cannot be paused from the list, and a tainted one stays held', async () => {
    if (!fixture || !learned) return;
    const spaceId = await fixture.createSpace();
    const writer = await fixture.writing(spaceId, { items: [externalItem()] });
    const held = await fixture.engine.intake(writer.claims, skill('held-digest'));
    expect(held.state).toBe('held');
    await rejectsWith(
      () => learned.change(fixture.ownerId, spaceId, held.candidateId, 'pause'),
      'invalid_procedure_state',
    );
  }, 120000);
});
