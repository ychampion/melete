/**
 * The ledger: one row per thing a company owes you, takes from you, or told
 * you it would do. A row says what it is in plain words, what it is worth and
 * when it falls due; opening it shows the sentence in the message that put it
 * there, and the three things a person can do about it.
 */
import { Icon } from '../design/icons.tsx';
import { Button, CompanyTile, Skeleton, Status } from '../design/primitives.tsx';
import type {
  Company,
  Confidence,
  LedgerDetail,
  LedgerItem,
  ScanProgress,
} from '../experience/types.ts';
import { MessageCard } from './evidence.tsx';
import {
  amountWords,
  dayOf,
  isOverdue,
  KIND_WORDS,
  money,
  STATUS_WORDS,
  whenDue,
} from './format.ts';

const CONFIDENCE_WORDS: Record<Confidence, string> = {
  high: 'Read with high confidence',
  medium: 'Read with medium confidence',
  low: 'Read with low confidence',
};

function StatusChip({ item, now }: { item: LedgerItem; now: number }) {
  if (item.status === 'settled') return <Status tone="settled">Settled</Status>;
  if (item.status === 'dropped') return <Status tone="kind">Not this</Status>;
  if (item.status === 'handling' || item.status === 'waiting')
    return <Status tone="working">{STATUS_WORDS[item.status]}</Status>;
  // A promise past its date has lapsed; money past its date is overdue.
  if (isOverdue(item, now))
    return <Status tone="late">{item.kind === 'promise' ? 'Lapsed' : 'Overdue'}</Status>;
  return <Status tone="kind">{KIND_WORDS[item.kind]}</Status>;
}

/** Confidence, said quietly: a mark a person can hover, and a sentence in the detail. */
function ConfidenceMark({ level }: { level: Confidence }) {
  return (
    <span className="confidence" data-level={level} title={CONFIDENCE_WORDS[level]}>
      <span className="sr-only">{CONFIDENCE_WORDS[level]}</span>
    </span>
  );
}

export function LedgerRow({
  item,
  company,
  now,
  open,
  showCompany = true,
  onToggle,
}: {
  item: LedgerItem;
  company: Company | undefined;
  now: number;
  open: boolean;
  showCompany?: boolean;
  onToggle: () => void;
}) {
  const amount = amountWords(item);
  const faded = item.status === 'settled' || item.status === 'dropped';
  const late = !faded && isOverdue(item, now);
  return (
    <button
      type="button"
      className="ledger-row"
      data-open={open ? 'true' : undefined}
      data-faded={faded ? 'true' : undefined}
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className="ledger-caret">
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
      </span>
      <span className="ledger-what">
        {showCompany ? (
          <>
            <span className="ledger-company">{company?.name ?? 'A company'}</span>
            <span className="ledger-sep" aria-hidden="true">
              {' · '}
            </span>
          </>
        ) : null}
        <span className="ledger-summary">{item.summary}</span>
      </span>
      <span className="ledger-amount" data-direction={item.direction}>
        {amount ? (
          <>
            <span className="ledger-figure">{amount.figure}</span>
            {amount.direction ? <span className="ledger-direction">{amount.direction}</span> : null}
          </>
        ) : (
          <span className="ledger-direction">—</span>
        )}
      </span>
      <span className="ledger-due" data-late={late ? 'true' : undefined}>
        {item.due_at ? (
          <>
            <span className="ledger-day">{dayOf(item.due_at)}</span>
            <span className="ledger-direction ledger-when">{whenDue(item.due_at, now)}</span>
          </>
        ) : (
          <span className="ledger-direction">no date</span>
        )}
      </span>
      <span className="ledger-status">
        <StatusChip item={item} now={now} />
        <ConfidenceMark level={item.confidence} />
      </span>
    </button>
  );
}

export function LedgerDetailPanel({
  detail,
  busy,
  onHandle,
  onSettled,
  onDrop,
}: {
  detail: LedgerDetail | null;
  busy: boolean;
  onHandle: () => void;
  onSettled: () => void;
  onDrop: () => void;
}) {
  if (!detail)
    return (
      <div className="ledger-detail">
        <Skeleton width="60%" height={14} />
        <Skeleton width="100%" height={110} />
      </div>
    );
  const { item, company, message } = detail;
  const spans = message ? item.evidence.filter((span) => span.message_id === message.id) : [];
  const done = item.status === 'settled' || item.status === 'dropped';
  return (
    <div className="ledger-detail">
      <div className="ledger-detail-head">
        <span className="ledger-detail-summary">{item.summary}</span>
        <span className="ledger-detail-meta">
          {company.name} · {company.domain} · {CONFIDENCE_WORDS[item.confidence].toLowerCase()}
        </span>
      </div>
      {message ? (
        <MessageCard message={message} spans={spans} />
      ) : (
        // A figure is only ever shown with the sentence it came from, so when the
        // message is no longer held there is nothing to open. Saying so is
        // better than drawing the quote on its own, which would look like
        // evidence while no longer being checkable against anything.
        <p className="ledger-detail-gone">
          The message this came from is no longer on this machine.
        </p>
      )}
      <div className="ledger-actions">
        {item.job_id ? (
          <Button icon="arrowUpRight" className="btn-card" onClick={onHandle}>
            Open the job
          </Button>
        ) : (
          <Button icon="send" className="btn-card" disabled={busy || done} onClick={onHandle}>
            Handle it
          </Button>
        )}
        <Button variant="outline" className="btn-card" disabled={busy || done} onClick={onSettled}>
          Settled
        </Button>
        <Button variant="ghost" className="btn-card" disabled={busy || done} onClick={onDrop}>
          Not this
        </Button>
      </div>
    </div>
  );
}

export function CompanyHeader({
  company,
  items,
  currency,
}: {
  company: Company;
  items: LedgerItem[];
  currency: string;
}) {
  const owed = items
    .filter((item) => item.direction === 'owed_to_you' && item.status !== 'dropped')
    .reduce((sum, item) => sum + (item.amount_minor ?? 0), 0);
  return (
    <div className="ledger-group">
      <CompanyTile id={company.id} name={company.name} size={24} />
      <span className="ledger-group-name">{company.name}</span>
      <span className="ledger-group-meta">
        {company.monthly_spend_minor
          ? `${money(company.monthly_spend_minor, company.currency ?? currency)} a month`
          : `${company.message_count} messages`}
      </span>
      {owed > 0 ? (
        <span className="ledger-group-owed">{money(owed, currency)} owed to you</span>
      ) : null}
    </div>
  );
}

/** Nothing found yet: what will appear here, and the one thing to press. */
export function EmptyLedger({
  scanning,
  progress,
  error,
  onScan,
}: {
  scanning: boolean;
  progress: ScanProgress | null;
  error: string | null;
  onScan: () => void;
}) {
  const share =
    progress && progress.messages_seen > 0
      ? Math.min(1, progress.messages_seen / Math.max(progress.messages_seen + 400, 1))
      : 0;
  return (
    <div className="ledger-empty">
      <span className="ledger-empty-title">No companies found yet</span>
      <p className="ledger-empty-body">
        Connect a mailbox and Melete reads it: what each company takes every month, what it owes
        back, what renews next, whose price went up, whose trial ends this week, and who is holding
        data. Every figure opens the sentence in the email it came from.
      </p>
      {scanning ? (
        <div className="scan" role="status">
          <div className="scan-bar">
            <span style={{ width: `${Math.round(share * 100)}%` }} />
          </div>
          <span className="scan-words">
            {progress
              ? `${progress.messages_seen.toLocaleString('en-GB')} messages read · ${
                  progress.items_found
                } found so far`
              : 'Starting'}
          </span>
        </div>
      ) : (
        <Button icon="search" onClick={onScan}>
          Scan the inbox
        </Button>
      )}
      {error ? <span className="ledger-empty-error">{error}</span> : null}
    </div>
  );
}
