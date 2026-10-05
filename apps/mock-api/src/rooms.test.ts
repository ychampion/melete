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

/** `Name <handle>`: the room's handle for a person, never their email. */
const label = /^[^<>@]+ <[a-z2-9]{8}>$/;

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

test('a room is made, a person is added, and everyone in it is shown by name and handle', async () => {
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
  const own = await room(mock);
  const me = C.ownerResponse.parse((await call(mock, 'GET', '/me')).json).owner.id;
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

test('an ask to send something waits on a permission only the asker may answer', async () => {
  const mock = createMock({ speed: 0 });
  const { id } = await room(mock);
  const detail = C.roomDetail.parse((await call(mock, 'GET', `/rooms/${id}`)).json);
  expect(detail.policy.requests_per_hour).toBe(30);
  const started = C.roomMessageResponse.parse(
    (
      await call(mock, 'POST', `/rooms/${id}/threads`, {
        text: 'Email the notes to the agency',
        ask_agent: true,
        submission_id: 'send-1',
      })
    ).json,
  );
  const view = C.roomThreadView.parse(
    (await call(mock, 'GET', `/rooms/${id}/threads/${started.thread.id}`)).json,
  );
  const [request] = view.requests;
  expect(request?.status).toBe('needs_you');
  const me = C.ownerResponse.parse((await call(mock, 'GET', '/me')).json).owner.id;
  expect(request?.permissions?.[0]?.eligible_approvers?.map((p) => p.principal_id)).toEqual([me]);
  expect(request?.decisions).toEqual([]);
});

test("a send through an account the room uses is answered under the room's team-account rule", async () => {
  const mock = createMock({ speed: 0 });
  const { id, priya } = await room(mock);
  const detail = C.roomDetail.parse((await call(mock, 'GET', `/rooms/${id}`)).json);
  expect(detail.policy.team_account_approvers).toBe('any_member');
  const added = await call(mock, 'POST', '/connections', {
    space_id: id,
    provider: 'caldav',
    label: 'Team calendar',
    scopes: ['calendar.list'],
    credentials: { password: 'hunter2' },
    caldav: { calendar_url: 'https://dav.example.com/calendars/team/', username: 'team' },
  });
  expect(added.status).toBe(201);
  const started = C.roomMessageResponse.parse(
    (
      await call(mock, 'POST', `/rooms/${id}/threads`, {
        text: 'Email the notes to the agency',
        ask_agent: true,
        submission_id: 'team-send-1',
      })
    ).json,
  );
  const waiting = async () =>
    C.roomThreadView.parse(
      (await call(mock, 'GET', `/rooms/${id}/threads/${started.thread.id}`)).json,
    ).requests[0]?.permissions?.[0];
  const me = C.ownerResponse.parse((await call(mock, 'GET', '/me')).json).owner.id;
  // Anyone in the room answers, the person who asked included.
  expect((await waiting())?.eligible_approvers?.map((p) => p.principal_id).sort()).toEqual(
    [me, priya.id].sort(),
  );
  const set = await call(mock, 'PUT', `/rooms/${id}/policy`, { team_account_approvers: 'owners' });
  expect(C.roomPolicyResponse.parse(set.json).policy.team_account_approvers).toBe('owners');
  const now = await waiting();
  expect(now?.eligible_approvers?.map((p) => p.principal_id)).toEqual([me]);
  expect(now?.why[0]).toContain("Waiting for one of the room's owners");

  // Kept for the owner, the account no longer serves the room: a new send follows the general rule.
  const account = C.connectionResponse.parse(added.json).connection.id;
  const kept = await call(mock, 'PUT', `/rooms/${id}/connections/${account}`, {
    shared_use: 'owner',
  });
  expect(C.roomConnectionResponse.parse(kept.json).connection.shared_use).toBe('owner');
  const again = C.roomMessageResponse.parse(
    (
      await call(mock, 'POST', `/rooms/${id}/threads`, {
        text: 'Email the plan to the agency',
        ask_agent: true,
        submission_id: 'team-send-2',
      })
    ).json,
  );
  const general = C.roomThreadView.parse(
    (await call(mock, 'GET', `/rooms/${id}/threads/${again.thread.id}`)).json,
  ).requests[0]?.permissions?.[0];
  expect(general?.eligible_approvers?.map((p) => p.principal_id)).toEqual([me]);
  expect(general?.why[0]).toContain('who asked for it');
});

const answerPermission = (
  mock: Mock,
  roomId: string,
  permission: { id: string; version: string; payload_hash?: string },
  option: 'allow_once' | 'deny',
) =>
  call(mock, 'POST', `/rooms/${roomId}/approvals/${permission.id}`, {
    option,
    version: permission.version,
    payload_hash: permission.payload_hash ?? '',
  });

test("a permission is answered by the people the room's rule names, once, and owners change the rule", async () => {
  const mock = createMock({ speed: 0, experience: { seed: true } });
  const rooms = C.roomList.parse((await call(mock, 'GET', '/rooms')).json).rooms;
  const launch = rooms.find((r) => r.my_role === 'owner');
  if (!launch) throw new Error('The demonstration has a room the account owns');
  const threads = C.roomThreadList.parse(
    (await call(mock, 'GET', `/rooms/${launch.id}/threads`)).json,
  ).threads;
  const read = async () => {
    for (const thread of threads) {
      const view = C.roomThreadView.parse(
        (await call(mock, 'GET', `/rooms/${launch.id}/threads/${thread.id}`)).json,
      );
      const waiting = view.requests.find((r) => (r.permissions ?? []).length > 0);
      if (waiting) return waiting;
    }
    return null;
  };
  const permission = (await read())?.permissions?.[0];
  if (!permission) throw new Error('The demonstration has a permission waiting');
  expect(permission.payload_hash).toMatch(/^[0-9a-f]{64}$/);
  // Sam asked; under the default rule only Sam answers, so the owner is refused.
  expect((await answerPermission(mock, launch.id, permission, 'allow_once')).status).toBe(403);
  const set = await call(mock, 'PUT', `/rooms/${launch.id}/policy`, { approvers: 'owners' });
  expect(C.roomPolicyResponse.parse(set.json).policy.approvers).toBe('owners');
  const now = (await read())?.permissions?.[0];
  if (!now) throw new Error('Still waiting');
  const me = C.ownerResponse.parse((await call(mock, 'GET', '/me')).json).owner.id;
  expect(now.eligible_approvers?.map((p) => p.principal_id)).toEqual([me]);
  const changed = { ...now, payload_hash: '0'.repeat(64) };
  expect((await answerPermission(mock, launch.id, changed, 'deny')).status).toBe(409);
  const allowed = await answerPermission(mock, launch.id, now, 'allow_once');
  expect(C.roomPermissionOutcome.parse(allowed.json).decided_by.principal_id).toBe(me);
  const again = await answerPermission(mock, launch.id, now, 'deny');
  expect(again.status).toBe(409);
  expect((again.json as { error: { message: string } }).error.message).toBe(
    'You already allowed this.',
  );
});

test('an invite makes a guest who reaches only rooms, reads no email, and never answers', async () => {
  const mock = createMock({ speed: 0 });
  const { id } = await room(mock);
  const made = C.roomInviteCreated.parse(
    (
      await call(mock, 'POST', `/rooms/${id}/invites`, {
        email: 'Gil@Studio.example',
        expires_in_days: 7,
      })
    ).json,
  );
  expect(made.invite.email).toBe('gil@studio.example');
  expect(made.invite.state).toBe('open');
  const token = new URLSearchParams(made.path.split('?')[1]).get('token') ?? '';
  const viewed = C.inviteView.parse((await call(mock, 'POST', '/invites/view', { token })).json);
  expect(viewed.existing_account).toBe(false);
  // The owner is signed in, so the link asks them to sign out first.
  const signedIn = await call(mock, 'POST', '/invites/accept', { token, password: 'x'.repeat(10) });
  expect(signedIn.status).toBe(409);
  await call(mock, 'POST', '/signout');
  const accepted = await call(mock, 'POST', '/invites/accept', {
    token,
    password: 'guest-password',
    display_name: 'Gil',
  });
  expect(C.acceptInviteResponse.parse(accepted.json).room_id).toBe(id);
  const me = C.meResponse.parse((await call(mock, 'GET', '/me')).json).owner;
  expect(me.kind).toBe('guest');
  expect((await call(mock, 'GET', '/home')).status).toBe(403);
  expect((await call(mock, 'GET', '/profile')).status).toBe(403);
  expect((await call(mock, 'GET', '/people')).status).toBe(403);
  expect((await call(mock, 'POST', '/rooms', { name: 'Mine' })).status).toBe(403);
  const detail = C.roomDetail.parse((await call(mock, 'GET', `/rooms/${id}`)).json);
  expect(detail.room.my_role).toBe('guest');
  for (const member of detail.members) {
    expect(member.email).toBeUndefined();
    expect(member.display_name).toMatch(label);
  }
  expect(detail.members.find((m) => m.principal_id === me.id)?.expires_at).toBe(
    made.invite.expires_at,
  );
  // A guest's ask is answered by the owners, never by the guest.
  const asked = C.roomMessageResponse.parse(
    (
      await call(mock, 'POST', `/rooms/${id}/threads`, {
        text: 'Email the brief to the studio',
        ask_agent: true,
        submission_id: 'guest-1',
      })
    ).json,
  );
  const view = C.roomThreadView.parse(
    (await call(mock, 'GET', `/rooms/${id}/threads/${asked.thread.id}`)).json,
  );
  const permission = view.requests[0]?.permissions?.[0];
  if (!permission) throw new Error('The ask waits on a permission');
  expect(permission.eligible_approvers?.map((p) => p.principal_id)).not.toContain(me.id);
  expect((await answerPermission(mock, id, permission, 'allow_once')).status).toBe(403);
  // A used link works no more, and signing out ends the guest's session.
  expect((await call(mock, 'POST', '/invites/view', { token })).status).toBe(404);
  await call(mock, 'POST', '/signout');
  expect((await call(mock, 'GET', '/me')).status).toBe(401);
  const back = await call(mock, 'POST', '/login', {
    email: 'gil@studio.example',
    password: 'guest-password',
  });
  expect(back.status).toBe(200);
  expect(C.meResponse.parse((await call(mock, 'GET', '/me')).json).owner.kind).toBe('guest');
});

test('a handoff waits on Home, runs the task the person read, and reaches the room only when shared', async () => {
  const mock = createMock({ speed: 0, experience: { seed: true } });
  const home = (await call(mock, 'GET', '/home')).json as { handoffs: unknown[] };
  const [waiting] = home.handoffs.map((entry) => C.roomHandoff.parse(entry));
  if (!waiting) throw new Error('The demonstration hands the account a task');
  expect(waiting.state).toBe('pending');
  expect(waiting.asked_by?.display_name).toMatch(label);
  const listed = (await call(mock, 'GET', '/permissions')).json as { handoffs: unknown[] };
  expect(listed.handoffs).toHaveLength(1);
  const wrong = await call(mock, 'POST', `/handoffs/${waiting.id}`, {
    decision: 'accept',
    task_hash: 'f'.repeat(64),
  });
  expect(wrong.status).toBe(409);
  const accepted = C.handoffResponse.parse(
    (
      await call(mock, 'POST', `/handoffs/${waiting.id}`, {
        decision: 'accept',
        task_hash: waiting.task_hash,
      })
    ).json,
  ).handoff;
  expect(accepted.state).toBe('settled');
  if (!accepted.result || !accepted.result_hash) throw new Error('The work ended with a result');
  // Sharing names the exact text the person read; any other text is refused.
  const stale = await call(mock, 'POST', `/handoffs/${waiting.id}/result`, {
    decision: 'share',
    result_hash: 'e'.repeat(64),
  });
  expect(stale.status).toBe(409);
  const shared = C.handoffResponse.parse(
    (
      await call(mock, 'POST', `/handoffs/${waiting.id}/result`, {
        decision: 'share',
        result_hash: accepted.result_hash,
      })
    ).json,
  ).handoff;
  expect(shared.state).toBe('shared');
  expect(shared.result).toBeNull();
  const thread = C.roomThreadView.parse(
    (await call(mock, 'GET', `/rooms/${waiting.room.id}/threads/${waiting.thread_id}`)).json,
  );
  const posted = thread.messages.find((m) => m.kind === 'handoff_result');
  expect(posted?.text).toBe(accepted.result);
  expect(posted?.via_agent).toBe(true);
  expect(thread.requests[0]?.status).toBe('done');
  const after = (await call(mock, 'GET', '/home')).json as { handoffs: unknown[] };
  expect(after.handoffs).toEqual([]);
});

test('a person deletes their own message, forgets what the room remembers, and shares a detail of their own', async () => {
  const mock = createMock({ speed: 0, experience: { seed: true } });
  const rooms = C.roomList.parse((await call(mock, 'GET', '/rooms')).json).rooms;
  const launch = rooms.find((r) => r.my_role === 'owner');
  if (!launch) throw new Error('The demonstration has a room the account owns');
  const memory = C.roomMemoryView.parse(
    (await call(mock, 'GET', `/rooms/${launch.id}/memory`)).json,
  );
  expect(memory.items.length).toBeGreaterThan(0);
  for (const item of memory.items) {
    expect(item.can_forget).toBe(true);
    for (const by of item.said_by) expect(by.display_name).toMatch(label);
  }
  const [first] = memory.items;
  if (!first) throw new Error('Something is remembered');
  const forgot = await call(mock, 'POST', `/rooms/${launch.id}/memory/${first.claim_id}/forget`);
  expect(C.roomMemoryForgotten.parse(forgot.json).forgotten).toBe(first.claim_id);

  const threads = C.roomThreadList.parse(
    (await call(mock, 'GET', `/rooms/${launch.id}/threads`)).json,
  ).threads;
  const thread = threads.find((t) => t.title === 'Pricing page copy');
  if (!thread) throw new Error('The room has a thread');
  const posted = C.roomMessageResponse.parse(
    (
      await call(mock, 'POST', `/rooms/${launch.id}/threads/${thread.id}/messages`, {
        text: 'My number is 0161 496 0000',
        submission_id: 'mine-1',
      })
    ).json,
  );
  const deleted = C.roomMessageDeleted.parse(
    (await call(mock, 'DELETE', `/rooms/${launch.id}/messages/${posted.message.id}`)).json,
  );
  expect(deleted.message.text).toBeNull();
  const view = C.roomThreadView.parse(
    (await call(mock, 'GET', `/rooms/${launch.id}/threads/${thread.id}`)).json,
  );
  const someoneElse = view.messages.find(
    (m) => m.author.principal_id !== posted.message.author.principal_id,
  );
  if (!someoneElse) throw new Error('Someone else spoke');
  const refused = await call(mock, 'DELETE', `/rooms/${launch.id}/messages/${someoneElse.id}`);
  expect(refused.status).toBe(403);

  const beliefs = C.beliefList.parse((await call(mock, 'GET', '/memory/beliefs')).json).beliefs;
  const mine = beliefs[0];
  if (!mine) throw new Error('The account remembers something');
  const share = await call(mock, 'POST', `/rooms/${launch.id}/shares`, { claim_id: mine.id });
  expect(share.status).toBe(201);
  const made = C.roomShareResponse.parse(share.json).share;
  expect(made.members_only).toBe(true);
  expect(made.content).toBe(mine.value);
  const withdrawn = await call(mock, 'DELETE', `/rooms/${launch.id}/shares/${made.id}`);
  expect(C.roomShareWithdrawn.parse(withdrawn.json).withdrawn).toBe(made.id);
});
