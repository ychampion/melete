/**
 * What I've learned: the lessons Melete took from the person's corrections and
 * the skills it wrote for itself, in one list. Each item says what it does,
 * where it came from and whether it is in use, and offers only the actions the
 * service allows in its state. Every change can be undone by the id the
 * person was shown, from the snackbar or from the last-change line.
 */
import { useState } from 'react';
import { currentSpaceId } from '../companies/api.ts';
import { Icon } from '../design/icons.tsx';
import { Badge, type BadgeTone, Button } from '../design/primitives.tsx';
import { adapter, type Result } from '../experience/adapter.ts';
import { useLoad } from '../experience/hooks.ts';
import type { LearnedChange, LearnedItem, LearnedList } from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';

type Action = LearnedItem['actions'][number];

export const ACTION_LABEL: Record<Action, string> = {
  try: 'Try it',
  pause: 'Pause',
  resume: 'Resume',
  remove: 'Remove',
  share: 'Share with your space',
  approve: 'Approve',
  edit: 'Edit',
  stop: 'Don’t do this',
};

/** The words a change is announced with, and undone from. */
export const CHANGE_WORD: Record<LearnedChange['action'], string> = {
  pause: 'Paused',
  resume: 'Resumed',
  remove: 'Removed',
  keep: 'Kept',
  decline: 'Declined',
};

/** Why stopping is recorded: the person said so here. */
const STOP_REASON = 'You said not to do this, from What I’ve learned.';

export function stateBadge(item: LearnedItem): { text: string; tone: BadgeTone } {
  switch (item.state) {
    case 'proposed':
      return item.source === 'engine'
        ? { text: 'Waiting for your OK', tone: 'learning' }
        : { text: 'New', tone: 'blue' };
    case 'trial':
      return { text: 'On trial', tone: 'learning' };
    case 'active':
      return { text: 'In use', tone: 'success' };
    case 'paused':
      return { text: 'Paused', tone: 'neutral' };
    case 'reverted':
      return { text: 'Stopped', tone: 'neutral' };
  }
}

const dateOf = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** Where it came from, when, and who it reaches. */
export function originLine(item: LearnedItem): string {
  const from =
    item.source === 'engine' ? 'Melete wrote this for itself' : 'Learned from your correction';
  return `${from} · ${dateOf(item.learned_at)}${item.shared ? ' · Shared with your space' : ''}`;
}

/** Said only while it is about to leave the list with the correction it came from. */
export function expiryLine(item: LearnedItem): string | null {
  if (!item.expiring_soon || !item.expires_at) return null;
  return `Leaves this list on ${dateOf(item.expires_at)} unless you try it`;
}

type Extra = { body?: string };

export function LearnedRow({
  item,
  body,
  busy,
  onAct,
}: {
  item: LearnedItem;
  /** An engine skill's full text, for editing it in the person's own words. */
  body?: string;
  busy: boolean;
  onAct: (action: Action, extra?: Extra) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body ?? item.does.join('\n'));
  const [stopping, setStopping] = useState(false);
  const badge = stateBadge(item);
  const expiry = expiryLine(item);
  return (
    <div
      className="col"
      style={{ gap: 8, padding: '12px 14px', borderTop: '1px solid var(--line)' }}
    >
      <div className="row" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <span
          className="row"
          style={{
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 8,
            background: 'var(--blue-soft)',
            color: 'var(--blue-ink)',
            flexShrink: 0,
          }}
        >
          <Icon name={item.source === 'engine' ? 'sparkles' : 'book'} size={14} />
        </span>
        <div className="col grow" style={{ gap: 4, minWidth: 200 }}>
          <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--heading)' }}>
              {item.name}
            </span>
            <Badge tone={badge.tone}>{badge.text}</Badge>
          </span>
          {editing ? (
            <form
              className="col"
              style={{ gap: 8 }}
              onSubmit={(event) => {
                event.preventDefault();
                const next = draft.trim();
                if (!next) return;
                void onAct('edit', { body: next }).then((ok) => ok && setEditing(false));
              }}
            >
              <textarea
                className="textarea"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                aria-label={`Your version of ${item.name}`}
                rows={4}
                // biome-ignore lint/a11y/noAutofocus: the person just asked to edit this text
                autoFocus
              />
              <span className="row" style={{ gap: 8 }}>
                <Button size="sm" type="submit" loading={busy} disabled={busy}>
                  Save your version
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </span>
            </form>
          ) : item.does.length ? (
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 14, color: 'var(--text)' }}>
              {item.does.map((step) => (
                <li key={step} style={{ lineHeight: '21px' }}>
                  {step}
                </li>
              ))}
            </ol>
          ) : null}
          {item.applies_when.length ? (
            <span style={{ fontSize: 13, color: 'var(--secondary)' }}>
              When you ask to {item.applies_when.map((phrase) => `“${phrase}”`).join(' or ')}
            </span>
          ) : null}
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {originLine(item)}
            {expiry ? ` · ${expiry}` : ''}
          </span>
          {item.state === 'reverted' && item.reason ? (
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{item.reason}</span>
          ) : null}
          {stopping ? (
            <div
              className="col"
              style={{
                gap: 8,
                fontSize: 13,
                color: 'var(--secondary)',
                padding: '8px 12px',
                borderRadius: 10,
                background: 'var(--soft)',
              }}
            >
              <span>
                Melete stops using this, and won’t write it again in any space until you say so.
              </span>
              <span className="row" style={{ gap: 8 }}>
                <Button
                  size="sm"
                  variant="destructive"
                  loading={busy}
                  disabled={busy}
                  onClick={() => void onAct('stop').then((ok) => ok && setStopping(false))}
                >
                  Stop it
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setStopping(false)}>
                  Keep it
                </Button>
              </span>
            </div>
          ) : null}
        </div>
        {editing || stopping ? null : (
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {item.actions.map((action) => (
              <Button
                key={action}
                size="sm"
                variant={
                  action === 'try' || action === 'approve'
                    ? 'primary'
                    : action === 'remove' || action === 'stop'
                      ? 'ghost'
                      : 'outline'
                }
                disabled={busy}
                aria-label={`${ACTION_LABEL[action]}: ${item.name}`}
                onClick={() => {
                  if (action === 'edit') setEditing(true);
                  else if (action === 'stop') setStopping(true);
                  else void onAct(action);
                }}
              >
                {ACTION_LABEL[action]}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type Loaded = { space: string; list: LearnedList; bodies: Record<string, string> };

async function loadLearned(): Promise<Result<Loaded>> {
  const space = await currentSpaceId();
  if (space.data === null) return space;
  const [list, skills] = await Promise.all([
    adapter.learned(space.data),
    adapter.engineSkills(space.data),
  ]);
  if (list.data === null) return list;
  const bodies = Object.fromEntries((skills.data?.skills ?? []).map((s) => [s.id, s.body]));
  return { data: { space: space.data, list: list.data, bodies }, error: null, unavailable: null };
}

export function LearnedTab({ onCount }: { onCount?: (count: number) => void }) {
  const learned = useLoad(async () => {
    const result = await loadLearned();
    if (result.data) onCount?.(result.data.list.items.length);
    return result;
  }, []);
  const [busy, setBusy] = useState<string | null>(null);
  const loaded = learned.data;
  const items = loaded?.list.items ?? [];
  const last = loaded?.list.last_change ?? null;

  const failed = (r: { error: string | null; unavailable: string | null }, fallback: string) => {
    toast({ kind: 'err', title: r.error ?? r.unavailable ?? fallback });
    return false;
  };

  const undo = async (change: LearnedChange) => {
    if (!loaded) return;
    const r = await adapter.undoLearned(loaded.space, change.id);
    if (r.data === null) {
      failed(r, 'Couldn’t undo that');
      return;
    }
    toast({
      kind: 'ok',
      title: `Undone: ${CHANGE_WORD[change.action].toLowerCase()} “${change.name}”`,
    });
    learned.reload();
  };

  const act = async (item: LearnedItem, action: Action, extra: Extra = {}): Promise<boolean> => {
    if (!loaded || busy) return false;
    setBusy(item.id);
    try {
      if (action === 'pause' || action === 'resume' || action === 'remove' || action === 'share') {
        const r = await adapter.changeLearned(item.id, action, loaded.space);
        if (r.data === null) return failed(r, 'Couldn’t change that');
        const { item: next, change } = r.data;
        const nextItems = next
          ? items.map((i) => (i.id === next.id ? next : i))
          : items.filter((i) => i.id !== item.id);
        learned.set({ ...loaded, list: { items: nextItems, last_change: change ?? last } });
        if (change)
          toast({
            kind: 'ok',
            title: `${CHANGE_WORD[change.action]} “${change.name}”`,
            action: 'Undo',
            onAction: () => void undo(change),
          });
        else toast({ kind: 'ok', title: `Shared “${item.name}” with your space` });
        return true;
      }
      if (action === 'try') {
        const r = await adapter.tryLearned(item.id, loaded.space, item.definition_hash);
        if (r.data === null) return failed(r, 'Couldn’t start trying it');
        toast({
          kind: 'ok',
          title: `Trying “${item.name}”`,
          sub: 'Melete uses it on your own work until you say to keep it or not.',
        });
      } else if (action === 'approve') {
        const r = await adapter.approveSkill(item.id, loaded.space, item.definition_hash);
        if (r.data === null) return failed(r, 'Couldn’t approve it');
        toast({ kind: 'ok', title: `Approved “${item.name}”` });
      } else if (action === 'edit') {
        const r = await adapter.editSkill(
          item.id,
          loaded.space,
          item.definition_hash,
          extra.body ?? '',
        );
        if (r.data === null) return failed(r, 'Couldn’t save your version');
        toast({
          kind: 'ok',
          title: 'Saved your version',
          sub: 'Melete uses your words from now on.',
        });
      } else if (action === 'stop') {
        const r = await adapter.stopSkill(item.id, loaded.space, STOP_REASON);
        if (r.data === null) return failed(r, 'Couldn’t stop it');
        toast({ kind: 'ok', title: `Melete won’t do “${item.name}”` });
      }
      learned.reload();
      return true;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="col" style={{ gap: 12 }}>
      <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
        What Melete took from your corrections, and what it wrote down for itself. Pause, change or
        remove anything; every change can be undone.
      </p>
      {learned.error ? (
        <p style={{ color: 'var(--danger)', fontSize: 13 }}>{learned.error}</p>
      ) : null}
      {learned.unavailable ? (
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>{learned.unavailable}</p>
      ) : null}
      {last ? (
        <div className="row" style={{ gap: 8, fontSize: 13, color: 'var(--secondary)' }}>
          <Icon name="clock" size={14} />
          <span className="grow">
            Last change: {CHANGE_WORD[last.action].toLowerCase()} “{last.name}”
          </span>
          <Button size="sm" variant="ghost" onClick={() => void undo(last)}>
            Undo
          </Button>
        </div>
      ) : null}
      {loaded ? (
        <div className="card-12" style={{ overflow: 'hidden' }}>
          <div style={{ height: 1 }} />
          {items.map((item) => (
            <LearnedRow
              key={item.id}
              item={item}
              body={loaded.bodies[item.id]}
              busy={busy === item.id}
              onAct={(action, extra) => act(item, action, extra)}
            />
          ))}
          {items.length === 0 ? (
            <div
              className="col"
              style={{ alignItems: 'center', gap: 8, padding: '32px 24px', textAlign: 'center' }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-head)',
                  fontSize: 16,
                  fontWeight: 600,
                  color: 'var(--heading)',
                }}
              >
                Nothing learned yet
              </span>
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                Correct Melete once and it’ll remember how you like it done.
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
