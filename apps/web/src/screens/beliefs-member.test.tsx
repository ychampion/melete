/**
 * Memory is a person's own. A member of someone else's shared space is told
 * so calmly, with nothing to press that would do nothing there.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppContext, type AppContextValue, NO_DECISIONS } from '../experience/hooks.ts';
import { MemoryPanel } from './Beliefs.tsx';

function render(node: React.ReactNode, member: boolean) {
  const app = {
    capabilities: { calendar: false, browser: false, multiplayer: true, features: {} },
    profile: null,
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
  } as unknown as AppContextValue;
  return renderToStaticMarkup(<AppContext.Provider value={app}>{node}</AppContext.Provider>);
}

// The page reads its address on first render; there is no browser here.
const scope = globalThis as { window?: unknown };
let saved: unknown;
beforeEach(() => {
  saved = scope.window;
  scope.window = { location: { hash: '#/settings/memory' } };
});
afterEach(() => {
  scope.window = saved;
});

test("a member's Memory page says memory is kept in their own space, with nothing to press", () => {
  const html = render(<MemoryPanel />, true);
  expect(html).toContain('Memory is kept in your own space');
  expect(html).not.toContain('belief-error');
  for (const action of ['Export JSON', 'Export Markdown', 'Import', 'Learn from my chats'])
    expect(html).not.toContain(action);
  expect(html).not.toContain('<button');
});

test("an owner's Memory page keeps its actions", () => {
  const html = render(<MemoryPanel />, false);
  expect(html).not.toContain('Memory is kept in your own space');
  expect(html).toContain('Export JSON');
  expect(html).toContain('Import');
});
