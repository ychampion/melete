/**
 * Sign-in and the guided setup: the tour (only stages the adapter reports as
 * available), plugging in apps, meeting the first agent, and four questions
 * whose answers become memory items the first message refers back to.
 */
import { type ReactNode, useEffect, useState } from 'react';
import { AgentFace } from '../design/face.tsx';
import { Icon } from '../design/icons.tsx';
import { Logo } from '../design/logos.tsx';
import { MeleteMark } from '../design/mark.tsx';
import { Button, Chip, Field, Input, Segmented, Toggle } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { useApp, useLoad, useMedia } from '../experience/hooks.ts';
import type { AgentTone, ConnectionData, TourStage } from '../experience/types.ts';
import { navigate } from '../router.ts';
import { toast } from '../shell/Shell.tsx';
import { type AgentDraft, blankAgent, LookFields, readFace } from './Agents.tsx';
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

export function SignInScreen() {
  const { capabilities, refreshSession } = useApp();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const phone = useMedia('(max-width: 900px)');

  const sendLink = async () => {
    if (!email.includes('@')) {
      toast({ kind: 'err', title: 'Enter the email address to send the link to.' });
      return;
    }
    setBusy(true);
    const result = await adapter.signIn(email);
    setBusy(false);
    if (result.error) toast({ kind: 'err', title: result.error });
    else setSent(true);
  };

  const oauth = async (provider: 'google' | 'apple') => {
    const result = await adapter.oauth(provider);
    if (result.error) toast({ kind: 'err', title: result.error });
    else refreshSession();
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
              Welcome to Melete
            </h1>
            <p style={{ fontSize: 15, lineHeight: '22px', color: 'var(--muted)' }}>
              Sign in or create your account. No password to remember.
            </p>
          </div>
          {sent ? (
            <div className="col card" style={{ gap: 10, padding: 16 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>
                Check your inbox
              </span>
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                A sign-in link went to {email}. It works once and expires in ten minutes.
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void adapter.completeSignIn(email).then(refreshSession)}
              >
                I opened the link
              </Button>
            </div>
          ) : (
            <>
              {capabilities.oauth_google === 'available' ||
              capabilities.oauth_apple === 'available' ? (
                <div className="col" style={{ gap: 10 }}>
                  {capabilities.oauth_google === 'available' ? (
                    <button
                      type="button"
                      className="btn btn-xl btn-outline"
                      style={{ width: '100%', gap: 10, fontSize: 14 }}
                      onClick={() => void oauth('google')}
                    >
                      <Logo name="google" size={18} />
                      <span>Continue with Google</span>
                    </button>
                  ) : null}
                  {capabilities.oauth_apple === 'available' ? (
                    <button
                      type="button"
                      className="btn btn-xl btn-outline"
                      style={{ width: '100%', gap: 10, fontSize: 14 }}
                      onClick={() => void oauth('apple')}
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
              {capabilities.magic_link === 'available' ? (
                <form
                  className="col"
                  style={{ gap: 12 }}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void sendLink();
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
                  <Button size="lg" icon="send" block type="submit" loading={busy}>
                    Send me a sign-in link
                  </Button>
                </form>
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
          <div
            className="row pop"
            style={{
              gap: 8,
              padding: '8px 8px 8px 12px',
              borderRadius: 10,
              background: 'var(--studio-panel)',
              border: '1px solid var(--studio-line)',
              animationDelay: '3.6s',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: 12, flex: 1 }}>
              Total <b>$214.30</b>. Submit to Finance?
            </span>
            <span
              className="row"
              style={{
                height: 28,
                padding: '0 10px',
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 500,
                background: 'var(--primary)',
                color: '#fff',
              }}
            >
              Submit
            </span>
            <span
              className="row"
              style={{
                gap: 6,
                height: 28,
                padding: '0 10px',
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--studio-text)',
              }}
            >
              <Icon name="cursor" size={14} />
              Take control
            </span>
          </div>
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

let entrySeq = 0;
const entry = (who: 'a' | 'u', text: string) => ({ id: ++entrySeq, who, text });

const QUESTIONS = [
  {
    key: 'Home',
    ask: 'Where are you based? I use it for time zones, weather and how far things are.',
    choices: ['New York', 'London', 'Somewhere else'],
  },
  {
    key: 'People',
    ask: 'Who should I know by name?',
    choices: ['Alex and Priya', 'My family', 'My team at work'],
  },
  {
    key: 'This month',
    ask: 'What eats your week right now?',
    choices: ['Meetings and follow-ups', 'Email and admin', 'A launch at work', 'Family logistics'],
  },
  {
    key: 'Check-ins',
    ask: 'How should I check in?',
    choices: ['Morning brief at 8:30', 'Only when it matters', 'Never first'],
  },
] as const;

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

export function OnboardingScreen() {
  const { capabilities, session, refreshSession, refreshAgents, refreshConversations } = useApp();
  const stages = capabilities.tour_stages;
  const connections = useLoad(() => adapter.connections(), []);
  const [step, setStep] = useState(1);
  const [stage, setStage] = useState(0);
  const [name, setName] = useState(session.profile?.name ?? '');
  const [short, setShort] = useState(session.profile?.short_name ?? '');
  const [brief, setBrief] = useState(true);
  const [agent, setAgent] = useState<AgentDraft>({
    ...blankAgent(),
    name: 'Nova',
    role: 'Concierge',
    blurb: 'Meetings, dinners, trips and bookings. Confirms before anything is paid.',
    standing_instruction: 'One option first, not five. Confirm before paying.',
    reaches: ['calendar', 'places', 'messages'],
  });
  const [log, setLog] = useState<{ id: number; who: 'a' | 'u'; text: string }[]>([]);

  const [q, setQ] = useState(0);
  const [answers, setAnswers] = useState<{ key: string; value: string }[]>([]);
  const [own, setOwn] = useState('');
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState(false);
  const total = 5;

  useEffect(() => {
    if (step !== 5 || log.length > 0) return;
    setTyping(true);
    const timer = setTimeout(() => {
      setTyping(false);
      setLog([entry('a', QUESTIONS[0].ask)]);
    }, 700);
    return () => clearTimeout(timer);
  }, [step, log.length]);

  const answer = (value: string) => {
    const question = QUESTIONS[q];
    if (!question) return;
    const next = [...answers, { key: question.key, value }];
    setAnswers(next);
    setLog((l) => [...l, entry('u', value)]);
    setOwn('');
    setTyping(true);
    setTimeout(() => {
      setTyping(false);
      const following = QUESTIONS[q + 1];
      setLog((l) => [
        ...l,
        entry(
          'a',
          following
            ? following.ask
            : 'Perfect, that’s plenty to start. I’ll remember these and learn the rest as we go.',
        ),
      ]);
      setQ(q + 1);
    }, 700);
  };

  const finish = async () => {
    setBusy(true);
    await adapter.saveProfile({
      name: name || 'You',
      short_name: short || name.split(' ')[0] || 'You',
      morning_brief: brief,
    });
    if (answers.length)
      await adapter.saveAnswers([
        ...answers,
        ...(short ? [{ key: 'Melete calls you', value: short }] : []),
      ]);
    let agentId: string | null = null;
    if (agent.name.trim()) {
      const saved = await adapter.saveAgent({ ...agent, id: null });
      agentId = saved.data?.agent.id ?? null;
    }
    const done = await adapter.completeOnboarding({ agent_id: agentId, first_message: null });
    setBusy(false);
    if (done.error !== null) {
      toast({ kind: 'err', title: done.error });
      return;
    }
    refreshSession();
    refreshAgents();
    refreshConversations();
    navigate(done.data.conversation_id ? `/chat/${done.data.conversation_id}` : '/');
  };

  const stepLabel = (
    <span style={{ fontSize: 12, color: 'var(--muted)', paddingRight: 8 }}>
      Step {step} of {total}
    </span>
  );
  const back = (
    <Button
      variant="ghost"
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
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 12,
              width: 520,
              maxWidth: '100%',
            }}
          >
            <Field label="Your name">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                width="100%"
                height={40}
                placeholder="Jamie Davis"
              />
            </Field>
            <Field label="Melete calls you">
              <Input
                value={short}
                onChange={(event) => setShort(event.target.value)}
                width="100%"
                height={40}
                placeholder="Jamie"
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
        title="Plug in what Melete may look at"
        sub="Pick as few as you like. Melete reads what you connect and asks before it writes anywhere."
        footer={
          <>
            {back}
            <div className="grow" />
            {stepLabel}
            <Button variant="ghost" onClick={() => setStep(4)}>
              Skip for now
            </Button>
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
            <ConnectionCard
              key={connection.id}
              connection={connection}
              compact
              onChange={(next: ConnectionData) =>
                connections.set({ connections: list.map((c) => (c.id === next.id ? next : c)) })
              }
            />
          ))}
        </div>
        <div className="row" style={{ gap: 8, fontSize: 12, color: 'var(--muted)' }}>
          <Icon name="lock" size={14} />
          Access is per agent. Anything that costs money or sends a message gets a confirmation card
          first.
          {capabilities.browser === 'available' ? ' The sandboxed browser is included.' : ''}
        </div>
      </Card>
    );
  } else if (step === 4) {
    const list = connections.data?.connections.filter((c) => c.state === 'connected') ?? [];
    card = (
      <Card
        title="Meet your first agent"
        sub="Give it a name, a look and one standing instruction. Change anything later in Agents."
        footer={
          <>
            {back}
            <div className="grow" />
            {stepLabel}
            <Button iconRight="chevronRight" onClick={() => setStep(5)}>
              Say hello
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
            <AgentFace look={agent.look} size={116} glow />
            <span style={{ fontSize: 12, color: 'var(--studio-muted)' }}>
              Idle · blinks now and then
            </span>
            <label
              className="btn btn-sm btn-ghost"
              style={{ cursor: 'pointer', color: 'var(--studio-text)' }}
            >
              <Icon name="upload" size={14} />
              <span>Import SVG or PNG</span>
              <input
                type="file"
                accept="image/svg+xml,image/png"
                hidden
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  const image = await readFace(file);
                  if (image) setAgent({ ...agent, look: { ...agent.look, image } });
                  else toast({ kind: 'err', title: 'That file isn’t an SVG or a PNG.' });
                }}
              />
            </label>
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
                onChange={(tone: AgentTone) => setAgent({ ...agent, tone })}
                options={[
                  { value: 'warm', label: 'Warm' },
                  { value: 'direct', label: 'Direct' },
                  { value: 'playful', label: 'Playful' },
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
              />
            </Field>
            {list.length ? (
              <Field label="May use">
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {list.map((connection) => {
                    const on = agent.allowed_connections.includes(connection.id);
                    return (
                      <Chip
                        key={connection.id}
                        on={on}
                        onClick={() =>
                          setAgent({
                            ...agent,
                            allowed_connections: on
                              ? agent.allowed_connections.filter((id) => id !== connection.id)
                              : [...agent.allowed_connections, connection.id],
                          })
                        }
                      >
                        {connection.name}
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
  } else {
    const question = QUESTIONS[q];
    const done = q >= QUESTIONS.length;
    card = (
      <Card
        title={`Let ${agent.name || 'Melete'} get to know you`}
        sub="Four quick questions, so it can help from day one. Change any answer later in Settings."
        footer={
          <>
            {back}
            <div className="grow" />
            {stepLabel}
            {done ? (
              <Button iconRight="chevronRight" loading={busy} onClick={() => void finish()}>
                Open Melete
              </Button>
            ) : (
              <Button variant="ghost" loading={busy} onClick={() => void finish()}>
                Skip, I’ll tell it later
              </Button>
            )}
          </>
        }
      >
        <div
          className="col"
          style={{
            height: 330,
            borderRadius: 14,
            background: 'var(--canvas)',
            border: '1px solid var(--line)',
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          <div
            className="col"
            style={{
              justifyContent: 'flex-end',
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              padding: '14px 16px',
              maxHeight: '100%',
              overflow: 'hidden',
              gap: 12,
            }}
          >
            {log.map((item) =>
              item.who === 'a' ? (
                <div key={item.id} className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                  <AgentFace look={agent.look} size={24} />
                  <p
                    style={{
                      fontSize: 14,
                      lineHeight: '21px',
                      color: 'var(--text)',
                      paddingTop: 1,
                    }}
                  >
                    {item.text}
                  </p>
                </div>
              ) : (
                <div key={item.id} className="col" style={{ alignItems: 'flex-end' }}>
                  <span
                    style={{
                      padding: '7px 12px',
                      borderRadius: '14px 14px 4px 14px',
                      background: 'var(--bubble)',
                      color: 'var(--bubble-ink)',
                      fontSize: 14,
                    }}
                  >
                    {item.text}
                  </span>
                </div>
              ),
            )}
            {typing ? (
              <div className="row" style={{ gap: 10 }}>
                <AgentFace look={agent.look} size={24} state="thinking" />
                <span
                  className="row"
                  style={{
                    gap: 4,
                    height: 26,
                    padding: '0 12px',
                    borderRadius: 13,
                    background: 'var(--soft)',
                    border: '1px solid var(--line)',
                  }}
                >
                  <span
                    className="pulse"
                    style={{ width: 5, height: 5, borderRadius: 999, background: 'var(--muted)' }}
                  />
                  <span
                    className="pulse"
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: 999,
                      background: 'var(--muted)',
                      animationDelay: '.2s',
                    }}
                  />
                  <span
                    className="pulse"
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: 999,
                      background: 'var(--muted)',
                      animationDelay: '.4s',
                    }}
                  />
                </span>
              </div>
            ) : null}
            {question && !typing && log.length > 0 ? (
              <form
                className="row"
                style={{ gap: 6, flexWrap: 'wrap', paddingLeft: 34 }}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (own.trim()) answer(own.trim());
                }}
              >
                {question.choices.map((choice) => (
                  <Chip key={choice} onClick={() => answer(choice)}>
                    {choice}
                  </Chip>
                ))}
                <Input
                  value={own}
                  onChange={(event) => setOwn(event.target.value)}
                  placeholder="Or type your own"
                  height={32}
                  width={180}
                  aria-label="Your own answer"
                />
              </form>
            ) : null}
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
        <Button size="sm" variant="ghost" onClick={() => void finish()}>
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
