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

export function WaitingOnSection({ now }: { now: number }) {
  const { refreshConversations } = useApp();
  const [view, setView] = useState<WaitingOn | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const live = useRef(true);

  const load = useCallback(async () => {
    const result = await companiesApi.waitingOn();
    if (live.current && result.data) setView(result.data);
    return result.data;
  }, []);

  // A first run: the mailbox is connected and nothing has been read, so read it.
  // A scan already under way is waited out rather than started again.
  const readMail = useCallback(
    async (first: WaitingOn) => {
      if (!first.scan.connected || first.scan.status === 'done' || first.scan.status === 'failed')
        return;
      setReading(true);
      if (first.scan.status === 'none') {
        const space = await currentSpaceId();
        if (space.data === null || (await companiesApi.startScan(space.data)).data === null) {
          if (live.current) setReading(false);
          return;
        }
      }
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (!live.current) return;
        const next = await load();
        if (next?.scan.status !== 'running') break;
      }
      if (live.current) setReading(false);
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
                  aria-label={`Chase ${entry.who}`}
                  onClick={() => void chase(entry)}
                >
                  Chase this
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
