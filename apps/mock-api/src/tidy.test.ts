/**
 * The mock renames and deletes chats, deletes plans and removes people the way
 * the service does, so the web app can be built and shown against it.
 */
import { expect, test } from 'bun:test';
import {
  conversationDeleted,
  conversationList,
  conversationResponse,
  planList,
  spaceMembers,
} from '@melete/contracts';
import { createMock } from './index.ts';

const setup = (space: 'personal' | 'shared' = 'personal') => {
  const mock = createMock({ speed: 0, experience: { seed: true }, space });
  const call = (path: string, method = 'GET', body?: unknown) =>
    mock.app.request(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const chats = async () =>
    conversationList.parse(await (await call('/conversations')).json()).conversations;
  return { call, chats };
};

test('a chat is renamed and then deleted, and leaves the list', async () => {
  const { call, chats } = setup();
  const first = (await chats())[0];
  if (!first) throw new Error('The seed has chats');
  const renamed = await call(`/conversations/${first.id}`, 'PATCH', { title: 'Kept for later' });
  expect(conversationResponse.parse(await renamed.json()).conversation.title).toBe(
    'Kept for later',
  );
  const deleted = await call(`/conversations/${first.id}?forget_memory=true`, 'DELETE');
  expect(conversationDeleted.parse(await deleted.json()).id).toBe(first.id);
  expect((await chats()).map((chat) => chat.id)).not.toContain(first.id);
  expect((await call(`/conversations/${first.id}`)).status).toBe(404);
});

test('a deleted plan leaves its chats behind, unlinked', async () => {
  const { call, chats } = setup();
  const plans = planList.parse(await (await call('/plans')).json()).plans;
  const linked = plans.find((plan) => plan.conversation_ids.length > 0);
  if (!linked) throw new Error('The seed links a chat to a plan');
  expect((await call(`/plans/${linked.id}`, 'DELETE')).status).toBe(200);
  const after = planList.parse(await (await call('/plans')).json()).plans;
  expect(after.map((plan) => plan.id)).not.toContain(linked.id);
  const chat = (await chats()).find((entry) => entry.id === linked.conversation_ids[0]);
  expect(chat?.plan_id).toBeNull();
});

test('only a shared space has people to remove, and never its owner', async () => {
  const personal = setup();
  const alone = spaceMembers.parse(await (await personal.call('/space/members')).json());
  expect(alone.space.kind).toBe('personal');
  expect(alone.members).toHaveLength(1);
  const shared = setup('shared');
  const before = spaceMembers.parse(await (await shared.call('/space/members')).json());
  expect(before.members.map((member) => member.role)).toEqual(['owner', 'member', 'member']);
  const [owner, member] = before.members;
  if (!owner || !member) throw new Error('Expected people');
  expect((await shared.call(`/space/members/${owner.principal_id}`, 'DELETE')).status).toBe(403);
  expect((await shared.call(`/space/members/${member.principal_id}`, 'DELETE')).status).toBe(200);
  const after = spaceMembers.parse(await (await shared.call('/space/members')).json());
  expect(after.members).toHaveLength(2);
});
