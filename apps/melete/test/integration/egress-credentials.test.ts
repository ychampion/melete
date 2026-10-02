/**
 * A connected command-line account end to end, against Postgres: the relay
 * looks the account up for the command's space, opens its sealed secret for
 * each request, and brings every write to the real broker, which asks the
 * person with the exact request and admits it once.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { egressAdmission } from '../../src/broker/egress-admission.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService, EGRESS_RERUN } from '../../src/broker/service.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { PostgresSecretRepository, SealedSecretStore } from '../../src/connectors/secrets.ts';
import { credentialAdapters } from '../../src/egress/adapters/index.ts';
import { EgressCertificateAuthority, postgresEgressCaStore } from '../../src/egress/ca.ts';
import { createCommandLineConnector } from '../../src/egress/connector.ts';
import { postgresEgressCredentials } from '../../src/egress/credentials.ts';
import { fixtureUpstream, rawRequest, throughRelay } from '../../src/egress/fixtures.ts';
import { SandboxEgressGuard } from '../../src/sandbox/adapters/docker-egress.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const db = await testDatabase();
const withDb = db ? describe : describe.skip;
const HOST = 'api.creds.test';
const SECRET = `tok_${randomBytes(18).toString('hex')}`;
const upstream = await fixtureUpstream(HOST);
afterAll(async () => {
  await upstream.close();
  await db?.close();
}, 15_000);
beforeEach(() => {
  upstream.seen.length = 0;
});

const guards: SandboxEgressGuard[] = [];
afterAll(async () => {
  for (const guard of guards) await guard.close();
});

async function setup(options: { holdSeconds: number }) {
  if (!db) throw new Error('Postgres is unavailable');
  const { sql } = db;
  const { claims, connectionId } = await seedJob(sql, {
    provider: 'command_line',
    scopes: ['egress.test_read', 'egress.test_write'],
  });
  const masterKey = randomBytes(32).toString('hex');
  const secrets = new SealedSecretStore(new PostgresSecretRepository(sql), () => masterKey);
  const secretId = await secrets.put(claims.space_id, SECRET);
  await sql`update connection set secret_ref = ${secretId},
    configuration = ${JSON.stringify({ kind: 'command_line', adapter: 'test', config: { hosts: [HOST] } })}::jsonb
    where id = ${connectionId}`;
  const broker = new BrokerService({
    sql,
    connectors: new ConnectorRegistry().register(connectionId, createCommandLineConnector('test')),
  });
  const ca = new EgressCertificateAuthority({
    store: postgresEgressCaStore(sql),
    sealer: secrets,
    constraints: ['test'],
  });
  const credentials = postgresEgressCredentials({
    sql,
    secrets,
    adapters: credentialAdapters({ test: true }),
    ca,
    admission: egressAdmission(broker, { pollMs: 50 }),
  });
  const guard = new SandboxEgressGuard({
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    dial: () => connect(upstream.port, '127.0.0.1'),
    credentials,
    intercept: {
      upstream: () => ({ address: { address: '127.0.0.1', family: 4 }, port: upstream.port }),
      upstreamCa: upstream.ca,
      approvalHoldSeconds: options.holdSeconds,
    },
  });
  guards.push(guard);
  const relayPort = await guard.listen(0, '127.0.0.1');
  const sandbox = `melete-sbx-${recordId('sbx').toLowerCase()}`;
  guard.allow('127.0.0.1', sandbox, { mode: 'open', session: 'sbx_one', space: claims.space_id });
  const mint = (attemptId: string) =>
    guard.mint(sandbox, {
      kind: 'command',
      sessionId: 'sbx_one',
      jobId: claims.job_id,
      attemptId,
      actionId: 'act_cmd',
      deadlineAt: Date.now() + 120_000,
    });
  const caPem = (await ca.certificate()).pem;
  const push = (token: string) =>
    throughRelay({
      relayPort,
      host: HOST,
      ca: caPem,
      token,
      requests: [
        rawRequest('POST', HOST, '/repos/alice/site/pulls', {
          headers: { 'content-type': 'application/json' },
          body: '{"title":"Fix login","head":"melete/fix-login","base":"main"}',
        }),
      ],
    }).then((answers) => answers[0]);
  const actionRow = async () => {
    const [row] = await sql`select * from action where job_id = ${claims.job_id}
      and kind = 'egress.test_write' order by created_at desc limit 1`;
    return row;
  };
  return { sql, claims, connectionId, broker, mint, push, actionRow, relayPort, caPem };
}

const waitFor = async <T>(read: () => Promise<T | undefined>, ms = 10_000): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

withDb('a connected command-line account', () => {
  test('a read through a connected host is injected with the sealed secret, and the answer is redacted', async () => {
    const { mint, claims, relayPort, caPem } = await setup({ holdSeconds: 0 });
    const [answer] = await throughRelay({
      relayPort,
      host: HOST,
      ca: caPem,
      token: mint(claims.attempt_id),
      requests: [rawRequest('GET', HOST, '/user')],
    });
    expect(answer?.status).toBe(200);
    expect(upstream.seen[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(answer?.body).not.toContain(SECRET);
    expect(answer?.body).toContain('[redacted]');
  });

  test('a write waits for approval within the hold and proceeds when approved', async () => {
    const { mint, claims, push, actionRow, broker } = await setup({ holdSeconds: 20 });
    const pending = push(mint(claims.attempt_id));
    const row = await waitFor(async () => {
      const found = await actionRow();
      return found?.status === 'needs_approval' ? found : undefined;
    });
    // The person is asked with the exact request.
    expect(row.canonical_payload).toMatchObject({
      host: HOST,
      method: 'POST',
      url_path: '/repos/alice/site/pulls',
      body: { json: { base: 'main', head: 'melete/fix-login', title: 'Fix login' } },
      destructive: false,
      summary: { title: `POST /repos/alice/site/pulls on ${HOST}` },
    });
    expect(row.effect_class).toBe('write_external');
    expect(upstream.seen).toEqual([]);
    await broker.decide(row.id, { decision: 'approved', payload_hash: row.payload_hash });
    const answer = await pending;
    expect(answer?.status).toBe(200);
    expect(upstream.seen.map((request) => [request.method, request.headers.authorization])).toEqual(
      [['POST', `Bearer ${SECRET}`]],
    );
    const done = await actionRow();
    expect(done?.status).toBe('succeeded');
    expect(done?.receipt?.detail).toMatchObject({ host: HOST, method: 'POST', status: 200 });
    expect(JSON.stringify(done?.receipt)).not.toContain(SECRET);
  }, 30_000);

  test('a write not approved in time fails the command with a plain message, and the job waits for approval', async () => {
    const { mint, claims, push, actionRow, sql } = await setup({ holdSeconds: 1 });
    const answer = await push(mint(claims.attempt_id));
    const row = await actionRow();
    expect(answer?.status).toBe(403);
    expect(answer?.headers['content-type']).toStartWith('text/plain');
    expect(answer?.body).toContain('Waiting for your approval in Melete');
    expect(answer?.body).toContain('Run the same command again once it is approved.');
    expect(answer?.headers['x-melete-approval']).toBe(row?.id);
    expect(row?.status).toBe('needs_approval');
    expect(row?.attempt_id).toBe(claims.attempt_id);
    const [job] = await sql`select state from job where id = ${claims.job_id}`;
    expect(job?.state).toBe('waiting_for_approval');
    expect(upstream.seen).toEqual([]);
  }, 30_000);

  test('a re-run after approval is admitted once, and a third run is refused as already done', async () => {
    const { mint, claims, push, actionRow, sql, broker } = await setup({ holdSeconds: 0 });
    expect((await push(mint(claims.attempt_id)))?.status).toBe(403);
    const row = await actionRow();
    if (!row) throw new Error('no action');
    await broker.decide(row.id, { decision: 'approved', payload_hash: row.payload_hash });
    // The job wakes into a new attempt.
    const next = recordId('att');
    await sql`update attempt set outcome = 'completed', ended_at = now() where id = ${claims.attempt_id}`;
    await sql`update job set lease_epoch = 2, state = 'running' where id = ${claims.job_id}`;
    await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
      values (${next}, ${claims.job_id}, 2, 'fake', 'fake', 'scripted')`;
    const claimsNext = { ...claims, attempt_id: next, epoch: 2 };
    // Resuming does not replay the bytes from here; it says to run the command again.
    const resumed = await broker.resume(claimsNext, row.id);
    expect(resumed.message).toBe(EGRESS_RERUN);
    expect(upstream.seen).toEqual([]);
    const second = await push(mint(next));
    expect(second?.status).toBe(200);
    expect(upstream.seen).toHaveLength(1);
    expect((await actionRow())?.id).toBe(row.id);
    const third = await push(mint(next));
    expect(third?.status).toBe(409);
    expect(third?.body).toContain('already succeeded');
    expect(upstream.seen).toHaveLength(1);
  }, 30_000);

  test('the write tool is never offered to the model, and proposing it directly is refused', async () => {
    const { broker, claims, connectionId } = await setup({ holdSeconds: 0 });
    const tools = await broker.catalog(claims);
    expect(tools.map((tool) => tool.name)).not.toContain('egress.test_write');
    const refused = await broker
      .propose(claims, {
        kind: 'egress.test_write',
        connection_id: connectionId,
        payload: { a: 1 },
      })
      .then(
        () => null,
        (error: Error) => error.message,
      );
    expect(refused).toContain('Commands in the agent');
  });
});
