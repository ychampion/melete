import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChatScreen } from './chat/Chat.tsx';
import { MeleteMark } from './design/mark.tsx';
import { Button } from './design/primitives.tsx';
import { Sheet } from './design/Sheet.tsx';
import { adapter } from './experience/adapter.ts';
import { AppContext, type AppContextValue, useLoad } from './experience/hooks.ts';
import type { Agent, Capabilities, ConversationSummary, Session } from './experience/types.ts';
import { navigate, useRoute } from './router.ts';
import { AgentsScreen } from './screens/Agents.tsx';
import { AutomationsScreen } from './screens/Automations.tsx';
import { HomeScreen } from './screens/Home.tsx';
import { OnboardingScreen, SignInScreen } from './screens/Onboarding.tsx';
import { PlansScreen } from './screens/Plans.tsx';
import { SettingsScreen } from './screens/Settings.tsx';
import { useTheme } from './theme.ts';

const FALLBACK_CAPABILITIES: Capabilities = {
  browser: 'unavailable',
  oauth_google: 'unavailable',
  oauth_apple: 'unavailable',
  magic_link: 'available',
  voice: 'unavailable',
  attachments: 'unavailable',
  tour_stages: [],
};

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

  const capabilities = useLoad(() => adapter.capabilities(), []);
  const session = useLoad(() => adapter.session(), []);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);

  const refreshAgents = useCallback(() => {
    void adapter.agents().then((result) => {
      if (result.error === null) setAgents(result.data.agents);
    });
  }, []);
  const refreshConversations = useCallback(() => {
    void adapter.conversations().then((result) => {
      if (result.error === null) setConversations(result.data.conversations);
    });
  }, []);

  const signedIn = session.data?.signed_in ?? false;
  useEffect(() => {
    if (!signedIn) return;
    refreshAgents();
    refreshConversations();
  }, [signedIn, refreshAgents, refreshConversations]);

  // Conversations move while the person is elsewhere; keep the sidebar honest.
  useEffect(() => {
    if (!signedIn) return;
    const timer = setInterval(refreshConversations, 8000);
    return () => clearInterval(timer);
  }, [signedIn, refreshConversations]);

  const sessionData: Session = session.data ?? {
    signed_in: false,
    onboarded: false,
    profile: null,
  };

  const value = useMemo<AppContextValue>(
    () => ({
      capabilities: capabilities.data ?? FALLBACK_CAPABILITIES,
      session: sessionData,
      agents,
      conversations,
      refreshSession: session.reload,
      refreshConversations,
      refreshAgents,
    }),
    [
      capabilities.data,
      sessionData,
      agents,
      conversations,
      session.reload,
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

  if (session.error && !session.data)
    return <Unreachable error={session.error} onRetry={session.reload} />;
  if (session.loading && !session.data) return null;

  const [head, second] = route.parts;

  let screen: React.ReactNode;
  if (!sessionData.signed_in) {
    screen = <SignInScreen />;
  } else if (!sessionData.onboarded || head === 'setup') {
    screen = <OnboardingScreen />;
  } else if (head === 'welcome') {
    navigate('/');
    screen = null;
  } else if (head === 'chat') {
    screen = <ChatScreen id={second ?? null} />;
  } else if (head === 'agents') {
    screen = <AgentsScreen selected={second ?? null} />;
  } else if (head === 'plans') {
    screen = <PlansScreen selected={second ?? null} />;
  } else if (head === 'automations') {
    screen = <AutomationsScreen />;
  } else if (head === 'settings') {
    screen = <SettingsScreen tab={second ?? 'memory'} />;
  } else {
    screen = <HomeScreen />;
  }

  return <AppContext.Provider value={value}>{screen}</AppContext.Provider>;
}
