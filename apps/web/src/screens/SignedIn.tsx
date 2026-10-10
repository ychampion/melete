/**
 * Settings › Account › Where you're signed in: every browser signed in to the
 * account, and the computers, notifications and assistants that reach it
 * without a password. Each browser or computer can be signed out on its own,
 * and "Sign out everywhere else" ends all of it but this browser.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../design/primitives.tsx';
import { keepingPushHere } from '../experience/account.ts';
import { adapter } from '../experience/adapter.ts';
import type { AccountAccess } from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Row({ title, sub, action }: { title: string; sub: string; action?: React.ReactNode }) {
  return (
    <div
      className="row"
      style={{
        gap: 12,
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid var(--line)',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
      }}
    >
      <div className="col" style={{ gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--heading)' }}>{title}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{sub}</span>
      </div>
      {action}
    </div>
  );
}

export function SignedIn() {
  const [access, setAccess] = useState<AccountAccess | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    void adapter.accountAccess().then((result) => {
      if (result.data) {
        setAccess(result.data);
        setProblem(null);
      } else setProblem(result.unavailable ?? result.error);
    });
  }, []);
  useEffect(load, [load]);

  const run = async (key: string, call: () => Promise<{ data: unknown; error: string | null }>) => {
    setBusy(key);
    const result = await call();
    setBusy(null);
    if (result.data === null) {
      toast({ kind: 'err', title: result.error ?? 'That didn’t work. Try again.' });
      return false;
    }
    load();
    return true;
  };

  const everywhereElse = async () => {
    const done = await run('others', () => keepingPushHere(() => adapter.signOutOthers()));
    if (done)
      toast({
        kind: 'ok',
        title: 'Signed out everywhere else',
        sub: 'Other browsers, computers, connected assistants and notifications were signed out. This browser stays signed in.',
      });
  };

  const heading = (
    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>
      Where you’re signed in
    </span>
  );
  if (!access)
    return (
      <div className="col" style={{ gap: 8 }}>
        {heading}
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {problem ?? 'Reading where you’re signed in…'}
        </span>
      </div>
    );

  const others = access.sessions.filter((session) => !session.current);
  const anythingElse =
    others.length +
      access.computers.length +
      access.notifications.length +
      access.assistants.length >
    0;
  return (
    <div className="col" style={{ gap: 10, maxWidth: 560 }}>
      {heading}
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
        Sign out anything you don’t recognise. A browser signs in for 30 days at most.
      </span>
      {access.sessions.map((session) => (
        <Row
          key={session.id}
          title={session.current ? `${session.label} · this browser` : session.label}
          sub={`Signed in ${day(session.created_at)}`}
          action={
            session.current ? null : (
              <Button
                variant="outline"
                size="sm"
                loading={busy === session.id}
                onClick={() => void run(session.id, () => adapter.endSession(session.id))}
              >
                Sign out
              </Button>
            )
          }
        />
      ))}
      {access.computers.map((computer) => (
        <Row
          key={computer.id}
          title={computer.name}
          sub={`Computer connected ${day(computer.paired_at)}`}
          action={
            <Button
              variant="outline"
              size="sm"
              loading={busy === computer.id}
              onClick={() => void run(computer.id, () => adapter.revokeDevice(computer.id))}
            >
              Disconnect
            </Button>
          }
        />
      ))}
      {access.notifications.length > 0 ? (
        <Row
          title={`${plural(access.notifications.length, 'browser gets', 'browsers get')} notifications`}
          sub={access.notifications.map((device) => device.label).join(', ')}
        />
      ) : null}
      {access.assistants.length > 0 ? (
        <Row
          title={`${plural(access.assistants.length, 'assistant', 'assistants')} connected`}
          sub={access.assistants.map((assistant) => assistant.client).join(', ')}
        />
      ) : null}
      <div className="row">
        <Button
          variant="outline"
          loading={busy === 'others'}
          disabled={!anythingElse}
          onClick={() => void everywhereElse()}
        >
          Sign out everywhere else
        </Button>
      </div>
    </div>
  );
}
