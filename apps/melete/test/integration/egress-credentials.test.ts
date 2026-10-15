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
  return {
    sql,
    claims,
    connectionId,
    broker,
    mint,
    push,
    actionRow,
    relayPort,
    caPem,
    credentials,
    secrets,
  };
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

withDb('where an account is offered', () => {
  test('a command approved and run by a later attempt can still ask for its changes', async () => {
    const { mint, claims, push, actionRow, sql } = await setup({ holdSeconds: 0 });
    // The command was proposed by the first attempt and carried out by the next.
    const token = mint(claims.attempt_id);
    const next = recordId('att');
    await sql`update attempt set outcome = 'completed', ended_at = now() where id = ${claims.attempt_id}`;
    await sql`update job set lease_epoch = 2 where id = ${claims.job_id}`;
    await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
      values (${next}, ${claims.job_id}, 2, 'fake', 'fake', 'scripted')`;
    const answer = await push(token);
    expect(answer?.body).toContain('Waiting for your approval in Melete');
    const row = await actionRow();
    expect(row?.status).toBe('needs_approval');
    expect(row?.attempt_id).toBe(next);
  }, 30_000);

  test('a live attempt at an older revision never takes over a command whose attempt has ended', async () => {
    const { mint, claims, push, actionRow, sql } = await setup({ holdSeconds: 0 });
    const token = mint(claims.attempt_id);
    const next = recordId('att');
    await sql`update attempt set outcome = 'completed', ended_at = now() where id = ${claims.attempt_id}`;
    // The request changed: the job is at revision 1, the live attempt still at 0.
    await sql`update job set lease_epoch = 2, revision = 1 where id = ${claims.job_id}`;
    await sql`insert into attempt (id, job_id, epoch, revision, runtime_version, provider, model)
      values (${next}, ${claims.job_id}, 2, 0, 'fake', 'fake', 'scripted')`;
    const answer = await push(token);
    expect(answer?.status).toBe(403);
    expect(answer?.body).toContain('The work that ran this command has ended.');
    expect(await actionRow()).toBeUndefined();
    expect(upstream.seen).toEqual([]);
  }, 30_000);

  test('a shared space, another audience or a public compartment is never offered the account', async () => {
    const { claims, credentials, sql } = await setup({ holdSeconds: 0 });
    const ask = () =>
      credentials.find({
        space: claims.space_id,
        attribution: {
          kind: 'command',
          sessionId: 'sbx_one',
          jobId: claims.job_id,
          attemptId: claims.attempt_id,
          actionId: 'act_cmd',
        },
        host: HOST,
      });
    expect((await ask())?.connectionId).toBeString();
    expect(await credentials.computer(claims.space_id)).not.toBeNull();
    const refused = async () => {
      expect(await ask()).toBeNull();
      expect(await credentials.computer(claims.space_id)).toBeNull();
      expect(await credentials.hosts(claims.space_id)).toEqual([]);
    };
    await sql`update space set kind = 'shared' where id = ${claims.space_id}`;
    await refused();
    // Any kind other than a person's own fails closed, including ones added later.
    await sql`update space set kind = 'room' where id = ${claims.space_id}`;
    await refused();
    await sql`update space set kind = 'personal', audience = 'public' where id = ${claims.space_id}`;
    await refused();
    await sql`update space set audience = 'owner' where id = ${claims.space_id}`;
    await sql`update job set constraints = constraints || '{"public_compartment": true}'::jsonb
      where id = ${claims.job_id}`;
    expect(await ask()).toBeNull();
  });

  test("a room's own account serves the requests made of the room, and no one's own work there", async () => {
    const { claims, credentials, sql, connectionId } = await setup({ holdSeconds: 0 });
    const room = claims.space_id;
    const person = async (kind: 'person' | 'guest' | 'room') => {
      const id = recordId('own');
      await sql`insert into principal (id, email, kind)
        values (${id}, ${`${id.toLowerCase()}@example.test`}, ${kind})`;
      return id;
    };
    const [owner, member, guest, agent] = await Promise.all([
      person('person'),
      person('person'),
      person('guest'),
      person('room'),
    ]);
    // The seeded space is a room the owner made, and its account one the owner added for the room.
    await sql`update space set kind = 'shared', audience = 'space', owner_principal_id = ${owner}
      where id = ${room}`;
    await sql`update connection set shared_use = 'room' where id = ${connectionId}`;
    // The seeded job is a request the member made of the room's agent.
    await sql`update job set audience = 'room', principal_id = ${agent},
      requested_by_principal_id = ${member} where id = ${claims.job_id}`;
    const job = async (
      space: string,
      principal: string,
      audience: 'principal' | 'room',
      requestedBy: string | null = null,
    ) => {
      const id = recordId('job');
      await sql`insert into job (id, space_id, title, objective, state, lease_epoch, budget,
          constraints, principal_id, audience, requested_by_principal_id)
        values (${id}, ${space}, 'Fixture', 'Push the branch', 'running', 1, '{}'::jsonb,
          '{"public_compartment": false, "allowed_domains": []}'::jsonb, ${principal}, ${audience},
          ${requestedBy})`;
      return id;
    };
    const ask = (jobId: string, space = room) =>
      credentials.find({
        space,
        attribution: {
          kind: 'command',
          sessionId: 'sbx_one',
          jobId,
          attemptId: claims.attempt_id,
          actionId: 'act_cmd',
        },
        host: HOST,
      });

    // The room's request gets the team's account, and the room's computer is set up for it.
    expect((await ask(claims.job_id))?.connectionId).toBe(connectionId);
    expect(await credentials.computer(room)).not.toBeNull();
    expect(await credentials.hosts(room)).toContain(HOST);

    // A member's own work in the room, the owner's own, and a guest's own get nothing.
    for (const principal of [member, owner, guest])
      expect(await ask(await job(room, principal, 'principal'))).toBeNull();

    // Another room's request gets nothing: not through this room's computer, nor its own.
    const other = recordId('sp');
    await sql`insert into space (id, name, git_path, kind, audience, owner_principal_id)
      values (${other}, 'Another room', ${`spaces/${other}`}, 'shared', 'space', ${owner})`;
    const elsewhere = await job(other, agent, 'room', member);
    expect(await ask(elsewhere)).toBeNull();
    expect(await ask(elsewhere, other)).toBeNull();
    expect(await credentials.computer(other)).toBeNull();

    // An account in the room kept for its owner's own work never reaches a room's computer.
    await sql`update connection set shared_use = 'owner' where id = ${connectionId}`;
    expect(await ask(claims.job_id)).toBeNull();
    expect(await ask(await job(room, owner, 'principal'))).toBeNull();
    expect(await credentials.computer(room)).toBeNull();
    expect(await credentials.hosts(room)).toEqual([]);

    // A public compartment is refused even the room's own account.
    await sql`update connection set shared_use = 'room' where id = ${connectionId}`;
    await sql`update job set constraints = constraints || '{"public_compartment": true}'::jsonb
      where id = ${claims.job_id}`;
    expect(await ask(claims.job_id)).toBeNull();
  });

  test("a room's account set to each person's own uses the asker's own account, and nobody else's", async () => {
    const { claims, credentials, sql, connectionId, secrets, mint, relayPort, caPem } = await setup(
      { holdSeconds: 0 },
    );
    const room = claims.space_id;
    const person = async (kind: 'person' | 'room', name: string | null = null) => {
      const id = recordId('own');
      await sql`insert into principal (id, email, kind, display_name)
        values (${id}, ${`${id.toLowerCase()}@example.test`}, ${kind}, ${name})`;
      return id;
    };
    const [owner, ana, ben, cal, dee, agent] = await Promise.all([
      person('person', 'Olive'),
      person('person', 'Ana'),
      person('person', 'Ben'),
      person('person', 'Cal'),
      person('person', 'Dee'),
      person('room'),
    ]);
    await sql`update space set kind = 'shared', audience = 'space', owner_principal_id = ${owner}
      where id = ${room}`;
    for (const [principal, role] of [
      [owner, 'owner'],
      [ana, 'member'],
      [ben, 'member'],
      [cal, 'member'],
      [dee, 'member'],
    ] as const)
      await sql`insert into space_membership (principal_id, space_id, role)
        values (${principal}, ${room}, ${role})`;
    // The room's own account, set to each person's own: its secret is never used.
    await sql`update connection set shared_use = 'room', per_member = true where id = ${connectionId}`;
    // Ana and Ben each connected their own account in their own space; Cal has
    // none, and Dee connected hers for reading only.
    const own = async (
      principal: string,
      secret: string,
      scopes = ['egress.test_read', 'egress.test_write'],
    ) => {
      const space = recordId('sp');
      await sql`insert into space (id, name, git_path, kind, audience, owner_principal_id)
        values (${space}, 'Own', ${`spaces/${space}`}, 'personal', 'owner', ${principal})`;
      const ref = await secrets.put(space, secret);
      await sql`insert into connection (id, space_id, provider, label, scopes, status, secret_ref,
          configuration)
        values (${recordId('conn')}, ${space}, 'command_line', 'Own account',
          ${JSON.stringify(scopes)}::jsonb, 'active', ${ref},
          ${JSON.stringify({ kind: 'command_line', adapter: 'test', config: { hosts: [HOST] } })}::jsonb)`;
    };
    const anaSecret = `tok_${randomBytes(18).toString('hex')}`;
    const benSecret = `tok_${randomBytes(18).toString('hex')}`;
    await own(ana, anaSecret);
    await own(ben, benSecret);
    const deeSecret = `tok_${randomBytes(18).toString('hex')}`;
    await own(dee, deeSecret, ['egress.test_read']);
    const request = async (requestedBy: string, parent: string | null = null) => {
      const id = recordId('job');
      await sql`insert into job (id, space_id, title, objective, state, lease_epoch, budget,
          constraints, principal_id, audience, requested_by_principal_id, experience_parent_id)
        values (${id}, ${room}, 'Fixture', 'Push the branch', 'running', 1, '{}'::jsonb,
          '{"public_compartment": false, "allowed_domains": []}'::jsonb, ${agent},
          'room', ${parent ? null : requestedBy}, ${parent})`;
      return id;
    };
    const ask = (jobId: string) =>
      credentials.find({
        space: room,
        attribution: {
          kind: 'command',
          sessionId: 'sbx_one',
          jobId,
          attemptId: claims.attempt_id,
          actionId: 'act_cmd',
        },
        host: HOST,
      });
    const secretOf = async (jobId: string) => {
      const use = await ask(jobId);
      expect(use?.connectionId).toBe(connectionId);
      expect(use?.missing).toBeUndefined();
      return use?.withSecret(async (secret) => secret);
    };

    // Each request uses the account of the person who asked it; a step, its request's asker's.
    const anas = await request(ana);
    expect(await secretOf(anas)).toBe(anaSecret);
    expect((await ask(anas))?.readOnly).toBeUndefined();
    expect(await secretOf(await request(ben))).toBe(benSecret);
    expect(await secretOf(await request(ana, anas))).toBe(anaSecret);

    // An own account connected for reading reads for its owner, and makes no changes.
    const dees = await request(dee);
    expect(await secretOf(dees)).toBe(deeSecret);
    expect((await ask(dees))?.readOnly).toContain('Dee connected theirs for reading only');

    // Someone with no account of their own is asked to connect one; nothing is opened.
    const missing = await ask(await request(cal));
    expect(missing?.missing).toContain("This room uses each person's own");
    expect(missing?.missing).toContain('Cal has not connected one yet');
    await expect(missing?.withSecret(async (secret) => secret) ?? null).rejects.toThrow();

    // Someone who left the room no longer lends the room their account.
    const bens = await request(ben);
    await sql`update space_membership set revoked_at = now()
      where space_id = ${room} and principal_id = ${ben}`;
    expect((await ask(bens))?.missing).toContain('only a person who is a member of the room');

    // The installation's owner's own space may name no owner; it is still theirs.
    await sql`insert into owner (id, email) values (${recordId('own')}, 'installation@example.test')
      on conflict do nothing`;
    const [installation] = await sql`select id from owner limit 1`;
    const first = String(installation?.id);
    await sql`insert into principal (id, email, kind, display_name)
      values (${first}, ${`${first.toLowerCase()}@example.test`}, 'person', 'Ivy')
      on conflict (id) do update set kind = 'person'`;
    await sql`insert into space_membership (principal_id, space_id, role)
      values (${first}, ${room}, 'member')`;
    const ivySecret = `tok_${randomBytes(18).toString('hex')}`;
    const unnamed = recordId('sp');
    // Older than any other space here, so it is the one their account is read from.
    await sql`insert into space (id, name, git_path, kind, audience, created_at)
      values (${unnamed}, 'Own', ${`spaces/${unnamed}`}, 'personal', 'owner', '2000-01-01')`;
    await sql`insert into connection (id, space_id, provider, label, scopes, status, secret_ref,
        configuration)
      values (${recordId('conn')}, ${unnamed}, 'command_line', 'Own account',
        '["egress.test_read", "egress.test_write"]'::jsonb, 'active',
        ${await secrets.put(unnamed, ivySecret)},
        ${JSON.stringify({ kind: 'command_line', adapter: 'test', config: { hosts: [HOST] } })}::jsonb)`;
    expect(await secretOf(await request(first))).toBe(ivySecret);
    // Nobody else ever reads from it.
    expect((await ask(await request(cal)))?.missing).toContain('Cal has not connected one yet');

    // Through the relay: Ana's request carries Ana's token, and Cal's sends nothing.
    await sql`update job set audience = 'room', principal_id = ${agent},
      requested_by_principal_id = ${ana} where id = ${claims.job_id}`;
    const read = () =>
      throughRelay({
        relayPort,
        host: HOST,
        ca: caPem,
        token: mint(claims.attempt_id),
        requests: [rawRequest('GET', HOST, '/user')],
      }).then((answers) => answers[0]);
    const anaRead = await read();
    expect(anaRead?.status).toBe(200);
    expect(upstream.seen.map((seen) => seen.headers.authorization)).toEqual([
      `Bearer ${anaSecret}`,
    ]);
    await sql`update job set requested_by_principal_id = ${cal} where id = ${claims.job_id}`;
    const calRead = await read();
    expect(calRead?.status).toBe(403);
    expect(calRead?.body).toContain('Cal has not connected one yet');
    // Cal is asked on the screen, once for the turn, and the turn then waits for Cal.
    expect(calRead?.body).toContain('Cal has been asked to connect');
    expect((await read())?.status).toBe(403);
    const asked = await sql`select payload from event
      where dedup_key = ${`${claims.attempt_id}:ask-person`}`;
    expect(asked).toHaveLength(1);
    expect(asked[0]?.payload.question.text).toStartWith('Cal, to do this I need your own');
    expect(upstream.seen).toHaveLength(1);
    // The room's own secret was never sent for anyone.
    expect(upstream.seen.some((seen) => seen.headers.authorization === `Bearer ${SECRET}`)).toBe(
      false,
    );
  });
});
