/**
 * One app, open: a header Melete draws (its name, who published it, its
 * version and when it changed) over the app itself, framed and sandboxed.
 *
 * The frame loads a view the service issued for this person. The view is
 * renewed before it ends; when the app moves to another version the frame
 * loads it, and when this person can no longer open the app the frame goes.
 *
 * Managers also get the app's versions, with "Use this version", and who can
 * open it. The publisher and the space's owner can delete it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoadError } from '../design/LoadError.tsx';
import { Badge, Button, Dialog, Input, Skeleton } from '../design/primitives.tsx';
import { useLoad } from '../experience/hooks.ts';
import { href, navigate } from '../router.ts';
import { Shell, toast } from '../shell/Shell.tsx';
import { FramedView } from '../viewer/FramedView.tsx';
import { changedWhen } from './AppsScreen.tsx';
import {
  type AppDetail,
  type AppGrant,
  type AppVersion,
  appBridgeCalls,
  appsApi,
  type GrantRequest,
  viewSource,
} from './api.ts';
import './apps.css';

/** How long before a view ends it is renewed, and the longest wait between renewals. */
const RENEW_BEFORE_MS = 60_000;
const RENEW_AT_MOST_MS = 5 * 60_000;

type Frame =
  | { kind: 'loading' }
  | { kind: 'open'; src: string; versionId: string; expiresAt: string }
  | { kind: 'ended'; reason: string };

/** "version 3", counted from the first; null when the versions are not listed for this person. */
export function versionLabel(detail: AppDetail): string | null {
  const versions = detail.versions;
  if (!versions) return null;
  const at = versions.findIndex((version) => version.current);
  return at === -1 ? null : `version ${versions.length - at}`;
}

export function changeSummary(version: AppVersion): string {
  const { added, removed, changed, truncated } = version.changes;
  const parts = [
    added.length ? `${added.length}${truncated ? '+' : ''} added` : '',
    changed.length ? `${changed.length}${truncated ? '+' : ''} changed` : '',
    removed.length ? `${removed.length}${truncated ? '+' : ''} removed` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'No file changes';
}

/** The grants as the service takes them back: the whole list, by email. */
function asRequest(grants: AppGrant[]): GrantRequest[] {
  return grants.map((grant) =>
    grant.kind === 'installation'
      ? { kind: 'installation', role: 'view' }
      : { kind: 'principal', email: grant.principal.email, role: grant.role },
  );
}

function VersionsDialog({
  open,
  onClose,
  detail,
  onUse,
}: {
  open: boolean;
  onClose: () => void;
  detail: AppDetail;
  onUse: (version: AppVersion) => Promise<void>;
}) {
  const versions = detail.versions ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Versions"
      sub="Choosing a version shows it to everyone who opens the app, straight away."
      width={560}
    >
      <ol className="app-versions">
        {versions.map((version, index) => (
          <li key={version.id} className="app-version">
            <span className="col" style={{ gap: 2, minWidth: 0, flex: 1 }}>
              <span className="app-version-name">
                Version {versions.length - index}
                {version.current ? (
                  <Badge tone="success" dot style={{ marginLeft: 8 }}>
                    Showing now
                  </Badge>
                ) : null}
              </span>
              <span className="app-row-meta">
                {version.created_by ? `${version.created_by.email} · ` : ''}
                {changedWhen(version.created_at)} · {changeSummary(version)}
              </span>
            </span>
            {version.current ? null : (
              <Button
                size="sm"
                variant="outline"
                loading={busy === version.id}
                disabled={busy !== null}
                aria-label={`Use version ${versions.length - index}`}
                onClick={async () => {
                  setBusy(version.id);
                  await onUse(version);
                  setBusy(null);
                }}
              >
                Use this version
              </Button>
            )}
          </li>
        ))}
      </ol>
    </Dialog>
  );
}

function ShareDialog({
  open,
  onClose,
  detail,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  detail: AppDetail;
  onSave: (grants: GrantRequest[]) => Promise<boolean>;
}) {
  const start = useMemo(() => asRequest(detail.grants ?? []), [detail.grants]);
  const [grants, setGrants] = useState<GrantRequest[]>(start);
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setGrants(start);
      setEmail('');
    }
  }, [open, start]);
  const everyone = grants.some((grant) => grant.kind === 'installation');
  const people = grants.flatMap((grant) => (grant.kind === 'principal' ? [grant] : []));
  const add = () => {
    const next = email.trim().toLowerCase();
    if (!next || people.some((grant) => grant.email.toLowerCase() === next)) return;
    setGrants([...grants, { kind: 'principal', email: next, role: 'view' }]);
    setEmail('');
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Who can open it"
      sub={`${detail.app.publisher.email} published it and can always open it. People need an account here.`}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={saving}
            onClick={async () => {
              setSaving(true);
              const saved = await onSave(grants);
              setSaving(false);
              if (saved) onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <label className="row app-share-everyone">
          <input
            type="checkbox"
            className="checkbox"
            checked={everyone}
            onChange={(event) =>
              setGrants(
                event.target.checked
                  ? [...grants, { kind: 'installation', role: 'view' }]
                  : grants.filter((grant) => grant.kind !== 'installation'),
              )
            }
          />
          Everyone with an account here
        </label>
        <form
          className="row"
          style={{ gap: 8 }}
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <Input
            type="email"
            placeholder="Their email"
            aria-label="Email of a person to add"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            width="100%"
          />
          <Button type="submit" variant="outline" disabled={!email.trim()}>
            Add
          </Button>
        </form>
        {people.length ? (
          <ul className="app-people">
            {people.map((grant) => (
              <li key={grant.email} className="row app-person">
                <span className="app-person-email">{grant.email}</span>
                <span className="app-row-meta">
                  {grant.role === 'manage' ? 'Manages it' : 'Can open it'}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${grant.email}`}
                  onClick={() => setGrants(grants.filter((other) => other !== grant))}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="app-row-meta">Nobody else can open it.</p>
        )}
      </div>
    </Dialog>
  );
}

export function AppViewer({ id }: { id: string }) {
  const detail = useLoad(() => appsApi.get(id), [id]);
  const [frame, setFrame] = useState<Frame>({ kind: 'loading' });
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const shown = useRef<string | null>(null);
  const reloadDetail = detail.reload;

  /** Ask for a view. The frame reloads only for a new version, or when `fresh` asks it to. */
  const open = useCallback(
    async (fresh = false) => {
      const result = await appsApi.view(id);
      if (!result.data) {
        shown.current = null;
        setFrame({
          kind: 'ended',
          reason: result.error ?? 'This app can’t be opened right now.',
        });
        return;
      }
      const view = result.data;
      setFrame((current) => {
        if (current.kind === 'open' && current.versionId === view.version_id && !fresh)
          return { ...current, expiresAt: view.expires_at };
        return {
          kind: 'open',
          src: viewSource(view),
          versionId: view.version_id,
          expiresAt: view.expires_at,
        };
      });
      if (shown.current !== null && shown.current !== view.version_id) reloadDetail();
      shown.current = view.version_id;
    },
    [id, reloadDetail],
  );

  useEffect(() => {
    shown.current = null;
    setFrame({ kind: 'loading' });
    void open(true);
  }, [open]);

  // Renewed before it ends, and checked every few minutes for a new version or a lost grant.
  const expiresAt = frame.kind === 'open' ? frame.expiresAt : null;
  useEffect(() => {
    if (!expiresAt) return;
    const until = new Date(expiresAt).getTime() - Date.now() - RENEW_BEFORE_MS;
    const timer = setTimeout(() => void open(), Math.max(5_000, Math.min(until, RENEW_AT_MOST_MS)));
    return () => clearTimeout(timer);
  }, [expiresAt, open]);

  const calls = useMemo(() => appBridgeCalls(id), [id]);
  const app = detail.data?.app;
  const manager = app?.role === 'manage';
  const version = detail.data ? versionLabel(detail.data) : null;
  const changed = app ? (app.current_version?.created_at ?? app.updated_at) : null;
  const name = app?.name ?? 'App';

  return (
    <Shell title={name} rail={false} phoneBack={() => navigate('/apps')}>
      <div className="page app-page">
        <div className="page-head app-head">
          <div className="col" style={{ gap: 4, minWidth: 0 }}>
            <a className="section-link app-back" href={href('/apps')}>
              Apps
            </a>
            <h1 className="app-title">{name}</h1>
            {app ? (
              <p className="apps-sub app-byline">
                by {app.publisher.email}
                {version ? ` · ${version}` : ''}
                {changed ? ` · updated ${changedWhen(changed)}` : ''}
              </p>
            ) : null}
          </div>
          {manager ? (
            <div className="row app-actions">
              <Button variant="outline" icon="clock" onClick={() => setVersionsOpen(true)}>
                Versions
              </Button>
              <Button variant="outline" icon="share" onClick={() => setShareOpen(true)}>
                Share
              </Button>
              <Button variant="ghost" icon="trash" onClick={() => setDeleting(true)}>
                Delete
              </Button>
            </div>
          ) : null}
        </div>
        {detail.error ? (
          <LoadError what="this app" error={detail.error} onRetry={detail.reload} />
        ) : null}
        <section className="app-frame" aria-label={`${name}, published by its author`}>
          {frame.kind === 'open' ? (
            <FramedView key={frame.src} src={frame.src} title={name} calls={calls} />
          ) : frame.kind === 'ended' ? (
            <div className="col app-ended" role="status">
              <span className="app-empty-title">{frame.reason}</span>
              <a className="section-link" href={href('/apps')}>
                Back to Apps
              </a>
            </div>
          ) : (
            <div className="app-ended" aria-busy="true">
              <Skeleton width="50%" height={16} />
            </div>
          )}
        </section>
      </div>
      {detail.data && manager ? (
        <>
          <VersionsDialog
            open={versionsOpen}
            onClose={() => setVersionsOpen(false)}
            detail={detail.data}
            onUse={async (chosen) => {
              const result = await appsApi.chooseVersion(id, chosen.id);
              if (!result.data) {
                toast({ kind: 'err', title: result.error ?? 'Couldn’t change the version' });
                return;
              }
              detail.set(result.data);
              setVersionsOpen(false);
              await open(true);
              toast({ kind: 'ok', title: 'Everyone now sees that version' });
            }}
          />
          <ShareDialog
            open={shareOpen}
            onClose={() => setShareOpen(false)}
            detail={detail.data}
            onSave={async (grants) => {
              const result = await appsApi.setGrants(id, grants);
              if (!result.data) {
                toast({ kind: 'err', title: result.error ?? 'Couldn’t change who can open it' });
                return false;
              }
              detail.set(result.data);
              await open(true);
              return true;
            }}
          />
        </>
      ) : null}
      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete ${name}?`}
        sub="Everyone loses it straight away, with every version. This can’t be undone."
        tone="danger"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                const result = await appsApi.remove(id);
                setDeleting(false);
                if (!result.data) {
                  toast({ kind: 'err', title: result.error ?? 'Couldn’t delete it' });
                  return;
                }
                toast({ kind: 'ok', title: `${name} is deleted` });
                navigate('/apps');
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </Shell>
  );
}
