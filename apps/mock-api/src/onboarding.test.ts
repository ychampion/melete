import { expect, test } from 'bun:test';
import {
  agentList,
  conversationResponse,
  memoryItemList,
  memoryItemResponse,
  turnList,
} from '@melete/contracts';
import { createMock } from './index.ts';

test('the mock keeps setup answers, welcomes the person, and requires sign-in after sign-out', async () => {
  const { app } = createMock({ speed: 0 });
  const initial = memoryItemList.parse(await (await app.request('/memory/items')).json()).items
    .length;
  const post = (path: string, body?: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'welcome-test' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const answers = [
    { key: 'pref.home.city', value: 'New York' },
    { key: 'pref.people.names', value: 'Alex and Priya' },
    { key: 'pref.focus.this-month', value: 'A launch at work' },
    { key: 'pref.checkins.style', value: 'Morning brief at 8:30' },
  ];
  for (const answer of answers) {
    const saved = await post('/memory/items', answer);
    expect(saved.status).toBe(200);
    expect(memoryItemResponse.parse(await saved.json()).item).toMatchObject({
      value: answer.value,
      source: 'onboarding',
    });
  }
  const listed = memoryItemList.parse(await (await app.request('/memory/items')).json());
  expect(listed.items).toHaveLength(initial + 4);
  expect(listed.items.filter((item) => item.source === 'onboarding')).toHaveLength(4);
  const updated = memoryItemResponse.parse(
    await (await post('/memory/items', { ...answers[0], value: 'Lisbon' })).json(),
  ).item;
  expect(listed.items.find((item) => item.key === 'home: city')?.id).toBe(updated.id);
  expect(
    memoryItemList.parse(await (await app.request('/memory/items')).json()).items,
  ).toHaveLength(initial + 4);
  const refused = await post('/memory/items', {
    key: 'contact.alex.email',
    value: 'alex@example.test',
  });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: { code: 'extractor_owned_key' } });
  expect((await post('/memory/items', { ...answers[0], owner_id: 'spoofed' })).status).toBe(400);

  const { agents } = agentList.parse(await (await app.request('/agents')).json());
  const agent = agents[0];
  if (!agent) throw new Error('Missing mock agent');
  const { conversation } = conversationResponse.parse(
    await (await post('/conversations', { title: 'Getting started', agent_id: agent.id })).json(),
  );
  expect(
    (await post(`/conversations/${conversation.id}/messages`, { text: 'Where do we start?' }))
      .status,
  ).toBe(200);
  let welcome = '';
  for (let i = 0; i < 100; i++) {
    welcome =
      turnList.parse(await (await app.request(`/conversations/${conversation.id}/messages`)).json())
        .turns[0]?.answer ?? '';
    if (welcome.includes('You said “A launch at work”')) break;
    await Bun.sleep(5);
  }
  expect(welcome).toContain('You said “A launch at work”');
  expect(welcome).not.toContain('{{');

  expect((await post('/signout')).status).toBe(200);
  expect((await app.request('/profile')).status).toBe(401);
  expect((await post('/memory/items', answers[0])).status).toBe(401);
  expect((await post('/signout')).status).toBe(401);
  expect(
    (
      await post('/signin/magic-link/consume', {
        token: 'fixture-token-0123456789abcdef0123456789abcdef',
      })
    ).status,
  ).toBe(200);
  expect((await app.request('/profile')).status).toBe(200);
  expect(
    memoryItemList.parse(await (await app.request('/memory/items')).json()).items,
  ).toHaveLength(initial + 4);
});
