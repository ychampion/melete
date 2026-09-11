/**
 * Agents: a face for each job. Profiles, a wall of faces to pick from,
 * templates, and an editor with Look, Behaviour and Access. Face states are
 * derived from turn status; the editor shows all nine so a person knows what
 * they will see while it works.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  AgentFace,
  FACE_PALETTE,
  FACE_SHAPES,
  FACE_STATES,
  type FaceLook,
  type FaceShape,
} from '../design/face.tsx';
import { Icon, type IconName } from '../design/icons.tsx';
import { isLogo, Logo } from '../design/logos.tsx';
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
import { adapter } from '../experience/adapter.ts';
import { useApp, useLoad } from '../experience/hooks.ts';
import type { Agent, AgentTemplate, AgentTone, ConnectionData } from '../experience/types.ts';
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

const REACH_ICON: Record<string, IconName> = {
  calendar: 'calendar',
  places: 'mapPin',
  messages: 'messages',
  'the web': 'globe',
  plans: 'plans',
  files: 'fileText',
  mail: 'mail',
  'the browser': 'globe',
};

export type AgentDraft = Omit<Agent, 'id' | 'stats'> & { id: string | null };

export const blankAgent = (): AgentDraft => ({
  id: null,
  name: '',
  role: 'Assistant',
  blurb: '',
  look: { color: FACE_PALETTE[7], eyes: 'white', shape: 'blob', image: null },
  tone: 'warm',
  standing_instruction: '',
  allowed_connections: [],
  asks_before_acting: true,
  reaches: [],
});

const shuffleLook = (): FaceLook => ({
  color: FACE_PALETTE[Math.floor(Math.random() * FACE_PALETTE.length)] ?? FACE_PALETTE[0],
  eyes: Math.random() > 0.5 ? 'white' : 'black',
  shape: FACE_SHAPES[Math.floor(Math.random() * FACE_SHAPES.length)]?.[0] ?? 'blob',
  image: null,
});

/** Read an SVG or PNG face from disk as a data URL. */
export function readFace(file: File): Promise<string | null> {
  if (!['image/svg+xml', 'image/png'].includes(file.type)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

export function LookFields({
  draft,
  onChange,
  compact = false,
}: {
  draft: AgentDraft;
  onChange: (next: AgentDraft) => void;
  compact?: boolean;
}) {
  const setLook = (patch: Partial<FaceLook>) =>
    onChange({ ...draft, look: { ...draft.look, ...patch } });
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
            const on = color === draft.look.color && !draft.look.image;
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
                onClick={() => setLook({ color, image: null })}
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
              const on = key === draft.look.shape && !draft.look.image;
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
                  onClick={() => setLook({ shape: key as FaceShape, image: null })}
                >
                  <AgentFace
                    look={{
                      color: on ? 'var(--heading)' : 'var(--control)',
                      eyes: 'none',
                      shape: key as FaceShape,
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
            value={draft.look.eyes === 'none' ? 'white' : draft.look.eyes}
            onChange={(eyes) => setLook({ eyes, image: null })}
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
  initial,
  connections,
  onSaved,
  onClose,
}: {
  initial: AgentDraft;
  connections: ConnectionData[];
  onSaved: (agent: Agent) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<AgentDraft>(initial);
  const [tab, setTab] = useState<'look' | 'behaviour' | 'access'>('look');
  const [state, setState] = useState<(typeof FACE_STATES)[number][0]>('idle');
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(initial), [initial]);

  const save = () => {
    if (!draft.name.trim()) {
      toast({ kind: 'err', title: 'Give the agent a name first.' });
      return;
    }
    setBusy(true);
    void adapter.saveAgent({ ...draft, name: draft.name.trim() }).then((result) => {
      setBusy(false);
      if (result.error !== null) toast({ kind: 'err', title: result.error });
      else onSaved(result.data.agent);
    });
  };

  return (
    <aside
      className="side-panel"
      style={{ width: 420 }}
      aria-label={draft.id ? `Edit ${draft.name}` : 'New agent'}
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
              <AgentFace look={draft.look} size={112} state={state} glow />
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
                  onClick={() => setDraft({ ...draft, look: shuffleLook() })}
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
                    <AgentFace look={draft.look} size={24} state={key} />
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
            <Field label="One line about the job">
              <Input
                value={draft.blurb}
                onChange={(event) => setDraft({ ...draft, blurb: event.target.value })}
                width="100%"
                placeholder="Dinners, trips and bookings."
              />
            </Field>
            <Field label="Tone">
              <Segmented
                label="Tone"
                value={draft.tone}
                onChange={(tone: AgentTone) => setDraft({ ...draft, tone })}
                options={[
                  { value: 'warm', label: 'Warm' },
                  { value: 'direct', label: 'Direct' },
                  { value: 'playful', label: 'Playful' },
                ]}
              />
            </Field>
            <Field
              label="One standing instruction"
              hint="It applies to every chat this agent handles."
            >
              <textarea
                className="textarea"
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
              Access is per agent. Tick what this one may look at.
            </p>
            <div className="col" style={{ gap: 6 }}>
              {[
                ...connections,
                {
                  id: 'browser',
                  app: 'browser',
                  name: 'Browser',
                  what: 'A sandboxed computer for bookings and forms',
                  state: 'connected',
                  access: 'write',
                  error: null,
                } as ConnectionData,
              ].map((connection) => {
                const on = draft.allowed_connections.includes(connection.id);
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
                    {isLogo(connection.app) ? (
                      <Logo name={connection.app} size={32} />
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
                        <Icon name="globe" size={16} />
                      </span>
                    )}
                    <span className="col grow" style={{ minWidth: 0 }}>
                      <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
                        {connection.name}
                      </span>
                      <span className="clamp1" style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {connection.access === 'draft'
                          ? 'Draft only · you always send'
                          : connection.access === 'read'
                            ? 'Read only'
                            : connection.what}
                      </span>
                    </span>
                    <Checkbox
                      checked={on}
                      label={connection.name}
                      onChange={(next) =>
                        setDraft({
                          ...draft,
                          allowed_connections: next
                            ? [...draft.allowed_connections, connection.id]
                            : draft.allowed_connections.filter((id) => id !== connection.id),
                        })
                      }
                    />
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
      <div
        className="row"
        style={{ gap: 8, padding: '12px 20px 16px', borderTop: '1px solid var(--line)' }}
      >
        <label className="btn btn-md btn-ghost" style={{ cursor: 'pointer' }}>
          <Icon name="upload" size={16} />
          <span>Import SVG or PNG</span>
          <input
            type="file"
            accept="image/svg+xml,image/png"
            hidden
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              const image = await readFace(file);
              if (!image) {
                toast({ kind: 'err', title: 'That file isn’t an SVG or a PNG.' });
                return;
              }
              setDraft({ ...draft, look: { ...draft.look, image } });
            }}
          />
        </label>
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

export function AgentsScreen({ selected }: { selected: string | null }) {
  const { agents, refreshAgents } = useApp();
  const data = useLoad(() => adapter.agents(), []);
  const connections = useLoad(() => adapter.connections(), []);
  const [wallSeed, setWallSeed] = useState(0);
  const [confirm, setConfirm] = useState<Agent | null>(null);
  const [picked, setPicked] = useState<FaceLook | null>(null);

  const wall = useMemo(() => {
    const items = WALL.map(([color, shape], i) => ({
      color,
      shape: shape as FaceShape,
      eyes: (i + wallSeed) % 3 === 0 ? ('black' as const) : ('white' as const),
    }));
    for (let i = 0; i < wallSeed % 7; i += 1) items.push(items.shift() as (typeof items)[number]);
    return items;
  }, [wallSeed]);

  const templates: AgentTemplate[] = data.data?.templates ?? [];
  const current =
    selected === 'new' ? null : (agents.find((agent) => agent.id === selected) ?? null);
  const draft: AgentDraft | null =
    selected === 'new'
      ? { ...blankAgent(), ...(picked ? { look: picked } : {}) }
      : current
        ? { ...current, id: current.id }
        : null;

  const panel = draft ? (
    <AgentEditor
      initial={draft}
      connections={connections.data?.connections.filter((c) => c.state === 'connected') ?? []}
      onSaved={(agent) => {
        refreshAgents();
        toast({ kind: 'ok', title: `${agent.name} is ready.` });
        navigate(`/agents/${agent.id}`);
      }}
      onClose={() => navigate('/agents')}
    />
  ) : undefined;

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
          <div className="row" style={{ gap: 8 }}>
            <label className="btn btn-md btn-outline" style={{ cursor: 'pointer' }}>
              <Icon name="upload" size={16} />
              <span>Import a face</span>
              <input
                type="file"
                accept="image/svg+xml,image/png"
                hidden
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  const image = await readFace(file);
                  if (!image)
                    return toast({ kind: 'err', title: 'That file isn’t an SVG or a PNG.' });
                  setPicked({ color: '#8a8f98', eyes: 'white', shape: 'square', image });
                  navigate('/agents/new');
                }}
              />
            </label>
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
                  <AgentFace look={agent.look} size={48} />
                  <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
                    <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--heading)' }}>
                      {agent.name}{' '}
                      <span style={{ fontWeight: 400, color: 'var(--muted)' }}>· {agent.role}</span>
                    </span>
                    <span style={{ fontSize: 13, color: 'var(--secondary)', lineHeight: '18px' }}>
                      {agent.blurb}
                    </span>
                  </div>
                  <IconButton
                    name="trash"
                    label={`Delete ${agent.name}`}
                    size={28}
                    iconSize={14}
                    onClick={(event) => {
                      event.preventDefault();
                      setConfirm(agent);
                    }}
                  />
                </div>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span className="row" style={{ gap: 4 }}>
                    {agent.reaches.map((reach) => (
                      <span
                        key={reach}
                        title={reach}
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
                        <Icon name={REACH_ICON[reach] ?? 'globe'} size={13} />
                      </span>
                    ))}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    reaches {agent.reaches.join(', ') || 'nothing yet'}
                  </span>
                  <div className="grow" />
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {agent.stats.chats
                      ? `${agent.stats.chats} chat${agent.stats.chats === 1 ? '' : 's'} · used ${agent.stats.last_used}`
                      : 'Not used yet'}
                  </span>
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
            {wall.map((look, i) => (
              <button
                key={`${look.color}-${look.shape}`}
                type="button"
                aria-label={`Pick this ${look.shape} face`}
                className="row"
                style={{
                  justifyContent: 'center',
                  height: 64,
                  borderRadius: 10,
                  background:
                    picked?.color === look.color && picked?.shape === look.shape
                      ? '#1b1e22'
                      : 'transparent',
                  border: `1px solid ${picked?.color === look.color && picked?.shape === look.shape ? '#3a3f46' : 'transparent'}`,
                }}
                onClick={() => {
                  setPicked({ ...look, image: null });
                  navigate('/agents/new');
                }}
              >
                <AgentFace
                  look={{ ...look, image: null }}
                  size={44}
                  state={['idle', 'observing', 'thinking', 'done'][i % 4] as 'idle'}
                />
              </button>
            ))}
          </div>
        </div>
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
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                className="card-12 hoverable row"
                style={{ gap: 12, padding: '12px 14px', textAlign: 'left' }}
                onClick={() =>
                  void adapter.saveAgent({ ...template.agent, id: null }).then((r) => {
                    if (r.data) {
                      refreshAgents();
                      navigate(`/agents/${r.data.agent.id}`);
                    }
                  })
                }
              >
                <AgentFace look={template.agent.look} size={36} state="inactive" />
                <span className="col grow" style={{ gap: 1 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>
                    {template.title}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {template.description}
                  </span>
                </span>
                <span style={{ color: 'var(--muted)', display: 'flex' }}>
                  <Icon name="plus" size={16} />
                </span>
              </button>
            ))}
          </div>
        </div>
        {data.error ? <Badge tone="danger">{data.error}</Badge> : null}
      </div>
      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={`Delete ${confirm?.name ?? 'this agent'}?`}
        sub="Its chats stay. Melete handles them from now on."
        icon="trash"
        tone="danger"
        width={400}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = confirm;
                setConfirm(null);
                if (!target) return;
                void adapter.deleteAgent(target.id).then(() => {
                  refreshAgents();
                  if (selected === target.id) navigate('/agents');
                });
              }}
            >
              Delete agent
            </Button>
          </>
        }
      />
    </Shell>
  );
}
