/**
 * Pages a conversation's connections showed (MCP Apps), drawn in the chat.
 *
 * Each card says which connection the page is from and where its server is,
 * so nobody takes it for Melete's own. While the page is open it is drawn in a
 * sandboxed frame with an opaque origin: it holds none of Melete's cookies and
 * reads nothing of the page around it, and it talks to Melete only through the
 * MCP Apps messages in page-bridge.ts. Once its server reports, the card shows
 * what the server said; the conversation goes on by itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { Button, Status, type StatusTone } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import type { ConnectionPage, ConnectionPageView } from '../experience/types.ts';
import { usePoll } from '../runs/poll.ts';
import { connectPageBridge } from './page-bridge.ts';
import './pages.css';

/** Never same-origin, popups or top navigation: a link goes through the person. */
export const PAGE_SANDBOX = 'allow-scripts allow-forms';

const STATES: Record<ConnectionPage['state'], { word: string; tone: StatusTone }> = {
  open: { word: 'Waiting for you', tone: 'needs' },
  completed: { word: 'Done', tone: 'settled' },
  failed: { word: 'Did not go through', tone: 'late' },
  cancelled: { word: 'Cancelled', tone: 'kind' },
  expired: { word: 'Expired', tone: 'kind' },
};

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

function currentTheme(): 'light' | 'dark' {
  const stamped = document.documentElement.dataset.theme;
  if (stamped === 'dark' || stamped === 'light') return stamped;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** The theme changes when the person picks one, or the system's changes under "system". */
function watchTheme(changed: () => void) {
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  media?.addEventListener('change', changed);
  const stamp = new MutationObserver(changed);
  stamp.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    media?.removeEventListener('change', changed);
    stamp.disconnect();
  };
}

/** A conversation's pages, read again when it settles and every half minute while one is open. */
export function ConnectionPages({
  conversationId,
  refresh,
}: {
  conversationId: string | null;
  refresh: unknown;
}) {
  const [pages, setPages] = useState<ConnectionPage[]>([]);
  const read = useCallback(() => {
    if (!conversationId) return;
    void adapter.conversationPages(conversationId).then((result) => {
      if (result.data) setPages(result.data.pages);
    });
  }, [conversationId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` is a nudge to read again
  useEffect(read, [read, refresh]);
  usePoll(
    read,
    30_000,
    pages.some((page) => page.state === 'open'),
  );
  if (!conversationId || pages.length === 0) return null;
  // Oldest first, as the conversation reads.
  return (
    <div className="col" style={{ gap: 8 }}>
      {[...pages].reverse().map((page) => (
        <PageCard key={page.id} page={page} />
      ))}
    </div>
  );
}

export function PageCard({ page }: { page: ConnectionPage }) {
  const state = STATES[page.state];
  const live = page.state === 'open' && Date.parse(page.expires_at) > Date.now();
  const host = hostOf(page.connection_origin);
  return (
    <section className="page-card" aria-label={`Page from ${page.connection_label}`}>
      <header className="page-card-head">
        <span className="page-card-icon" aria-hidden="true">
          <Icon name="frame" size={18} />
        </span>
        <span className="page-card-from">
          <span className="page-card-label">From {page.connection_label}</span>
          <span className="page-card-origin" title={page.connection_origin}>
            <Icon name="lock" size={12} />
            {host}
          </span>
        </span>
        <Status tone={state.tone} quiet>
          {state.word}
        </Status>
      </header>
      {live ? (
        <PageFrame page={page} />
      ) : page.summary ? (
        <p className="page-card-summary">{page.summary}</p>
      ) : null}
    </section>
  );
}

function PageFrame({ page }: { page: ConnectionPage }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [view, setView] = useState<ConnectionPageView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [link, setLink] = useState<{ url: string; settle: (opened: boolean) => void } | null>(null);

  useEffect(() => {
    let live = true;
    void adapter.pageView(page.id).then((result) => {
      if (!live) return;
      if (result.data) setView(result.data);
      else setFailed('This page could not be opened here.');
    });
    return () => {
      live = false;
    };
  }, [page.id]);

  useEffect(() => {
    if (!view) return;
    return connectPageBridge(() => frame.current, {
      theme: currentTheme,
      watchTheme,
      toolInput: view.tool_input,
      toolResult: view.tool_result,
      openOrigins: page.open_origins,
      resize: setHeight,
      confirmLink: (url) => new Promise((settle) => setLink({ url, settle })),
    });
  }, [view, page.open_origins]);

  // The person's click opens the tab, so no browser takes it for a popup.
  const answer = (open: boolean) => {
    if (!link) return;
    if (open) window.open(link.url, '_blank', 'noopener,noreferrer');
    link.settle(open);
    setLink(null);
  };

  if (failed) return <p className="page-card-summary">{failed}</p>;
  if (!view) return <div className="page-card-frame page-card-loading" aria-busy="true" />;
  return (
    <>
      <iframe
        ref={frame}
        className="page-card-frame"
        src={adapter.pageSource(view)}
        title={`Page from ${page.connection_label}`}
        sandbox={PAGE_SANDBOX}
        referrerPolicy="no-referrer"
        style={height ? { height } : undefined}
      />
      {link ? (
        <fieldset className="page-card-link" aria-label="Open a page from this connection">
          <p>
            {page.connection_label} wants to open this in a new tab:
            <span className="page-card-url">{link.url}</span>
          </p>
          <span className="page-card-link-actions">
            <Button variant="ghost" size="sm" onClick={() => answer(false)}>
              Not now
            </Button>
            <Button size="sm" iconRight="arrowUpRight" onClick={() => answer(true)}>
              Open
            </Button>
          </span>
        </fieldset>
      ) : null}
    </>
  );
}
