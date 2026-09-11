import type { Approval } from '@melete/client';
import { useState } from 'react';
import { client, errorMessage, unwrap } from '../api.ts';
import { Banner, Empty, formatTime, Modal, PayloadHash, PayloadTable } from '../components.tsx';
import { useEventStream, useLoad } from '../hooks.ts';

/**
 * The approvals inbox.
 *
 * Every card here is rendered from the `action` record the broker
 * canonicalised, never from anything the model wrote. That is the whole point:
 * the bytes a person approves are the bytes that will be sent, and the hash
 * shown is the hash the decision binds to.
 */
export function Approvals() {
  const stream = useEventStream();
  const approvals = useLoad<Approval[]>(
    async () => unwrap(await client.api.GET('/approvals', {})).approvals,
    [stream.events.length],
  );
  const [pending, setPending] = useState<{
    approval: Approval;
    decision: 'approved' | 'denied';
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const decide = async () => {
    if (!pending) return;
    const { approval, decision } = pending;
    const { error: failure } = await client.api.POST('/approvals/{approvalId}', {
      params: { path: { approvalId: approval.approval_id } },
      body: {
        decision,
        // The hash the person was shown. If the draft moved, the API refuses
        // rather than spending the approval on different content.
        payload_hash: approval.payload_hash,
        ...(note.trim() ? { note: note.trim() } : {}),
      },
    });
    setPending(null);
    setNote('');
    if (failure) setError(errorMessage(failure));
    else {
      setError(null);
      approvals.reload();
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <p>
            Nothing leaves the machine until you say so. Each card is the record the connector will
            be handed, not a summary of it.
          </p>
        </div>
        <span className="live" data-live={stream.live}>
          {stream.live ? 'Live' : 'Reconnecting'}
        </span>
      </div>

      <Banner message={error ?? approvals.error} />

      {!approvals.data?.length ? (
        <Empty>Nothing is waiting on you.</Empty>
      ) : (
        <div className="stack">
          {approvals.data.map((approval) => (
            <article className="card attention" key={approval.approval_id}>
              <div className="card-head">
                <h2>
                  {approval.kind} <span className="muted">({approval.effect_class})</span>
                </h2>
                <span className="muted">{formatTime(approval.requested_at)}</span>
              </div>
              <p className="muted">
                Job <a href={`#/jobs/${approval.job_id}`}>{approval.job_id}</a> · revision{' '}
                {approval.job_revision}
              </p>

              <PayloadTable payload={approval.canonical_payload as Record<string, unknown>} />
              <PayloadHash hash={approval.payload_hash} />

              <div className="row" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => setPending({ approval, decision: 'approved' })}
                >
                  Approve this send
                </button>
                <button
                  type="button"
                  className="button button-danger"
                  onClick={() => setPending({ approval, decision: 'denied' })}
                >
                  Deny
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <Modal
        open={pending !== null}
        title={pending?.decision === 'denied' ? 'Deny this action' : 'Approve this action'}
        onClose={() => setPending(null)}
      >
        <p className="muted">
          {pending?.decision === 'denied'
            ? 'Nothing will be sent. The job wakes up and asks what to do instead.'
            : 'This approves exactly the payload below. Editing the draft would create a different action.'}
        </p>
        {pending ? <PayloadHash hash={pending.approval.payload_hash} /> : null}
        <div className="field">
          <label htmlFor="approval-note">Note (optional)</label>
          <input
            id="approval-note"
            type="text"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={() => setPending(null)}>
            Cancel
          </button>
          <button
            type="button"
            className={
              pending?.decision === 'denied' ? 'button button-danger' : 'button button-primary'
            }
            onClick={() => void decide()}
          >
            {pending?.decision === 'denied' ? 'Deny' : 'Approve'}
          </button>
        </div>
      </Modal>
    </>
  );
}
