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
import { ExperienceEvents } from '../experience/events.ts';
import type { DesktopCommand, DockerSandboxProvider } from './adapters/docker.ts';
import type { MaritimeProvider } from './adapters/maritime.ts';
import { mountSandboxComputers, SandboxComputerService } from './computer.ts';
import { type ComputerControls, PostgresComputerControls } from './computer-control.ts';
import { COMPUTER_CHECK_LEFT, handComputerToPerson } from './hand-off.ts';
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

/** A Maritime computer's viewer: the links it minted, and how often they were all ended. */
function maritimeViewer() {
  const minted: { mode: string; ttlSeconds?: number }[] = [];
  let ended = 0;
  let holder: 'human' | 'agent' = 'agent';
  const provider = {
    maritime: true,
    capabilities: { adapter: 'maritime', desktop: true },
    async inspect() {
      return 'running';
    },
    async viewerLink(
      _handle: unknown,
      request: { mode: 'watch' | 'control'; ttlSeconds?: number },
    ) {
      minted.push(request);
      return {
        url: `https://viewer.example.test/${request.mode}/secret-${minted.length}`,
        expiresAt: '2026-10-18T00:10:00.000Z',
        mode: request.mode,
      };
    },
    async endViewers() {
      ended += 1;
    },
    async holder() {
      return holder;
    },
  } as unknown as MaritimeProvider;
  return {
    provider,
    minted,
    ended: () => ended,
    /** Maritime's own word on who holds the desktop. */
    holds(now: 'human' | 'agent') {
      holder = now;
    },
  };
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

/**
 * Another person on the same installation: their own personal space, a job of
 * theirs there, and that job's computer on their space's own connection.
 */
async function person() {
  if (!database) throw new Error('Postgres unavailable');
  const sql = database.sql;
  const id = recordId('prn');
  await sql`insert into principal (id, email) values (${id}, ${`${id}@example.test`})`;
  const scope = await seedSessionScope(sql);
  await sql`update space set kind = 'personal', owner_principal_id = ${id} where id = ${scope.spaceId}`;
  await sql`update job set principal_id = ${id}, state = 'running' where id = ${scope.jobId}`;
  const attemptId = await scope.attempt();
  const sessionId = recordId('sbx');
  const sandbox = `melete-sbx-test-${sessionId.toLowerCase()}`;
  await sql`insert into sandbox_session (id, connection_id, space_id, job_id, attempt_id, agent_id,
      adapter, provider_sandbox_id, image_ref, egress_policy, persistence, status, lease_expires_at)
    values (${sessionId}, ${scope.connectionId}, ${scope.spaceId}, ${scope.jobId}, ${attemptId},
      ${scope.agentId}, 'docker', ${sandbox}, 'melete-sandbox:local', '{"kind":"open"}'::jsonb,
      'pause', 'ready', now() + interval '1 hour')`;
  return { id, scope, sessionId, sandbox };
}

async function scene(
  options: {
    wrap?: (controls: ComputerControls) => ComputerControls;
    /** Other connections this instance serves, with the same desktop. */
    serves?: string[];
    /** A Maritime computer, shown through Maritime's own viewer, instead of Docker's desktop. */
    maritime?: boolean;
  } = {},
) {
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
      ${scope.agentId}, ${options.maritime ? 'maritime' : 'docker'}, ${sandbox}, 'melete-sandbox:local', '{"kind":"deny_all"}'::jsonb,
      'pause', 'ready', now() + interval '1 hour')`;
  const docker = desktop();
  const viewer = maritimeViewer();
  const provider = options.maritime ? viewer.provider : docker.provider;
  const inputs = docker.inputs;
  const stored = new PostgresComputerControls(sql);
  const controls = options.wrap ? options.wrap(stored) : stored;
  const providers = () =>
    new Map(
      [scope.connectionId, ...(options.serves ?? [])].map((id) => [
        id,
        { adapter: options.maritime ? ('maritime' as const) : ('docker' as const), provider },
      ]),
    );
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
    viewer,
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
          view: 'stream',
        },
      ],
    });
    s.as(recordId('own'));
    expect((await s.call('GET', `/sandbox/computers?job_id=${s.scope.jobId}`)).status).toBe(404);
    expect((await s.call('POST', `/sandbox/sessions/${s.sessionId}/takeover`)).status).toBe(404);
    expect((await s.controls.state(s.sandbox)).control).toBe('agent');
  });

  test('another person with a computer of their own can list, take, watch or drive nothing of this one', async () => {
    const other = await person();
    const s = await scene({ serves: [other.scope.connectionId] });
    const mine = s.owner().id;
    const opened = await s.call('POST', `/sandbox/sessions/${s.sessionId}/live`);
    expect(opened.status).toBe(200);
    const { live_id: liveId } = (await opened.json()) as { live_id: string };
    const typed = { live_id: liveId, ack_through: 0, events: [{ k: 'text', text: 'hi' }] };

    s.as(other.id);
    // Their own computer answers them, so each refusal below is about whose computer it is.
    const theirs = await s.call('GET', `/sandbox/computers?job_id=${other.scope.jobId}`);
    expect(theirs.status).toBe(200);
    expect(
      ((await theirs.json()) as { computers: { session_id: string }[] }).computers.map(
        (computer) => computer.session_id,
      ),
    ).toEqual([other.sessionId]);
    // Nothing of this one, by its job, its session or the view its owner holds open, even from
    // the same address the owner opened it from.
    const attempts: [string, 'GET' | 'POST', string, unknown?][] = [
      ['list', 'GET', `/sandbox/computers?job_id=${s.scope.jobId}`],
      ['takeover', 'POST', `/sandbox/sessions/${s.sessionId}/takeover`],
      ['handback', 'POST', `/sandbox/sessions/${s.sessionId}/handback`],
      ['live', 'POST', `/sandbox/sessions/${s.sessionId}/live`],
      ['frames', 'GET', `/sandbox/sessions/${s.sessionId}/live/frames?live_id=${liveId}`],
      ['input', 'POST', `/sandbox/sessions/${s.sessionId}/live/input`, typed],
      ['close', 'POST', `/sandbox/sessions/${s.sessionId}/live/close`, { live_id: liveId }],
    ];
    for (const [what, method, path, body] of attempts) {
      const response = await s.call(method, path, body);
      expect([what, response.status, await codeOf(response)]).toEqual([
        what,
        404,
        'session_not_found',
      ]);
    }
    // The owner's view, carried to their own computer's routes, is not theirs either.
    for (const path of ['input', 'close']) {
      const response = await s.call(
        'POST',
        `/sandbox/sessions/${other.sessionId}/live/${path}`,
        path === 'input' ? typed : { live_id: liveId },
      );
      expect([path, response.status, await codeOf(response)]).toEqual([path, 410, 'live_closed']);
    }
    expect(s.inputs).toEqual([]);
    expect(await s.controls.state(s.sandbox)).toEqual({ control: 'agent', epoch: 0 });
    expect(s.parked).toEqual([]);
    // They steer their own.
    expect((await s.call('POST', `/sandbox/sessions/${other.sessionId}/takeover`)).status).toBe(
      200,
    );
    expect((await s.controls.state(other.sandbox)).control).toBe('human');

    s.as(mine);
    // And the owner nothing of theirs, while their own view is still open and still theirs.
    for (const [what, method, path] of [
      ['list', 'GET', `/sandbox/computers?job_id=${other.scope.jobId}`],
      ['handback', 'POST', `/sandbox/sessions/${other.sessionId}/handback`],
      ['live', 'POST', `/sandbox/sessions/${other.sessionId}/live`],
    ] as const) {
      const response = await s.call(method, path);
      expect([what, response.status]).toEqual([what, 404]);
    }
    expect((await s.controls.state(other.sandbox)).control).toBe('human');
    const closed = await s.call('POST', `/sandbox/sessions/${s.sessionId}/live/close`, {
      live_id: liveId,
    });
    expect(await closed.json()).toEqual({ closed: true });
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

  test('a turn that has ended keeps its wait through a takeover, and a hand-back starts nothing again', async () => {
    for (const ended of [
      {
        state: 'waiting_for_input',
        wait: { kind: 'user_input', question: 'Which of the three should I book?' },
      },
      { state: 'waiting_for_approval', wait: { kind: 'approval' } },
      { state: 'completed', wait: { kind: 'none' } },
    ]) {
      const s = await scene();
      const broker = new BrokerService({ sql: s.sql, connectors: { get: () => undefined } });
      s.service.onHandedBack = (jobId) => broker.resumeAfterControl(jobId, 'Computer control:');
      await s.sql`update attempt set outcome = 'completed', ended_at = now(),
        lease_expires_at = null, lease_status = 'ended' where id = ${s.attemptId}`;
      await s.sql`update job set state = ${ended.state}, wait = ${JSON.stringify(ended.wait)}::jsonb
        where id = ${s.scope.jobId}`;
      const taken = await s.call('POST', `/sandbox/sessions/${s.sessionId}/takeover`);
      expect(await taken.json()).toMatchObject({ control: 'human' });
      const back = await s.call('POST', `/sandbox/sessions/${s.sessionId}/handback`);
      expect(await back.json()).toMatchObject({ control: 'agent' });
      const [job] =
        await s.sql`select state, wait, next_wake_at from job where id = ${s.scope.jobId}`;
      expect({ state: job?.state, wait: job?.wait, next_wake_at: job?.next_wake_at }).toEqual({
        ...ended,
        next_wake_at: null,
      });
      const [attempt] = await s.sql`select outcome from attempt where id = ${s.attemptId}`;
      expect(attempt?.outcome).toBe('completed');
      expect(s.parked).toEqual([]);
    }
  });

  test('a check on the screen hands the work over with a card; a takeover keeps it and the hand-back carries the work on', async () => {
    const s = await scene();
    const broker = new BrokerService({ sql: s.sql, connectors: { get: () => undefined } });
    // Wired as the server wires it.
    s.service.onHandedBack = (jobId, sessionId) =>
      broker.handedBack(jobId, sessionId, 'Computer control:');
    await s.sql`update attempt set epoch = (select lease_epoch from job where id = ${s.scope.jobId})
      where id = ${s.attemptId}`;
    const card = await handComputerToPerson(s.sql, {
      spaceId: s.scope.spaceId,
      jobId: s.scope.jobId,
      sessionId: s.sessionId,
      attemptId: s.attemptId,
      service: 'shop.example',
      current: {
        kind: 'computer.batch',
        payload: {
          step: 3,
          actions: [
            { action: 'open', url: 'https://shop.example/checkout' },
            { action: 'type', text: 'never shown' },
          ],
        },
      },
    });
    expect(card).toMatchObject({
      reason: 'captcha',
      service: 'shop.example',
      done: ['Opened shop.example', 'Typed into the page'],
      left: COMPUTER_CHECK_LEFT,
      take_over: { surface: 'computer', session_id: s.sessionId },
    });
    expect(JSON.stringify(card)).not.toContain('never shown');
    const job = async () =>
      (await s.sql`select state, wait from job where id = ${s.scope.jobId}`)[0] as {
        state: string;
        wait: { question?: string; handoff?: unknown };
      };
    expect((await job()).state).toBe('waiting_for_input');
    expect((await job()).wait.handoff).toEqual(card);
    expect((await job()).wait.question).toStartWith('Over to you at shop.example.');
    const [attempt] =
      await s.sql`select outcome, outcome_detail from attempt where id = ${s.attemptId}`;
    expect(attempt).toMatchObject({
      outcome: 'fenced',
      outcome_detail: { kind: 'handed_to_person', reason: 'captcha' },
    });
    // A second look by the same attempt hands nothing over again.
    expect(
      await handComputerToPerson(s.sql, {
        spaceId: s.scope.spaceId,
        jobId: s.scope.jobId,
        sessionId: s.sessionId,
        attemptId: s.attemptId,
        service: 'shop.example',
        current: { kind: 'computer.screenshot', payload: { step: 4 } },
      }),
    ).toBeNull();

    // Taking the computer over keeps the card: it says what is left.
    expect((await s.call('POST', `/sandbox/sessions/${s.sessionId}/takeover`)).status).toBe(200);
    expect((await job()).wait.handoff).toEqual(card);
    expect(s.parked).toEqual([]);
    // Handing it back carries the work on, told to look afresh.
    expect((await s.call('POST', `/sandbox/sessions/${s.sessionId}/handback`)).status).toBe(200);
    const [after] = await s.sql`select state, next_wake_at from job where id = ${s.scope.jobId}`;
    expect(after?.state).toBe('queued');
    expect(after?.next_wake_at).not.toBeNull();
    const [notice] = await s.sql`select payload from event where job_id = ${s.scope.jobId}
      and type = 'notice' and payload->>'kind' = 'handed_back'`;
    expect(notice?.payload).toMatchObject({
      session_id: s.sessionId,
      fresh_observation_required: true,
    });
  });

  test('a check handed to the person shows in the chat as a card to take over, and the chat waits on them', async () => {
    if (!database) throw new Error('Postgres unavailable');
    const s = await scene();
    // A chat whose turn is under way, as Melete was working on it when the check showed.
    const turnId = recordId('turn');
    await s.sql`insert into experience_turn (id, job_id, agent_id, submission_id, text, status)
      values (${turnId}, ${s.scope.jobId}, ${s.scope.agentId}, ${recordId('sub')},
        'Check out as a guest', 'streaming')`;
    await s.sql`update job set kind = 'chat', current_turn_id = ${turnId} where id = ${s.scope.jobId}`;
    await s.sql`update attempt set epoch = (select lease_epoch from job where id = ${s.scope.jobId}),
      turn_id = ${turnId} where id = ${s.attemptId}`;
    const card = await handComputerToPerson(s.sql, {
      spaceId: s.scope.spaceId,
      jobId: s.scope.jobId,
      sessionId: s.sessionId,
      attemptId: s.attemptId,
      service: 'shop.example',
      current: { kind: 'computer.open', payload: { url: 'https://shop.example/checkout' } },
    });
    expect(card).not.toBeNull();
    // Read again, the chat waits on the person, as Home lists it.
    const [turn] = await s.sql`select status from experience_turn where id = ${turnId}`;
    expect(turn?.status).toBe('needs_you');
    const other = openDatabase(database.url);
    try {
      const stream = new ExperienceEvents(other.db);
      const { events } = await stream.page(s.scope.spaceId, 0, s.scope.jobId, 100, s.owner().id);
      const items = events.map((event) => event.item);
      // A card says where the work is stuck, what is left and what is done, with a Take over.
      expect(items.filter((item) => item.type === 'card')).toEqual([
        {
          type: 'card',
          card: {
            id: expect.stringMatching(/^handoff_\d+$/),
            title: 'Over to you at shop.example',
            meta: 'Needs you',
            facts: [
              { label: 'About', value: COMPUTER_CHECK_LEFT },
              { label: 'Done so far', value: 'Opened shop.example' },
            ],
            primary_action: {
              label: 'Take over',
              kind: 'take_over',
              handle: s.sessionId,
              surface: 'computer',
            },
            secondary_actions: [],
            source_connection: null,
          },
        },
      ]);
      // The composer no longer says Melete is working: the turn waits on the person.
      const statuses = items.flatMap((item) => (item.type === 'status' ? [item] : []));
      expect(statuses.at(-1)).toEqual({ type: 'status', status: 'needs_you', composer: 'send' });
      expect(statuses.some((item) => item.status === 'working')).toBe(false);
    } finally {
      await other.close();
    }
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
        heldAnywhere: (sandbox) => controls.heldAnywhere(sandbox),
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

withDb('a computer shown through its provider’s own viewer', () => {
  test('it is listed with its own screen and how it is shown, and has no live view here', async () => {
    const s = await scene({ maritime: true });
    const listed = (await (
      await s.call('GET', `/sandbox/computers?job_id=${s.scope.jobId}`)
    ).json()) as { computers: Record<string, unknown>[] };
    expect(listed.computers).toEqual([
      expect.objectContaining({
        session_id: s.sessionId,
        running: true,
        control: 'agent',
        viewport: { width: 1200, height: 750 },
        view: 'link',
      }),
    ]);
    const live = await s.call('POST', `/sandbox/sessions/${s.sessionId}/live`);
    expect([live.status, await codeOf(live)]).toEqual([409, 'own_viewer']);
  });

  test('watching takes a link at any time; driving takes one only after taking over', async () => {
    const s = await scene({ maritime: true });
    const viewer = `/sandbox/sessions/${s.sessionId}/viewer`;
    const watch = await s.call('POST', viewer, { mode: 'watch' });
    expect(watch.status).toBe(200);
    expect(watch.headers.get('cache-control')).toBe('no-store');
    expect(await watch.json()).toEqual({
      mode: 'watch',
      url: 'https://viewer.example.test/watch/secret-1',
      expires_at: '2026-10-18T00:10:00.000Z',
    });
    const early = await s.call('POST', viewer, { mode: 'control' });
    expect([early.status, await codeOf(early)]).toEqual([409, 'agent_control']);
    expect(s.viewer.minted).toEqual([{ mode: 'watch', ttlSeconds: 600 }]);
    expect((await s.call('POST', `/sandbox/sessions/${s.sessionId}/takeover`)).status).toBe(200);
    // The job is parked as on Docker: the agent waits for the hand-back.
    const [job] = await s.sql`select state from job where id = ${s.scope.jobId}`;
    expect(job?.state).toBe('waiting_for_input');
    const control = await s.call('POST', viewer, { mode: 'control' });
    expect(control.status).toBe(200);
    expect(((await control.json()) as { mode: string }).mode).toBe('control');
    // A link to drive it lasts the provider's short default: no length is asked for.
    expect(s.viewer.minted.at(-1)).toEqual({ mode: 'control' });
    const refused = await s.call('POST', viewer, { mode: 'everything' });
    expect(refused.status).toBeGreaterThanOrEqual(400);
  });

  test('handing back ends every link, wakes the work, and no link is stored or logged', async () => {
    const s = await scene({ maritime: true });
    const written: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    const resumed: string[] = [];
    s.service.onHandedBack = async (jobId) => {
      resumed.push(jobId);
    };
    try {
      await s.call('POST', `/sandbox/sessions/${s.sessionId}/viewer`, { mode: 'watch' });
      await s.call('POST', `/sandbox/sessions/${s.sessionId}/takeover`);
      await s.call('POST', `/sandbox/sessions/${s.sessionId}/viewer`, { mode: 'control' });
      expect(s.viewer.ended()).toBe(0);
      const back = await s.call('POST', `/sandbox/sessions/${s.sessionId}/handback`);
      expect(back.status).toBe(200);
      expect(s.viewer.ended()).toBe(1);
      expect(resumed).toEqual([s.scope.jobId]);
      expect(await s.controls.state(s.sandbox)).toMatchObject({ control: 'agent' });
      // Driving needs control again.
      const after = await s.call('POST', `/sandbox/sessions/${s.sessionId}/viewer`, {
        mode: 'control',
      });
      expect(after.status).toBe(409);
    } finally {
      process.stderr.write = write;
    }
    const events = await s.sql`select type, payload from event where job_id = ${s.scope.jobId}`;
    expect(events.length).toBeGreaterThan(0);
    const stored = JSON.stringify(events);
    expect(stored).toContain('computer_handback');
    expect(stored).not.toContain('viewer.example.test');
    expect(stored).not.toContain('secret-');
    expect(written.join('')).not.toContain('viewer.example.test');
  });

  test('it is not handed back while the person still holds it in the viewer', async () => {
    const s = await scene({ maritime: true });
    await s.call('POST', `/sandbox/sessions/${s.sessionId}/takeover`);
    await s.call('POST', `/sandbox/sessions/${s.sessionId}/viewer`, { mode: 'control' });
    s.viewer.holds('human');
    const early = await s.call('POST', `/sandbox/sessions/${s.sessionId}/handback`);
    expect([early.status, await codeOf(early)]).toEqual([409, 'finish_in_viewer']);
    expect((await s.controls.state(s.sandbox)).control).toBe('human');
    expect(s.viewer.ended()).toBe(0);
    // Done pressed in the viewer: now it goes back.
    s.viewer.holds('agent');
    expect((await s.call('POST', `/sandbox/sessions/${s.sessionId}/handback`)).status).toBe(200);
    expect((await s.controls.state(s.sandbox)).control).toBe('agent');
  });

  test('another person can get no link to it, to watch or to drive', async () => {
    const s = await scene({ maritime: true });
    s.as(recordId('own'));
    for (const mode of ['watch', 'control']) {
      const response = await s.call('POST', `/sandbox/sessions/${s.sessionId}/viewer`, { mode });
      expect([mode, response.status, await codeOf(response)]).toEqual([
        mode,
        404,
        'session_not_found',
      ]);
    }
    expect(s.viewer.minted).toEqual([]);
  });

  test('a Docker computer has no viewer link to give', async () => {
    const s = await scene();
    const response = await s.call('POST', `/sandbox/sessions/${s.sessionId}/viewer`, {
      mode: 'watch',
    });
    expect([response.status, await codeOf(response)]).toEqual([409, 'live_view_only']);
  });
});
