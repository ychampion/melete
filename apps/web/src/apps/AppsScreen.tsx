/**
 * Apps: the pages the agent built and published, that this person can open.
 * Each row names the app, who published it and when it last changed, and
 * whether this person manages it. Opening one frames it in Melete.
 */
import { LoadError } from '../design/LoadError.tsx';
import { Badge, CompanyTile, Skeleton } from '../design/primitives.tsx';
import { useLoad } from '../experience/hooks.ts';
import { href } from '../router.ts';
import { RailToggle, Shell } from '../shell/Shell.tsx';
import { type AppSummary, appsApi } from './api.ts';
import './apps.css';

/** When an app last changed, as a short phrase: today's time, or the date. */
export function changedWhen(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  if (at.toDateString() === now.toDateString())
    return `today at ${at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  return at.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

function AppRow({ app }: { app: AppSummary }) {
  const changed = app.current_version?.created_at ?? app.updated_at;
  return (
    <a className="list-row app-row" href={href(`/apps/${app.id}`)}>
      <CompanyTile id={app.id} name={app.name} size={36} />
      <span className="col app-row-text">
        <span className="app-row-name">{app.name}</span>
        <span className="app-row-meta">
          {app.description ? `${app.description} · ` : ''}by {app.publisher.email} · updated{' '}
          {changedWhen(changed)}
        </span>
      </span>
      {app.role === 'manage' ? <Badge tone="chip">You manage</Badge> : null}
    </a>
  );
}

export function AppsScreen() {
  const list = useLoad(() => appsApi.list(), []);
  const apps = list.data?.apps ?? [];
  return (
    <Shell title="Apps">
      <div className="page">
        <div className="page-head">
          <div className="col" style={{ gap: 4 }}>
            <h1>Apps</h1>
            <p className="apps-sub">
              Dashboards, trackers and forms your agent built, and the ones people shared with you.
            </p>
          </div>
          <RailToggle />
        </div>
        {list.error ? (
          <LoadError what="your apps" error={list.error} onRetry={list.reload} />
        ) : null}
        {list.loading && !list.data ? (
          <div className="col" style={{ gap: 12 }} aria-busy="true">
            <Skeleton width="40%" height={16} />
            <Skeleton width="60%" height={16} />
          </div>
        ) : null}
        {apps.length > 0 ? (
          <nav className="card app-list" aria-label="Apps">
            {apps.map((app) => (
              <AppRow key={app.id} app={app} />
            ))}
          </nav>
        ) : null}
        {list.data && !list.error && apps.length === 0 ? (
          <div className="col app-empty">
            <span className="app-empty-title">No apps yet</span>
            <span className="app-empty-sub">
              Ask your agent for a dashboard, a tracker or a small form. It asks you before anyone
              can open it.
            </span>
            <a className="section-link" href={href('/chat')}>
              Start a chat
            </a>
          </div>
        ) : null}
      </div>
    </Shell>
  );
}
