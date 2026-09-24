/**
 * The mock API server. `bun run dev:mock` from the repository root.
 *
 * It exists so a client can be written, and demonstrated, before the service is
 * finished, without either side inventing a contract. Nothing here is a
 * simulation of Melete's judgment: the scenarios are scripted and the state
 * machine is the real one.
 */
import { createMockApp, MOCK_VERSION } from './app.ts';
import { Runner } from './runner.ts';
import { loadScenarios } from './scenarios.ts';
import { seed } from './seed.ts';
import { Store } from './store.ts';

// The web app and the screens walk expect the mock here.
export const DEFAULT_PORT = 3210;

export type MockOptions = {
  /** Multiplies every scripted delay. Set 0 to play a scenario instantly. */
  speed?: number;
  now?: () => Date;
  /** Seed the designed surfaces (conversations, plans, tasks, routines). Tests leave this off. */
  experience?: { seed?: boolean };
};

/** Everything a test or the server needs, already wired together. */
export function createMock(options: MockOptions = {}) {
  const store = new Store();
  if (options.now) store.now = options.now;
  const scenarios = loadScenarios();
  const runner = new Runner(store, { speed: options.speed ?? 1 });
  const { spaceId, connections } = seed(store);
  const app = createMockApp({
    store,
    runner,
    scenarios,
    spaceId,
    experienceSpeed: options.speed ?? 1,
    seedExperience: options.experience?.seed ?? false,
  });
  return { app, store, runner, scenarios, spaceId, connections };
}

if (import.meta.main) {
  const port = Number(process.env.MOCK_PORT ?? DEFAULT_PORT);
  const { app, spaceId, scenarios } = createMock({
    experience: { seed: process.env.MOCK_SEED !== 'off' },
  });
  Bun.serve({ port, fetch: app.fetch, idleTimeout: 0 });
  process.stdout.write(
    [
      `melete mock-api ${MOCK_VERSION} listening on http://localhost:${port}`,
      `space: ${spaceId}`,
      `scenarios: ${scenarios.map((scenario) => scenario.id).join(', ')}`,
      '',
    ].join('\n'),
  );
}
