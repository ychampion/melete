import type { Job } from '@melete/client';
import { useMemo, useState } from 'react';
import { client, errorMessage } from '../api.ts';
import { Banner, JobChip, WAITING_SENTENCE, waitingDetail } from '../components.tsx';
import { useEventStream, useLoad } from '../hooks.ts';

const EXAMPLES = [
  'Email the building manager about HT-4471 and ask for a date an engineer is booked.',
  'Write one line to the flaky test destination; I want to see an unknown outcome.',
];

/**
 * Delegate a responsibility in one message, then watch the job work.
 *
 * The transcript is the event stream, not a chat log the client keeps: reload
 * the page and the durable events come back, while a reconnect shows an
 * ellipsis where transient text was lost.
 */
export function Chat({ spaceId }: { spaceId: string | null }) {
  const [text, setText] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const stream = useEventStream({ ...(jobId ? { jobId } : {}), enabled: jobId !== null });
  const job = useLoad<Job | null>(async () => {
    if (!jobId) return null;
    const { data, error: failure } = await client.api.GET('/jobs/{jobId}', {
      params: { path: { jobId } },
    });
    if (!data) throw new Error(errorMessage(failure));
    return data.job;
    // Reloading on every event keeps the state chip honest without polling.
  }, [jobId, stream.events.length]);

  const create = async () => {
    if (!spaceId || !text.trim() || sending) return;
    setSending(true);
    setError(null);
    const { data, error: failure } = await client.api.POST('/jobs', {
      body: {
        space_id: spaceId,
        title: text.trim().slice(0, 80),
        objective: text.trim(),
      },
    });
    setSending(false);
    if (!data) {
      setError(errorMessage(failure));
      return;
    }
    setJobId(data.job.id);
    setText('');
  };

  const answer = async (reply: string) => {
    if (!jobId) return;
    const { error: failure } = await client.api.POST('/jobs/{jobId}/messages', {
      params: { path: { jobId } },
      body: { text: reply },
    });
    if (failure) setError(errorMessage(failure));
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Delegate</h1>
          <p>
            Say what you want done. Melete will come back with progress, a result, or one precise
            question.
          </p>
        </div>
        {job.data ? <JobChip state={job.data.state} /> : null}
      </div>

      <Banner message={error} />

      {jobId === null ? (
        <article className="card">
          <div className="field">
            <label htmlFor="objective">What should Melete take on?</label>
            <textarea
              id="objective"
              value={text}
              placeholder="Email the building manager about the heating and ask for a date."
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void create();
              }}
            />
          </div>
          <div className="row spread" style={{ marginTop: 12 }}>
            <span className="muted">Control-Enter sends.</span>
            <button
              type="button"
              className="button button-primary"
              onClick={() => void create()}
              disabled={!spaceId || !text.trim() || sending}
            >
              {sending ? 'Starting' : 'Start the job'}
            </button>
          </div>
          <div className="stack" style={{ marginTop: 14 }}>
            <p className="muted">Two things the mock knows how to do:</p>
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                className="button button-small"
                style={{ textAlign: 'left' }}
                onClick={() => setText(example)}
              >
                {example}
              </button>
            ))}
          </div>
        </article>
      ) : (
        <Transcript
          jobId={jobId}
          job={job.data}
          stream={stream}
          onAnswer={(reply) => void answer(reply)}
          onReset={() => setJobId(null)}
        />
      )}
    </>
  );
}

type StreamShape = ReturnType<typeof useEventStream>;

function Transcript({
  jobId,
  job,
  stream,
  onAnswer,
  onReset,
}: {
  jobId: string;
  job: Job | null;
  stream: StreamShape;
  onAnswer: (reply: string) => void;
  onReset: () => void;
}) {
  const [reply, setReply] = useState('');

  // One list, in stream order, with the gaps interleaved where they happened.
  const lines = useMemo(() => {
    type Line =
      | { kind: 'text'; seq: number; text: string }
      | { kind: 'owner'; seq: number; text: string }
      | { kind: 'note'; seq: number; text: string }
      | { kind: 'gap'; seq: number; text: string };
    const out: Line[] = [];
    for (const event of stream.events) {
      const payload = event.payload as Record<string, unknown>;
      if (event.type === 'text_delta' && typeof payload.text === 'string') {
        out.push({ kind: 'text', seq: event.seq, text: payload.text });
      } else if (event.type === 'turn_started' && typeof payload.text === 'string') {
        out.push({ kind: 'owner', seq: event.seq, text: payload.text });
      } else if (event.type === 'notice' && typeof payload.title === 'string') {
        const body = typeof payload.body === 'string' ? payload.body : '';
        out.push({ kind: 'note', seq: event.seq, text: `${payload.title}. ${body}`.trim() });
      } else if (event.type === 'approval_requested') {
        out.push({
          kind: 'note',
          seq: event.seq,
          text: 'A send is waiting for your decision. Open the approvals inbox.',
        });
      }
    }
    for (const gap of stream.gaps) {
      out.push({
        kind: 'gap',
        seq: gap.after + 0.5,
        text:
          gap.reason === 'reconnect'
            ? 'The stream reconnected. Anything typed while it was down is not kept.'
            : `Events ${gap.after + 1} to ${(gap.next ?? gap.after) - 1} are missing.`,
      });
    }
    return out.sort((a, b) => a.seq - b.seq);
  }, [stream.events, stream.gaps]);

  const waiting = job && WAITING_SENTENCE[job.state];

  return (
    <article className="card">
      <div className="card-head">
        <h2>
          <a href={`#/jobs/${jobId}`}>{job?.title ?? 'Working'}</a>
        </h2>
        <span className="live" data-live={stream.live}>
          {stream.live ? 'Live' : 'Reconnecting'}
          {stream.reconnects > 0 ? ` · ${stream.reconnects} reconnect` : ''}
        </span>
      </div>

      <div className="transcript">
        {lines.length === 0 ? <p className="muted">Waiting for the first event.</p> : null}
        {lines.map((line) =>
          line.kind === 'gap' ? (
            <p className="gap" key={`gap-${line.seq}`}>
              …{line.text}
            </p>
          ) : (
            <p
              key={`${line.kind}-${line.seq}`}
              className={`bubble${line.kind === 'owner' ? ' bubble-owner' : ''}${
                line.kind === 'note' ? ' bubble-note' : ''
              }`}
            >
              {line.text}
            </p>
          ),
        )}
      </div>

      {waiting ? (
        <div className="stack" style={{ marginTop: 14 }}>
          <p className="muted">{waiting}</p>
          {job?.wait.kind === 'user_input' ? (
            <>
              <p>{waitingDetail(job.wait)}</p>
              <div className="row">
                <input
                  type="text"
                  value={reply}
                  aria-label="Your answer"
                  placeholder="Your answer"
                  onChange={(event) => setReply(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' || !reply.trim()) return;
                    onAnswer(reply.trim());
                    setReply('');
                  }}
                  style={{ flex: '1 1 240px' }}
                />
                <button
                  type="button"
                  className="button button-primary"
                  disabled={!reply.trim()}
                  onClick={() => {
                    onAnswer(reply.trim());
                    setReply('');
                  }}
                >
                  Answer
                </button>
              </div>
            </>
          ) : null}
          {job?.state === 'waiting_for_approval' ? (
            <a className="button button-primary" href="#/approvals">
              Open the approvals inbox
            </a>
          ) : null}
          {job?.state === 'needs_reconciliation' ? (
            <a className="button button-primary" href="#/actions">
              Open the action ledger
            </a>
          ) : null}
        </div>
      ) : null}

      <div className="row" style={{ marginTop: 14 }}>
        <button type="button" className="button button-small" onClick={onReset}>
          Delegate something else
        </button>
      </div>
    </article>
  );
}
