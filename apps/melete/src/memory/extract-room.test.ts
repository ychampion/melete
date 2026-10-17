/**
 * What a room keeps from what its people say. "I'm taking the vendor contract
 * review, done by Thursday" is one week's work to a personal chat, and was
 * dropped in a room too, so nobody could later ask who had it.
 */
import { describe, expect, test } from 'bun:test';
import {
  EXTRACTION_INSTRUCTIONS,
  extractionMessages,
  ROOM_EXTRACTION_INSTRUCTIONS,
  readExtractionReply,
} from './extract.ts';
import type { ExtractionBatch } from './work.ts';

const said = "I'm taking the vendor contract review, done by Thursday.";
const evidence = {
  source_id: 'src_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  source_version: '1',
  start: 0,
  text: said,
};
/** What a model answers when it reads the message as the room's shared work. */
const claimed = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    proposals: [
      {
        op: 'add',
        claim_id: null,
        expected_revision: null,
        domain_key: 'work.vendor_contract_review',
        content: 'Bob is taking the vendor contract review, due Thursday',
        kind: 'user_statement',
        factual_status: 'attributed',
        valid_from: '2026-10-12T10:00:00Z',
        valid_until: null,
        lasting: false,
        about: 'shared_work',
        sources: [{ quote: "I'm taking the vendor contract review, done by Thursday" }],
        ...extra,
      },
    ],
  });
const ops = (raw: string, room?: boolean) =>
  readExtractionReply(raw, room === undefined ? evidence : { ...evidence, room }).proposals.map(
    (proposal) => proposal.op,
  );

describe('who in a room is doing what', () => {
  test('is kept when it was said in a room, even read as short-lived', () => {
    expect(ops(claimed(), true)).toEqual(['add']);
    expect(ops(claimed({ lasting: true }), true)).toEqual(['add']);
    // A week's word in the content does not drop it either.
    expect(
      ops(claimed({ content: 'Bob is taking the vendor contract review this week' }), true),
    ).toEqual(['add']);
  });

  test('is one task’s detail anywhere else, and is not kept', () => {
    expect(ops(claimed(), false)).toEqual(['no-op']);
    expect(ops(claimed({ lasting: true }))).toEqual(['no-op']);
  });

  test('a room keeps no more than shared work: one task’s detail is still dropped there', () => {
    expect(ops(claimed({ about: 'this_task_only', lasting: true }), true)).toEqual(['no-op']);
  });
});

describe('what the extraction model is told about a room message', () => {
  const batch = (speaker?: string | null) =>
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

  test('who said it, and that "I" is them', () => {
    const { system, content } = extractionMessages(batch('Bob <k3mxq7ab>'));
    expect(system).toBe(`${EXTRACTION_INSTRUCTIONS}\n${ROOM_EXTRACTION_INSTRUCTIONS}`);
    expect(system).toContain('"about":"shared_work"');
    expect(JSON.parse(content).evidence.speaker).toBe('Bob <k3mxq7ab>');
  });

  test('a message said anywhere else is read as before, with no speaker', () => {
    for (const speaker of [undefined, null]) {
      const { system, content } = extractionMessages(batch(speaker));
      expect(system).toBe(EXTRACTION_INSTRUCTIONS);
      expect(JSON.parse(content).evidence).not.toHaveProperty('speaker');
    }
  });

  // A structured answer can only name what its schema offers: a personal chat
  // is never offered shared work, which would only drop a detail there.
  const offered = (speaker: string | null) => {
    const { format } = extractionMessages(batch(speaker));
    const schema = format.schema as {
      properties: {
        proposals: { items: { properties: { about: { anyOf: { enum?: unknown[] }[] } } } };
      };
    };
    const about = schema.properties.proposals.items.properties.about;
    return about.anyOf.flatMap((choice) => choice.enum ?? []);
  };

  test('only a room message is offered shared work as an answer', () => {
    expect(offered('Bob <k3mxq7ab>')).toContain('shared_work');
    expect(offered(null)).not.toContain('shared_work');
    expect(offered(null)).toContain('this_task_only');
  });
});
