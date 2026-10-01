/**
 * The pieces of a chat turn: the person's bubble, the agent's trail, and the
 * cards that carry a result, a draft, a decision, a receipt, or a question.
 * Each renders from the contract's typed data and calls back with the one
 * thing a person can do to it.
 */
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
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
import { adapter } from '../experience/adapter.ts';
import { decisionKey, pressOf } from '../experience/decide.ts';
import { lookOf } from '../experience/hooks.ts';
import { plainTitle } from '../experience/plain.ts';
import { answerOf, reactionMessageSeq, type TranscriptTurn } from '../experience/reduce.ts';
import { OPEN_TEXT_LIMIT_BYTES } from '../experience/text-prefix.ts';
import { toolOf } from '../experience/trace.ts';
import type {
  ActionResolution,
  ActionReview,
  Agent,
  BecauseLink,
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
import { href } from '../router.ts';
import { ActivityRow, ThinkingBlock } from './activity.tsx';

export const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/**
 * The logo for an app the contract names in plain words. Only a named product
 * wears its logo: a mailbox, calendar or file store of no particular brand is
 * drawn with its own icon (see `appIcon`).
 */
const LOGO_BY_APP: Record<string, LogoName> = {
  'google calendar': 'gcal',
  gmail: 'gmail',
  'google maps': 'gmaps',
  whatsapp: 'whatsapp',
  messages: 'imessage',
  imessage: 'imessage',
  slack: 'slack',
  notion: 'notion',
  spotify: 'spotify',
  'google drive': 'gdrive',
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

/** The icon for a connection of no particular brand, by the kind of thing it reaches. */
const ICON_BY_APP: Record<string, IconName> = {
  mail: 'mail',
  calendar: 'calendar',
  files: 'files',
  'saved results': 'bookmark',
  'finished work': 'bookmark',
  web: 'globe',
  browser: 'globe',
  computer: 'monitor',
  'code runner': 'terminal',
  'code in the workspace': 'terminal',
  voice: 'voice',
  speech: 'voice',
  'voice to text': 'mic',
  transcription: 'mic',
  phone: 'messages',
  messages: 'messages',
  device: 'laptop',
  devices: 'laptop',
  mcp: 'connectors',
};
export const appIcon = (app: string, label?: string): IconName =>
  ICON_BY_APP[(label ?? '').toLowerCase()] ?? ICON_BY_APP[app.toLowerCase()] ?? 'connectors';

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

const RUNNING: TurnStatus[] = ['queued', 'working', 'streaming', 'paused'];

/** A step the trail tells without a tool entry: grouped app work and its sources. */
function GroupStep({
  step,
  chipsOnly,
}: {
  step: Extract<TrailStep, { type: 'action' }>;
  /** The rows above already name the work, so only the sources are added. */
  chipsOnly: boolean;
}) {
  const chips = step.sources.length ? (
    <div className="trail-chips">
      {step.sources.map((source) => (
        <SourceChip key={`${source.app}-${source.title}`} source={source} />
      ))}
    </div>
  ) : null;
  if (chipsOnly) return chips ? <li className="act-sources">{chips}</li> : null;
  return (
    <li className="col">
      <div className="trail-row">
        <span className="trail-icon">
          <span style={{ color: 'var(--secondary)', display: 'flex' }}>
            <Icon name={actionIcon(step)} size={15} />
          </span>
        </span>
        <span style={{ flex: 1, fontSize: 13, color: 'var(--secondary)', minWidth: 0 }}>
          {step.label}
          {step.meta ? <span style={{ color: 'var(--muted)' }}> · {step.meta}</span> : null}
        </span>
      </div>
      {chips}
    </li>
  );
}

/**
 * What the agent did for a turn, drawn above its answer: an ordered list of
 * the work, one row per tool entry as it starts, finishing in place, with the
 * model's reasoning closed between rows. The header is live while the turn
 * runs and says how long it took and how many steps once it ends. The list is
 * open while the agent works and nothing has been said yet, and closed once
 * the answer arrives or the turn ends, unless the person opened or closed it,
 * or the job kept going after it first settled (a chase: the send, then the
 * reply and the follow-up), which stays open so what it did after the send is
 * in view.
 */
export function Trail({
  turn,
  now,
  answering = false,
}: {
  turn: TranscriptTurn;
  now: number;
  /** Whether the answer is being drawn beneath. */
  answering?: boolean;
}) {
  const running = RUNNING.includes(turn.status);
  const dones = turn.trail.filter(
    (s): s is Extract<TrailStep, { type: 'done' }> => s.type === 'done',
  );
  const doneStep = running ? undefined : dones.at(-1);
  const continued =
    turn.trail.findIndex((s) => s.type === 'done') < turn.trail.length - 1 && dones.length > 0;
  const [open, setOpen] = useState<boolean | null>(null);
  const stepsId = useId();
  const steps = turn.trail.filter((s) => s.type !== 'done');
  if (turn.trail.length === 0 && !running) return null;
  const tools = steps.flatMap((step) => {
    const tool = toolOf(step);
    return tool ? [tool] : [];
  });
  const hasRows = tools.length > 0;
  const expandable = steps.length > 0;
  const expanded = expandable && (open ?? (running ? !answering : continued));
  const elapsed = doneStep
    ? Math.max(1, Math.round(doneStep.elapsed_ms / 1000))
    : Math.max(0, Math.round((now - new Date(turn.turn.created_at).getTime()) / 1000));
  const failures = tools.filter((tool) => tool.status === 'failed').length;
  const rest = doneStep
    ? [
        tools.length ? `${tools.length} step${tools.length === 1 ? '' : 's'}` : '',
        failures ? `${failures} didn’t work` : '',
        !hasRows && doneStep.source_count
          ? `${doneStep.source_count} source${doneStep.source_count === 1 ? '' : 's'}`
          : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const underWay = [...tools].reverse().find((tool) => tool.status === 'running');
  const currentTitle = turn.live?.title ?? underWay?.title;
  const head = running ? (
    <>
      <span className="working-dots" aria-hidden="true">
        <span className="pulse" />
        <span className="pulse" style={{ animationDelay: '.2s' }} />
        <span className="pulse" style={{ animationDelay: '.4s' }} />
      </span>
      <span>{turn.status === 'paused' ? `Paused · ${elapsed}s` : `Working · ${elapsed}s`}</span>
      {!expanded && currentTitle ? (
        <span className="clamp1" style={{ color: 'var(--muted)', fontWeight: 400 }}>
          · {currentTitle}
        </span>
      ) : null}
    </>
  ) : (
    <>
      {turn.status === 'stopped' ? (
        <span>Stopped after {elapsed}s</span>
      ) : turn.status === 'needs_you' ? (
        <span>Waiting for you · {elapsed}s</span>
      ) : turn.status === 'failed' ? (
        <span>Stopped without finishing</span>
      ) : (
        <span>Worked for {elapsed}s</span>
      )}
      {rest ? (
        <span className="clamp1" style={{ color: 'var(--muted)', fontWeight: 400 }}>
          · {rest}
        </span>
      ) : null}
    </>
  );
  const last = steps.at(-1);
  // A running row or reasoning being written already shows the work under way.
  const showsWork =
    underWay !== undefined || (last?.type === 'reasoning' && running) || turn.status === 'paused';
  return (
    <div className="col trail" style={{ gap: 4 }}>
      {expandable ? (
        <button
          type="button"
          className="trail-head"
          aria-expanded={expanded}
          aria-controls={stepsId}
          onClick={() => setOpen(!expanded)}
        >
          <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} />
          {head}
        </button>
      ) : (
        <div className="trail-head" data-static="true">
          {head}
        </div>
      )}
      {expanded ? (
        <ol className="trail-steps act-list" id={stepsId} aria-label="What it did">
          {steps.map((step, index) => {
            const key =
              step.type === 'action' && step.tool ? step.tool.id : `${step.type}-${index}`;
            if (step.type === 'reasoning')
              return (
                <ThinkingBlock
                  key={key}
                  text={step.text}
                  live={running && index === steps.length - 1}
                />
              );
            if (step.type === 'say')
              return (
                <li key={key} className="trail-say">
                  {step.text}
                </li>
              );
            if (step.type === 'note')
              return (
                <li key={key} className="trail-row" data-note="true">
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
                </li>
              );
            if (step.type !== 'action') return null;
            const tool = toolOf(step);
            if (tool) return <ActivityRow key={key} tool={tool} now={now} live={running} />;
            return <GroupStep key={key} step={step} chipsOnly={hasRows} />;
          })}
          {running && !showsWork ? (
            <li className="trail-row">
              <span className="trail-icon">
                <span style={{ color: 'var(--primary)', display: 'flex' }}>
                  <Icon name="loader" size={14} stroke={2} className="spin" />
                </span>
              </span>
              <span style={{ flex: 1, fontSize: 13, color: 'var(--text)' }}>
                {turn.live?.title ?? 'Still working'}
              </span>
            </li>
          ) : null}
          {turn.status === 'paused' ? (
            <li className="trail-row">
              <span className="trail-icon">
                <Icon name="clock" size={14} />
              </span>
              <span style={{ flex: 1, fontSize: 13, color: 'var(--text)' }}>Paused</span>
            </li>
          ) : null}
        </ol>
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

/* ---------- saved file ---------- */

/**
 * A file the agent saved: a text file opens here, in a dialog that reads it
 * from the service; anything else downloads.
 */
function SavedFileAction({
  id,
  name,
  label,
  view,
  primary,
  size,
  touch,
}: {
  id: string;
  name: string;
  label: string;
  view: boolean;
  primary: boolean;
  size: 'sm' | 'xl';
  touch: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const href = adapter.artifactUrl(id);
  if (!view)
    return (
      <a className={`btn btn-${size} btn-${primary ? 'primary' : 'outline'}`} href={href} download>
        {label}
      </a>
    );
  const show = async () => {
    setOpen(true);
    setError(null);
    const result = await adapter.artifactText(id);
    if (result.data !== null) setShown(result.data);
    else setError(result.error ?? result.unavailable ?? 'Couldn’t open this file.');
  };
  return (
    <>
      <Button
        size={size}
        variant={primary ? undefined : 'outline'}
        block={touch}
        onClick={() => void show()}
      >
        {label}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={name}
        width={720}
        footer={
          <>
            <a className="btn btn-md btn-outline" href={href} download>
              Download
            </a>
            <Button onClick={() => setOpen(false)}>Close</Button>
          </>
        }
      >
        {error ? (
          <p role="alert" className="permission-why">
            {error}
          </p>
        ) : shown === null ? (
          <p className="permission-why">Opening…</p>
        ) : (
          <>
            <pre className="permission-file-text">{shown.text || 'This file is empty.'}</pre>
            {shown.truncated ? (
              <p className="permission-why">
                This shows the first {OPEN_TEXT_LIMIT_BYTES / 1024} KB. Download to see all of it.
              </p>
            ) : null}
          </>
        )}
      </Dialog>
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
    if ((a.kind === 'open' || a.kind === 'download') && !a.url && a.handle.startsWith('art_'))
      return (
        <SavedFileAction
          key={a.handle}
          id={a.handle}
          name={card.title}
          label={a.label}
          view={a.kind === 'open'}
          primary={primary}
          size={size}
          touch={touch}
        />
      );
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
              <h3
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  lineHeight: '22px',
                  color: 'var(--heading)',
                  overflowWrap: 'anywhere',
                }}
              >
                {plainTitle(card.title)}
              </h3>
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

/* ---------- why an action was taken ---------- */

/**
 * "Because: …" under a receipt or a permission card, linking each belief the
 * action relied on to its place in Memory. Only beliefs the agent named and
 * rules the person set are listed: what memory merely offered the turn is not
 * a reason, so it is left out rather than shown as one.
 */
export function BecauseLine({ because }: { because?: BecauseLink[] }) {
  const cited = (because ?? []).filter((link) => link.basis !== 'recalled');
  if (!cited.length) return null;
  return (
    <span className="because">
      <span>Because:</span>
      {cited.map((link) => (
        <a
          key={`${link.kind}:${link.id}`}
          href={href(
            link.kind === 'belief' ? `/settings/memory?belief=${link.id}` : '/settings/rules',
          )}
        >
          {link.label}
        </a>
      ))}
    </span>
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
      <span className="grow col" style={{ gap: 2, minWidth: 0 }}>
        <span
          style={{
            fontSize: 13,
            color: 'var(--text)',
            textDecoration: reversed ? 'line-through' : undefined,
          }}
        >
          {receipt.what}{' '}
          <span style={{ color: 'var(--muted)' }}>
            · {timeOf(receipt.when)} · {receipt.where}
          </span>
        </span>
        {receipt.review ? <ReviewNote review={receipt.review} /> : null}
        <BecauseLine because={receipt.because} />
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

/** A sentence as the tail of another one: "approved because it only reads." */
const asClause = (text: string) =>
  /^[A-Z][a-z]/.test(text) ? `${text[0]?.toLowerCase()}${text.slice(1)}` : text;

/** What auto-review decided, on the receipt of what it let through or the card it sent on. */
export function ReviewNote({ review }: { review: ActionReview }) {
  const approved = review.outcome === 'auto_approved';
  return (
    <span className="review-note" data-outcome={review.outcome}>
      <Icon name={approved ? 'check' : 'info'} size={12} stroke={2.5} />
      <span>
        <strong>{approved ? 'Auto-reviewed:' : 'Escalated:'}</strong>{' '}
        {approved ? `approved because ${asClause(review.reason)}` : review.reason}
      </span>
    </span>
  );
}

/* ---------- permission ---------- */

const DAYS = [1, 7, 14, 30] as const;

/** How much of a proposed file shows before "Show all". */
const FILE_PREVIEW_LINES = 12;
const FILE_PREVIEW_CHARS = 1200;

/**
 * The exact text a file write would save, so it is never approved unseen. It
 * is shown as written, not rendered: what is reviewed is what lands on disk.
 */
export function FilePreview({ file }: { file: NonNullable<Permission['file']> }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const lines = file.content.split('\n');
  const long = lines.length > FILE_PREVIEW_LINES || file.content.length > FILE_PREVIEW_CHARS;
  const shown =
    long && !open
      ? `${lines.slice(0, FILE_PREVIEW_LINES).join('\n').slice(0, FILE_PREVIEW_CHARS).trimEnd()}\n…`
      : file.content;
  return (
    <div className="permission-file">
      <pre id={id} className="permission-file-text">
        {file.content ? shown : 'This file is empty.'}
      </pre>
      {file.truncated && (open || !long) ? (
        <span className="permission-caption">
          Showing the first {file.content.length.toLocaleString()} characters of{' '}
          {file.bytes.toLocaleString()} bytes.
        </span>
      ) : null}
      {long ? (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Show less' : 'Show all'}
        </Button>
      ) : null}
    </div>
  );
}

/** What a decided permission card says it came to; null while it waits. */
export function permissionOutcome(
  decided: PermissionOption | 'replaced' | 'withdrawn' | 'closed' | null,
): string | null {
  return decided === 'allow_once'
    ? 'Allowed once'
    : decided === 'always'
      ? 'Always allowed'
      : decided === 'deny'
        ? 'Denied'
        : decided === 'replaced'
          ? 'Replaced by your new message'
          : decided === 'withdrawn'
            ? 'Withdrawn when you stopped'
            : decided === 'closed'
              ? 'Decided'
              : null;
}

/** The tile at the head of a permission card: a lock while it waits, then what came of it. */
export function permissionTile(
  decided: PermissionOption | 'replaced' | 'withdrawn' | 'closed' | null,
): { icon: IconName; outcome: 'pending' | 'allowed' | 'denied' | 'withdrawn' | 'decided' } {
  if (decided === null) return { icon: 'lock', outcome: 'pending' };
  if (decided === 'allow_once' || decided === 'always')
    return { icon: 'check', outcome: 'allowed' };
  if (decided === 'deny') return { icon: 'x', outcome: 'denied' };
  if (decided === 'replaced' || decided === 'withdrawn')
    return { icon: 'clock', outcome: 'withdrawn' };
  return { icon: 'circleCheck', outcome: 'decided' };
}

export function PermissionCard({
  permission,
  decided,
  onDecide,
  touch = false,
  bare = false,
  busy = false,
}: {
  permission: Permission;
  decided: PermissionOption | 'replaced' | 'withdrawn' | 'closed' | null;
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
  const outcome = permissionOutcome(decided);
  const tile = permissionTile(decided);
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
  // "Label: value" lines are fields; any other reason ("For your request.") reads as a sentence.
  const reasons = permission.why.slice(1);
  const notes = reasons.filter((line) => !line.includes(': '));
  const fields = reasons
    .filter((line) => line.includes(': '))
    .map((line) => {
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
        <span className="permission-lock" data-outcome={tile.outcome}>
          <Icon name={tile.icon} size={16} stroke={tile.outcome === 'denied' ? 2.25 : undefined} />
        </span>
        <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
          <span className="permission-what">{permission.what}</span>
          {/* Once decided the card is its head and the outcome: the request's
              reasons were for the decision, which has been made. */}
          {pending ? (
            <>
              <span className="permission-why">{permission.why[0]}</span>
              {notes.map((note) => (
                <span key={note} className="permission-why">
                  {note}
                </span>
              ))}
            </>
          ) : null}
          <BecauseLine because={permission.because} />
        </div>
        {outcome ? (
          <Status tone={tile.outcome === 'allowed' ? 'settled' : 'kind'}>{outcome}</Status>
        ) : null}
      </div>
      {pending ? (
        <div className="permission-body">
          {permission.review ? <ReviewNote review={permission.review} /> : null}
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
          {permission.file ? <FilePreview file={permission.file} /> : null}
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
  if (typeof payload.summary === 'string' && payload.summary) return `“${payload.summary}”`;
  const kind = typeof action.kind === 'string' ? action.kind : '';
  const path = typeof payload.path === 'string' ? payload.path : null;
  if (path && /^files\./.test(kind)) return `saving “${plainTitle(path.split('/').pop() ?? path)}”`;
  if (typeof payload.command === 'string' || /^(?:exec|sandbox|device)\./.test(kind))
    return 'a command on its computer';
  return 'one step of this task';
}

/** Whether a step that went unconfirmed was a message to someone, which "arrives". */
const isMessage = (action: LedgerAction): boolean => {
  const to = (action.canonical_payload as Record<string, unknown>).to;
  return (Array.isArray(to) && to.length > 0) || (typeof to === 'string' && to.length > 0);
};

/** What "It did not" leads to: the effect is open to another attempt. */
export const RETRY_HINT = 'Melete may try again, and asks you first.';

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
  const retryHint = useId();
  const message = isMessage(action);
  const yes = message ? 'It arrived' : 'It worked';
  const no = message ? 'It did not' : 'It didn’t';
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
            {message
              ? 'I sent this once and never heard back.'
              : 'I tried this once and couldn’t confirm it finished.'}
          </span>
          <span style={{ fontSize: 13, color: 'var(--secondary)' }}>
            {message
              ? 'It may or may not have arrived. I have not sent it again.'
              : 'I haven’t tried it again.'}{' '}
            What I tried: {describeAction(action)}.
          </span>
          {settled === 'failed' ? (
            <span style={{ fontSize: 13, color: 'var(--secondary)' }}>{RETRY_HINT}</span>
          ) : null}
        </div>
        {settled ? (
          <Badge tone={settled === 'succeeded' ? 'success' : 'neutral'}>
            {settled === 'succeeded' ? yes : no}
          </Badge>
        ) : unsure ? (
          <Badge tone="neutral">Still unsure</Badge>
        ) : null}
      </div>
      {!settled ? (
        <div className="card-actions">
          <Button size="sm" onClick={() => onResolve('succeeded')}>
            {yes}
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-describedby={retryHint}
            onClick={() => onResolve('failed')}
          >
            {no}
          </Button>
          {unsure ? null : (
            <Button size="sm" variant="ghost" onClick={() => onResolve('unresolved')}>
              I can’t tell yet
            </Button>
          )}
          <span id={retryHint} style={{ fontSize: 12, color: 'var(--muted)' }}>
            If {message ? 'it did not' : 'it didn’t'}, Melete may try again, and asks you first.
          </span>
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
