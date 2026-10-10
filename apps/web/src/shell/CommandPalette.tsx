/**
 * ⌘K. Search across conversations, plans, tasks, events, connections and
 * actions, with typed results from the contract's search. Arrow keys move,
 * Enter opens, Tab cycles the type filter.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from '../design/icons.tsx';
import { Kbd } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import type { SearchResult } from '../experience/types.ts';
import { navigate } from '../router.ts';
import { searchAfterPause, secondaryOf, withoutBuiltins } from './palette.ts';

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

const GROUP_LABEL: Record<SearchResult['kind'], string> = {
  conversation: 'Chats',
  plan: 'Plans',
  task: 'Tasks',
  event: 'Events',
  connection: 'Connections',
  action: 'Actions',
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

const optionId = (n: number) => `palette-option-${n}`;

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('all');
  const [hits, setHits] = useState<SearchResult[] | null>(null);
  const [builtins, setBuiltins] = useState<ReadonlySet<string>>(new Set());
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
    void adapter.connections().then((result) => {
      if (live && result.data)
        setBuiltins(new Set(result.data.connections.filter((c) => c.builtin).map((c) => c.id)));
    });
    return () => {
      live = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    // Only the answer for what is in the box now is shown; an older one arriving late is dropped.
    const cancel = searchAfterPause(query, (q) => {
      void adapter.search(q).then((result) => {
        if (live) setHits(result.data ? result.data.results : []);
      });
    });
    return () => {
      live = false;
      cancel();
    };
  }, [open, query]);

  const found = useMemo(() => withoutBuiltins(hits ?? [], builtins), [hits, builtins]);
  const visible = found.filter((hit) => tab === 'all' || hit.kind === tab);
  const grouped = new Map<SearchResult['kind'], SearchResult[]>();
  for (const hit of visible) grouped.set(hit.kind, [...(grouped.get(hit.kind) ?? []), hit]);
  const flat = [...grouped.values()].flat();
  const at = Math.min(index, Math.max(0, flat.length - 1));
  const current = flat[at];

  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(at))?.scrollIntoView({ block: 'nearest' });
  }, [open, at]);

  const openHit = (hit: SearchResult | undefined) => {
    if (!hit) return;
    onClose();
    navigate(hrefOf(hit));
  };

  if (!open) return null;
  const tabLabel = TABS.find(([key]) => key === tab)?.[1] ?? 'All';
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
          <span className="palette-glyph">
            <Icon name="search" size={16} />
          </span>
          <input
            ref={inputRef}
            value={query}
            placeholder="Search chats, plans, tasks, events…"
            aria-label="Search your workspace"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={current ? optionId(at) : undefined}
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
                const from = TABS.findIndex(([key]) => key === tab);
                const next = TABS[(from + (event.shiftKey ? TABS.length - 1 : 1)) % TABS.length];
                if (next) setTab(next[0]);
                setIndex(0);
              }
            }}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div className="palette-tabs" role="tablist" aria-label="Result type">
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
                inputRef.current?.focus();
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="palette-list" id="palette-list" role="listbox" aria-label={tabLabel}>
          {hits !== null && flat.length === 0 ? (
            <div className="palette-empty">
              <span className="palette-empty-title">
                {query.trim()
                  ? `No ${tab === 'all' ? 'results' : tabLabel.toLowerCase()} match “${query.trim()}”`
                  : tab === 'all'
                    ? 'Nothing to search yet'
                    : `No ${tabLabel.toLowerCase()} yet`}
              </span>
              <span className="palette-empty-sub">
                {tab !== 'all' && found.length > 0
                  ? 'Press Tab to look under another type, or search everything.'
                  : query.trim()
                    ? 'Try a shorter or different word.'
                    : 'Chats, plans and tasks show up here as you make them.'}
              </span>
              {tab !== 'all' && found.length > 0 ? (
                <button
                  type="button"
                  className="palette-empty-action"
                  onClick={() => {
                    setTab('all');
                    setIndex(0);
                    inputRef.current?.focus();
                  }}
                >
                  Search everything
                </button>
              ) : null}
            </div>
          ) : null}
          {[...grouped.entries()].map(([kind, list]) => (
            <div key={kind} className="palette-group">
              {tab === 'all' ? (
                <div className="palette-heading" aria-hidden="true">
                  {GROUP_LABEL[kind]}
                </div>
              ) : null}
              {list.map((hit) => {
                const n = flat.indexOf(hit);
                const sub = secondaryOf(hit);
                return (
                  <a
                    key={`${hit.kind}-${hit.id}`}
                    id={optionId(n)}
                    className="palette-item"
                    role="option"
                    aria-selected={current === hit}
                    tabIndex={-1}
                    href={`#${hrefOf(hit)}`}
                    data-on={current === hit ? 'true' : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      openHit(hit);
                    }}
                    onMouseMove={() => {
                      if (n !== at) setIndex(n);
                    }}
                  >
                    <span className="palette-glyph">
                      <Icon name={ICONS[hit.kind]} size={16} />
                    </span>
                    <span className="palette-text">
                      <span className="palette-title">{hit.title}</span>
                      {sub ? <span className="palette-sub">{sub}</span> : null}
                    </span>
                    {current === hit ? (
                      <span className="palette-go" aria-hidden="true">
                        <Icon name="chevronRight" size={14} />
                      </span>
                    ) : null}
                  </a>
                );
              })}
            </div>
          ))}
        </div>
        <div className="palette-foot" aria-hidden="true">
          <span className="palette-hint">
            <span className="palette-keys">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
            </span>
            Move
          </span>
          <span className="palette-hint">
            <Kbd>↵</Kbd>
            Open
          </span>
          <span className="palette-hint">
            <Kbd>Tab</Kbd>
            Next type
          </span>
        </div>
      </div>
    </div>
  );
}
