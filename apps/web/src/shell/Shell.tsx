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
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { AgentFace } from '../design/face.tsx';
import { Icon, type IconName } from '../design/icons.tsx';
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
  Overline,
  Popover,
  Toast,
  Toggle,
} from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import {
  agentById,
  lookOf,
  sendingAddress,
  useApp,
  useDecisions,
  useLoad,
  useMedia,
} from '../experience/hooks.ts';
import type { CalendarEvent, Conversation } from '../experience/types.ts';
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
  { icon: 'smile', label: 'Agents', path: '/agents', match: (p) => p.startsWith('/agents') },
  {
    icon: 'automations',
    label: 'Automations',
    path: '/automations',
    match: (p) => p.startsWith('/automations'),
  },
];

const LIVE = new Set<Conversation['status']>(['queued', 'working', 'streaming']);

function SpaceSwitcher() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className="space-switch"
        aria-label="Switch space"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <MeleteAvatar size={22} />
        <span>Personal</span>
        <span className="row" style={{ color: 'var(--muted)' }}>
          <Icon name="chevronsUpDown" size={14} />
        </span>
      </button>
      <Popover open={open} onClose={close} offset={4}>
        <Menu label="Spaces" width={208}>
          <MenuItem icon="user" on onSelect={close}>
            Personal
          </MenuItem>
        </Menu>
      </Popover>
    </div>
  );
}

function AccountMenu({ address }: { address: string | null }) {
  const { profile } = useApp();
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const [theme, setTheme, dark] = useTheme();
  const close = useCallback(() => setOpen(false), []);
  const name = profile?.name ?? 'You';
  const initials = name
    .split(' ')
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const inSettings = route.parts[0] === 'settings';
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
            <Overline style={{ padding: '6px 8px 2px' }}>{name}</Overline>
            <div style={{ padding: '0 8px 6px', fontSize: 12, color: 'var(--muted)' }}>
              {profile?.time_zone ?? ''}
            </div>
            <MenuSep />
            <MenuItem
              icon="sliders"
              kbd="⌘,"
              onSelect={() => {
                close();
                navigate('/settings/memory');
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
          </Menu>
        </Popover>
      </div>
      <IconButton
        name="sliders"
        label="Settings"
        on={inSettings}
        aria-current={inSettings ? 'page' : undefined}
        onClick={() => navigate('/settings/memory')}
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
  const { conversations, agents } = useApp();
  const decisions = useDecisions();
  const activeChat = route.parts[0] === 'chat' ? (route.parts[1] ?? null) : null;
  const chats = [...conversations].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const address = sendingAddress(decisions.permissions.data?.permissions ?? []);
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
        <div className="recent-label">Chats</div>
        {chats.map((chat) => {
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
                {agent ? (
                  <AgentFace look={lookOf(agent)} size={16} state={live ? 'working' : 'idle'} />
                ) : null}
              </span>
              <span className="clamp1 grow">{chat.title}</span>
              {chat.status === 'needs_you' ? (
                <span className="chat-dot" data-tone="needs" title="Waiting for you" />
              ) : live ? (
                <span className="chat-dot dot-live" data-tone="working" title="Working" />
              ) : null}
            </a>
          );
        })}
        {conversations.length === 0 ? <div className="recent-empty">Nothing yet</div> : null}
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

export function Rail({ onClose, sheet = false }: { onClose?: () => void; sheet?: boolean }) {
  const home = useLoad(() => adapter.home(), []);
  const tasks = useLoad(() => adapter.tasks(), []);
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
  let lastDay = '';
  return (
    <aside className="rail" aria-label="Your day">
      <div className="col" style={{ gap: 10 }}>
        <div className="row" style={{ justifyContent: 'space-between', height: 28 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>Your day</h2>
          <span className="row" style={{ gap: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)', paddingRight: 4 }}>
              {today.toLocaleDateString('en-US', { month: 'long' })}
            </span>
            {sheet && onClose ? (
              <IconButton name="x" label="Close" size={28} iconSize={14} onClick={onClose} />
            ) : null}
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
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {doneCount} of {list.length}
            </span>
            <IconButton name="plus" label="Add a task" size={28} onClick={() => setAdding(true)} />
          </span>
        </div>
        <div className="col">
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
      {connections.data ? (
        <a
          href={href('/settings/connections')}
          className="row"
          style={{ gap: 6, fontSize: 12, color: 'var(--muted)' }}
        >
          <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--success)' }} />
          {connected} connection{connected === 1 ? '' : 's'} · connected
        </a>
      ) : null}
    </aside>
  );
}

export type ShellProps = {
  children: ReactNode;
  title?: string;
  agentId?: string | null;
  /** A docked panel replaces the rail (plans sheet, agent editor). */
  panel?: ReactNode;
  rail?: boolean;
  phoneActions?: ReactNode;
};

export function Shell({ children, title, agentId, panel, rail = true, phoneActions }: ShellProps) {
  const phone = useMedia('(max-width: 767px)');
  const narrow = useMedia('(max-width: 1279px)');
  const [drawer, setDrawer] = useState(false);
  // Wide screens show the day unless it is hidden; narrow ones open it over the page.
  const [railOpen, setRailOpen] = useState(false);
  const [railHidden, setRailHidden] = useState(false);
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
  const railVisible = showRail && (narrow ? railOpen : !railHidden);
  const toggleRail = useCallback(() => {
    if (narrow) setRailOpen((o) => !o);
    else setRailHidden((h) => !h);
  }, [narrow]);
  const railState = useMemo<RailState>(
    () => ({ available: showRail && !phone, on: railVisible, toggle: toggleRail }),
    [showRail, phone, railVisible, toggleRail],
  );
  const closeDrawer = useCallback(() => setDrawer(false), []);
  const openPalette = useCallback(() => setPalette(true), []);

  return (
    <RailContext.Provider value={railState}>
      <div className="shell">
        {phone && drawer ? (
          // biome-ignore lint/a11y/noStaticElementInteractions: the scrim closes the drawer; the close button does the same for the keyboard
          <div className="drawer-scrim" onMouseDown={closeDrawer} />
        ) : null}
        <Sidebar open={drawer} onClose={closeDrawer} onPalette={openPalette} />
        <div className="shell-main">
          {phone ? (
            <header className="phone-head">
              <IconButton
                name="menu"
                label="Open the sidebar"
                size={44}
                iconSize={20}
                onClick={() => setDrawer(true)}
              />
              <div className="col grow" style={{ alignItems: 'center', minWidth: 0 }}>
                <span
                  className="row clamp1"
                  style={{ gap: 6, fontSize: 15, fontWeight: 600, color: 'var(--heading)' }}
                >
                  {agent ? <AgentFace look={lookOf(agent)} size={18} /> : null}
                  {title ?? 'Melete'}
                </span>
              </div>
              {phoneActions}
              {showRail ? (
                <IconButton
                  name="calendar"
                  label="Your day"
                  size={44}
                  iconSize={20}
                  on={railOpen}
                  onClick={() => setRailOpen((o) => !o)}
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
            <main className="shell-content">{children}</main>
            {panel}
            {railVisible ? <Rail sheet={narrow} onClose={() => setRailOpen(false)} /> : null}
          </div>
        </div>
        <CommandPalette open={palette} onClose={() => setPalette(false)} />
        <ToastStack />
      </div>
    </RailContext.Provider>
  );
}
