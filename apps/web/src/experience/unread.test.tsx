/**
 * A reminder that came due shows wherever the person is: the chat is marked in
 * the sidebar and the chat list, Home lists it under "Needs you" with a way to
 * open it, and the tab's title counts it. Seeing it goes through its chat.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { statusWord } from '../screens/Chats.tsx';
import { NeedsYouRow, needsYouApi } from '../screens/NeedsYouSection.tsx';
import { PUSH_OFFER_LINE } from '../screens/Notifications.tsx';
import { Shell, sidebarChats } from '../shell/Shell.tsx';
import { client } from './adapter.ts';
import { AppContext, type AppContextValue, NO_DECISIONS } from './hooks.ts';
import type { Conversation, NeedsYouItem } from './types.ts';
import { tabTitle, unreadChats } from './unread.ts';

const chat = (id: string, extra: Partial<Conversation> = {}): Conversation => ({
  id,
  title: `Chat ${id}`,
  agent_id: 'agent_1',
  status: 'done',
  composer: 'send',
  created_at: '2026-10-25T18:00:00.000Z',
  updated_at: '2026-10-25T18:00:00.000Z',
  plan_id: null,
  ...extra,
});

const reminder: NeedsYouItem = {
  id: 'turn_1',
  source: 'reminder',
  sentence: 'Time to call Sam back.',
  reason: 'It came due at the time you set.',
  because: {
    kind: 'reminder',
    label: 'You asked for a reminder',
    handle: 'turn:turn_1',
    subject: 'Call Sam back',
    at: '2026-10-25T18:52:00.000Z',
  },
  urgency: 'normal',
  seen: false,
  created_at: '2026-10-25T18:52:00.000Z',
  chat_prompt: null,
  conversation_id: 'job_sam',
};

test('the tab says how many chats wait unread, and only then', () => {
  expect(tabTitle('Melete', 0)).toBe('Melete');
  expect(tabTitle('Melete', 2)).toBe('(2) Melete');
  expect(unreadChats([chat('a'), chat('b', { unread: true })]).map((c) => c.id)).toEqual(['b']);
});

test('an unread chat is listed with those that want the person, ahead of the latest', () => {
  const latest = Array.from({ length: 9 }, (_, i) => chat(`new${i}`));
  const old = chat('sam', { unread: true });
  expect(
    sidebarChats([...latest, old], null)
      .slice(0, 2)
      .map((c) => c.id),
  ).toEqual(['sam', 'new0']);
});

test('the chat list says a chat has a new message, below a decision that waits', () => {
  const sam = chat('job_sam', { unread: true });
  expect(statusWord(sam, new Set())).toBe('New message');
  expect(statusWord(sam, new Set(['job_sam']))).toBe('Waiting for you');
  expect(statusWord(chat('job_other'), new Set())).toBe('Done');
});

test('a reminder on Home opens its chat or is marked seen; it is never dismissed or handled', () => {
  const html = renderToStaticMarkup(
    <NeedsYouRow
      item={reminder}
      now={Date.parse('2026-10-25T19:00:00.000Z')}
      busy={false}
      onStart={() => {}}
      onMark={() => {}}
    />,
  );
  expect(html).toContain('Time to call Sam back.');
  expect(html).toContain('href="#/chat/job_sam"');
  expect(html).toContain('Because: You asked for a reminder');
  expect(html).toContain('Seen');
  expect(html).not.toContain('Dismiss');
  expect(html).not.toContain('Handle it');
});

const original = client.options.fetch;
afterEach(() => {
  (client.options as { fetch: typeof fetch }).fetch = original;
});

test('marking a reminder seen on Home sees its chat', async () => {
  const asked: string[] = [];
  (client.options as { fetch: typeof fetch }).fetch = (async (url: string, init?: RequestInit) => {
    asked.push(`${init?.method ?? 'GET'} ${String(url)}`);
    return Response.json({ conversation: chat('job_sam') });
  }) as typeof fetch;
  await needsYouApi.mark(reminder, 'ack');
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatch(/^POST .*\/conversations\/job_sam\/seen$/);
});

test('the offer on Home says reminders are included, and that they come on time', () => {
  expect(PUSH_OFFER_LINE).toContain('Reminders');
  expect(PUSH_OFFER_LINE).toContain('on time');
});

// The shell reads the window size and the address; on the server it has neither.
const media = { matches: false, addEventListener() {}, removeEventListener() {} };
const hadWindow = 'window' in globalThis;
const before = (globalThis as { window?: unknown }).window;
beforeAll(() => {
  Object.assign(globalThis, {
    window: {
      matchMedia: () => media,
      location: { hash: '#/', pathname: '/', search: '' },
      addEventListener() {},
      removeEventListener() {},
    },
  });
});
afterAll(() => {
  if (hadWindow) Object.assign(globalThis, { window: before });
  else delete (globalThis as { window?: unknown }).window;
});

test('the sidebar marks an unread chat for eyes and for a screen reader', () => {
  const app = {
    capabilities: { calendar: false, browser: false, multiplayer: false, features: {} },
    profile: null,
    onboarded: true,
    setOnboarded: () => {},
    agents: [],
    removedAgents: [],
    conversations: [chat('job_sam', { unread: true }), chat('job_other')],
    conversationsError: null,
    decisions: { ...NO_DECISIONS, loaded: true },
    refreshProfile: () => {},
    refreshConversations: () => {},
    refreshAgents: () => {},
    accountSwitched: () => {},
    signOut: async () => {},
    member: false,
  } as unknown as AppContextValue;
  const html = renderToStaticMarkup(
    <AppContext.Provider value={app}>
      <Shell title="Home">
        <p>body</p>
      </Shell>
    </AppContext.Provider>,
  );
  const sam = html.slice(html.indexOf('#/chat/job_sam'), html.indexOf('#/chat/job_other'));
  expect(sam).toContain('data-unread="true"');
  expect(sam).toContain(', new message');
  const other = html.slice(html.indexOf('#/chat/job_other'));
  expect(other.slice(0, other.indexOf('</a>'))).not.toContain('new message');
});
