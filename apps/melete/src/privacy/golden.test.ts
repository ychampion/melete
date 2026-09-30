/**
 * The whole outbound request for a realistic bill-paying conversation, as the
 * engine would send it: identity and memory in the system prompt, the person's
 * turns, a tool call, a mailbox result, and the tool catalog. The request that
 * leaves the gateway is compared field by field and string by string with the
 * reviewed golden copy, and no raw sensitive value may appear anywhere in it.
 *
 * `UPDATE_GOLDEN=1 bun test apps/melete/src/privacy/golden.test.ts` rewrites
 * the copy; review the diff before committing it.
 */
import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createModelGateway } from '../gateway/index.ts';
import { PrivacyRouter } from './router.ts';
import { MemoryPrivacyStore } from './store.ts';

const GOLDEN = new URL('./fixtures/finance-outbound.json', import.meta.url);

/** Everything in the conversation that must not reach the provider. */
const SENSITIVE = [
  'Sam Rivera',
  'Priya Rivera',
  '742 Evergreen Terrace',
  '62704',
  '(415) 555-0132',
  'sam.rivera@example.org',
  'priya.r@example.net',
  'billing@citypower.example.com',
  '4400 1234 5678',
  '000123456789',
  '021000021',
  '7741 2290 0183',
  '1-800-555-0199',
  '4242',
  '123-45-6789',
  '03/14/1988',
  '4111 1111 1111 1111',
  '737',
  'Tr0ub4dor&3',
];

/** What must survive: the task is useless without it. */
const KEPT = ['$142.17', '2026-10-15', 'City Power', 'electricity bill', 'payments.send'];

const request = {
  model: 'cloud-model',
  stream: true,
  max_tokens: 1024,
  messages: [
    {
      role: 'system',
      content: [
        'You are Melete, a personal assistant that acts only with the person’s approval.',
        '',
        '## What you know about the person',
        '- Name: Sam Rivera',
        '- Home: 742 Evergreen Terrace, Springfield, IL 62704',
        '- Phone: (415) 555-0132',
        '- Email: sam.rivera@example.org',
        '- Sister: Priya Rivera (priya.r@example.net)',
        '- Pays household bills from the joint checking account 4400 1234 5678.',
      ].join('\n'),
    },
    {
      role: 'user',
      content:
        'Please pay this month’s electricity bill from my checking account 000123456789 (routing 021000021) and email the receipt to my sister.',
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'mail.search',
            arguments: JSON.stringify({
              query: 'from:billing@citypower.example.com newer_than:30d',
            }),
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: JSON.stringify({
        messages: [
          {
            from: 'billing@citypower.example.com',
            subject: 'Your September bill from City Power',
            body: 'Dear Sam Rivera,\nAccount number: 7741 2290 0183\nService address: 742 Evergreen Terrace, Springfield, IL 62704\nAmount due: $142.17 by 2026-10-15.\nPay online or call 1-800-555-0199.\nCard on file ending in 4242.',
          },
        ],
      }),
    },
    {
      role: 'assistant',
      content:
        'I found your September electricity bill from City Power: $142.17, due 2026-10-15. I will pay it from checking account 000123456789 and send the receipt to Priya Rivera at priya.r@example.net. Shall I go ahead?',
    },
    {
      role: 'user',
      content:
        'Yes. If they need to verify, my SSN is 123-45-6789 and my date of birth is 03/14/1988. If the bank transfer fails use my card 4111 1111 1111 1111 exp 09/28, CVV 737. My online banking password is Tr0ub4dor&3.',
    },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'payments.send',
        description:
          'Send a payment from a connected bank account owned by sam.rivera@example.org.',
        parameters: {
          type: 'object',
          properties: {
            from_account: { type: 'string', description: 'The account to pay from' },
            payee: { type: 'string' },
            amount: { type: 'string', description: 'Amount in dollars, for example 142.17' },
          },
          required: ['from_account', 'payee', 'amount'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'email.send',
        description: 'Send an email from the person’s mailbox.',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string' },
            subject: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['to', 'subject', 'body'],
        },
      },
    },
  ],
};

let server: Server | undefined;
afterAll(() => server?.close());

test('the full outbound request for a finance conversation carries placeholders only', async () => {
  const store = new MemoryPrivacyStore();
  store.scopes.set('job_finance', {
    spaceId: 'spc_1',
    conversationId: 'job_finance',
    agentId: null,
    turnId: 'trn_2',
  });
  // The person listed their own and their sister's names as private.
  await store.saveSettings(
    'spc_1',
    {},
    {
      known: [
        { id: 'pv_1', label: 'Me', category: 'name', value: 'Sam Rivera' },
        { id: 'pv_2', label: 'Sister', category: 'name', value: 'Priya Rivera' },
      ],
    },
  );
  let outbound = '';
  server = createModelGateway({
    authenticate: async () => ({
      jobId: 'job_finance',
      attemptId: 'att_finance',
      epoch: 1,
      revision: 1,
      maxRequests: 5,
      maxTokens: 20_000,
      allowedModels: [{ provider: 'fireworks', model: 'cloud-model' }],
    }),
    budget: { reserve: async () => ({ id: randomUUID() }), settle: async () => {} },
    providers: [
      {
        name: 'fireworks',
        baseUrl: 'https://api.fireworks.ai/inference/v1/',
        apiKey: 'provider-key',
        protocols: ['chat/completions'],
      },
    ],
    defaultProvider: 'fireworks',
    privacy: new PrivacyRouter({ store }),
    fetch: async (sent) => {
      outbound = await sent.text();
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
  const response = await fetch(
    `http://127.0.0.1:${address.port}/providers/fireworks/v1/chat/completions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer melete-surrogate-test',
        'x-melete-capability': 'attempt',
      },
      body: JSON.stringify(request),
    },
  );
  expect(response.status).toBe(200);
  await response.text();

  for (const value of SENSITIVE) expect([value, outbound.includes(value)]).toEqual([value, false]);
  for (const value of KEPT) expect([value, outbound.includes(value)]).toEqual([value, true]);

  const sent = JSON.parse(outbound);
  if (process.env.UPDATE_GOLDEN === '1')
    writeFileSync(GOLDEN, `${JSON.stringify(sent, null, 2)}\n`);
  // Every field and every string, exactly; the file's own formatting is the formatter's.
  expect(sent).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
});
