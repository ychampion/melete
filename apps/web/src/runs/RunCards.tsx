/**
 * Long work where the person already is: a compact card in the chat that
 * started it, and a short "In progress" list on Home. Each links to the work's
 * own page. Neither is drawn when there is nothing to show.
 */
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { Status } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import type { Run } from '../experience/types.ts';
import { href } from '../router.ts';
import { usePoll } from './poll.ts';
import { RunPermissions } from './RunPermissions.tsx';
import { ago, excerpt, isOpen, lastActivity, standingLine, statusOf, workOrder } from './words.ts';
import './runs.css';

/**
 * Read a list of work, keeping what was last read when a refresh fails.
 * `null` reads nothing: a chat that does not exist yet started no work.
 */
function useRuns(conversationId: string | null | undefined, refresh: unknown) {
  const [runs, setRuns] = useState<Run[]>([]);
  const read = useCallback(() => {
    if (conversationId === null) return;
    void adapter.runs(conversationId).then((result) => {
      if (result.data) setRuns(result.data.runs);
      else if (result.unavailable !== null) setRuns([]);
    });
  }, [conversationId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` is a nudge to read again
  useEffect(read, [read, refresh]);
  usePoll(
    read,
    30_000,
    runs.some((run) => isOpen(run.status)),
  );
  return { runs, read };
}

export function RunChatCards({
  conversationId,
  refresh,
}: {
  conversationId: string | null;
  /** Changes when the conversation settles, so new work shows without waiting. */
  refresh: unknown;
}) {
  const { runs, read } = useRuns(conversationId, refresh);
  if (!conversationId || runs.length === 0) return null;
  return (
    <div className="col" style={{ gap: 8 }}>
      {workOrder(runs).map((run) => {
        const status = statusOf(run);
        const update = run.result ?? run.latest_report?.body ?? null;
        return (
          <div key={run.id} className="run-chat-item">
            <a
              className="run-chat-card"
              href={href(`/runs/${run.id}`)}
              data-needs={run.status === 'needs_you' ? 'true' : undefined}
            >
              <span className="run-chat-icon" aria-hidden="true">
                <Icon name="progress" size={18} />
              </span>
              <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                <span className="run-chat-top">
                  <span className="run-chat-kicker">In the background</span>
                  <Status tone={status.tone} quiet>
                    {status.word}
                  </Status>
                </span>
                <span className="run-chat-title">{run.title}</span>
                <span className="run-chat-line">{run.status_line}</span>
                {run.standing ? <span className="run-card-repeat">{standingLine(run)}</span> : null}
                {update ? <span className="run-chat-update clamp2">{excerpt(update)}</span> : null}
              </span>
              <Icon name="chevronRight" size={16} style={{ color: 'var(--muted)' }} />
            </a>
            {/* What it waits for the person's OK on is answered here, in the chat. */}
            <RunPermissions run={run} compact onDecided={read} />
          </div>
        );
      })}
    </div>
  );
}

export function InProgress({ now }: { now: number }) {
  const { runs } = useRuns(undefined, null);
  const open = workOrder(runs.filter((run) => isOpen(run.status))).slice(0, 3);
  if (open.length === 0) return null;
  return (
    <section className="home-section" aria-labelledby="home-progress">
      <div className="home-section-head">
        <h2 id="home-progress">In progress</h2>
        <a className="section-link" href={href('/runs')}>
          All work
          <Icon name="chevronRight" size={14} />
        </a>
      </div>
      <div className="motion">
        {open.map((run) => {
          const status = statusOf(run);
          return (
            <a key={run.id} className="motion-row" href={href(`/runs/${run.id}`)}>
              <span className="run-home-icon" data-tone={status.tone} aria-hidden="true">
                <Icon name="progress" size={16} />
              </span>
              <span className="col grow" style={{ gap: 1, minWidth: 0 }}>
                <span className="clamp1 motion-title">{run.title}</span>
                <span className="clamp1 motion-line">
                  {run.status === 'needs_you' ? `Needs you · ${run.status_line}` : run.status_line}
                </span>
              </span>
              <span className="motion-when run-when">{ago(lastActivity(run), now)}</span>
            </a>
          );
        })}
      </div>
    </section>
  );
}
