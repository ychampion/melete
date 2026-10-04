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
import { REALTIME_PATH, type RealtimeState, realtimeSocket } from './voice.ts';

// The web app and the screens walk expect the mock here.
export const DEFAULT_PORT = 3210;

export type MockOptions = {
  /** Multiplies every scripted delay. Set 0 to play a scenario instantly. */
  speed?: number;
  now?: () => Date;
  /** Seed the designed surfaces (conversations, plans, tasks, routines). Tests leave this off. */
  experience?: { seed?: boolean };
  /** Start as a fresh install: no account yet, and signed out until one is made. */
  setupNeeded?: boolean;
  /** Offer voice; on unless turned off, or kept off as in a private space. */
  voice?: boolean | 'private';
  /** Off, conversations have no browser or sandbox, as on a fresh install. */
  computer?: boolean;
  /** `shared` makes the session's space a shared one the person owns, with two others in it. */
  space?: 'personal' | 'shared';
  /** `none` starts with nothing connected, as before the person connects an app. */
  connections?: 'seeded' | 'none';
  /** `none` shows Home's "Needs you" with nothing in it. */
  needsYou?: 'seeded' | 'none';
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
    setupNeeded: options.setupNeeded ?? false,
    voice: options.voice ?? true,
    computer: options.computer ?? true,
    space: options.space ?? 'personal',
    needsYou: options.needsYou !== 'none',
  });
  if (options.connections === 'none') store.connections.clear();
  return { app, store, runner, scenarios, spaceId, connections };
}

if (import.meta.main) {
  const port = Number(process.env.MOCK_PORT ?? DEFAULT_PORT);
  const { app, spaceId, scenarios } = createMock({
    experience: { seed: process.env.MOCK_SEED !== 'off' },
    setupNeeded: process.env.MELETE_MOCK_SETUP === 'needed',
    computer: process.env.MELETE_MOCK_COMPUTER !== 'off',
    space: process.env.MELETE_MOCK_SPACE === 'shared' ? 'shared' : 'personal',
    connections: process.env.MELETE_MOCK_CONNECTIONS === 'none' ? 'none' : 'seeded',
    needsYou: process.env.MELETE_MOCK_NEEDS_YOU === 'none' ? 'none' : 'seeded',
    voice:
      process.env.MELETE_MOCK_VOICE === 'private'
        ? 'private'
        : process.env.MELETE_MOCK_VOICE !== 'off',
  });
  Bun.serve<RealtimeState>({
    port,
    idleTimeout: 0,
    // Voice mode's realtime session is a WebSocket; everything else is the app.
    fetch(request, server) {
      if (new URL(request.url).pathname === REALTIME_PATH) {
        const data: RealtimeState = { spokenMs: 0, quietMs: 0, partials: 0, committed: 0 };
        if (server.upgrade(request, { data })) return undefined;
      }
      return app.fetch(request);
    },
    websocket: realtimeSocket,
  });
  process.stdout.write(
    [
      `melete mock-api ${MOCK_VERSION} listening on http://localhost:${port}`,
      `space: ${spaceId}`,
      `scenarios: ${scenarios.map((scenario) => scenario.id).join(', ')}`,
      '',
    ].join('\n'),
  );
}
