/**
 * The plain words for long work. The service names the parts of its record
 * for itself; a person reads them here as Plan, Found, Tried, Update and so
 * on, and reads where the work stands as one short status.
 */
import type { StatusTone } from '../design/primitives.tsx';
import type { Run, RunEntry, RunStatus } from '../experience/types.ts';

/** What each part of the record is called on screen. */
export const RECORD_LABEL: Record<RunEntry['kind'], string> = {
  plan: 'Plan',
  note: 'Note',
  finding: 'Found',
  decision: 'Decided',
  experiment: 'Tried',
  report: 'Update',
  checkpoint: 'Progress saved',
  step_started: 'Helper started',
  step_finished: 'Helper finished',
  finished: 'Done',
};

export const recordLabel = (entry: Pick<RunEntry, 'kind'>): string =>
  RECORD_LABEL[entry.kind] ?? 'Note';

/** Paused work rests as waiting; its line is the only place that says so. */
export const isPaused = (run: Pick<Run, 'status' | 'status_line'>): boolean =>
  run.status === 'waiting' && /^Paused\b/.test(run.status_line);

export const isFinished = (status: RunStatus): boolean =>
  status === 'done' || status === 'stopped' || status === 'failed';

/** Work still going, or held for the person: what Home and a chat keep in view. */
export const isOpen = (status: RunStatus): boolean => !isFinished(status);

/** The detail page follows work that is moving on its own. */
export const keepsMoving = (status: RunStatus): boolean =>
  status === 'working' || status === 'waiting';

export function statusOf(run: Pick<Run, 'status' | 'status_line'>): {
  word: string;
  tone: StatusTone;
} {
  if (isPaused(run)) return { word: 'Paused', tone: 'waiting' };
  switch (run.status) {
    case 'working':
      return { word: 'Working', tone: 'working' };
    case 'waiting':
      return { word: 'Resting', tone: 'waiting' };
    case 'needs_you':
      return { word: 'Needs you', tone: 'needs' };
    case 'done':
      return { word: 'Done', tone: 'settled' };
    case 'stopped':
      return { word: 'Stopped', tone: 'waiting' };
    default:
      return { word: 'Couldn’t go on', tone: 'late' };
  }
}

/** A helper's state in a word. */
export function helperWord(status: RunStatus): string {
  return statusOf({ status, status_line: '' }).word;
}

/** The newest moment the work showed anything: an update, a try, or its end. */
export function lastActivity(run: Run): string {
  const moments = [
    run.started_at,
    run.latest_report?.created_at,
    run.experiments.best?.created_at,
    ...run.experiments.recent.map((item) => item.created_at),
    run.finished_at,
  ].filter((value): value is string => typeof value === 'string');
  return moments.reduce((latest, value) => (value > latest ? value : latest));
}

/** "just now", "12 min ago", "3 hr ago", "2 days ago". */
export function ago(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** A measured value as a person reads it: no float noise, no trailing zeros. */
export function formatValue(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  return Number(value.toPrecision(4)).toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/** "41 tries · best accuracy 0.873", or null when nothing was tried. */
export function triesLine(run: Pick<Run, 'experiments' | 'metric'>): string | null {
  const { count, best } = run.experiments;
  if (count === 0) return null;
  const tries = `${count} ${count === 1 ? 'try' : 'tries'}`;
  if (!best || best.value === null) return tries;
  return `${tries} · best ${run.metric ? `${run.metric.name} ` : ''}${formatValue(best.value)}`;
}

/** The start of a longer text, cut at a word. */
export function excerpt(text: string, limit = 160): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, '')}…`;
}

/** A later page of the record joins the end; an entry already shown is not shown twice. */
export function appendEntries(shown: RunEntry[], page: RunEntry[]): RunEntry[] {
  const seen = new Set(shown.map((entry) => entry.id));
  return [...shown, ...page.filter((entry) => !seen.has(entry.id))];
}

/** Open work first, the one that needs the person ahead of the rest, then the newest. */
export function workOrder(runs: Run[]): Run[] {
  const rank = (run: Run) => (run.status === 'needs_you' ? 0 : isOpen(run.status) ? 1 : 2);
  return [...runs].sort(
    (a, b) => rank(a) - rank(b) || lastActivity(b).localeCompare(lastActivity(a)),
  );
}

/** A file name for the downloaded record. */
export function recordFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'work'}-record.md`;
}

/** Hours from a limit field; anything that is not a positive number clears it. */
export function hoursFrom(text: string): number | null {
  const value = Number(text.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}
