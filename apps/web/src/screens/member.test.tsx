/**
 * A member of someone else's shared space is shown what is theirs to use:
 * Settings leaves out the tabs that set up the space, and the space's clock
 * reads as its owner's to set.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppContext, type AppContextValue, NO_DECISIONS } from '../experience/hooks.ts';
import type { Profile } from '../experience/types.ts';
import { opensAgents, showsRail } from '../shell/member-guards.ts';
import { AccountSettings } from './AccountSettings.tsx';
import { settingsTab, showsTab } from './Settings.tsx';

const profile = (role: 'owner' | 'member'): Profile => ({
  name: 'Sam',
  time_zone: 'Europe/Paris',
  day_hours: { start: '09:00', end: '18:00' },
  onboarded: true,
  time_zone_confirmed: true,
  sending_address: null,
  role,
  voice: 'teammate',
});

function render(node: React.ReactNode, member: boolean) {
  const app = {
    capabilities: { calendar: false, browser: false, multiplayer: true, features: {} },
    profile: profile(member ? 'member' : 'owner'),
    onboarded: true,
    setOnboarded: () => {},
    agents: [],
    conversations: [],
    conversationsError: null,
    decisions: NO_DECISIONS,
    refreshProfile: () => {},
    refreshConversations: () => {},
    refreshAgents: () => {},
    signOut: async () => {},
    member,
  } as AppContextValue;
  return renderToStaticMarkup(<AppContext.Provider value={app}>{node}</AppContext.Provider>);
}

const OWNER_TABS = ['connections', 'devices', 'approvals', 'rules', 'models', 'privacy'] as const;
const MEMBER_TABS = [
  'account',
  'notifications',
  'people',
  'activity',
  'feedback',
  'memory',
] as const;

test('a member’s Settings lists no tab that sets up the space, and an owner’s lists them all', () => {
  for (const tab of OWNER_TABS) {
    expect(showsTab(tab, true)).toBe(false);
    expect(showsTab(tab, false)).toBe(true);
  }
  for (const tab of MEMBER_TABS) expect(showsTab(tab, true)).toBe(true);
});

test('a member who opens an owner’s tab by its address lands on their account', () => {
  for (const tab of OWNER_TABS) {
    expect(settingsTab(tab, true)).toBe('account');
    expect(settingsTab(tab, false)).toBe(tab);
  }
  for (const tab of MEMBER_TABS) expect(settingsTab(tab, true)).toBe(tab);
  expect(settingsTab('nowhere', true)).toBe('account');
});

test('a member’s pages have no day rail, and neither does a page with a docked panel', () => {
  expect(showsRail({ rail: true, panel: undefined, member: false })).toBe(true);
  expect(showsRail({ rail: true, panel: undefined, member: true })).toBe(false);
  expect(showsRail({ rail: true, panel: 'plan sheet', member: false })).toBe(false);
  expect(showsRail({ rail: false, panel: undefined, member: false })).toBe(false);
});

test('the Agents page opens for an owner and not for a member', () => {
  expect(opensAgents(false)).toBe(true);
  expect(opensAgents(true)).toBe(false);
});

test('a member reads the space’s time zone but does not change it', () => {
  const member = render(<AccountSettings />, true);
  expect(member).toContain('The space’s owner sets it.');
  expect(member).toContain('Paris');
  expect(member).not.toContain('Routines such as the morning brief run on this clock');
  const owner = render(<AccountSettings />, false);
  expect(owner).not.toContain('The space’s owner sets it.');
  expect(owner).toContain('Routines such as the morning brief run on this clock');
});

test('an owner picks the voice; a member reads it', () => {
  const member = render(<AccountSettings />, true);
  expect(member).toContain('Voice');
  expect(member).toContain('Teammate');
  expect(member).not.toContain('Drafts to people you don’t know well');
  const owner = render(<AccountSettings />, false);
  expect(owner).toContain('Drafts to people you don’t know well sound professional either way.');
});
