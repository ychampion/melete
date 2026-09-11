import { expect, test } from 'bun:test';
import { artifactExpectation } from '@melete/contracts';
import {
  imageDimensions,
  markdownHeadings,
  parseCsv,
  renderCsvTable,
  renderMarkdown,
  validateArtifact,
} from './validate.ts';

const utf8 = (text: string) => new TextEncoder().encode(text);
const named = (results: ReturnType<typeof validateArtifact>, name: string) => {
  const found = results.find((result) => result.name === name);
  if (!found) throw new Error(`no validation named ${name} in ${results.map((r) => r.name)}`);
  return found;
};

test('a ragged CSV row is a parse failure, not a padded row', () => {
  expect(() => parseCsv('a,b\n1,2\n3\n')).toThrow('row 3 has 1 cells');
  const table = parseCsv('name,amount\n"Smith, J.",10.5\n"He said ""hi""",2\n');
  expect(table.header).toEqual(['name', 'amount']);
  expect(table.rows).toEqual([
    ['Smith, J.', '10.5'],
    ['He said "hi"', '2'],
  ]);
});

test('totals that do not add up fail with the two numbers named', () => {
  const expectation = artifactExpectation.parse({
    kind: 'csv',
    checks: [{ kind: 'totals', column: 'amount', total_label: 'Total' }],
  });
  const wrong = validateArtifact(
    expectation,
    utf8('item,amount\nDesk,60.00\nChair,31.50\nTotal,100.00\n'),
  );
  const failed = named(wrong, 'totals:amount');
  expect(failed.status).toBe('failed');
  expect(failed.detail).toContain('91.5');
  expect(failed.detail).toContain('100');

  const fixed = validateArtifact(
    expectation,
    utf8('item,amount\nDesk,60.00\nChair,40.00\nTotal,100.00\n'),
  );
  expect(named(fixed, 'totals:amount').status).toBe('passed');
  expect(named(fixed, 'totals:amount').evidence).toMatchObject({ sum: 100, stated: 100 });
});

test('a totals column with a word in it fails rather than skipping the row', () => {
  const results = validateArtifact(
    artifactExpectation.parse({
      kind: 'csv',
      checks: [{ kind: 'totals', column: 'amount', equals: 10 }],
    }),
    utf8('item,amount\nDesk,tbd\n'),
  );
  expect(named(results, 'totals:amount').status).toBe('failed');
  expect(named(results, 'totals:amount').detail).toContain('not a number');
});

test('a file that does not parse fails every check that needed the contents', () => {
  const results = validateArtifact(
    artifactExpectation.parse({
      kind: 'json',
      checks: [{ kind: 'schema', schema: { type: 'object' } }],
    }),
    utf8('{ not json'),
  );
  expect(named(results, 'json.parses').status).toBe('failed');
  expect(named(results, 'schema').status).toBe('failed');
  expect(named(results, 'schema').detail).toContain('did not parse');
});

test('required sections are matched against real headings, not any old text', () => {
  expect(markdownHeadings('# One\ntext\n```\n## Not a heading\n```\n## Two\n')).toEqual([
    'One',
    'Two',
  ]);
  const expectation = artifactExpectation.parse({
    kind: 'markdown',
    checks: [{ kind: 'required_sections', sections: ['Findings', 'Next steps'] }],
  });
  const missing = validateArtifact(expectation, utf8('# Findings\nall good\n'));
  expect(named(missing, 'required_sections').status).toBe('failed');
  expect(named(missing, 'required_sections').detail).toContain('Next steps');
  const complete = validateArtifact(
    expectation,
    utf8('# Findings\nall good\n\n## Next steps\nnone\n'),
  );
  expect(named(complete, 'required_sections').status).toBe('passed');
});

test('markdown renders, and an unterminated fence is caught by rendering it', () => {
  expect(renderMarkdown('# Title\n\n- one\n- two\n')).toContain('<li>one</li>');
  const broken = validateArtifact(
    artifactExpectation.parse({ kind: 'markdown' }),
    utf8('```\nx\n'),
  );
  expect(named(broken, 'render:markdown').status).toBe('failed');
  expect(named(broken, 'render:markdown').detail).toContain('never closed');
});

test('a CSV renders as the table a reader would see', () => {
  const html = renderCsvTable(parseCsv('a,b\n1,2\n'));
  expect(html).toContain('<th>a</th>');
  expect(html).toContain('<td>2</td>');
  const results = validateArtifact(artifactExpectation.parse({ kind: 'csv' }), utf8('a,b\n1,2\n'));
  expect(named(results, 'render:csv').status).toBe('passed');
});

test('image dimensions come from the header, and a mismatch fails', () => {
  // A 2x1 PNG: signature, then an IHDR whose width and height are read here.
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  new DataView(png.buffer).setUint32(16, 2);
  new DataView(png.buffer).setUint32(20, 1);
  expect(imageDimensions(png)).toEqual({ format: 'png', width: 2, height: 1 });
  const results = validateArtifact(
    artifactExpectation.parse({
      kind: 'image',
      checks: [{ kind: 'image_dimensions', min_width: 800 }],
    }),
    png,
  );
  expect(named(results, 'image_dimensions').status).toBe('failed');
  expect(named(results, 'image_dimensions').detail).toContain('under 800');
});

test('a kind with no renderer records unavailable rather than a pass', () => {
  const results = validateArtifact(artifactExpectation.parse({ kind: 'xlsx' }), utf8('PK'));
  expect(named(results, 'render:xlsx').status).toBe('unavailable');
  expect(named(results, 'render:xlsx').advisory).toBe(false);
});

test('a declared critique and a declared acceptance start out pending', () => {
  const results = validateArtifact(
    artifactExpectation.parse({ kind: 'markdown', critique: 'is this readable?', human: true }),
    utf8('# Title\n\nbody\n'),
  );
  expect(named(results, 'critique')).toMatchObject({ status: 'pending', advisory: true });
  expect(named(results, 'human')).toMatchObject({ status: 'pending', advisory: false });
});
