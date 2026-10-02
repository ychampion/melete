/**
 * Agents: Melete, who is always here and can use everything, and a face for
 * each specialist job. Profiles, a wall of faces to pick from, templates, and
 * an editor with Look, Behaviour and Access, all on the contract's agent
 * record. The nine face states derive from turn status.
 */
import { freeAgentName } from '@melete/contracts/mention';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { logoFor } from '../chat/parts.tsx';
import {
  AgentFace,
  FACE_PALETTE,
  FACE_SHAPES,
  FACE_STATES,
  type FaceShape,
} from '../design/face.tsx';
import { Icon } from '../design/icons.tsx';
import { LoadError } from '../design/LoadError.tsx';
import { Logo } from '../design/logos.tsx';
import { MeleteAvatar } from '../design/mark.tsx';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  Field,
  IconButton,
  Input,
  Overline,
  Segmented,
  Select,
  Toggle,
} from '../design/primitives.tsx';
import { AgentAvatar } from '../experience/AgentAvatar.tsx';
import { adapter } from '../experience/adapter.ts';
import { lookOf, useApp, useLoad } from '../experience/hooks.ts';
import type { Agent, AgentInput, AgentTemplate, Connection } from '../experience/types.ts';
import { href, navigate } from '../router.ts';
import { Shell, toast } from '../shell/Shell.tsx';
import { LibraryShelf, TemplateSheet, WelcomeSheet } from './AgentLibrary.tsx';
import { draftKey, followSaved } from './agent-draft.ts';
import { suggests, WORKS_WITH, type WorksWith } from './agent-library.ts';

const ROLES = [
  'Concierge',
  'Coach',
  'Researcher',
  'Helper',
  'Planner',
  'Travel concierge',
  'Study buddy',
  'Assistant',
];
const TONES = [
  'Warm',
  'Direct',
  'Playful',
  'Calm and practical',
  'Warm and concise',
  'Patient and encouraging',
];
const WHITE = '#ffffff';
const BLACK = '#16181d';

export const blankAgent = (): AgentInput => ({
  name: '',
  role: 'Assistant',
  colour: FACE_PALETTE[7],
  surface: 'blob',
  eye_colour: WHITE,
  tone: 'Warm',
  standing_instruction: '',
  allowed_connection_ids: null,
  asks_before_acting: true,
  uses_computer: true,
  reads_memory: true,
  writes_memory: true,
});

/** What an agent may use besides its connections, in a few words. */
export function reachWords(agent: Pick<Agent, 'uses_computer' | 'reads_memory' | 'writes_memory'>) {
  const memory =
    agent.reads_memory && agent.writes_memory
      ? 'remembers'
      : agent.reads_memory
        ? 'reads memory only'
        : agent.writes_memory
          ? 'keeps memory, reads none'
          : 'no memory';
  return `${agent.uses_computer ? 'uses the computer' : 'no computer'} · ${memory}`;
}

/** Null reaches every connection, including ones connected later. */
export const reaches = (ids: string[] | null, id: string) => ids === null || ids.includes(id);

/** Ticking the last one back returns to every connection, so later ones are included again. */
export function toggleReach(ids: string[] | null, id: string, on: boolean, all: string[]) {
  const current = ids ?? all;
  const next = on ? [...current, id] : current.filter((item) => item !== id);
  return all.every((item) => next.includes(item)) ? null : next;
}

const toSurface = (shape: FaceShape): AgentInput['surface'] =>
  shape === 'square' ? 'rounded' : shape;

const shuffle = (): Pick<AgentInput, 'colour' | 'surface' | 'eye_colour'> => ({
  colour: FACE_PALETTE[Math.floor(Math.random() * FACE_PALETTE.length)] ?? FACE_PALETTE[0],
  surface: toSurface(FACE_SHAPES[Math.floor(Math.random() * FACE_SHAPES.length)]?.[0] ?? 'blob'),
  eye_colour: Math.random() > 0.5 ? WHITE : BLACK,
});

/** Ink that reads on a swatch: dark on light colours, white on deep ones. */
const inkOn = (hex: string) => {
  const value = hex.replace('#', '');
  const luminance =
    Number.parseInt(value.slice(0, 2), 16) * 0.299 +
    Number.parseInt(value.slice(2, 4), 16) * 0.587 +
    Number.parseInt(value.slice(4, 6), 16) * 0.114;
  return luminance > 150 ? BLACK : WHITE;
};

export function LookFields({
  draft,
  onChange,
}: {
  draft: AgentInput;
  onChange: (next: AgentInput) => void;
}) {
  const shapeOf = (surface: AgentInput['surface']): FaceShape =>
    surface === 'rounded' ? 'square' : surface;
  // A colour set elsewhere still shows, first and selected, so the picker never hides it.
  const current = draft.colour.toLowerCase();
  const colours: string[] = FACE_PALETTE.some((color) => color === current)
    ? [...FACE_PALETTE]
    : [current, ...FACE_PALETTE];
  const white = draft.eye_colour.toLowerCase() === WHITE;
  return (
    <>
      <fieldset className="field-group col" style={{ gap: 8 }}>
        <legend className="overline">Colour</legend>
        <div className="look-swatches" style={{ gridTemplateColumns: 'repeat(6, minmax(0, 1fr))' }}>
          {colours.map((color) => {
            const on = color === current;
            return (
              <button
                key={color}
                type="button"
                aria-label={`Colour ${color}`}
                aria-pressed={on}
                className="look-swatch"
                style={{ background: color, color: inkOn(color) }}
                onClick={() => onChange({ ...draft, colour: color })}
              >
                {on ? <Icon name="check" size={14} stroke={2.5} /> : null}
              </button>
            );
          })}
        </div>
      </fieldset>
      <fieldset className="field-group col" style={{ gap: 8 }}>
        <legend className="overline">Surface</legend>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {FACE_SHAPES.map(([key, label]) => {
            const on = shapeOf(draft.surface) === key;
            return (
              <button
                key={key}
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={on}
                className="look-tile"
                onClick={() => onChange({ ...draft, surface: toSurface(key) })}
              >
                <AgentFace look={{ color: draft.colour, eyes: 'none', shape: key }} size={26} />
              </button>
            );
          })}
        </div>
      </fieldset>
      <fieldset className="field-group col" style={{ gap: 8 }}>
        <legend className="overline">Eyes</legend>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {(
            [
              ['white', 'White', WHITE],
              ['black', 'Black', BLACK],
            ] as const
          ).map(([key, label, ink]) => {
            const on = (key === 'white') === white;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={on}
                className="look-tile"
                data-wide="true"
                onClick={() => onChange({ ...draft, eye_colour: ink })}
              >
                <AgentFace
                  look={{
                    color: draft.colour,
                    eyes: key,
                    eyeColor: ink,
                    shape: shapeOf(draft.surface),
                  }}
                  size={26}
                />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </fieldset>
    </>
  );
}

/** A switch on its own row: a title, one line of what it means, and the toggle. */
function SwitchRow({
  title,
  hint,
  on,
  onChange,
}: {
  title: string;
  hint: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div
      className="row"
      style={{
        gap: 12,
        padding: '12px 14px',
        borderRadius: 12,
        background: 'var(--soft)',
        border: '1px solid var(--line)',
      }}
    >
      <div className="col grow" style={{ gap: 1 }}>
        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>{title}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{hint}</span>
      </div>
      <Toggle on={on} label={title} onChange={onChange} />
    </div>
  );
}

function AgentEditor({
  agentId,
  isDefault = false,
  fixedReach = false,
  initial,
  connections,
  connectionsError = null,
  onRetryConnections,
  onSaved,
  onClose,
  onDelete,
  worksWith,
}: {
  agentId: string | null;
  /** Melete: its name and reach are fixed, so only how it sounds is edited. */
  isDefault?: boolean;
  /** Melete in a personal space: it reaches everything, and that is not edited. */
  fixedReach?: boolean;
  initial: AgentInput;
  connections: Connection[];
  /** Why the connections could not be read; the Access tab says so instead of "none". */
  connectionsError?: string | null;
  onRetryConnections?: () => void;
  onSaved: (agent: Agent) => void;
  onClose: () => void;
  /** Asks to delete this agent; given for agents other than Melete. */
  onDelete?: () => void;
  /** For a library agent: the kinds it works best with, marked on its connections, never ticked. */
  worksWith?: readonly WorksWith[];
}) {
  const [draft, setDraft] = useState<AgentInput>(initial);
  const panelRef = useRef<HTMLElement>(null);
  // Focus moves into the drawer when it opens: to the name on a new agent, so
  // it can be named straight away, otherwise to the drawer itself.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const name = agentId
      ? null
      : panel.querySelector<HTMLInputElement>('input[aria-label="Agent name"]');
    (name ?? panel).focus({ preventScroll: true });
    name?.select();
  }, [agentId]);
  const onPanelKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    // A list open inside the drawer takes the first Escape itself.
    if (panelRef.current?.querySelector('[aria-expanded="true"]')) return;
    event.preventDefault();
    onClose();
  };
  const [tab, setTab] = useState<'look' | 'behaviour' | 'access'>(isDefault ? 'behaviour' : 'look');
  const [state, setState] = useState<(typeof FACE_STATES)[number][0]>('idle');
  const [busy, setBusy] = useState(false);
  // A background refresh hands a new copy of the same agent; only a real change
  // to the saved agent moves the draft, and never over a field being edited.
  const saved = useRef(initial);
  useEffect(() => {
    const previous = saved.current;
    saved.current = initial;
    if (previous !== initial) setDraft((current) => followSaved(current, previous, initial));
  }, [initial]);
  const look = lookOf(draft);

  const save = () => {
    if (!draft.name.trim()) {
      toast({ kind: 'err', title: 'Give the agent a name first.' });
      return;
    }
    setBusy(true);
    const body = { ...draft, name: draft.name.trim() };
    void (agentId ? adapter.updateAgent(agentId, body) : adapter.createAgent(body)).then(
      (result) => {
        setBusy(false);
        if (result.data === null)
          toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t save' });
        else onSaved(result.data.agent);
      },
    );
  };

  return (
    <aside
      ref={panelRef}
      className="side-panel"
      style={{ width: 420, maxWidth: '100%' }}
      aria-label={agentId ? `Edit ${draft.name}` : 'New agent'}
      tabIndex={-1}
      onKeyDown={onPanelKey}
    >
      <div
        className="row"
        style={{
          gap: 8,
          height: 48,
          padding: '0 12px 0 20px',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <span
          className="grow clamp1"
          style={{
            fontFamily: 'var(--font-head)',
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--heading)',
          }}
        >
          {draft.name || 'New agent'}
        </span>
        <Segmented
          label="Section"
          value={tab}
          onChange={setTab}
          options={[
            ...(isDefault ? [] : [{ value: 'look' as const, label: 'Look' }]),
            { value: 'behaviour', label: 'Behaviour' },
            { value: 'access', label: 'Access' },
          ]}
        />
        <IconButton name="x" label="Close" onClick={onClose} />
      </div>
      <div className="panel-body">
        {tab === 'look' ? (
          <>
            <div
              className="col"
              style={{
                position: 'relative',
                height: 176,
                flexShrink: 0,
                borderRadius: 14,
                background: 'var(--studio)',
                backgroundImage:
                  'linear-gradient(#ffffff08 1px, transparent 1px), linear-gradient(90deg, #ffffff08 1px, transparent 1px)',
                backgroundSize: '22px 22px',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
              }}
            >
              <AgentFace look={look} size={112} state={state} glow />
              <div
                className="row"
                style={{
                  position: 'absolute',
                  left: 12,
                  bottom: 10,
                  height: 28,
                  padding: '0 12px',
                  borderRadius: 999,
                  background: 'var(--studio-panel)',
                  border: '1px solid var(--studio-line)',
                  fontSize: 12,
                  color: 'var(--studio-text)',
                  gap: 6,
                }}
              >
                <span style={{ fontWeight: 600 }}>
                  {FACE_STATES.find((s) => s[0] === state)?.[1]}
                </span>
                <span style={{ color: 'var(--studio-muted)' }}>· looping</span>
              </div>
              <div style={{ position: 'absolute', right: 12, bottom: 10 }}>
                <Button
                  size="sm"
                  variant="outline"
                  icon="shuffle"
                  onClick={() => setDraft({ ...draft, ...shuffle() })}
                >
                  Shuffle
                </Button>
              </div>
            </div>
            <div
              style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}
            >
              <div className="col" style={{ gap: 8 }}>
                <Overline>Agent name</Overline>
                <Input
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  width="100%"
                  aria-label="Agent name"
                  placeholder="Nova"
                  maxLength={40}
                />
              </div>
              <div className="col" style={{ gap: 8 }}>
                <Overline>Role</Overline>
                <Select
                  label="Role"
                  value={draft.role}
                  onChange={(role) => setDraft({ ...draft, role })}
                  width="100%"
                  options={[...new Set([...ROLES, draft.role])].map((role) => ({
                    value: role,
                    label: role,
                  }))}
                />
              </div>
            </div>
            <LookFields draft={draft} onChange={setDraft} />
            <div className="col" style={{ gap: 8 }}>
              <Overline>State · what people see while it works</Overline>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                  gap: 6,
                }}
              >
                {FACE_STATES.map(([key, label, sub]) => (
                  <button
                    key={key}
                    type="button"
                    className="look-tile"
                    data-state="true"
                    aria-pressed={state === key}
                    onClick={() => setState(key)}
                  >
                    <AgentFace look={look} size={26} state={key} />
                    <span className="col" style={{ minWidth: 0, alignItems: 'flex-start' }}>
                      <span
                        className="clamp1"
                        style={{ fontSize: 13, fontWeight: 600, color: 'var(--heading)' }}
                      >
                        {label}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{sub}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : tab === 'behaviour' ? (
          <>
            {isDefault ? (
              <div className="row" style={{ gap: 12 }}>
                <MeleteAvatar size={40} />
                <p style={{ fontSize: 13, color: 'var(--secondary)', lineHeight: '19px' }}>
                  Melete is always here. It takes every chat, routine and message from Home unless
                  you choose another agent, and its name stays Melete.
                </p>
              </div>
            ) : null}
            <Field label="Tone">
              <Select
                label="Tone"
                value={draft.tone}
                onChange={(tone) => setDraft({ ...draft, tone })}
                width="100%"
                options={[...new Set([...TONES, draft.tone])].map((tone) => ({
                  value: tone,
                  label: tone,
                }))}
              />
            </Field>
            <Field
              label="Standing instruction"
              hint="Its brief for every chat it handles. Up to 500 characters."
            >
              <textarea
                className="textarea"
                maxLength={500}
                rows={6}
                value={draft.standing_instruction}
                onChange={(event) =>
                  setDraft({ ...draft, standing_instruction: event.target.value })
                }
                placeholder="One option first, not five. Confirm before paying."
              />
            </Field>
            <SwitchRow
              title="Asks before acting"
              hint="Anything that sends, books or pays waits for your yes."
              on={draft.asks_before_acting}
              onChange={(on) => setDraft({ ...draft, asks_before_acting: on })}
            />
          </>
        ) : fixedReach ? (
          <p style={{ fontSize: 13, color: 'var(--secondary)', lineHeight: '19px' }}>
            Melete can use everything you connect, including what you connect later, the computer
            and what it remembers about you. To keep something narrower, make an agent for that job
            and choose what it can use.
          </p>
        ) : (
          <>
            <SwitchRow
              title="Uses the computer"
              hint="The agent's computer and your paired computers."
              on={draft.uses_computer ?? true}
              onChange={(on) => setDraft({ ...draft, uses_computer: on })}
            />
            <SwitchRow
              title="Reads memory"
              hint="What Melete remembers about you is brought into its work."
              on={draft.reads_memory ?? true}
              onChange={(on) => setDraft({ ...draft, reads_memory: on })}
            />
            <SwitchRow
              title="Keeps memory"
              hint="What you tell it is remembered for later."
              on={draft.writes_memory ?? true}
              onChange={(on) => setDraft({ ...draft, writes_memory: on })}
            />
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>
              Connections are per agent. Tick what this one may look at; with everything ticked, it
              also reaches what you connect later.
            </p>
            {worksWith?.length ? (
              <p style={{ fontSize: 13, color: 'var(--secondary)' }}>
                Works best with{' '}
                {worksWith.map((kind) => WORKS_WITH[kind].label.toLowerCase()).join(', ')}. Nothing
                is ticked for you.
              </p>
            ) : null}
            <div className="col" style={{ gap: 6 }}>
              {connections.map((connection) => {
                const on = reaches(draft.allowed_connection_ids, connection.id);
                const logo = logoFor(connection.app);
                return (
                  <div
                    key={connection.id}
                    className="row"
                    style={{
                      gap: 12,
                      padding: '10px 12px',
                      borderRadius: 12,
                      border: '1px solid var(--line)',
                      background: 'var(--surface)',
                    }}
                  >
                    {logo ? (
                      <Logo name={logo} size={32} />
                    ) : (
                      <span
                        className="row"
                        style={{
                          justifyContent: 'center',
                          width: 32,
                          height: 32,
                          borderRadius: 8,
                          background: 'var(--blue-soft)',
                          color: 'var(--blue-ink)',
                        }}
                      >
                        <Icon name="connectors" size={16} />
                      </span>
                    )}
                    <span className="col grow" style={{ minWidth: 0 }}>
                      <span
                        className="row"
                        style={{ gap: 6, fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}
                      >
                        {connection.label}
                        {worksWith && suggests(worksWith, connection.app) ? (
                          <span className="library-suggested">Suggested</span>
                        ) : null}
                      </span>
                      <span className="clamp1" style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {connection.app} ·{' '}
                        {connection.access === 'draft_only'
                          ? 'Draft only · you always send'
                          : connection.access === 'read_only'
                            ? 'Read only'
                            : 'Asks before acting'}
                      </span>
                    </span>
                    <Checkbox
                      checked={on}
                      label={connection.label}
                      onChange={(next) =>
                        setDraft({
                          ...draft,
                          allowed_connection_ids: toggleReach(
                            draft.allowed_connection_ids,
                            connection.id,
                            next,
                            connections.map((item) => item.id),
                          ),
                        })
                      }
                    />
                  </div>
                );
              })}
              {connectionsError && connections.length === 0 ? (
                <LoadError
                  what="your connections"
                  error={connectionsError}
                  onRetry={() => onRetryConnections?.()}
                />
              ) : connections.length === 0 ? (
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                  Nothing is connected yet.
                </span>
              ) : null}
            </div>
          </>
        )}
      </div>
      <div
        className="row"
        style={{ gap: 8, padding: '12px 20px 16px', borderTop: '1px solid var(--line)' }}
      >
        {agentId && !isDefault && onDelete ? (
          <Button variant="ghost" icon="trash" onClick={onDelete}>
            Delete
          </Button>
        ) : null}
        <div className="grow" />
        <Button loading={busy} onClick={save}>
          {agentId ? 'Save agent' : 'Create agent'}
        </Button>
      </div>
    </aside>
  );
}

const WALL = [
  ['#f4c430', 'blob'],
  ['#f26a4e', 'square'],
  ['#a43fc8', 'gear'],
  ['#18d3ef', 'diamond'],
  ['#5ab4a0', 'octagon'],
  ['#f3a4c8', 'blob'],
  ['#c92a2a', 'gear'],
  ['#c8c95a', 'square'],
  ['#0f8f7a', 'diamond'],
  ['#c9c1f5', 'blob'],
  ['#ec8a2b', 'octagon'],
  ['#f5dfb4', 'gear'],
  ['#18d3ef', 'square'],
  ['#a43fc8', 'blob'],
  ['#f4c430', 'diamond'],
  ['#5ab4a0', 'gear'],
] as const;

export const inputOf = (agent: Agent): AgentInput => ({
  name: agent.name,
  role: agent.role,
  colour: agent.colour,
  surface: agent.surface,
  eye_colour: agent.eye_colour,
  tone: agent.tone,
  standing_instruction: agent.standing_instruction,
  allowed_connection_ids: agent.allowed_connection_ids,
  asks_before_acting: agent.asks_before_acting,
  uses_computer: agent.uses_computer,
  reads_memory: agent.reads_memory,
  writes_memory: agent.writes_memory,
  ...(agent.face_image ? { face_image: agent.face_image } : {}),
});

const usedWhen = (agent: Agent): string => {
  if (!agent.usage.last_used) return 'Not used yet';
  const date = new Date(agent.usage.last_used);
  const day =
    date.toDateString() === new Date().toDateString()
      ? 'today'
      : date.toLocaleDateString('en-US', { weekday: 'long' });
  return `${agent.usage.conversations} chat${agent.usage.conversations === 1 ? '' : 's'} · used ${day}`;
};

export function AgentsScreen({ selected }: { selected: string | null }) {
  const { agents, refreshAgents } = useApp();
  const templates = useLoad(() => adapter.agentTemplates(), []);
  const connections = useLoad(() => adapter.connections(), []);
  const [wallSeed, setWallSeed] = useState(0);
  const [picked, setPicked] = useState<Pick<
    AgentInput,
    'colour' | 'surface' | 'eye_colour'
  > | null>(null);
  // A template the person chose opens as a draft to name and review; nothing
  // is made until they save it.
  const [seed, setSeed] = useState<AgentTemplate | null>(null);
  const [deleting, setDeleting] = useState<Agent | null>(null);
  const [removing, setRemoving] = useState(false);
  // A library template being read before it is added, and an agent just made
  // from one, whose routine and questions are offered next.
  const [viewing, setViewing] = useState<AgentTemplate | null>(null);
  const [welcome, setWelcome] = useState<{ agent: Agent; template: AgentTemplate } | null>(null);

  const wall = useMemo(() => {
    const items = WALL.map(([colour, shape], i) => ({
      colour,
      surface: toSurface(shape as FaceShape),
      eye_colour: (i + wallSeed) % 3 === 0 ? BLACK : WHITE,
    }));
    for (let i = 0; i < wallSeed % 7; i += 1) items.push(items.shift() as (typeof items)[number]);
    return items;
  }, [wallSeed]);

  const current =
    selected === 'new' ? null : (agents.find((agent) => agent.id === selected) ?? null);
  const key = draftKey(
    selected,
    selected === 'new'
      ? { ...blankAgent(), ...(seed?.agent ?? {}), ...(picked ?? {}) }
      : current
        ? inputOf(current)
        : null,
  );
  const initial = useMemo(
    () => (key === null ? null : (JSON.parse(key) as [string, AgentInput])[1]),
    [key],
  );

  // Back to the card that opened the drawer, so the keyboard picks up where it was.
  const closeTo = (id: string | null) => {
    navigate('/agents');
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(id ? `[data-agent-card="${id}"]` : '[data-new-agent]')
        ?.focus(),
    );
  };

  const remove = () => {
    if (!deleting) return;
    const gone = deleting;
    setRemoving(true);
    void adapter.deleteAgent(gone.id).then((result) => {
      setRemoving(false);
      if (result.data === null) {
        toast({ kind: 'err', title: 'Couldn’t delete', sub: result.error ?? result.unavailable });
        return;
      }
      setDeleting(null);
      const { conversations, routines, routines_paused: paused } = result.data;
      const moved = [
        conversations ? `${conversations} chat${conversations === 1 ? '' : 's'}` : '',
        routines ? `${routines} routine${routines === 1 ? '' : 's'}` : '',
      ].filter(Boolean);
      toast({
        kind: 'ok',
        title: `${gone.name} deleted`,
        sub: moved.length
          ? `Melete now looks after its ${moved.join(' and ')}.${paused ? ` ${paused === 1 ? 'The routine is' : 'They are'} paused until you turn ${paused === 1 ? 'it' : 'them'} back on.` : ''}`
          : undefined,
      });
      refreshAgents();
      templates.reload();
      closeTo(null);
    });
  };

  const editor = initial ? (
    <AgentEditor
      key={current?.id ?? `new-${seed?.id ?? 'blank'}`}
      agentId={current?.id ?? null}
      isDefault={current?.is_default === true}
      fixedReach={current?.fixed_reach === true}
      initial={initial}
      connections={connections.data?.connections.filter((c) => c.status === 'connected') ?? []}
      connectionsError={connections.error}
      onRetryConnections={connections.reload}
      onSaved={(agent) => {
        refreshAgents();
        templates.reload();
        // A new agent from the library goes on to its routine and questions.
        const from = !current && seed ? seed : null;
        setSeed(null);
        if (from && (from.starter_routine || from.questions.length))
          setWelcome({ agent, template: from });
        else toast({ kind: 'ok', title: `${agent.name} is ready.` });
        navigate(`/agents/${agent.id}`);
      }}
      onClose={() => closeTo(current?.id ?? null)}
      onDelete={current && !current.is_default ? () => setDeleting(current) : undefined}
      worksWith={!current && seed ? seed.works_best_with : undefined}
    />
  ) : undefined;

  const closeSheet = (id: string) => {
    setViewing(null);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-library-card="${id}"]`)?.focus(),
    );
  };

  const panel = welcome ? (
    <WelcomeSheet
      key={welcome.agent.id}
      agent={welcome.agent}
      template={welcome.template}
      onOpenAgent={() => {
        setWelcome(null);
        navigate(`/agents/${welcome.agent.id}`);
      }}
      onClose={() => {
        setWelcome(null);
        closeTo(welcome.agent.id);
      }}
    />
  ) : viewing && selected === null ? (
    <TemplateSheet
      key={viewing.id}
      template={viewing}
      onAdd={() => {
        setViewing(null);
        fromTemplate(viewing);
      }}
      onClose={() => closeSheet(viewing.id)}
    />
  ) : (
    editor
  );

  const fromTemplate = (template: AgentTemplate) => {
    // The suggested name is one no agent here has, so "@name" stays clear.
    const taken = agents.map((agent) => agent.name);
    setPicked(null);
    setSeed({
      ...template,
      agent: { ...template.agent, name: freeAgentName(template.agent.name, taken) },
    });
    navigate('/agents/new');
  };

  return (
    <Shell title="Agents" rail={false} panel={panel}>
      <div className="page" style={{ gap: 20 }}>
        <div className="page-head">
          <div className="col" style={{ gap: 4 }}>
            <h1>Agents</h1>
            <p style={{ fontSize: 14, color: 'var(--muted)', maxWidth: 520 }}>
              Melete handles everything by default. Give it a face for a particular job, with its
              own tone and only the tools it needs. Type @ and a name in any chat to ask one.
            </p>
          </div>
          <Button
            icon="plus"
            data-new-agent=""
            onClick={() => {
              setPicked(null);
              setSeed(null);
              setViewing(null);
              navigate('/agents/new');
            }}
          >
            New agent
          </Button>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: 12,
          }}
        >
          {agents.map((agent) => {
            const on = agent.id === selected;
            const allowed = (connections.data?.connections ?? []).filter((c) =>
              reaches(agent.allowed_connection_ids, c.id),
            );
            return (
              <a
                key={agent.id}
                data-agent-card={agent.id}
                className="card hoverable col"
                href={href(`/agents/${agent.id}`)}
                style={{
                  borderRadius: 14,
                  gap: 12,
                  padding: 16,
                  textDecoration: 'none',
                  color: 'inherit',
                  border: `1px solid ${on ? 'var(--primary)' : 'var(--line)'}`,
                  boxShadow: on ? 'inset 0 0 0 1px var(--primary)' : 'none',
                }}
              >
                <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                  <AgentAvatar agent={agent} size={48} />
                  <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
                    <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--heading)' }}>
                      {agent.name}{' '}
                      <span style={{ fontWeight: 400, color: 'var(--muted)' }}>· {agent.role}</span>
                    </span>
                    <span style={{ fontSize: 13, color: 'var(--secondary)', lineHeight: '18px' }}>
                      {agent.is_default
                        ? agent.standing_instruction ||
                          'Takes every chat unless you choose another agent.'
                        : agent.standing_instruction || agent.tone}
                    </span>
                  </div>
                  {agent.is_default ? <Badge>Always here</Badge> : null}
                </div>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span className="row" style={{ gap: 4 }}>
                    {allowed.slice(0, 5).map((c) => {
                      const logo = logoFor(c.app);
                      return logo ? (
                        <Logo key={c.id} name={logo} size={20} />
                      ) : (
                        <span
                          key={c.id}
                          className="row"
                          style={{
                            justifyContent: 'center',
                            width: 24,
                            height: 24,
                            borderRadius: 6,
                            background: 'var(--soft)',
                            border: '1px solid var(--line)',
                            color: 'var(--secondary)',
                          }}
                        >
                          <Icon name="connectors" size={13} />
                        </span>
                      );
                    })}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {agent.fixed_reach
                      ? 'reaches everything you connect'
                      : allowed.length
                        ? `reaches ${allowed.map((c) => c.label).join(', ')}`
                        : 'reaches nothing yet'}{' '}
                    · {reachWords(agent)}
                  </span>
                  <div className="grow" />
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{usedWhen(agent)}</span>
                </div>
              </a>
            );
          })}
        </div>
        {templates.data?.templates.length ? (
          <LibraryShelf
            templates={templates.data.templates}
            open={viewing && selected === null ? viewing.id : null}
            onOpen={(template) => {
              setWelcome(null);
              setViewing(template);
              if (selected !== null) navigate('/agents');
            }}
          />
        ) : null}
        <div
          className="col"
          style={{
            gap: 12,
            padding: 16,
            borderRadius: 14,
            background: 'var(--studio)',
            backgroundImage:
              'linear-gradient(#ffffff07 1px, transparent 1px), linear-gradient(90deg, #ffffff07 1px, transparent 1px)',
            backgroundSize: '22px 22px',
          }}
        >
          <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: '#d3d5da' }}>
              Need a face? Shuffle the wall and pick one.
            </span>
            <button
              type="button"
              className="row"
              style={{
                gap: 6,
                height: 28,
                padding: '0 10px',
                borderRadius: 999,
                background: '#1b1e22',
                border: '1px solid #2a2e33',
                fontSize: 12,
                fontWeight: 500,
                color: '#d3d5da',
              }}
              onClick={() => setWallSeed((n) => n + 1)}
            >
              <Icon name="shuffle" size={13} />
              Shuffle
            </button>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(64px, 1fr))',
              gap: 12,
            }}
          >
            {wall.map((look, i) => {
              const on = picked?.colour === look.colour && picked?.surface === look.surface;
              return (
                <button
                  key={`${look.colour}-${look.surface}`}
                  type="button"
                  aria-label={`Pick this ${look.surface} face`}
                  className="row"
                  style={{
                    justifyContent: 'center',
                    height: 64,
                    borderRadius: 10,
                    background: on ? '#1b1e22' : 'transparent',
                    border: `1px solid ${on ? '#3a3f46' : 'transparent'}`,
                  }}
                  onClick={() => {
                    setPicked(look);
                    setSeed(null);
                    setViewing(null);
                    navigate('/agents/new');
                  }}
                >
                  <AgentFace
                    look={lookOf({ ...look })}
                    size={44}
                    state={['idle', 'observing', 'thinking', 'done'][i % 4] as 'idle'}
                  />
                </button>
              );
            })}
          </div>
        </div>
        {templates.error ? <Badge tone="danger">{templates.error}</Badge> : null}
      </div>
      <Dialog
        open={deleting !== null}
        onClose={removing ? () => {} : () => setDeleting(null)}
        icon="trash"
        tone="danger"
        title={`Delete ${deleting?.name ?? 'this agent'}?`}
        sub={
          agents.find((agent) => agent.is_default)?.fixed_reach
            ? `Its chats move to Melete, which can use everything you've connected. Its routines are paused until you turn them back on. What ${deleting?.name ?? 'it'} said stays in those chats.`
            : `Its chats and routines move to Melete, which can use only what you've chosen for it here. What ${deleting?.name ?? 'it'} said stays in those chats.`
        }
        footer={
          <>
            <Button variant="outline" disabled={removing} onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" loading={removing} disabled={removing} onClick={remove}>
              Delete {deleting?.name ?? 'agent'}
            </Button>
          </>
        }
      />
    </Shell>
  );
}
