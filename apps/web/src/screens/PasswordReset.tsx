/**
 * The way back in after a forgotten password. A reset link opens this page
 * with its one-time code; without one, the page mails a link when this Melete
 * can send email, and takes a code someone sent the person. A code is checked
 * before a new password is asked for.
 */
import { useEffect, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { MeleteMark } from '../design/mark.tsx';
import { Button, Field, Input } from '../design/primitives.tsx';
import { NEW_PASSWORD_MIN, resetCodeFrom } from '../experience/account.ts';
import { adapter } from '../experience/adapter.ts';
import { linkParam, navigate, useRoute } from '../router.ts';

const panel: React.CSSProperties = { gap: 12, padding: 16 };

const WRONG_CODE = 'That code isn’t right. Copy the whole code, or open the link it came in.';

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

function Problem({ text }: { text: string }) {
  return (
    <span role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>
      {text}
    </span>
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
        if (password.length < NEW_PASSWORD_MIN)
          return setNotice(`The password needs at least ${NEW_PASSWORD_MIN} characters.`);
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
          placeholder={`At least ${NEW_PASSWORD_MIN} characters`}
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

function AskForLink({
  onCode,
  codeProblem,
}: {
  onCode: (code: string) => void;
  codeProblem: string | null;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [emailProblem, setEmailProblem] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [typedProblem, setTypedProblem] = useState<string | null>(null);
  // Whether this Melete can email a link; until it says, the form is offered.
  const [canEmail, setCanEmail] = useState(true);
  useEffect(() => {
    void adapter.setupStatus().then((status) => {
      if (status.data?.email_sign_in === false) setCanEmail(false);
    });
  }, []);
  const shownCodeProblem = typedProblem ?? codeProblem;
  return (
    <>
      {canEmail ? (
        <form
          className="col card"
          style={panel}
          onSubmit={(event) => {
            event.preventDefault();
            if (!email.includes('@'))
              return setEmailProblem('Enter the email address you sign in with.');
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
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setEmailProblem(null);
                  }}
                  placeholder="you@example.com"
                  autoComplete="email"
                  width="100%"
                  height={44}
                  error={emailProblem !== null}
                  aria-invalid={emailProblem !== null}
                />
              </Field>
              {emailProblem ? <Problem text={emailProblem} /> : null}
              <Button block type="submit" loading={busy}>
                Send the link
              </Button>
            </>
          )}
          {notice ? <Notice text={notice} /> : null}
        </form>
      ) : (
        <Notice text="This Melete can’t email you a reset link. Ask whoever set up your account to send you one." />
      )}
      <form
        className="col card"
        style={panel}
        onSubmit={(event) => {
          event.preventDefault();
          if (!code.trim()) return setTypedProblem('Paste the reset code, or the whole link.');
          const found = resetCodeFrom(code);
          if (!found) return setTypedProblem(WRONG_CODE);
          setTypedProblem(null);
          onCode(found);
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--heading)' }}>
          Have a reset code?
        </span>
        <span style={{ fontSize: 13, color: 'var(--muted)', lineHeight: '19px' }}>
          If someone sent you a reset link, open it, or paste it or its code here.
        </span>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Input
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
              setTypedProblem(null);
            }}
            placeholder="Reset code"
            aria-label="Reset code"
            width="min(100%, 240px)"
            spellCheck={false}
            error={shownCodeProblem !== null}
            aria-invalid={shownCodeProblem !== null}
          />
          <Button variant="outline" type="submit">
            Use the code
          </Button>
        </div>
        {shownCodeProblem ? <Problem text={shownCodeProblem} /> : null}
      </form>
    </>
  );
}

type Verdict = { token: string; ok: boolean; problem: string | null };

export function PasswordResetScreen() {
  const route = useRoute();
  const [entered, setEntered] = useState<string | null>(null);
  const linked = linkParam(route, 'token');
  const token = linked ?? entered;
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [codeProblem, setCodeProblem] = useState<string | null>(null);

  // A code is checked before a new password is chosen for it.
  useEffect(() => {
    if (!token) return;
    let live = true;
    void adapter.checkPasswordReset(token).then((result) => {
      if (!live) return;
      // An installation that can't check codes leaves the check to the last step.
      const ok = result.data !== null || result.unavailable !== null;
      setVerdict({ token, ok, problem: ok ? null : (result.error ?? WRONG_CODE) });
    });
    return () => {
      live = false;
    };
  }, [token]);

  // A code that isn't good goes back to the form, saying so there.
  useEffect(() => {
    if (!verdict || verdict.ok) return;
    setCodeProblem(verdict.problem);
    setEntered(null);
    if (linked) navigate('/reset');
  }, [verdict, linked]);

  const settled = token !== null && verdict?.token === token;
  let body: React.ReactNode;
  if (token && settled && verdict?.ok) body = <ChooseNew token={token} />;
  else if (token && !settled)
    body = (
      <div className="col card" style={panel}>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>Checking the code…</span>
      </div>
    );
  else
    body = (
      <AskForLink
        codeProblem={codeProblem}
        onCode={(code) => {
          setCodeProblem(null);
          setEntered(code);
        }}
      />
    );
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
        {body}
        <Button variant="ghost" icon="chevronLeft" onClick={() => navigate('/welcome')}>
          Back to sign-in
        </Button>
      </div>
    </div>
  );
}
