/**
 * What an app collects and what it shows, for the people who look after it:
 *
 * - Responses: what viewers sent from the app, newest first, with who sent
 *   each. Managers read and delete them.
 * - Data updates: when the publisher chose to review each new version of a
 *   data file, the versions waiting, with what each changes. Letting one
 *   through shows it to viewers from their next read.
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Dialog, Select, Skeleton } from '../design/primitives.tsx';
import { toast } from '../shell/Shell.tsx';
import { changedWhen } from './AppsScreen.tsx';
import { type AppDataUpdate, type AppDetail, type AppSubmission, appsApi } from './api.ts';

const VALUE_CHARS = 300;

/** A response's fields as lines a person reads: `name: value`, each clipped. */
export function responseLines(data: Record<string, unknown>): { key: string; text: string }[] {
  return Object.entries(data).map(([key, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return {
      key,
      text: text.length > VALUE_CHARS ? `${text.slice(0, VALUE_CHARS)}…` : text,
    };
  });
}

/** The keys an update adds, changes and removes, as short lines; empty when it names none. */
export function updateLines(update: AppDataUpdate): string[] {
  const changes = update.changes;
  if (!changes) return [];
  const more = changes.truncated ? ', and more' : '';
  return [
    changes.added.length ? `Added: ${changes.added.join(', ')}${more}` : '',
    changes.changed.length ? `Changed: ${changes.changed.join(', ')}${more}` : '',
    changes.removed.length ? `Removed: ${changes.removed.join(', ')}${more}` : '',
  ].filter(Boolean);
}

const ALL = '';

export function ResponsesDialog({
  open,
  onClose,
  detail,
}: {
  open: boolean;
  onClose: () => void;
  detail: AppDetail;
}) {
  const id = detail.app.id;
  const [collection, setCollection] = useState(ALL);
  const [items, setItems] = useState<AppSubmission[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(
    async (before?: string) => {
      setBusy(true);
      const result = await appsApi.submissions(id, {
        ...(collection ? { collection } : {}),
        ...(before ? { before } : {}),
      });
      setBusy(false);
      if (!result.data) {
        setError(result.error ?? 'Couldn’t load the responses.');
        return;
      }
      setError(null);
      const page = result.data;
      setItems((current) =>
        before ? [...(current ?? []), ...page.submissions] : page.submissions,
      );
      setNext(page.next_before);
    },
    [id, collection],
  );

  useEffect(() => {
    if (!open) return;
    setItems(null);
    setConfirming(null);
    void load();
  }, [open, load]);

  const remove = async (submission: AppSubmission) => {
    const result = await appsApi.deleteSubmission(id, submission.id);
    setConfirming(null);
    if (!result.data) {
      toast({ kind: 'err', title: result.error ?? 'Couldn’t delete it' });
      return;
    }
    setItems((current) => (current ?? []).filter((item) => item.id !== submission.id));
    toast({ kind: 'ok', title: 'Response deleted' });
  };

  const names = detail.collections.map((entry) => entry.name);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Responses"
      sub="What people sent from this app, newest first, with who sent each."
      width={600}
    >
      <div className="col" style={{ gap: 12 }}>
        {names.length > 1 ? (
          <Select
            label="Which responses"
            value={collection}
            onChange={setCollection}
            options={[
              { value: ALL, label: 'All' },
              ...names.map((name) => ({ value: name, label: name })),
            ]}
            width={220}
          />
        ) : null}
        {error ? (
          <p className="app-row-meta" role="alert">
            {error}
          </p>
        ) : null}
        {items === null ? (
          <div aria-busy="true">
            <Skeleton width="70%" height={14} />
          </div>
        ) : items.length === 0 ? (
          <p className="app-row-meta">No responses yet.</p>
        ) : (
          <ol className="app-responses">
            {items.map((item) => (
              <li key={item.id} className="app-response">
                <div className="row app-response-head">
                  <span className="app-row-meta app-response-by">
                    {item.by?.email ?? 'Someone no longer here'} · {changedWhen(item.created_at)}
                    {names.length > 1 ? ` · ${item.collection}` : ''}
                  </span>
                  {confirming === item.id ? (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => void remove(item)}
                      aria-label={`Confirm deleting the response from ${item.by?.email ?? 'someone'}`}
                    >
                      Delete it
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirming(item.id)}
                      aria-label={`Delete the response from ${item.by?.email ?? 'someone'}`}
                    >
                      Delete
                    </Button>
                  )}
                </div>
                <dl className="app-response-fields">
                  {responseLines(item.data).map((line) => (
                    <div key={line.key} className="app-response-field">
                      <dt>{line.key}</dt>
                      <dd>{line.text}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ol>
        )}
        {next ? (
          <Button
            variant="outline"
            loading={busy}
            onClick={() => void load(next)}
            style={{ alignSelf: 'flex-start' }}
          >
            Show older
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}

export function DataUpdatesDialog({
  open,
  onClose,
  appId,
  onReleased,
}: {
  open: boolean;
  onClose: () => void;
  appId: string;
  onReleased: () => void;
}) {
  const [updates, setUpdates] = useState<AppDataUpdate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUpdates(null);
    void appsApi.dataUpdates(appId).then((result) => {
      if (!result.data) setError(result.error ?? 'Couldn’t load the updates.');
      else {
        setError(null);
        setUpdates(result.data.updates);
      }
    });
  }, [open, appId]);

  const release = async (update: AppDataUpdate) => {
    setBusy(update.artifact_id);
    const result = await appsApi.release(appId, update.binding, update.artifact_id);
    setBusy(null);
    if (!result.data) {
      toast({ kind: 'err', title: result.error ?? 'Couldn’t show it to viewers' });
      const fresh = await appsApi.dataUpdates(appId);
      if (fresh.data) setUpdates(fresh.data.updates);
      return;
    }
    setUpdates(result.data.updates);
    toast({ kind: 'ok', title: `Viewers now see the new ${update.binding}` });
    onReleased();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Data waiting for you"
      sub="You asked to see each new version before the people who open this app do."
      width={560}
    >
      {error ? (
        <p className="app-row-meta" role="alert">
          {error}
        </p>
      ) : updates === null ? (
        <div aria-busy="true">
          <Skeleton width="60%" height={14} />
        </div>
      ) : updates.length === 0 ? (
        <p className="app-row-meta">Nothing waits for you. Viewers see the newest data.</p>
      ) : (
        <ol className="app-versions">
          {updates.map((update) => (
            <li key={update.artifact_id} className="app-version">
              <span className="col" style={{ gap: 4, minWidth: 0, flex: 1 }}>
                <span className="app-version-name">
                  {update.binding}
                  <Badge tone="blue" dot style={{ marginLeft: 8 }}>
                    Waiting
                  </Badge>
                </span>
                <span className="app-row-meta">
                  {update.path} · written {changedWhen(update.written_at)}
                </span>
                <span className="app-row-meta">{update.summary}</span>
                {updateLines(update).map((line) => (
                  <span key={line} className="app-row-meta">
                    {line}
                  </span>
                ))}
              </span>
              <Button
                size="sm"
                loading={busy === update.artifact_id}
                disabled={busy !== null}
                onClick={() => void release(update)}
                aria-label={`Show the new ${update.binding} to viewers`}
              >
                Show to viewers
              </Button>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}
