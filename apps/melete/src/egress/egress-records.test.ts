/**
 * Where the agent's computer reached, kept in Postgres: what the guard sees
 * becomes one row per tunnel or refusal, in the space of the computer's own
 * session, completed when the tunnel closes, summed per host for a receipt,
 * and removed after the retention period or with its space.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { connect, createServer, type Socket } from 'node:net';
import { testDatabase } from '../../test/helpers/database.ts';
import { recordId } from '../broker/records.ts';
import { SandboxEgressGuard } from '../sandbox/adapters/docker-egress.ts';
import { seedSessionScope } from '../sandbox/session-fixtures.ts';
import { egressHostsFor, egressRecorder, expireEgressRecords, newHostsFor } from './records.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;

beforeEach(async () => {
  if (handle) await handle.sql`truncate space cascade`;
});
afterAll(async () => handle?.close());

withDb('egress records', () => {
  const setup = async () => {
    if (!handle) throw new Error('Postgres is unavailable');
    const { sql } = handle;
    const scope = await seedSessionScope(sql);
    const attemptId = await scope.attempt();
    const actionId = await scope.action(attemptId);
    const sessionId = recordId('sbx');
    await sql`insert into sandbox_session (id, connection_id, space_id, job_id, attempt_id,
        adapter, provider_sandbox_id, image_ref, egress_policy, persistence, status,
        lease_expires_at)
      values (${sessionId}, ${scope.connectionId}, ${scope.spaceId}, ${scope.jobId}, ${attemptId},
        'docker', ${`melete-sbx-test-${sessionId}`}, 'base', '{"kind":"open"}'::jsonb,
        'ephemeral', 'ready', now() + interval '5 minutes')`;
    const lines: string[] = [];
    const recorder = egressRecorder(sql, (line) => lines.push(line));
    return { sql, scope, attemptId, actionId, sessionId, recorder, lines };
  };

  test("a record takes its space from the computer's session, and is completed when the tunnel closes", async () => {
    const { sql, scope, attemptId, actionId, sessionId, recorder, lines } = await setup();
    const openedAt = new Date();
    recorder.opened({
      id: 'egr_tunnel',
      sessionId,
      jobId: scope.jobId,
      attemptId,
      actionId,
      tokenKind: 'command',
      host: 'github.com',
      port: 443,
      verdict: 'tunnel',
      reason: null,
      count: 1,
      openedAt,
    });
    recorder.closed('egr_tunnel', { bytesUp: 512, bytesDown: 70_000, closedAt: new Date() });
    await recorder.flush();
    const [row] = await sql`select * from egress_record where id = 'egr_tunnel'`;
    expect(row).toMatchObject({
      session_id: sessionId,
      space_id: scope.spaceId,
      job_id: scope.jobId,
      action_id: actionId,
      token_kind: 'command',
      host: 'github.com',
      verdict: 'tunnel',
      reads: 0,
      writes: 0,
    });
    expect([Number(row?.bytes_up), Number(row?.bytes_down)]).toEqual([512, 70_000]);
    expect(row?.closed_at).not.toBeNull();
    expect(lines).toEqual([]);
  });

  test('a record for a session that is not there is not written, and a refused write is reported, never thrown', async () => {
    const { sql, sessionId, recorder, lines } = await setup();
    recorder.opened({
      id: 'egr_nowhere',
      sessionId: 'sbx_missing',
      jobId: null,
      attemptId: null,
      actionId: null,
      tokenKind: null,
      host: 'example.com',
      port: 443,
      verdict: 'unattributed',
      reason: null,
      count: 1,
      openedAt: new Date(),
    });
    recorder.opened({
      id: 'egr_bad',
      sessionId,
      jobId: null,
      attemptId: null,
      actionId: null,
      tokenKind: null,
      host: 'example.com',
      port: 443,
      // Refused by the table's own check: reported, never thrown at the guard.
      verdict: 'sideways' as 'tunnel',
      reason: null,
      count: 1,
      openedAt: new Date(),
    });
    recorder.closed('egr_nowhere', { bytesUp: 1, bytesDown: 1, closedAt: new Date() });
    await recorder.flush();
    expect(await sql`select id from egress_record`).toHaveLength(0);
    expect(lines).toEqual([expect.stringContaining('an egress record could not be written')]);
  });

  test("what the guard sees over real sockets lands in the computer's records", async () => {
    const { sql, scope, attemptId, actionId, sessionId, recorder } = await setup();
    const echo = createServer((socket) => {
      socket.on('data', (data) => socket.write(data));
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    const echoPort = (echo.address() as { port: number }).port;
    const guard = new SandboxEgressGuard({
      records: recorder,
      resolve: async () => [{ address: '93.184.215.14', family: 4 }],
      dial: () => connect(echoPort, '127.0.0.1'),
    });
    const port = await guard.listen(0, '127.0.0.1');
    try {
      guard.allow('127.0.0.1', `melete-sbx-test-${sessionId}`, {
        session: sessionId,
        space: scope.spaceId,
      });
      const token = guard.mint(`melete-sbx-test-${sessionId}`, {
        kind: 'command',
        sessionId,
        jobId: scope.jobId,
        attemptId,
        actionId,
      });
      const auth = Buffer.from(`cmd:${token}`).toString('base64');
      const client: Socket = connect(port, '127.0.0.1');
      let seen = '';
      client.on('data', (data) => {
        seen += data.toString();
      });
      await new Promise<void>((resolve) => client.once('connect', () => resolve()));
      client.write(
        `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
      );
      for (let tries = 0; tries < 100 && !seen.includes('\r\n\r\n'); tries += 1)
        await Bun.sleep(20);
      client.write('ping');
      for (let tries = 0; tries < 100 && !seen.endsWith('ping'); tries += 1) await Bun.sleep(20);
      expect(guard.tokens.settle(token)).toEqual([
        { host: 'example.com', tunnels: 1, refused: 0, bytes_up: 4, bytes_down: 4 },
      ]);
      const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
      client.destroy();
      await closed;
      await Bun.sleep(50);
      await recorder.flush();
      expect(await egressHostsFor(sql, actionId)).toEqual([
        { host: 'example.com', tunnels: 1, refused: 0, bytes_up: 4, bytes_down: 4 },
      ]);
    } finally {
      await guard.close();
      await new Promise<void>((resolve) => echo.close(() => resolve()));
    }
  });

  test("a coalesced refusal's count reaches its row, and a receipt read back sums the counts", async () => {
    const { sql, scope, attemptId, actionId, sessionId, recorder } = await setup();
    const base = {
      sessionId,
      jobId: scope.jobId,
      attemptId,
      actionId,
      tokenKind: 'command' as const,
      port: 443,
      openedAt: new Date(),
      closedAt: new Date(),
    };
    recorder.opened({
      ...base,
      id: 'egr_refused',
      host: 'blocked.example',
      verdict: 'refused',
      reason: 'host_not_connected',
      count: 1,
    });
    recorder.counted('egr_refused', 40);
    // A late, smaller count never lowers what was written.
    recorder.counted('egr_refused', 12);
    recorder.opened({
      ...base,
      id: 'egr_over',
      host: '',
      port: 0,
      actionId: null,
      verdict: 'suppressed',
      reason: 'over_record_budget',
      count: 1,
    });
    recorder.counted('egr_over', 900);
    await recorder.flush();
    const rows = await sql`select id, count from egress_record order by id`;
    expect(rows.map((row) => [row.id, Number(row.count)])).toEqual([
      ['egr_over', 900],
      ['egr_refused', 40],
    ]);
    expect(await egressHostsFor(sql, actionId)).toEqual([
      { host: 'blocked.example', tunnels: 0, refused: 40, bytes_up: 0, bytes_down: 0 },
    ]);
  });

  test('a host is new until an earlier connection from the space reached it', async () => {
    const { sql, scope, sessionId, actionId } = await setup();
    const before = new Date();
    await sql`insert into egress_record (id, session_id, space_id, action_id, host, port, verdict, opened_at)
      values
        ('egr_earlier', ${sessionId}, ${scope.spaceId}, null, 'pypi.org', 443, 'unattributed',
          now() - interval '1 day'),
        ('egr_refused', ${sessionId}, ${scope.spaceId}, null, 'blocked.example', 443, 'refused',
          now() - interval '1 day'),
        ('egr_this', ${sessionId}, ${scope.spaceId}, ${actionId}, 'httpbin.org', 443, 'tunnel',
          now() - interval '1 minute'),
        ('egr_later', ${sessionId}, ${scope.spaceId}, null, 'example.com', 443, 'tunnel',
          now() + interval '1 minute')`;
    expect(
      await newHostsFor(sql, {
        sessionId,
        actionId,
        hosts: ['pypi.org', 'httpbin.org', 'example.com', 'blocked.example'],
        before,
      }),
    ).toEqual(['blocked.example', 'example.com', 'httpbin.org']);
    expect(await newHostsFor(sql, { sessionId, actionId, hosts: [], before })).toEqual([]);
  });

  test('records past the retention period are removed, and the rest are kept', async () => {
    const { sql, scope, sessionId } = await setup();
    await sql`insert into egress_record (id, session_id, space_id, host, port, verdict, opened_at)
      values
        ('egr_old', ${sessionId}, ${scope.spaceId}, 'example.com', 443, 'unattributed',
          now() - interval '31 days'),
        ('egr_new', ${sessionId}, ${scope.spaceId}, 'example.com', 443, 'unattributed',
          now() - interval '29 days')`;
    expect(await expireEgressRecords(sql, 30)).toBe(1);
    expect((await sql`select id from egress_record`).map((row) => row.id)).toEqual(['egr_new']);
  });

  test('a removed space takes its egress records with it', async () => {
    const { sql, scope, sessionId } = await setup();
    await sql`insert into egress_record (id, session_id, space_id, host, port, verdict, opened_at)
      values ('egr_gone', ${sessionId}, ${scope.spaceId}, 'example.com', 443, 'tunnel', now())`;
    // Actions hold their connection; the space's own removal clears them first.
    await sql`delete from action where job_id = ${scope.jobId}`;
    await sql`delete from space where id = ${scope.spaceId}`;
    expect(await sql`select id from egress_record`).toHaveLength(0);
  });
});
