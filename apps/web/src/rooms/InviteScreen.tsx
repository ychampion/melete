/**
 * The page an invite link opens: `#/invite?token=…`. It shows the room's name
 * and how long the invite lasts, and nothing about the room's people. Someone
 * new chooses a password and lands in the room as a guest; someone who is
 * already a guest here joins while signed in. The token travels in the link's
 * fragment and in request bodies, never in a path a server keeps.
 */
import { useEffect, useState } from 'react';
import { MeleteMark } from '../design/mark.tsx';
import { Button, Field, Input } from '../design/primitives.tsx';
import { useApp } from '../experience/hooks.ts';
import { navigate, useRoute } from '../router.ts';
import { type InviteView, roomsApi } from './api.ts';
import { dayOf } from './reduce.ts';
import './rooms.css';

const page: React.CSSProperties = {
  height: '100%',
  overflowY: 'auto',
  alignItems: 'center',
  padding: '48px 16px',
  background: 'var(--canvas)',
};

export function InviteScreen({
  signedIn,
  onJoined,
}: {
  /** Who is signed in on this browser now, if anyone. */
  signedIn: 'person' | 'guest' | null;
  /** The new session is read again, so the app opens as the guest. */
  onJoined: () => void;
}) {
  const route = useRoute();
  const { signOut } = useApp();
  const token = route.query.get('token') ?? '';
  const [view, setView] = useState<InviteView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (!token) {
      setProblem('This invite link is not complete. Open the whole link you were sent.');
      return;
    }
    void roomsApi.viewInvite(token).then((result) => {
      if (!live) return;
      if (result.data) setView(result.data);
      else setProblem(result.error ?? result.unavailable);
    });
    return () => {
      live = false;
    };
  }, [token]);

  const join = async () => {
    if (busy) return;
    setBusy(true);
    const result = await roomsApi.acceptInvite(
      token,
      signedIn ? null : password,
      signedIn ? null : name,
    );
    setBusy(false);
    if (!result.data) {
      setError(result.error ?? result.unavailable);
      return;
    }
    onJoined();
    navigate(`/rooms/${result.data.room_id}`);
  };
  const signOutHere = async () => {
    const back = window.location.hash;
    await signOut();
    window.location.hash = back;
  };

  const newcomer = view !== null && !view.existing_account && signedIn === null;
  return (
    <div className="col" style={page}>
      <div className="col invite-card">
        <MeleteMark width={56} />
        {problem ? (
          <>
            <h1 className="invite-title">This invite can’t be used</h1>
            <p className="invite-sub">{problem}</p>
          </>
        ) : !view ? (
          <p className="invite-sub" aria-busy="true">
            Reading the invite…
          </p>
        ) : (
          <>
            <h1 className="invite-title voice">You’re invited to {view.room_name}</h1>
            <p className="invite-sub">
              You join as a guest until {dayOf(view.expires_at)}. You read and post in this room,
              and ask its agent when the room allows it. You see no one’s email, and nobody sees
              yours.
            </p>
            {signedIn === 'person' ? (
              <div className="col" style={{ gap: 10 }}>
                <p className="invite-note" role="status">
                  You are signed in to an account here. A guest joins with their own sign-in: sign
                  out, then this page asks for a password.
                </p>
                <div>
                  <Button variant="outline" onClick={() => void signOutHere()}>
                    Sign out
                  </Button>
                </div>
              </div>
            ) : view.existing_account && signedIn === null ? (
              <div className="col" style={{ gap: 10 }}>
                <p className="invite-note" role="status">
                  This email already has an account here. Sign in with it, then open this link again
                  to join.
                </p>
                <div>
                  <Button variant="outline" onClick={() => navigate('/welcome')}>
                    Sign in
                  </Button>
                </div>
              </div>
            ) : (
              <form
                className="col"
                style={{ gap: 14 }}
                onSubmit={(event) => {
                  event.preventDefault();
                  void join();
                }}
              >
                {newcomer ? (
                  <>
                    <Field label="Your name" hint="Optional. People in the room see it.">
                      <Input
                        value={name}
                        maxLength={80}
                        autoComplete="name"
                        onChange={(event) => setName(event.target.value)}
                      />
                    </Field>
                    <Field label="Choose a password" hint="At least 8 characters.">
                      <Input
                        type="password"
                        value={password}
                        minLength={8}
                        autoComplete="new-password"
                        error={error !== null}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                    </Field>
                  </>
                ) : null}
                {error ? (
                  <p className="rooms-error" role="alert">
                    {error}
                  </p>
                ) : null}
                <div>
                  <Button
                    type="submit"
                    loading={busy}
                    disabled={busy || (newcomer && password.length < 8)}
                  >
                    Join {view.room_name}
                  </Button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
