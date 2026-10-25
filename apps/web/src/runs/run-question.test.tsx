/**
 * A question with answers to press can be answered wherever it is shown: on
 * the work's own page and on Home's card, with the answers as buttons.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppContext, type AppContextValue } from '../experience/hooks.ts';
import type { Question, Run } from '../experience/types.ts';
import { DecisionCard } from '../screens/Home.tsx';
import { questionOfRun, RunQuestion } from './RunQuestion.tsx';

const privacy: Question = {
  id: 'qst_1',
  conversation_id: 'job_run',
  text: 'This conversation looks like it is about personal finances.',
  why: [],
  if_ignored: 'Nothing is sent to a cloud model until you answer.',
  options: [
    { id: 'send_redacted', label: 'Send a redacted version' },
    { id: 'keep_private', label: 'Keep it private' },
  ],
  free_text: false,
  created_at: '2026-10-09T08:00:00.000Z',
} as Question;

const app = { agents: [], conversations: [], refreshConversations: () => {} };
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <AppContext.Provider value={app as unknown as AppContextValue}>{node}</AppContext.Provider>,
  );

test('the work page finds the question this work asked, and only one with answers to press', () => {
  const run = { id: 'job_run' } as Run;
  const other = { ...privacy, id: 'qst_2', conversation_id: 'job_other' };
  const words = { ...privacy, id: 'qst_3', options: [], free_text: true };
  expect(questionOfRun(run, [other, privacy])?.id).toBe('qst_1');
  expect(questionOfRun(run, [other])).toBeNull();
  expect(questionOfRun(run, [words])).toBeNull();
});

test('the work page shows both answers as buttons', () => {
  const html = render(<RunQuestion question={privacy} />);
  expect(html).toContain(privacy.text);
  expect(html).toMatch(/<button[^>]*class="question-option"[^>]*>.*Send a redacted version/);
  expect(html).toMatch(/<button[^>]*class="question-option"[^>]*>.*Keep it private/);
  // The reply box under it takes the person's own words; the card adds no second one.
  expect(html).not.toContain('aria-label="Your own answer"');
});

test('Home’s card for long work’s question shows both answers as buttons', () => {
  const html = render(
    <DecisionCard
      decision={{ kind: 'question', id: privacy.id, question: privacy }}
      conversation={undefined}
      run={{ id: 'job_run', title: 'Used cars under $20k' }}
      agent={null}
      linked={null}
      now={Date.parse('2026-10-09T09:00:00.000Z')}
      busy={false}
      onDecide={() => {}}
      onAnswer={() => {}}
      onDismiss={() => {}}
    />,
  );
  expect(html).toContain('from “Used cars under $20k”');
  expect(html).toMatch(/<button[^>]*class="question-option"[^>]*>.*Send a redacted version/);
  expect(html).toMatch(/<button[^>]*class="question-option"[^>]*>.*Keep it private/);
  expect(html).toContain('Read it all');
});
