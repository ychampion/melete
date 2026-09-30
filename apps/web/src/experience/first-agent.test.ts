import { expect, test } from 'bun:test';
import { blankAgent } from '../screens/Agents.tsx';
import { agentForFirstMessage } from './first-agent.ts';
import type { Agent } from './types.ts';

const agent = (id: string) => ({ id }) as Agent;
const fallback = { ...blankAgent(), name: 'Nova' };

function calls(listed: Agent[] | 'failed') {
  const made: string[] = [];
  return {
    made,
    agents: async () =>
      listed === 'failed'
        ? { data: null, error: 'Couldn’t reach Melete.', unavailable: null }
        : { data: { agents: listed }, error: null, unavailable: null },
    createAgent: async () => {
      made.push('agt_new');
      return { data: { agent: agent('agt_new') }, error: null, unavailable: null };
    },
  };
}

test('an agent the page already knows is used as it is', async () => {
  const api = calls([]);
  expect(await agentForFirstMessage('agt_known', fallback, api)).toEqual({
    id: 'agt_known',
    created: false,
  });
  expect(api.made).toEqual([]);
});

test('a list that has not loaded yet does not make a second agent', async () => {
  const api = calls([agent('agt_existing')]);
  expect(await agentForFirstMessage(undefined, fallback, api)).toEqual({
    id: 'agt_existing',
    created: false,
  });
  expect(api.made).toEqual([]);
});

test('a list that failed to load makes nothing and says why', async () => {
  const api = calls('failed');
  expect(await agentForFirstMessage(undefined, fallback, api)).toEqual({
    error: 'Couldn’t reach Melete.',
  });
  expect(api.made).toEqual([]);
});

test('with no agent at all, the default one is made once', async () => {
  const api = calls([]);
  expect(await agentForFirstMessage(undefined, fallback, api)).toEqual({
    id: 'agt_new',
    created: true,
  });
  expect(api.made).toEqual(['agt_new']);
});
