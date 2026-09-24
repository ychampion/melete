/**
 * The pieces of a chat turn: the person's bubble, the agent's trail, and the
 * cards that carry a result, a draft, a decision, a receipt, or a question.
 * Each renders from the contract's typed data and calls back with the one
 * thing a person can do to it.
 */
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { AgentFace, faceStateFor } from '../design/face.tsx';
import { Icon, type IconName } from '../design/icons.tsx';
import { Logo, type LogoName } from '../design/logos.tsx';
import { MeleteAvatar } from '../design/mark.tsx';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  Field,
  IconButton,
  Select,
  Status,
} from '../design/primitives.tsx';
import { decisionKey, pressOf } from '../experience/decide.ts';
import { lookOf } from '../experience/hooks.ts';
import { answerOf, reactionMessageSeq, type TranscriptTurn } from '../experience/reduce.ts';
import { type ToolEntry, toolOf } from '../experience/trace.ts';
import type {
  ActionResolution,
  Agent,
  Draft,
  LedgerAction,
  Permission,
  PermissionOption,
  Question,
  Reaction,
  Receipt,
  ResultCard as ResultCardData,
  RuleBounds,
  Source,
  TrailStep,
  TurnStatus,
} from '../experience/types.ts';

export const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** The logo for an app the contract names in plain words. */
const LOGO_BY_APP: Record<string, LogoName> = {
  'google calendar': 'gcal',
  calendar: 'gcal',
  gmail: 'gmail',
  mail: 'gmail',
  'google maps': 'gmaps',
  whatsapp: 'whatsapp',
  messages: 'imessage',
  imessage: 'imessage',
  slack: 'slack',
  notion: 'notion',
  spotify: 'spotify',
  'google drive': 'gdrive',
  files: 'gdrive',
  uber: 'uber',
  zoom: 'zoom',
  linear: 'linear',
  github: 'github',
  google: 'google',
  yelp: 'yelp',
  reddit: 'reddit',
  x: 'x',
  youtube: 'youtube',
  tripadvisor: 'tripadvisor',
};
export const logoFor = (app: string): LogoName | null => LOGO_BY_APP[app.toLowerCase()] ?? null;

const KIND_ICON: Record<Source['kind'], IconName> = {
  event: 'calendar',
  message: 'messages',
  draft: 'messages',
  file: 'fileText',
  page: 'globe',
  task: 'check',
};

/* ---------- user bubble ---------- */

export function UserBubble({
  turn,
  reactions = [],
  onRetry,
}: {
  turn: TranscriptTurn;
  /** The agent's glyphs on this message, drawn under the bubble. */
  reactions?: Reaction[];
  onRetry?: () => void;
}) {
  const delivery = turn.delivery;
  // A turn started elsewhere is drawn from its events before its message is read.
  if (!turn.turn.text) return null;
  return (
    <div className="bubble-wrap">
      <div className="bubble" data-pending={delivery ? 'true' : undefined}>
        {turn.turn.text}
      </div>
      {reactions.length ? <ReactionRow reactions={reactions} /> : null}
      <div className="bubble-meta">
        {delivery === 'sending' ? (
          <span className="row" style={{ gap: 6 }}>
            <Icon name="loader" size={12} stroke={2} className="spin" />
            Sending…
          </span>
        ) : delivery === 'queued_offline' ? (
          <span>Will send when you’re back online</span>
        ) : delivery === 'failed_retry' ? (
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
          <span>{timeOf(turn.turn.created_at)}</span>
        )}
      </div>
    </div>
  );
}

/* ---------- trail ---------- */

function SourceChip({ source }: { source: Source }) {
  const logo = logoFor(source.app);
  const inner = logo ? (
    <Logo name={logo} size={16} />
  ) : (
    <span style={{ color: 'var(--muted)', display: 'flex' }}>
      <Icon name={KIND_ICON[source.kind]} size={13} />
    </span>
  );
  const body = (
    <>
      {inner}
      <span>{source.title}</span>
    </>
  );
  return source.url ? (
    <a className="trail-chip" href={source.url} target="_blank" rel="noreferrer" title={source.app}>
      {body}
    </a>
  ) : (
    <span className="trail-chip" title={source.app}>
      {body}
    </span>
  );
}

const actionIcon = (step: Extract<TrailStep, { type: 'action' }>): IconName => {
  const kinds = step.sources.map((s) => s.kind);
  const apps = step.sources.map((s) => s.app.toLowerCase());
  if (apps.some((a) => a.includes('calendar'))) return 'calendar';
  if (apps.some((a) => a.includes('maps'))) return 'mapPin';
  if (kinds.includes('draft') || kinds.includes('message')) return 'messages';
  if (kinds.includes('file')) return 'fileText';
  if (kinds.includes('event')) return 'calendar';
  if (kinds.includes('page')) return 'search';
  const label = step.label.toLowerCase();
  if (label.includes('calendar')) return 'calendar';
  if (label.includes('draft') || label.includes('message')) return 'messages';
  if (label.includes('browser') || label.includes('opened')) return 'globe';
  if (label.includes('slot') || label.includes('chose')) return 'cursor';
  return 'search';
};

const TOOL_ICON: Record<string, IconName> = {
  connector: 'mail',
  web: 'globe',
  file: 'fileText',
  artifact: 'upload',
  browser: 'compass',
  sandbox: 'square',
  skill: 'sparkles',
  memory_recall: 'book',
  memory_write: 'book',
  memory_correct: 'pencil',
  memory_forget: 'trash',
  model: 'sparkles',
  retry: 'refresh',
};

/** What went in and what came out, in Melete's words; anything from outside is quoted. */
function ToolLines({ tool }: { tool: ToolEntry }) {
  const summaries = [tool.input_summary, tool.output_summary].filter(
    (summary): summary is NonNullable<typeof summary> => summary !== null,
  );
  if (summaries.length === 0) return null;
  return (
    <div className="trail-tool">
      {summaries.map((summary, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: input then output, in that order
        <span key={index} className="trail-tool-line">
          {summary.text}
          {summary.quote ? (
            <q className="trail-quote" title={`From a ${summary.quote.from}`}>
              {summary.quote.text}
            </q>
          ) : null}
        </span>
      ))}
    </div>
  );
}

const RUNNING: TurnStatus[] = ['queued', 'working', 'streaming', 'paused'];

export function Trail({ turn, now }: { turn: TranscriptTurn; now: number }) {
  const running = RUNNING.includes(turn.status);
  const dones = turn.trail.filter(
    (s): s is Extract<TrailStep, { type: 'done' }> => s.type === 'done',
  );
  // A job that keeps going after it first settles (a chase: the send, then the
  // reply and the follow-up) is read from its last resting line, and stays open
  // so what it did after the send is in view.
  const doneStep = running ? undefined : dones.at(-1);
  const continued =
    turn.trail.findIndex((s) => s.type === 'done') < turn.trail.length - 1 && dones.length > 0;
  const [open, setOpen] = useState<boolean | null>(null);
  const steps = turn.trail.filter((s) => s.type !== 'done');
  if (turn.trail.length === 0) return null;
  const expanded = open ?? (!doneStep || continued);
  const elapsed = doneStep
    ? Math.max(1, Math.round(doneStep.elapsed_ms / 1000))
    : Math.max(0, Math.round((now - new Date(turn.turn.created_at).getTime()) / 1000));
  const rest = doneStep
    ? [
        doneStep.apps.join(', '),
        doneStep.source_count
          ? `${doneStep.source_count} source${doneStep.source_count === 1 ? '' : 's'}`
          : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const head = running ? (
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
  ) : turn.status === 'needs_you' ? (
    <span>Waiting for you · {elapsed}s</span>
  ) : turn.status === 'failed' ? (
    <span>Stopped without finishing</span>
  ) : (
    <span>Worked for {elapsed}s</span>
  );
  return (
    <div className="col" style={{ gap: 4 }}>
      <button
        type="button"
        className="trail-head"
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
      >
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} />
        {head}
        {!expanded && rest ? (
          <span className="clamp1" style={{ color: 'var(--muted)', fontWeight: 400 }}>
            · {rest}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="trail-steps">
          {steps.map((step, index) => {
            const key = `${step.type}-${index}`;
            if (step.type === 'say')
              return (
                <div key={key} className="trail-say">
                  {step.text}
                </div>
              );
            if (step.type === 'note')
              return (
                <div key={key} className="trail-row" data-note="true">
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
            if (step.type !== 'action') return null;
            const tool = toolOf(step);
            return (
              <div key={key} className="col">
                <div className="trail-row">
                  <span className="trail-icon">
                    <span
                      style={{
                        color: tool?.status === 'failed' ? 'var(--danger)' : 'var(--secondary)',
                        display: 'flex',
                      }}
                    >
                      <Icon name={(tool && TOOL_ICON[tool.kind]) || actionIcon(step)} size={15} />
                    </span>
                  </span>
                  <span style={{ flex: 1, fontSize: 13, color: 'var(--secondary)', minWidth: 0 }}>
                    {tool?.title ?? step.label}
                    {!tool && step.meta ? (
                      <span style={{ color: 'var(--muted)' }}> · {step.meta}</span>
                    ) : null}
                  </span>
                </div>
                {tool ? <ToolLines tool={tool} /> : null}
                {step.sources.length ? (
                  <div className="trail-chips">
                    {step.sources.map((source) => (
                      <SourceChip key={`${source.app}-${source.title}`} source={source} />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
          {running && steps.length > 0 ? (
            <div className="trail-row">
              <span className="trail-icon">
                <span style={{ color: 'var(--primary)', display: 'flex' }}>
                  <Icon name="loader" size={14} stroke={2} className="spin" />
                </span>
              </span>
              <span style={{ flex: 1, fontSize: 13, color: 'var(--text)' }}>
                {turn.status === 'paused' ? 'Paused' : (turn.live?.title ?? 'Still working')}
              </span>
            </div>
          ) : null}
          {doneStep ? (
            <div className="trail-row">
              <span className="trail-icon">
                <span style={{ color: 'var(--success)', display: 'flex' }}>
                  <Icon name="circleCheck" size={16} />
                </span>
              </span>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--heading)' }}>
                Worked for {elapsed}s{rest ? ` · ${rest}` : ''}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A message body as paragraphs: a blank line is a gap, a single break stays a break. */
function Paragraphs({ text }: { text: string }) {
  const paragraphs = text.split(/\n\s*\n/).filter((part) => part.trim().length > 0);
  return (
    <>
      {paragraphs.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the paragraphs are a cut of one string, in order
        <p key={index}>{part.trim()}</p>
      ))}
    </>
  );
}

/* ---------- result card ---------- */

export function ResultCard({
  card,
  draft,
  onSend,
  onUndo,
  touch = false,
  sending = false,
  readOnly = false,
  children,
}: {
  card: ResultCardData;
  /** The draft this card carries, when its send button raised one. */
  draft?: Draft;
  onSend?: (handle: string) => void;
  onUndo?: (handle: string) => void;
  touch?: boolean;
  sending?: boolean;
  readOnly?: boolean;
  children?: ReactNode;
}) {
  const size = touch ? 'xl' : 'sm';
  const about = card.facts.find((f) => f.label === 'About')?.value ?? null;
  const chips = card.facts.filter((f) => f.label === 'When').map((f) => f.value);
  const rows = card.facts.filter(
    (f) => f.label !== 'About' && f.label !== 'When' && f.label !== 'Draft',
  );
  const draftBody = draft?.body ?? card.facts.find((f) => f.label === 'Draft')?.value ?? null;
  const [broken, setBroken] = useState(false);
  const action = (a: NonNullable<ResultCardData['primary_action']>, primary: boolean) => {
    if (a.kind === 'open' || a.kind === 'download') {
      return a.url ? (
        <a
          key={a.handle}
          className={`btn btn-${size} btn-${primary ? 'primary' : 'outline'}`}
          href={a.url}
          target="_blank"
          rel="noreferrer"
        >
          {a.label}
        </a>
      ) : null;
    }
    if (a.kind === 'send') {
      if (draft?.status === 'sent')
        return (
          <Badge key={a.handle} tone="success" dot>
            Sent
          </Badge>
        );
      if (draft?.status === 'awaiting_permission')
        return (
          <Badge key={a.handle} tone="outline">
            Waiting for your decision
          </Badge>
        );
      return (
        <Button
          key={a.handle}
          size={size}
          icon="send"
          block={touch}
          loading={sending}
          disabled={readOnly}
          onClick={() => onSend?.(a.handle)}
        >
          {a.label}
        </Button>
      );
    }
    return (
      <Button
        key={a.handle}
        size={size}
        variant="outline"
        block={touch}
        disabled={readOnly}
        onClick={() => onUndo?.(a.handle)}
      >
        {a.label}
      </Button>
    );
  };
  const isDraft = Boolean(draftBody);
  if (draft && (draft.status === 'awaiting_permission' || draft.status === 'sent'))
    return (
      <div className="draft-row">
        <Avatar initials={draft.recipient.slice(0, 2).toUpperCase()} size={28} tone="sage" />
        <span className="col grow" style={{ gap: 1, minWidth: 0 }}>
          <span className="clamp1 draft-row-title">{draft.subject || card.title}</span>
          <span className="clamp1 draft-row-meta">
            To {draft.recipient} · {draft.channel === 'email' ? 'email' : 'message'}
          </span>
        </span>
        {draft.status === 'awaiting_permission' ? (
          <span className="draft-tag">Waiting for your decision</span>
        ) : (
          <Status tone="settled" quiet>
            Sent
          </Status>
        )}
      </div>
    );
  return (
    <div className="result-card">
      <div className="result-body">
        {card.image && !broken ? (
          <img src={card.image} alt="" loading="lazy" onError={() => setBroken(true)} />
        ) : null}
        <div className="col grow" style={{ gap: 6, minWidth: 0 }}>
          {isDraft ? (
            <div className="row" style={{ gap: 10 }}>
              <Avatar
                initials={(draft?.recipient ?? card.title).slice(0, 2).toUpperCase()}
                size={28}
                tone="sage"
              />
              <div className="col grow" style={{ gap: 1 }}>
                <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
                  {card.title}
                </span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{card.meta}</span>
              </div>
            </div>
          ) : (
            <>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{card.meta}</span>
              <h3 style={{ fontSize: 20, fontWeight: 600, lineHeight: '26px' }}>{card.title}</h3>
            </>
          )}
          {isDraft ? (
            <div className="draft-body">
              {draft?.subject && draft.subject !== card.title ? (
                <div className="draft-subject">{draft.subject}</div>
              ) : null}
              <Paragraphs text={draftBody ?? ''} />
            </div>
          ) : null}
          {draft ? (
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              To {draft.recipient}
              {draft.cc?.length ? ` · cc ${draft.cc.join(', ')}` : ''}
              {draft.bcc?.length ? ` · bcc ${draft.bcc.join(', ')}` : ''}
            </span>
          ) : null}
          {about ? (
            <p
              className="clamp2"
              style={{ fontSize: 13, lineHeight: '18px', color: 'var(--secondary)' }}
            >
              {about}
            </p>
          ) : null}
          {rows.length ? (
            <div className="col">
              {rows.map((fact) => (
                <div key={`${fact.label}-${fact.value}`} className="field-row">
                  <span>{fact.label}</span>
                  <span>{fact.value}</span>
                </div>
              ))}
            </div>
          ) : null}
          {chips.length ? (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {chips.map((chip) => (
                <Badge key={chip} tone="chip">
                  {chip}
                </Badge>
              ))}
            </div>
          ) : null}
          {card.primary_action || card.secondary_actions.length ? (
            <div
              className="card-actions"
              style={{ paddingTop: 4, justifyContent: isDraft ? 'flex-end' : undefined }}
            >
              {card.primary_action ? action(card.primary_action, true) : null}
              {card.secondary_actions.map((a) => action(a, false))}
            </div>
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
  reversed,
  now,
  onUndo,
  standalone = false,
}: {
  receipt: Receipt;
  reversed: boolean;
  now: number;
  onUndo: () => void;
  standalone?: boolean;
}) {
  const canUndo =
    Boolean(receipt.undo) &&
    !reversed &&
    (receipt.undo ? Date.parse(receipt.undo.valid_until) > now : false);
  const reversal = receipt.what.startsWith('Removed again');
  return (
    <div className="receipt" data-standalone={standalone ? 'true' : undefined}>
      <span
        className="row"
        style={{
          justifyContent: 'center',
          width: 20,
          height: 20,
          borderRadius: 999,
          background: reversed || reversal ? 'var(--line)' : 'var(--success-soft)',
          color: reversed || reversal ? 'var(--muted)' : 'var(--success)',
          flexShrink: 0,
        }}
      >
        <Icon name={reversed || reversal ? 'refresh' : 'check'} size={12} stroke={3} />
      </span>
      <span
        className="grow"
        style={{
          fontSize: 13,
          color: 'var(--text)',
          minWidth: 0,
          textDecoration: reversed ? 'line-through' : undefined,
        }}
      >
        {receipt.what}{' '}
        <span style={{ color: 'var(--muted)' }}>
          · {timeOf(receipt.when)} · {receipt.where}
        </span>
      </span>
      {canUndo ? (
        <Button
          variant="outline"
          size="sm"
          className="btn-undo"
          onClick={onUndo}
          title={`Undo until ${timeOf(receipt.undo?.valid_until ?? receipt.when)}`}
        >
          Undo
        </Button>
      ) : null}
    </div>
  );
}

/* ---------- permission ---------- */

const DAYS = [1, 7, 14, 30] as const;

export function PermissionCard({
  permission,
  decided,
  onDecide,
  touch = false,
  bare = false,
  busy = false,
}: {
  permission: Permission;
  decided: PermissionOption | 'closed' | null;
  onDecide: (option: PermissionOption, bounds?: RuleBounds) => void;
  touch?: boolean;
  /** Drawn without its footer, when the phone carries the decision in a bottom bar. */
  bare?: boolean;
  /** The decision's request is in flight: its actions wait for the answer. */
  busy?: boolean;
}) {
  const [always, setAlways] = useState(false);
  const [cap, setCap] = useState('10');
  const [days, setDays] = useState('30');
  const [reconsent, setReconsent] = useState('7');
  const pending = decided === null;
  const outcome =
    decided === 'allow_once'
      ? 'Allowed once'
      : decided === 'always'
        ? 'Always allowed'
        : decided === 'deny'
          ? 'Denied'
          : decided === 'closed'
            ? 'Decided'
            : null;
  const can = (option: PermissionOption) => permission.options.includes(option);
  // When a decision made here collapses the card, focus stays on it rather
  // than falling to the page with the buttons that were pressed.
  const cardRef = useRef<HTMLDivElement>(null);
  const was = useRef(decided);
  useEffect(() => {
    const before = was.current;
    was.current = decided;
    if (before !== null || decided === null || decided === 'closed') return;
    const active = document.activeElement;
    const lost =
      !active ||
      active === document.body ||
      cardRef.current?.contains(active) ||
      active.closest('.decide-bar') !== null;
    if (lost) cardRef.current?.focus({ preventScroll: true });
  }, [decided]);
  const fields = permission.why.slice(1).map((line) => {
    const [label = '', ...value] = line.split(': ');
    return { label, value: value.join(': ') };
  });
  const draft = permission.draft;
  if (draft && !fields.some((field) => field.label.toLowerCase() === 'to'))
    fields.push({
      label: 'To',
      value: `${draft.recipient}${draft.cc?.length ? ` · cc ${draft.cc.join(', ')}` : ''}${
        draft.bcc?.length ? ` · bcc ${draft.bcc.join(', ')}` : ''
      }`,
    });
  const size = touch ? 'xl' : 'md';

  // The keys work only while this card has focus: Enter on the card itself, D anywhere in it.
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!pending || always) return;
    const intent = decisionKey(pressOf(event), { allow: can('allow_once'), deny: can('deny') });
    if (!intent) return;
    event.preventDefault();
    if (busy) return;
    if (intent.kind === 'allow') onDecide('allow_once');
    else if (intent.kind === 'deny') onDecide('deny');
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would restyle the card and carries no more meaning than a named group
    <div
      ref={cardRef}
      className="permission"
      data-pending={pending ? 'true' : undefined}
      role="group"
      aria-label={permission.what}
      tabIndex={pending ? 0 : -1}
      onKeyDown={onKey}
    >
      <div className="permission-head">
        <span className="permission-lock" data-done={pending ? undefined : 'true'}>
          <Icon name={pending ? 'lock' : 'check'} size={16} />
        </span>
        <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
          <span className="permission-what">{permission.what}</span>
          <span className="permission-why">{permission.why[0]}</span>
        </div>
        {outcome ? (
          <Status tone={decided === 'allow_once' || decided === 'always' ? 'settled' : 'kind'}>
            {outcome}
          </Status>
        ) : null}
      </div>
      {pending ? (
        <div className="permission-body">
          {fields.length ? (
            <div className="permission-fields">
              {fields.map((field) => (
                <div key={`${field.label}-${field.value}`} className="permission-field">
                  <span>{field.label}</span>
                  <span>{field.value}</span>
                </div>
              ))}
            </div>
          ) : null}
          {permission.preview && !draft ? (
            <ResultCard card={permission.preview} readOnly touch={touch} />
          ) : null}
          {draft ? (
            <div className="permission-draft">
              {draft.subject ? <div className="draft-subject">{draft.subject}</div> : null}
              <Paragraphs text={draft.body} />
            </div>
          ) : null}
        </div>
      ) : null}
      {pending && !bare ? (
        <div className="permission-foot">
          <span className="permission-caption">
            <Icon name="lock" size={13} />
            <span>
              {can('always')
                ? '“Always allow” creates a rule with a limit and an expiry you can see and revoke in Settings.'
                : 'This request can be allowed once or denied.'}
            </span>
          </span>
          <div className="permission-actions">
            {can('always') ? (
              <Button
                size={size}
                variant="outline"
                block={touch}
                disabled={busy}
                onClick={() => setAlways(true)}
              >
                Always allow
              </Button>
            ) : null}
            {can('deny') ? (
              <Button
                size={size}
                variant="ghost"
                block={touch}
                hint={touch ? undefined : 'D'}
                disabled={busy}
                onClick={() => onDecide('deny')}
              >
                Deny
              </Button>
            ) : null}
            {can('allow_once') ? (
              <Button
                size={size}
                block={touch}
                hint={touch ? undefined : '↵'}
                disabled={busy}
                onClick={() => onDecide('allow_once')}
              >
                Allow once
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <Dialog
        open={always}
        onClose={() => setAlways(false)}
        title="Always allow this?"
        sub="A rule with a limit and an expiry. You can revoke it any time under Settings › Rules."
        footer={
          <>
            <Button variant="ghost" onClick={() => setAlways(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setAlways(false);
                onDecide('always', {
                  count_cap: Number(cap),
                  expires_at: new Date(Date.now() + Number(days) * 86_400_000).toISOString(),
                  reconsent_after_days: Number(reconsent),
                });
              }}
            >
              Create the rule
            </Button>
          </>
        }
      >
        <Field label="Up to">
          <Select
            label="Up to"
            value={cap}
            onChange={setCap}
            width="100%"
            options={['1', '5', '10', '25', '50'].map((n) => ({
              value: n,
              label: `${n} time${n === '1' ? '' : 's'}`,
            }))}
          />
        </Field>
        <Field label="For the next">
          <Select
            label="For the next"
            value={days}
            onChange={setDays}
            width="100%"
            options={DAYS.map((n) => ({
              value: String(n),
              label: `${n} day${n === 1 ? '' : 's'}`,
            }))}
          />
        </Field>
        <Field
          label="Ask me again after"
          hint="Even inside the limit, Melete checks in again after this many days."
        >
          <Select
            label="Ask me again after"
            value={reconsent}
            onChange={setReconsent}
            width="100%"
            options={['1', '3', '7', '14', '30'].map((n) => ({
              value: n,
              label: `${n} day${n === '1' ? '' : 's'}`,
            }))}
          />
        </Field>
      </Dialog>
    </div>
  );
}

/* ---------- questionnaire ---------- */

export function Questionnaire({
  question,
  answered,
  active,
  busy = false,
  onAnswer,
  onOwn,
}: {
  question: Question;
  answered: string | null;
  /** The answer's request is in flight: the options wait for it. */
  busy?: boolean;
  /** The newest open question, drawn as the one waiting on the person. */
  active: boolean;
  onAnswer: (optionId: string) => void;
  onOwn: (text: string) => void;
}) {
  const [own, setOwn] = useState('');
  const options = question.options.slice(0, 4);
  // The number keys answer only while this card has focus.
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (answered) return;
    const intent = decisionKey(pressOf(event), { options, own: true });
    if (!intent) return;
    event.preventDefault();
    if (intent.kind === 'own') document.getElementById(`own-${question.id}`)?.focus();
    else if (intent.kind === 'answer' && !busy) onAnswer(intent.optionId);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would restyle the card and carries no more meaning than a named group
    <div
      className="question"
      data-active={active ? 'true' : undefined}
      role="group"
      aria-label={question.text}
      tabIndex={answered ? -1 : 0}
      onKeyDown={onKey}
    >
      <div
        className="row"
        style={{ justifyContent: 'space-between', padding: '0 2px 4px', gap: 8 }}
      >
        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
          {question.text}
        </span>
        {!answered ? (
          <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
            Press 1–{options.length + 1}
          </span>
        ) : null}
      </div>
      {options.map((option, index) => {
        const [label, ...description] = option.label.split(' · ');
        const on = answered === option.id;
        return (
          <button
            key={option.id}
            type="button"
            className="question-option"
            data-on={on ? 'true' : undefined}
            disabled={Boolean(answered) || busy}
            onClick={() => onAnswer(option.id)}
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
              {label}
            </span>
            <span className="clamp1 grow" style={{ fontSize: 13, color: 'var(--muted)' }}>
              {description.join(' · ')}
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
            if (own.trim()) onOwn(own.trim());
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
      ) : null}
      {question.if_ignored && !answered ? (
        <span style={{ fontSize: 12, color: 'var(--muted)', padding: '0 2px' }}>
          {question.if_ignored}
        </span>
      ) : null}
    </div>
  );
}

/* ---------- action bar ---------- */

/**
 * An effect the connector never confirmed, read from the broker's ledger.
 * Nothing is repeated; the person says what happened and the ledger records
 * that decision. The action's kind is a tool name and is never shown.
 */
export function describeAction(action: LedgerAction): string {
  const payload = action.canonical_payload as Record<string, unknown>;
  const to = payload.to;
  if (Array.isArray(to) && to.length) return `a message to ${to.map(String).join(', ')}`;
  if (typeof to === 'string' && to) return `a message to ${to}`;
  if (typeof payload.title === 'string' && payload.title) return `“${payload.title}”`;
  return 'the change';
}

export function UnknownCard({
  action,
  onResolve,
}: {
  action: LedgerAction;
  onResolve: (resolution: ActionResolution) => void;
}) {
  const settled =
    action.status === 'succeeded' || action.status === 'failed' ? action.status : null;
  const unsure = action.status === 'unresolved';
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
        <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>
            I sent this once and never heard back.
          </span>
          <span style={{ fontSize: 13, color: 'var(--secondary)' }}>
            It may or may not have arrived. I have not sent it again. What I tried:{' '}
            {describeAction(action)}.
          </span>
        </div>
        {settled ? (
          <Badge tone={settled === 'succeeded' ? 'success' : 'neutral'}>
            {settled === 'succeeded' ? 'It arrived' : 'It did not'}
          </Badge>
        ) : unsure ? (
          <Badge tone="neutral">Still unsure</Badge>
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
          {unsure ? null : (
            <Button size="sm" variant="ghost" onClick={() => onResolve('unresolved')}>
              I can’t tell yet
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- reactions ---------- */

/** The glyphs a person can answer with in one tap. Anything else is a message. */
export const REACTION_SET = ['\u{1F44D}', '\u{1F44E}', '\u2764\uFE0F', '\u{1F64F}'] as const;

/**
 * Reactions drawn on the message they belong to, never as a row of their own.
 * The same glyph from both sides shows once, with a count.
 */
export function ReactionRow({ reactions }: { reactions: Reaction[] }) {
  const grouped = new Map<string, Reaction[]>();
  for (const reaction of reactions)
    grouped.set(reaction.emoji, [...(grouped.get(reaction.emoji) ?? []), reaction]);
  if (grouped.size === 0) return null;
  return (
    <div className="reactions">
      {[...grouped.entries()].map(([emoji, list]) => {
        const who = list.map((r) => (r.by === 'person' ? 'you' : 'the agent')).join(' and ');
        return (
          <span
            key={emoji}
            className="reaction"
            data-mine={list.some((r) => r.by === 'person') ? 'true' : undefined}
            title={`${emoji} from ${who}`}
          >
            <span aria-hidden="true">{emoji}</span>
            {list.length > 1 ? <span className="reaction-count">{list.length}</span> : null}
            <span className="sr-only">{`${emoji} from ${who}`}</span>
          </span>
        );
      })}
    </div>
  );
}

export function ActionBar({
  turn,
  onCopy,
  touch,
  reactions = [],
  onReact,
}: {
  turn: TranscriptTurn;
  onCopy: () => void;
  touch: boolean;
  reactions?: Reaction[];
  /** Absent when this message cannot be reacted to; then no control is drawn. */
  onReact?: (emoji: string) => void;
}) {
  const s = touch ? 40 : 28;
  const i = touch ? 18 : 15;
  const mine = new Set(reactions.filter((r) => r.by === 'person').map((r) => r.emoji));
  return (
    <div className="col" style={{ gap: 4 }}>
      {reactions.length ? <ReactionRow reactions={reactions} /> : null}
      <div className="action-bar">
        <IconButton name="copy" label="Copy" size={s} iconSize={i} onClick={onCopy} />
        {onReact && reactionMessageSeq(turn) !== null
          ? REACTION_SET.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="react-btn"
                style={{ width: s, height: s }}
                aria-label={`React with ${emoji}`}
                aria-pressed={mine.has(emoji)}
                data-on={mine.has(emoji) ? 'true' : undefined}
                onClick={() => onReact(emoji)}
              >
                <span aria-hidden="true">{emoji}</span>
              </button>
            ))
          : null}
        <div className="grow" />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{timeOf(turn.turn.created_at)}</span>
      </div>
    </div>
  );
}

/* ---------- avatars ---------- */

export function TurnAvatar({ agent, status }: { agent: Agent | null; status: TurnStatus }) {
  if (!agent) return <MeleteAvatar size={28} />;
  const mapped =
    status === 'working'
      ? 'running'
      : status === 'needs_you'
        ? 'idle'
        : status === 'stopped'
          ? 'inactive'
          : status;
  return <AgentFace look={lookOf(agent)} size={28} state={faceStateFor(mapped)} />;
}

export const answerText = answerOf;
