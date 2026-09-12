import { expect, test } from 'bun:test';
import * as C from '@melete/contracts';
import { BACKEND_VOCABULARY } from '../../melete/src/experience/projectors.ts';
import { createMock } from './index.ts';

const call = async (
  mock: ReturnType<typeof createMock>,
  path: string,
  method = 'GET',
  body?: unknown,
  headers = {},
) => {
  const response = await mock.app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, body: await response.json() };
};
async function chatFixture(objective = 'Reply about the repair') {
  const mock = createMock({ speed: 0 });
  const agents = C.agentList.parse((await call(mock, '/agents')).body).agents;
  const agentId = agents[0]?.id;
  if (!agentId) throw new Error('Missing mock agent');
  const chat = C.conversationResponse.parse(
    (await call(mock, '/conversations', 'POST', { title: objective, agent_id: agentId })).body,
  ).conversation;
  const accepted = C.messageAcceptance.parse(
    (
      await call(
        mock,
        `/conversations/${chat.id}/messages`,
        'POST',
        { text: objective },
        { 'Idempotency-Key': 'one' },
      )
    ).body,
  );
  for (let index = 0; index < 100; index++) {
    const view = C.conversationResponse.parse(
      (await call(mock, `/conversations/${chat.id}`)).body,
    ).conversation;
    if (view.status === 'done' || view.status === 'needs_you') return { mock, chat, accepted };
    await Bun.sleep(5);
  }
  throw new Error('Mock scenario did not settle');
}

test('experience scenario drafts first, reviews an explicit send, and replays safe events', async () => {
  const { mock, chat, accepted } = await chatFixture();
  const drafts = C.experienceOperations['GET /conversations/{id}/drafts'].response.parse(
    (await call(mock, `/conversations/${chat.id}/drafts`)).body,
  );
  const draft = C.experienceDraft.parse(drafts.drafts[0]);
  expect(draft.status).toBe('draft');
  expect(
    C.experienceOperations['GET /permissions'].response.parse(
      (await call(mock, '/permissions')).body,
    ).permissions,
  ).toHaveLength(0);
  expect(
    C.experienceOperations['GET /conversations/{id}/receipts'].response.parse(
      (await call(mock, `/conversations/${chat.id}/receipts`)).body,
    ).receipts,
  ).toHaveLength(0);
  const duplicate = C.messageAcceptance.parse(
    (
      await call(
        mock,
        `/conversations/${chat.id}/messages`,
        'POST',
        { text: 'Reply about the repair' },
        { 'Idempotency-Key': 'one' },
      )
    ).body,
  );
  expect(duplicate).toEqual(accepted);
  const send = C.experienceOperations['POST /drafts/{id}/send'].response.parse(
    (await call(mock, `/drafts/${draft.id}/send`, 'POST')).body,
  );
  const permission = C.permissionCard.parse(send.permission);
  expect(
    (
      await call(mock, `/permissions/${permission.id}`, 'POST', {
        option: 'allow_once',
        version: 'stale',
      })
    ).response.status,
  ).toBe(409);
  const decision = await call(mock, `/permissions/${permission.id}`, 'POST', {
    option: 'always',
    version: permission.version,
    bounds: {
      count_cap: 2,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      reconsent_after_days: 1,
    },
  });
  expect(C.permissionOutcome.parse(decision.body).rule?.bounds.count_cap).toBe(2);
  expect(
    C.experienceDraft.parse(
      C.experienceOperations['GET /conversations/{id}/drafts'].response.parse(
        (await call(mock, `/conversations/${chat.id}/drafts`)).body,
      ).drafts[0],
    ).status,
  ).toBe('sent');
  expect(
    C.experienceOperations['GET /conversations/{id}/receipts'].response.parse(
      (await call(mock, `/conversations/${chat.id}/receipts`)).body,
    ).receipts,
  ).toHaveLength(1);
  await call(mock, `/drafts/${draft.id}/send`, 'POST');
  expect(
    C.experienceOperations['GET /conversations/{id}/receipts'].response.parse(
      (await call(mock, `/conversations/${chat.id}/receipts`)).body,
    ).receipts,
  ).toHaveLength(1);
  const page = C.experienceEventPage.parse(
    (await call(mock, `/conversations/${chat.id}/events?since=0`)).body,
  );
  expect(page.events.some((event) => event.item.type === 'action')).toBe(true);
  expect(JSON.stringify(page)).not.toMatch(BACKEND_VOCABULARY);
  expect(
    C.experienceEventPage.parse(
      (await call(mock, `/conversations/${chat.id}/events?since=${page.next_cursor}`)).body,
    ).events,
  ).toEqual([]);
  const response = await mock.app.request(`/conversations/${chat.id}/events?since=0`, {
    headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(page.events[0]?.seq ?? 0) },
  });
  const reader = response.body?.getReader();
  const chunk = await reader?.read();
  expect(new TextDecoder().decode(chunk?.value)).toContain('event:');
  await reader?.cancel();
});

test('mock task, plan, profile and saved-detail changes conform to the experience contract', async () => {
  const mock = createMock({ speed: 0 });
  expect(
    (
      await call(mock, '/profile', 'PATCH', {
        name: 'Jamie',
        time_zone: 'Asia/Kolkata',
        day_hours: { start: '08:00', end: '22:00' },
      })
    ).response.status,
  ).toBe(200);
  const task = C.taskResponse.parse(
    (await call(mock, '/tasks', 'POST', { title: 'Buy dinner', due_at: null })).body,
  ).task;
  const plan = C.planResponse.parse(
    (
      await call(mock, '/plans', 'POST', {
        title: 'Dinner plan',
        category: 'Home',
        milestones: [{ title: 'Choose food', assignee: { kind: 'person' } }],
      })
    ).body,
  ).plan;
  const changed = C.planResponse.parse(
    (
      await call(mock, `/plans/${plan.id}/milestones/${plan.milestones[0]?.id}`, 'PATCH', {
        done: true,
      })
    ).body,
  ).plan;
  expect(changed.progress_percent).toBe(100);
  expect(
    C.homeResponse.parse((await call(mock, '/home')).body).tasks.some((row) => row.id === task.id),
  ).toBe(true);
  expect(
    C.experienceSearch.parse((await call(mock, '/search?q=dinner')).body).results,
  ).toHaveLength(2);
  const items = C.memoryItemList.parse((await call(mock, '/memory/items')).body).items;
  const item = items[0];
  if (!item) throw new Error('Missing saved mock detail');
  expect(
    (
      await call(mock, `/memory/items/${item.id}`, 'PATCH', {
        value: 'Updated preference',
        version: item.version,
      })
    ).response.status,
  ).toBe(200);
  expect(
    (
      await call(mock, `/memory/items/${item.id}`, 'PATCH', {
        value: 'Stale edit',
        version: item.version,
      })
    ).response.status,
  ).toBe(409);
  expect(
    (await call(mock, '/tasks', 'POST', { title: 'No', due_at: null, space_id: 'foreign' }))
      .response.status,
  ).toBe(400);
  expect(C.notAvailable.parse((await call(mock, '/browser/sessions/absent')).body).status).toBe(
    'not_available',
  );
  const cors = await mock.app.request('/conversations', {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:3202',
      'Access-Control-Request-Method': 'PATCH',
      'Access-Control-Request-Headers': 'Idempotency-Key',
    },
  });
  expect(cors.headers.get('Access-Control-Allow-Methods')).toContain('PATCH');
  expect(cors.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain(
    'idempotency-key',
  );
});

test('the uncertain scenario leaves a reviewed send unconfirmed without repeating it', async () => {
  const { mock, chat } = await chatFixture('Try the flaky destination');
  const { drafts } = C.experienceOperations['GET /conversations/{id}/drafts'].response.parse(
    (await call(mock, `/conversations/${chat.id}/drafts`)).body,
  );
  const draft = drafts[0];
  if (!draft) throw new Error('Expected scenario draft');
  const send = C.experienceOperations['POST /drafts/{id}/send'].response.parse(
    (await call(mock, `/drafts/${draft.id}/send`, 'POST')).body,
  );
  const permission = C.permissionCard.parse(send.permission);
  expect(permission.options).not.toContain('always');
  expect(
    (
      await call(mock, `/permissions/${permission.id}`, 'POST', {
        option: 'allow_once',
        version: permission.version,
      })
    ).response.status,
  ).toBe(200);
  const page = C.experienceEventPage.parse(
    (await call(mock, `/conversations/${chat.id}/events`)).body,
  );
  const notices = page.events.filter((event) => event.item.type === 'note');
  expect(notices).toHaveLength(1);
  expect(
    C.notAvailable.parse((await call(mock, `/drafts/${draft.id}/send`, 'POST')).body).status,
  ).toBe('not_available');
  const after = C.experienceEventPage.parse(
    (await call(mock, `/conversations/${chat.id}/events?since=${page.next_cursor}`)).body,
  );
  expect(after.events).toHaveLength(0);
  expect(
    C.experienceOperations['GET /conversations/{id}/receipts'].response.parse(
      (await call(mock, `/conversations/${chat.id}/receipts`)).body,
    ).receipts,
  ).toHaveLength(0);
  expect(
    C.conversationResponse.parse((await call(mock, `/conversations/${chat.id}`)).body).conversation
      .status,
  ).toBe('needs_you');
});
