/**
 * A question on Home names the chat it came from and can be dismissed when
 * the person no longer wants to answer it; the line under the queue never
 * says nothing needs them while something still waits.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AppContext,
  type AppContextValue,
  type Decisions,
  NO_DECISIONS,
} from '../experience/hooks.ts';
import type { Conversation, Question } from '../experience/types.ts';
import { WaitingOnYou } from './Home.tsx';
import { emptyLine, whenWords } from './NeedsYouSection.tsx';

const now = Date.parse('2026-10-09T09:00:00.000Z');

const question: Question = {
  id: 'qa_1',
  conversation_id: 'job_1',
  text: 'Which hotel should I book?',
  why: [],
  if_ignored: 'Nothing is booked.',
  options: [
    { id: 'opt_1', label: 'The one by the river' },
    { id: 'opt_2', label: 'The one near the station' },
  ],
  free_text: true,
  created_at: '2026-10-09T08:00:00.000Z',
} as Question;

function render(decisions: Decisions, conversations: Conversation[]) {
  const app = {
    agents: [],
    conversations,
    decisions,
    refreshConversations: () => {},
  } as unknown as AppContextValue;
  return renderToStaticMarkup(
    <AppContext.Provider value={app}>
      <WaitingOnYou
        decisions={{ ...decisions, count: 0 }}
        map={null}
        now={now}
        onCleared={() => {}}
      />
    </AppContext.Provider>,
  );
}

test('a question card says which chat it came from and offers to dismiss it', () => {
  const chat = { id: 'job_1', title: 'Trip to Kyoto' } as Conversation;
  const html = render({ ...NO_DECISIONS, loaded: true, questions: [question] }, [chat]);
  expect(html).toContain('from “Trip to Kyoto”');
  expect(html).toContain('aria-label="Dismiss: Which hotel should I book?"');
  expect(html).toContain('>Dismiss<');
});

test('the line under the queue does not say nothing needs you while something waits', () => {
  expect(emptyLine(0)).toBe('Nothing needs you right now.');
  expect(emptyLine(2)).toBe('Nothing else needs you right now.');
});

test('a reminder from more than a week ago reads as a date, not a weekday', () => {
  const nineDaysAgo = new Date(now - 9 * 86_400_000).toISOString();
  expect(whenWords(nineDaysAgo, now)).not.toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/);
});
