/**
 * Two service instances on one database. Each instance here has its own
 * connection pool, its own app and its own services, as two processes would;
 * all they share is Postgres.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { type DatabaseHandle, openDatabase } from '../../src/db/client.ts';
import { loadEnv } from '../../src/env.ts';
import { FeedbackLimiter } from '../../src/feedback/rate-limit.ts';
import { PostgresCredentialRepository, ProviderSignIn } from '../../src/gateway/credentials.ts';
import { type FakeIssuer, startFakeIssuer } from '../../src/gateway/fixtures/fake-oauth.ts';
import { chatgptIssuer } from '../../src/gateway/oauth.ts';
import { createApp } from '../../src/index.ts';
import { InstanceRegistry } from '../../src/ops/instance.ts';
import { LEASE_SPACE, Leases, leaseConnection } from '../../src/ops/leader.ts';
import { FailureWindow, PostgresLimitStore } from '../../src/ops/limiter.ts';
import { PostgresSignInStore, signInKey } from '../../src/ops/signin-store.ts';
import type { SandboxSessions } from '../../src/sandbox/sessions.ts';
import { startSandboxes } from '../../src/sandbox/wiring.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const describeWithDb = handle ? describe : describe.skip;
const masterKey = randomBytes(32).toString('hex');
const password = 'my-test-password';
const email = 'owner@example.test';

/** The second instance's own pool on the same database. */
let other: DatabaseHandle | undefined;
const pools = () => {
  if (!handle) throw new Error('Postgres is unavailable');
  other ??= openDatabase(handle.url);
  return [handle, other] as const;
};

let issuer: FakeIssuer | undefined;

/** One instance's app: its own pool, sign-in service and in-process state. */
function instance(pool: DatabaseHandle) {
  const env = loadEnv({ NODE_ENV: 'test', MELETE_MASTER_KEY: masterKey });
  const signIn = issuer
    ? new ProviderSignIn({
        repository: new PostgresCredentialRepository(pool.sql),
        issuers: { chatgpt: chatgptIssuer({ issuer: issuer.url }) },
        masterKey: () => masterKey,
        store: new PostgresSignInStore(pool.sql, () => masterKey),
        log: () => {},
      })
    : undefined;
  return createApp({
    env,
    db: pool.db,
    sql: pool.sql,
    providerSignIn: signIn,
    checkDatabase: async () => 'ok',
  });
}

const json = (body: unknown, cookie?: string): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
});
const sessionOf = (response: Response) =>
  response.headers.get('set-cookie')?.split(';')[0] ?? 'missing';

describeWithDb('two service instances on one database', () => {
  beforeEach(async () => {
    await resetTestRows(pools()[0].sql);
    await pools()[0].sql`delete from ops_instance`;
  });

  afterEach(async () => {
    await issuer?.stop();
    issuer = undefined;
  });

  afterAll(async () => {
    await other?.close();
    await handle?.close();
  });

  test('a try is counted before the work it guards, so concurrent tries on two instances stop at the limit', async () => {
    const [one, two] = pools();
    const stores = [new PostgresLimitStore(one.sql), new PostgresLimitStore(two.sql)];
    // Wrong pairing codes: twenty guesses at once, half through each instance.
    const windows = stores.map((store) => new FailureWindow(store, 'device.pair', 10, 600_000));
    const waits = await Promise.all(
      Array.from({ length: 20 }, (_, index) => windows[index % 2]?.reserve('198.51.100.20') ?? 0),
    );
    expect(waits.filter((wait) => wait === 0)).toHaveLength(10);
    // Problem reports: the same budget whichever instance takes them.
    const limiters = stores.map((store) => new FeedbackLimiter(undefined, 5, 600_000, store));
    const sent = await Promise.all(
      Array.from({ length: 12 }, (_, index) => limiters[index % 2]?.admit('own_reporter') ?? 0),
    );
    expect(sent.filter((wait) => wait === 0)).toHaveLength(5);
  });

  test('limits hold across two instances on one database', async () => {
    const [one, two] = pools().map(instance);
    if (!one || !two) throw new Error('Two instances are needed');
    expect((await one.request('/setup', json({ email, password }))).status).toBe(201);
    const from = { clientAddress: '198.51.100.9' };
    const statuses: number[] = [];
    // A guesser alternates between the instances; they count one budget.
    for (let attempt = 0; attempt < 6; attempt++) {
      const api = attempt % 2 === 0 ? one : two;
      statuses.push(
        (await api.request('/login', json({ email, password: `wrong-password-${attempt}` }), from))
          .status,
      );
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    // The wait is the same on either instance, and another address is untouched.
    expect((await one.request('/login', json({ email, password }), from)).status).toBe(429);
    const elsewhere = { clientAddress: '198.51.100.10' };
    expect((await one.request('/login', json({ email, password }), elsewhere)).status).toBe(200);
    // The table names no address or account.
    const rows = await pools()[0].sql`select key, scope from rate_limit_window`;
    expect(JSON.stringify(rows)).not.toContain('198.51.100.9');
    expect(JSON.stringify(rows)).not.toContain(email);
  });

  test('a sign-in started on one instance finishes on the other', async () => {
    issuer = await startFakeIssuer();
    const [one, two] = pools().map(instance);
    if (!one || !two) throw new Error('Two instances are needed');
    const cookie = sessionOf(await one.request('/setup', json({ email, password })));
    const started = (await (
      await one.request('/model-providers/chatgpt/sign-in', json({ method: 'browser' }, cookie))
    ).json()) as { sign_in_id: string; authorize_url: string };
    // The other instance sees it waiting.
    const states = (await (
      await two.request('/model-providers/sign-in', { headers: { cookie } })
    ).json()) as { providers: Array<{ state: string }> };
    expect(states.providers[0]?.state).toBe('pending');
    const state = new URL(started.authorize_url).searchParams.get('state') ?? '';
    const stored = JSON.stringify(await pools()[0].sql`select * from signin_pending`);
    expect(stored).not.toContain(state);
    expect(stored).not.toContain(started.sign_in_id);

    const callback =
      (await fetch(started.authorize_url, { redirect: 'manual' })).headers.get('location') ?? '';
    const finish = (api: typeof one) =>
      api.request(
        '/model-providers/chatgpt/sign-in/complete',
        json({ sign_in_id: started.sign_in_id, callback_url: callback }, cookie),
      );
    const done = await finish(two);
    expect(done.status).toBe(200);
    expect(((await done.json()) as { state: string }).state).toBe('signed_in');
    // Spent: the first instance cannot finish it again.
    expect((await finish(one)).status).toBe(404);
    expect(await pools()[0].sql`select 1 from signin_pending`).toHaveLength(0);
  });

  test('a waiting sign-in opens only on the row it was written for, and only once', async () => {
    const [one, two] = pools();
    const first = new PostgresSignInStore(one.sql, () => masterKey);
    const second = new PostgresSignInStore(two.sql, () => masterKey);
    const now = Date.now();
    await first.put('mcp', 'one', { verifier: 'v-one' }, now + 60_000);
    await first.put('mcp', 'two', { verifier: 'v-two' }, now + 60_000);
    expect(await second.get<{ verifier: string }>('mcp', 'one', now)).toEqual({
      verifier: 'v-one',
    });
    // A payload moved onto another sign-in's row does not open there.
    await one.sql`update signin_pending set sealed_payload =
      (select sealed_payload from signin_pending p where p.state_hash = ${signInKey('mcp', 'one')})
      where state_hash = ${signInKey('mcp', 'two')}`;
    expect(await second.get('mcp', 'two', now)).toBeUndefined();
    const taken = await Promise.all([
      first.take('mcp', 'one', now),
      second.take('mcp', 'one', now),
    ]);
    expect(taken.filter(Boolean)).toEqual([{ verifier: 'v-one' }]);
    // An expired one is gone for every instance.
    await first.put('mcp', 'late', { verifier: 'v-late' }, now - 1);
    expect(await second.get('mcp', 'late', now)).toBeUndefined();
    // Without the master key nothing opens.
    const keyless = new PostgresSignInStore(two.sql, () => randomBytes(32).toString('hex'));
    await first.put('mcp', 'three', { verifier: 'v-three' }, now + 60_000);
    expect(await keyless.get('mcp', 'three', now)).toBeUndefined();
  });

  test('only one instance runs the sandbox sweep at a time, and another takes over when its lease lapses', async () => {
    const [one, two] = pools();
    const sweeps = [0, 0];
    const leases = [
      new Leases(
        () => leaseConnection(one.url, 'test'),
        () => {},
      ),
      new Leases(
        () => leaseConnection(one.url, 'test'),
        () => {},
      ),
    ];
    const wirings = [0, 1].map((index) =>
      startSandboxes({
        sql: [one, two][index]?.sql ?? one.sql,
        sessions: {
          sweep: async () => {
            sweeps[index] = (sweeps[index] ?? 0) + 1;
            return [];
          },
        } as unknown as SandboxSessions,
        providers: () => new Map(),
        project: 'melete',
        sweepMs: 25,
      }),
    );
    try {
      wirings.forEach((wiring, index) => {
        const lease = leases[index];
        if (lease)
          wiring.start({
            leads: () => lease.leads('sandbox'),
            signal: () => lease.signal('sandbox'),
          });
      });
      await Bun.sleep(400);
      const leader = (sweeps[0] ?? 0) > 0 ? 0 : 1;
      const follower = 1 - leader;
      expect(sweeps[leader]).toBeGreaterThan(3);
      expect(sweeps[follower]).toBe(0);
      // The leader's connection ends without a word, as when its process dies.
      const [held] = await one.sql<{ pid: number }[]>`select pid from pg_locks
        where locktype = 'advisory' and granted and classid = ${LEASE_SPACE} and objsubid = 2`;
      expect(held).toBeDefined();
      await one.sql`select pg_terminate_backend(${held?.pid ?? 0})`;
      const before = sweeps[follower] ?? 0;
      await Bun.sleep(400);
      expect(sweeps[follower]).toBeGreaterThan(before + 3);
      // The old leader runs nothing on the lease it lost.
      const stopped = sweeps[leader] ?? 0;
      await Bun.sleep(200);
      expect(sweeps[leader]).toBe(stopped);
      // and the signal its work runs under has ended.
      expect(leases[leader]?.signal('sandbox').aborted).toBe(true);
      expect(leases[follower]?.signal('sandbox').aborted).toBe(false);
    } finally {
      for (const wiring of wirings) wiring.stop();
      await Promise.all(leases.map((lease) => lease.close()));
    }
  });

  test('a lease let go on shutdown passes to another instance at once', async () => {
    const [one] = pools();
    const first = new Leases(
      () => leaseConnection(one.url, 'test'),
      () => {},
    );
    const second = new Leases(
      () => leaseConnection(one.url, 'test'),
      () => {},
    );
    try {
      expect(await first.leads('learning-drain')).toBe(true);
      expect(await second.leads('learning-drain')).toBe(false);
      // Different work has its own lease.
      expect(await second.leads('sandbox')).toBe(true);
      await first.close();
      expect(await second.leads('learning-drain')).toBe(true);
      // The connection the first held went back to its pool without any lease.
      const locks = await one.sql<{ pid: number }[]>`select pid from pg_locks
        where locktype = 'advisory' and granted and classid = ${LEASE_SPACE} and objsubid = 2`;
      expect(new Set(locks.map((lock) => lock.pid)).size).toBe(1);
      expect(locks).toHaveLength(2);
    } finally {
      await first.close();
      await second.close();
    }
  });

  test('a second running process under the same instance name refuses to start', async () => {
    const [one, two] = pools();
    const first = new InstanceRegistry(one.sql, 'shared', { host: 'a', heartbeatMs: 100 });
    const second = new InstanceRegistry(two.sql, 'shared', { host: 'b', heartbeatMs: 100 });
    await first.start();
    try {
      await expect(second.start()).rejects.toThrow('Another running Melete service instance');
      // A name whose last process ended without stopping is taken over after one wait.
      await first.stop();
      await one.sql`insert into ops_instance (id, host, nonce) values ('shared', 'a', 'gone')`;
      await second.start();
      const [row] = await one.sql`select host from ops_instance where id = 'shared'`;
      expect(row?.host).toBe('b');
    } finally {
      await first.stop();
      await second.stop();
    }
  });

  test('of two processes starting at once under one instance name, exactly one runs', async () => {
    const [one, two] = pools();
    const first = new InstanceRegistry(one.sql, 'twin', { host: 'a', heartbeatMs: 100 });
    const second = new InstanceRegistry(two.sql, 'twin', { host: 'b', heartbeatMs: 100 });
    try {
      const started = await Promise.allSettled([first.start(), second.start()]);
      expect(started.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const refused = started.find((result) => result.status === 'rejected');
      expect(String((refused as PromiseRejectedResult | undefined)?.reason)).toContain(
        'Another running Melete service instance',
      );
    } finally {
      await first.stop();
      await second.stop();
    }
  });

  test('each instance sees the others while their heartbeat is fresh', async () => {
    const [one, two] = pools();
    const first = new InstanceRegistry(one.sql, 'first', { host: 'a' });
    const second = new InstanceRegistry(two.sql, 'second', { host: 'b' });
    await first.start();
    await second.start();
    try {
      expect([...(await first.others())]).toEqual(['second']);
      expect([...(await second.others())]).toEqual(['first']);
      // A heartbeat that stopped two minutes ago is an instance that ended.
      await one.sql`update ops_instance set heartbeat_at = now() - interval '3 minutes'
        where id = 'second'`;
      expect([...(await first.others())]).toEqual([]);
      await second.start();
      expect([...(await first.others())]).toEqual(['second']);
      await second.stop();
      expect([...(await first.others())]).toEqual([]);
    } finally {
      await first.stop();
      await second.stop();
    }
  });
});
