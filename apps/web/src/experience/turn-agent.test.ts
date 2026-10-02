import { expect, test } from 'bun:test';
import { turnAgent } from './hooks.ts';
import type { Agent } from './types.ts';

const agent = (id: string, name: string) => ({ id, name }) as Agent;

test('a turn names the agent that answered it, a deleted one as removed', () => {
  const live = [agent('agent_melete', 'Melete')];
  const removed = [agent('agent_scout', 'Scout')];
  expect(turnAgent(live, removed, 'agent_melete')?.name).toBe('Melete');
  expect(turnAgent(live, removed, 'agent_scout')?.name).toBe('Scout (removed)');
  expect(turnAgent(live, undefined, 'agent_scout')).toBeNull();
});
