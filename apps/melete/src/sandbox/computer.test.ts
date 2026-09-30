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
import type { DesktopCommand, DockerSandboxProvider } from './adapters/docker.ts';
import { mountSandboxComputers, SandboxComputerService } from './computer.ts';
import { ComputerControls } from './computer-control.ts';
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

async function scene() {
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
  const controls = new ComputerControls();
  const service = new SandboxComputerService(
    sql,
    () => new Map([[scope.connectionId, { adapter: 'docker' as const, provider }]]),
    { controls },
  );
  const parked: string[][] = [];
  service.onPark = (_job, attempts) => parked.push(attempts);
  let owner: Owner = { id: ownerId };
  const app = new Hono();
  app.use(async (c, next) => {
    c.set('owner' as never, owner as never);
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
  return {
    sql,
    scope,
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
    expect(s.controls.state(s.sandbox).control).toBe('agent');
  });

  test('taking over parks the job and fences its attempt; handing back leaves it for the person to answer', async () => {
    const s = await scene();
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
    const [after] = await s.sql`select state from job where id = ${s.scope.jobId}`;
    expect(after?.state).toBe('waiting_for_input');
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
    expect(s.controls.state(s.sandbox).control).toBe('human');
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
    expect(s.controls.state(s.sandbox)).toEqual({ control: 'agent', epoch: 0 });
    expect(s.parked).toEqual([]);
  });
});
