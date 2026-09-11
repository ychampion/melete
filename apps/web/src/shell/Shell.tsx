/**
 * The frame every signed-in screen sits in: sidebar, topbar, the day panel on
 * the right, and the phone layout with a drawer and a bottom sheet. Surfaces
 * the adapter reports as unavailable are simply not offered.
 */
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { AgentFace } from '../design/face.tsx';
import { Icon, type IconName } from '../design/icons.tsx';
import { MeleteAvatar } from '../design/mark.tsx';
import {
  Avatar,
  Button,
  Checkbox,
  Dialog,
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
import { agentById, useApp, useLoad, useMedia } from '../experience/hooks.ts';
import type { ConversationSummary, DayPanel } from '../experience/types.ts';
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

function groupChats(chats: ConversationSummary[]): [string, ConversationSummary[]][] {
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  const groups = new Map<string, ConversationSummary[]>();
  for (const chat of chats) {
    const day = new Date(chat.updated_at).toDateString();
    const label = chat.pinned
      ? 'Pinned'
      : day === today
        ? 'Today'
        : day === yesterday
          ? 'Yesterday'
          : 'Earlier';
    groups.set(label, [...(groups.get(label) ?? []), chat]);
  }
  const order = ['Pinned', 'Today', 'Yesterday', 'Earlier'];
  return order.filter((key) => groups.has(key)).map((key) => [key, groups.get(key) ?? []]);
}

function ChatRow({ chat, active }: { chat: ConversationSummary; active: boolean }) {
  const { refreshConversations } = useApp();
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [rename, setRename] = useState<string | null>(null);
  const close = useCallback(() => setMenu(false), []);
  return (
    <div style={{ position: 'relative' }}>
      <a
        className="chat-row"
        href={href(`/chat/${chat.id}`)}
        aria-current={active ? 'page' : undefined}
        data-menu={menu ? 'true' : undefined}
      >
        <span className="chat-dot">
          {active ? (
            <span
              style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--primary)' }}
            />
          ) : null}
        </span>
        <span className="clamp1 grow">{chat.title}</span>
        <span style={{ width: 22, flexShrink: 0 }} />
      </a>
      <button
        type="button"
        className="chat-more"
        style={{
          position: 'absolute',
          right: 10,
          top: 6,
          display: 'flex',
          width: 22,
          height: 22,
          borderRadius: 6,
          color: 'var(--muted)',
          background: 'var(--line)',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        aria-label={`Options for ${chat.title}`}
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu((open) => !open)}
      >
        <Icon name="more" size={14} />
      </button>
      <Popover open={menu} onClose={close} align="right" offset={-4}>
        <Menu label={`Options for ${chat.title}`}>
          <MenuItem
            icon="pencil"
            onSelect={() => {
              close();
              setRename(chat.title);
            }}
          >
            Rename
          </MenuItem>
          <MenuItem
            icon="pin"
            onSelect={() => {
              close();
              void adapter.pin(chat.id, !chat.pinned).then(refreshConversations);
            }}
          >
            {chat.pinned ? 'Unpin' : 'Pin to top'}
          </MenuItem>
          <MenuItem
            icon="share"
            onSelect={() => {
              close();
              void navigator.clipboard?.writeText(`${window.location.origin}/#/chat/${chat.id}`);
              toast({ kind: 'ok', title: 'Link copied', sub: 'Anyone with it sees this chat.' });
            }}
          >
            Share chat
          </MenuItem>
          <MenuSep />
          <MenuItem
            icon="trash"
            danger
            onSelect={() => {
              close();
              setConfirm(true);
            }}
          >
            Delete
          </MenuItem>
        </Menu>
      </Popover>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete this chat?"
        sub="The conversation and its drafts are removed. Anything you saved to a plan stays."
        icon="trash"
        tone="danger"
        width={400}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirm(false);
                void adapter.deleteConversation(chat.id).then(() => {
                  refreshConversations();
                  if (active) navigate('/chat');
                });
              }}
            >
              Delete chat
            </Button>
          </>
        }
      />
      <Dialog
        open={rename !== null}
        onClose={() => setRename(null)}
        title="Rename chat"
        width={400}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRename(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const title = rename?.trim();
                setRename(null);
                if (!title) return;
                void adapter.rename(chat.id, title).then(refreshConversations);
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <Input
          value={rename ?? ''}
          onChange={(event) => setRename(event.target.value)}
          width="100%"
          aria-label="Chat title"
        />
      </Dialog>
    </div>
  );
}

function AccountMenu() {
  const { session, refreshSession } = useApp();
  const [open, setOpen] = useState(false);
  const [theme, setTheme, dark] = useTheme();
  const close = useCallback(() => setOpen(false), []);
  const profile = session.profile;
  const initials = (profile?.name ?? 'You')
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
            {profile?.name ?? 'You'}
          </span>
          <span className="clamp1" style={{ fontSize: 12, color: 'var(--muted)' }}>
            {profile?.space ?? 'Personal'} workspace
          </span>
        </span>
        <span style={{ color: 'var(--muted)', display: 'flex' }}>
          <Icon name="chevronsUpDown" size={16} />
        </span>
      </button>
      <Popover open={open} onClose={close} side="top" offset={4}>
        <Menu label="Account" width={232}>
          <Overline style={{ padding: '6px 8px 2px' }}>{profile?.name ?? 'You'}</Overline>
          <div style={{ padding: '0 8px 6px', fontSize: 12, color: 'var(--muted)' }}>
            {profile?.email ?? ''}
          </div>
          <MenuSep />
          <MenuItem icon="user" on>
            {profile?.space ?? 'Personal'}
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
          <MenuSep />
          <MenuItem
            icon="logout"
            danger
            onSelect={() => {
              close();
              void adapter.signOut().then(() => {
                refreshSession();
                navigate('/welcome');
              });
            }}
          >
            Sign out
          </MenuItem>
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
              <div
                key={label}
                className="col"
                style={{ marginTop: label === 'Pinned' || label === 'Today' ? 4 : 8 }}
              >
                <div className="group-label">{label}</div>
                {chats.map((chat) => (
                  <ChatRow key={chat.id} chat={chat} active={chat.id === activeChat} />
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
  const { session } = useApp();
  return (
    <header className="topbar">
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        style={{ paddingLeft: 10, paddingRight: 8, color: 'var(--text)' }}
      >
        {session.profile?.space ?? 'Personal'}
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

const TINT: Record<DayPanel['events'][number]['tint'], string> = {
  primary: 'var(--primary)',
  sage: 'var(--sage-ink)',
  sand: 'var(--sand-ink)',
  lilac: 'var(--lilac-ink)',
};

export function Rail({ onClose, sheet = false }: { onClose?: () => void; sheet?: boolean }) {
  const day = useLoad(() => adapter.day(), []);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const data = day.data;
  const doneCount = data?.tasks.filter((t) => t.done).length ?? 0;
  const total = data?.tasks.length ?? 0;
  let lastDay = '';
  return (
    <aside className="rail" aria-label="Your day">
      <div className="col" style={{ gap: 10 }}>
        <div className="row" style={{ justifyContent: 'space-between', height: 28 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>Your day</h2>
          <span className="row" style={{ gap: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)', paddingRight: 4 }}>
              {data?.month ?? ''}
            </span>
            {sheet && onClose ? (
              <IconButton name="x" label="Close" size={28} iconSize={14} onClick={onClose} />
            ) : null}
          </span>
        </div>
        <div className="rail-week">
          {(data?.week ?? []).map((d) => (
            <div key={d.date} className="rail-day">
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
                  background: d.has_events
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
      <section className="col" style={{ gap: 8 }}>
        <div className="row" style={{ justifyContent: 'space-between', height: 28 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600 }}>Upcoming</h3>
        </div>
        <div className="col" style={{ gap: 4 }}>
          {(data?.events ?? []).map((event) => {
            const showDay = event.day && event.day !== lastDay;
            if (event.day) lastDay = event.day;
            return (
              <div key={event.id} className="event-row">
                <div className="col" style={{ width: 60, flexShrink: 0, gap: 2 }}>
                  {showDay ? <span className="overline">{event.day}</span> : null}
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--secondary)' }}>
                    {event.time}
                  </span>
                </div>
                <div
                  style={{
                    width: 2,
                    height: 28,
                    borderRadius: 2,
                    background: TINT[event.tint],
                    flexShrink: 0,
                  }}
                />
                <div className="col" style={{ minWidth: 0, gap: 2 }}>
                  <span
                    className="clamp1"
                    style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}
                  >
                    {event.title}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {event.duration}
                    {event.place ? ` · ${event.place}` : ''}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>
      <div className="hairline" />
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
                  width: `${total ? (doneCount / total) * 100 : 0}%`,
                  height: '100%',
                  background: 'var(--primary)',
                }}
              />
            </span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {doneCount} of {total}
            </span>
            <IconButton name="plus" label="Add a task" size={28} onClick={() => setAdding(true)} />
          </span>
        </div>
        <div className="col">
          {(data?.tasks ?? []).map((task) => (
            <div key={task.id} className="task-row" data-done={task.done ? 'true' : undefined}>
              <Checkbox
                checked={task.done}
                label={task.text}
                onChange={(done) =>
                  void adapter.toggleTask(task.id, done).then((r) => r.data && day.set(r.data))
                }
              />
              <span className="clamp1">{task.text}</span>
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
                void adapter.addTask(text).then((r) => r.data && day.set(r.data));
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
      <a
        href={href('/settings/connections')}
        className="row"
        style={{ gap: 6, fontSize: 12, color: 'var(--muted)' }}
      >
        <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--success)' }} />
        {data?.connections_synced ?? 0} connections · synced
      </a>
    </aside>
  );
}

export type ShellProps = {
  children: ReactNode;
  /** The phone header's title and the agent chip beside it. */
  title?: string;
  agentId?: string | null;
  /** A docked panel replaces the rail (plans sheet, agent editor, browser). */
  panel?: ReactNode;
  /** Hide the rail entirely for this screen. */
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
                {agent ? <AgentFace look={agent.look} size={18} /> : null}
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
