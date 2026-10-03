/**
 * "Waiting on": what companies owe the person and the replies nobody has sent
 * them, with the few worth chasing first. On a first run, with a mailbox
 * connected and nothing read yet, it reads the mail itself and says so while
 * it does. Everything shown is what `GET /waiting-on` returned; "Chase this"
 * starts the same chase "Handle it" does, and the first message still asks.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { companiesApi, currentSpaceId } from '../companies/api.ts';
import { money } from '../companies/format.ts';
import { Icon } from '../design/icons.tsx';
import { Button } from '../design/primitives.tsx';
import { useApp } from '../experience/hooks.ts';
import type { WaitingOn, WaitingOnEntry } from '../experience/types.ts';
import { navigate } from '../router.ts';
import { toast } from '../shell/Shell.tsx';

const DAY = 86_400_000;
const POLL_MS = 2_000;

/** "Waiting on: £534.50 and 3 replies", with any part whose count is zero left out. */
export function waitingOnLine(view: WaitingOn): string | null {
  const parts = [
    view.owed_minor > 0 ? money(view.owed_minor, view.currency) : null,
    view.replies.length > 0
      ? `${view.replies.length} ${view.replies.length === 1 ? 'reply' : 'replies'}`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? `Waiting on: ${parts.join(' and ')}` : null;
}

/** What sits at the end of a row: the figure owed, or how long a message has waited. */
export function entryDetail(entry: WaitingOnEntry, now: number): string | null {
  if (entry.kind === 'owed')
    return entry.amount_minor !== null && entry.currency
      ? money(entry.amount_minor, entry.currency)
      : null;
  if (!entry.sent_at) return null;
  const days = Math.max(0, Math.round((now - Date.parse(entry.sent_at)) / DAY));
  return days === 1 ? 'Sent yesterday' : `Sent ${days} days ago`;
}

/**
 * What to do about the mail on arriving: read it when nothing has been read
 * yet, or when the last read finished before replies were looked for; wait out
 * a read already under way; otherwise nothing.
 */
export function mailPlan(scan: WaitingOn['scan']): 'start' | 'wait' | null {
  if (!scan.connected) return null;
  if (scan.status === 'running') return 'wait';
  if (scan.status === 'none' || (scan.status === 'done' && scan.stale)) return 'start';
  return null;
}

export function WaitingOnSection({ now }: { now: number }) {
  const { refreshConversations } = useApp();
  const [view, setView] = useState<WaitingOn | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const live = useRef(true);

  const load = useCallback(async (spaceId?: string) => {
    const result = await companiesApi.waitingOn(spaceId);
    if (live.current && result.data) setView(result.data);
    return result.data;
  }, []);

  // A first run: the mailbox is connected and nothing has been read, so read it.
  // A scan already under way is waited out rather than started again. The scan
  // is started, and watched, in the space the service reported it for.
  const readMail = useCallback(
    async (first: WaitingOn) => {
      const plan = mailPlan(first.scan);
      if (!plan) return;
      setReading(true);
      let spaceId = first.scan.space_id ?? undefined;
      if (plan === 'start') {
        if (!spaceId) {
          const space = await currentSpaceId();
          spaceId = space.data ?? undefined;
        }
        if (!spaceId || (await companiesApi.startScan(spaceId)).data === null) {
          if (live.current) setReading(false);
          return;
        }
      }
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (!live.current) return;
        const next = await load(spaceId);
        if (next?.scan.status !== 'running') break;
      }
      // Back to every space the person can see.
      if (live.current) {
        await load();
        setReading(false);
      }
    },
    [load],
  );

  useEffect(() => {
    live.current = true;
    void load().then((first) => {
      if (first) void readMail(first);
    });
    return () => {
      live.current = false;
    };
  }, [load, readMail]);

  const chase = async (entry: WaitingOnEntry) => {
    if (busy) return;
    // A connected app's item opens where its step's tool and input are shown.
    if (entry.added_by !== undefined) {
      navigate(`/companies?item=${encodeURIComponent(entry.id)}`);
      return;
    }
    setBusy(entry.id);
    const result =
      entry.kind === 'owed'
        ? await companiesApi.handle(entry.id)
        : await companiesApi.chaseReply(entry.id);
    setBusy(null);
    if (result.data === null) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t start it' });
      return;
    }
    refreshConversations();
    navigate(`/chat/${result.data.job_id}`);
  };

  // Not waiting on it any more: it leaves the list, and a later scan leaves it out.
  const dismiss = async (entry: WaitingOnEntry) => {
    if (busy) return;
    setBusy(entry.id);
    const result = await companiesApi.dropReply(entry.id);
    if (result.data === null) {
      setBusy(null);
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t dismiss it' });
      return;
    }
    await load();
    if (live.current) setBusy(null);
  };

  if (!view) return null;
  if (reading)
    return (
      <section className="home-section" aria-labelledby="home-waiting-on" aria-busy="true">
        <div className="home-section-head">
          <h2 id="home-waiting-on">Waiting on</h2>
        </div>
        <p className="waiting-on-line" role="status">
          <Icon name="loader" size={14} />
          Reading your mail for money you’re owed and replies you’re waiting on.
        </p>
      </section>
    );
  const line = waitingOnLine(view);
  if (!line) return null;

  return (
    <section className="home-section" aria-labelledby="home-waiting-on">
      <div className="home-section-head">
        <h2 id="home-waiting-on">Waiting on</h2>
      </div>
      <p className="waiting-on-line voice">{line}</p>
      {view.top.length ? (
        <ul className="waiting-on-list">
          {view.top.map((entry) => {
            const detail = entryDetail(entry, now);
            return (
              <li key={entry.id} className="waiting-on-row">
                <Icon name={entry.kind === 'owed' ? 'piggy' : 'mail'} size={16} />
                <span className="col grow" style={{ gap: 1, minWidth: 0 }}>
                  <span className="clamp1 waiting-on-who">{entry.who}</span>
                  <span className="clamp1 waiting-on-what">{entry.what}</span>
                </span>
                {detail ? <span className="waiting-on-detail">{detail}</span> : null}
                <Button
                  size="sm"
                  variant="outline"
                  loading={busy === entry.id}
                  disabled={busy !== null}
                  aria-label={
                    entry.next_step_label
                      ? `${entry.next_step_label}: ${entry.who}`
                      : `Chase ${entry.who}`
                  }
                  onClick={() => void chase(entry)}
                >
                  {entry.next_step_label ?? 'Chase this'}
                </Button>
                {entry.kind === 'reply' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    aria-label={`Dismiss ${entry.who}`}
                    onClick={() => void dismiss(entry)}
                  >
                    Dismiss
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
