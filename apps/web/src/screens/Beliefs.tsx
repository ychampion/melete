/**
 * "What I believe about you": the main view of Settings → Memory.
 *
 * Beliefs are grouped by what they are about. Each says where it came from in
 * plain words, links to the conversation or receipt when there is one, and
 * shows how far it can be trusted. Any of them can be corrected in place (the
 * correction becomes the person's own word and the old value stays in its
 * history), forgotten, or forgotten for good. The timeline shows what was
 * learned each day, and a whole day can be undone after a preview; the undo is
 * itself undoable. The weekly digest sits on top until it is dismissed.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import {
  Badge,
  type BadgeTone,
  Button,
  Chip,
  IconButton,
  Input,
  TabsUnderline,
} from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { useLoad } from '../experience/hooks.ts';
import type {
  Belief,
  BeliefCategory,
  BeliefHistory,
  MemoryDay,
  MemoryDigest,
  MemoryRewind,
  RewindPreview,
  RewindTarget,
} from '../experience/types.ts';
import { href, navigate, useRoute } from '../router.ts';
import { toast } from '../shell/Shell.tsx';
import './beliefs.css';
import { LearnedTab } from './Learned.tsx';

export const CATEGORY_TITLE: Record<BeliefCategory, string> = {
  people: 'People',
  preferences: 'Preferences',
  accounts: 'Accounts and bills',
  routines: 'Routines and dates',
  work: 'Work',
  other: 'Everything else',
};
const CATEGORY_ORDER: BeliefCategory[] = [
  'people',
  'preferences',
  'accounts',
  'routines',
  'work',
  'other',
];
const TRUST_TONE: Record<Belief['trust'], BadgeTone> = {
  yours: 'success',
  connected: 'blue',
  outside: 'finance',
  worked_out: 'learning',
};
const TRUST_SHORT: Record<Belief['trust'], string> = {
  yours: 'Your words',
  connected: 'Connected account',
  outside: 'Not checked',
  worked_out: 'My guess',
};
const CHANGE_WORD: Record<MemoryDay['changes'][number]['change'], string> = {
  learned: 'Learned',
  changed: 'Changed',
  corrected: 'You corrected',
  restored: 'Rewound',
  removed: 'Set aside',
};

const failed = (r: { error: string | null; unavailable: string | null }, fallback: string) =>
  toast({ kind: 'err', title: r.error ?? r.unavailable ?? fallback });

/** Where a source link goes: the conversation it was said in, or the one its receipt is in. */
const linkHref = (link: NonNullable<Belief['source']['link']>) => href(`/chat/${link.id}`);

function SourceLine({ source }: { source: Belief['source'] }) {
  const text = source.text.charAt(0).toUpperCase() + source.text.slice(1);
  return source.link ? (
    <a className="belief-source" href={linkHref(source.link)} title={source.link.label}>
      {text}
      <Icon name="arrowUpRight" size={12} />
    </a>
  ) : (
    <span className="belief-source">{text}</span>
  );
}

function EditForm({
  label,
  initial,
  onSave,
  onCancel,
}: {
  label: string;
  initial: string;
  onSave: (value: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="belief-edit"
      onSubmit={(event) => {
        event.preventDefault();
        const next = value.trim();
        if (!next || saving) return;
        setSaving(true);
        void onSave(next).finally(() => setSaving(false));
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        width="100%"
        height={34}
        aria-label={`New value for ${label}`}
        autoFocus
      />
      <div className="row" style={{ gap: 6 }}>
        <Button size="sm" type="submit" loading={saving} disabled={saving}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function BeliefRow({
  belief,
  highlighted,
  onChanged,
  onRemoved,
}: {
  belief: Belief;
  highlighted: boolean;
  onChanged: () => void;
  onRemoved: (message: string) => void;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'forget'>('view');
  const [history, setHistory] = useState<BeliefHistory | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  // Closing an inline form hands focus back to the row's first action.
  const closeEdit = () => {
    setMode('view');
    row.current?.querySelector<HTMLButtonElement>('.belief-actions button')?.focus();
  };
  useEffect(() => {
    if (highlighted) row.current?.scrollIntoView({ block: 'center' });
  }, [highlighted]);
  const toggleHistory = () => {
    if (historyOpen) return setHistoryOpen(false);
    void adapter.beliefHistory(belief.id).then((r) => {
      if (!r.data) return failed(r, 'Couldn’t load its history');
      setHistory(r.data);
      setHistoryOpen(true);
    });
  };
  return (
    <div
      ref={row}
      className="belief-row"
      id={`belief-${belief.id}`}
      data-highlight={highlighted ? 'true' : undefined}
    >
      <div className="belief-main">
        <span className="belief-label">{belief.label}</span>
        {mode === 'edit' ? (
          <EditForm
            label={belief.label}
            initial={belief.value}
            onCancel={closeEdit}
            onSave={async (value) => {
              const r = await adapter.editMemory(belief.id, value, belief.version);
              if (r.data === null) {
                failed(r, 'Couldn’t save the correction');
                return false;
              }
              setMode('view');
              setHistoryOpen(false);
              toast({ kind: 'ok', title: 'Corrected', sub: 'Your words replace what I had.' });
              onChanged();
              return true;
            }}
          />
        ) : (
          <span className="belief-value">{belief.value}</span>
        )}
        <span className="belief-meta">
          <SourceLine source={belief.source} />
          <Badge tone={TRUST_TONE[belief.trust]} style={{ height: 20, fontSize: 11 }}>
            <span title={belief.trust_label}>{TRUST_SHORT[belief.trust]}</span>
          </Badge>
          {belief.disputed ? (
            <Badge tone="danger" style={{ height: 20, fontSize: 11 }}>
              Two answers disagree
            </Badge>
          ) : null}
        </span>
        {historyOpen && history ? (
          <ol className="belief-history" aria-label={`Earlier versions of ${belief.label}`}>
            {history.versions.map((version) => (
              <li
                key={`${version.at}-${version.value}`}
                data-current={version.current || undefined}
              >
                <span className="belief-history-value">{version.value}</span>
                <span className="belief-history-meta">
                  {version.current ? 'Now · ' : ''}
                  {version.source.text}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
        {mode === 'forget' ? (
          <fieldset className="belief-confirm">
            <legend>Forget this? It is erased, not hidden.</legend>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <Button
                size="sm"
                variant="destructive"
                autoFocus
                onClick={() =>
                  void adapter.deleteMemory(belief.id).then((r) => {
                    if (r.data === null) return failed(r, 'Couldn’t forget that');
                    onRemoved(`Forgot “${belief.label}”`);
                  })
                }
              >
                Forget
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void adapter.blockBelief(belief.id).then((r) => {
                    if (r.data === null) return failed(r, 'Couldn’t forget that');
                    onRemoved(`Forgot “${belief.label}” and won’t learn it again`);
                  })
                }
              >
                Forget and don’t learn again
              </Button>
              <Button size="sm" variant="ghost" onClick={closeEdit}>
                Keep it
              </Button>
            </div>
          </fieldset>
        ) : null}
      </div>
      <div className="belief-actions">
        <IconButton
          name="pencil"
          label={`Correct ${belief.label}`}
          size={30}
          iconSize={14}
          onClick={() => setMode(mode === 'edit' ? 'view' : 'edit')}
          on={mode === 'edit'}
        />
        {belief.earlier > 0 ? (
          <IconButton
            name="clock"
            label={`History of ${belief.label}`}
            size={30}
            iconSize={14}
            onClick={toggleHistory}
            on={historyOpen}
            aria-expanded={historyOpen}
          />
        ) : null}
        <IconButton
          name="trash"
          label={`Forget ${belief.label}`}
          size={30}
          iconSize={14}
          onClick={() => setMode(mode === 'forget' ? 'view' : 'forget')}
          on={mode === 'forget'}
        />
      </div>
    </div>
  );
}

function BeliefsView({ focus }: { focus: string | null }) {
  const beliefs = useLoad(() => adapter.beliefs(), []);
  const blocks = useLoad(() => adapter.beliefBlocks(), []);
  const [filter, setFilter] = useState<BeliefCategory | 'all'>('all');
  const list = beliefs.data?.beliefs ?? [];
  const counts = new Map<BeliefCategory, number>();
  for (const belief of list) counts.set(belief.category, (counts.get(belief.category) ?? 0) + 1);
  const shown = CATEGORY_ORDER.filter(
    (category) => (counts.get(category) ?? 0) > 0 && (filter === 'all' || filter === category),
  );
  return (
    <div className="col" style={{ gap: 18 }}>
      {list.length ? (
        <fieldset className="belief-filters">
          <legend className="sr-only">Show beliefs about</legend>
          <Chip on={filter === 'all'} onClick={() => setFilter('all')}>
            All {list.length}
          </Chip>
          {CATEGORY_ORDER.filter((category) => counts.get(category)).map((category) => (
            <Chip key={category} on={filter === category} onClick={() => setFilter(category)}>
              {CATEGORY_TITLE[category]} {counts.get(category)}
            </Chip>
          ))}
        </fieldset>
      ) : null}
      {beliefs.error || beliefs.unavailable ? (
        <p className="belief-error">{beliefs.error ?? beliefs.unavailable}</p>
      ) : null}
      {shown.map((category) => (
        <section
          key={category}
          className="col"
          style={{ gap: 8 }}
          aria-labelledby={`bc-${category}`}
        >
          <h3 id={`bc-${category}`} className="belief-group">
            {CATEGORY_TITLE[category]}
          </h3>
          <div className="card-12 belief-list">
            {list
              .filter((belief) => belief.category === category)
              .map((belief) => (
                <BeliefRow
                  key={`${belief.id}:${belief.version}`}
                  belief={belief}
                  highlighted={focus === belief.id}
                  onChanged={beliefs.reload}
                  onRemoved={(message) => {
                    toast({ kind: 'ok', title: message });
                    beliefs.reload();
                    blocks.reload();
                  }}
                />
              ))}
          </div>
        </section>
      ))}
      {beliefs.data && list.length === 0 ? (
        <div className="card-12 belief-empty">
          <span className="belief-empty-title">Nothing learned yet</span>
          <span>Melete adds to this as you talk, and tells you when it does.</span>
        </div>
      ) : null}
      {(blocks.data?.blocks.length ?? 0) > 0 ? (
        <section className="col" style={{ gap: 8 }} aria-labelledby="bc-blocked">
          <h3 id="bc-blocked" className="belief-group">
            Not learning again
          </h3>
          <div className="card-12 belief-list">
            {blocks.data?.blocks.map((block) => (
              <div key={block.id} className="belief-row">
                <div className="belief-main">
                  <span className="belief-value">{block.label}</span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void adapter.unblockBelief(block.id).then((r) => {
                      if (r.data === null) return failed(r, 'Couldn’t change that');
                      toast({ kind: 'ok', title: `I can learn “${block.label}” again` });
                      blocks.reload();
                    })
                  }
                >
                  Allow again
                </Button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function RewindPreviewPanel({
  target,
  onDone,
  onCancel,
}: {
  target: RewindTarget;
  onDone: (rewind: MemoryRewind) => void;
  onCancel: () => void;
}) {
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const [working, setWorking] = useState(false);
  useEffect(() => {
    void adapter.previewRewind(target).then((r) => {
      if (!r.data) {
        failed(r, 'Couldn’t prepare the undo');
        onCancel();
        return;
      }
      setPreview(r.data);
    });
  }, [target, onCancel]);
  if (!preview) return <div className="rewind-panel">Checking what would change…</div>;
  return (
    <section className="rewind-panel" aria-label={preview.label}>
      <span className="rewind-title">{preview.label}</span>
      {preview.steps.length ? (
        <ul className="rewind-steps">
          {preview.steps.map((step) => (
            <li key={step.belief_id}>
              <span className="rewind-label">{step.label}</span>
              <span className="rewind-change">
                <s>{step.from}</s>
                <Icon name="arrowDown" size={12} />
                {step.to ?? <em>not known any more</em>}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <span className="belief-note">Nothing from that day is still in effect.</span>
      )}
      {preview.skipped.map((line) => (
        <span key={line} className="belief-note">
          {line}
        </span>
      ))}
      <div className="row" style={{ gap: 6 }}>
        {preview.steps.length ? (
          <Button
            size="sm"
            loading={working}
            disabled={working}
            autoFocus
            onClick={() => {
              setWorking(true);
              void adapter.rewind(target).then((r) => {
                setWorking(false);
                if (!r.data) return failed(r, 'Couldn’t undo that');
                onDone(r.data.rewind);
              });
            }}
          >
            Undo {preview.steps.length} {preview.steps.length === 1 ? 'change' : 'changes'}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

function undoRewind(rewind: MemoryRewind, after: () => void) {
  void adapter.undoRewind(rewind.id).then((r) => {
    if (!r.data) return failed(r, 'Couldn’t restore that');
    toast({
      kind: 'ok',
      title: 'Put back as it was',
      sub: r.data.rewind.skipped.at(-1),
    });
    after();
  });
}

function TimelineView() {
  const timeline = useLoad(() => adapter.memoryTimeline(30), []);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const days = timeline.data?.days ?? [];
  const cancel = useRef(() => setPreviewing(null)).current;
  return (
    <div className="col" style={{ gap: 14 }}>
      <p className="belief-intro">
        What I learned each day. Undo a day and everything learned or changed that day goes back to
        how it was; you can put it back again.
      </p>
      {timeline.error ? <p className="belief-error">{timeline.error}</p> : null}
      {days.map((day) => {
        const target = { day: day.day };
        return (
          <section
            key={day.day}
            className="card-12 timeline-day"
            aria-labelledby={`day-${day.day}`}
          >
            <div className="timeline-head">
              <h3 id={`day-${day.day}`}>{day.label}</h3>
              <span className="belief-note">
                {day.changes.length} {day.changes.length === 1 ? 'change' : 'changes'}
              </span>
              <div className="grow" />
              {day.changes.length ? (
                <Button
                  size="sm"
                  variant="outline"
                  icon="refresh"
                  onClick={() => setPreviewing(previewing === day.day ? null : day.day)}
                  aria-expanded={previewing === day.day}
                >
                  Undo this day
                </Button>
              ) : null}
            </div>
            {previewing === day.day ? (
              <RewindPreviewPanel
                target={target}
                onCancel={cancel}
                onDone={(rewind) => {
                  setPreviewing(null);
                  toast({
                    kind: 'ok',
                    title: `Undid ${rewind.steps.length} ${rewind.steps.length === 1 ? 'change' : 'changes'}`,
                    action: 'Put back',
                    onAction: () => undoRewind(rewind, timeline.reload),
                  });
                  timeline.reload();
                }}
              />
            ) : null}
            <ul className="timeline-changes">
              {day.changes.map((change) => (
                <li key={`${change.belief_id}-${change.at}`}>
                  <Badge
                    tone={change.change === 'corrected' ? 'success' : 'neutral'}
                    style={{ height: 20, fontSize: 11 }}
                  >
                    {CHANGE_WORD[change.change]}
                  </Badge>
                  <span className="timeline-text">
                    <strong>{change.label}</strong>: {change.value ?? '—'}
                    {change.previous && change.change !== 'learned' ? (
                      <span className="belief-note"> (was {change.previous})</span>
                    ) : null}
                  </span>
                </li>
              ))}
              {day.rewinds.map((rewind) => (
                <li key={rewind.id} className="timeline-rewind">
                  <Badge tone="outline" style={{ height: 20, fontSize: 11 }}>
                    {rewind.undone_at ? 'Put back' : 'Undid'}
                  </Badge>
                  <span className="timeline-text">
                    {rewind.label} · {rewind.steps.length}{' '}
                    {rewind.steps.length === 1 ? 'belief' : 'beliefs'}
                  </span>
                  {rewind.undone_at ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => undoRewind(rewind, timeline.reload)}
                    >
                      Put back
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {timeline.data && days.length === 0 ? (
        <div className="card-12 belief-empty">
          <span className="belief-empty-title">Nothing learned in the last 30 days</span>
        </div>
      ) : null}
    </div>
  );
}

function DigestCard({ digest, onClose }: { digest: MemoryDigest; onClose: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [items, setItems] = useState(digest.items);
  const [previewing, setPreviewing] = useState<RewindTarget | null>(null);
  const cancel = useRef(() => setPreviewing(null)).current;
  return (
    <section className="digest" aria-labelledby="digest-title">
      <div className="timeline-head">
        <Icon name="sparkles" size={16} />
        <h2 id="digest-title">{digest.title}</h2>
        <div className="grow" />
        <IconButton
          name="x"
          label="Dismiss this week’s summary"
          size={28}
          iconSize={14}
          onClick={onClose}
        />
      </div>
      <ul className="digest-items">
        {items.map((item) => (
          <li key={item.belief_id}>
            <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
              <span className="timeline-text">
                <strong>{item.label}</strong>: {item.value}
              </span>
              <span className="belief-note">
                {item.change === 'learned'
                  ? 'New this week'
                  : item.change === 'corrected'
                    ? `You corrected it${item.previous ? ` (was ${item.previous})` : ''}`
                    : `Changed${item.previous ? ` from ${item.previous}` : ''}`}
                {item.current ? '' : ' · changed again since'}
              </span>
              {editing === item.belief_id && item.version ? (
                <EditForm
                  label={item.label}
                  initial={item.value}
                  onCancel={() => setEditing(null)}
                  onSave={async (value) => {
                    const r = await adapter.editMemory(item.belief_id, value, item.version ?? '');
                    if (r.data === null) {
                      failed(r, 'Couldn’t save the correction');
                      return false;
                    }
                    setEditing(null);
                    setItems((all) =>
                      all.map((entry) =>
                        entry.belief_id === item.belief_id
                          ? { ...entry, value, change: 'corrected', current: false, version: null }
                          : entry,
                      ),
                    );
                    toast({ kind: 'ok', title: 'Corrected' });
                    return true;
                  }}
                />
              ) : null}
              {previewing &&
              'belief_id' in previewing &&
              previewing.belief_id === item.belief_id ? (
                <RewindPreviewPanel
                  target={previewing}
                  onCancel={cancel}
                  onDone={(rewind) => {
                    setPreviewing(null);
                    setItems((all) =>
                      all.map((entry) =>
                        entry.belief_id === item.belief_id
                          ? { ...entry, current: false, version: null }
                          : entry,
                      ),
                    );
                    toast({
                      kind: 'ok',
                      title: `Undid “${item.label}”`,
                      action: 'Put back',
                      onAction: () => undoRewind(rewind, () => {}),
                    });
                  }}
                />
              ) : null}
            </div>
            {item.current ? (
              <div className="row" style={{ gap: 4 }}>
                <Button size="sm" variant="ghost" onClick={() => setEditing(item.belief_id)}>
                  Correct
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setPreviewing({ belief_id: item.belief_id, since: digest.window_start })
                  }
                >
                  Undo
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function PortableActions({ onImported }: { onImported: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  const exportAs = (format: 'json' | 'markdown') =>
    void adapter.exportBeliefs(format).then((r) => {
      if (!r.data) return failed(r, 'Couldn’t export');
      download(
        r.data.filename,
        r.data.content,
        format === 'json' ? 'application/json' : 'text/markdown',
      );
    });
  return (
    <div className="row belief-portable">
      <Button size="sm" variant="outline" icon="arrowDown" onClick={() => exportAs('json')}>
        Export JSON
      </Button>
      <Button size="sm" variant="outline" icon="fileText" onClick={() => exportAs('markdown')}>
        Export Markdown
      </Button>
      <Button size="sm" variant="ghost" icon="upload" onClick={() => file.current?.click()}>
        Import
      </Button>
      <input
        ref={file}
        type="file"
        accept=".json,.md,.markdown,application/json,text/markdown"
        hidden
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          event.target.value = '';
          if (!chosen) return;
          void chosen.text().then((content) =>
            adapter
              .importBeliefs({
                format: /\.(md|markdown)$/i.test(chosen.name) ? 'markdown' : 'json',
                content,
              })
              .then((r) => {
                if (!r.data) return failed(r, 'Couldn’t import that file');
                toast({
                  kind: 'ok',
                  title: `Imported ${r.data.imported} ${r.data.imported === 1 ? 'belief' : 'beliefs'}`,
                  sub: r.data.skipped
                    ? `${r.data.skipped} already known or kept as you had them.`
                    : undefined,
                });
                onImported();
              }),
          );
        }}
      />
    </div>
  );
}

type View = 'beliefs' | 'timeline' | 'lessons';

export function MemoryPanel(): ReactNode {
  const route = useRoute();
  const view =
    (['beliefs', 'timeline', 'lessons'] as const).find(
      (value) => value === route.query.get('view'),
    ) ?? 'beliefs';
  const focus = route.query.get('belief');
  const digest = useLoad(() => adapter.memoryDigest(), []);
  const [reloadKey, setReloadKey] = useState(0);
  const current = digest.data?.digest;
  const showDigest = current && !current.seen_at && current.items.length > 0;
  return (
    <div className="col" style={{ gap: 20 }}>
      <div className="row belief-head">
        <div className="col grow" style={{ gap: 4, minWidth: 220 }}>
          <h2 className="belief-title">What I believe about you</h2>
          <p className="belief-intro">
            Grouped by what it’s about, with where each came from. Correct anything, forget it, or
            tell me not to learn it again. It stays yours whichever model you use.
          </p>
        </div>
        <PortableActions onImported={() => setReloadKey((n) => n + 1)} />
      </div>
      {showDigest && current ? (
        <DigestCard
          digest={current}
          onClose={() => void adapter.digestSeen(current.id).then(digest.reload)}
        />
      ) : null}
      <TabsUnderline
        label="Memory"
        value={view}
        onChange={(next: View) =>
          navigate(`/settings/memory${next === 'beliefs' ? '' : `?view=${next}`}`)
        }
        tabs={[
          { value: 'beliefs', label: 'Beliefs' },
          { value: 'timeline', label: 'Timeline' },
          { value: 'lessons', label: 'Lessons and skills' },
        ]}
      />
      {view === 'beliefs' ? (
        <BeliefsView key={reloadKey} focus={focus} />
      ) : view === 'timeline' ? (
        <TimelineView key={reloadKey} />
      ) : (
        <LearnedTab />
      )}
    </div>
  );
}
