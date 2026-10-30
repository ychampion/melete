import { expect, test } from 'bun:test';
import corpus from './corpus.json' with { type: 'json' };
import {
  corpusHash,
  emailBytes,
  modelRequest,
  surfaceFeatures,
  validateCorpus,
  visible,
} from './generate.ts';

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

type CorpusCase = (typeof corpus.cases)[number];
const MONTH_DAY =
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}\b/g;
const CODE = /\b[A-Z]{2,}-\d{4,}\b/;
const amounts = (text: string) =>
  [...text.matchAll(/\$(\d[\d,]*(?:\.\d+)?)/g)].map((m) => Number(m[1]!.replaceAll(',', '')));
/** Everything the generator shows the model: envelope fields and the raw body. */
const shown = (c: CorpusCase) =>
  [c.envelope.sender, c.envelope.recipient, c.envelope.subject, c.body].join('\n');

/** Accuracy of the best one-feature rule (either polarity, every threshold). */
function shortcutAudit(cases: readonly CorpusCase[]) {
  const scam = cases.map((c) => c.scorer.label === 'scam');
  const scams = scam.filter(Boolean).length;
  const results: { name: string; accuracy: number }[] = [];
  const score = (name: string, values: number[]) => {
    for (const threshold of new Set(values)) {
      const right = values.filter((v, i) => v >= threshold === scam[i]).length;
      results.push({
        name: `${name} >= ${threshold}`,
        accuracy: Math.max(right, cases.length - right) / cases.length,
      });
    }
  };
  for (const name of Object.keys(surfaceFeatures('')))
    score(
      name,
      cases.map((c) =>
        Number(c.scorer.surfaceFeatures[name as keyof typeof c.scorer.surfaceFeatures]),
      ),
    );
  const lines = cases.map((c) => c.body.split('\n'));
  score(
    'heading line 1 code',
    lines.map((l) => Number(CODE.test(l[0] ?? ''))),
  );
  score(
    'heading line 2 code',
    lines.map((l) => Number(CODE.test(l[1] ?? ''))),
  );
  score(
    'heading code',
    lines.map((l) => Number(CODE.test(`${l[0]}\n${l[1]}`))),
  );
  score(
    'month-day dates',
    cases.map((c) => [...c.body.matchAll(MONTH_DAY)].length),
  );
  score(
    'largest amount',
    cases.map((c) => Math.max(0, ...amounts(c.body))),
  );
  score(
    'smallest amount',
    cases.map((c) => (amounts(c.body).length ? Math.min(...amounts(c.body)) : 0)),
  );
  score(
    'amount count',
    cases.map((c) => amounts(c.body).length),
  );
  // Case-sensitive raw character n-grams (digits and punctuation included) and
  // case-folded one- to three-word phrases.
  const counts = new Map<string, number[]>();
  cases.forEach((c, i) => {
    const text = shown(c);
    const grams = new Set<string>();
    for (let n = 3; n <= 8; n++)
      for (let start = 0; start + n <= text.length; start++)
        grams.add(`chars ${JSON.stringify(text.slice(start, start + n))}`);
    const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (let n = 1; n <= 3; n++)
      for (let start = 0; start + n <= words.length; start++)
        grams.add(`phrase ${JSON.stringify(words.slice(start, start + n).join(' '))}`);
    for (const gram of grams) {
      const count = counts.get(gram) ?? [0, 0];
      count[scam[i] ? 0 : 1]!++;
      counts.set(gram, count);
    }
  });
  for (const [gram, [inScam, inGenuine]] of counts) {
    const right = inScam! + (cases.length - scams - inGenuine!);
    results.push({
      name: gram,
      accuracy: Math.max(right, cases.length - right) / cases.length,
    });
  }
  return results.sort((a, b) => b.accuracy - a.accuracy);
}

test('single surface features cannot classify more than three quarters of cases', () => {
  for (const c of corpus.cases) expect(c.scorer.surfaceFeatures).toEqual(surfaceFeatures(c.body));
  const results = shortcutAudit(corpus.cases);
  expect(results.length).toBeGreaterThan(10_000);
  const worst = results.filter((r) => r.accuracy > 0.75).slice(0, 10);
  expect(worst, 'single-feature shortcuts above 75%').toEqual([]);
});

test('the shortcut audit catches a planted one-sided cue', () => {
  const planted = corpus.cases.map((c) =>
    c.scorer.label === 'scam' ? { ...c, body: `${c.body}\nRef#7` } : c,
  );
  const results = shortcutAudit(planted);
  expect(results[0]!.accuracy).toBe(1);
  expect(results.find((r) => r.name === 'chars "Ref#7"')?.accuracy).toBe(1);
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
