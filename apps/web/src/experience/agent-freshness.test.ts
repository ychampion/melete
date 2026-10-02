/**
 * An agent made through the API or in another tab shows up without a reload:
 * a link to it, a chat started with it or a chat it answers makes the app read
 * its agents again, once per agent it does not know.
 */
import { expect, test } from 'bun:test';
import type { Route } from '../router.ts';
import { agentIdsIn, throttled, unknownAgentIds } from './agent-freshness.ts';

const at = (hash: string): Route => {
  const [path = '/', query = ''] = hash.split('?');
  return { path, parts: path.split('/').filter(Boolean), query: new URLSearchParams(query) };
};
const chats = [
  { id: 'job_1', agent_id: 'agt_melete' },
  { id: 'job_2', agent_id: 'agt_atlas' },
];
const known = [{ id: 'agt_melete' }, { id: 'agt_nova' }];

test('a link to an agent the app has not read makes it read the list again', () => {
  const named = agentIdsIn(at('/agents/agt_new'), []);
  expect(unknownAgentIds(named, known, new Set())).toEqual(['agt_new']);
  // A draft is not an agent yet.
  expect(agentIdsIn(at('/agents/new'), [])).toEqual([]);
});

test('a new chat started with an agent, and a chat another agent answers, name it', () => {
  expect(agentIdsIn(at('/chat/new?agent=agt_new'), [])).toEqual(['agt_new']);
  const named = agentIdsIn(at('/chat/job_2'), chats);
  expect(named).toContain('agt_atlas');
  expect(unknownAgentIds(named, known, new Set())).toEqual(['agt_atlas']);
});

test('an agent already known, or already asked about, is not read again', () => {
  const named = agentIdsIn(at('/chats'), chats);
  expect(unknownAgentIds(named, [...known, { id: 'agt_atlas' }], new Set())).toEqual([]);
  expect(unknownAgentIds(named, known, new Set(['agt_atlas']))).toEqual([]);
});

test('focus, visibility and a view change close together read once', () => {
  let now = 0;
  let reads = 0;
  const read = throttled(
    () => reads++,
    2000,
    () => now,
  );
  read();
  read();
  now = 1500;
  read();
  expect(reads).toBe(1);
  now = 2500;
  read();
  expect(reads).toBe(2);
});
