/**
 * What memory keeps when a person asks for it to be remembered. "Please
 * remember that the offsite budget is $12,000..." in a personal chat was read
 * as one task's details and work shared with a team, and nothing was kept.
 */
import { describe, expect, test } from 'bun:test';
import { extractionMessages, readExtractionReply } from './extract.ts';
import type { ExtractionBatch } from './work.ts';

const said =
  'Please remember that the offsite budget is $12,000, the venue is 500 Harbor Road, the deposit is due November 3, and I shared the plan with the team.';
const evidence = {
  source_id: 'src_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  source_version: '1',
  start: 0,
  text: said,
};

/** One fact as the model read it from the message. */
const fact = (domain_key: string, content: string, quote: string) => ({
  op: 'add',
  claim_id: null,
  expected_revision: null,
  domain_key,
  content,
  kind: 'user_statement',
  factual_status: 'attributed',
  valid_from: '2026-10-16T10:00:00Z',
  valid_until: null,
  sources: [{ quote }],
});
const FACTS = [
  fact('work.offsite.budget', 'Offsite budget is $12,000', 'the offsite budget is $12,000'),
  fact('work.offsite.venue', 'Offsite venue is 500 Harbor Road', 'the venue is 500 Harbor Road'),
  fact(
    'work.offsite.deposit',
    'Offsite deposit is due November 3',
    'the deposit is due November 3',
  ),
  fact(
    'work.offsite.shared',
    'Shared the offsite plan with the team',
    'I shared the plan with the team',
  ),
];

/** The model's answer, every fact read the same way. */
const answer = (read: Record<string, unknown>) =>
  JSON.stringify({ proposals: FACTS.map((item) => ({ ...item, ...read })) });
const ops = (raw: string, room = false) =>
  readExtractionReply(raw, { ...evidence, room }).proposals.map((proposal) => proposal.op);

describe('a request to remember', () => {
  // Each way the model has read these facts: work shared with others, one
  // task's details, or simply not lasting.
  const readings = [
    { about: 'shared_work', lasting: false },
    { about: 'shared_work', lasting: true },
    { about: 'this_task_only', lasting: false },
    { about: 'this_task_only', lasting: true },
    { about: 'the_person', lasting: false },
  ];

  test('keeps every fact asked for in a personal chat, however the model read it', () => {
    for (const read of readings)
      expect(ops(answer({ ...read, asked_to_remember: true }))).toEqual([
        'add',
        'add',
        'add',
        'add',
      ]);
  });

  test('keeps them in a room too', () => {
    for (const read of readings)
      expect(ops(answer({ ...read, asked_to_remember: true }), true)).toEqual([
        'add',
        'add',
        'add',
        'add',
      ]);
  });

  test('the same details, not asked for, are still one task’s and are not kept', () => {
    for (const asked of [false, null, undefined])
      for (const read of readings)
        expect(ops(answer({ ...read, asked_to_remember: asked }))).toEqual([
          'no-op',
          'no-op',
          'no-op',
          'no-op',
        ]);
  });
});

describe('what the extraction model is told about a request to remember', () => {
  const batch = (speaker?: string) =>
    ({
      work: {
        id: 'mw_1',
        source_id: evidence.source_id,
        policy_version: 'p1',
        segment_start: 0,
        segment_end: said.length,
        status: 'leased',
        fence: 1,
        lease_until: null,
        continuation: null,
      },
      source: { source_id: evidence.source_id, source_version: '1' },
      text: said,
      claims: [],
      ...(speaker === undefined ? {} : { speaker }),
    }) as unknown as ExtractionBatch;

  test('a structured answer can say it was asked for, in a personal chat and in a room', () => {
    for (const speaker of [undefined, 'Bob <k3mxq7ab>']) {
      const schema = extractionMessages(batch(speaker)).format.schema as {
        properties: { proposals: { items: { properties: Record<string, unknown> } } };
      };
      expect(schema.properties.proposals.items.properties).toHaveProperty('asked_to_remember');
    }
  });

  test('no rule tells the model to drop what it was asked to remember', () => {
    const { system } = extractionMessages(batch());
    expect(system).toContain('"asked_to_remember":true');
    expect(system).toContain('unless the person asks you to remember them');
  });

  test('a reminder to do something is still a request, not a fact to keep', () => {
    const { system } = extractionMessages(batch());
    expect(system).toContain('"remember to call the bank at 5"');
    expect(system).toContain('is a request, not a fact to keep: propose nothing for it');
  });
});
