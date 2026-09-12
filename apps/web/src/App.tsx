import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChatScreen } from './chat/Chat.tsx';
import { MeleteMark } from './design/mark.tsx';
import { Button } from './design/primitives.tsx';
import { Sheet } from './design/Sheet.tsx';
import { adapter } from './experience/adapter.ts';
import { AppContext, type AppContextValue, useLoad } from './experience/hooks.ts';
import type { Agent, Capabilities, Conversation } from './experience/types.ts';
import { navigate, useRoute } from './router.ts';
import { AgentsScreen } from './screens/Agents.tsx';
import { AutomationsScreen } from './screens/Automations.tsx';
import { HomeScreen } from './screens/Home.tsx';
import { OnboardingScreen, SignInScreen } from './screens/Onboarding.tsx';
import { PlansScreen } from './screens/Plans.tsx';
import { SettingsScreen } from './screens/Settings.tsx';
import { useTheme } from './theme.ts';

const ONBOARDED_KEY = 'melete.onboarded';

function readOnboarded(): boolean | null {
  try {
    const stored = window.localStorage.getItem(ONBOARDED_KEY);
    return stored === null ? null : stored === 'true';
  } catch {
    return null;
  }
}

function Unreachable({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div
      className="col"
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 16,
        padding: 24,
        textAlign: 'center',
      }}
    >
      <MeleteMark width={64} />
      <h1 style={{ fontSize: 22, fontWeight: 700 }}>Couldn’t reach Melete</h1>
      <p style={{ fontSize: 14, color: 'var(--muted)', maxWidth: 420 }}>{error}</p>
      <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 420 }}>
        Start the service, or point <code>VITE_MELETE_API</code> at one that is running.
      </p>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function App() {
  const route = useRoute();
  useTheme();

  // The profile is the session: a signed-in person has one, a stranger does not.
  const profile = useLoad(() => adapter.profile(), []);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [onboardedStored, setOnboardedStored] = useState<boolean | null>(readOnboarded);
  const [capabilities, setCapabilities] = useState<Capabilities>({
    calendar: false,
    browser: false,
    google_sign_in: false,
    apple_sign_in: false,
    magic_link: true,
  });

  const refreshAgents = useCallback(() => {
    void adapter.agents().then((result) => {
      if (result.data) setAgents(result.data.agents);
      setAgentsLoaded(true);
    });
  }, []);
  const refreshConversations = useCallback(() => {
    void adapter.conversations().then((result) => {
      if (result.data) setConversations(result.data.conversations);
    });
  }, []);

  const signedIn = profile.data !== null;
  useEffect(() => {
    if (!signedIn) return;
    refreshAgents();
    refreshConversations();
    // Capabilities are learned from the calls that would serve them.
    void adapter.home().then((home) => {
      setCapabilities((c) => ({
        ...c,
        calendar: Boolean(home.data && Array.isArray(home.data.upcoming)),
      }));
    });
    void adapter.browserSession('probe').then((session) => {
      setCapabilities((c) => ({
        ...c,
        browser: session.unavailable === null && session.error === null,
      }));
    });
  }, [signedIn, refreshAgents, refreshConversations]);

  // Conversations move while the person is elsewhere; keep the sidebar honest.
  useEffect(() => {
    if (!signedIn) return;
    const timer = setInterval(refreshConversations, 8000);
    return () => clearInterval(timer);
  }, [signedIn, refreshConversations]);

  const setOnboarded = useCallback((next: boolean) => {
    setOnboardedStored(next);
    try {
      window.localStorage.setItem(ONBOARDED_KEY, String(next));
    } catch {
      // A browser with storage blocked still gets a working session.
    }
  }, []);

  // Nothing in the contract records setup. A stored flag wins; otherwise an
  // instance with agents already made has been set up.
  const onboarded = onboardedStored ?? (agentsLoaded ? agents.length > 0 : true);

  const value = useMemo<AppContextValue>(
    () => ({
      capabilities,
      profile: profile.data?.profile ?? null,
      onboarded,
      setOnboarded,
      agents,
      conversations,
      refreshProfile: profile.reload,
      refreshConversations,
      refreshAgents,
    }),
    [
      capabilities,
      profile.data,
      profile.reload,
      onboarded,
      setOnboarded,
      agents,
      conversations,
      refreshConversations,
      refreshAgents,
    ],
  );

  if (route.path === '/design') {
    return (
      <AppContext.Provider value={value}>
        <div style={{ height: '100%', overflowY: 'auto' }}>
          <Sheet />
        </div>
      </AppContext.Provider>
    );
  }

  if (profile.error && !profile.data)
    return <Unreachable error={profile.error} onRetry={profile.reload} />;
  if (profile.loading && !profile.data) return null;

  const [head, second] = route.parts;

  let screen: React.ReactNode;
  if (!signedIn || head === 'welcome') {
    screen = <SignInScreen signedIn={signedIn} />;
  } else if (!onboarded || head === 'setup') {
    screen = <OnboardingScreen />;
  } else if (head === 'chat') {
    screen = <ChatScreen key={second ?? 'new'} id={second ?? null} />;
  } else if (head === 'agents') {
    screen = <AgentsScreen selected={second ?? null} />;
  } else if (head === 'plans') {
    screen = <PlansScreen selected={second ?? null} />;
  } else if (head === 'automations') {
    screen = <AutomationsScreen />;
  } else if (head === 'settings') {
    screen = <SettingsScreen tab={second ?? 'memory'} />;
  } else {
    if (head) navigate('/');
    screen = <HomeScreen />;
  }

  return <AppContext.Provider value={value}>{screen}</AppContext.Provider>;
}
