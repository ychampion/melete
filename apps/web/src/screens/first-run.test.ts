/**
 * What a new person is offered: the top apps to connect, the morning brief's
 * choices, and the next steps Home shows until each is done or put away.
 */
import { expect, test } from 'bun:test';
import { MORNING_BRIEF_TITLE } from '@melete/contracts/morning-brief';
import type { Automation, CatalogEntry } from '../experience/types.ts';
import { topPicks } from './ConnectionInstall.tsx';
import { firstSteps } from './FirstSteps.tsx';
import {
  BRIEF_TIMES,
  BRIEF_TOPIC_LIMIT,
  clockWords,
  hasMorningBrief,
  toggleTopic,
} from './MorningBrief.tsx';

const google = (available: boolean): CatalogEntry => ({
  id: 'google',
  title: 'Google',
  description: 'Gmail, Google Calendar and Drive.',
  covers: ['mail', 'calendar'],
  connect: {
    method: 'sign_in',
    provider: 'google',
    start: '/google-sign-ins',
    issuer: 'https://accounts.google.com',
    scopes: [],
  },
  available,
});
const microsoft: CatalogEntry = {
  ...google(true),
  id: 'microsoft',
  title: 'Microsoft',
  connect: {
    method: 'sign_in',
    provider: 'microsoft',
    start: '/microsoft-sign-ins',
    issuer: 'https://login.microsoftonline.com',
    scopes: [],
  },
};
const app = (id: string, available = true): CatalogEntry => ({
  id,
  title: id,
  description: `${id} in one sign-in.`,
  covers: ['tools'],
  connect: {
    method: 'mcp_sign_in',
    url: `https://mcp.${id}.example/mcp`,
    suggested_id: id,
    start: '/mcp-sign-ins',
    tools: [{ label: 'Search', effect_class: 'read', asks_first: false }],
  },
  available,
});
const form: CatalogEntry = {
  id: 'imap',
  title: 'Mail',
  description: 'Any IMAP account.',
  covers: ['mail'],
  connect: { method: 'form', kind_id: 'imap' },
  available: true,
};

test('setup offers Google when this server can sign in to it, and nothing else beside it', () => {
  const picks = topPicks([microsoft, google(true), app('notion'), form]);
  expect(picks.accounts.map((entry) => entry.id)).toEqual(['google']);
  expect(picks.apps).toEqual([]);
});

test('without Google, setup offers the first four one-click apps that are ready', () => {
  const picks = topPicks([
    google(false),
    microsoft,
    app('notion'),
    app('github', false),
    app('linear'),
    app('sentry'),
    app('stripe'),
    app('atlassian'),
    form,
  ]);
  expect(picks.accounts).toEqual([]);
  expect(picks.apps.map((entry) => entry.id)).toEqual(['notion', 'linear', 'sentry', 'stripe']);
  expect(topPicks([form, google(false)])).toEqual({ accounts: [], apps: [] });
});

test('the brief comes on a morning half hour, read the way a person says it', () => {
  expect(BRIEF_TIMES).toContain('08:00');
  expect(BRIEF_TIMES[0]).toBe('05:00');
  expect(BRIEF_TIMES.at(-1)).toBe('11:00');
  expect(clockWords('08:00')).toBe('8:00 AM');
  expect(clockWords('07:30')).toBe('7:30 AM');
  expect(clockWords('12:00')).toBe('12:00 PM');
  expect(clockWords('00:15')).toBe('12:15 AM');
});

test('topics turn on and off, and stop at the limit', () => {
  let topics: string[] = [];
  for (const topic of ['World', 'Tech', 'AI', 'Science', 'Sports', 'Markets'])
    topics = toggleTopic(topics, topic);
  expect(topics).toHaveLength(BRIEF_TOPIC_LIMIT);
  expect(topics).not.toContain('Markets');
  expect(toggleTopic(topics, 'Tech')).not.toContain('Tech');
});

const routine = (title: string, ended = false): Automation => ({
  id: `routine_${title}`,
  title,
  schedule: 'Every day at 8:00 AM (UTC)',
  enabled: true,
  ended,
  conversation_id: 'job_1',
  runs: [],
});

test('a brief counts as set up until it ends, paused or not', () => {
  expect(hasMorningBrief([])).toBe(false);
  expect(hasMorningBrief([routine('Weekly review')])).toBe(false);
  expect(hasMorningBrief([routine(MORNING_BRIEF_TITLE, true)])).toBe(false);
  expect(hasMorningBrief([{ ...routine(MORNING_BRIEF_TITLE), enabled: false }])).toBe(true);
});

test('Home offers each next step until it is done or put away, and waits until it knows', () => {
  const none = new Set<'calendar' | 'brief'>();
  expect(firstSteps({ calendar: false, brief: false, dismissed: none })).toEqual([
    'calendar',
    'brief',
  ]);
  expect(firstSteps({ calendar: true, brief: true, dismissed: none })).toEqual([]);
  expect(firstSteps({ calendar: null, brief: null, dismissed: none })).toEqual([]);
  expect(firstSteps({ calendar: false, brief: false, dismissed: new Set(['brief']) })).toEqual([
    'calendar',
  ]);
});
