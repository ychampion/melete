import { describe, expect, test } from 'bun:test';
import { PROCEDURE_CHECK_KINDS } from '@melete/contracts';
import { admitProposal, type ProposalSource } from './admit.ts';
import {
  GENERAL_PROPOSAL_FORMAT,
  generalProposalFormat,
  unfenced,
  withoutUnusedCheckFields,
} from './proposal-gateway.ts';

const body = '{"target":"skill_body"}';

describe('the proposal answer fence', () => {
  test('exactly one json or bare fence around the answer is removed', () => {
    expect(JSON.parse(unfenced(`\`\`\`json\n${body}\n\`\`\``))).toEqual({ target: 'skill_body' });
    expect(JSON.parse(unfenced(`\`\`\`\n${body}\n\`\`\``))).toEqual({ target: 'skill_body' });
    expect(JSON.parse(unfenced(`  \`\`\`json\r\n${body}\r\n\`\`\`  \n`))).toEqual({
      target: 'skill_body',
    });
    expect(unfenced(body)).toBe(body);
  });

  test('anything more lenient than one fence is left for the parser to refuse', () => {
    for (const text of [
      `Here you go:\n\`\`\`json\n${body}\n\`\`\``,
      `\`\`\`json\n${body}\n\`\`\`\nHope that helps.`,
      `\`\`\`json\n\`\`\`json\n${body}\n\`\`\`\n\`\`\``,
      `\`\`\`javascript\n${body}\n\`\`\``,
      `\`\`\`json ${body} \`\`\``,
      `~~~json\n${body}\n~~~`,
    ])
      expect(() => JSON.parse(unfenced(text))).toThrow();
  });
});

describe('a structured proposal, as a schema-held model returns it', () => {
  const objective = 'Summarise the weekly project status report';
  const intervention =
    'Far too long. Keep summaries to five bullet points at most, and put the risks first.';
  const sources: ProposalSource[] = [
    { id: 'intervention', offset: 0, text: intervention },
    { id: 'objective', offset: 0, text: objective },
  ];
  const unusedCheck = {
    min: null,
    max: null,
    phrase: null,
    form: null,
    headings: null,
    ordered: null,
    key: null,
    type: null,
    direction: null,
    preserve_rows: null,
    action_kind: null,
  };
  // Recorded shape of a strict json_schema answer to GENERAL_PROPOSAL_FORMAT:
  // quotes only, no offsets, and every check field its kind does not use null.
  const recorded = {
    target: 'skill_body',
    steps: [
      {
        text: 'Write the summary as five bullet points at most.',
        evidence: { source: 'intervention', quote: 'Keep summaries to five bullet points at most' },
      },
      {
        text: 'Put the risks first.',
        evidence: { source: 'intervention', quote: 'put the risks first' },
      },
    ],
    triggers: [
      { phrase: 'status report', evidence: { source: 'objective', quote: 'status report' } },
    ],
    checks: [
      { ...unusedCheck, kind: 'output_format', form: 'bullets' },
      { ...unusedCheck, kind: 'line_count', min: 1, max: 5 },
    ],
    variant_objectives: [],
  };

  test('is admitted with offsets the service found and checks without their unused fields', () => {
    const admitted = admitProposal(withoutUnusedCheckFields(recorded), { sources, objective });
    expect(admitted.checks).toEqual([
      { kind: 'output_format', form: 'bullets' },
      { kind: 'line_count', min: 1, max: 5 },
    ]);
    for (const span of admitted.evidence) {
      const text = span.source === 'intervention' ? intervention : objective;
      expect(text.slice(span.start, span.end)).toBe(span.quote);
    }
    expect(admitted.evidence[0]).toMatchObject({ start: 14, end: 58 });
  });

  test('the schema names every check kind and no offsets', () => {
    const schema = JSON.stringify(GENERAL_PROPOSAL_FORMAT.schema);
    expect(schema).not.toContain('"start"');
    expect(schema).not.toContain('"end"');
    const kinds = (
      GENERAL_PROPOSAL_FORMAT.schema as {
        properties: { checks: { items: { properties: { kind: { enum: string[] } } } } };
      }
    ).properties.checks.items.properties.kind.enum;
    expect(kinds).toEqual([...PROCEDURE_CHECK_KINDS]);
  });
});

describe('a structured proposal full of filler', () => {
  const objective = 'Summarise the weekly project status report';
  const intervention =
    'Far too long. Keep summaries to five bullet points at most, and put the risks first.';
  const sources: ProposalSource[] = [
    { id: 'intervention', offset: 0, text: intervention },
    { id: 'objective', offset: 0, text: objective },
  ];
  // Recorded shape: strict mode makes the model write every check field, and it
  // fills the unused ones with "", 0, [] and false instead of null.
  const filler = {
    min: 0,
    max: 0,
    phrase: '',
    form: null,
    headings: [],
    ordered: false,
    key: '',
    type: null,
    direction: null,
    preserve_rows: false,
    action_kind: '',
  };
  const reply = {
    target: 'skill_body',
    steps: [
      {
        text: 'Write the summary as five bullet points at most.',
        evidence: { source: 'intervention', quote: 'Keep summaries to five bullet points at most' },
      },
    ],
    triggers: [
      { phrase: 'status report', evidence: { source: 'objective', quote: 'status report' } },
    ],
    checks: [
      { ...filler, kind: 'output_format', form: 'bullets' },
      { ...filler, kind: 'line_count', max: 5 },
      {
        ...filler,
        kind: 'records_sorted',
        key: 'date',
        type: 'date',
        direction: 'ascending',
        preserve_rows: false,
      },
    ],
    variant_objectives: [],
  };

  test('is admitted: each check keeps only its kind’s own fields', () => {
    const admitted = admitProposal(withoutUnusedCheckFields(reply), { sources, objective });
    expect(admitted.checks[0]).toEqual({ kind: 'output_format', form: 'bullets' });
    expect(admitted.checks[1]).toMatchObject({ kind: 'line_count', max: 5 });
    // A choice the kind uses is kept even when it looks like filler.
    expect(admitted.checks[2]).toMatchObject({ kind: 'records_sorted', preserve_rows: false });
  });

  test('without the projection, the same reply is refused, as it was before', () => {
    expect(() => admitProposal(reply, { sources, objective })).toThrow();
  });

  test('the schema offers only the sources that were sent', () => {
    const only = JSON.stringify(generalProposalFormat(['intervention']).schema);
    expect(only).toContain('"enum":["intervention"]');
    expect(only).not.toContain('"objective"');
  });
});
