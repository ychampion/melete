import { expect, test } from 'bun:test';
import * as C from '@melete/contracts';
import { createMock } from './index.ts';

const call = async (
  mock: ReturnType<typeof createMock>,
  path: string,
  method = 'GET',
  body?: unknown,
) => {
  const response = await mock.app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': path },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    response,
    body: (await response
      .clone()
      .json()
      .catch(() => null)) as unknown,
  };
};

async function booking(options: { computer?: boolean } = {}) {
  const mock = createMock({ speed: 0, ...options });
  const agents = C.agentList.parse((await call(mock, '/agents')).body).agents;
  const chat = C.conversationResponse.parse(
    (await call(mock, '/conversations', 'POST', { title: 'Dinner', agent_id: agents[0]?.id })).body,
  ).conversation;
  const computer = async () =>
    C.agentComputer.parse((await call(mock, `/conversations/${chat.id}/computer`)).body);
  const empty = await computer();
  await call(mock, `/conversations/${chat.id}/messages`, 'POST', { text: 'Book the table for 3' });
  for (let index = 0; index < 200; index++) {
    const view = C.conversationResponse.parse(
      (await call(mock, `/conversations/${chat.id}`)).body,
    ).conversation;
    if (view.status === 'needs_you' || view.status === 'done') break;
    await Bun.sleep(5);
  }
  return { mock, chat, empty, computer };
}

test('a conversation shows the page its agent opened and the command it ran', async () => {
  const { mock, empty, computer } = await booking();
  expect(empty).toEqual({
    browser: null,
    terminal: [],
    processes: [],
    available: { browser: true, terminal: true },
  });
  const view = await computer();
  expect(view.browser).toMatchObject({
    control: 'agent',
    url: 'https://resy.com/venues/luna-trattoria',
    title: 'Luna Trattoria',
  });
  expect(view.terminal).toHaveLength(1);
  expect(view.terminal[0]).toMatchObject({ status: 'done', exit_code: 0 });
  expect(view.terminal[0]?.output).toContain('First time all three are free: 19:30');
  const picture = await mock.app.request(
    `/artifacts/${view.browser?.screenshot?.artifact_id}/content`,
  );
  // The picture is behind the mock's session like every other artifact.
  expect(picture.status).toBe(401);
});

test('a person takes the browser, watches it live, and hands it back', async () => {
  const { mock, computer } = await booking();
  const session = (await computer()).browser?.session_id ?? '';
  expect((await call(mock, `/browser/sessions/${session}/live`, 'POST')).status).toBe(409);
  const taken = C.browserControlResponse.parse(
    (await call(mock, `/browser/sessions/${session}/takeover`, 'POST')).body,
  );
  expect(taken.control).toBe('human');
  expect((await computer()).browser?.control).toBe('you');
  const opened = C.liveOpen.parse(
    (await call(mock, `/browser/sessions/${session}/live`, 'POST')).body,
  );
  const abort = new AbortController();
  const stream = await mock.app.request(
    `/browser/sessions/${session}/live/frames?live_id=${opened.live_id}`,
    { signal: abort.signal },
  );
  const reader = stream.body?.getReader();
  const first = new TextDecoder().decode((await reader?.read())?.value);
  expect(first).toContain('event: where');
  const input = await call(mock, `/browser/sessions/${session}/live/input`, 'POST', {
    live_id: opened.live_id,
    ack_through: 1,
    events: [{ k: 'down', x: 10, y: 10, button: 0, mods: 0, clicks: 1 }],
  });
  expect(input.body).toEqual({ accepted: 1 });
  abort.abort();
  await reader?.cancel().catch(() => {});
  expect(
    C.browserControlResponse.parse(
      (await call(mock, `/browser/sessions/${session}/handback`, 'POST')).body,
    ).control,
  ).toBe('automation');
  expect((await computer()).browser?.control).toBe('agent');
  // The live view belonged to the takeover that ended.
  expect(
    (
      await call(mock, `/browser/sessions/${session}/live/input`, 'POST', {
        live_id: opened.live_id,
        ack_through: 0,
        events: [],
      })
    ).status,
  ).toBe(410);
});

test('without a browser or sandbox, the view is empty and says neither is available', async () => {
  const { empty, computer } = await booking({ computer: false });
  const none = {
    browser: null,
    terminal: [],
    processes: [],
    available: { browser: false, terminal: false },
  };
  expect(empty).toEqual(none);
  expect(await computer()).toEqual(none);
});
