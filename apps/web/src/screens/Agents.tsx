/**
 * Agents: a face for each job. Profiles, a wall of faces to pick from,
 * templates, and an editor with Look, Behaviour and Access, all on the
 * contract's agent record. The nine face states derive from turn status.
 */
import { useEffect, useMemo, useState } from 'react';
import { logoFor } from '../chat/parts.tsx';
import {
  AgentFace,
  FACE_PALETTE,
  FACE_SHAPES,
  FACE_STATES,
  type FaceShape,
} from '../design/face.tsx';
import { Icon } from '../design/icons.tsx';
import { Logo } from '../design/logos.tsx';
import {
  Badge,
  Button,
  Checkbox,
  Field,
  IconButton,
  Input,
  Overline,
  Segmented,
  Select,
  Toggle,
} from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { lookOf, useApp, useLoad } from '../experience/hooks.ts';
import type { Agent, AgentInput, AgentTemplate, Connection } from '../experience/types.ts';
import { href, navigate } from '../router.ts';
import { Shell, toast } from '../shell/Shell.tsx';

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
});

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

export function LookFields({
  draft,
  onChange,
  compact = false,
}: {
  draft: AgentInput;
  onChange: (next: AgentInput) => void;
  compact?: boolean;
}) {
  return (
    <>
      <div className="col" style={{ gap: 8 }}>
        <Overline>Colour</Overline>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${compact ? 12 : 6}, minmax(0, 1fr))`,
            gap: 8,
          }}
        >
          {FACE_PALETTE.map((color) => {
            const on = color.toLowerCase() === draft.colour.toLowerCase();
            return (
              <button
                key={color}
                type="button"
                aria-label={`Colour ${color}`}
                aria-pressed={on}
                className="row"
                style={{
                  justifyContent: 'center',
                  height: compact ? 34 : 40,
                  borderRadius: 10,
                  background: color,
                  boxShadow: on ? '0 0 0 2px var(--surface), 0 0 0 4px var(--heading)' : 'none',
                }}
                onClick={() => onChange({ ...draft, colour: color })}
              >
                {on ? (
                  <span
                    style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--danger)' }}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto',
          gap: 12,
          alignItems: 'end',
        }}
      >
        <div className="col" style={{ gap: 8 }}>
          <Overline>Surface</Overline>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {FACE_SHAPES.map(([key, label]) => {
              const on = toSurface(key) === draft.surface;
              return (
                <button
                  key={key}
                  type="button"
                  title={label}
                  aria-label={label}
                  aria-pressed={on}
                  className="row"
                  style={{
                    justifyContent: 'center',
                    width: 48,
                    height: 44,
                    borderRadius: 10,
                    background: 'var(--soft)',
                    border: `1px solid ${on ? 'var(--primary)' : 'var(--line)'}`,
                    boxShadow: on ? 'inset 0 0 0 1px var(--primary)' : 'none',
                  }}
                  onClick={() => onChange({ ...draft, surface: toSurface(key) })}
                >
                  <AgentFace
                    look={{
                      color: on ? 'var(--heading)' : 'var(--control)',
                      eyes: 'none',
                      shape: key,
                    }}
                    size={22}
                  />
                </button>
              );
            })}
          </div>
        </div>
        <div className="col" style={{ gap: 8 }}>
          <Overline>Eyes</Overline>
          <Segmented
            label="Eyes"
            value={draft.eye_colour.toLowerCase() === WHITE ? 'white' : 'black'}
            onChange={(eyes) =>
              onChange({ ...draft, eye_colour: eyes === 'white' ? WHITE : BLACK })
            }
            options={[
              { value: 'white', label: 'White' },
              { value: 'black', label: 'Black' },
            ]}
          />
        </div>
      </div>
    </>
  );
}

function AgentEditor({
  agentId,
  initial,
  connections,
  onSaved,
  onClose,
}: {
  agentId: string | null;
  initial: AgentInput;
  connections: Connection[];
  onSaved: (agent: Agent) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<AgentInput>(initial);
  const [tab, setTab] = useState<'look' | 'behaviour' | 'access'>('look');
  const [state, setState] = useState<(typeof FACE_STATES)[number][0]>('idle');
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(initial), [initial]);
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
      className="side-panel"
      style={{ width: 420 }}
      aria-label={agentId ? `Edit ${draft.name}` : 'New agent'}
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
            { value: 'look', label: 'Look' },
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
                  background: '#1b1e22',
                  border: '1px solid #2a2e33',
                  fontSize: 12,
                  color: '#d3d5da',
                  gap: 6,
                }}
              >
                <span style={{ fontWeight: 600 }}>
                  {FACE_STATES.find((s) => s[0] === state)?.[1]}
                </span>
                <span style={{ color: '#8a8f98' }}>· looping</span>
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
                    className="row"
                    aria-pressed={state === key}
                    style={{
                      gap: 10,
                      height: 46,
                      padding: '0 10px',
                      borderRadius: 10,
                      background: state === key ? 'var(--blue-soft)' : 'var(--soft)',
                      border: `1px solid ${state === key ? 'var(--blue-line)' : 'var(--line)'}`,
                    }}
                    onClick={() => setState(key)}
                  >
                    <AgentFace look={look} size={24} state={key} />
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
              label="One standing instruction"
              hint="It applies to every chat this agent handles. Up to 200 characters."
            >
              <textarea
                className="textarea"
                maxLength={200}
                value={draft.standing_instruction}
                onChange={(event) =>
                  setDraft({ ...draft, standing_instruction: event.target.value })
                }
                placeholder="One option first, not five. Confirm before paying."
              />
            </Field>
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
                <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
                  Asks before acting
                </span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Anything that sends, books or pays waits for your yes.
                </span>
              </div>
              <Toggle
                on={draft.asks_before_acting}
                label="Asks before acting"
                onChange={(on) => setDraft({ ...draft, asks_before_acting: on })}
              />
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>
              Access is per agent. Tick what this one may look at; with everything ticked, it also
              reaches what you connect later.
            </p>
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
                      <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
                        {connection.label}
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
              {connections.length === 0 ? (
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
        <div className="grow" />
        <Button loading={busy} onClick={save}>
          Save agent
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

const inputOf = (agent: Agent): AgentInput => ({
  name: agent.name,
  role: agent.role,
  colour: agent.colour,
  surface: agent.surface,
  eye_colour: agent.eye_colour,
  tone: agent.tone,
  standing_instruction: agent.standing_instruction,
  allowed_connection_ids: agent.allowed_connection_ids,
  asks_before_acting: agent.asks_before_acting,
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
  const initial: AgentInput | null =
    selected === 'new' ? { ...blankAgent(), ...(picked ?? {}) } : current ? inputOf(current) : null;

  const panel = initial ? (
    <AgentEditor
      agentId={current?.id ?? null}
      initial={initial}
      connections={connections.data?.connections.filter((c) => c.status === 'connected') ?? []}
      onSaved={(agent) => {
        refreshAgents();
        toast({ kind: 'ok', title: `${agent.name} is ready.` });
        navigate(`/agents/${agent.id}`);
      }}
      onClose={() => navigate('/agents')}
    />
  ) : undefined;

  const fromTemplate = (template: AgentTemplate) =>
    void adapter.createAgent(template.agent).then((r) => {
      if (r.data) {
        refreshAgents();
        navigate(`/agents/${r.data.agent.id}`);
      } else toast({ kind: 'err', title: r.error ?? r.unavailable ?? 'Couldn’t create the agent' });
    });

  return (
    <Shell title="Agents" rail={false} panel={panel}>
      <div className="page" style={{ gap: 20 }}>
        <div className="page-head">
          <div className="col" style={{ gap: 4 }}>
            <h1>Agents</h1>
            <p style={{ fontSize: 14, color: 'var(--muted)', maxWidth: 520 }}>
              Give Melete a face for each job. Each agent keeps its own tone, tools and memory.
            </p>
          </div>
          <Button
            icon="plus"
            onClick={() => {
              setPicked(null);
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
                  <AgentFace look={lookOf(agent)} size={48} />
                  <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
                    <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--heading)' }}>
                      {agent.name}{' '}
                      <span style={{ fontWeight: 400, color: 'var(--muted)' }}>· {agent.role}</span>
                    </span>
                    <span style={{ fontSize: 13, color: 'var(--secondary)', lineHeight: '18px' }}>
                      {agent.standing_instruction || agent.tone}
                    </span>
                  </div>
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
                    {allowed.length
                      ? `reaches ${allowed.map((c) => c.label).join(', ')}`
                      : 'reaches nothing yet'}{' '}
                    · {agent.tone.toLowerCase()}
                  </span>
                  <div className="grow" />
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{usedWhen(agent)}</span>
                </div>
              </a>
            );
          })}
        </div>
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
        {templates.data?.templates.length ? (
          <div className="col" style={{ gap: 12 }}>
            <div className="section-head">
              <h2>Start from a template</h2>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 12,
              }}
            >
              {templates.data.templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className="card-12 hoverable row"
                  style={{ gap: 12, padding: '12px 14px', textAlign: 'left' }}
                  onClick={() => fromTemplate(template)}
                >
                  <AgentFace look={lookOf(template.agent)} size={36} state="inactive" />
                  <span className="col grow" style={{ gap: 1 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>
                      {template.title}
                    </span>
                    <span className="clamp1" style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {template.agent.standing_instruction}
                    </span>
                  </span>
                  <span style={{ color: 'var(--muted)', display: 'flex' }}>
                    <Icon name="plus" size={16} />
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {templates.error ? <Badge tone="danger">{templates.error}</Badge> : null}
      </div>
    </Shell>
  );
}
