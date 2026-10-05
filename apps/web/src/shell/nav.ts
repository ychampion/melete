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
  { icon: 'apps', label: 'Apps', path: '/apps', match: (p) => p.startsWith('/apps') },
];

/**
 * The sections a sign-in reaches. A guest reaches only the rooms they were
 * invited to: Home, chats, Companies, Work, Agents, Memory, Automations, Apps
 * and Settings are a person's own and stay out of their sidebar. Rooms are
 * listed only where the server has them switched on.
 */
export const sidebarNav = (guest: boolean, multiplayer = true): typeof NAV =>
  guest
    ? NAV.filter((item) => item.path === '/rooms')
    : multiplayer
      ? NAV
      : NAV.filter((item) => item.path !== '/rooms');
