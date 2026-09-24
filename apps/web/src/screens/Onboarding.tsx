/**
 * Sign-in and the guided setup on the contract: a magic link (OAuth buttons
 * only when the service says they work), the tour (only stages this instance
 * can do), plugging in apps, meeting the first agent, and saving four answers
 * as memory before opening a conversation that refers to one of them.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { AgentFace } from '../design/face.tsx';
import { Icon } from '../design/icons.tsx';
import { Logo } from '../design/logos.tsx';
import { MeleteMark } from '../design/mark.tsx';
import { Button, Chip, Field, Input, Segmented, Toggle } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { lookOf, messageKey, useApp, useLoad, useMedia } from '../experience/hooks.ts';
import { givenName } from '../experience/profile.ts';
import type { AgentInput, MemoryItem, TourStage } from '../experience/types.ts';
import { navigate, useRoute } from '../router.ts';
import { toast } from '../shell/Shell.tsx';
import { blankAgent, LookFields, reaches, toggleReach } from './Agents.tsx';
import { ConnectionCard } from './Settings.tsx';

const studio = {
  background: 'var(--studio)',
  backgroundImage:
    'radial-gradient(ellipse at 50% 0%, #2f5fd626, transparent 60%), linear-gradient(#ffffff07 1px, transparent 1px), linear-gradient(90deg, #ffffff07 1px, transparent 1px)',
  backgroundSize: '100% 100%, 24px 24px, 24px 24px',
  border: '1px solid var(--studio-line)',
  color: 'var(--studio-text)',
} as const;

const NOVA = { color: '#4aa3f7', eyes: 'white', shape: 'blob', image: null } as const;
const SAGE = { color: '#5ab4a0', eyes: 'black', shape: 'octagon', image: null } as const;
const ATLAS = { color: '#ec8a2b', eyes: 'white', shape: 'diamond', image: null } as const;

/* ---------- sign in ---------- */

export function SignInScreen({ signedIn }: { signedIn: boolean }) {
  const { refreshProfile, setOnboarded } = useApp();
  const route = useRoute();
  // A fresh install has no account yet: it offers "Create your account"
  // instead of sign-in. Until the service answers, it is sign-in.
  const [creating, setCreating] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [google, setGoogle] = useState<boolean | null>(null);
  const [apple, setApple] = useState<boolean | null>(null);
  const phone = useMedia('(max-width: 900px)');

  useEffect(() => {
    void adapter.setupStatus().then((r) => setCreating(r.data?.needed === true));
  }, []);

  // The OAuth buttons are drawn only when the service says they work.
  useEffect(() => {
    void adapter.signInGoogle().then((r) => setGoogle(r.unavailable === null && r.error === null));
    void adapter.signInApple().then((r) => setApple(r.unavailable === null && r.error === null));
  }, []);

  // A magic link lands here with its token in the fragment; consume it once.
  useEffect(() => {
    const token = route.query.get('token');
    if (!token) return;
    void adapter.consumeMagicLink(token).then((r) => {
      window.history.replaceState(null, '', `${window.location.pathname}#/`);
      if (r.data) refreshProfile();
      else setNotice(r.error ?? r.unavailable ?? 'That link did not work.');
    });
  }, [route.query, refreshProfile]);

  const sendLink = async () => {
    if (!email.includes('@')) {
      toast({ kind: 'err', title: 'Enter the email address to send the link to.' });
      return;
    }
    setLinking(true);
    setNotice(null);
    const result = await adapter.magicLink(email);
    setLinking(false);
    if (result.data) setSent(true);
    else setNotice(result.error ?? result.unavailable ?? 'Couldn’t send the link.');
  };

  const submit = async () => {
    if (!email.includes('@')) {
      toast({ kind: 'err', title: 'Enter your email address.' });
      return;
    }
    if (password.length < 8) {
      toast({ kind: 'err', title: 'The password needs at least 8 characters.' });
      return;
    }
    setBusy(true);
    setNotice(null);
    if (creating) {
      const made = await adapter.createAccount(email, password);
      if (made.data) {
        // Setup signs this browser in; sign in here only if it did not.
        const me = await adapter.profile();
        const session =
          me.error !== null && me.unauthorized ? await adapter.logIn(email, password) : me;
        setBusy(false);
        if (session.data === null) {
          setNotice(
            session.error ?? session.unavailable ?? 'Your account is made. Sign in to continue.',
          );
          setCreating(false);
          return;
        }
        setOnboarded(false);
        navigate('/setup');
        refreshProfile();
        return;
      }
      setBusy(false);
      // Someone else finished setup first: this installation now signs in.
      if (made.error !== null && /already/i.test(made.error)) setCreating(false);
      setNotice(made.error ?? made.unavailable ?? 'Couldn’t create the account.');
      return;
    }
    const result = await adapter.logIn(email, password);
    setBusy(false);
    if (result.data) {
      if (route.parts[0] === 'welcome') navigate('/');
      refreshProfile();
    } else setNotice(result.error ?? result.unavailable ?? 'Couldn’t sign in.');
  };

  const kcard = (inner: ReactNode, width = 320, extra?: React.CSSProperties) => (
    <div
      className="col pop"
      style={{
        gap: 8,
        width,
        padding: 12,
        borderRadius: 14,
        background: 'var(--studio-panel)',
        border: '1px solid var(--studio-line)',
        boxShadow: '0 24px 60px #00000080',
        color: 'var(--studio-text)',
        position: 'absolute',
        ...extra,
      }}
    >
      {inner}
    </div>
  );
  const kchip = (
    name: 'gcal' | 'slack' | 'imessage' | 'gmaps' | 'notion' | 'linear',
    label: string,
  ) => (
    <span
      className="row"
      style={{
        gap: 6,
        height: 24,
        padding: '0 8px 0 4px',
        borderRadius: 6,
        background: 'var(--studio-panel-2)',
        border: '1px solid var(--studio-line)',
        fontSize: 12,
        whiteSpace: 'nowrap',
      }}
    >
      <Logo name={name} size={16} />
      {label}
    </span>
  );

  return (
    <div
      className="row"
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        background: 'var(--canvas)',
        alignItems: 'stretch',
      }}
    >
      {!phone ? (
        <div
          style={{
            ...studio,
            position: 'relative',
            width: '55%',
            flexShrink: 0,
            border: 0,
            overflow: 'hidden',
          }}
        >
          <div className="row" style={{ gap: 10, position: 'absolute', left: 44, top: 32 }}>
            <MeleteMark width={46} />
            <span style={{ fontFamily: 'var(--font-head)', fontSize: 18, fontWeight: 700 }}>
              Melete
            </span>
          </div>
          <div
            className="col"
            style={{
              gap: 12,
              position: 'absolute',
              left: 44,
              top: 104,
              width: 'min(540px, calc(100% - 88px))',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-head)',
                fontSize: 42,
                lineHeight: '48px',
                fontWeight: 700,
                letterSpacing: '-.02em',
                textWrap: 'balance',
              }}
            >
              The assistant that actually does it.
            </span>
            <span
              style={{
                fontSize: 16,
                lineHeight: '24px',
                color: 'var(--studio-muted)',
                maxWidth: 460,
                textWrap: 'pretty',
              }}
            >
              Dinner with friends or the pricing launch. Melete takes the task end to end and comes
              back only for the moments that need you.
            </span>
          </div>
          <div
            className="row"
            style={{ position: 'absolute', left: 44, top: 318, gap: 22, alignItems: 'flex-end' }}
          >
            <AgentFace look={SAGE} size={64} glow />
            <AgentFace look={NOVA} size={108} state="working" glow />
            <AgentFace look={ATLAS} size={64} glow />
          </div>
          {kcard(
            <>
              <div className="col" style={{ alignItems: 'flex-end' }}>
                <span
                  style={{
                    padding: '7px 12px',
                    borderRadius: '14px 14px 4px 14px',
                    background: '#2f5fd6',
                    color: '#fff',
                    fontSize: 13,
                    lineHeight: '18px',
                  }}
                >
                  Move my 3 PM to tomorrow and tell Sam.
                </span>
              </div>
              <div className="row" style={{ gap: 8, fontSize: 12, color: 'var(--studio-muted)' }}>
                <span style={{ color: '#4ade80', display: 'flex' }}>
                  <Icon name="circleCheck" size={14} />
                </span>
                Moved to Tuesday 3:00 PM · message to Sam drafted, not sent
              </div>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {kchip('gcal', 'Pricing sync · Tue 3:00 PM')}
                {kchip('slack', 'Sam · draft')}
              </div>
            </>,
            320,
            { left: '52%', top: 290, animationDelay: '.4s' },
          )}
          {kcard(
            <>
              <div className="row" style={{ gap: 10 }}>
                <span
                  className="row"
                  style={{
                    justifyContent: 'center',
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: 'var(--studio-panel-2)',
                    color: '#f5b342',
                  }}
                >
                  <Icon name="star" size={16} />
                </span>
                <div className="col grow" style={{ minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>
                    Luna Trattoria · 7:30, table for 3
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--studio-muted)' }}>
                    On your calendar · a note to Alex ready for you to send
                  </span>
                </div>
              </div>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {kchip('gcal', 'Tonight 7:30 PM')}
                {kchip('imessage', 'Alex · not sent')}
                {kchip('gmaps', '12 min walk')}
              </div>
            </>,
            320,
            { left: '50%', top: 470, animationDelay: '.9s' },
          )}
          {kcard(
            <>
              <div className="row" style={{ gap: 8, fontSize: 12, color: 'var(--studio-muted)' }}>
                <span className="spin" style={{ display: 'flex', color: '#8db6f7' }}>
                  <Icon name="loader" size={12} stroke={2} />
                </span>
                Working · 6s
              </div>
              <span style={{ fontSize: 13, lineHeight: '18px' }}>
                Reading the brief first so the timeline matches what Sam already agreed.
              </span>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {kchip('notion', 'Pricing page launch · brief')}
                {kchip('linear', 'PRC-114 · Legal review')}
              </div>
            </>,
            300,
            { left: 44, top: 586, animationDelay: '1.4s' },
          )}
          <div
            className="col"
            style={{ gap: 10, position: 'absolute', left: 44, right: 44, bottom: 36 }}
          >
            <span
              style={{
                fontSize: 11,
                letterSpacing: '.08em',
                textTransform: 'uppercase',
                color: 'var(--studio-muted)',
              }}
            >
              Works with the apps you already use
            </span>
            <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
              {(
                [
                  'gcal',
                  'gmail',
                  'slack',
                  'notion',
                  'gdrive',
                  'whatsapp',
                  'zoom',
                  'linear',
                  'github',
                  'spotify',
                ] as const
              ).map((name) => (
                <Logo key={name} name={name} size={28} />
              ))}
            </div>
          </div>
        </div>
      ) : null}
      <div
        className="col grow"
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          padding: 24,
          overflowY: 'auto',
        }}
      >
        <div className="col" style={{ gap: 22, width: 400, maxWidth: '100%' }}>
          <div className="col" style={{ gap: 8 }}>
            <MeleteMark width={64} />
            <h1
              style={{
                fontSize: 28,
                fontWeight: 700,
                letterSpacing: '-.01em',
                lineHeight: '34px',
                paddingTop: 6,
              }}
            >
              {creating ? 'Create your account' : 'Welcome to Melete'}
            </h1>
            <p style={{ fontSize: 15, lineHeight: '22px', color: 'var(--muted)' }}>
              {creating
                ? 'This is the first account on this installation. Your agents come next.'
                : 'Sign in with your email and password.'}
            </p>
          </div>
          {signedIn ? (
            <div className="col card" style={{ gap: 10, padding: 16 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>
                You’re already signed in on this device.
              </span>
              <Button icon="chevronRight" onClick={() => navigate('/')}>
                Continue to Melete
              </Button>
            </div>
          ) : null}
          {sent ? (
            <div className="col card" style={{ gap: 10, padding: 16 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>
                Check your inbox
              </span>
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                A sign-in link went to {email}. It works once and expires in ten minutes.
              </span>
            </div>
          ) : (
            <>
              {!creating && (google || apple) ? (
                <div className="col" style={{ gap: 10 }}>
                  {google ? (
                    <button
                      type="button"
                      className="btn btn-xl btn-outline"
                      style={{ width: '100%', gap: 10, fontSize: 14 }}
                      onClick={() =>
                        void adapter
                          .signInGoogle()
                          .then((r) =>
                            r.data ? refreshProfile() : setNotice(r.error ?? r.unavailable ?? ''),
                          )
                      }
                    >
                      <Logo name="google" size={18} />
                      <span>Continue with Google</span>
                    </button>
                  ) : null}
                  {apple ? (
                    <button
                      type="button"
                      className="btn btn-xl btn-outline"
                      style={{ width: '100%', gap: 10, fontSize: 14 }}
                      onClick={() =>
                        void adapter
                          .signInApple()
                          .then((r) =>
                            r.data ? refreshProfile() : setNotice(r.error ?? r.unavailable ?? ''),
                          )
                      }
                    >
                      <Icon name="apple" size={18} />
                      <span>Continue with Apple</span>
                    </button>
                  ) : null}
                  <div className="row" style={{ gap: 12 }}>
                    <span className="grow hairline" />
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>or with email</span>
                    <span className="grow hairline" />
                  </div>
                </div>
              ) : null}
              <form
                className="col"
                style={{ gap: 12 }}
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <Field label="Email">
                  <Input
                    type="email"
                    icon="mail"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
                    width="100%"
                    height={44}
                    autoComplete="email"
                  />
                </Field>
                <Field label="Password">
                  <Input
                    type="password"
                    icon="lock"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={creating ? 'At least 8 characters' : undefined}
                    width="100%"
                    height={44}
                    autoComplete={creating ? 'new-password' : 'current-password'}
                  />
                </Field>
                <Button size="lg" icon="chevronRight" block type="submit" loading={busy}>
                  {creating ? 'Create account' : 'Sign in'}
                </Button>
                {creating ? null : (
                  <Button
                    variant="ghost"
                    icon="send"
                    block
                    loading={linking}
                    onClick={() => void sendLink()}
                  >
                    Email me a link instead
                  </Button>
                )}
              </form>
              {notice ? (
                <div
                  className="row"
                  style={{
                    gap: 8,
                    padding: '10px 12px',
                    borderRadius: 10,
                    background: 'var(--sand)',
                    color: 'var(--sand-ink)',
                    fontSize: 13,
                  }}
                >
                  <Icon name="info" size={14} />
                  <span>{notice}</span>
                </div>
              ) : null}
            </>
          )}
          <div className="col" style={{ gap: 10, alignItems: 'center', textAlign: 'center' }}>
            <span className="row" style={{ gap: 6, fontSize: 12, color: 'var(--muted)' }}>
              <Icon name="lock" size={13} />
              Your data stays yours. Agents ask before they act.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- setup ---------- */

const STAGES: Record<TourStage, { title: string; desc: string }> = {
  calendar: {
    title: 'Say it once. It gets done.',
    desc: 'Not answers, outcomes. Melete checks what it needs, does the steps, and comes back with the one thing only you can do.',
  },
  drafting: {
    title: 'Messages you always send yourself',
    desc: 'Melete drafts the note in your voice and stops. Nothing goes out until you press send.',
  },
  browser: {
    title: 'It has hands',
    desc: 'Expense reports, forms, bookings, sign-ups: Melete does them in its own sandboxed browser. Watch, take over any time. Money and messages always wait for your yes.',
  },
  plans: {
    title: 'Plans that run themselves',
    desc: 'A project at work or a goal at home: say it once. Melete drafts the milestones, assigns the legwork to agents, and keeps the next step in front of you.',
  },
  memory: {
    title: 'Memory that compounds',
    desc: 'It remembers the people, habits and rules of your life, and uses them without being asked. Every bit is visible and editable.',
  },
};

function Stage({ stage }: { stage: TourStage }) {
  const chip = (inner: ReactNode, delay: number) => (
    <span
      className="row pop"
      style={{
        gap: 6,
        height: 26,
        padding: '0 9px 0 5px',
        borderRadius: 7,
        background: 'var(--studio-panel-2)',
        border: '1px solid var(--studio-line)',
        fontSize: 12,
        alignSelf: 'flex-start',
        animationDelay: `${delay}s`,
        maxWidth: '100%',
      }}
    >
      {inner}
    </span>
  );
  const bubble = (text: string) => (
    <div className="col pop" style={{ alignItems: 'flex-end' }}>
      <span
        style={{
          padding: '8px 14px',
          borderRadius: '16px 16px 5px 16px',
          background: '#2f5fd6',
          color: '#fff',
          fontSize: 14,
          maxWidth: 560,
        }}
      >
        {text}
      </span>
    </div>
  );
  const memCard = (inner: ReactNode, delay: number) => (
    <span
      className="row pop"
      style={{
        gap: 8,
        height: 32,
        padding: '0 10px 0 6px',
        borderRadius: 9,
        background: 'var(--studio-panel)',
        border: '1px solid var(--studio-line)',
        fontSize: 12,
        animationDelay: `${delay}s`,
        whiteSpace: 'nowrap',
      }}
    >
      {inner}
    </span>
  );
  return (
    <div
      className="col"
      style={{
        ...studio,
        minHeight: 300,
        borderRadius: 14,
        overflow: 'hidden',
        padding: 22,
        justifyContent: 'center',
        gap: 12,
      }}
    >
      {stage === 'calendar' ? (
        <>
          {bubble('Move my 3 PM with Priya to tomorrow and tell her.')}
          <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
            <AgentFace look={NOVA} size={26} state="working" />
            <div className="col" style={{ gap: 6, minWidth: 0 }}>
              {chip(
                <>
                  <Logo name="gcal" size={16} />
                  Checked both calendars · you’re both free Thu 10:00
                </>,
                0.4,
              )}
              {chip(
                <>
                  <Logo name="gcal" size={16} />
                  Moved “Pricing review” to Thu 10:00 · invite updated
                </>,
                1.2,
              )}
              {chip(
                <>
                  <Logo name="whatsapp" size={16} />
                  Drafted a note to Priya, in your tone
                </>,
                2,
              )}
            </div>
          </div>
        </>
      ) : stage === 'drafting' ? (
        <div
          className="row pop"
          style={{
            gap: 14,
            padding: '12px 14px',
            borderRadius: 14,
            background: 'var(--studio-panel)',
            border: '1px solid var(--studio-line)',
            alignItems: 'flex-start',
          }}
        >
          <Logo name="whatsapp" size={44} />
          <div className="col grow" style={{ gap: 6, minWidth: 0 }}>
            <span style={{ fontFamily: 'var(--font-head)', fontSize: 15, fontWeight: 600 }}>
              To Priya · not sent yet
            </span>
            <span style={{ fontSize: 13, lineHeight: '19px' }}>
              “Hey Priya, can we do the pricing review Thu 10 instead of today at 3? Invite’s
              updated, shout if it doesn’t work.”
            </span>
            <div className="row" style={{ gap: 8, paddingTop: 2 }}>
              <span
                className="row"
                style={{
                  gap: 6,
                  height: 30,
                  padding: '0 12px',
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 500,
                  background: 'var(--primary)',
                  color: '#fff',
                }}
              >
                <Icon name="send" size={14} />
                Send
              </span>
              <span
                className="row"
                style={{
                  height: 30,
                  padding: '0 12px',
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 500,
                  background: 'var(--studio-panel-2)',
                  border: '1px solid var(--studio-line)',
                }}
              >
                Edit
              </span>
            </div>
          </div>
        </div>
      ) : stage === 'browser' ? (
        <div className="col" style={{ gap: 10 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              color: 'var(--studio-muted)',
            }}
          >
            Friday · 5:12 PM
          </span>
          {chip(
            <>
              <Logo name="gmail" size={16} />6 receipts found in Gmail · Uber, lunches, the client
              dinner
            </>,
            0.4,
          )}
          {chip(
            <>
              <span style={{ color: 'var(--primary)', display: 'flex' }}>
                <Icon name="cursor" size={14} />
              </span>
              Filling the expense portal · amounts, dates, categories
            </>,
            1.6,
          )}
          {chip(
            <>
              <span style={{ color: '#5ab4a0', display: 'flex' }}>
                <Icon name="check" size={14} />
              </span>
              Report ready · $214.30 · nothing over the limit
            </>,
            3,
          )}
        </div>
      ) : stage === 'plans' ? (
        <div
          className="col"
          style={{
            gap: 12,
            padding: '16px 18px',
            borderRadius: 14,
            background: 'var(--studio-panel)',
            border: '1px solid var(--studio-line)',
          }}
        >
          <div className="row" style={{ gap: 12 }}>
            <span
              className="row"
              style={{
                justifyContent: 'center',
                width: 40,
                height: 40,
                borderRadius: 10,
                background: '#1b2942',
                color: '#b9d1f6',
              }}
            >
              <Icon name="plans" size={20} />
            </span>
            <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
              <span style={{ fontFamily: 'var(--font-head)', fontSize: 16, fontWeight: 600 }}>
                Launch the new pricing page · Sep 30
              </span>
              <span style={{ fontSize: 12, color: 'var(--studio-muted)' }}>
                3 weeks · 3 agents on it · you sign off on copy and go-live
              </span>
            </div>
          </div>
          {[
            ['Agree the three tiers with Sam', 'done', null],
            ['Draft page copy from the brief', 'done', ATLAS],
            [
              'Collect legal and finance sign-off',
              'active',
              { color: '#c9c1f5', eyes: 'black', shape: 'square', image: null } as const,
            ],
            ['Schedule the announcement', 'todo', NOVA],
          ].map(([text, state, who]) => (
            <div key={String(text)} className="row" style={{ gap: 10, minHeight: 30 }}>
              <span
                className="row"
                style={{
                  justifyContent: 'center',
                  width: 16,
                  height: 16,
                  borderRadius: 4,
                  border: '1px solid #3a3f46',
                  background: state === 'done' ? 'var(--primary)' : 'transparent',
                  color: '#fff',
                }}
              >
                {state === 'done' ? (
                  <Icon name="check" size={11} stroke={3} />
                ) : state === 'active' ? (
                  <Icon name="loader" size={11} stroke={2.5} className="spin" />
                ) : null}
              </span>
              <span
                style={{
                  flex: 1,
                  fontSize: 13,
                  color: state === 'done' ? 'var(--studio-muted)' : 'var(--studio-text)',
                }}
              >
                {String(text)}
              </span>
              {who ? (
                <AgentFace
                  look={who as typeof NOVA}
                  size={20}
                  state={state === 'active' ? 'working' : 'idle'}
                />
              ) : (
                <span style={{ fontSize: 11, color: 'var(--studio-muted)' }}>you</span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="col" style={{ gap: 14, alignItems: 'center' }}>
          <AgentFace look={NOVA} size={76} state="thinking" glow />
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            {memCard(
              <>
                <Icon name="user" size={14} />
                Alex · vegetarian, hates loud rooms
              </>,
              0.6,
            )}
            {memCard(
              <>
                <Logo name="gcal" size={18} />
                Stand-up · 9:30 daily, never move it
              </>,
              1.2,
            )}
            {memCard(
              <>
                <Logo name="whatsapp" size={18} />
                Priya prefers WhatsApp over email
              </>,
              1.8,
            )}
            {memCard(
              <>
                <Icon name="mapPin" size={14} />
                Office · 14th St · you walk when it’s dry
              </>,
              2.4,
            )}
          </div>
          <span
            className="row pop"
            style={{
              gap: 8,
              height: 28,
              padding: '0 10px',
              borderRadius: 999,
              background: '#2f5fd6',
              color: '#fff',
              fontSize: 12,
              fontWeight: 500,
              animationDelay: '3s',
              textAlign: 'center',
            }}
          >
            <Icon name="check" size={12} stroke={3} />
            So the team dinner was vegetarian-friendly, quiet, near the office.
          </span>
        </div>
      )}
    </div>
  );
}

function Card({
  title,
  sub,
  children,
  footer,
  width = 780,
}: {
  title: string;
  sub?: string;
  children: ReactNode;
  footer: ReactNode;
  width?: number;
}) {
  return (
    <div
      className="col card"
      style={{
        width,
        maxWidth: '100%',
        borderRadius: 22,
        boxShadow: 'var(--elevated)',
        overflow: 'hidden',
      }}
    >
      <div className="row" style={{ gap: 10, padding: '20px 24px 0' }}>
        <MeleteMark width={40} />
        <span
          style={{
            fontFamily: 'var(--font-head)',
            fontSize: 18,
            fontWeight: 700,
            color: 'var(--heading)',
            flex: 1,
          }}
        >
          {title}
        </span>
      </div>
      {sub ? (
        <p
          style={{
            padding: '6px 24px 0 62px',
            fontSize: 14,
            lineHeight: '21px',
            color: 'var(--muted)',
          }}
        >
          {sub}
        </p>
      ) : null}
      <div className="col" style={{ gap: 16, padding: '18px 24px 22px' }}>
        {children}
      </div>
      <div
        className="row"
        style={{
          gap: 12,
          padding: '14px 24px',
          borderTop: '1px solid var(--line)',
          background: 'var(--soft)',
          flexWrap: 'wrap',
        }}
      >
        {footer}
      </div>
    </div>
  );
}

/**
 * Four quick questions. Each answer is a detail the person states outright,
 * saved on its own key the moment it is chosen, so setup never pretends and
 * Settings › Memory shows exactly what was kept.
 */
const QUESTIONS = [
  {
    key: 'pref.home.city',
    ask: 'Where are you based? I use it for time zones, weather and how far things are.',
    choices: ['New York', 'London', 'Somewhere else'],
    reply: (answer: string) =>
      answer === 'Somewhere else'
        ? 'No problem, I’ll pick it up from your calendar.'
        : `${answer}. Noted, and I’ll assume that time zone unless you travel.`,
  },
  {
    key: 'pref.people.names',
    ask: 'Who should I know by name?',
    choices: ['Alex and Priya', 'My family', 'My team at work'],
    reply: (answer: string) =>
      `Got it. When you say “${answer.split(' ')[0]}”, I’ll know who you mean.`,
  },
  {
    key: 'pref.focus.this-month',
    ask: 'What eats your week right now?',
    choices: ['Meetings and follow-ups', 'Email and admin', 'A launch at work', 'Family logistics'],
    reply: (answer: string) =>
      answer === 'A launch at work'
        ? 'A launch. I’ll offer to set it up as a plan when you’re ready.'
        : 'That’s the kind of thing I take off your plate first. I’ll start there.',
  },
  {
    key: 'pref.checkins.style',
    ask: 'How should I check in?',
    choices: ['Morning brief at 8:30', 'Only when it matters', 'Never first'],
    reply: () =>
      'Perfect, that’s plenty to start. I’ll remember these and learn the rest as we go.',
  },
] as const;

type Exchange = { id: number; who: 'agent' | 'you'; text: string };
let exchangeId = 0;
const exchange = (who: Exchange['who'], text: string): Exchange => ({
  id: ++exchangeId,
  who,
  text,
});

export function OnboardingScreen() {
  const { capabilities, profile, setOnboarded, refreshProfile, refreshAgents } = useApp();
  const stages = (['calendar', 'drafting', 'browser', 'plans', 'memory'] as TourStage[]).filter(
    (stage) =>
      stage === 'calendar'
        ? capabilities.calendar
        : stage === 'browser'
          ? capabilities.browser
          : true,
  );
  const connections = useLoad(() => adapter.connections(), []);
  const [step, setStep] = useState(1);
  const [stage, setStage] = useState(0);
  const [name, setName] = useState(givenName(profile));
  const [brief, setBrief] = useState(true);
  const [agent, setAgent] = useState<AgentInput>({
    ...blankAgent(),
    name: 'Nova',
    role: 'Concierge',
    tone: 'Warm',
    standing_instruction: 'One option first, not five. Confirm before paying.',
  });
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(0);
  const [log, setLog] = useState<Exchange[]>(() => [exchange('agent', QUESTIONS[0].ask)]);
  const [kept, setKept] = useState<MemoryItem[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  // An answer that did not save stays on screen with the reason and a retry.
  const [unsaved, setUnsaved] = useState<{ choice: string; reason: string } | null>(null);
  // Keep accepted steps across a failed welcome request so retrying cannot
  // create a second agent, conversation, or first message.
  const completed = useRef({ agentId: '', chatId: '', messageKey: messageKey(), brief: false });
  const total = 5;

  const answer = async (choice: string) => {
    const question = QUESTIONS[asked];
    if (!question || saving) return;
    setSaving(true);
    setUnsaved(null);
    setLog((previous) => [...previous, exchange('you', choice)]);
    const saved = await adapter.createMemoryItem({
      key: question.key,
      value: choice,
      statement: `${question.ask} ${choice}`,
    });
    setSaving(false);
    if (saved.data === null) {
      const reason = saved.error ?? saved.unavailable ?? 'Something went wrong.';
      toast({ kind: 'err', title: 'Couldn’t save that', sub: reason });
      setLog((previous) => previous.slice(0, -1));
      setUnsaved({ choice, reason });
      return;
    }
    const item = saved.data.item;
    setKept((previous) => [...previous.filter((entry) => entry.id !== item.id), item]);
    setAnswers((previous) => ({ ...previous, [question.key]: choice }));
    const next = QUESTIONS[asked + 1];
    setLog((previous) => [
      ...previous,
      exchange('agent', question.reply(choice)),
      ...(next ? [exchange('agent', next.ask)] : []),
    ]);
    setAsked(asked + 1);
  };

  const finish = async () => {
    if (busy || saving) return;
    setBusy(true);
    const fail = (title: string) => {
      toast({ kind: 'err', title });
      setBusy(false);
    };
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const savedProfile = await adapter.saveProfile({
      name: name.trim() || profile?.name || 'You',
      time_zone: profile?.time_zone ?? timeZone,
      day_hours: profile?.day_hours ?? { start: '08:00', end: '22:00' },
    });
    if (!savedProfile.data)
      return fail(savedProfile.error ?? savedProfile.unavailable ?? 'Couldn’t save your profile');
    let agentId = completed.current.agentId;
    if (!agentId) {
      if (!agent.name.trim()) return fail('Give your agent a name first.');
      const saved = await adapter.createAgent({ ...agent, name: agent.name.trim() });
      if (!saved.data) return fail(saved.error ?? saved.unavailable ?? 'Couldn’t create the agent');
      agentId = saved.data.agent.id;
      completed.current.agentId = agentId;
    }
    if (brief && !completed.current.brief) {
      const routine = await adapter.morningBrief(agentId, '08:30');
      completed.current.brief = true;
      if (routine.data === null)
        toast({
          kind: 'info',
          title: 'The morning brief is not available here yet',
          sub: routine.unavailable ?? routine.error ?? '',
        });
    }
    // The first message names one thing the person just said, so the agent's
    // reply can show it was kept.
    const focus = answers['pref.focus.this-month'];
    const first = focus
      ? `${focus} is what eats my week right now. Where do we start?`
      : kept[0]
        ? `I told you: ${kept[0].value}. Where do we start?`
        : null;
    if (first) {
      if (!completed.current.chatId) {
        const opened = await adapter.createConversation({
          title: 'Getting started',
          agent_id: agentId,
        });
        if (!opened.data)
          return fail(
            opened.error ?? opened.unavailable ?? 'Couldn’t open your first conversation',
          );
        completed.current.chatId = opened.data.conversation.id;
      }
      const sent = await adapter.send(
        completed.current.chatId,
        first,
        completed.current.messageKey,
      );
      if (!sent.data)
        return fail(sent.error ?? sent.unavailable ?? 'Couldn’t send your first message');
    }
    setBusy(false);
    refreshProfile();
    refreshAgents();
    setOnboarded(true);
    navigate(completed.current.chatId ? `/chat/${completed.current.chatId}` : '/');
  };

  const stepLabel = (
    <span style={{ fontSize: 12, color: 'var(--muted)', paddingRight: 8 }}>
      Step {step} of {total}
    </span>
  );
  const back = (
    <Button
      variant="ghost"
      disabled={busy || saving}
      onClick={() =>
        step === 2 && stage > 0 ? setStage(stage - 1) : setStep(Math.max(1, step - 1))
      }
    >
      Back
    </Button>
  );

  let card: ReactNode;
  if (step === 1) {
    card = (
      <Card
        title="Welcome to Melete"
        footer={
          <>
            {stepLabel}
            <div className="grow" />
            <Button variant="ghost" onClick={() => void finish()}>
              Maybe later
            </Button>
            <Button iconRight="chevronRight" onClick={() => setStep(2)}>
              Show me
            </Button>
          </>
        }
      >
        <div className="col" style={{ gap: 18, alignItems: 'center', padding: '8px 0 4px' }}>
          <div
            className="row"
            style={{
              ...studio,
              height: 220,
              width: '100%',
              borderRadius: 14,
              justifyContent: 'center',
              gap: 28,
              position: 'relative',
            }}
          >
            <AgentFace look={SAGE} size={64} glow />
            <AgentFace look={NOVA} size={96} glow />
            <AgentFace look={ATLAS} size={64} glow />
            <span
              className="row pop"
              style={{
                position: 'absolute',
                bottom: 18,
                height: 28,
                padding: '0 12px',
                borderRadius: 999,
                background: 'var(--studio-panel)',
                border: '1px solid var(--studio-line)',
                fontSize: 12,
                animationDelay: '.8s',
                textAlign: 'center',
              }}
            >
              Meetings, messages, expenses, errands. The doing, not just the answers.
            </span>
          </div>
          <div className="col" style={{ gap: 6, alignItems: 'center', textAlign: 'center' }}>
            <span
              style={{
                fontFamily: 'var(--font-head)',
                fontSize: 26,
                fontWeight: 700,
                letterSpacing: '-.01em',
                color: 'var(--heading)',
              }}
            >
              The assistant that actually does it
            </span>
            <span style={{ fontSize: 15, color: 'var(--muted)', maxWidth: 520 }}>
              For your life and your work. Melete takes the task off your plate end to end, and only
              comes back for the moments that need you.
            </span>
          </div>
          <div style={{ width: 520, maxWidth: '100%' }}>
            <Field label="Your name">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                width="100%"
                height={40}
                placeholder="Jamie Davis"
              />
            </Field>
          </div>
          <div
            className="row"
            style={{
              gap: 12,
              padding: '12px 14px',
              borderRadius: 12,
              background: 'var(--soft)',
              border: '1px solid var(--line)',
              width: 520,
              maxWidth: '100%',
            }}
          >
            <span
              className="row"
              style={{
                justifyContent: 'center',
                width: 32,
                height: 32,
                borderRadius: 8,
                background: 'var(--blue-soft)',
                color: 'var(--blue-ink)',
              }}
            >
              <Icon name="automations" size={16} />
            </span>
            <div className="col grow" style={{ gap: 1 }}>
              <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
                Morning brief at 8:30
              </span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                Today’s events, open tasks and the weather. Off any time.
              </span>
            </div>
            <Toggle on={brief} label="Morning brief" onChange={setBrief} />
          </div>
        </div>
      </Card>
    );
  } else if (step === 2) {
    const current = stages[stage] ?? stages[0];
    card = (
      <Card
        title="What Melete does"
        footer={
          <>
            {back}
            <div className="grow" />
            <div className="row" style={{ gap: 6 }}>
              {stages.map((s, i) => (
                <span
                  key={s}
                  style={{
                    width: i === stage ? 18 : 6,
                    height: 6,
                    borderRadius: 3,
                    background:
                      i === stage
                        ? 'var(--primary)'
                        : i < stage
                          ? 'var(--blue-line)'
                          : 'var(--line-strong)',
                  }}
                />
              ))}
            </div>
            <div className="grow" />
            {stepLabel}
            <Button
              iconRight="chevronRight"
              onClick={() => (stage < stages.length - 1 ? setStage(stage + 1) : setStep(3))}
            >
              {stage < stages.length - 1 ? 'Next' : 'Continue'}
            </Button>
          </>
        }
      >
        {current ? (
          <div className="col" style={{ gap: 14 }}>
            <Stage key={current} stage={current} />
            <div className="col" style={{ gap: 4 }}>
              <span
                style={{
                  fontFamily: 'var(--font-head)',
                  fontSize: 19,
                  fontWeight: 700,
                  color: 'var(--heading)',
                }}
              >
                {STAGES[current].title}
              </span>
              <span style={{ fontSize: 14, lineHeight: '21px', color: 'var(--muted)' }}>
                {STAGES[current].desc}
              </span>
            </div>
          </div>
        ) : (
          <p style={{ fontSize: 14, color: 'var(--muted)' }}>
            Nothing to show on this instance yet.
          </p>
        )}
      </Card>
    );
  } else if (step === 3) {
    const list = connections.data?.connections ?? [];
    card = (
      <Card
        title="What Melete may look at"
        sub="These are the apps connected on this instance. Melete reads what is connected and asks before it writes anywhere."
        footer={
          <>
            {back}
            <div className="grow" />
            {stepLabel}
            <Button iconRight="chevronRight" onClick={() => setStep(4)}>
              Continue
            </Button>
          </>
        }
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
            gap: 10,
          }}
        >
          {list.map((connection) => (
            <ConnectionCard key={connection.id} connection={connection} compact />
          ))}
        </div>
        {connections.data && list.length === 0 ? (
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>Nothing is connected yet.</span>
        ) : null}
        <div className="row" style={{ gap: 8, fontSize: 12, color: 'var(--muted)' }}>
          <Icon name="lock" size={14} />
          Access is per agent. Anything that costs money or sends a message gets a confirmation card
          first.
        </div>
      </Card>
    );
  } else if (step === 5) {
    const question = QUESTIONS[asked];
    card = (
      <Card
        title={`Let ${agent.name || 'your agent'} get to know you`}
        sub="Four quick questions, so it can help from day one. Each answer is kept under Settings › Memory and can be changed there."
        footer={
          <>
            {back}
            <div className="grow" />
            {stepLabel}
            {asked >= QUESTIONS.length ? (
              <Button
                iconRight="chevronRight"
                loading={busy}
                disabled={busy}
                onClick={() => void finish()}
              >
                Open Melete
              </Button>
            ) : (
              <Button
                variant="ghost"
                loading={busy}
                disabled={saving || busy}
                onClick={() => void finish()}
              >
                Skip, I’ll tell it later
              </Button>
            )}
          </>
        }
      >
        <div className="row" style={{ gap: 16, alignItems: 'stretch', flexWrap: 'wrap' }}>
          <div
            className="col grow"
            style={{
              gap: 12,
              minWidth: 260,
              minHeight: 280,
              padding: 14,
              borderRadius: 14,
              background: 'var(--canvas)',
              border: '1px solid var(--line)',
              justifyContent: 'flex-end',
            }}
          >
            {log.slice(-6).map((entry) =>
              entry.who === 'agent' ? (
                <div key={entry.id} className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                  <AgentFace look={lookOf(agent)} size={24} />
                  <p style={{ fontSize: 14, lineHeight: '21px', textWrap: 'pretty' }}>
                    {entry.text}
                  </p>
                </div>
              ) : (
                <div key={entry.id} className="col" style={{ alignItems: 'flex-end' }}>
                  <span
                    style={{
                      padding: '7px 12px',
                      borderRadius: '14px 14px 4px 14px',
                      background: 'var(--bubble)',
                      color: 'var(--bubble-ink)',
                      fontSize: 14,
                    }}
                  >
                    {entry.text}
                  </span>
                </div>
              ),
            )}
            {question && unsaved ? (
              <div
                role="alert"
                className="row"
                style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', paddingLeft: 34 }}
              >
                <span style={{ fontSize: 13 }}>
                  Couldn’t save “{unsaved.choice}”: {unsaved.reason}
                </span>
                <Chip disabled={saving} onClick={() => void answer(unsaved.choice)}>
                  Retry
                </Chip>
              </div>
            ) : null}
            {question ? (
              <div className="row" style={{ gap: 6, flexWrap: 'wrap', paddingLeft: 34 }}>
                {question.choices.map((choice) => (
                  <Chip key={choice} disabled={saving} onClick={() => void answer(choice)}>
                    {choice}
                  </Chip>
                ))}
              </div>
            ) : null}
          </div>
          <div className="col" style={{ gap: 8, width: 220, flexShrink: 0 }}>
            <span className="overline">What {agent.name || 'your agent'} will remember</span>
            {kept.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                Nothing yet. Each answer appears here as it is saved.
              </span>
            ) : null}
            {kept.map((item) => (
              <div
                key={item.id}
                className="row pop"
                style={{
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 10,
                  background: 'var(--surface)',
                  border: '1px solid var(--line)',
                }}
              >
                <span
                  className="row"
                  style={{
                    justifyContent: 'center',
                    width: 24,
                    height: 24,
                    borderRadius: 7,
                    background: 'var(--blue-soft)',
                    color: 'var(--blue-ink)',
                    flexShrink: 0,
                  }}
                >
                  <Icon name="bookmark" size={13} />
                </span>
                <span className="col grow" style={{ minWidth: 0 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--heading)' }}>
                    {item.key}
                  </span>
                  <span className="clamp1" style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {item.value}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </Card>
    );
  } else {
    const list = connections.data?.connections.filter((c) => c.status === 'connected') ?? [];
    card = (
      <Card
        title="Meet your first agent"
        sub="Give it a name, a look and one standing instruction. Change anything later in Agents. Anything Melete learns about you shows up under Settings › Memory."
        footer={
          <>
            {back}
            <div className="grow" />
            {stepLabel}
            <Button
              iconRight="chevronRight"
              disabled={!agent.name.trim()}
              onClick={() => setStep(5)}
            >
              Continue
            </Button>
          </>
        }
      >
        <div className="row" style={{ gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div
            className="col"
            style={{
              ...studio,
              gap: 10,
              alignItems: 'center',
              width: 236,
              height: 246,
              flexShrink: 0,
              borderRadius: 14,
              justifyContent: 'center',
            }}
          >
            <AgentFace look={lookOf(agent)} size={116} glow />
            <span style={{ fontSize: 12, color: 'var(--studio-muted)' }}>
              Idle · blinks now and then
            </span>
          </div>
          <div className="col grow" style={{ gap: 14, minWidth: 260 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                gap: 12,
              }}
            >
              <Field label="Name">
                <Input
                  value={agent.name}
                  onChange={(event) => setAgent({ ...agent, name: event.target.value })}
                  width="100%"
                  maxLength={40}
                />
              </Field>
              <Field label="Job">
                <Input
                  value={agent.role}
                  onChange={(event) => setAgent({ ...agent, role: event.target.value })}
                  width="100%"
                />
              </Field>
            </div>
            <LookFields draft={agent} onChange={setAgent} compact />
            <Field label="Tone">
              <Segmented
                label="Tone"
                value={agent.tone}
                onChange={(tone) => setAgent({ ...agent, tone })}
                options={[
                  { value: 'Warm', label: 'Warm' },
                  { value: 'Direct', label: 'Direct' },
                  { value: 'Playful', label: 'Playful' },
                ]}
              />
            </Field>
            <Field label="One standing instruction">
              <Input
                value={agent.standing_instruction}
                onChange={(event) =>
                  setAgent({ ...agent, standing_instruction: event.target.value })
                }
                width="100%"
                maxLength={200}
              />
            </Field>
            {list.length ? (
              <Field label="May use">
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {list.map((connection) => {
                    const on = reaches(agent.allowed_connection_ids, connection.id);
                    return (
                      <Chip
                        key={connection.id}
                        on={on}
                        onClick={() =>
                          setAgent({
                            ...agent,
                            allowed_connection_ids: toggleReach(
                              agent.allowed_connection_ids,
                              connection.id,
                              !on,
                              list.map((item) => item.id),
                            ),
                          })
                        }
                      >
                        {connection.label}
                      </Chip>
                    );
                  })}
                </div>
              </Field>
            ) : null}
            <div className="row" style={{ gap: 12 }}>
              <div className="col grow" style={{ gap: 1 }}>
                <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
                  Asks before acting
                </span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Anything that sends, books or pays waits for your yes.
                </span>
              </div>
              <Toggle
                on={agent.asks_before_acting}
                label="Asks before acting"
                onChange={(on) => setAgent({ ...agent, asks_before_acting: on })}
              />
            </div>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div
      className="col"
      style={{ width: '100%', height: '100%', overflowY: 'auto', background: 'var(--canvas)' }}
    >
      <header className="row" style={{ gap: 10, height: 64, padding: '0 32px', flexShrink: 0 }}>
        <MeleteMark width={40} />
        <span
          style={{
            fontFamily: 'var(--font-head)',
            fontSize: 16,
            fontWeight: 600,
            color: 'var(--heading)',
          }}
        >
          Melete
        </span>
        <div className="grow" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOnboarded(true);
            navigate('/');
          }}
        >
          Skip setup
        </Button>
      </header>
      <div
        className="col grow"
        style={{ alignItems: 'center', justifyContent: 'flex-start', padding: '16px 16px 40px' }}
      >
        {card}
      </div>
    </div>
  );
}
