/**
 * When what waits on the person cannot be read, Home says so in plain words
 * and offers to read it again, rather than drawing an empty queue as if
 * nothing were waiting.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AppContext,
  type AppContextValue,
  type Decisions,
  NO_DECISIONS,
} from '../experience/hooks.ts';
import { WaitingOnYou } from './Home.tsx';

function render(decisions: Decisions) {
  const app = {
    agents: [],
    conversations: [],
    decisions,
    refreshConversations: () => {},
  } as unknown as AppContextValue;
  return renderToStaticMarkup(
    <AppContext.Provider value={app}>
      <WaitingOnYou
        decisions={{ ...decisions, count: 0 }}
        map={null}
        now={Date.parse('2026-09-23T09:00:00.000Z')}
        onCleared={() => {}}
      />
    </AppContext.Provider>,
  );
}

test('a list that could not be read is said plainly, with a way to read it again', () => {
  const html = render({
    ...NO_DECISIONS,
    loaded: true,
    error: 'Couldn’t reach Melete. Check that the service is running.',
  });
  expect(html).toContain('Waiting on you');
  expect(html).toContain('Couldn’t read what’s waiting on you.');
  expect(html).toContain('Try again');
});

test('nothing waiting and nothing wrong draws no section at all', () => {
  expect(render({ ...NO_DECISIONS, loaded: true })).toBe('');
});
