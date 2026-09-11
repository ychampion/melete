/**
 * The pieces of a chat turn: the person's bubble, the agent's trail, and the
 * cards that carry a result, a draft, a decision, a receipt, a question, an
 * unknown outcome, or a browser session. Each renders from typed data and
 * calls back with the one thing a person can do to it.
 */
import { type ReactNode, useEffect, useState } from 'react';
import { AgentFace, faceStateFor } from '../design/face.tsx';
import { Icon, type IconName } from '../design/icons.tsx';
import { isLogo, Logo } from '../design/logos.tsx';
import { MeleteAvatar } from '../design/mark.tsx';
import {
  Avatar,
  Badge,
  Button,
  IconButton,
  Menu,
  MenuItem,
  Popover,
} from '../design/primitives.tsx';
import type {
  Agent,
  BrowserSessionData,
  DraftData,
  PermissionData,
  QuestionData,
  Reaction,
  ReceiptData,
  ResultCardData,
  Source,
  TrailStep,
  Turn,
  UnknownOutcomeData,
  UserMessage,
} from '../experience/types.ts';

export const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/* ---------- user bubble ---------- */

export function UserBubble({ message, onRetry }: { message: UserMessage; onRetry?: () => void }) {
  const pending = message.delivery !== 'sent';
  return (
    <div className="bubble-wrap">
      <div className="bubble" data-pending={pending ? 'true' : undefined}>
        {message.text}
      </div>
      <div className="bubble-meta">
        {message.delivery === 'sending' ? (
          <span className="row" style={{ gap: 6 }}>
            <Icon name="loader" size={12} stroke={2} className="spin" />
            Sending…
          </span>
        ) : message.delivery === 'queued' ? (
          <span>Will send when you’re back online</span>
        ) : message.delivery === 'failed' ? (
          <>
            <span className="row" style={{ gap: 6, color: 'var(--danger)' }}>
              <Icon name="alert" size={12} />
              Failed to send
            </span>
            <button
              type="button"
              className="btn btn-link"
              style={{ fontSize: 12 }}
              onClick={onRetry}
            >
              Retry
            </button>
          </>
        ) : (
          <span>{timeOf(message.at)}</span>
        )}
      </div>
    </div>
  );
}

/* ---------- trail ---------- */

function SourceChip({ source }: { source: Source }) {
  const inner = isLogo(source.app) ? (
    <Logo name={source.app} size={16} />
  ) : (
    <span style={{ color: 'var(--muted)', display: 'flex' }}>
      <Icon
        name={source.app === 'web' ? 'globe' : source.app === 'globe' ? 'globe' : 'mapPin'}
        size={13}
      />
    </span>
  );
  const body = (
    <>
      {inner}
      <span>{source.label}</span>
    </>
  );
  return source.url ? (
    <a className="trail-chip" href={source.url} target="_blank" rel="noreferrer">
      {body}
    </a>
  ) : (
    <span className="trail-chip">{body}</span>
  );
}

const ACTION_ICON = (step: Extract<TrailStep, { kind: 'action' }>): IconName => {
  const apps = step.sources.map((s) => s.app);
  if (apps.includes('gcal')) return 'calendar';
  if (apps.includes('gmaps')) return 'mapPin';
  if (apps.includes('imessage') || apps.includes('whatsapp') || apps.includes('slack'))
    return 'messages';
  if (apps.includes('notion') || apps.includes('gdrive')) return 'book';
  if (apps.includes('globe')) return 'globe';
  if (apps.length) return 'search';
  const label = step.label.toLowerCase();
  if (label.includes('calendar')) return 'calendar';
  if (label.includes('draft') || label.includes('message')) return 'messages';
  if (label.includes('browser') || label.includes('open')) return 'globe';
  if (label.includes('slot') || label.includes('chose') || label.includes('choosing'))
    return 'cursor';
  return 'search';
};

function stepSummaryApps(steps: TrailStep[]): string {
  const words = new Set<string>();
  for (const step of steps) {
    if (step.kind !== 'action') continue;
    for (const source of step.sources) {
      const app = source.app;
      words.add(
        app === 'gcal'
          ? 'calendar'
          : app === 'gmaps'
            ? 'Maps'
            : app === 'imessage'
              ? 'Messages'
              : ['google', 'reddit', 'yelp', 'youtube', 'tripadvisor', 'web'].includes(app)
                ? 'web'
                : app,
      );
    }
  }
  return [...words].join(', ');
}

export function Trail({ turn, now }: { turn: Turn; now: number }) {
  const running = turn.status === 'running' || turn.status === 'queued' || turn.status === 'paused';
  const doneStep = turn.trail.find(
    (s): s is Extract<TrailStep, { kind: 'done' }> => s.kind === 'done',
  );
  const [open, setOpen] = useState<boolean | null>(null);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const expanded = open ?? !doneStep;
  const end = turn.ended_at ? new Date(turn.ended_at).getTime() : now;
  const elapsed = Math.max(0, Math.round((end - new Date(turn.started_at).getTime()) / 1000));
  const steps = turn.trail.filter((s) => s.kind !== 'done');
  if (turn.trail.length === 0) return null;
  const sourceCount = steps.reduce((n, s) => n + (s.kind === 'action' ? s.sources.length : 0), 0);
  const summary =
    doneStep?.summary ??
    [`Worked for ${elapsed}s`, stepSummaryApps(steps), sourceCount ? `${sourceCount} sources` : '']
      .filter(Boolean)
      .join(' · ');
  const headText = running ? (
    <>
      <span className="working-dots" aria-hidden="true">
        <span className="pulse" />
        <span className="pulse" style={{ animationDelay: '.2s' }} />
        <span className="pulse" style={{ animationDelay: '.4s' }} />
      </span>
      <span>{turn.status === 'paused' ? `Paused · ${elapsed}s` : `Working · ${elapsed}s`}</span>
    </>
  ) : turn.status === 'stopped' ? (
    <span>Stopped after {elapsed}s</span>
  ) : turn.status === 'waiting' ? (
    <span>Waiting for you · {elapsed}s</span>
  ) : (
    <span>{doneStep ? summary.split(' · ')[0] : `Worked for ${elapsed}s`}</span>
  );
  const rest = doneStep ? summary.split(' · ').slice(1).join(' · ') : '';
  return (
    <div className="col" style={{ gap: 4 }}>
      <button
        type="button"
        className="trail-head"
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
      >
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} />
        {headText}
        {!expanded && rest ? (
          <span className="clamp1" style={{ color: 'var(--muted)', fontWeight: 400 }}>
            · {rest}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="trail-steps">
          {steps.map((step) => {
            if (step.kind === 'say')
              return (
                <div key={step.id} className="trail-say">
                  {step.text}
                </div>
              );
            if (step.kind === 'note')
              return (
                <div key={step.id} className="trail-row" data-note="true">
                  <span className="trail-icon">
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        background: 'var(--control)',
                      }}
                    />
                  </span>
                  <span style={{ flex: 1, fontSize: 13, color: 'var(--muted)' }}>{step.text}</span>
                </div>
              );
            const active = step.status === 'running';
            const isOpen = openStep === step.id;
            return (
              <div key={step.id} className="col">
                <button
                  type="button"
                  className="trail-row"
                  aria-expanded={isOpen}
                  disabled={active || step.sources.length === 0}
                  onClick={() => setOpenStep(isOpen ? null : step.id)}
                >
                  <span className="trail-icon">
                    {active ? (
                      <span style={{ color: 'var(--primary)', display: 'flex' }}>
                        <Icon name="loader" size={14} stroke={2} className="spin" />
                      </span>
                    ) : (
                      <span style={{ color: 'var(--secondary)', display: 'flex' }}>
                        <Icon name={ACTION_ICON(step)} size={15} />
                      </span>
                    )}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      fontSize: 13,
                      color: active ? 'var(--text)' : 'var(--secondary)',
                      minWidth: 0,
                    }}
                  >
                    {step.label}
                    {step.meta ? (
                      <span style={{ color: 'var(--muted)' }}> · {step.meta}</span>
                    ) : null}
                  </span>
                  {!active && step.sources.length > 0 ? (
                    <span style={{ color: 'var(--placeholder)', display: 'flex' }}>
                      <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={14} />
                    </span>
                  ) : null}
                </button>
                {!active && step.sources.length > 0 && (isOpen || steps.length <= 12) ? (
                  <div className="trail-chips">
                    {step.sources.map((source) => (
                      <SourceChip key={`${source.app}-${source.label}`} source={source} />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
          {doneStep ? (
            <div className="trail-row">
              <span className="trail-icon">
                <span style={{ color: 'var(--success)', display: 'flex' }}>
                  <Icon name="circleCheck" size={16} />
                </span>
              </span>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--heading)' }}>
                {doneStep.summary}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- result card ---------- */

export function ResultCard({
  card,
  permission,
  onDecide,
  children,
  touch = false,
}: {
  card: ResultCardData;
  permission: PermissionData | null;
  onDecide: (decision: 'allow_once' | 'always' | 'deny') => void;
  children?: ReactNode;
  touch?: boolean;
}) {
  const [more, setMore] = useState(false);
  const [broken, setBroken] = useState(false);
  const size = touch ? 'xl' : 'sm';
  const iconSize = touch ? 44 : 32;
  const decided = permission
    ? permission.status !== 'pending' && permission.status !== 'changed'
    : false;
  const allowed = permission?.status === 'allowed_once' || permission?.status === 'allowed_always';
  const primaryIcon = (card.primary.icon ?? 'calendar') as IconName;
  return (
    <div className="result-card">
      <div className="result-body">
        {card.image && !broken ? (
          <img
            src={card.image.src}
            alt={card.image.alt}
            loading="lazy"
            onError={() => setBroken(true)}
          />
        ) : card.image ? (
          <div className="result-image-missing" aria-label={card.image.alt}>
            <Icon name="image" size={22} />
          </div>
        ) : null}
        <div className="col grow" style={{ gap: 6 }}>
          <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{card.overline}</span>
            {card.example ? <Badge tone="outline">Example</Badge> : null}
          </div>
          <h3 style={{ fontSize: 20, fontWeight: 600, lineHeight: '26px' }}>{card.title}</h3>
          <div className="result-facts">
            {card.rating ? (
              <span className="row" style={{ gap: 4, color: 'var(--rating)', fontWeight: 600 }}>
                <Icon name="star" size={14} />
                {card.rating}
              </span>
            ) : null}
            {card.facts.map((fact, index) => (
              <span key={fact} className="row" style={{ gap: 8 }}>
                {index > 0 || card.rating ? (
                  <span style={{ color: 'var(--line-strong)' }}>·</span>
                ) : null}
                <span>{fact}</span>
              </span>
            ))}
          </div>
          {card.description ? (
            <p
              className="clamp2"
              style={{ fontSize: 13, lineHeight: '18px', color: 'var(--secondary)' }}
            >
              {card.description}
            </p>
          ) : null}
          {card.chips.length ? (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {card.chips.map((chip) => (
                <Badge key={chip} tone="chip">
                  {chip}
                </Badge>
              ))}
            </div>
          ) : null}
          <div className="card-actions" style={{ paddingTop: 4, position: 'relative' }}>
            {permission ? (
              allowed ? (
                <Button size={size} variant="secondary" icon="check" disabled block={touch}>
                  {card.primary.done_label ?? 'Done'}
                </Button>
              ) : permission.status === 'denied' ? (
                <Button size={size} variant="secondary" disabled block={touch}>
                  Not added
                </Button>
              ) : (
                <Button
                  size={size}
                  icon={primaryIcon}
                  block={touch}
                  onClick={() => onDecide('allow_once')}
                >
                  {card.primary.label}
                </Button>
              )
            ) : card.primary.effect.kind === 'link' ? (
              <a
                className="btn btn-sm btn-primary"
                href={card.primary.effect.url}
                target="_blank"
                rel="noreferrer"
              >
                {card.primary.label}
              </a>
            ) : (
              <Button size="sm" icon={primaryIcon} disabled>
                {card.primary.label}
              </Button>
            )}
            <IconButton
              name="mapPin"
              label="Open in Maps"
              variant="outline"
              size={iconSize}
              iconSize={touch ? 18 : 16}
            />
            {permission && !decided ? (
              <div style={{ position: 'relative' }}>
                <Button
                  size="sm"
                  variant="ghost"
                  iconRight="chevronDown"
                  onClick={() => setMore((m) => !m)}
                  aria-expanded={more}
                >
                  More
                </Button>
                <Popover open={more} onClose={() => setMore(false)}>
                  <Menu label="More" width={232}>
                    <MenuItem
                      icon="check"
                      onSelect={() => {
                        setMore(false);
                        onDecide('always');
                      }}
                    >
                      Always allow this
                    </MenuItem>
                    <MenuItem
                      icon="x"
                      onSelect={() => {
                        setMore(false);
                        onDecide('deny');
                      }}
                    >
                      Don’t add it
                    </MenuItem>
                  </Menu>
                </Popover>
              </div>
            ) : null}
          </div>
          {permission?.status === 'changed' ? (
            <span style={{ fontSize: 12, color: 'var(--danger)' }}>
              This changed while you were reading it. Take another look and decide again.
            </span>
          ) : null}
        </div>
      </div>
      {children}
    </div>
  );
}

/* ---------- receipt ---------- */

export function ReceiptRow({
  receipt,
  onUndo,
  standalone = false,
}: {
  receipt: ReceiptData;
  onUndo: () => void;
  standalone?: boolean;
}) {
  return (
    <div className="receipt" data-standalone={standalone ? 'true' : undefined}>
      <span
        className="row"
        style={{
          justifyContent: 'center',
          width: 20,
          height: 20,
          borderRadius: 999,
          background: receipt.undone ? 'var(--line)' : 'var(--success-soft)',
          color: receipt.undone ? 'var(--muted)' : 'var(--success)',
          flexShrink: 0,
        }}
      >
        <Icon name={receipt.undone ? 'refresh' : 'check'} size={12} stroke={3} />
      </span>
      <span className="grow" style={{ fontSize: 13, color: 'var(--text)', minWidth: 0 }}>
        {receipt.undone ? `Undone · ${receipt.what.toLowerCase()} was reversed` : receipt.what}{' '}
        {!receipt.undone ? (
          <span style={{ color: 'var(--muted)' }}>
            · {receipt.when} · {receipt.where}
          </span>
        ) : null}
      </span>
      {receipt.undo && !receipt.undone ? (
        <Button
          variant="outline"
          size="sm"
          onClick={onUndo}
          title={`Undo within ${receipt.undo.until}`}
        >
          Undo
        </Button>
      ) : null}
    </div>
  );
}

/* ---------- draft ---------- */

export function DraftCard({
  draft,
  onSend,
  onEdit,
}: {
  draft: DraftData;
  onSend: () => void;
  onEdit: (body: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(draft.body);
  useEffect(() => setBody(draft.body), [draft.body]);
  const sent = draft.status === 'sent';
  return (
    <div className="card-pad" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 10 }}>
        <Avatar initials={draft.recipient.initials} size={28} tone="sage" />
        <div className="col grow" style={{ gap: 1 }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
            Message to {draft.recipient.name}
          </span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {sent ? `Sent via ${draft.channel_label}` : 'Nothing is sent until you confirm'}
          </span>
        </div>
        {isLogo(draft.channel) ? <Logo name={draft.channel} size={24} /> : null}
      </div>
      <div className="draft-body">
        {editing ? (
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            aria-label="Draft"
          />
        ) : (
          body
        )}
      </div>
      <div className="card-actions" style={{ justifyContent: 'flex-end' }}>
        {sent ? (
          <Badge tone="success" dot>
            Sent
          </Badge>
        ) : editing ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setEditing(false);
                onEdit(body);
              }}
            >
              Save draft
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="ghost" icon="pencil" onClick={() => setEditing(true)}>
              Edit draft
            </Button>
            <Button size="sm" icon="send" onClick={onSend} loading={draft.status === 'sending'}>
              Send via {draft.channel_label}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- permission ---------- */

export function PermissionCard({
  permission,
  onDecide,
}: {
  permission: PermissionData;
  onDecide: (decision: 'allow_once' | 'always' | 'deny') => void;
}) {
  const pending = permission.status === 'pending' || permission.status === 'changed';
  const outcome =
    permission.status === 'allowed_once'
      ? 'Allowed once'
      : permission.status === 'allowed_always'
        ? 'Always allowed'
        : permission.status === 'denied'
          ? 'Denied'
          : null;
  return (
    <div className="card-pad">
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <span
          className="row"
          style={{
            justifyContent: 'center',
            width: 40,
            height: 40,
            borderRadius: 10,
            background: 'var(--blue-soft)',
            color: 'var(--blue-ink)',
            flexShrink: 0,
          }}
        >
          {isLogo(permission.connection.app) ? (
            <Logo name={permission.connection.app} size={24} />
          ) : (
            <Icon name="lock" size={20} />
          )}
        </span>
        <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>
            {permission.title}
          </span>
          {permission.detail ? (
            <span style={{ fontSize: 13, color: 'var(--secondary)' }}>{permission.detail}</span>
          ) : null}
        </div>
        {outcome ? (
          <Badge tone={permission.status === 'denied' ? 'neutral' : 'success'}>{outcome}</Badge>
        ) : null}
      </div>
      <div className="col">
        {Object.entries(permission.fields).map(([key, value]) => (
          <div key={key} className="field-row">
            <span>{key.replace(/_/g, ' ')}</span>
            <span>{Array.isArray(value) ? value.join(', ') : String(value)}</span>
          </div>
        ))}
      </div>
      <div
        className="row"
        style={{ gap: 8, fontSize: 12, color: 'var(--muted)', alignItems: 'flex-start' }}
      >
        <Icon name="lock" size={14} />
        <span>{permission.rule_text}</span>
      </div>
      {permission.status === 'changed' ? (
        <span style={{ fontSize: 13, color: 'var(--danger)' }}>
          This changed while you were reading it. Take another look and decide again.
        </span>
      ) : null}
      {pending ? (
        <div className="card-actions">
          <Button size="sm" onClick={() => onDecide('allow_once')}>
            Allow once
          </Button>
          <Button size="sm" variant="outline" onClick={() => onDecide('always')}>
            Always allow
          </Button>
          <div className="grow" />
          <Button size="sm" variant="ghost" onClick={() => onDecide('deny')}>
            Deny
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* ---------- questionnaire ---------- */

export function Questionnaire({
  question,
  onAnswer,
  active,
}: {
  question: QuestionData;
  onAnswer: (text: string) => void;
  /** Only the newest open question listens to the number keys. */
  active: boolean;
}) {
  const [own, setOwn] = useState('');
  const answered = question.answered;
  const options = question.options.slice(0, 4);
  useEffect(() => {
    if (!active || answered) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const n = Number(event.key);
      if (!Number.isInteger(n) || n < 1 || n > options.length + 1) return;
      event.preventDefault();
      const option = options[n - 1];
      if (option) onAnswer(option.label);
      else document.getElementById(`own-${question.id}`)?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, answered, options, onAnswer, question.id]);
  return (
    <div className="question">
      <div
        className="row"
        style={{ justifyContent: 'space-between', padding: '0 2px 4px', gap: 8 }}
      >
        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
          {question.title}
        </span>
        {!answered ? (
          <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
            Press 1–{options.length + 1}
          </span>
        ) : null}
      </div>
      {options.map((option, index) => {
        const on = answered === option.label;
        return (
          <button
            key={option.label}
            type="button"
            className="question-option"
            data-on={on ? 'true' : undefined}
            disabled={Boolean(answered)}
            onClick={() => onAnswer(option.label)}
          >
            <span className="kbd">{index + 1}</span>
            <span
              style={{
                fontSize: 14,
                fontWeight: 500,
                color: 'var(--heading)',
                whiteSpace: 'nowrap',
              }}
            >
              {option.label}
            </span>
            <span className="clamp1 grow" style={{ fontSize: 13, color: 'var(--muted)' }}>
              {option.description}
            </span>
            {on ? (
              <span
                className="row"
                style={{
                  justifyContent: 'center',
                  width: 20,
                  height: 20,
                  borderRadius: 999,
                  background: 'var(--primary)',
                  color: 'var(--primary-fg)',
                }}
              >
                <Icon name="check" size={12} stroke={3} />
              </span>
            ) : null}
          </button>
        );
      })}
      {!answered ? (
        <form
          className="question-own"
          onSubmit={(event) => {
            event.preventDefault();
            if (own.trim()) onAnswer(own.trim());
          }}
        >
          <span className="kbd">{options.length + 1}</span>
          <input
            id={`own-${question.id}`}
            value={own}
            onChange={(event) => setOwn(event.target.value)}
            placeholder="Type your own"
            aria-label="Your own answer"
          />
        </form>
      ) : answered && !options.some((o) => o.label === answered) ? (
        <div className="question-own">
          <span className="kbd">{options.length + 1}</span>
          <span style={{ fontSize: 14, color: 'var(--heading)' }}>{answered}</span>
        </div>
      ) : null}
    </div>
  );
}

/* ---------- unknown outcome ---------- */

export function UnknownCard({
  unknown,
  onResolve,
}: {
  unknown: UnknownOutcomeData;
  onResolve: (resolution: 'succeeded' | 'failed' | 'unresolved') => void;
}) {
  const settled = unknown.resolution;
  return (
    <div className="card-pad">
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <span
          className="row"
          style={{
            justifyContent: 'center',
            width: 40,
            height: 40,
            borderRadius: 10,
            background: 'var(--sand)',
            color: 'var(--sand-ink)',
            flexShrink: 0,
          }}
        >
          <Icon name="alert" size={20} />
        </span>
        <div className="col grow" style={{ gap: 2 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>
            I sent this once and never heard back.
          </span>
          <span style={{ fontSize: 13, color: 'var(--secondary)' }}>
            It may or may not have arrived. I have not sent it again. What I tried: {unknown.what}.
          </span>
        </div>
        {settled ? (
          <Badge
            tone={settled === 'succeeded' ? 'success' : settled === 'failed' ? 'danger' : 'neutral'}
          >
            {settled === 'succeeded'
              ? 'It arrived'
              : settled === 'failed'
                ? 'It did not'
                : 'Still unsure'}
          </Badge>
        ) : null}
      </div>
      {!settled ? (
        <div className="card-actions">
          <Button size="sm" onClick={() => onResolve('succeeded')}>
            It arrived
          </Button>
          <Button size="sm" variant="outline" onClick={() => onResolve('failed')}>
            It did not
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onResolve('unresolved')}>
            I can’t tell yet
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* ---------- browser ---------- */

export function BrowserFrame({
  session,
  dense = false,
  height,
}: {
  session: BrowserSessionData;
  dense?: boolean;
  height?: number;
}) {
  const p = session.preview;
  return (
    <div className="browser-frame" style={{ height }}>
      <div className="browser-bar" data-dense={dense ? 'true' : undefined}>
        <span className="browser-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="browser-url">
          <Icon name="lock" size={dense ? 12 : 9} />
          {session.url}
        </span>
      </div>
      <div className="browser-page" data-dense={dense ? 'true' : undefined}>
        <div className="row" style={{ gap: dense ? 12 : 6 }}>
          <span
            style={{
              width: dense ? 72 : 44,
              height: dense ? 14 : 8,
              borderRadius: 4,
              background: 'var(--line)',
            }}
          />
          <span
            style={{
              width: dense ? 220 : 120,
              height: dense ? 26 : 14,
              borderRadius: 4,
              background: 'var(--line)',
            }}
          />
          <span className="grow" />
          <span
            style={{
              width: dense ? 64 : 36,
              height: dense ? 26 : 14,
              borderRadius: 4,
              background: 'var(--line)',
            }}
          />
        </div>
        <div className="col" style={{ gap: dense ? 6 : 3 }}>
          <span
            style={{
              fontFamily: 'var(--font-head)',
              fontSize: dense ? 22 : 13,
              fontWeight: 700,
              color: 'var(--heading)',
              lineHeight: 1.2,
            }}
          >
            {p.title}
          </span>
          <span style={{ fontSize: dense ? 13 : 9, color: 'var(--secondary)' }}>{p.sub}</span>
        </div>
        {p.chips.length ? (
          <div className="row" style={{ gap: dense ? 12 : 6, flexWrap: 'wrap' }}>
            {p.chips.map((chip) => (
              <span key={chip} className="browser-pill">
                {chip}
              </span>
            ))}
          </div>
        ) : null}
        {p.slots.length ? (
          <div className="row" style={{ gap: dense ? 8 : 4, flexWrap: 'wrap' }}>
            {p.slots.map((slot) => (
              <span
                key={slot}
                className="browser-pill"
                data-on={slot === p.chosen ? 'true' : undefined}
              >
                {slot}
              </span>
            ))}
          </div>
        ) : null}
        {dense ? (
          <div className="col" style={{ gap: 8 }}>
            <span
              style={{ width: '100%', height: 10, borderRadius: 4, background: 'var(--line)' }}
            />
            <span
              style={{ width: '92%', height: 10, borderRadius: 4, background: 'var(--line)' }}
            />
            <span
              style={{ width: '60%', height: 10, borderRadius: 4, background: 'var(--line)' }}
            />
          </div>
        ) : null}
        {session.status === 'working' ? (
          <span
            style={{
              position: 'absolute',
              left: dense ? '47%' : '45%',
              top: dense ? '47%' : '62%',
              color: 'var(--heading)',
              display: 'flex',
            }}
          >
            <Icon name="cursor" size={dense ? 18 : 12} fill="#ffffff" />
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function BrowserCard({
  session,
  onTakeControl,
  onHandBack,
  onStop,
  onOpen,
}: {
  session: BrowserSessionData;
  onTakeControl: () => void;
  onHandBack: () => void;
  onStop: () => void;
  onOpen: () => void;
}) {
  const sub =
    session.status === 'working' ? (
      <span className="row" style={{ gap: 6, fontSize: 13, color: 'var(--secondary)' }}>
        <span className="spin" style={{ display: 'flex', color: 'var(--primary)' }}>
          <Icon name="loader" size={12} stroke={2} />
        </span>
        Working · {session.task}
      </span>
    ) : session.status === 'needs-you' ? (
      <span className="row" style={{ gap: 6, fontSize: 13, color: 'var(--secondary)' }}>
        <span style={{ color: 'var(--danger)', display: 'flex' }}>
          <Icon name="alert" size={14} />
        </span>
        Needs you · {session.attention ?? 'Take over, then hand it back'}
      </span>
    ) : session.status === 'stopped' ? (
      <span className="row" style={{ gap: 6, fontSize: 13, color: 'var(--secondary)' }}>
        <Icon name="square" size={14} />
        Stopped · nothing was booked
      </span>
    ) : (
      <span className="row" style={{ gap: 6, fontSize: 13, color: 'var(--secondary)' }}>
        <span style={{ color: 'var(--success)', display: 'flex' }}>
          <Icon name="circleCheck" size={14} />
        </span>
        Completed · {session.task}
      </span>
    );
  return (
    <div className="card-pad">
      <div className="row" style={{ gap: 12 }}>
        <span
          className="row"
          style={{
            justifyContent: 'center',
            width: 40,
            height: 40,
            borderRadius: 10,
            background: 'var(--soft)',
            border: '1px solid var(--line)',
            color: 'var(--secondary)',
            flexShrink: 0,
          }}
        >
          <Icon name="globe" size={20} />
        </span>
        <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>Browser</span>
          {sub}
        </div>
        {session.status === 'needs-you' ? (
          <Badge tone="danger">Action needed</Badge>
        ) : (
          <Badge tone="outline">Sandboxed</Badge>
        )}
      </div>
      <BrowserFrame session={session} height={200} />
      {session.status === 'working' ? (
        <div className="card-actions">
          <Button size="sm" icon="cursor" onClick={onTakeControl}>
            Take control
          </Button>
          <Button size="sm" variant="outline" icon="square" onClick={onStop}>
            Stop the task
          </Button>
          <div className="grow" />
          <Button size="sm" variant="ghost" icon="maximize" onClick={onOpen}>
            Open browser
          </Button>
        </div>
      ) : session.status === 'needs-you' ? (
        <div className="col" style={{ gap: 10 }}>
          <div
            className="row"
            style={{
              gap: 10,
              padding: '10px 12px',
              borderRadius: 10,
              background: 'var(--danger-soft)',
              fontSize: 13,
              color: 'var(--text)',
            }}
          >
            <span style={{ color: 'var(--danger)', display: 'flex' }}>
              <Icon name="lock" size={16} />
            </span>
            <span className="grow">
              Melete never types your passwords. Do this step yourself, then hand it back.
            </span>
          </div>
          <div className="card-actions">
            <Button size="sm" icon="check" onClick={onHandBack}>
              I’m done, continue
            </Button>
            <Button size="sm" variant="outline" icon="maximize" onClick={onOpen}>
              Open browser
            </Button>
            <div className="grow" />
            <Button size="sm" variant="ghost" onClick={onStop}>
              Stop the task
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" icon="maximize" block onClick={onOpen}>
          Open browser
        </Button>
      )}
    </div>
  );
}

/* ---------- action bar ---------- */

export function ActionBar({
  turn,
  onReact,
  onCopy,
  onSave,
  touch,
}: {
  turn: Turn;
  onReact: (reaction: Reaction) => void;
  onCopy: () => void;
  onSave: () => void;
  touch: boolean;
}) {
  const s = touch ? 40 : 28;
  const i = touch ? 18 : 15;
  return (
    <div className="action-bar">
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        style={{ height: s, paddingLeft: 8, paddingRight: 8, color: 'var(--text)' }}
        onClick={onSave}
      >
        <Icon name="bookmark" size={i} />
        Save to plan
      </button>
      <IconButton name="copy" label="Copy" size={s} iconSize={i} onClick={onCopy} />
      <IconButton
        name="thumbsUp"
        label="Good answer"
        size={s}
        iconSize={i}
        on={turn.reaction === 'up'}
        onClick={() => onReact(turn.reaction === 'up' ? null : 'up')}
      />
      <IconButton
        name="thumbsDown"
        label="Not helpful"
        size={s}
        iconSize={i}
        on={turn.reaction === 'down'}
        onClick={() => onReact(turn.reaction === 'down' ? null : 'down')}
      />
      <div className="grow" />
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
        {timeOf(turn.ended_at ?? turn.at)}
      </span>
    </div>
  );
}

/* ---------- avatars ---------- */

export function TurnAvatar({ agent, turn }: { agent: Agent | null; turn: Turn }) {
  if (!agent) return <MeleteAvatar size={28} />;
  const status =
    turn.status === 'waiting' ? 'idle' : turn.status === 'stopped' ? 'inactive' : turn.status;
  return <AgentFace look={agent.look} size={28} state={faceStateFor(status)} />;
}
