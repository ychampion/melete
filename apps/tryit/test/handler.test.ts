/**
 * The whole route, end to end, against the scripted provider: the happy path
 * and every way it can end badly. What is being checked is that the gates are
 * still in force once the pieces are wired together, and that each ending
 * comes back with its own status and words rather than a stack trace.
 */
import { describe, expect, test } from 'bun:test';
import type { Deps, LogLine } from '../src/handler.ts';
import { caseFileRoute, clientIp, readStream } from '../src/handler.ts';
import { memoryLimiter } from '../src/limiter.ts';
import type { Limits } from '../src/limits.ts';
import { DEFAULT_LIMITS } from '../src/limits.ts';
import { ProviderError } from '../src/provider.ts';
import { SAMPLES } from '../src/samples.ts';
import type { Script } from '../src/scripted.ts';
import { scriptedProvider } from '../src/scripted.ts';
import { canonical } from '../src/text.ts';

const REFUND = SAMPLES[0]?.text ?? '';

const LIMITS: Limits = { ...DEFAULT_LIMITS, perIpPerDay: 2, globalPerDay: 3, requestTimeoutMs: 50 };

function deps(script: Script = {}, over: Partial<Deps> = {}): Deps & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  return {
    provider: scriptedProvider(script),
    limiter: memoryLimiter(LIMITS),
    limits: LIMITS,
    log: (line) => lines.push(line),
    lines,
    ...over,
  };
}

const post = (text: unknown, ip = '1.2.3.4'): Request =>
  new Request('https://tryit.example/api/case-file', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ text }),
  });

describe('the happy path', () => {
  test('streams its stages and ends with a case file built from the paste', async () => {
    const use = deps();
    const response = await caseFileRoute(post(REFUND), use);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('ndjson');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const { stages, done } = await readStream(response);
    expect(stages.map((stage) => stage.stage)).toEqual(['reading', 'model', 'checking']);
    if (!done?.ok) throw new Error('expected a case file');

    const file = done.caseFile;
    expect(file.company).toBe('Northwind Electricals');
    expect(file.entitlement.amountMinor).toBe(24999);
    expect(file.entitlement.currency).toBe('GBP');
    expect(file.evidence.length).toBeGreaterThan(0);
    expect(file.noEvidenceNote).toBeNull();
    expect(file.ladder.length).toBeGreaterThanOrEqual(3);
    expect(file.message.body).toContain('Northwind Electricals');

    // Every quote shown is really in what was pasted.
    for (const entry of file.evidence) expect(canonical(REFUND)).toContain(entry.quote);
  });

  test('records sizes, timings and an outcome, and never the text', async () => {
    const use = deps();
    await readStream(await caseFileRoute(post(REFUND), use));
    expect(use.lines).toHaveLength(1);
    const line = use.lines[0];
    expect(line).toMatchObject({ event: 'case_file', outcome: 'ok', chars: REFUND.trim().length });
    const written = JSON.stringify(line ?? {});
    expect(written).not.toContain('Northwind');
    expect(written).not.toContain('249.99');
  });
});

describe('what the model claims is checked, not taken', () => {
  test('a quote the paste does not contain never reaches the page', async () => {
    const invented = 'We have already sent the money to your bank, on 1 September.';
    const use = deps({
      mutate: (draft) => ({
        ...draft,
        evidence: [...draft.evidence.slice(0, 1), { quote: invented, why: 'Says they paid.' }],
      }),
    });
    const { done } = await readStream(await caseFileRoute(post(REFUND), use));
    if (!done?.ok) throw new Error('expected a case file');
    expect(done.caseFile.evidence.map((entry) => entry.quote)).not.toContain(invented);
    expect(done.meta.quotesDropped).toBe(1);
    expect(use.lines[0]?.quotesDropped).toBe(1);
  });

  test('with every quote invented, the page is told plainly and the odds drop', async () => {
    const use = deps({
      mutate: (draft) => ({
        ...draft,
        odds: { ...draft.odds, level: 'high' },
        entitlement: { ...draft.entitlement, basis: [] },
        evidence: [{ quote: 'We paid you in full on 1 September 2026.', why: 'Invented.' }],
      }),
    });
    const { done } = await readStream(await caseFileRoute(post(REFUND), use));
    if (!done?.ok) throw new Error('expected a case file');
    expect(done.caseFile.evidence).toHaveLength(0);
    expect(done.caseFile.noEvidenceNote).toContain('no sentence to quote');
    expect(done.caseFile.odds.level).toBe('medium');
  });

  test('a link the search never returned never reaches the page', async () => {
    const use = deps({
      sources: [{ url: 'https://northwind-electricals.example/help/returns', title: 'Returns' }],
      mutate: (draft) => ({
        ...draft,
        entitlement: {
          ...draft.entitlement,
          basis: [
            {
              claim: 'Their published policy covers this.',
              source_kind: 'url',
              url: 'https://northwind-electricals.example/help/returns',
              title: 'Returns',
              quote: null,
            },
            {
              claim: 'The regulator says so.',
              source_kind: 'url',
              url: 'https://www.invented-regulator.example/rules/refunds',
              title: 'Refund rules',
              quote: null,
            },
          ],
        },
      }),
    });
    const { done, stages } = await readStream(await caseFileRoute(post(REFUND), use));
    if (!done?.ok) throw new Error('expected a case file');
    const links = done.caseFile.entitlement.basis.map((entry) =>
      entry.source.kind === 'url' ? entry.source.url : null,
    );
    expect(links).toEqual(['https://northwind-electricals.example/help/returns']);
    expect(done.meta.urlsDropped).toBe(1);
    expect(stages.some((stage) => stage.stage === 'checking' && stage.searches === 1)).toBe(true);
  });

  test('a reply in the wrong shape is refused rather than half-rendered', async () => {
    const use = deps({ mutate: () => ({ company: 'Northwind', nothing: 'else' }) });
    const { done } = await readStream(await caseFileRoute(post(REFUND), use));
    expect(done).toMatchObject({ ok: false, code: 'malformed' });
    expect(use.lines[0]?.outcome).toBe('malformed');
  });
});

describe('the ways it ends badly', () => {
  test('too much text is refused before any of it is read', async () => {
    const use = deps();
    const response = await caseFileRoute(post('x'.repeat(LIMITS.maxInputChars + 1)), use);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ ok: false, code: 'too_long' });
    expect(use.lines[0]?.outcome).toBe('too_long');
  });

  test('a body far past the cap is refused on its declared size alone', async () => {
    const use = deps();
    const request = new Request('https://tryit.example/api/case-file', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '5000000' },
      body: JSON.stringify({ text: REFUND }),
    });
    expect((await caseFileRoute(request, use)).status).toBe(413);
  });

  test('a few words is not a case', async () => {
    const response = await caseFileRoute(post('they owe me'), deps());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: 'empty_input' });
  });

  test('a body that is not json, and the wrong method', async () => {
    const use = deps();
    const broken = new Request('https://tryit.example/api/case-file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect((await caseFileRoute(broken, use)).status).toBe(400);
    const wrong = new Request('https://tryit.example/api/case-file', { method: 'GET' });
    expect((await caseFileRoute(wrong, use)).status).toBe(405);
  });

  test('the day’s turns run out for one address, and then for the page', async () => {
    const use = deps();
    for (let turn = 0; turn < LIMITS.perIpPerDay; turn += 1)
      await readStream(await caseFileRoute(post(REFUND, '9.9.9.9'), use));

    const mine = await caseFileRoute(post(REFUND, '9.9.9.9'), use);
    expect(mine.status).toBe(429);
    expect(await mine.json()).toMatchObject({ ok: false, code: 'rate_limited' });

    await readStream(await caseFileRoute(post(REFUND, '8.8.8.8'), use));
    const everyone = await caseFileRoute(post(REFUND, '7.7.7.7'), use);
    expect(everyone.status).toBe(503);
    expect(await everyone.json()).toMatchObject({ ok: false, code: 'busy' });
  });

  test('a model that never answers is given up on, and the turn is handed back', async () => {
    const use = deps({ delayMs: 5_000 });
    const { done } = await readStream(await caseFileRoute(post(REFUND), use));
    expect(done).toMatchObject({ ok: false, code: 'timeout' });
    expect(use.lines[0]?.outcome).toBe('timeout');
    // The attempt produced nothing, so it did not cost one of the day's turns.
    expect(await use.limiter.take('1.2.3.4')).toMatchObject({ allowed: true });
  });

  test('an upstream failure is reported as one', async () => {
    const use = deps({ fail: new ProviderError('upstream', 'responses api returned 500') });
    const { done } = await readStream(await caseFileRoute(post(REFUND), use));
    expect(done).toMatchObject({ ok: false, code: 'upstream' });
    expect(JSON.stringify(done)).not.toContain('500');
  });

  test('a refusal is reported as a refusal', async () => {
    const use = deps({ fail: new ProviderError('refused', 'I cannot help with that') });
    const { done } = await readStream(await caseFileRoute(post(REFUND), use));
    expect(done).toMatchObject({ ok: false, code: 'refused' });
  });
});

describe('the caller’s address', () => {
  test('comes from Cloudflare first, then a proxy header, then nothing', () => {
    const at = (headers: Record<string, string>) =>
      clientIp(new Request('https://tryit.example/', { headers }));
    expect(at({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' })).toBe('1.1.1.1');
    expect(at({ 'x-forwarded-for': '2.2.2.2, 3.3.3.3' })).toBe('2.2.2.2');
    expect(at({})).toBe('unknown');
  });
});

describe('the three samples', () => {
  test('each one produces a case file with real quotes in it', async () => {
    for (const sample of SAMPLES) {
      const { done } = await readStream(await caseFileRoute(post(sample.text, sample.id), deps()));
      if (!done?.ok) throw new Error(`${sample.id} did not produce a case file`);
      expect(done.caseFile.evidence.length).toBeGreaterThan(0);
      const folded = canonical(sample.text);
      for (const entry of done.caseFile.evidence) expect(folded).toContain(entry.quote);
    }
  });
});
