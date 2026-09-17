import { expect, test } from 'bun:test';
import { gist, relevance, stem, terms } from './lexical.ts';

test('inflections and identifier spellings meet at one stem', () => {
  for (const word of ['restart', 'restarts', 'restarted', 'restarting'])
    expect(stem(word)).toBe('restart');
  expect(stem('shared')).toBe(stem('share'));
  expect(stem('submitted')).toBe(stem('submit'));
  expect([...terms('server.restart serverRestart server_restart')].sort()).toEqual([
    'restart',
    'server',
  ]);
  expect(terms('Please tell me whether it is the one')).toEqual(new Set(['one']));
});

test('a name segment outweighs prose and an empty query scores nothing', () => {
  const query = terms('Share the review file with Alex');
  const share = { name: 'files.share', description: 'Give another person access' };
  const read = { name: 'files.read', description: 'Read a file you may later share' };
  expect(relevance(query, share)).toBeGreaterThan(relevance(query, read));
  expect(relevance(new Set(), share)).toBe(0);
});

test('a gist is the first sentence, at most eight words, without closing punctuation', () => {
  expect(gist('Send a message. It needs approval.')).toBe('Send a message');
  expect(gist('one two three four five six seven eight nine ten')).toBe(
    'one two three four five six seven eight',
  );
});
