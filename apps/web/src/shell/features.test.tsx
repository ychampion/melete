/**
 * A feature the operator turned off is left out of the interface: the setup
 * status says so, and the surface is not drawn. The service refuses its
 * routes anyway; this is so nobody is offered what cannot work.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { featureOn } from '../experience/features.ts';
import { AppContext, type AppContextValue, NO_DECISIONS } from '../experience/hooks.ts';
import { NAV, sidebarNav } from './nav.ts';
import { Shell } from './Shell.tsx';

// The shell reads the window size and the address; on the server it has neither.
// It is put back afterwards, so no other test file sees a window.
const media = { matches: false, addEventListener() {}, removeEventListener() {} };
const hadWindow = 'window' in globalThis;
const before = (globalThis as { window?: unknown }).window;
beforeAll(() => {
  Object.assign(globalThis, {
    window: {
      matchMedia: () => media,
      location: { hash: '#/', pathname: '/', search: '' },
      addEventListener() {},
      removeEventListener() {},
    },
  });
});
afterAll(() => {
  if (hadWindow) Object.assign(globalThis, { window: before });
  else delete (globalThis as { window?: unknown }).window;
});

function render(features: Record<string, boolean>) {
  const app = {
    capabilities: { calendar: false, browser: false, multiplayer: false, features },
    profile: {
      name: 'Sam',
      time_zone: 'Europe/Paris',
      day_hours: { start: '09:00', end: '18:00' },
      onboarded: true,
      time_zone_confirmed: true,
      sending_address: null,
      role: 'owner',
      voice: 'teammate',
    },
    onboarded: true,
    setOnboarded: () => {},
    agents: [],
    removedAgents: [],
    conversations: [],
    conversationsError: null,
    decisions: NO_DECISIONS,
    refreshProfile: () => {},
    refreshConversations: () => {},
    refreshAgents: () => {},
    signOut: async () => {},
    member: false,
  } as AppContextValue;
  return renderToStaticMarkup(
    <AppContext.Provider value={app}>
      <Shell title="Home">
        <p>body</p>
      </Shell>
    </AppContext.Provider>,
  );
}

test('a feature the status does not name, or names as on, counts as on', () => {
  expect(featureOn({ features: {} }, 'voice')).toBe(true);
  expect(featureOn({ features: { voice: true } }, 'voice')).toBe(true);
  expect(featureOn({ features: { voice: false } }, 'voice')).toBe(false);
});

test('Companies leaves the sidebar when the operator turned it off', () => {
  expect(sidebarNav(false, true, false, false).map((item) => item.path)).toEqual(
    NAV.map((item) => item.path).filter((path) => path !== '/companies'),
  );
  expect(render({}).match(/href="#\/companies"/g)?.length ?? 0).toBeGreaterThan(0);
  expect(render({ companies: false })).not.toContain('href="#/companies"');
});
