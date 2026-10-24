import type { IconName } from '../design/icons.tsx';

/** The sections the sidebar lists, in order. */
export const NAV: {
  icon: IconName;
  label: string;
  path: string;
  match: (path: string) => boolean;
}[] = [
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
  { icon: 'users', label: 'Rooms', path: '/rooms', match: (p) => p.startsWith('/rooms') },
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
  { icon: 'files', label: 'Files', path: '/files', match: (p) => p.startsWith('/files') },
  { icon: 'apps', label: 'Apps', path: '/apps', match: (p) => p.startsWith('/apps') },
];

/**
 * The sections a sign-in reaches. A guest reaches only the rooms they were
 * invited to: Home, chats, Companies, Work, Agents, Memory, Automations,
 * Files, Apps and Settings are a person's own and stay out of their sidebar. Rooms are
 * listed only where the server has them switched on. A member of someone
 * else's shared space chats with its agents but does not make or change them,
 * so Agents is not theirs; nor is Memory, which is kept in a person's own space.
 * Companies is left out where the operator turned it off.
 */
const OWNERS_ONLY: ReadonlySet<string> = new Set(['/agents', '/settings/memory']);
export const sidebarNav = (
  guest: boolean,
  multiplayer = true,
  member = false,
  companies = true,
): typeof NAV =>
  guest
    ? NAV.filter((item) => item.path === '/rooms')
    : NAV.filter(
        (item) =>
          (multiplayer || item.path !== '/rooms') &&
          (companies || item.path !== '/companies') &&
          !(member && OWNERS_ONLY.has(item.path)),
      );
