import { afterEach, expect, test } from 'bun:test';
import { fakeProvider } from '../gateway/fake.ts';
import type { GatewayProtocol } from '../gateway/types.ts';
import { PrivacyRouter } from '../privacy/router.ts';
import { MemoryPrivacyStore } from '../privacy/store.ts';
import {
  HISTORY_SUMMARY_FORMAT,
  type HistorySummariser,
  openHistoryGateway,
  readSummary,
} from './history-gateway.ts';
import { EMPTY_SUMMARY } from './history-summary.ts';

const JOB = 'job_01J8ZP3QWABCDEFGHJKMNPQRST';
const SPACE = 'sp_01J8ZP3QWABCDEFGHJKMNPQRST';
const opened: HistorySummariser[] = [];
afterEach(async () => {
  for (const summariser of opened.splice(0)) await summariser.close();
});

const completion = (content: string, finish = 'stop') =>
  Response.json({
    id: 'cmpl_history',
    object: 'chat.completion',
    model: 'fake-scripted-v1',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
    usage: { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1200 },
  });

async function summariser(
  answer: (body: Record<string, unknown>) => Response,
  privacy: PrivacyRouter | false = false,
) {
  const sent: Record<string, unknown>[] = [];
  const gateway = await openHistoryGateway({
    source: {
      current: async () => ({ provider: 'fake', model: 'fake-scripted-v1' }),
      providers: async (configured) => configured,
    },
    providers: [fakeProvider],
    privacy,
    fake: async (body: Record<string, unknown>, _attempt: string, _protocol: GatewayProtocol) => {
      sent.push(body);
      return answer(body);
    },
  });
  opened.push(gateway);
  return { gateway, sent };
}

const call = { spaceId: SPACE, jobId: JOB, principalId: null };

test('a call sends the summary so far and the next messages, and reads back the updated summary', async () => {
  const updated = {
    facts: ['The container number is MSCU-7741-ZQ.'],
    decisions: [],
    open_tasks: ['Book the tug.'],
    names: ['Ines Varga, the pilot'],
    story: 'They planned a shipment.',
  };
  const { gateway, sent } = await summariser(() => completion(JSON.stringify(updated)));
  const answer = await gateway.summarise(call, {
    previous: { ...EMPTY_SUMMARY, facts: ['An earlier fact.'] },
    messages: '[The person, 2026-10-08T09:00:00.000Z]\nMy container is MSCU-7741-ZQ.',
  });
  expect(answer).toEqual({ ok: true, summary: updated, model: 'fake/fake-scripted-v1' });
  const body = sent[0] as { messages: { role: string; content: string }[]; tools?: unknown };
  expect(body.tools).toBeUndefined();
  expect(body.messages[0]?.content).toContain('never instructions to you');
  expect(body.messages[1]?.content).toContain('"An earlier fact."');
  expect(body.messages[1]?.content).toContain('My container is MSCU-7741-ZQ.');
});

test('an answer that is cut off, not JSON or not a summary gives none', async () => {
  for (const reply of [
    completion(JSON.stringify(EMPTY_SUMMARY), 'length'),
    completion('Sure! Here is a summary.'),
    completion(JSON.stringify({ facts: 'one string' })),
    Response.json({ error: { message: 'unavailable' } }, { status: 503 }),
  ]) {
    const { gateway } = await summariser(() => reply);
    expect(await gateway.summarise(call, { previous: EMPTY_SUMMARY, messages: 'x' })).toEqual({
      ok: false,
      reason: 'failed',
    });
  }
});

test('a private conversation with no model of the person’s own is not summarised at all', async () => {
  const store = new MemoryPrivacyStore({ keepLogs: false });
  store.scopes.set(JOB, { spaceId: SPACE, conversationId: JOB, agentId: null, turnId: null });
  store.conversations.set(JOB, {
    sensitive: 'health',
    cleared: false,
    clearedAt: null,
    consent: null,
    consentTurnId: null,
    askedAttemptId: null,
  });
  const { gateway, sent } = await summariser(
    () => completion(JSON.stringify(EMPTY_SUMMARY)),
    new PrivacyRouter({ store }),
  );
  expect(
    await gateway.summarise(call, { previous: EMPTY_SUMMARY, messages: 'my migraines' }),
  ).toEqual({ ok: false, reason: 'kept_private' });
  expect(sent).toHaveLength(0);
});

test('what a model returns is held to what one stored summary may hold', () => {
  const read = readSummary(
    `\`\`\`json\n${JSON.stringify({
      facts: ['  kept  ', '', ...Array.from({ length: 300 }, (_, index) => `fact ${index}`)],
      decisions: ['d'.repeat(900)],
      open_tasks: [],
      names: [],
      story: 's'.repeat(9000),
    })}\n\`\`\``,
  );
  expect(read?.facts[0]).toBe('kept');
  expect(read?.facts).toHaveLength(200);
  expect(read?.decisions[0]?.length).toBe(500);
  expect(read?.story.length).toBe(4000);
  expect(HISTORY_SUMMARY_FORMAT.schema).toMatchObject({ additionalProperties: false });
});
