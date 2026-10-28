import { expect, test } from 'bun:test';
import { answerText } from './reply-to.ts';

const said = (text: string) => ({ type: 'text_delta', text });
const tool = { type: 'tool_call_proposed', text: '' };

test('an answer quoted for a reply keeps the words after the tools it called', () => {
  expect(
    answerText([
      said('Let me look '),
      said('for flights.'),
      tool,
      tool,
      said(' Three flights: 1. TAP, '),
      said('2. easyJet, 3. Ryanair.'),
    ]),
  ).toBe('Let me look for flights.\nThree flights: 1. TAP, 2. easyJet, 3. Ryanair.');
});

test('an answer with no tool calls is its pieces joined as streamed', () => {
  expect(answerText([said('Two '), said('options.')])).toBe('Two options.');
});

test('a tool call before any words adds no break', () => {
  expect(answerText([tool, said('Done.')])).toBe('Done.');
});
