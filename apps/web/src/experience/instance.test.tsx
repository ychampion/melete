/**
 * The installation's names reach every screen: with a name set, the main
 * views say it and never "Melete"; with none set, they read as before.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatScreen } from '../chat/Chat.tsx';
import { HomeScreen } from '../screens/Home.tsx';
import { OnboardingScreen, SignInScreen } from '../screens/Onboarding.tsx';
import { SettingsScreen } from '../screens/Settings.tsx';
import { AppContext, type AppContextValue, NO_DECISIONS } from './hooks.ts';
import {
  assistantName,
  currentInstance,
  DEFAULT_NAME,
  instanceName,
  setInstance,
} from './instance.ts';
import { useInstance } from './use-instance.ts';

// The screens read the window size and the address; on the server there is no
// window, so a small one stands in, and is taken away again afterwards.
const media = { matches: false, addEventListener() {}, removeEventListener() {} };
const hadWindow = 'window' in globalThis;
const before = (globalThis as { window?: unknown }).window;
beforeAll(() => {
  Object.assign(globalThis, {
    window: {
      matchMedia: () => media,
      location: { hash: '#/', pathname: '/', search: '', href: 'http://localhost/#/' },
      history: { length: 1 },
      addEventListener() {},
      removeEventListener() {},
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      setTimeout,
      clearTimeout,
    },
  });
});
afterAll(() => {
  if (hadWindow) Object.assign(globalThis, { window: before });
  else delete (globalThis as { window?: unknown }).window;
});
afterEach(() => setInstance({}));

const app = (signedIn: boolean) =>
  ({
    capabilities: { calendar: false, browser: false, multiplayer: false },
    profile: signedIn
      ? {
          name: 'Sam',
          time_zone: 'Europe/Paris',
          day_hours: { start: '09:00', end: '18:00' },
          onboarded: true,
          time_zone_confirmed: true,
          sending_address: null,
          role: 'owner',
        }
      : null,
    onboarded: signedIn,
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
  }) as unknown as AppContextValue;

const render = (node: React.ReactNode, signedIn = true) =>
  renderToStaticMarkup(<AppContext.Provider value={app(signedIn)}>{node}</AppContext.Provider>);

const VIEWS: [string, () => string][] = [
  ['Home', () => render(<HomeScreen />)],
  ['Chat', () => render(<ChatScreen id={null} />)],
  ['Settings', () => render(<SettingsScreen tab="account" detail={null} />)],
  ['Settings, privacy', () => render(<SettingsScreen tab="privacy" detail={null} />)],
  ['sign-in', () => render(<SignInScreen signedIn={false} />, false)],
  ['onboarding', () => render(<OnboardingScreen />)],
];

describe('useInstance', () => {
  function Names() {
    const { name, assistant } = useInstance();
    return (
      <p>
        {name} / {assistant}
      </p>
    );
  }

  test('both names are Melete until the setup status says otherwise', () => {
    expect(currentInstance()).toEqual({ name: DEFAULT_NAME, assistant: DEFAULT_NAME });
    expect(renderToStaticMarkup(<Names />)).toBe('<p>Melete / Melete</p>');
  });

  test('the setup status names the installation and its assistant', () => {
    setInstance({ instance_name: 'Riverside Assistant', assistant_name: 'Juniper' });
    expect(renderToStaticMarkup(<Names />)).toBe('<p>Riverside Assistant / Juniper</p>');
    expect([instanceName(), assistantName()]).toEqual(['Riverside Assistant', 'Juniper']);
  });

  test('a missing or blank name stays the default', () => {
    setInstance({ instance_name: '  ', assistant_name: undefined });
    expect(currentInstance()).toEqual({ name: 'Melete', assistant: 'Melete' });
  });

  test('with only the installation named, the assistant takes its name', () => {
    setInstance({ instance_name: 'Riverside Assistant', assistant_name: ' ' });
    expect(currentInstance()).toEqual({
      name: 'Riverside Assistant',
      assistant: 'Riverside Assistant',
    });
    setInstance({ instance_name: 'Riverside Assistant' });
    expect(assistantName()).toBe('Riverside Assistant');
  });
});

describe('the main views with a name set', () => {
  test('say the installation’s names and never Melete', () => {
    setInstance({ instance_name: 'Riverside Assistant', assistant_name: 'Juniper' });
    for (const [view, draw] of VIEWS) {
      const html = draw();
      // Code names in class names and the logo's file path are not words anyone reads.
      const words = html.replace(/melete-[a-z-]+/g, '');
      expect([view, /Melete/.test(words)]).toEqual([view, false]);
    }
    expect(render(<SignInScreen signedIn={false} />, false)).toContain('Riverside Assistant');
    expect(render(<HomeScreen />)).toContain('Ask Juniper to handle something');
  });

  test('with none set, the same views still say Melete', () => {
    expect(render(<HomeScreen />)).toContain('Ask Melete to handle something');
    expect(render(<SignInScreen signedIn={false} />, false)).toContain('Melete');
  });
});
