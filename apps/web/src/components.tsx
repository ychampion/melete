/**
 * The small set of pieces every screen reuses. A state chip, a payload table, a
 * modal dialog, and the five sentences a waiting job is allowed to say.
 */
import type { ActionStatus, JobState, JobWait } from '@melete/client';
import { type ReactNode, useEffect, useRef } from 'react';

const JOB_STATE_TONE: Record<JobState, string> = {
  queued: 'chip-neutral',
  running: 'chip-running',
  waiting_for_input: 'chip-waiting',
  waiting_for_approval: 'chip-waiting',
  waiting_for_event_or_time: 'chip-waiting',
  needs_reconciliation: 'chip-bad',
  completed: 'chip-good',
  failed: 'chip-bad',
  cancelled: 'chip-neutral',
};

const JOB_STATE_LABEL: Record<JobState, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting_for_input: 'Waiting for you',
  waiting_for_approval: 'Waiting for approval',
  waiting_for_event_or_time: 'Waiting for an event',
  needs_reconciliation: 'Needs reconciliation',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * What a job that is not moving should say to a person, in words that name the
 * thing they have to do. These five sentences are the whole vocabulary of
 * waiting, and docs/CLIENT.md repeats them so the product interface matches.
 */
export const WAITING_SENTENCE: Record<string, string> = {
  waiting_for_input: 'I need one answer from you before I can go on.',
  waiting_for_approval: 'I have something to send. Read it and decide.',
  waiting_for_event_or_time: 'Nothing to do until something happens. I am watching for it.',
  needs_reconciliation: 'I cannot tell whether one action happened. Tell me what you find.',
  failed: 'I stopped without finishing. Here is how far I got.',
};

const ACTION_TONE: Record<ActionStatus, string> = {
  proposed: 'chip-neutral',
  needs_approval: 'chip-waiting',
  approved: 'chip-running',
  denied: 'chip-neutral',
  admitted: 'chip-running',
  dispatched: 'chip-running',
  succeeded: 'chip-good',
  failed: 'chip-bad',
  unknown: 'chip-bad',
  unresolved: 'chip-bad',
};

export function JobChip({ state }: { state: JobState }) {
  return <span className={`chip ${JOB_STATE_TONE[state]}`}>{JOB_STATE_LABEL[state]}</span>;
}

export function ActionChip({ status }: { status: ActionStatus }) {
  return <span className={`chip ${ACTION_TONE[status]}`}>{status.replace(/_/g, ' ')}</span>;
}

export function waitingDetail(wait: JobWait): string | null {
  if (wait.kind === 'user_input') return wait.question;
  if (wait.kind === 'approval') return `${wait.action_ids.length} action awaiting your decision`;
  if (wait.kind === 'timer') return `Waking at ${formatTime(wait.wake_at)}`;
  if (wait.kind === 'event') return 'Waiting for a trigger to fire';
  return null;
}

export const formatTime = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

/**
 * Render a canonical payload as a table of its own fields. Nothing here reads
 * model text: the record is the interface, and the screen is downstream of it.
 */
export function PayloadTable({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload).sort(([a], [b]) => a.localeCompare(b));
  return (
    <dl className="payload">
      {entries.map(([key, value]) => (
        <div key={key} style={{ display: 'contents' }}>
          <dt>{key}</dt>
          <dd>{renderValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

const renderValue = (value: unknown): string => {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.map((item) => renderValue(item)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
};

export function PayloadHash({ hash }: { hash: string }) {
  return (
    <p className="hash">
      <span>Payload hash</span>
      <code className="mono">{hash}</code>
    </p>
  );
}

/**
 * A native dialog, so focus trapping, Escape, and the backdrop are the
 * browser's job rather than a home-made keyboard trap that gets it wrong.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={ref} onClose={onClose} aria-label={title}>
      <div className="dialog-body">
        <h2>{title}</h2>
        {children}
      </div>
    </dialog>
  );
}

export function Banner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="banner" role="alert">
      {message}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
