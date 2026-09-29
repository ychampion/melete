/**
 * Report a problem in two clicks: open, say what went wrong, send. The page
 * attaches what it knows about itself unless the person unticks it, and the
 * answer is a short id to quote when asking about it.
 *
 * Opened from the bug button in the sidebar, the `/feedback` command in a
 * composer, or the `#/feedback` address.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { Button, Checkbox, Dialog, IconButton } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import type { FeedbackReport } from '../experience/types.ts';
import { navigate, useRoute } from '../router.ts';
import { currentRoute, pageContext } from './diagnostics.ts';
import './feedback.css';

const openListeners = new Set<(draft: string) => void>();

/** Open the report panel from anywhere, optionally with words already in it. */
export function openFeedback(draft = '') {
  for (const listener of openListeners) listener(draft);
}

function Sent({ report, onClose }: { report: FeedbackReport; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(report.id)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };
  return (
    <Dialog
      open
      onClose={onClose}
      icon="circleCheck"
      title="We’ve got it"
      sub="Thanks for telling us. Whoever runs Melete here can see your report now."
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="col" style={{ gap: 8 }}>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>Your report</span>
        <div className="feedback-id-row">
          <span className="feedback-id">{report.id}</span>
          <IconButton
            name={copied ? 'check' : 'copy'}
            label={copied ? 'Copied' : 'Copy the report id'}
            onClick={copy}
          />
        </div>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          Quote it if you ask about this. You can follow it under Settings, Feedback.
        </span>
        <span className="sr-only" aria-live="polite">
          {copied ? 'Copied the report id' : ''}
        </span>
      </div>
    </Dialog>
  );
}

function Form({
  draft,
  onClose,
  onSent,
}: {
  draft: string;
  onClose: () => void;
  onSent: (report: FeedbackReport) => void;
}) {
  const [message, setMessage] = useState(draft);
  const [includeDetails, setIncludeDetails] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read once, when the panel opens: the page as the person saw it.
  const [details] = useState(pageContext);
  const canSend = message.trim().length > 0 && !sending;

  const send = () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    void adapter
      .sendFeedback({ message: message.trim(), ...(includeDetails ? { context: details } : {}) })
      .then((result) => {
        setSending(false);
        if (result.data) onSent(result.data.report);
        else setError(result.error ?? result.unavailable ?? 'Couldn’t send the report.');
      });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="What went wrong?"
      sub="A sentence is enough. Say what you did and what you expected."
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canSend} loading={sending} onClick={send}>
            Send report
          </Button>
        </>
      }
    >
      <form
        className="col"
        style={{ gap: 14 }}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          className="textarea feedback-text"
          aria-label="What went wrong?"
          placeholder="The plan list stayed empty after I added one."
          maxLength={5000}
          value={message}
          autoFocus
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="feedback-details">
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the checkbox inside is the control */}
          <label className="row" style={{ gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
            <Checkbox
              checked={includeDetails}
              onChange={setIncludeDetails}
              label="Include details about this page"
            />
            <span className="col" style={{ gap: 2 }}>
              <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
                Include details about this page
              </span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                The page address, your browser and screen size, and the last errors this page hit.
                Never what you typed elsewhere, passwords, cookies or email addresses.
              </span>
            </span>
          </label>
          {includeDetails ? (
            <button
              type="button"
              className="feedback-peek"
              aria-expanded={showDetails}
              onClick={() => setShowDetails((open) => !open)}
            >
              <Icon name={showDetails ? 'chevronDown' : 'chevronRight'} size={14} />
              {showDetails ? 'Hide what’s included' : 'See what’s included'}
            </button>
          ) : null}
          {includeDetails && showDetails ? (
            <pre className="feedback-json">{JSON.stringify(details, null, 2)}</pre>
          ) : null}
        </div>
        {error ? (
          <p role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

/** Drawn once in the shell; opens on request or at `#/feedback`. */
export function FeedbackHost() {
  const route = useRoute();
  const [state, setState] = useState<
    { step: 'closed' } | { step: 'form'; draft: string } | { step: 'sent'; report: FeedbackReport }
  >({ step: 'closed' });
  const atAddress = route.parts[0] === 'feedback';
  // The field inside takes focus as the panel opens, so the dialog cannot see
  // what opened it; focus goes back to that control here instead.
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const listener = (draft: string) => {
      opener.current = document.activeElement as HTMLElement | null;
      setState({ step: 'form', draft });
    };
    openListeners.add(listener);
    return () => {
      openListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (atAddress) setState((now) => (now.step === 'closed' ? { step: 'form', draft: '' } : now));
  }, [atAddress]);

  const close = useCallback(() => {
    setState({ step: 'closed' });
    const back = opener.current;
    opener.current = null;
    if (back?.isConnected) requestAnimationFrame(() => back.focus());
    // Leaving the report's own address goes back to the page it was opened over.
    if (window.location.hash.startsWith('#/feedback')) {
      const page = currentRoute();
      navigate(page.startsWith('#/feedback') ? '/' : page.slice(1) || '/');
    }
  }, []);

  if (state.step === 'form') {
    return (
      <Form
        draft={state.draft}
        onClose={close}
        onSent={(report) => setState({ step: 'sent', report })}
      />
    );
  }
  if (state.step === 'sent') return <Sent report={state.report} onClose={close} />;
  return null;
}
