/**
 * The mock API server. `bun run dev:mock` from the repository root.
 *
 * It exists so a client can be written, and demonstrated, before the service is
 * finished, without either side inventing a contract. Nothing here is a
 * simulation of Melete's judgment: the scenarios are scripted and the state
 * machine is the real one.
 */
import { createMockApp, MOCK_VERSION } from './app.ts';
import { createExperience } from './experience.ts';
import { Runner } from './runner.ts';
import { loadScenarios } from './scenarios.ts';
import { seed } from './seed.ts';
import { Store } from './store.ts';

export const DEFAULT_PORT = 3190;

export type MockOptions = {
  /** Multiplies every scripted delay. Set 0 to play a scenario instantly. */
  speed?: number;
  now?: () => Date;
  /**
   * The designed surfaces under /experience. Seeding starts two conversations
   * at boot, which a test that counts jobs does not want; the server does.
   * `fresh` starts signed out, so the onboarding can be walked.
   */
  experience?: { seed?: boolean; browser?: boolean; fresh?: boolean };
};

/** Everything a test or the server needs, already wired together. */
export function createMock(options: MockOptions = {}) {
  const store = new Store();
  if (options.now) store.now = options.now;
  const scenarios = loadScenarios();
  const runner = new Runner(store, { speed: options.speed ?? 1 });
  const { spaceId, connections } = seed(store);
  const app = createMockApp({ store, runner, scenarios, spaceId });
  const experience = createExperience({
    store,
    runner,
    scenarios,
    spaceId,
    api: app,
    options: {
      browser: options.experience?.browser ?? true,
      fresh: options.experience?.fresh ?? false,
      seed: options.experience?.seed ?? false,
    },
  });
  app.route('/experience', experience.app);
  // Seeding sends requests through the app, so it runs after every route is mounted.
  if (options.experience?.seed) void experience.seed();
  return { app, store, runner, scenarios, spaceId, connections };
}

if (import.meta.main) {
  const port = Number(process.env.MOCK_PORT ?? DEFAULT_PORT);
  const fresh = process.env.MOCK_FRESH === '1';
  const { app, spaceId, scenarios } = createMock({
    experience: { seed: !fresh, fresh, browser: process.env.MOCK_BROWSER !== 'off' },
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
