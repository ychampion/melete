/**
 * The mock's "What I've learned" list behaves as the service's: each item
 * offers only what its state allows, every change can be undone by the id the
 * person was shown, and engine skills are approved, edited or stopped by the
 * exact text they were shown.
 */
import { expect, test } from 'bun:test';
import {
  engineSkillListResponse,
  engineSkillResponse,
  learnedItemResponse,
  learnedList,
} from '@melete/contracts';
import { createMock } from './index.ts';

const setup = () => {
  const mock = createMock({ speed: 0 });
  const post = (path: string, body: unknown) =>
    mock.app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const list = async () =>
    learnedList.parse(await (await mock.app.request(`/learned?space_id=${mock.spaceId}`)).json());
  return { mock, post, list, space: { space_id: mock.spaceId } };
};

test('the list names each item with the actions its state allows', async () => {
  const { list } = setup();
  const { items, last_change } = await list();
  expect(last_change).toBeNull();
  const byName = new Map(items.map((item) => [item.name, item]));
  expect(byName.get('Chasing a company')?.actions).toEqual(['pause', 'remove']);
  expect(byName.get('Replies to the landlord')?.actions).toEqual(['try', 'remove']);
  expect(byName.get('Replies to the landlord')?.expiring_soon).toBe(true);
  expect(byName.get('refund-follow-up')?.actions).toEqual(['approve', 'edit', 'remove', 'stop']);
  expect(byName.get('Morning brief')?.actions).toEqual(['resume', 'remove']);
});

test('pause, then undo by the change id brings it back as it was', async () => {
  const { post, list, space } = setup();
  const chase = (await list()).items.find((item) => item.name === 'Chasing a company');
  if (!chase) throw new Error('missing seed');
  const paused = learnedItemResponse.parse(
    await (await post(`/learned/${chase.id}/pause`, space)).json(),
  );
  expect(paused.item?.state).toBe('paused');
  expect(paused.item?.actions).toEqual(['resume', 'remove']);
  expect((await list()).last_change?.id).toBe(paused.change?.id);
  // A change the person did not see is not undone.
  expect((await post('/learned/undo', { ...space, change_id: 'chg_other' })).status).toBe(409);
  const undone = learnedItemResponse.parse(
    await (await post('/learned/undo', { ...space, change_id: paused.change?.id })).json(),
  );
  expect(undone.item?.state).toBe('active');
  expect((await list()).last_change).toBeNull();
});

test('remove takes it off the list, and undo puts it back', async () => {
  const { post, list, space } = setup();
  const brief = (await list()).items.find((item) => item.name === 'Morning brief');
  if (!brief) throw new Error('missing seed');
  const removed = learnedItemResponse.parse(
    await (await post(`/learned/${brief.id}/remove`, space)).json(),
  );
  expect(removed.item).toBeNull();
  expect((await list()).items.some((item) => item.id === brief.id)).toBe(false);
  await post('/learned/undo', { ...space, change_id: removed.change?.id });
  expect((await list()).items.find((item) => item.id === brief.id)?.state).toBe('paused');
});

test('trying something learned approves the exact text shown', async () => {
  const { post, list, space } = setup();
  const landlord = (await list()).items.find((item) => item.name === 'Replies to the landlord');
  if (!landlord) throw new Error('missing seed');
  const stale = await post(`/learned/${landlord.id}/try`, {
    ...space,
    definition_hash: 'a'.repeat(64),
  });
  expect(stale.status).toBe(409);
  const tried = learnedItemResponse.parse(
    await (
      await post(`/learned/${landlord.id}/try`, {
        ...space,
        definition_hash: landlord.definition_hash,
      })
    ).json(),
  );
  expect(tried.item?.state).toBe('trial');
  expect(tried.item?.expires_at).toBeNull();
});

test('an engine skill is approved, rewritten in the person’s words, or stopped', async () => {
  const { mock, post, list, space } = setup();
  const skill = (await list()).items.find((item) => item.source === 'engine');
  if (!skill) throw new Error('missing seed');
  const skills = engineSkillListResponse.parse(
    await (await mock.app.request(`/engine-skills?space_id=${mock.spaceId}`)).json(),
  ).skills;
  expect(skills[0]?.state).toBe('held');
  const approved = engineSkillResponse.parse(
    await (
      await post(`/engine-skills/${skill.id}/approve`, {
        ...space,
        definition_hash: skill.definition_hash,
      })
    ).json(),
  );
  expect(approved.skill.state).toBe('live');
  const edited = engineSkillResponse.parse(
    await (
      await post(`/engine-skills/${skill.id}/edit`, {
        ...space,
        definition_hash: skill.definition_hash,
        body: 'Follow up on a refund a week after the date they gave\nAsk for the reference',
      })
    ).json(),
  );
  expect(edited.skill.body).toContain('a week after');
  const after = (await list()).items.find((item) => item.id === skill.id);
  expect(after?.does).toEqual([
    'Follow up on a refund a week after the date they gave',
    'Ask for the reference',
  ]);
  const stopped = engineSkillResponse.parse(
    await (
      await post(`/engine-skills/${skill.id}/stop`, { ...space, reason: 'Not like this.' })
    ).json(),
  );
  expect(stopped.skill.state).toBe('reverted');
  expect((await list()).items.find((item) => item.id === skill.id)?.actions).toEqual(['remove']);
});

test('another space is refused', async () => {
  const { mock, post, list } = setup();
  const [first] = (await list()).items;
  expect((await mock.app.request('/learned?space_id=sp_01M0000000000000000000000Z')).status).toBe(
    403,
  );
  expect(
    (await post(`/learned/${first?.id}/pause`, { space_id: 'sp_01M0000000000000000000000Z' }))
      .status,
  ).toBe(403);
});
