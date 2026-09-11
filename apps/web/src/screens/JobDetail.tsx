import type { Action, Attempt, Job, StoredEvent } from '@melete/client';
import { fetchEventPage } from '@melete/client';
import { client, errorMessage, unwrap } from '../api.ts';
import {
  ActionChip,
  Banner,
  Empty,
  formatTime,
  JobChip,
  PayloadHash,
  PayloadTable,
  WAITING_SENTENCE,
  waitingDetail,
} from '../components.tsx';
import { useEventStream, useLoad } from '../hooks.ts';

/** One job: what it is waiting on, what it tried, and what it actually did. */
export function JobDetail({ jobId }: { jobId: string }) {
  const stream = useEventStream({ jobId });
  const tick = stream.events.length;

  const job = useLoad<Job>(
    async () => unwrap(await client.api.GET('/jobs/{jobId}', { params: { path: { jobId } } })).job,
    [jobId, tick],
  );
  const attempts = useLoad<Attempt[]>(
    async () =>
      unwrap(await client.api.GET('/jobs/{jobId}/attempts', { params: { path: { jobId } } }))
        .attempts,
    [jobId, tick],
  );
  const actions = useLoad<Action[]>(
    async () =>
      unwrap(await client.api.GET('/actions', { params: { query: { job_id: jobId } } })).actions,
    [jobId, tick],
  );
  // The page cursor carries the whole durable history; the live stream only
  // carries what happened since this screen opened.
  const history = useLoad<StoredEvent[]>(async () => {
    const { data, error } = await fetchEventPage(client, { jobId, after: 0, limit: 1000 });
    if (!data) throw new Error(errorMessage(error));
    return data.events;
  }, [jobId, tick]);

  const cancel = async () => {
    const { error } = await client.api.POST('/jobs/{jobId}/cancel', {
      params: { path: { jobId } },
      body: { reason: 'Cancelled from the reference client.' },
    });
    if (!error) job.reload();
  };

  const waiting = job.data ? WAITING_SENTENCE[job.data.state] : null;
  const detail = job.data ? waitingDetail(job.data.wait) : null;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="muted">
            <a href="#/">Jobs</a> / <span className="mono">{jobId}</span>
          </p>
          <h1>{job.data?.title ?? 'Job'}</h1>
          <p>{job.data?.objective}</p>
        </div>
        <div className="row">
          {job.data ? <JobChip state={job.data.state} /> : null}
          <span className="live" data-live={stream.live}>
            {stream.live ? 'Live' : 'Reconnecting'}
          </span>
        </div>
      </div>

      <Banner message={job.error ?? actions.error ?? history.error} />

      {waiting ? (
        <article className="card attention">
          <h2>{waiting}</h2>
          {detail ? <p className="muted">{detail}</p> : null}
          <div className="row" style={{ marginTop: 10 }}>
            {job.data?.state === 'waiting_for_approval' ? (
              <a className="button button-primary" href="#/approvals">
                Decide now
              </a>
            ) : null}
            {job.data?.state === 'needs_reconciliation' ? (
              <a className="button button-primary" href="#/actions">
                Settle the action
              </a>
            ) : null}
            {job.data?.state === 'waiting_for_input' ? (
              <a className="button button-primary" href="#/chat">
                Answer in the chat
              </a>
            ) : null}
          </div>
        </article>
      ) : null}

      <article className="card">
        <div className="card-head">
          <h2>Attempts</h2>
          <p className="muted">What ran, on which provider and model.</p>
        </div>
        {!attempts.data?.length ? (
          <Empty>No attempt has started yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Provider</th>
                  <th>Model asked / served</th>
                  <th>Outcome</th>
                  <th>Tokens</th>
                </tr>
              </thead>
              <tbody>
                {attempts.data.map((attempt) => (
                  <tr key={attempt.id}>
                    <td>{formatTime(attempt.started_at)}</td>
                    <td>{attempt.provider}</td>
                    <td>
                      {attempt.model}
                      {attempt.model_actual && attempt.model_actual !== attempt.model ? (
                        <>
                          {' → '}
                          <strong>{attempt.model_actual}</strong>
                        </>
                      ) : null}
                    </td>
                    <td>{attempt.outcome ?? 'running'}</td>
                    <td>
                      {attempt.usage.input_tokens} in / {attempt.usage.output_tokens} out
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>

      <article className="card">
        <div className="card-head">
          <h2>Actions</h2>
          <p className="muted">Every external effect this job proposed, and how it ended.</p>
        </div>
        {!actions.data?.length ? (
          <Empty>This job has proposed no external effect.</Empty>
        ) : (
          <div className="stack">
            {actions.data.map((action) => (
              <div key={action.id}>
                <div className="row spread">
                  <h3>
                    {action.kind} <span className="muted">({action.effect_class})</span>
                  </h3>
                  <ActionChip status={action.status} />
                </div>
                <PayloadTable payload={action.canonical_payload as Record<string, unknown>} />
                <PayloadHash hash={action.payload_hash} />
                {action.receipt ? (
                  <p className="muted">
                    Receipt{' '}
                    <code className="mono">
                      {String((action.receipt as { external_ref?: string }).external_ref ?? '—')}
                    </code>
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </article>

      <article className="card">
        <div className="card-head">
          <h2>Timeline</h2>
          <p className="muted">
            Persisted first, streamed second. A reload replays it from the database.
          </p>
        </div>
        <Timeline history={history.data ?? []} live={stream.events} gaps={stream.gaps} />
      </article>

      {job.data && !['completed', 'failed', 'cancelled'].includes(job.data.state) ? (
        <div className="row" style={{ marginTop: 14 }}>
          <button type="button" className="button button-danger" onClick={() => void cancel()}>
            Cancel this job
          </button>
        </div>
      ) : null}
    </>
  );
}

function Timeline({
  history,
  live,
  gaps,
}: {
  history: StoredEvent[];
  live: { seq: number; type: string; payload: Record<string, unknown>; created_at: string }[];
  gaps: { after: number; next: number | null; reason: string }[];
}) {
  const seen = new Map<
    number,
    { seq: number; type: string; payload: unknown; created_at: string }
  >();
  for (const event of history) seen.set(event.seq, event);
  for (const event of live) seen.set(event.seq, event);
  const rows = [...seen.values()].sort((a, b) => a.seq - b.seq);
  const gapAfter = new Set(gaps.map((gap) => gap.after));

  if (rows.length === 0) return <Empty>No events yet.</Empty>;

  return (
    <div className="timeline">
      {rows.map((event) => (
        <div key={event.seq}>
          <div className="event">
            <span className="event-seq">#{event.seq}</span>
            <span className="event-type">{event.type}</span>
            <span className="event-body">{summarise(event.type, event.payload)}</span>
          </div>
          {gapAfter.has(event.seq) ? (
            <p className="gap">…the stream reconnected here; streamed text is not replayed</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

const summarise = (type: string, payload: unknown): string => {
  const fields = (payload ?? {}) as Record<string, unknown>;
  const pick = (key: string): string | null =>
    typeof fields[key] === 'string' ? (fields[key] as string) : null;

  if (type === 'text_delta') return pick('text') ?? '';
  if (type === 'job_state_changed') return `${pick('from')} → ${pick('to')} (${pick('input')})`;
  if (type === 'attempt_started') return `${pick('provider')} · ${pick('model')}`;
  if (type === 'attempt_ended') return `outcome ${pick('outcome')}`;
  if (type === 'action_status_changed') return `${pick('kind')} is ${pick('status')}`;
  if (type === 'action_requested') return `${pick('kind')} proposed`;
  if (type === 'approval_requested') return 'an approval was raised';
  if (type === 'approval_decided') return `${pick('decision')}`;
  if (type === 'notice') return `${pick('title')}. ${pick('body') ?? ''}`.trim();
  if (type === 'tool_call_proposed' || type === 'tool_result') return pick('name') ?? '';
  return JSON.stringify(fields).slice(0, 160);
};
