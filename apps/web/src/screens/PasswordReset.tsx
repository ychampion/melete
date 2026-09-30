/**
 * The way back in after a forgotten password. A reset link opens this page
 * with its one-time code; without one, the page asks for a mailed link, or
 * explains how the person who runs this Melete prints one on its host.
 */
import { useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { MeleteMark } from '../design/mark.tsx';
import { Button, Field, Input } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { navigate, useRoute } from '../router.ts';

const panel: React.CSSProperties = { gap: 12, padding: 16 };

function Notice({ text }: { text: string }) {
  return (
    <div
      role="status"
      className="row"
      style={{
        gap: 8,
        padding: '10px 12px',
        borderRadius: 10,
        background: 'var(--sand)',
        color: 'var(--sand-ink)',
        fontSize: 13,
        alignItems: 'flex-start',
      }}
    >
      <Icon name="info" size={14} />
      <span>{text}</span>
    </div>
  );
}

function ChooseNew({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (done)
    return (
      <div className="col card" style={panel}>
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--heading)' }}>
          Your password is changed
        </span>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          Every device and connected app was signed out. Sign in with the new password.
        </span>
        <Button icon="chevronRight" onClick={() => navigate('/welcome')}>
          Sign in
        </Button>
      </div>
    );
  return (
    <form
      className="col card"
      style={panel}
      onSubmit={(event) => {
        event.preventDefault();
        if (password.length < 8) return setNotice('The password needs at least 8 characters.');
        if (password !== again) return setNotice('The two passwords are not the same.');
        setBusy(true);
        setNotice(null);
        void adapter.consumePasswordReset(token, password).then((result) => {
          setBusy(false);
          if (result.data) {
            // The used code leaves the address bar and the history entry.
            window.history.replaceState(null, '', `${window.location.pathname}#/reset`);
            setDone(true);
          } else setNotice(result.error ?? result.unavailable ?? 'That did not work.');
        });
      }}
    >
      <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--heading)' }}>
        Choose a new password
      </span>
      <Field label="New password">
        <Input
          type="password"
          icon="lock"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="At least 8 characters"
          autoComplete="new-password"
          width="100%"
          height={44}
        />
      </Field>
      <Field label="The same again">
        <Input
          type="password"
          icon="lock"
          value={again}
          onChange={(event) => setAgain(event.target.value)}
          autoComplete="new-password"
          width="100%"
          height={44}
        />
      </Field>
      <Button size="lg" block type="submit" loading={busy}>
        Set the new password
      </Button>
      {notice ? <Notice text={notice} /> : null}
    </form>
  );
}

function AskForLink({ onCode }: { onCode: (code: string) => void }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  return (
    <>
      <form
        className="col card"
        style={panel}
        onSubmit={(event) => {
          event.preventDefault();
          if (!email.includes('@')) return setNotice('Enter the email address you sign in with.');
          setBusy(true);
          setNotice(null);
          void adapter.requestPasswordReset(email).then((result) => {
            setBusy(false);
            if (result.data) setSent(true);
            else setNotice(result.error ?? result.unavailable ?? 'Couldn’t send the link.');
          });
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--heading)' }}>
          Email me a reset link
        </span>
        {sent ? (
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>
            If {email} has an account here, a link is on its way. It works once and expires in 30
            minutes.
          </span>
        ) : (
          <>
            <Field label="Email">
              <Input
                type="email"
                icon="mail"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                width="100%"
                height={44}
              />
            </Field>
            <Button block type="submit" loading={busy}>
              Send the link
            </Button>
          </>
        )}
        {notice ? <Notice text={notice} /> : null}
      </form>
      <div className="col card" style={panel}>
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--heading)' }}>
          No email set up?
        </span>
        <span style={{ fontSize: 13, color: 'var(--muted)', lineHeight: '19px' }}>
          The person who runs this Melete can print a one-time link on the machine it runs on:
        </span>
        <code
          style={{
            fontSize: 12,
            padding: '8px 10px',
            borderRadius: 8,
            background: 'var(--soft)',
            border: '1px solid var(--line)',
            overflowWrap: 'anywhere',
          }}
        >
          bun run reset-password you@example.com
        </code>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          With Docker Compose, run it as{' '}
          <code style={{ overflowWrap: 'anywhere' }}>
            docker compose exec melete bun run reset-password you@example.com
          </code>
          . Open the link it prints, or paste its code here.
        </span>
        <form
          className="row"
          style={{ gap: 8, flexWrap: 'wrap' }}
          onSubmit={(event) => {
            event.preventDefault();
            if (code.trim()) onCode(code.trim());
          }}
        >
          <Input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Reset code"
            aria-label="Reset code"
            width="min(100%, 240px)"
          />
          <Button variant="outline" type="submit" disabled={!code.trim()}>
            Use the code
          </Button>
        </form>
      </div>
    </>
  );
}

export function PasswordResetScreen() {
  const route = useRoute();
  const [code, setCode] = useState<string | null>(null);
  const token = route.query.get('token') ?? code;
  return (
    <div
      className="col"
      style={{
        height: '100%',
        overflowY: 'auto',
        alignItems: 'center',
        padding: '48px 16px',
        background: 'var(--canvas)',
      }}
    >
      <div className="col" style={{ gap: 16, width: 420, maxWidth: '100%' }}>
        <MeleteMark width={56} />
        <h1 style={{ fontSize: 26, fontWeight: 700, lineHeight: '32px' }}>Reset your password</h1>
        {token ? <ChooseNew token={token} /> : <AskForLink onCode={setCode} />}
        <Button variant="ghost" icon="chevronLeft" onClick={() => navigate('/welcome')}>
          Back to sign-in
        </Button>
      </div>
    </div>
  );
}
