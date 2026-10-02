/**
 * The rooms mock answers the rooms routes with bodies the contract describes:
 * a room is made and filled, the agent answers only when asked, each answer
 * streams on the thread's frames, a thread works on one ask at a time, and a
 * person who leaves finds no room.
 */
import { expect, test } from 'bun:test';
import * as C from '@melete/contracts';
import { createMock } from './index.ts';

type Mock = ReturnType<typeof createMock>;

const call = async (mock: Mock, method: string, path: string, body?: unknown) => {
  const response = await mock.app.fetch(
    new Request(`http://mock.test${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, json: (await response.json()) as unknown };
};

const label = /^.+ <[^<>\s]+@[^<>\s]+>$/;

async function room(mock: Mock) {
  const made = await call(mock, 'POST', '/rooms', { name: 'Design', purpose: 'The new site' });
  expect(made.status).toBe(201);
  const detail = C.roomDetail.parse(made.json);
  const people = C.peopleList.parse((await call(mock, 'GET', '/people?query=priya')).json).people;
  const priya = people[0];
  if (!priya) throw new Error('No one to add');
  const added = await call(mock, 'POST', `/rooms/${detail.room.id}/members`, {
    principal_id: priya.id,
  });
  expect(added.status).toBe(201);
  return { id: detail.room.id, priya };
}

test('a room is made, a person is added, and everyone in it is shown by name and email', async () => {
  const mock = createMock({ speed: 0 });
  const { id } = await room(mock);
  const detail = C.roomDetail.parse((await call(mock, 'GET', `/rooms/${id}`)).json);
  expect(detail.room.my_role).toBe('owner');
  expect(detail.members.map((m) => m.role).sort()).toEqual(['member', 'owner']);
  for (const member of detail.members) expect(member.display_name).toMatch(label);
  const listed = C.roomList.parse((await call(mock, 'GET', '/rooms')).json);
  expect(listed.rooms.map((r) => r.id)).toEqual([id]);
});

test('a message that does not ask starts nothing, and an ask is answered with a card and a receipt', async () => {
  const mock = createMock({ speed: 0 });
  const { id } = await room(mock);
  const started = C.roomMessageResponse.parse(
    (
      await call(mock, 'POST', `/rooms/${id}/threads`, {
        text: 'Which fonts are we using?',
        submission_id: 'first-1',
      })
    ).json,
  );
  expect(started.request_job_id).toBeNull();
  const thread = started.thread.id;
  const asked = C.roomMessageResponse.parse(
    (
      await call(mock, 'POST', `/rooms/${id}/threads/${thread}/messages`, {
        text: '@Melete can you sum this up?',
        submission_id: 'ask-1',
      })
    ).json,
  );
  expect(asked.request_job_id).not.toBeNull();
  const view = C.roomThreadView.parse(
    (await call(mock, 'GET', `/rooms/${id}/threads/${thread}`)).json,
  );
  expect(view.messages).toHaveLength(2);
  const [request] = view.requests;
  expect(request?.status).toBe('done');
  expect(request?.turns[0]?.answer).toContain('sum this up');
  expect(request?.cards).toHaveLength(1);
  expect(request?.receipts).toHaveLength(1);
  expect(request?.requested_by.display_name).toMatch(label);

  const frames = (await call(mock, 'GET', `/rooms/${id}/threads/${thread}/events?after=0`))
    .json as { frames: unknown[] };
  const parsed = frames.frames.map((frame) => C.roomStreamFrame.parse(frame));
  const seqs = parsed.map((frame) => frame.seq);
  expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  expect(parsed.some((frame) => frame.kind === 'message')).toBe(true);
  const kinds = parsed.flatMap((frame) =>
    frame.kind === 'request' ? [frame.event.item.type] : [],
  );
  expect(kinds).toContain('text_delta');
  expect(kinds).toContain('card');
  expect(kinds).toContain('receipt');

  const retried = C.roomMessageResponse.parse(
    (
      await call(mock, 'POST', `/rooms/${id}/threads/${thread}/messages`, {
        text: '@Melete can you sum this up?',
        submission_id: 'ask-1',
      })
    ).json,
  );
  expect(retried.message.id).toBe(asked.message.id);
});

test('a thread works on one ask at a time, and stopping one lets the next start', async () => {
  const mock = createMock({ speed: 1 });
  const { id } = await room(mock);
  const first = C.roomMessageResponse.parse(
    (
      await call(mock, 'POST', `/rooms/${id}/threads`, {
        text: 'Draft the launch note',
        ask_agent: true,
        submission_id: 'one',
      })
    ).json,
  );
  const thread = first.thread.id;
  const second = C.roomMessageResponse.parse(
    (
      await call(mock, 'POST', `/rooms/${id}/threads/${thread}/messages`, {
        text: '@Melete and a shorter one too',
        submission_id: 'two',
      })
    ).json,
  );
  expect(second.message.request_state).toBe('pending');
  expect(second.request_job_id).toBeNull();
  const stopped = await call(mock, 'POST', `/rooms/${id}/requests/${first.request_job_id}/stop`);
  expect(C.roomStopResponse.parse(stopped.json).request.status).toBe('stopped');
  const view = C.roomThreadView.parse(
    (await call(mock, 'GET', `/rooms/${id}/threads/${thread}`)).json,
  );
  expect(view.messages.find((m) => m.id === second.message.id)?.request_state).toBe('started');
  expect(view.requests).toHaveLength(2);
  for (const request of view.requests) {
    const stop = await call(mock, 'POST', `/rooms/${id}/requests/${request.job_id}/stop`);
    expect(stop.status).toBe(200);
  }
});

test('a member who leaves finds no room, and the owner cannot leave', async () => {
  const mock = createMock({ speed: 0 });
  mock.store.now = () => new Date();
  const own = await room(mock);
  const ownerLeaves = await call(mock, 'GET', '/me');
  const me = C.ownerResponse.parse(ownerLeaves.json).owner.id;
  expect((await call(mock, 'DELETE', `/rooms/${own.id}/members/${me}`)).status).toBe(409);

  const seeded = createMock({ speed: 0, experience: { seed: true } });
  const rooms = C.roomList.parse((await call(seeded, 'GET', '/rooms')).json).rooms;
  const joined = rooms.find((r) => r.my_role === 'member');
  if (!joined) throw new Error('The demonstration has a room the account was added to');
  const self = C.ownerResponse.parse((await call(seeded, 'GET', '/me')).json).owner.id;
  const left = await call(seeded, 'DELETE', `/rooms/${joined.id}/members/${self}`);
  expect(C.roomLeaveResponse.parse(left.json).removed).toBe(self);
  expect((await call(seeded, 'GET', `/rooms/${joined.id}`)).status).toBe(404);
  expect((await call(seeded, 'GET', `/rooms/${joined.id}/threads`)).status).toBe(404);
});

test('a name another person goes by is refused', async () => {
  const mock = createMock({ speed: 0 });
  const taken = await call(mock, 'PATCH', '/me', { display_name: 'Priya Shah' });
  expect(taken.status).toBe(409);
  const renamed = await call(mock, 'PATCH', '/me', { display_name: 'Jamie' });
  expect(C.meResponse.parse(renamed.json).owner.display_name).toBe('Jamie');
  expect((await call(mock, 'PATCH', '/me', { display_name: 'a <b@c.d>' })).status).toBe(400);
});
