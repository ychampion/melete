/**
 * A person's side of an agent's computer, over the mounted routes and a real
 * database: who may see it, what taking it over does to the job, and when the
 * live view accepts input.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { testDatabase } from '../../test/helpers/database.ts';
import { ServiceError } from '../api/errors.ts';
import { recordId } from '../broker/records.ts';
import { BrokerService } from '../broker/service.ts';
import { openDatabase } from '../db/client.ts';
import type { DesktopCommand, DockerSandboxProvider } from './adapters/docker.ts';
import { mountSandboxComputers, SandboxComputerService } from './computer.ts';
import { type ComputerControls, PostgresComputerControls } from './computer-control.ts';
import { seedSessionScope } from './session-fixtures.ts';

const database = await testDatabase();
afterAll(async () => database?.close());
const withDb = database ? describe : describe.skip;

type Owner = { id: string };

const codeOf = async (response: Response) => ((await response.json()) as { code?: string }).code;

/** A desktop that records what it was asked and paints two frames. */
function desktop() {
  const inputs: DesktopCommand[] = [];
  const provider = {
    desktop: true,
    capabilities: { adapter: 'docker' },
    async running() {
      return true;
    },
    async computer(_handle: unknown, command: DesktopCommand) {
      inputs.push(command);
      return new TextEncoder().encode('{"accepted":1}');
    },
    async *frames(_handle: unknown, _fps: number, signal: AbortSignal) {
      for (let frame = 0; frame < 2 && !signal.aborted; frame += 1)
        yield new Uint8Array([0xff, 0xd8, frame]);
    },
    touch() {},
  } as unknown as DockerSandboxProvider;
  return { provider, inputs };
}

/** The routes of one service instance, as the owner middleware would mount them. */
function mount(service: SandboxComputerService, getOwner: () => Owner) {
  const app = new Hono();
  app.use(async (c, next) => {
    c.set('owner' as never, getOwner() as never);
    await next();
  });
  mountSandboxComputers(app as never, service);
  app.onError((error, c) =>
    error instanceof ServiceError
      ? c.json({ code: error.code }, error.status)
      : c.json({ code: 'internal', message: error.message }, 500),
  );
  const call = (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    peer = '10.9.0.1',
    headers: Record<string, string> = {},
  ) =>
    app.request(
      `http://melete.test${path}`,
      {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { clientAddress: peer },
    );
  return call;
}

async function scene(options: { wrap?: (controls: ComputerControls) => ComputerControls } = {}) {
  if (!database) throw new Error('Postgres unavailable');
  const sql = database.sql;
  const ownerId = recordId('own');
  await sql`insert into owner (id, email) values (${ownerId}, ${`${ownerId}@example.test`}) on conflict do nothing`;
  await sql`insert into principal (id, email) values (${ownerId}, ${`${ownerId}@example.test`}) on conflict do nothing`;
  const scope = await seedSessionScope(sql);
  await sql`update space set owner_principal_id = ${ownerId} where id = ${scope.spaceId}`;
  await sql`update job set principal_id = ${ownerId}, state = 'running' where id = ${scope.jobId}`;
  const attemptId = await scope.attempt();
  const sessionId = recordId('sbx');
  const sandbox = `melete-sbx-test-${sessionId.toLowerCase()}`;
  await sql`insert into sandbox_session (id, connection_id, space_id, job_id, attempt_id, agent_id,
      adapter, provider_sandbox_id, image_ref, egress_policy, persistence, status, lease_expires_at)
    values (${sessionId}, ${scope.connectionId}, ${scope.spaceId}, ${scope.jobId}, ${attemptId},
      ${scope.agentId}, 'docker', ${sandbox}, 'melete-sandbox:local', '{"kind":"deny_all"}'::jsonb,
      'pause', 'ready', now() + interval '1 hour')`;
  const { provider, inputs } = desktop();
  const stored = new PostgresComputerControls(sql);
  const controls = options.wrap ? options.wrap(stored) : stored;
  const providers = () => new Map([[scope.connectionId, { adapter: 'docker' as const, provider }]]);
  const service = new SandboxComputerService(sql, providers, { controls });
  const parked: string[][] = [];
  service.onPark = (_job, attempts) => parked.push(attempts);
  let owner: Owner = { id: ownerId };
  const call = mount(service, () => owner);
  return {
    sql,
    scope,
    service,
    providers,
    owner: () => owner,
    attemptId,
    sessionId,
    sandbox,
    controls,
    inputs,
    parked,
    call,
    as(id: string) {
      owner = { id };
    },
  };
}

withDb('the computer a person steers', () => {
  test('the job owner finds its computer; anyone else finds nothing', async () => {
    const s = await scene();
    const listed = await s.call('GET', `/sandbox/computers?job_id=${s.scope.jobId}`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      computers: [
        {
          session_id: s.sessionId,
          job_id: s.scope.jobId,
          agent_id: s.scope.agentId,
          status: 'ready',
          running: true,
          control: 'agent',
          control_epoch: 0,
          viewport: { width: 1024, height: 768 },
          egress: 'deny_all',
        },
      ],
    });
    s.as(recordId('own'));
    expect((await s.call('GET', `/sandbox/computers?job_id=${s.scope.jobId}`)).status).toBe(404);
    expect((await s.call('POST', `/sandbox/sessions/${s.sessionId}/takeover`)).status).toBe(404);
    expect((await s.controls.state(s.sandbox)).control).toBe('agent');
  });

  test('taking over parks the job and fences its attempt; handing back carries the work on', async () => {
    const s = await scene();
    // Wired as the server wires it: the hand-back wakes the job the takeover parked.
    const broker = new BrokerService({ sql: s.sql, connectors: { get: () => undefined } });
    s.service.onHandedBack = (jobId) => broker.resumeAfterControl(jobId, 'Computer control:');
    const taken = await s.call('POST', `/sandbox/sessions/${s.sessionId}/takeover`);
    expect(await taken.json()).toEqual({
      session_id: s.sessionId,
      control: 'human',
      control_epoch: 1,
    });
    const [job] = await s.sql`select state, wait from job where id = ${s.scope.jobId}`;
    expect(job?.state).toBe('waiting_for_input');
    expect(job?.wait.question).toStartWith('Computer control:');
    const [attempt] = await s.sql`select outcome from attempt where id = ${s.attemptId}`;
    expect(attempt?.outcome).toBe('fenced');
    expect(s.parked).toEqual([[s.attemptId]]);
    // A second takeover moves the epoch on without parking twice.
    await s.call('POST', `/sandbox/sessions/${s.sessionId}/takeover`);
    expect(s.parked.length).toBe(1);
    const back = await s.call('POST', `/sandbox/sessions/${s.sessionId}/handback`);
    expect(await back.json()).toMatchObject({ control: 'agent', control_epoch: 3 });
    const [after] = await s.sql`select state, next_wake_at from job where id = ${s.scope.jobId}`;
    expect(after?.state).toBe('queued');
    expect(after?.next_wake_at).not.toBeNull();
    const events =
      await s.sql`select type, payload from event where job_id = ${s.scope.jobId} order by seq`;
    expect(events.map((event) => event.payload?.kind ?? event.type)).toEqual(
      expect.arrayContaining(['computer_control', 'computer_handback']),
    );
  });

  test('the live view shows the desktop to its owner and takes input only while they hold it', async () => {
    const s = await scene();
    const opened = await s.call('POST', `/sandbox/sessions/${s.sessionId}/live`);
    expect(opened.status).toBe(200);
    const { live_id: liveId, viewport } = (await opened.json()) as {
      live_id: string;
      viewport: unknown;
    };
    expect(viewport).toEqual({ width: 1024, height: 768 });
    const frames = await s.call(
      'GET',
      `/sandbox/sessions/${s.sessionId}/live/frames?live_id=${liveId}`,
    );
    expect(frames.headers.get('content-type')).toBe('text/event-stream');
    const reader = frames.body?.getReader();
    let text = '';
    while (reader && !text.includes('"seq":2')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain('"type":"frame"');
    await reader?.cancel();
    const typed = { live_id: liveId, ack_through: 2, events: [{ k: 'text', text: 'hi' }] };
    // The agent is driving: watching is fine, typing is not.
    const refused = await s.call('POST', `/sandbox/sessions/${s.sessionId}/live/input`, typed);
    expect([refused.status, await codeOf(refused)]).toEqual([409, 'agent_control']);
    expect(s.inputs).toEqual([]);
    // Taking over ends the view opened under the old epoch.
    await s.call('POST', `/sandbox/sessions/${s.sessionId}/takeover`);
    const stale = await s.call('POST', `/sandbox/sessions/${s.sessionId}/live/input`, typed);
    expect(stale.status).toBe(410);
    const reopened = (await (
      await s.call('POST', `/sandbox/sessions/${s.sessionId}/live`)
    ).json()) as {
      live_id: string;
    };
    const accepted = await s.call('POST', `/sandbox/sessions/${s.sessionId}/live/input`, {
      ...typed,
      live_id: reopened.live_id,
    });
    expect(await accepted.json()).toEqual({ accepted: 1 });
    expect(s.inputs).toEqual([{ kind: 'input', events: [{ k: 'text', text: 'hi' }] }]);
    // The live id is bound to the address it was opened from.
    const elsewhere = await s.call(
      'POST',
      `/sandbox/sessions/${s.sessionId}/live/input`,
      { ...typed, live_id: reopened.live_id },
      '10.9.0.2',
    );
    expect([elsewhere.status, await codeOf(elsewhere)]).toEqual([403, 'not_you']);
    // A flood closes the view; control stays with the person.
    const flood = Array.from({ length: 150 }, () => ({ k: 'text', text: 'x' }));
    await s.call('POST', `/sandbox/sessions/${s.sessionId}/live/input`, {
      live_id: reopened.live_id,
      ack_through: 2,
      events: flood,
    });
    const over = await s.call('POST', `/sandbox/sessions/${s.sessionId}/live/input`, {
      live_id: reopened.live_id,
      ack_through: 2,
      events: flood,
    });
    expect([over.status, await codeOf(over)]).toEqual([429, 'slow_down']);
    expect((await s.controls.state(s.sandbox)).control).toBe('human');
  });

  test('a cross-site request cannot take the computer or open its view', async () => {
    const s = await scene();
    for (const headers of [
      { 'Sec-Fetch-Site': 'cross-site' },
      { Origin: 'https://evil.example' },
    ] as Record<string, string>[])
      for (const path of ['takeover', 'live']) {
        const response = await s.call(
          'POST',
          `/sandbox/sessions/${s.sessionId}/${path}`,
          undefined,
          '10.9.0.1',
          headers,
        );
        expect([path, response.status, await codeOf(response)]).toEqual([
          path,
          403,
          'origin_refused',
        ]);
      }
    expect(await s.controls.state(s.sandbox)).toEqual({ control: 'agent', epoch: 0 });
    expect(s.parked).toEqual([]);
  });

  test('a takeover on one instance is seen and handed back on another, and a page showing an older epoch is refused', async () => {
    if (!database) throw new Error('Postgres unavailable');
    const s = await scene();
    const other = openDatabase(database.url);
    try {
      const elsewhere = mount(new SandboxComputerService(other.sql, s.providers), s.owner);
      const path = (operation: string) => `/sandbox/sessions/${s.sessionId}/${operation}`;
      const taken = await s.call('POST', path('takeover'), { control_epoch: 0 });
      expect(await taken.json()).toMatchObject({ control: 'human', control_epoch: 1 });
      const listed = (await (
        await elsewhere('GET', `/sandbox/computers?job_id=${s.scope.jobId}`)
      ).json()) as { computers: Array<{ control: string; control_epoch: number }> };
      expect(listed.computers[0]).toMatchObject({ control: 'human', control_epoch: 1 });
      // A page still showing the agent's epoch cannot hand it back.
      const stale = await elsewhere('POST', path('handback'), { control_epoch: 0 });
      expect([stale.status, await codeOf(stale)]).toEqual([409, 'epoch_changed']);
      const back = await elsewhere('POST', path('handback'), { control_epoch: 1 });
      expect(await back.json()).toMatchObject({ control: 'agent', control_epoch: 2 });
      // Without an epoch, the change is made from the one read now.
      expect((await s.call('POST', path('takeover'))).status).toBe(200);
      expect(await s.controls.state(s.sandbox)).toEqual({ control: 'human', epoch: 3 });
    } finally {
      await other.close();
    }
  });

  test('a live view is closed when who holds the computer cannot be read', async () => {
    let failing = false;
    const s = await scene({
      wrap: (controls) => ({
        state: (sandbox) =>
          failing ? Promise.reject(new Error('database unavailable')) : controls.state(sandbox),
        change: (sandbox, to, options) => controls.change(sandbox, to, options),
        seen: (sandbox) => controls.seen(sandbox),
        handBackUnwatched: (afterMs) => controls.handBackUnwatched(afterMs),
        onChange: (listener) => controls.onChange(listener),
      }),
    });
    const opened = await s.call('POST', `/sandbox/sessions/${s.sessionId}/live`);
    const { live_id: liveId } = (await opened.json()) as { live_id: string };
    failing = true;
    await Bun.sleep(1500);
    failing = false;
    const after = await s.call('POST', `/sandbox/sessions/${s.sessionId}/live/close`, {
      live_id: liveId,
    });
    expect([after.status, await codeOf(after)]).toEqual([410, 'live_closed']);
  });

  test('the room computer can be watched by members and taken over only by owners', async () => {
    const s = await scene();
    // The job becomes a room's request: the room's principal's job, asked by a member.
    const [space] = await s.sql`select owner_principal_id from space where id = ${s.scope.spaceId}`;
    const ownerId = String(space?.owner_principal_id);
    const memberId = recordId('own');
    const roomId = recordId('own');
    const outsiderId = recordId('own');
    for (const [id, kind] of [
      [memberId, 'person'],
      [roomId, 'room'],
      [outsiderId, 'person'],
    ] as const)
      await s.sql`insert into principal (id, email, kind) values (${id}, ${`${id.toLowerCase()}@example.test`}, ${kind})`;
    await s.sql`update space set kind = 'shared', audience = 'space' where id = ${s.scope.spaceId}`;
    await s.sql`insert into space_membership (principal_id, space_id, role) values
      (${ownerId}, ${s.scope.spaceId}, 'owner'), (${memberId}, ${s.scope.spaceId}, 'member'),
      (${roomId}, ${s.scope.spaceId}, 'agent')`;
    await s.sql`update job set principal_id = ${roomId}, audience = 'room',
      requested_by_principal_id = ${memberId} where id = ${s.scope.jobId}`;
    const takeover = `/sandbox/sessions/${s.sessionId}/takeover`;
    // A member, even the one who asked, sees the computer and its screen, and cannot take it.
    s.as(memberId);
    expect((await s.call('GET', `/sandbox/computers?job_id=${s.scope.jobId}`)).status).toBe(200);
    const watching = await s.call('POST', `/sandbox/sessions/${s.sessionId}/live`);
    expect(watching.status).toBe(200);
    const { live_id: liveId } = (await watching.json()) as { live_id: string };
    expect((await s.call('POST', takeover)).status).toBe(404);
    expect((await s.controls.state(s.sandbox)).control).toBe('agent');
    // Someone outside the room finds nothing at all.
    s.as(outsiderId);
    expect((await s.call('GET', `/sandbox/computers?job_id=${s.scope.jobId}`)).status).toBe(404);
    expect((await s.call('POST', `/sandbox/sessions/${s.sessionId}/live`)).status).toBe(404);
    // The room's owner takes it over; the member still cannot type into it.
    s.as(ownerId);
    expect((await s.call('POST', takeover)).status).toBe(200);
    expect((await s.controls.state(s.sandbox)).control).toBe('human');
    s.as(memberId);
    const reopened = await s.call('POST', `/sandbox/sessions/${s.sessionId}/live`);
    const watched = (await reopened.json()) as { live_id: string };
    const typed = await s.call('POST', `/sandbox/sessions/${s.sessionId}/live/input`, {
      live_id: watched.live_id ?? liveId,
      ack_through: 0,
      events: [{ k: 'text', text: 'hi' }],
    });
    expect(typed.status).toBe(404);
    expect(s.inputs).toEqual([]);
    // Once the member leaves the room, they cannot even watch.
    await s.sql`update space_membership set revoked_at = now()
      where space_id = ${s.scope.spaceId} and principal_id = ${memberId}`;
    expect((await s.call('GET', `/sandbox/computers?job_id=${s.scope.jobId}`)).status).toBe(404);
  });

  test('opening the live view counts as watching at once, so a hold reopened at its limit is kept', async () => {
    const s = await scene();
    expect((await s.call('POST', `/sandbox/sessions/${s.sessionId}/takeover`)).status).toBe(200);
    await s.sql`update sandbox_control set seen_at = now() - interval '31 minutes',
      changed_at = now() - interval '31 minutes' where provider_sandbox_id = ${s.sandbox}`;
    expect((await s.call('POST', `/sandbox/sessions/${s.sessionId}/live`)).status).toBe(200);
    // The sweep runs before the view's first tick.
    expect(await s.controls.handBackUnwatched()).not.toContain(s.sandbox);
    expect((await s.controls.state(s.sandbox)).control).toBe('human');
  });
});
