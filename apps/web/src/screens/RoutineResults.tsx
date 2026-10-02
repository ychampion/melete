/**
 * What the person's routines did in the last day, on Home: each routine's
 * newest run, what it said or why it did not finish, and a link to the
 * thread that holds the whole answer.
 */
import { Icon } from '../design/icons.tsx';
import { plainRunReason } from '../experience/plain.ts';
import type { Home } from '../experience/types.ts';
import { href } from '../router.ts';

type RoutineResult = Home['routine_results'][number];

export function runHeadline(run: RoutineResult['run']): string {
  switch (run.status) {
    case 'done':
      return 'Finished';
    case 'failed':
    case 'stopped':
      return 'Didn’t finish';
    case 'needs_you':
      return 'Waiting for you';
    default:
      return 'Running now';
  }
}

export function clockTime(iso: string, now: number): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return new Date(now).toDateString() === date.toDateString() ? time : `Yesterday ${time}`;
}

export function RoutineResults({ results, now }: { results: RoutineResult[]; now: number }) {
  if (results.length === 0) return null;
  return (
    <section className="home-section" aria-labelledby="home-routines">
      <div className="home-section-head">
        <h2 id="home-routines">From your routines</h2>
        <a className="section-link" href={href('/automations')}>
          All routines
          <Icon name="chevronRight" size={14} />
        </a>
      </div>
      <div className="motion">
        {results.map((result) => {
          const ok = result.run.status === 'done';
          const failed = result.run.status === 'failed' || result.run.status === 'stopped';
          return (
            <a
              key={result.automation_id}
              className="motion-row"
              href={href(`/chat/${result.conversation_id}`)}
              style={{ alignItems: 'flex-start' }}
            >
              <span
                className="row"
                style={{
                  justifyContent: 'center',
                  width: 28,
                  height: 28,
                  flexShrink: 0,
                  color: ok ? 'var(--success)' : failed ? 'var(--danger)' : 'var(--primary)',
                }}
              >
                <Icon name={ok ? 'circleCheck' : failed ? 'circleX' : 'automations'} size={18} />
              </span>
              <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                <span className="clamp1 motion-title">
                  {result.title} · {runHeadline(result.run)}
                </span>
                <span className="motion-line" style={{ whiteSpace: 'normal' }}>
                  {result.run.summary ??
                    (result.run.reason ? plainRunReason(result.run.reason) : null) ??
                    'Open it to read what it did.'}
                </span>
              </span>
              <span className="motion-when">{clockTime(result.run.started_at, now)}</span>
            </a>
          );
        })}
      </div>
    </section>
  );
}
