/**
 * ⌘K. Search across conversations, plans, tasks, events, connections and
 * actions, with typed results from the contract's search. Arrow keys move,
 * Enter opens, Tab cycles the type filter.
 */
import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../design/icons.tsx';
import { Kbd } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import type { SearchResult } from '../experience/types.ts';
import { navigate } from '../router.ts';

const TABS = [
  ['all', 'All'],
  ['conversation', 'Chats'],
  ['plan', 'Plans'],
  ['task', 'Tasks'],
  ['event', 'Events'],
  ['connection', 'Connections'],
  ['action', 'Actions'],
] as const;

const ICONS: Record<SearchResult['kind'], IconName> = {
  conversation: 'chat',
  plan: 'plans',
  task: 'check',
  event: 'calendar',
  connection: 'connectors',
  action: 'compose',
};

const KIND_LABEL: Record<SearchResult['kind'], string> = {
  conversation: 'Chat',
  plan: 'Plan',
  task: 'Task',
  event: 'Event',
  connection: 'Connection',
  action: 'Action',
};

/** Where a result opens. Actions open the conversation they happened in. */
export function hrefOf(hit: SearchResult): string {
  switch (hit.kind) {
    case 'conversation':
      return `/chat/${hit.id}`;
    case 'plan':
      return `/plans/${hit.id}`;
    case 'connection':
      return '/settings/connections';
    case 'action':
      return hit.conversation_id ? `/chat/${hit.conversation_id}` : '/';
    default:
      return '/';
  }
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('all');
  const [hits, setHits] = useState<SearchResult[]>([]);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setTab('all');
    setIndex(0);
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    // The contract wants a non-empty query; an empty box lists everything.
    void adapter.search(query.trim() || ' ').then((result) => {
      if (live && result.data) setHits(result.data.results);
    });
    return () => {
      live = false;
    };
  }, [open, query]);

  const visible = hits.filter((hit) => tab === 'all' || hit.kind === tab);
  const grouped = new Map<SearchResult['kind'], SearchResult[]>();
  for (const hit of visible) grouped.set(hit.kind, [...(grouped.get(hit.kind) ?? []), hit]);
  const flat = [...grouped.values()].flat();
  const current = flat[Math.min(index, Math.max(0, flat.length - 1))];

  const openHit = (hit: SearchResult | undefined) => {
    if (!hit) return;
    onClose();
    navigate(hrefOf(hit));
  };

  if (!open) return null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the scrim closes the palette on an outside click; Escape does the same for the keyboard
    <div
      className="palette-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search your workspace">
        <div className="palette-input">
          <span style={{ color: 'var(--muted)', display: 'flex' }}>
            <Icon name="search" size={18} />
          </span>
          <input
            ref={inputRef}
            value={query}
            placeholder="Search chats, plans, tasks, events…"
            aria-label="Search your workspace"
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose();
              else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setIndex((n) => Math.min(n + 1, Math.max(0, flat.length - 1)));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setIndex((n) => Math.max(n - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                openHit(current);
              } else if (event.key === 'Tab') {
                event.preventDefault();
                const at = TABS.findIndex(([key]) => key === tab);
                const next = TABS[(at + (event.shiftKey ? TABS.length - 1 : 1)) % TABS.length];
                if (next) setTab(next[0]);
                setIndex(0);
              }
            }}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div className="palette-tabs" role="tablist">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              className="palette-tab"
              aria-selected={tab === key}
              onClick={() => {
                setTab(key);
                setIndex(0);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="palette-list">
          {flat.length === 0 ? (
            <p style={{ padding: '12px 10px 8px', fontSize: 13, color: 'var(--muted)' }}>
              Nothing matches “{query}”.
            </p>
          ) : null}
          {[...grouped.entries()].map(([kind, list]) => (
            <div key={kind} className="col" style={{ gap: 2 }}>
              <div className="overline" style={{ padding: '8px 10px 4px' }}>
                {KIND_LABEL[kind]}s
              </div>
              {list.map((hit) => (
                <a
                  key={`${hit.kind}-${hit.id}`}
                  className="palette-item"
                  href={`#${hrefOf(hit)}`}
                  data-on={current === hit ? 'true' : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    openHit(hit);
                  }}
                  onMouseEnter={() => setIndex(flat.indexOf(hit))}
                >
                  <span style={{ color: 'var(--muted)', display: 'flex' }}>
                    <Icon name={ICONS[hit.kind]} size={16} />
                  </span>
                  <span style={{ fontSize: 14, color: 'var(--heading)', whiteSpace: 'nowrap' }}>
                    {hit.title}
                  </span>
                  <span className="clamp1 grow" style={{ fontSize: 13, color: 'var(--muted)' }}>
                    {hit.meta}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {KIND_LABEL[hit.kind]}
                  </span>
                </a>
              ))}
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span className="row" style={{ gap: 4 }}>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> move
          </span>
          <span className="row" style={{ gap: 4 }}>
            <Kbd>↵</Kbd> open
          </span>
          <span className="row" style={{ gap: 4 }}>
            <Kbd>⇥</Kbd> next tab
          </span>
        </div>
      </div>
    </div>
  );
}
