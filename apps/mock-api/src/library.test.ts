/**
 * The mock serves the agent library as the service does, and adding one makes
 * one agent, schedules nothing, and keeps the answers as saved details.
 */
import { expect, test } from 'bun:test';
import {
  agentList,
  agentResponse,
  agentTemplateList,
  automationList,
  libraryAnswers,
  memoryItemList,
} from '@melete/contracts';
import { createMock } from './index.ts';

test('a library agent is added once, its routine is only offered, its answers are kept', async () => {
  const mock = createMock({ speed: 0, experience: { seed: true }, space: 'personal' });
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await mock.app.request(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as unknown;
  };
  const { templates } = agentTemplateList.parse(await call('/agents/templates'));
  expect(templates.length).toBeGreaterThanOrEqual(20);
  const template = templates.find((entry) => entry.id === 'subscription-watcher');
  if (!template) throw new Error('no subscription watcher');
  const before = agentList.parse(await call('/agents')).agents.length;
  const routines = automationList.parse(await call('/automations')).automations.length;

  const made = agentResponse.parse(await call('/agents', 'POST', template.agent)).agent;
  expect(made.allowed_connection_ids).toEqual([]);
  expect(agentList.parse(await call('/agents')).agents).toHaveLength(before + 1);
  expect(automationList.parse(await call('/automations')).automations).toHaveLength(routines);

  for (const detail of libraryAnswers(template.questions, { keep: 'Music' }))
    await call('/memory/items', 'POST', detail);
  const { items } = memoryItemList.parse(await call('/memory/items'));
  expect(items.find((item) => item.key === 'subscriptions: keep')?.value).toBe('Music');
});
