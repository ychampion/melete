import { afterAll, beforeEach, expect, test } from 'bun:test';
import { testDatabase } from '../../test/helpers/database.ts';
import { createMaritimeProvider } from './adapters/maritime.ts';
import { AUTHORING_KEY, createMaritimeStandin } from './adapters/maritime-standin.ts';
import { openSandbox, SandboxRefusal, sandboxLabels } from './manifest.ts';
import {
  AWAKE_FULL,
  COMPUTERS_FULL,
  cappedSandboxProvider,
  ProviderCapLedger,
} from './provider-caps.ts';
import {
  SandboxAdapterRefusal,
  SandboxFileNotFound,
  SandboxGone,
  type SandboxSpec,
} from './types.ts';

const database = await testDatabase();
afterAll(async () => database?.close());
const signal = () => AbortSignal.timeout(60_000);

beforeEach(async () => {
  if (!database) return;
  await database.sql`delete from sandbox_provider_lease`;
  await database.sql`delete from sandbox_provider_computer`;
});

const spec = (session: string): SandboxSpec => ({
  image: 'linux',
  egress: { kind: 'open' },
  region: null,
  lifetimeSeconds: 600,
  idleSeconds: null,
  workdir: '/work',
  labels: sandboxLabels({ project: 'caps-test', space: 'sp_CAPS', session }),
  env: {},
});

function capped(maxComputers: number | null, maxAwake: number | null, waitMs = 200) {
  const standin = createMaritimeStandin();
  let nonce = 0;
  const inner = createMaritimeProvider({
    credential: (use) => use(AUTHORING_KEY),
    fetch: standin.fetch,
    nonce: () => {
      nonce += 1;
      return String(nonce);
    },
  });
  const provider = cappedSandboxProvider(inner, {
    sql: database?.sql as never,
    caps: { maxComputers, maxAwake, idleSeconds: 330, waitMs },
  });
  return { standin, inner, provider };
}

const refusal = (error: unknown) =>
  error instanceof SandboxRefusal ? `${error.code}: ${error.message}` : String(error);

test.skipIf(!database)('with no cap set, the provider is given back unwrapped', () => {
  const { inner } = capped(null, null);
  expect(
    cappedSandboxProvider(inner, {
      sql: database?.sql as never,
      caps: { maxComputers: null, maxAwake: null, idleSeconds: 330 },
    }),
  ).toBe(inner);
});

test.skipIf(!database)(
  'concurrent creates never pass the computer cap, and the rest are told so in a sentence',
  async () => {
    const { provider, standin } = capped(3, null);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        openSandbox(provider, spec(`sbx_CAPS${String(index).padStart(4, '0')}`), signal()),
      ),
    );
    const made = results.filter((result) => result.status === 'fulfilled');
    const refused = results.flatMap((result) =>
      result.status === 'rejected' ? [refusal(result.reason)] : [],
    );
    expect(made).toHaveLength(3);
    expect(refused).toHaveLength(7);
    for (const reason of refused) expect(reason).toBe(`provider_capacity: ${COMPUTERS_FULL}`);
    // Nothing was made at the provider past the cap.
    expect(standin.records.size).toBe(3);
    const ledger = new ProviderCapLedger(database?.sql as never, 'maritime', {
      maxComputers: 3,
      maxAwake: null,
      idleSeconds: 330,
    });
    expect((await ledger.counts()).computers).toBe(3);
    // Deleting one frees its place.
    const first = made[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof openSandbox>>>;
    await provider.destroy(first.value, signal());
    await openSandbox(provider, spec('sbx_CAPSAGAIN'), signal());
    expect(standin.records.size).toBe(3);
  },
  60_000,
);

test.skipIf(!database)(
  'past the awake cap a wake waits, then is refused, and never makes a new computer',
  async () => {
    const { provider, standin } = capped(null, 2);
    const one = await openSandbox(provider, spec('sbx_AWAKE0001'), signal());
    const two = await openSandbox(provider, spec('sbx_AWAKE0002'), signal());
    // Both are awake: a third computer is refused after the wait.
    const third = await openSandbox(provider, spec('sbx_AWAKE0003'), signal()).catch(refusal);
    expect(third).toBe(`provider_capacity: ${AWAKE_FULL}`);
    expect(standin.records.size).toBe(2);
    // One goes to sleep; the third may now be made.
    const pause = provider.pause as NonNullable<typeof provider.pause>;
    await pause(one, signal());
    const made = await openSandbox(provider, spec('sbx_AWAKE0003'), signal());
    expect(standin.records.size).toBe(3);
    // The sleeping one cannot wake while two are awake: a command is refused before it runs.
    const command = await provider
      .exec(
        one,
        {
          marker: 'act_01J0CAPSAWAKE00000000000',
          argv: ['sh', '-c', 'printf ran > /work/ran'],
          cwd: '/work',
          timeoutMs: 5_000,
          maxOutputBytes: 1024,
        },
        signal(),
      )
      .catch((error: unknown) => error);
    expect(command).toBeInstanceOf(SandboxAdapterRefusal);
    expect((command as Error).message).toBe(AWAKE_FULL);
    expect(standin.records.size).toBe(3);
    expect(standin.records.get(one.providerSandboxId)?.status).toBe('asleep');
    // An awake computer keeps working while the cap is reached.
    await expect(provider.getFile(two, '/work/missing', 10, signal())).rejects.toThrow();
    // Once another sleeps, the first wakes and runs its command.
    await pause(made, signal());
    const ran = await provider.exec(
      one,
      {
        marker: 'act_01J0CAPSAWAKE00000000001',
        argv: ['sh', '-c', 'printf ran > /work/ran'],
        cwd: '/work',
        timeoutMs: 5_000,
        maxOutputBytes: 1024,
      },
      signal(),
    );
    expect(ran).toMatchObject({ state: 'exited', exitCode: 0 });
  },
  60_000,
);

test.skipIf(!database)(
  'a sleep that lands after a wake, or while a call holds the computer, does not free its place',
  async () => {
    const ledger = new ProviderCapLedger(database?.sql as never, 'caps-sleep', {
      maxComputers: null,
      maxAwake: 1,
      idleSeconds: 330,
    });
    // The sleep is asked for; before its answer arrives a command wakes the computer.
    const asked = await ledger.clock();
    const lease = await ledger.hold('computer-a', 60_000);
    expect(lease).not.toBeNull();
    await ledger.asleep('computer-a', asked);
    expect((await ledger.counts()).awake).toBe(1);
    expect(await ledger.hold('computer-b', 60_000)).toBeNull();
    // Even a sleep asked after the wake does not free a computer a call still holds.
    await ledger.asleep('computer-a', await ledger.clock());
    expect((await ledger.counts()).awake).toBe(1);
    // The call ends: it was used after that first sleep was asked, so it stays counted.
    await ledger.unhold(lease as string, 'computer-a');
    await ledger.asleep('computer-a', asked);
    expect((await ledger.counts()).awake).toBe(1);
    // A sleep asked after its last use frees the place.
    await ledger.asleep('computer-a', await ledger.clock());
    expect((await ledger.counts()).awake).toBe(0);
    expect(await ledger.hold('computer-b', 60_000)).not.toBeNull();
  },
);

test.skipIf(!database)(
  'a create whose answer was lost keeps its place; one refused before anything was made frees it',
  async () => {
    const standin = createMaritimeStandin();
    let loseAnswer = false;
    const inner = createMaritimeProvider({
      credential: (use) => use(AUTHORING_KEY),
      fetch: async (input, init) => {
        const response = await standin.fetch(input, init);
        const create = (init?.method ?? 'GET') === 'POST' && String(input).endsWith('/computers');
        if (loseAnswer && create) {
          await response.body?.cancel().catch(() => {});
          throw new TypeError('network connection lost');
        }
        return response;
      },
    });
    const provider = cappedSandboxProvider(inner, {
      sql: database?.sql as never,
      caps: { maxComputers: 2, maxAwake: null, idleSeconds: 330, waitMs: 200 },
    });
    const ledger = new ProviderCapLedger(database?.sql as never, 'maritime', {
      maxComputers: 2,
      maxAwake: null,
      idleSeconds: 330,
    });
    // Refused by the adapter before Maritime was asked: nothing was made, the place is free.
    const refused = await provider
      .create({ ...spec('sbx_CAPSLOST0001'), image: 'custom:1' }, signal())
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SandboxAdapterRefusal);
    expect((await ledger.counts()).computers).toBe(0);
    // Maritime made the computer and the answer was lost: its place stays taken.
    loseAnswer = true;
    const lost = await provider.create(spec('sbx_CAPSLOST0002'), signal()).catch((e) => e);
    expect(lost).toBeInstanceOf(Error);
    expect(standin.records.size).toBe(1);
    expect((await ledger.counts()).computers).toBe(1);
  },
  60_000,
);

test.skipIf(!database)(
  'a cap lowered below what is in use refuses new computers and wakes, and keeps awake ones working',
  async () => {
    const generous = capped(null, null);
    // Three computers made before any cap was set, all awake.
    const handles = await Promise.all(
      ['sbx_LOWER0001', 'sbx_LOWER0002', 'sbx_LOWER0003'].map((session) =>
        openSandbox(generous.inner, spec(session), signal()),
      ),
    );
    const provider = cappedSandboxProvider(generous.inner, {
      sql: database?.sql as never,
      caps: { maxComputers: 2, maxAwake: 1, idleSeconds: 330, waitMs: 200 },
    });
    // Checking them counts them, though they were made before the caps.
    for (const handle of handles) expect(await provider.inspect(handle, signal())).toBe('running');
    const ledger = new ProviderCapLedger(database?.sql as never, 'maritime', {
      maxComputers: 2,
      maxAwake: 1,
      idleSeconds: 330,
    });
    expect(await ledger.counts()).toEqual({ computers: 3, awake: 3 });
    // No new computer, at once.
    const fourth = await openSandbox(provider, spec('sbx_LOWER0004'), signal()).catch(refusal);
    expect(fourth).toBe(`provider_capacity: ${COMPUTERS_FULL}`);
    expect(generous.standin.records.size).toBe(3);
    // An awake computer keeps working.
    const [one, two] = handles as [(typeof handles)[0], (typeof handles)[0]];
    await expect(provider.getFile(one, '/work/missing', 10, signal())).rejects.toThrow(
      SandboxFileNotFound,
    );
    // One that sleeps cannot wake again while the rest are over the awake cap.
    const pause = provider.pause as NonNullable<typeof provider.pause>;
    await pause(two, signal());
    const woken = await provider.getFile(two, '/work/missing', 10, signal()).catch((e) => e);
    expect(woken).toBeInstanceOf(SandboxAdapterRefusal);
    expect((woken as Error).message).toBe(AWAKE_FULL);
    // Deleting computers frees places, down to the cap and then below it.
    await provider.destroy(one, signal());
    expect((await ledger.counts()).computers).toBe(2);
    expect(await openSandbox(provider, spec('sbx_LOWER0005'), signal()).catch(refusal)).toBe(
      `provider_capacity: ${COMPUTERS_FULL}`,
    );
    await provider.destroy(two, signal());
    expect((await ledger.counts()).computers).toBe(1);
  },
  60_000,
);

test.skipIf(!database)(
  "reconciliation forgets a counted computer nothing live names, so a lost removal can't hold a place forever",
  async () => {
    const { provider, standin } = capped(5, null);
    const kept = await openSandbox(provider, spec('sbx_FORGET0001'), signal());
    // Removed at the provider without the count hearing of it (its database write failed).
    const dropped = await openSandbox(provider, spec('sbx_FORGET0002'), signal());
    standin.records.delete(dropped.providerSandboxId);
    if (!database) return;
    await database.sql`update sandbox_provider_computer
      set created_at = now() - interval '1 hour', active_at = now() - interval '1 hour'`;
    const ledger = new ProviderCapLedger(database?.sql as never, 'maritime', {
      maxComputers: 5,
      maxAwake: null,
      idleSeconds: 330,
    });
    expect((await ledger.counts()).computers).toBe(2);
    await provider.reconcile('caps-test', new Set([kept.providerSandboxId]), signal(), null);
    expect((await ledger.counts()).computers).toBe(1);
    // A live one is never forgotten, however old.
    await provider.reconcile('caps-test', new Set([kept.providerSandboxId]), signal(), null);
    expect((await ledger.counts()).computers).toBe(1);
  },
  60_000,
);

test.skipIf(!database)(
  'a computer removed behind the count, found gone by a call, frees its place',
  async () => {
    const { provider, standin } = capped(5, 5);
    const handle = await openSandbox(provider, spec('sbx_GONECALL01'), signal());
    const ledger = new ProviderCapLedger(database?.sql as never, 'maritime', {
      maxComputers: 5,
      maxAwake: 5,
      idleSeconds: 330,
    });
    expect((await ledger.counts()).computers).toBe(1);
    // Deleted at the provider, not through this installation.
    await standin.fetch(`https://api.maritime.sh/api/v1/computers/${handle.providerSandboxId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${AUTHORING_KEY}` },
    });
    const failed = await provider.getFile(handle, '/work/x', 10, signal()).catch((e) => e);
    expect(failed).toBeInstanceOf(SandboxGone);
    expect(await ledger.counts()).toEqual({ computers: 0, awake: 0 });
  },
  60_000,
);

test.skipIf(!database)(
  'the lock is never held while the provider is called',
  async () => {
    const standin = createMaritimeStandin();
    let release: () => void = () => {};
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let park = false;
    const inner = createMaritimeProvider({
      credential: (use) => use(AUTHORING_KEY),
      fetch: async (input, init) => {
        if (park && String(input).endsWith('/computers')) {
          entered();
          await parked;
        }
        return standin.fetch(input, init);
      },
    });
    const provider = cappedSandboxProvider(inner, {
      sql: database?.sql as never,
      caps: { maxComputers: 5, maxAwake: 5, idleSeconds: 330, waitMs: 200 },
    });
    park = true;
    // A create is inside its call to the provider...
    const creating = openSandbox(provider, spec('sbx_LOCKFREE01'), signal());
    await inside;
    // ...and every ledger operation, through another connection, still goes through.
    const other = new ProviderCapLedger(database?.sql as never, 'maritime', {
      maxComputers: 5,
      maxAwake: 5,
      idleSeconds: 330,
    });
    const quick = await Promise.race([
      (async () => {
        const taken = await other.reserve();
        if ('reservation' in taken) await other.release(taken.reservation);
        await other.hold('elsewhere', 1_000);
        return 'went through';
      })(),
      Bun.sleep(5_000).then(() => 'blocked'),
    ]);
    expect(quick).toBe('went through');
    release();
    await creating;
  },
  60_000,
);

test.skipIf(!database)('concurrent wakes take exactly the awake places there are', async () => {
  const ledger = new ProviderCapLedger(database?.sql as never, 'caps-race', {
    maxComputers: null,
    maxAwake: 5,
    idleSeconds: 330,
  });
  const leases = await Promise.all(
    Array.from({ length: 20 }, (_, index) => ledger.hold(`computer-${index}`, 60_000)),
  );
  expect(leases.filter((lease) => lease !== null)).toHaveLength(5);
  expect((await ledger.counts()).awake).toBe(5);
  // A computer already awake is never refused its own place.
  const awake = leases.findIndex((lease) => lease !== null);
  expect(await ledger.hold(`computer-${awake}`, 60_000)).not.toBeNull();
  // And concurrent reservations never pass the computer cap.
  const kept = new ProviderCapLedger(database?.sql as never, 'caps-race-kept', {
    maxComputers: 4,
    maxAwake: null,
    idleSeconds: 330,
  });
  const reservations = await Promise.all(Array.from({ length: 12 }, () => kept.reserve()));
  expect(reservations.filter((each) => 'reservation' in each)).toHaveLength(4);
});
