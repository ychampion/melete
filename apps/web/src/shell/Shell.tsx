/**
 * The frame every signed-in screen sits in: the sidebar on the paper, the page
 * on a sheet beside it, the day panel as a second sheet on the right, and the
 * phone layout with a drawer and a bottom sheet. Every
 * section reads from the experience contract; a section whose call answers
 * not_available is not drawn.
 */
import {
  createContext,
  type ReactNode,
  type Ref,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Icon, type IconName } from '../design/icons.tsx';
import { LoadError } from '../design/LoadError.tsx';
import { MeleteAvatar } from '../design/mark.tsx';
import {
  Avatar,
  Button,
  Checkbox,
  IconButton,
  Input,
  Kbd,
  Menu,
  MenuItem,
  MenuSep,
  Popover,
  Toast,
  Toggle,
} from '../design/primitives.tsx';
import { AgentAvatar } from '../experience/AgentAvatar.tsx';
import { adapter, type Result } from '../experience/adapter.ts';
import {
  agentById,
  type Loaded,
  useApp,
  useDecisions,
  useLoad,
  useMedia,
} from '../experience/hooks.ts';
import { zoneName } from '../experience/plain.ts';
import { givenName } from '../experience/profile.ts';
import type { CalendarEvent, Conversation, Home, Task } from '../experience/types.ts';
import { FeedbackHost, openFeedback } from '../feedback/FeedbackPanel.tsx';
import { href, navigate, useRoute } from '../router.ts';
import { useTheme } from '../theme.ts';
import { CommandPalette } from './CommandPalette.tsx';
import './shell.css';

export type ToastSpec = {
  id: number;
  kind: 'ok' | 'err' | 'info';
  title: string;
  sub?: string;
  action?: string;
  onAction?: () => void;
};

let toastSeq = 0;
const toastListeners = new Set<(toast: ToastSpec) => void>();

/** Show a toast from anywhere. The shell renders the stack. */
export function toast(spec: Omit<ToastSpec, 'id'>) {
  const full = { ...spec, id: ++toastSeq };
  for (const listener of toastListeners) listener(full);
}

function ToastStack() {
  const [toasts, setToasts] = useState<ToastSpec[]>([]);
  useEffect(() => {
    const listener = (item: ToastSpec) => {
      setToasts((previous) => [...previous, item]);
      setTimeout(() => setToasts((previous) => previous.filter((t) => t.id !== item.id)), 6000);
    };
    toastListeners.add(listener);
    return () => {
      toastListeners.delete(listener);
    };
  }, []);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack">
      {toasts.map((item) => (
        <Toast
          key={item.id}
          kind={item.kind}
          title={item.title}
          sub={item.sub}
          action={item.action}
          onAction={() => {
            item.onAction?.();
            setToasts((previous) => previous.filter((t) => t.id !== item.id));
          }}
          onClose={() => setToasts((previous) => previous.filter((t) => t.id !== item.id))}
        />
      ))}
    </div>
  );
}

const NAV: { icon: IconName; label: string; path: string; match: (path: string) => boolean }[] = [
  { icon: 'home', label: 'Home', path: '/', match: (p) => p === '/' },
  { icon: 'chat', label: 'Chat', path: '/chat', match: (p) => p.startsWith('/chat') },
  {
    icon: 'piggy',
    label: 'Companies',
    path: '/companies',
    match: (p) => p.startsWith('/companies'),
  },
  { icon: 'plans', label: 'Plans', path: '/plans', match: (p) => p.startsWith('/plans') },
  { icon: 'progress', label: 'Work', path: '/runs', match: (p) => p.startsWith('/runs') },
  { icon: 'smile', label: 'Agents', path: '/agents', match: (p) => p.startsWith('/agents') },
  {
    icon: 'bookmark',
    label: 'Memory',
    path: '/settings/memory',
    match: (p) => p.startsWith('/settings/memory'),
  },
  {
    icon: 'automations',
    label: 'Automations',
    path: '/automations',
    match: (p) => p.startsWith('/automations'),
  },
  { icon: 'apps', label: 'Apps', path: '/apps', match: (p) => p.startsWith('/apps') },
];

const LIVE = new Set<Conversation['status']>(['queued', 'working', 'streaming']);

/** How many chats the sidebar lists; the rest are a click away under "All chats". */
const RECENT_CHATS = 8;

/**
 * The chats the sidebar lists: those waiting for the person first, then the
 * latest, and the open one wherever it falls, so it is always in view.
 */
export function sidebarChats(chats: Conversation[], active: string | null): Conversation[] {
  const needs = chats.filter((chat) => chat.status === 'needs_you');
  const rest = chats.filter((chat) => chat.status !== 'needs_you');
  const shown = [...needs, ...rest.slice(0, Math.max(0, RECENT_CHATS - needs.length))];
  const open = active ? chats.find((chat) => chat.id === active) : undefined;
  return open && !shown.includes(open) ? [...shown, open] : shown;
}

/**
 * The space this is. With one space there is nothing to switch to, so it is a
 * plain label rather than a menu with a single entry.
 */
function SpaceSwitcher() {
  return (
    <div className="space-switch" data-static="true">
      <MeleteAvatar size={22} />
      <span>Personal</span>
    </div>
  );
}

function AccountMenu({ address }: { address: string | null }) {
  const { profile, signOut } = useApp();
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const [theme, setTheme, dark] = useTheme();
  const close = useCallback(() => setOpen(false), []);
  const name = givenName(profile) || 'You';
  const initials = name
    .split(' ')
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
  // Memory has its own place in the nav; the gear stands for the rest of Settings.
  const inSettings = route.parts[0] === 'settings' && route.parts[1] !== 'memory';
  return (
    <div className="account-row">
      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        <button
          type="button"
          className="account-button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <Avatar initials={initials} size={28} />
          <span className="col grow">
            <span className="clamp1 account-name">{name}</span>
            {address ? <span className="clamp1 account-address">{address}</span> : null}
          </span>
        </button>
        <Popover open={open} onClose={close} side="top" offset={4}>
          <Menu label="Account" width={232}>
            <div className="account-menu-head">
              <span className="clamp1 account-menu-name">{name}</span>
              {address ? <span className="clamp1">{address}</span> : null}
              {profile ? <span className="clamp1">{zoneName(profile.time_zone)}</span> : null}
            </div>
            <MenuSep />
            <MenuItem
              icon="sliders"
              kbd="⌘,"
              onSelect={() => {
                close();
                navigate('/settings');
              }}
            >
              Settings
            </MenuItem>
            <div className="menu-item" style={{ cursor: 'default' }}>
              <Icon name="moon" size={16} />
              <span className="grow">Dark appearance</span>
              <Toggle
                on={dark}
                label="Dark appearance"
                onChange={(next) => setTheme(next ? 'dark' : 'light')}
              />
            </div>
            {theme !== 'system' ? (
              <MenuItem icon="refresh" onSelect={() => setTheme('system')}>
                Follow the system
              </MenuItem>
            ) : null}
            <MenuSep />
            <MenuItem
              icon="logout"
              onSelect={() => {
                close();
                void signOut();
              }}
            >
              Sign out
            </MenuItem>
          </Menu>
        </Popover>
      </div>
      <IconButton name="bug" label="Report a problem" onClick={() => openFeedback()} />
      <IconButton
        name="sliders"
        label="Settings"
        on={inSettings}
        aria-current={inSettings ? 'page' : undefined}
        onClick={() => navigate('/settings')}
      />
    </div>
  );
}

function Sidebar({
  open,
  onClose,
  onPalette,
}: {
  open: boolean;
  onClose: () => void;
  onPalette: () => void;
}) {
  const route = useRoute();
  const { conversations, conversationsError, agents, profile, refreshConversations } = useApp();
  const decisions = useDecisions();
  const activeChat = route.parts[0] === 'chat' ? (route.parts[1] ?? null) : null;
  const chats = [...conversations].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const recent = sidebarChats(chats, activeChat);
  // The address the person sends from: the space's mail connection that can send.
  const address = profile?.sending_address ?? null;
  return (
    <aside className="sidebar" data-open={open ? 'true' : undefined} aria-label="Sections">
      <div className="sidebar-head">
        <SpaceSwitcher />
        <div className="grow" />
        <IconButton
          name="panelLeft"
          label="Close the sidebar"
          className="phone-only"
          onClick={onClose}
        />
        <IconButton
          name="compose"
          label="New chat"
          onClick={() => {
            onClose();
            navigate('/chat/new');
          }}
        />
      </div>
      <nav className="sidebar-nav" aria-label="Pages">
        <button
          type="button"
          className="nav-item"
          onClick={() => {
            onClose();
            onPalette();
          }}
        >
          <Icon name="search" size={18} />
          <span>Search</span>
          <Kbd>⌘K</Kbd>
        </button>
        {NAV.map((item) => (
          <a
            key={item.path}
            className="nav-item"
            href={href(item.path)}
            aria-current={item.match(route.path) ? 'page' : undefined}
            onClick={onClose}
          >
            <Icon name={item.icon} size={18} />
            <span>{item.label}</span>
            {item.path === '/' && decisions.count > 0 ? (
              <span className="nav-count">
                {decisions.count}
                <span className="sr-only"> waiting on you</span>
              </span>
            ) : null}
          </a>
        ))}
      </nav>
      <div className="sidebar-recent">
        {agents.length > 0 ? (
          <>
            <div className="recent-label">Agents</div>
            {agents.map((agent) => (
              <a
                key={agent.id}
                className="chat-row"
                href={href(`/chat/new?agent=${agent.id}`)}
                title={`New chat with ${agent.name}`}
                onClick={onClose}
              >
                <span className="chat-face">
                  <AgentAvatar agent={agent} size={16} />
                </span>
                <span className="clamp1 grow">{agent.name}</span>
                <span className="clamp1 agent-row-role">{agent.role}</span>
              </a>
            ))}
          </>
        ) : null}
        <div className="recent-label" data-after={agents.length > 0 ? 'agents' : undefined}>
          Chats
        </div>
        {recent.map((chat) => {
          const agent = agentById(agents, chat.agent_id);
          const live = LIVE.has(chat.status);
          return (
            <a
              key={chat.id}
              className="chat-row"
              href={href(`/chat/${chat.id}`)}
              aria-current={chat.id === activeChat ? 'page' : undefined}
              onClick={onClose}
            >
              <span className="chat-face">
                <AgentAvatar agent={agent} size={16} state={live ? 'working' : 'idle'} />
              </span>
              <span className="clamp1 grow">{chat.title}</span>
              {chat.status === 'needs_you' ? (
                <span className="chat-dot" data-tone="needs" title="Waiting for you">
                  <span className="sr-only">, waiting for you</span>
                </span>
              ) : live ? (
                <span className="chat-dot dot-live" data-tone="working" title="Working">
                  <span className="sr-only">, working</span>
                </span>
              ) : null}
            </a>
          );
        })}
        {chats.length > recent.length ? (
          <a className="chat-row chat-all" href={href('/chats')} onClick={onClose}>
            <span className="grow">All chats</span>
            <span className="chat-all-count">{chats.length}</span>
            <Icon name="chevronRight" size={14} />
          </a>
        ) : null}
        {conversationsError && conversations.length === 0 ? (
          <LoadError
            compact
            what="your chats"
            error={conversationsError}
            onRetry={refreshConversations}
          />
        ) : conversations.length === 0 && decisions.loaded ? (
          // Said only once the list was read: before that there is nothing to say.
          <div className="recent-empty">Nothing yet</div>
        ) : null}
      </div>
      <AccountMenu address={address} />
    </aside>
  );
}

/**
 * The day panel's state, shared with the page header that carries its toggle.
 * `available` is false on pages without a rail and on the phone, where the
 * phone head carries the toggle.
 */
type RailState = { available: boolean; on: boolean; toggle: () => void };
const RailContext = createContext<RailState>({ available: false, on: false, toggle: () => {} });

/** The day-panel toggle, drawn at the right end of a page header that has a rail. */
export function RailToggle() {
  const rail = useContext(RailContext);
  if (!rail.available) return null;
  return (
    <IconButton
      name="panelRight"
      label={rail.on ? 'Hide your day' : 'Show your day'}
      on={rail.on}
      aria-expanded={rail.on}
      onClick={rail.toggle}
    />
  );
}

const dayLabel = (iso: string, today: Date): string => {
  const d = new Date(iso);
  if (d.toDateString() === today.toDateString()) return 'Today';
  return d.toLocaleDateString('en-US', { weekday: 'short' });
};
const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const durationLabel = (event: CalendarEvent) => {
  const minutes = Math.round((Date.parse(event.ends_at) - Date.parse(event.starts_at)) / 60_000);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Number.isInteger(minutes / 60) ? minutes / 60 : (minutes / 60).toFixed(1);
  return `${hours} hour${minutes > 60 ? 's' : ''}`;
};

type Day = { home: Loaded<Home>; tasks: Loaded<{ tasks: Task[] }> };

/** True when the day has something to show: an event coming up, or a task. */
const dayHasContent = (day: Day) =>
  (Array.isArray(day.home.data?.upcoming) && day.home.data.upcoming.length > 0) ||
  (day.tasks.data?.tasks.length ?? 0) > 0;

export function Rail({
  day,
  onClose,
  sheet = false,
  panelRef,
}: {
  /** The day's events and tasks, read once by the shell for the rail and its toggle. */
  day: Day;
  onClose?: () => void;
  sheet?: boolean;
  /** The panel itself, so an overlay can take focus when it opens. */
  panelRef?: Ref<HTMLElement>;
}) {
  const { home, tasks } = day;
  const connections = useLoad(() => adapter.connections(), []);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const today = new Date();
  const upcoming: CalendarEvent[] | null =
    home.data && Array.isArray(home.data.upcoming) ? (home.data.upcoming as CalendarEvent[]) : null;
  const list = tasks.data?.tasks ?? [];
  const doneCount = list.filter((t) => t.done).length;
  const dow = (today.getDay() + 6) % 7;
  const monday = new Date(today);
  monday.setDate(today.getDate() - dow);
  const eventDays = new Set((upcoming ?? []).map((e) => new Date(e.starts_at).toDateString()));
  const week = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((label, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return {
      label,
      num: d.getDate(),
      key: d.toDateString(),
      today: i === dow,
      has: eventDays.has(d.toDateString()),
    };
  });
  const connected =
    connections.data?.connections.filter((c) => c.status === 'connected').length ?? 0;
  const footer = connections.data ? (
    <a href={href('/settings/connections')} className="rail-foot">
      <span className="rail-foot-dot" data-on={connected > 0 ? 'true' : undefined} />
      {connected > 0 ? `${connected} app${connected === 1 ? '' : 's'} connected` : 'Connect an app'}
    </a>
  ) : null;
  const closeButton =
    sheet && onClose ? (
      <IconButton name="x" label="Close" size={28} iconSize={14} onClick={onClose} />
    ) : null;
  // Nothing on the calendar and no tasks: one calm block, not a week strip over an empty sheet.
  if (!dayHasContent(day) && !tasks.error && !adding && !home.loading && !tasks.loading)
    return (
      <aside className="rail" aria-label="Your day" ref={panelRef} tabIndex={-1}>
        <div className="row" style={{ justifyContent: 'space-between', height: 28 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>Your day</h2>
          {closeButton}
        </div>
        <div className="col rail-empty">
          <span>Nothing scheduled today.</span>
          {upcoming === null ? (
            <a href={href('/settings/connections')}>Connect a calendar to see your events here</a>
          ) : null}
          <button type="button" className="task-add" onClick={() => setAdding(true)}>
            <Icon name="plus" size={15} />
            Add a task
          </button>
        </div>
        <div className="grow" />
        {footer}
      </aside>
    );
  let lastDay = '';
  return (
    <aside className="rail" aria-label="Your day" ref={panelRef} tabIndex={-1}>
      <div className="col" style={{ gap: 10 }}>
        <div className="row" style={{ justifyContent: 'space-between', height: 28 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>Your day</h2>
          <span className="row" style={{ gap: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)', paddingRight: 4 }}>
              {today.toLocaleDateString('en-US', { month: 'long' })}
            </span>
            {closeButton}
          </span>
        </div>
        <div className="rail-week">
          {week.map((d) => (
            <div key={d.key} className="rail-day">
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: d.today ? 'var(--primary)' : 'var(--muted)',
                }}
              >
                {d.label}
              </span>
              <span
                className="row"
                style={{
                  justifyContent: 'center',
                  width: 28,
                  height: 28,
                  borderRadius: 999,
                  fontSize: 13,
                  fontWeight: d.today ? 600 : 500,
                  color: d.today ? 'var(--blue-ink)' : 'var(--text)',
                  background: d.today ? 'var(--blue-soft)' : 'transparent',
                }}
              >
                {d.num}
              </span>
              <span
                style={{
                  width: 4,
                  height: 4,
                  borderRadius: 999,
                  background: d.has
                    ? d.today
                      ? 'var(--primary)'
                      : 'var(--control)'
                    : 'transparent',
                }}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="hairline" />
      {upcoming ? (
        <>
          <section className="col" style={{ gap: 8 }}>
            <div className="row" style={{ justifyContent: 'space-between', height: 28 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600 }}>Upcoming</h3>
            </div>
            <div className="col" style={{ gap: 4 }}>
              {upcoming.map((event) => {
                const day = dayLabel(event.starts_at, today);
                const showDay = day !== lastDay;
                lastDay = day;
                const title = event.title;
                return (
                  <div key={event.id} className="event-row">
                    <div className="col" style={{ width: 60, flexShrink: 0, gap: 2 }}>
                      {showDay ? <span className="overline">{day}</span> : null}
                      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--secondary)' }}>
                        {timeLabel(event.starts_at)}
                      </span>
                    </div>
                    <div
                      style={{
                        width: 2,
                        height: 28,
                        borderRadius: 2,
                        background: 'var(--primary)',
                        flexShrink: 0,
                      }}
                    />
                    <div className="col" style={{ minWidth: 0, gap: 2 }}>
                      {event.url ? (
                        <a
                          className="clamp1"
                          href={event.url}
                          target="_blank"
                          rel="noreferrer"
                          style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}
                        >
                          {title}
                        </a>
                      ) : (
                        <span
                          className="clamp1"
                          style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}
                        >
                          {title}
                        </span>
                      )}
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {durationLabel(event)}
                      </span>
                    </div>
                  </div>
                );
              })}
              {upcoming.length === 0 ? (
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>Nothing coming up.</span>
              ) : null}
            </div>
          </section>
          <div className="hairline" />
        </>
      ) : null}
      <section className="col" style={{ gap: 8 }}>
        <div className="row" style={{ justifyContent: 'space-between', height: 28 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600 }}>Tasks</h3>
          <span className="row" style={{ gap: 8 }}>
            {list.length ? (
              <span
                style={{
                  width: 64,
                  height: 3,
                  borderRadius: 3,
                  background: 'var(--line)',
                  overflow: 'hidden',
                  display: 'block',
                }}
              >
                <span
                  style={{
                    display: 'block',
                    width: `${list.length ? (doneCount / list.length) * 100 : 0}%`,
                    height: '100%',
                    background: 'var(--primary)',
                  }}
                />
              </span>
            ) : null}
            {list.length ? (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {doneCount} of {list.length}
              </span>
            ) : null}
            <IconButton name="plus" label="Add a task" size={28} onClick={() => setAdding(true)} />
          </span>
        </div>
        <div className="col">
          {tasks.error ? (
            <LoadError compact what="your tasks" error={tasks.error} onRetry={tasks.reload} />
          ) : null}
          {list.map((task) => (
            <div key={task.id} className="task-row" data-done={task.done ? 'true' : undefined}>
              <Checkbox
                checked={task.done}
                label={task.title}
                onChange={(done) =>
                  void adapter.setTask(task, { done }).then((r) => {
                    if (r.data)
                      tasks.set({ tasks: list.map((t) => (t.id === task.id ? r.data.task : t)) });
                  })
                }
              />
              <span className="clamp1">{task.title}</span>
            </div>
          ))}
          {adding ? (
            <form
              className="row"
              style={{ gap: 8, paddingTop: 6 }}
              onSubmit={(event) => {
                event.preventDefault();
                const text = draft.trim();
                if (!text) return;
                void adapter.addTask(text).then((r) => {
                  if (r.data) tasks.set({ tasks: [...list, r.data.task] });
                });
                setDraft('');
                setAdding(false);
              }}
            >
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="A task"
                aria-label="New task"
                width="100%"
                height={32}
                autoFocus
              />
              <Button size="sm" type="submit">
                Add
              </Button>
            </form>
          ) : null}
        </div>
      </section>
      <div className="grow" />
      {footer}
    </aside>
  );
}

/** What the shell answers for a call it does not make on a page without a rail. */
const off = <T,>(): Promise<Result<T>> =>
  Promise.resolve({ data: null, error: null, unavailable: 'No day panel here.' });
/** The rail's toggle choice, and whether the day had anything, carried across pages. */
let railPreference: boolean | null = null;
let lastHasDay = false;

export type ShellProps = {
  children: ReactNode;
  title?: string;
  agentId?: string | null;
  /** A docked panel replaces the rail (plans sheet, agent editor). */
  panel?: ReactNode;
  rail?: boolean;
  phoneActions?: ReactNode;
  /** On the phone, a back button in place of the drawer. */
  phoneBack?: () => void;
  /** On the phone, a second line under the title. */
  phoneSub?: ReactNode;
};

export function Shell({
  children,
  title,
  agentId,
  panel,
  rail = true,
  phoneActions,
  phoneBack,
  phoneSub,
}: ShellProps) {
  const phone = useMedia('(max-width: 767px)');
  const narrow = useMedia('(max-width: 1279px)');
  const [drawer, setDrawer] = useState(false);
  // Wide screens show the day unless it is hidden; narrow ones open it over the page.
  const [railOpen, setRailOpen] = useState(false);
  // What the person chose with the toggle, kept while they move between pages.
  const [railChoice, setRailChoice] = useState<boolean | null>(railPreference);
  const [palette, setPalette] = useState(false);
  const { agents } = useApp();
  const route = useRoute();
  const agent = agentById(agents, agentId);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a navigation closes the drawer
  useEffect(() => {
    setDrawer(false);
  }, [route.path]);

  const showRail = rail && !panel;
  const day: Day = {
    home: useLoad(() => (showRail ? adapter.home() : off<Home>()), [showRail]),
    tasks: useLoad(() => (showRail ? adapter.tasks() : off<{ tasks: Task[] }>()), [showRail]),
  };
  // The day opens by itself only when it has something in it; the toggle still opens it.
  const loaded = !day.home.loading && !day.tasks.loading;
  const hasDay = loaded ? dayHasContent(day) : lastHasDay;
  useEffect(() => {
    if (loaded && showRail) lastHasDay = hasDay;
  }, [loaded, showRail, hasDay]);
  const railVisible = showRail && (narrow ? railOpen : (railChoice ?? hasDay));
  // Over the page (under 1280px) the day is an overlay: it takes focus when it
  // opens, Escape closes it, and focus goes back to what opened it.
  const railRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const closeRail = useCallback(() => {
    setRailOpen(false);
    openerRef.current?.focus();
  }, []);
  const overlay = narrow && railOpen && rail && !panel;
  useEffect(() => {
    if (!overlay) return;
    railRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const active = document.activeElement;
      const ours =
        !active ||
        active === document.body ||
        active === openerRef.current ||
        railRef.current?.contains(active);
      if (!ours) return;
      event.preventDefault();
      closeRail();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay, closeRail]);
  const toggleRail = useCallback(() => {
    if (narrow) {
      if (!railOpen) openerRef.current = document.activeElement as HTMLElement | null;
      setRailOpen(!railOpen);
      return;
    }
    const next = !(railChoice ?? hasDay);
    railPreference = next;
    setRailChoice(next);
  }, [narrow, railOpen, railChoice, hasDay]);
  const railState = useMemo<RailState>(
    () => ({ available: showRail && !phone, on: railVisible, toggle: toggleRail }),
    [showRail, phone, railVisible, toggleRail],
  );
  const closeDrawer = useCallback(() => setDrawer(false), []);
  const openPalette = useCallback(() => setPalette(true), []);

  return (
    <RailContext.Provider value={railState}>
      <div className="shell">
        {/* The first stop for the keyboard: past the sidebar, straight to the page. */}
        <button
          type="button"
          className="skip-link"
          onClick={() => document.getElementById('main')?.focus()}
        >
          Skip to content
        </button>
        {phone && drawer ? (
          // biome-ignore lint/a11y/noStaticElementInteractions: the scrim closes the drawer; the close button does the same for the keyboard
          <div className="drawer-scrim" onMouseDown={closeDrawer} />
        ) : null}
        <Sidebar open={drawer} onClose={closeDrawer} onPalette={openPalette} />
        <div className="shell-main">
          {phone ? (
            <header className="phone-head">
              {phoneBack ? (
                <IconButton
                  name="chevronLeft"
                  label="Back"
                  size={44}
                  iconSize={20}
                  onClick={phoneBack}
                />
              ) : (
                <IconButton
                  name="menu"
                  label="Open the sidebar"
                  size={44}
                  iconSize={20}
                  onClick={() => setDrawer(true)}
                />
              )}
              <div className="col grow" style={{ alignItems: 'center', minWidth: 0 }}>
                <span
                  className="row clamp1"
                  style={{
                    gap: 6,
                    fontSize: 15,
                    fontWeight: 600,
                    lineHeight: '20px',
                    color: 'var(--heading)',
                    maxWidth: '100%',
                  }}
                >
                  {agent && !phoneSub ? <AgentAvatar agent={agent} size={18} /> : null}
                  <span className="clamp1">{title ?? 'Melete'}</span>
                </span>
                {phoneSub ? <span className="phone-sub clamp1">{phoneSub}</span> : null}
              </div>
              {phoneActions}
              {showRail ? (
                <IconButton
                  name="calendar"
                  label="Your day"
                  size={44}
                  iconSize={20}
                  on={railOpen}
                  onClick={toggleRail}
                />
              ) : null}
              <IconButton
                name="search"
                label="Search"
                size={44}
                iconSize={20}
                onClick={openPalette}
              />
            </header>
          ) : null}
          <div className="shell-body">
            <main id="main" className="shell-content" tabIndex={-1}>
              {children}
            </main>
            {panel}
            {railVisible ? (
              <Rail day={day} sheet={narrow} onClose={closeRail} panelRef={railRef} />
            ) : null}
          </div>
        </div>
        <CommandPalette open={palette} onClose={() => setPalette(false)} />
        <FeedbackHost />
        <ToastStack />
      </div>
    </RailContext.Provider>
  );
}
