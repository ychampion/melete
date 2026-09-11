import type { Action, ActionStatus } from '@melete/client';
import { useState } from 'react';
import { client, errorMessage, unwrap } from '../api.ts';
import {
  ActionChip,
  Banner,
  Empty,
  formatTime,
  Modal,
  PayloadHash,
  PayloadTable,
} from '../components.tsx';
import { useEventStream, useLoad } from '../hooks.ts';

const STATUSES: (ActionStatus | 'all')[] = [
  'all',
  'needs_approval',
  'dispatched',
  'succeeded',
  'failed',
  'denied',
  'unknown',
  'unresolved',
];

const NEEDS_A_PERSON = new Set<ActionStatus>(['unknown', 'unresolved']);

/**
 * Every external effect the system has ever proposed.
 *
 * `unknown` and `unresolved` are highlighted and sorted to the front, because
 * they are the only rows that mean something is waiting on a person. Neither is
 * ever retried: a person says what happened, and the answer is recorded as a
 * reconciliation rather than a guess.
 */
export function Ledger() {
  const stream = useEventStream();
  const [filter, setFilter] = useState<ActionStatus | 'all'>('all');
  const [settling, setSettling] = useState<Action | null>(null);
  const [resolution, setResolution] = useState<'succeeded' | 'failed' | 'unresolved'>('succeeded');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const actions = useLoad<Action[]>(
    async () =>
      unwrap(
        await client.api.GET('/actions', {
          params: { query: { ...(filter === 'all' ? {} : { status: filter }), limit: 200 } },
        }),
      ).actions,
    [filter, stream.events.length],
  );

  const settle = async () => {
    if (!settling) return;
    const { error: failure } = await client.api.POST('/actions/{actionId}/resolve', {
      params: { path: { actionId: settling.id } },
      body: { resolution, ...(note.trim() ? { note: note.trim() } : {}) },
    });
    setSettling(null);
    setNote('');
    if (failure) setError(errorMessage(failure));
    else {
      setError(null);
      actions.reload();
    }
  };

  const rows = [...(actions.data ?? [])].sort((a, b) => {
    const urgency = Number(NEEDS_A_PERSON.has(b.status)) - Number(NEEDS_A_PERSON.has(a.status));
    return urgency !== 0 ? urgency : b.created_at.localeCompare(a.created_at);
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Action ledger</h1>
          <p>
            Every effect that was proposed, admitted, or dispatched. An action that came back
            unknown is never re-sent.
          </p>
        </div>
        <div className="field" style={{ minWidth: 200 }}>
          <label htmlFor="status-filter">Status</label>
          <select
            id="status-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value as ActionStatus | 'all')}
          >
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status === 'all' ? 'Everything' : status.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Banner message={error ?? actions.error} />

      {rows.length === 0 ? (
        <Empty>No action matches that filter.</Empty>
      ) : (
        <div className="stack">
          {rows.map((action) => {
            const urgent = NEEDS_A_PERSON.has(action.status);
            return (
              <article className={`card${urgent ? ' attention' : ''}`} key={action.id}>
                <div className="card-head">
                  <h2>
                    {action.kind} <span className="muted">({action.effect_class})</span>
                  </h2>
                  <ActionChip status={action.status} />
                </div>
                <p className="muted">
                  Job <a href={`#/jobs/${action.job_id}`}>{action.job_id}</a> · proposed{' '}
                  {formatTime(action.created_at)}
                  {action.dispatched_at ? ` · dispatched ${formatTime(action.dispatched_at)}` : ''}
                </p>

                {urgent ? (
                  <p>
                    {action.status === 'unknown'
                      ? 'The connector never answered. This may or may not have happened, and nothing was sent a second time.'
                      : 'Nobody could decide what happened. It rests here rather than being guessed at.'}
                  </p>
                ) : null}

                <PayloadTable payload={action.canonical_payload as Record<string, unknown>} />
                <PayloadHash hash={action.payload_hash} />

                {action.reconciliation ? (
                  <p className="muted">
                    Reconciliation:{' '}
                    <code className="mono">{JSON.stringify(action.reconciliation)}</code>
                  </p>
                ) : null}

                {urgent ? (
                  <div className="row" style={{ marginTop: 12 }}>
                    <button
                      type="button"
                      className="button button-primary"
                      onClick={() => {
                        setSettling(action);
                        setResolution('succeeded');
                      }}
                    >
                      Tell Melete what happened
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      <Modal open={settling !== null} title="Settle this action" onClose={() => setSettling(null)}>
        <p className="muted">
          Melete could not confirm this. Say what you found; the answer is recorded as a
          reconciliation and the action is never dispatched again.
        </p>
        <div className="field">
          <label htmlFor="resolution">What actually happened?</label>
          <select
            id="resolution"
            value={resolution}
            onChange={(event) =>
              setResolution(event.target.value as 'succeeded' | 'failed' | 'unresolved')
            }
          >
            <option value="succeeded">It happened</option>
            <option value="failed">It did not happen</option>
            <option value="unresolved">I cannot tell</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="resolve-note">How do you know?</label>
          <input
            id="resolve-note"
            type="text"
            value={note}
            placeholder="It is in the Sent folder."
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={() => setSettling(null)}>
            Cancel
          </button>
          <button type="button" className="button button-primary" onClick={() => void settle()}>
            Record it
          </button>
        </div>
      </Modal>
    </>
  );
}
