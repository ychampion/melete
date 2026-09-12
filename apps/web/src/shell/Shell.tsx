/**
 * The frame every signed-in screen sits in: sidebar, topbar, the day panel on
 * the right, and the phone layout with a drawer and a bottom sheet. Every
 * section reads from the experience contract; a section whose call answers
 * not_available is not drawn.
 */
import { type ReactNode, useCallback, useEffect, useState } from 'react';
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
import { agentById, lookOf, useApp, useLoad, useMedia } from '../experience/hooks.ts';
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
  { icon: 'smile', label: 'Agents', path: '/agents', match: (p) => p.startsWith('/agents') },
  { icon: 'plans', label: 'Plans', path: '/plans', match: (p) => p.startsWith('/plans') },
  {
    icon: 'automations',
    label: 'Automations',
    path: '/automations',
    match: (p) => p.startsWith('/automations'),
  },
];

function groupChats(chats: Conversation[]): [string, Conversation[]][] {
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  const groups = new Map<string, Conversation[]>();
  const sorted = [...chats].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  for (const chat of sorted) {
    const day = new Date(chat.updated_at).toDateString();
    const label = day === today ? 'Today' : day === yesterday ? 'Yesterday' : 'Earlier';
    groups.set(label, [...(groups.get(label) ?? []), chat]);
  }
  return ['Today', 'Yesterday', 'Earlier']
    .filter((key) => groups.has(key))
    .map((key) => [key, groups.get(key) ?? []]);
}

function AccountMenu() {
  const { profile } = useApp();
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
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className="account-row"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Avatar initials={initials} size={32} />
        <span className="col grow" style={{ gap: 2 }}>
          <span
            className="clamp1"
            style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}
          >
            {name}
          </span>
          <span className="clamp1" style={{ fontSize: 12, color: 'var(--muted)' }}>
            Personal workspace
          </span>
        </span>
        <span style={{ color: 'var(--muted)', display: 'flex' }}>
          <Icon name="chevronsUpDown" size={16} />
        </span>
      </button>
      <Popover open={open} onClose={close} side="top" offset={4}>
        <Menu label="Account" width={232}>
          <Overline style={{ padding: '6px 8px 2px' }}>{name}</Overline>
          <div style={{ padding: '0 8px 6px', fontSize: 12, color: 'var(--muted)' }}>
            {profile?.time_zone ?? ''}
          </div>
          <MenuSep />
          <MenuItem icon="user" on>
            Personal
          </MenuItem>
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
  );
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const route = useRoute();
  const { conversations } = useApp();
  const [recentsOpen, setRecentsOpen] = useState(true);
  const activeChat = route.parts[0] === 'chat' ? (route.parts[1] ?? null) : null;
  return (
    <aside className="sidebar" data-open={open ? 'true' : undefined} aria-label="Sections">
      <div className="sidebar-head">
        <a href={href('/')} aria-label="Home">
          <MeleteAvatar size={28} />
        </a>
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
          variant="soft"
          onClick={() => {
            onClose();
            navigate('/chat/new');
          }}
        />
      </div>
      <nav className="sidebar-nav">
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
          </a>
        ))}
      </nav>
      <div className="sidebar-recent">
        <button
          type="button"
          className="recent-head"
          aria-expanded={recentsOpen}
          onClick={() => setRecentsOpen((o) => !o)}
        >
          <Overline>Recent chats</Overline>
          <span style={{ color: 'var(--muted)', display: 'flex' }}>
            <Icon name={recentsOpen ? 'chevronDown' : 'chevronRight'} size={14} />
          </span>
        </button>
        {recentsOpen
          ? groupChats(conversations).map(([label, chats]) => (
              <div key={label} className="col" style={{ marginTop: label === 'Today' ? 4 : 8 }}>
                <div className="group-label">{label}</div>
                {chats.map((chat) => (
                  <a
                    key={chat.id}
                    className="chat-row"
                    href={href(`/chat/${chat.id}`)}
                    aria-current={chat.id === activeChat ? 'page' : undefined}
                    onClick={onClose}
                  >
                    <span className="chat-dot">
                      {chat.id === activeChat ? (
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 999,
                            background: 'var(--primary)',
                          }}
                        />
                      ) : null}
                    </span>
                    <span className="clamp1 grow">{chat.title}</span>
                    {chat.status === 'needs_you' ? (
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 999,
                          background: 'var(--sand-ink)',
                        }}
                        title="Waiting for you"
                      />
                    ) : null}
                  </a>
                ))}
              </div>
            ))
          : null}
        {recentsOpen && conversations.length === 0 ? (
          <div className="group-label" style={{ marginTop: 4 }}>
            Nothing yet
          </div>
        ) : null}
      </div>
      <div className="grow" />
      <nav className="sidebar-foot">
        <a
          className="nav-item"
          href={href('/settings/memory')}
          aria-current={route.parts[0] === 'settings' ? 'page' : undefined}
          onClick={onClose}
        >
          <Icon name="sliders" size={18} />
          <span>Settings</span>
        </a>
      </nav>
      <AccountMenu />
    </aside>
  );
}

function Topbar({
  railOn,
  onRail,
  onPalette,
  railAvailable,
}: {
  railOn: boolean;
  onRail: () => void;
  onPalette: () => void;
  railAvailable: boolean;
}) {
  return (
    <header className="topbar">
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        style={{ paddingLeft: 10, paddingRight: 8, color: 'var(--text)' }}
      >
        Personal
        <Icon name="chevronDown" size={14} />
      </button>
      <div className="topbar-search">
        <button
          type="button"
          className="input"
          onClick={onPalette}
          aria-label="Search your workspace"
          style={{ cursor: 'pointer' }}
        >
          <span className="input-icon">
            <Icon name="search" size={16} />
          </span>
          <span
            className="grow"
            style={{ fontSize: 14, color: 'var(--placeholder)', textAlign: 'left' }}
          >
            Search your workspace
          </span>
          <Kbd>⌘K</Kbd>
        </button>
      </div>
      <div className="grow" />
      {railAvailable ? (
        <IconButton
          name="panelRight"
          label={railOn ? 'Hide your day' : 'Show your day'}
          on={railOn}
          onClick={onRail}
        />
      ) : null}
    </header>
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
  const [railOn, setRailOn] = useState(false);
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
  const railVisible = showRail && (narrow ? railOn : true);
  const closeDrawer = useCallback(() => setDrawer(false), []);

  return (
    <div className="shell">
      {phone && drawer ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: the scrim closes the drawer; the close button does the same for the keyboard
        <div className="drawer-scrim" onMouseDown={closeDrawer} />
      ) : null}
      <Sidebar open={drawer} onClose={closeDrawer} />
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
                style={{
                  gap: 6,
                  fontFamily: 'var(--font-head)',
                  fontSize: 15,
                  fontWeight: 600,
                  color: 'var(--heading)',
                }}
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
                on={railOn}
                onClick={() => setRailOn((o) => !o)}
              />
            ) : null}
            <IconButton
              name="search"
              label="Search"
              size={44}
              iconSize={20}
              onClick={() => setPalette(true)}
            />
          </header>
        ) : (
          <Topbar
            railOn={railVisible}
            onRail={() => setRailOn((o) => !o)}
            onPalette={() => setPalette(true)}
            railAvailable={showRail}
          />
        )}
        <div className="shell-body">
          <main className="shell-content">{children}</main>
          {panel}
          {railVisible ? <Rail sheet={narrow} onClose={() => setRailOn(false)} /> : null}
        </div>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <ToastStack />
    </div>
  );
}
