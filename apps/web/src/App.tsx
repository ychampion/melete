import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChatScreen } from './chat/Chat.tsx';
import { MeleteMark } from './design/mark.tsx';
import { Button } from './design/primitives.tsx';
import { Sheet } from './design/Sheet.tsx';
import { adapter } from './experience/adapter.ts';
import {
  AppContext,
  type AppContextValue,
  type Decisions,
  NO_DECISIONS,
  useLoad,
} from './experience/hooks.ts';
import type { Agent, Capabilities, Conversation } from './experience/types.ts';
import { navigate, useRoute } from './router.ts';
import { AgentsScreen } from './screens/Agents.tsx';
import { AutomationsScreen } from './screens/Automations.tsx';
import { CompaniesScreen } from './screens/Companies.tsx';
import { HomeScreen } from './screens/Home.tsx';
import { OnboardingScreen, SignInScreen } from './screens/Onboarding.tsx';
import { PlansScreen } from './screens/Plans.tsx';
import { SettingsScreen } from './screens/Settings.tsx';
import { toast } from './shell/Shell.tsx';
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

  const [signedOut, setSignedOut] = useState(false);
  // An expired or revoked cookie needs sign-in, including after a page reload.
  const profile = useLoad(async () => {
    const result = await adapter.profile();
    if (result.error !== null && result.unauthorized) setSignedOut(true);
    else if (result.data) setSignedOut(false);
    return result;
  }, []);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [decisions, setDecisions] = useState<Decisions>(NO_DECISIONS);
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
  // One refresh reads the conversations and what waits on the person, so the
  // sidebar's dots, Home's count and the queue always agree.
  const refreshConversations = useCallback(() => {
    void Promise.all([adapter.conversations(), adapter.permissions(), adapter.questions()]).then(
      ([listed, permissions, questions]) => {
        if (listed.data) setConversations(listed.data.conversations);
        setDecisions((previous) => ({
          permissions: permissions.data
            ? permissions.data.permissions
            : permissions.unavailable !== null
              ? []
              : previous.permissions,
          questions: questions.data
            ? questions.data.questions
            : questions.unavailable !== null
              ? []
              : previous.questions,
          loaded: true,
          error: permissions.error ?? questions.error ?? null,
        }));
      },
    );
  }, []);

  const signedIn = profile.data !== null && !signedOut;
  const refreshProfile = useCallback(() => {
    profile.reload();
  }, [profile.reload]);
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

  const signOut = useCallback(async () => {
    const result = await adapter.signOut();
    if (result.data === null) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t sign out' });
      return;
    }
    setAgents([]);
    setConversations([]);
    setDecisions(NO_DECISIONS);
    setAgentsLoaded(false);
    setSignedOut(true);
    navigate('/welcome');
  }, []);

  // Nothing in the contract records setup. A stored flag wins; otherwise an
  // instance with agents already made has been set up.
  const onboarded = onboardedStored ?? (agentsLoaded ? agents.length > 0 : true);

  const value = useMemo<AppContextValue>(
    () => ({
      capabilities,
      profile: signedIn ? (profile.data?.profile ?? null) : null,
      onboarded,
      setOnboarded,
      agents,
      conversations,
      decisions,
      refreshProfile,
      refreshConversations,
      refreshAgents,
      signOut,
    }),
    [
      signOut,
      signedIn,
      refreshProfile,
      capabilities,
      profile.data,
      onboarded,
      setOnboarded,
      agents,
      conversations,
      decisions,
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

  if (!signedOut && profile.error && !profile.data)
    return <Unreachable error={profile.error} onRetry={profile.reload} />;
  if (!signedOut && profile.loading && !profile.data) return null;

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
  } else if (head === 'companies') {
    screen = <CompaniesScreen />;
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
