/**
 * Settings → Activity: what was done in the person's name by chats and plans
 * they have since deleted. A deleted chat's messages go; the record of what it
 * sent, saved or changed elsewhere stays here.
 */
import { useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { LoadError } from '../design/LoadError.tsx';
import { Button } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { useLoad } from '../experience/hooks.ts';
import { toast } from '../shell/Shell.tsx';

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

export function ActivityTab() {
  const activity = useLoad(() => adapter.activity(), []);
  const entries = activity.data?.activity ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  // Undo runs the change's reversal as a change of its own, then the list is read again.
  const undo = (id: string) => {
    setBusy(id);
    void adapter.undoActivity(id).then((result) => {
      setBusy(null);
      if (result.data === null)
        toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t undo' });
      else toast({ kind: 'ok', title: 'Undone' });
      activity.reload();
    });
  };
  return (
    <div className="col" style={{ gap: 12 }}>
      <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
        What Melete did for you in chats and plans you have deleted: what it was, where it went and
        when. What the messages said is not kept here.
      </p>
      {activity.error ? (
        <LoadError what="your activity" error={activity.error} onRetry={activity.reload} />
      ) : null}
      <div className="card-12" style={{ overflow: 'hidden' }}>
        {entries.map((entry, index) => (
          <div
            key={entry.id}
            className="list-row"
            style={{ minHeight: 60, ...(index === 0 ? { borderTop: 0 } : {}) }}
          >
            <span style={{ color: 'var(--success)', display: 'flex' }}>
              <Icon name="circleCheck" size={18} />
            </span>
            <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
              <span
                className="clamp1"
                style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}
              >
                {entry.what}
                {entry.destination ? ` · ${entry.destination}` : ''}
              </span>
              <span className="clamp1" style={{ fontSize: 12, color: 'var(--muted)' }}>
                {entry.where} · from “{entry.source}”
                {entry.reference ? ` · ref ${entry.reference}` : ''}
                {entry.undone_at ? ' · undone' : ''}
              </span>
            </div>
            {entry.undo && Date.parse(entry.undo.valid_until) > Date.now() ? (
              <Button
                variant="outline"
                size="sm"
                className="btn-undo"
                disabled={busy === entry.id}
                onClick={() => undo(entry.id)}
                title={`Undo until ${when(entry.undo.valid_until)}`}
              >
                Undo
              </Button>
            ) : null}
            <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
              {when(entry.happened_at)}
            </span>
          </div>
        ))}
        {activity.data && !activity.error && entries.length === 0 ? (
          <div style={{ padding: '28px 16px', fontSize: 14, color: 'var(--muted)' }}>
            When you delete a chat that sent or changed something, it is listed here.
          </div>
        ) : null}
      </div>
    </div>
  );
}
