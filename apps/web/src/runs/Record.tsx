/**
 * The full record of long work, oldest first: what it planned, found, tried,
 * decided and reported, each under a plain label. Tries show their value and
 * whether the value was confirmed from the output it came from.
 */
import { Icon } from '../design/icons.tsx';
import { Button } from '../design/primitives.tsx';
import type { RunEntry } from '../experience/types.ts';
import { formatValue, recordLabel } from './words.ts';

const OUTCOME: Record<string, string> = {
  kept: 'Kept',
  discarded: 'Set aside',
  failed: 'Didn’t work out',
};

const stamp = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

function Facts({ entry }: { entry: RunEntry }) {
  const data = entry.data;
  if (entry.kind === 'experiment') {
    const value = typeof data.value === 'number' ? formatValue(data.value) : null;
    const outcome = typeof data.outcome === 'string' ? OUTCOME[data.outcome] : undefined;
    if (!value && !outcome && data.checked !== true) return null;
    return (
      <span className="run-entry-facts">
        {value ? <span className="tabular run-entry-value">{value}</span> : null}
        {outcome ? <span>{outcome}</span> : null}
        {data.checked === true ? (
          <span className="run-checked">
            <Icon name="circleCheck" size={12} />
            confirmed from its output
          </span>
        ) : null}
      </span>
    );
  }
  if (entry.kind === 'checkpoint' && typeof data.next === 'string' && data.next)
    return <span className="run-entry-facts">Next: {data.next}</span>;
  return null;
}

export function RecordTimeline({
  entries,
  helpers,
  more,
  loading,
  onMore,
}: {
  entries: RunEntry[];
  /** Helper titles by id, to say which helper wrote an entry. */
  helpers: Map<string, string>;
  more: boolean;
  loading: boolean;
  onMore: () => void;
}) {
  if (entries.length === 0 && !more)
    return <p className="run-muted">{loading ? 'Loading…' : 'Nothing recorded yet.'}</p>;
  return (
    <div className="col" style={{ gap: 12 }}>
      <ol className="run-record">
        {entries.map((entry) => {
          // A helper's own start and finish already name it in the title.
          const own = entry.kind === 'step_started' || entry.kind === 'step_finished';
          const helper = entry.step_id && !own ? helpers.get(entry.step_id) : undefined;
          return (
            <li key={entry.id} className="run-entry" data-kind={entry.kind}>
              <span className="run-entry-dot" aria-hidden="true" />
              <div className="col" style={{ gap: 4, minWidth: 0 }}>
                <div className="run-entry-head">
                  <span className="run-entry-label">{recordLabel(entry)}</span>
                  <time className="run-entry-time" dateTime={entry.created_at}>
                    {stamp(entry.created_at)}
                  </time>
                </div>
                <span className="run-entry-title">{entry.title}</span>
                {helper ? <span className="run-entry-by">From the helper “{helper}”</span> : null}
                {entry.body ? <p className="run-entry-body">{entry.body}</p> : null}
                <Facts entry={entry} />
              </div>
            </li>
          );
        })}
      </ol>
      {more ? (
        <div>
          <Button size="sm" variant="outline" loading={loading} disabled={loading} onClick={onMore}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
