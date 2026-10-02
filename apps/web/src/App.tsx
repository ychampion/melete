import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChatScreen } from './chat/Chat.tsx';
import { MeleteMark } from './design/mark.tsx';
import { Button } from './design/primitives.tsx';
import { Sheet } from './design/Sheet.tsx';
import { adapter, type Result } from './experience/adapter.ts';
import {
  AppContext,
  type AppContextValue,
  type Decisions,
  NO_DECISIONS,
  useLoad,
} from './experience/hooks.ts';
import { onboardedProfile } from './experience/profile.ts';
import type { Agent, Capabilities, Conversation, Profile } from './experience/types.ts';
import { roomsApi } from './rooms/api.ts';
import { InviteScreen } from './rooms/InviteScreen.tsx';
import { RoomsRoute } from './rooms/RoomsScreen.tsx';
import { navigate, useRoute } from './router.ts';
import { AgentsScreen } from './screens/Agents.tsx';
import { AutomationsScreen } from './screens/Automations.tsx';
import { ChatsScreen } from './screens/Chats.tsx';
import { CompaniesScreen } from './screens/Companies.tsx';
import { HomeScreen } from './screens/Home.tsx';
import { OnboardingScreen, SignInScreen } from './screens/Onboarding.tsx';
import { PasswordResetScreen } from './screens/PasswordReset.tsx';
import { PlansScreen } from './screens/Plans.tsx';
import { SettingsScreen } from './screens/Settings.tsx';
import { toast } from './shell/Shell.tsx';
import { TimeZonePrompt } from './shell/TimeZonePrompt.tsx';
import { useTheme } from './theme.ts';

/** Where builds before the service kept setup kept it: only a finished setup is carried over. */
function finishedOnThisBrowser(): boolean {
  try {
    return window.localStorage.getItem('melete.onboarded') === 'true';
  } catch {
    return false;
  }
}

function Unreachable({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div
      className="col"
      style={{ alignItems: 'center', height: '100%', overflowY: 'auto', padding: 24 }}
    >
      {/* Auto margins centre it and still let a short window scroll to the top. */}
      <div
        className="col"
        style={{
          alignItems: 'center',
          gap: 16,
          maxWidth: '100%',
          marginBlock: 'auto',
          flexShrink: 0,
          textAlign: 'center',
        }}
      >
        <MeleteMark width={64} />
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>Couldn’t reach Melete</h1>
        <p style={{ fontSize: 14, color: 'var(--muted)', maxWidth: 420 }}>{error}</p>
        <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 420 }}>
          It may be starting up or restarting. Try again in a moment.
        </p>
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}

/** The shell's frame with nothing in it yet, so a load never opens on blank paper. */
function BootFrame() {
  return (
    <div className="shell" aria-busy="true">
      <aside className="sidebar" aria-label="Sections" />
      <div className="shell-main">
        <div className="shell-body">
          <main className="shell-content" />
        </div>
      </div>
    </div>
  );
}

export function App() {
  const route = useRoute();
  useTheme();

  const [signedOut, setSignedOut] = useState(false);
  // A guest's sign-in reaches only the rooms they were invited to and their own account.
  const [guest, setGuest] = useState(false);
  // An expired or revoked cookie needs sign-in, including after a page reload.
  const profile = useLoad(async (): Promise<Result<{ profile: Profile }>> => {
    // The account says first whether it is a guest's: a guest's sign-in reaches
    // only rooms, so nothing personal, the profile included, is asked for.
    const me = await roomsApi.me();
    if (me.error !== null && me.unauthorized) {
      setSignedOut(true);
      setGuest(false);
      return {
        data: null,
        error: me.error ?? 'Sign in again.',
        unavailable: null,
        unauthorized: true,
      };
    }
    if (me.data?.owner.kind === 'guest') {
      setSignedOut(false);
      setGuest(true);
      return { data: null, error: null, unavailable: 'A guest account uses rooms only.' };
    }
    const result = await adapter.profile();
    if (result.error !== null && result.unauthorized) {
      setSignedOut(true);
      setGuest(false);
    } else if (result.data) {
      setSignedOut(false);
      setGuest(false);
    }
    return result;
  }, []);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Decisions>(NO_DECISIONS);
  // Finished here before the saved profile says so; the service keeps the record.
  const [onboardedHere, setOnboardedHere] = useState(false);
  const [capabilities, setCapabilities] = useState<Capabilities>({
    calendar: false,
    browser: false,
    google_sign_in: false,
    apple_sign_in: false,
    magic_link: true,
  });

  const refreshAgents = useCallback(() => {
    // A list that failed to load keeps what was last read; it never decides setup.
    void adapter.agents().then((result) => {
      if (result.data) setAgents(result.data.agents);
    });
  }, []);
  // One refresh reads the conversations and what waits on the person, so the
  // sidebar's dots, Home's count and the queue always agree.
  const refreshConversations = useCallback(() => {
    void Promise.all([adapter.conversations(), adapter.permissions(), adapter.questions()]).then(
      ([listed, permissions, questions]) => {
        if (listed.data) setConversations(listed.data.conversations);
        setConversationsError(listed.data ? null : (listed.error ?? listed.unavailable));
        setDecisions((previous) => ({
          permissions: permissions.data
            ? permissions.data.permissions
            : permissions.unavailable !== null
              ? []
              : previous.permissions,
          handoffs: permissions.data
            ? (permissions.data.handoffs ?? [])
            : permissions.unavailable !== null
              ? []
              : previous.handoffs,
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

  // A guest is signed in to rooms alone; every personal surface stays closed to them.
  const signedIn = profile.data !== null && !signedOut && !guest;
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

  const saved = profile.data?.profile ?? null;
  // Setup is recorded on the service by whoever finishes or skips it, so every
  // browser agrees and a list that fails to load can never send a set-up
  // account back through it. This only says so here at once.
  const setOnboarded = useCallback((next: boolean) => {
    setOnboardedHere(next);
    try {
      window.localStorage.removeItem('melete.onboarded');
    } catch {
      // Storage blocked: there is nothing kept here to clear.
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
    setConversationsError(null);
    setDecisions(NO_DECISIONS);
    setOnboardedHere(false);
    setSignedOut(true);
    setGuest(false);
    navigate('/welcome');
  }, []);

  const onboarded = onboardedHere || saved?.onboarded === true;
  // Setup finished before the service kept the record is recorded there once.
  useEffect(() => {
    if (!signedIn || !saved || saved.onboarded || !finishedOnThisBrowser()) return;
    setOnboarded(true);
    void adapter.saveProfile(onboardedProfile(saved)).then((result) => {
      if (result.data) profile.set(result.data);
    });
  }, [signedIn, saved, setOnboarded, profile.set]);

  const value = useMemo<AppContextValue>(
    () => ({
      capabilities,
      profile: signedIn ? (profile.data?.profile ?? null) : null,
      onboarded,
      setOnboarded,
      agents,
      conversations,
      conversationsError,
      decisions,
      refreshProfile,
      refreshConversations,
      refreshAgents,
      signOut,
      guest: guest && !signedOut,
    }),
    [
      signOut,
      guest,
      signedOut,
      signedIn,
      refreshProfile,
      capabilities,
      profile.data,
      onboarded,
      setOnboarded,
      agents,
      conversations,
      conversationsError,
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

  const [head, second] = route.parts;

  // A guest gets the rooms they were invited to, and nothing personal: no Home,
  // no chats, no setup. Their sign-in would be refused everywhere else.
  if (guest && !signedOut) {
    let room: React.ReactNode;
    if (head === 'invite') room = <InviteScreen signedIn="guest" onJoined={refreshProfile} />;
    else {
      if (head !== 'rooms') navigate('/rooms');
      room = <RoomsRoute parts={head === 'rooms' ? route.parts : ['rooms']} />;
    }
    return <AppContext.Provider value={value}>{room}</AppContext.Provider>;
  }
  // An invite link opens for anyone; it says what to do when the wrong account is signed in.
  if (head === 'invite' && (signedOut || profile.data))
    return (
      <AppContext.Provider value={value}>
        <InviteScreen signedIn={signedIn ? 'person' : null} onJoined={refreshProfile} />
      </AppContext.Provider>
    );

  if (!signedOut && profile.error && !profile.data)
    return <Unreachable error={profile.error} onRetry={profile.reload} />;
  // While the profile loads, the frame is already there: paper, the sidebar's place and a sheet.
  if (!signedOut && profile.loading && !profile.data) return <BootFrame />;

  let screen: React.ReactNode;
  if (head === 'reset') {
    screen = <PasswordResetScreen />;
  } else if (!signedIn || head === 'welcome') {
    screen = <SignInScreen signedIn={signedIn} />;
  } else if (!onboarded || head === 'setup') {
    screen = <OnboardingScreen />;
  } else if (head === 'chats') {
    screen = <ChatsScreen />;
  } else if (head === 'chat') {
    screen = <ChatScreen key={second ?? 'new'} id={second ?? null} />;
  } else if (head === 'agents') {
    screen = <AgentsScreen selected={second ?? null} />;
  } else if (head === 'plans') {
    screen = <PlansScreen selected={second ?? null} />;
  } else if (head === 'rooms') {
    screen = <RoomsRoute parts={route.parts} />;
  } else if (head === 'companies') {
    screen = <CompaniesScreen />;
  } else if (head === 'automations') {
    screen = <AutomationsScreen />;
  } else if (head === 'settings') {
    // What Melete learned now lives under Memory; old links land there.
    if (second === 'learned') window.location.replace('#/settings/memory');
    screen = (
      <SettingsScreen
        tab={second === 'learned' ? 'memory' : (second ?? 'account')}
        detail={route.parts[2] ?? null}
      />
    );
  } else if (head === 'feedback') {
    // The report panel opens over Home; the shell's host reads this address.
    screen = <HomeScreen />;
  } else {
    if (head) navigate('/');
    screen = <HomeScreen />;
  }

  return (
    <AppContext.Provider value={value}>
      {screen}
      {signedIn && onboarded && head !== 'setup' && head !== 'reset' ? <TimeZonePrompt /> : null}
    </AppContext.Provider>
  );
}
