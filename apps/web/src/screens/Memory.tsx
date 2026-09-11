import type { KnowledgeHit, KnowledgeRecord } from '@melete/client';
import { useState } from 'react';
import { client, errorMessage, unwrap } from '../api.ts';
import { Banner, Empty, Modal } from '../components.tsx';
import { useLoad } from '../hooks.ts';

/**
 * What Melete knows, where it got it, and how to take it back.
 *
 * Retraction is the point of this screen. A record that is retracted leaves
 * retrieval at once, so the search below stops returning it the moment the
 * button is pressed.
 */
export function Memory({ spaceId }: { spaceId: string | null }) {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [retracting, setRetracting] = useState<KnowledgeHit | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  const hits = useLoad<KnowledgeHit[]>(async () => {
    if (!spaceId) return [];
    return unwrap(
      await client.api.GET('/knowledge/search', {
        params: { query: { space_id: spaceId, q: submitted || 'e', limit: 25 } },
      }),
    ).hits;
  }, [spaceId, submitted, round]);

  const record = useLoad<KnowledgeRecord | null>(async () => {
    if (!openId) return null;
    return unwrap(
      await client.api.GET('/knowledge/{recordId}', { params: { path: { recordId: openId } } }),
    );
  }, [openId]);

  const retract = async () => {
    if (!retracting || !reason.trim()) return;
    const { error: failure } = await client.api.DELETE('/knowledge/{recordId}', {
      params: { path: { recordId: retracting.id } },
      body: { reason: reason.trim(), hard_delete: false },
    });
    setRetracting(null);
    setReason('');
    if (failure) setError(errorMessage(failure));
    else {
      setError(null);
      setRound((n) => n + 1);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Memory</h1>
          <p>
            Markdown records in your space, each one carrying where it came from. Retract anything
            and it leaves retrieval at once.
          </p>
        </div>
      </div>

      <Banner message={error ?? hits.error} />

      <article className="card">
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(query.trim());
          }}
        >
          <input
            type="search"
            aria-label="Search memory"
            placeholder="heating, landlord, bun"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            style={{ flex: '1 1 220px' }}
          />
          <button type="submit" className="button button-primary">
            Search
          </button>
          <button
            type="button"
            className="button"
            onClick={() => {
              setQuery('');
              setSubmitted('');
            }}
          >
            Show all
          </button>
        </form>
      </article>

      {!hits.data?.length ? (
        <Empty>{hits.loading ? 'Searching.' : 'Nothing matches that.'}</Empty>
      ) : (
        <div className="stack">
          {hits.data.map((hit) => (
            <article className="card" key={hit.id}>
              <div className="card-head">
                <h2>{hit.title}</h2>
                <span className={`chip ${hit.status === 'active' ? 'chip-good' : 'chip-neutral'}`}>
                  {hit.status}
                </span>
              </div>
              <p className="muted">{hit.excerpt}</p>
              <p className="muted mono">{hit.path}</p>
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="button button-small"
                  onClick={() => setOpenId(hit.id)}
                >
                  Read it
                </button>
                <button
                  type="button"
                  className="button button-small button-danger"
                  onClick={() => setRetracting(hit)}
                >
                  Retract
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <Modal
        open={openId !== null}
        title={record.data?.frontmatter.title ?? 'Record'}
        onClose={() => setOpenId(null)}
      >
        {record.data ? (
          <>
            <p className="muted">
              {record.data.frontmatter.type} · {record.data.frontmatter.confidence} confidence ·
              asserted by {record.data.frontmatter.asserted_by}
            </p>
            <p style={{ whiteSpace: 'pre-wrap' }}>{record.data.body}</p>
            <p className="muted">
              Source: {record.data.frontmatter.source.kind}{' '}
              <code className="mono">{record.data.frontmatter.source.ref}</code>
            </p>
            {record.data.frontmatter.source.quote ? (
              <blockquote className="muted" style={{ margin: 0 }}>
                “{record.data.frontmatter.source.quote}”
              </blockquote>
            ) : null}
            <p className="muted">
              Observed {record.data.frontmatter.observed_at} · true from{' '}
              {record.data.frontmatter.valid_from}
              {record.data.frontmatter.valid_until
                ? ` until ${record.data.frontmatter.valid_until}`
                : ''}
            </p>
          </>
        ) : (
          <p className="muted">Loading.</p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={() => setOpenId(null)}>
            Close
          </button>
        </div>
      </Modal>

      <Modal
        open={retracting !== null}
        title="Retract this record"
        onClose={() => setRetracting(null)}
      >
        <p className="muted">
          It leaves retrieval immediately and stays gone after a restart. The file keeps the text
          and your reason, so the record of what was believed is not erased.
        </p>
        <div className="field">
          <label htmlFor="retract-reason">Why is it wrong?</label>
          <input
            id="retract-reason"
            type="text"
            value={reason}
            placeholder="The engineer came and it is fixed."
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={() => setRetracting(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-danger"
            disabled={!reason.trim()}
            onClick={() => void retract()}
          >
            Retract
          </button>
        </div>
      </Modal>
    </>
  );
}
