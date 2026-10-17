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
import { SandboxAdapterRefusal, type SandboxSpec } from './types.ts';

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
  const plan = new ProviderCapLedger(database?.sql as never, 'caps-race-plan', {
    maxComputers: 4,
    maxAwake: null,
    idleSeconds: 330,
  });
  const reservations = await Promise.all(Array.from({ length: 12 }, () => plan.reserve()));
  expect(reservations.filter((each) => 'reservation' in each)).toHaveLength(4);
});
