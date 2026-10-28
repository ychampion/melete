/**
 * Under a finished answer: how many details were swapped for placeholders
 * before the cloud model saw the conversation, or that it stayed on the
 * person's own model. The reveal asks this person's own Melete for the values
 * and shows them here only; nothing is stored in the page. Beside it, "What
 * the model saw" opens the answer as the cloud model received it.
 */
import { useEffect, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { adapter } from '../experience/adapter.ts';
import { instanceName } from '../experience/instance.ts';
import { CATEGORY_NAMES } from '../experience/privacy.ts';
import type { ConversationPrivacy, PrivacyReveal } from '../experience/types.ts';
import { ModelSaw } from './ModelSaw.tsx';

type Summary = ConversationPrivacy['turns'][number];

/** One read per conversation, shared by its answers, refreshed when an answer is missing. */
const reads = new Map<string, { at: number; pending: Promise<ConversationPrivacy | null> }>();

function summaryFor(conversationId: string, turnId: string): Promise<Summary | null> {
  const cached = reads.get(conversationId);
  const fresh = cached && Date.now() - cached.at < 4000;
  const pending = fresh
    ? cached.pending
    : adapter.conversationPrivacy(conversationId).then((result) => result.data);
  if (!fresh) reads.set(conversationId, { at: Date.now(), pending });
  return pending.then((data) => data?.turns.find((turn) => turn.turn_id === turnId) ?? null);
}

export function Protected({ conversationId, turnId }: { conversationId: string; turnId: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [revealed, setRevealed] = useState<PrivacyReveal['items'] | null>(null);
  const [open, setOpen] = useState(false);
  const [saw, setSaw] = useState(false);

  useEffect(() => {
    let live = true;
    void summaryFor(conversationId, turnId).then((found) => {
      if (live) setSummary(found);
    });
    return () => {
      live = false;
    };
  }, [conversationId, turnId]);

  if (!summary) return null;
  if (summary.route === 'local' || summary.route === 'on_device')
    return (
      <div className="row protected" style={{ gap: 6, fontSize: 12, color: 'var(--muted)' }}>
        <Icon name="lock" size={12} />
        {summary.route === 'local' ? 'Answered on your local model' : 'Answered on your own model'}
      </div>
    );
  const sawButton = (
    <>
      <button type="button" className="saw-open" onClick={() => setSaw(true)}>
        <Icon name="frame" size={12} />
        What the model saw
      </button>
      {saw ? (
        <ModelSaw conversationId={conversationId} turnId={turnId} onClose={() => setSaw(false)} />
      ) : null}
    </>
  );
  if (!summary.protected) return <div className="row protected">{sawButton}</div>;

  const toggle = async () => {
    if (open) {
      setOpen(false);
      // Values leave the page when the list closes.
      setRevealed(null);
      return;
    }
    const result = await adapter.revealPrivacy(conversationId, turnId);
    setRevealed(result.data?.items ?? []);
    setOpen(true);
  };

  return (
    <div className="col protected" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="row"
          aria-expanded={open}
          onClick={() => void toggle()}
          style={{
            gap: 6,
            fontSize: 12,
            color: 'var(--muted)',
            background: 'none',
            border: 0,
            padding: '2px 0',
            cursor: 'pointer',
            alignSelf: 'flex-start',
          }}
        >
          <Icon name="lock" size={12} />
          Protected {summary.protected} detail{summary.protected === 1 ? '' : 's'}
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        </button>
        {sawButton}
      </div>
      {open && revealed ? (
        <div
          className="col"
          style={{
            gap: 4,
            fontSize: 12,
            padding: '8px 10px',
            borderRadius: 10,
            background: 'var(--soft)',
            maxWidth: 520,
          }}
        >
          <span style={{ color: 'var(--muted)' }}>
            The cloud model saw placeholders. Shown here only, from your own {instanceName()}.
          </span>
          {revealed.map((item) => (
            <div key={item.placeholder} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <code style={{ color: 'var(--blue-ink)' }}>{item.placeholder}</code>
              <span style={{ color: 'var(--text)', overflowWrap: 'anywhere' }}>{item.value}</span>
              <span style={{ color: 'var(--muted)' }}>{CATEGORY_NAMES[item.category]}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
