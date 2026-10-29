import { expect, test } from 'bun:test';
import corpus from './corpus.json' with { type: 'json' };
import { corpusHash, emailBytes, modelRequest, validateCorpus, visible } from './generate.ts';

test('exact fictional stratification and format balance', () => {
  validateCorpus(corpus);
  expect(corpus.cases).toHaveLength(60);
  expect(new Set(corpus.cases.map((c) => c.id)).size).toBe(60);
  for (const label of ['scam', 'genuine']) {
    const cases = corpus.cases.filter((c) => c.scorer.label === label);
    expect(cases).toHaveLength(30);
    expect(cases.filter((c) => c.format === 'image')).toHaveLength(20);
    const groups = new Map(
      [...new Set(cases.map((c) => c.scorer.category))].map((category) => [
        category,
        cases.filter((c) => c.scorer.category === category),
      ]),
    );
    expect(groups.size).toBe(6);
    for (const group of groups.values()) {
      expect(group).toHaveLength(5);
      expect(new Set(group.map((c) => c.format)).size).toBe(2);
    }
  }
});

test('model-visible projection excludes scorer metadata and photo body text', () => {
  for (const c of corpus.cases) {
    expect(Object.keys(visible(c)).sort()).toEqual(['body', 'envelope', 'format', 'id']);
    const request = JSON.stringify(modelRequest(c, 'Room helper <h1>', 'file-1'));
    expect(request).not.toContain(c.body);
    expect(request).not.toContain(c.scorer.rationale);
    expect(request).not.toContain(c.scorer.category);
    expect(c.id).toMatch(/^notice-[a-f0-9]{12}$/);
  }
});

test('RFC822 uses fixed date, neutral subject, unique IDs and exact body', () => {
  const c = corpus.cases.find((c) => c.format === 'email')!;
  const email = emailBytes(c).toString();
  expect(email).toContain('Thu, 29 Oct 2026 09:00:00 +0000');
  expect(email).toContain(`Subject: Notice ${c.id.slice(-6)}`);
  expect(email).toContain(c.body.replaceAll('\n', '\r\n'));
  expect(corpusHash(corpus)).toBe(corpusHash(structuredClone(corpus)));
});
