/**
 * A question that asks for a secret shows a password field in place of the
 * box for the person's own words, so the value is never typed where it would
 * become a message.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Questionnaire } from '../chat/parts.tsx';
import type { Question } from './types.ts';

const QUESTION = {
  id: 'qst_1',
  conversation_id: 'job_1',
  text: 'Could you give me your weather service API key?',
  why: [],
  if_ignored: 'This waits for your answer.',
  options: [],
  free_text: false,
  secret: { name: 'WEATHER_API_KEY', purpose: 'Reading the forecast', host: null },
  created_at: '2026-10-28T09:00:00.000Z',
} as unknown as Question;

const card = (answered: string | null) =>
  renderToStaticMarkup(
    <Questionnaire
      question={QUESTION}
      answered={answered}
      active={false}
      onAnswer={() => {}}
      onOwn={() => {}}
      onSecret={() => {}}
    />,
  );

test('a secret question takes its answer in a sealed password field', () => {
  const open = card(null);
  expect(open).toContain('type="password"');
  expect(open).toContain('autoComplete="off"');
  expect(open).toContain('WEATHER_API_KEY: Reading the forecast');
  expect(open).toContain('Kept sealed');
  // No box for the person's own words, which would send it as a message.
  expect(open).not.toContain('Your own answer');
});

test('once saved, the field is gone', () => {
  expect(card('Saved')).not.toContain('type="password"');
});
