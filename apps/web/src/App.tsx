import type { Approval, Space } from '@melete/client';
import { API_BASE_URL, client, unwrap } from './api.ts';
import { Banner } from './components.tsx';
import { useEventStream, useLoad, useRoute, useStored } from './hooks.ts';
import { Approvals } from './screens/Approvals.tsx';
import { Chat } from './screens/Chat.tsx';
import { Home } from './screens/Home.tsx';
import { JobDetail } from './screens/JobDetail.tsx';
import { Ledger } from './screens/Ledger.tsx';
import { Memory } from './screens/Memory.tsx';

const NAV = [
  { href: '#/', label: 'Jobs', match: (route: string) => route === '/' },
  { href: '#/chat', label: 'Delegate', match: (route: string) => route.startsWith('/chat') },
  {
    href: '#/approvals',
    label: 'Approvals',
    match: (route: string) => route.startsWith('/approvals'),
  },
  { href: '#/actions', label: 'Actions', match: (route: string) => route.startsWith('/actions') },
  { href: '#/memory', label: 'Memory', match: (route: string) => route.startsWith('/memory') },
];

export function App() {
  const route = useRoute();
  const [theme, setTheme] = useStored('melete.theme', 'light');
  const stream = useEventStream();

  const spaces = useLoad<Space[]>(
    async () => unwrap(await client.api.GET('/spaces', {})).spaces,
    [],
  );
  const approvals = useLoad<Approval[]>(
    async () => unwrap(await client.api.GET('/approvals', {})).approvals,
    [stream.events.length],
  );

  const spaceId = spaces.data?.[0]?.id ?? null;
  const waiting = approvals.data?.length ?? 0;

  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme;
  }

  const jobMatch = /^\/jobs\/([^/]+)$/.exec(route);

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Sections">
        <p className="brand">
          <strong>Melete</strong> <span>reference client</span>
        </p>
        {NAV.map((item) => (
          <a
            key={item.href}
            className="nav-link"
            href={item.href}
            {...(item.match(route) ? { 'aria-current': 'page' as const } : {})}
          >
            {item.label}
            {item.label === 'Approvals' && waiting > 0 ? (
              <span className="nav-count">{waiting}</span>
            ) : null}
          </a>
        ))}
        <div className="sidebar-footer">
          <span className="mono">{API_BASE_URL}</span>
          <button
            type="button"
            className="button button-small"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </button>
        </div>
      </nav>

      <main className="main">
        <Banner message={spaces.error} />
        {/*
          A service that goes away mid-session must not take the screen with it.
          The banner says what happened; the transcript, the approval you were
          reading, and the job you started all stay where they are. Only a
          client that never reached the service at all shows the help text.
        */}
        {spaces.error && !spaces.data ? (
          <p className="muted">
            Start the mock with <code className="mono">bun run dev:mock</code>, or point{' '}
            <code className="mono">VITE_MELETE_API</code> at a running service.
          </p>
        ) : jobMatch?.[1] ? (
          <JobDetail jobId={jobMatch[1]} />
        ) : route.startsWith('/chat') ? (
          <Chat spaceId={spaceId} />
        ) : route.startsWith('/approvals') ? (
          <Approvals />
        ) : route.startsWith('/actions') ? (
          <Ledger />
        ) : route.startsWith('/memory') ? (
          <Memory spaceId={spaceId} />
        ) : (
          <Home spaceId={spaceId} />
        )}
      </main>
    </div>
  );
}
