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
import type { CaseFileProvider } from '../src/provider.ts';
import { ProviderError } from '../src/provider.ts';
import { SAMPLES } from '../src/samples.ts';
import type { Script } from '../src/scripted.ts';
import { scriptedProvider } from '../src/scripted.ts';

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

    // Every quote shown is really in what was pasted. Asserted against the
    // paste itself, not against the fold the gate computes: comparing with
    // the gate's own working restates it and cannot catch it being wrong.
    for (const entry of file.evidence) expect(REFUND).toContain(entry.quote);
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

  /**
   * The declared length is the cheap check, and it is the one an attacker
   * simply omits: a streamed body sends no `content-length` at all, and a
   * garbage one parses to `NaN`. Either way the guard was skipped and the
   * whole body was read and parsed before the character cap saw it. The cap
   * has to hold on what actually arrives.
   */
  /** A body that reports how much of itself was actually asked for. */
  const streamed = (text: string, headers: Record<string, string> = {}) => {
    const body = new TextEncoder().encode(JSON.stringify({ text }));
    const size = 64 * 1024;
    const sent = { bytes: 0 };
    let at = 0;
    const request = new Request('https://tryit.example/api/case-file', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (at >= body.byteLength) {
            controller.close();
            return;
          }
          const chunk = body.slice(at, at + size);
          at += chunk.byteLength;
          sent.bytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
      duplex: 'half',
    });
    return { request, sent, total: body.byteLength };
  };

  test('a huge body with no declared length is dropped part-way, not read whole', async () => {
    const { request, sent, total } = streamed('A'.repeat(5_000_000));
    expect(request.headers.get('content-length')).toBeNull();
    const response = await caseFileRoute(request, deps());
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ ok: false, code: 'too_long' });
    // Stopped once it was clearly over, rather than reading five megabytes.
    expect(sent.bytes).toBeLessThan(total / 10);
  });

  test('a lie about the length does not buy a full read either', async () => {
    const { request, sent, total } = streamed('A'.repeat(5_000_000), {
      'content-length': 'not-a-number',
    });
    expect((await caseFileRoute(request, deps())).status).toBe(413);
    expect(sent.bytes).toBeLessThan(total / 10);
  });

  test('a body inside the cap still arrives, streamed or not', async () => {
    const { request } = streamed(REFUND);
    const { done } = await readStream(await caseFileRoute(request, deps()));
    expect(done?.ok).toBe(true);
  });

  test('a few words is not a case', async () => {
    const response = await caseFileRoute(post('they owe me'), deps());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: 'empty_input' });
  });

  /**
   * `text/plain` is one of the three content types a browser will send
   * cross-origin without asking permission first. Accepting it let any website
   * spend a visitor's five, and a slot of the day's budget, from inside their
   * browser with no preflight and nothing on screen. Insisting on JSON forces
   * a preflight, and this Worker answers none.
   */
  test('only json is accepted, so no other site can spend a visitor’s turns', async () => {
    const use = deps();
    for (const type of ['text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', '']) {
      const request = new Request('https://tryit.example/api/case-file', {
        method: 'POST',
        headers: type ? { 'content-type': type } : {},
        body: JSON.stringify({ text: REFUND }),
      });
      const response = await caseFileRoute(request, use);
      expect(response.status).toBe(415);
      if (response.body) await response.text();
    }
    // ...and no turn was spent finding that out.
    expect(await use.limiter.take('1.2.3.4')).toMatchObject({ allowed: true });
  });

  test('a charset or spacing on the json type is still json', async () => {
    const request = new Request('https://tryit.example/api/case-file', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text: REFUND }),
    });
    const { done } = await readStream(await caseFileRoute(request, deps()));
    expect(done?.ok).toBe(true);
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

  test('a model that never answers is given up on', async () => {
    const use = deps({ delayMs: 5_000 });
    const { done } = await readStream(await caseFileRoute(post(REFUND), use));
    expect(done).toMatchObject({ ok: false, code: 'timeout' });
    expect(use.lines[0]?.outcome).toBe('timeout');
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

/**
 * A cap that hands the turn back after the model has been paid for is not a
 * cap: anyone who can make the model refuse, overrun or run slow gets as many
 * calls as they like. So the question each test asks is not "was there an
 * error" but "how many times could the model be called", and the counter is
 * spent down to the cap first — a test with room left over passes whether or
 * not the rule holds, which is how this went unnoticed.
 */
describe('what a failure costs', () => {
  /** Count the calls that would really have been billed, and fail after them. */
  const billing = (error: ProviderError) => {
    const calls = { made: 0 };
    const provider: CaseFileProvider = {
      name: 'billing',
      async run() {
        calls.made += 1; // the tokens are spent here
        throw error; // ...and the failure happens after
      },
    };
    return { calls, provider };
  };

  const attempts = async (error: ProviderError, tries: number) => {
    const { calls, provider } = billing(error);
    const use = deps({}, { provider });
    for (let turn = 0; turn < tries; turn += 1) {
      const response = await caseFileRoute(post(REFUND, '1.1.1.1'), use);
      if (response.body) await response.text();
    }
    return calls.made;
  };

  test('a refusal costs a turn: the paid-for call is counted', async () => {
    // Twenty tries against a cap of two may buy two calls, and no more.
    expect(await attempts(new ProviderError('refused', 'no', true), 20)).toBe(LIMITS.perIpPerDay);
  });

  test('so does a reply that stopped early', async () => {
    expect(await attempts(new ProviderError('malformed', 'stopped early', true), 20)).toBe(
      LIMITS.perIpPerDay,
    );
  });

  test('so does a reply that answered, but in the wrong shape', async () => {
    // This one returns rather than throws, so it is the handler's own
    // `malformed` branch that must not hand the turn back.
    let calls = 0;
    const nonsense: CaseFileProvider = {
      name: 'nonsense',
      async run() {
        calls += 1;
        return { json: { not: 'a case file' }, sources: [], searches: 0 };
      },
    };
    const use = deps({}, { provider: nonsense });
    for (let turn = 0; turn < 20; turn += 1) {
      const response = await caseFileRoute(post(REFUND, '2.2.2.2'), use);
      if (response.body) await response.text();
    }
    expect(calls).toBe(LIMITS.perIpPerDay);
  });

  test('so does a request given up on after it was sent', async () => {
    expect(await attempts(new ProviderError('timeout', 'too slow', true), 20)).toBe(
      LIMITS.perIpPerDay,
    );
  });

  test('a failure that never reached the model is handed back', async () => {
    // Nothing was sent, so nothing was paid for, and the turn is still theirs.
    expect(await attempts(new ProviderError('upstream', 'could not connect', false), 20)).toBe(20);
  });

  test('the whole page runs out too, however the attempts fail', async () => {
    const { calls, provider } = billing(new ProviderError('refused', 'no', true));
    const use = deps({}, { provider });
    for (let turn = 0; turn < 20; turn += 1) {
      const response = await caseFileRoute(post(REFUND, `9.9.9.${turn}`), use);
      if (response.body) await response.text();
    }
    expect(calls.made).toBe(LIMITS.globalPerDay);
  });

  test('a case file that arrives is never handed back', async () => {
    const handed: string[] = [];
    const use = deps(
      {},
      {
        limiter: {
          take: async () => ({ allowed: true, remaining: 4 }),
          giveBack: async (ip) => {
            handed.push(ip);
          },
        },
      },
    );
    await readStream(await caseFileRoute(post(REFUND), use));
    expect(handed).toEqual([]);
  });
});

/**
 * The counter has to tell one visitor from another for a day. It does not have
 * to know who they are, and the page promises it keeps nothing but the day's
 * counters — which was not quite true while up to four hundred raw addresses
 * sat in the object until the next day overwrote them.
 */
describe('what the counter is told about a visitor', () => {
  const watching = () => {
    const keys: string[] = [];
    const limiter = {
      take: async (key: string) => {
        keys.push(key);
        return { allowed: true as const, remaining: 4 };
      },
      giveBack: async (key: string) => {
        keys.push(key);
      },
    };
    return { keys, limiter };
  };

  const keyFor = async (ip: string, at: string) => {
    const { keys, limiter } = watching();
    const request = new Request('https://tryit.example/api/case-file', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({ text: REFUND }),
    });
    await readStream(
      await caseFileRoute(request, deps({}, { limiter, now: () => Date.parse(at) })),
    );
    return keys[0] ?? '';
  };

  test('the address itself is never handed over', async () => {
    const key = await keyFor('203.0.113.7', '2026-09-19T10:00:00Z');
    expect(key).not.toContain('203.0.113.7');
    expect(key).not.toContain('203');
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  test('the same visitor on the same day is the same one', async () => {
    const first = await keyFor('203.0.113.7', '2026-09-19T10:00:00Z');
    const later = await keyFor('203.0.113.7', '2026-09-19T23:00:00Z');
    expect(later).toBe(first);
  });

  test('two visitors are two', async () => {
    const one = await keyFor('203.0.113.7', '2026-09-19T10:00:00Z');
    const other = await keyFor('203.0.113.8', '2026-09-19T10:00:00Z');
    expect(other).not.toBe(one);
  });

  test('tomorrow they are someone else again', async () => {
    const today = await keyFor('203.0.113.7', '2026-09-19T10:00:00Z');
    const tomorrow = await keyFor('203.0.113.7', '2026-09-20T10:00:00Z');
    expect(tomorrow).not.toBe(today);
  });

  // One IPv6 connection is handed a /64 at the least, so every address in it
  // belongs to the same person, who could otherwise take a fresh allowance
  // from each of them.
  test('every address in one IPv6 /64 is the same visitor', async () => {
    const at = '2026-09-19T10:00:00Z';
    const one = await keyFor('2001:db8:1:2::1', at);
    expect(await keyFor('2001:db8:1:2:ffff:ffff:ffff:fffe', at)).toBe(one);
    expect(await keyFor('2001:0DB8:0001:0002:0:0:0:9', at)).toBe(one);
    expect(await keyFor('[2001:db8:1:2::7]', at)).toBe(one);
    expect(await keyFor('fe80::1%eth0', at)).toBe(await keyFor('fe80::2', at));
  });

  test('the next /64 along is someone else', async () => {
    const at = '2026-09-19T10:00:00Z';
    expect(await keyFor('2001:db8:1:3::1', at)).not.toBe(await keyFor('2001:db8:1:2::1', at));
    expect(await keyFor('2001:db8::1', at)).not.toBe(await keyFor('2001:db8:1::1', at));
  });

  test('an IPv4 address written as IPv6 is that IPv4 address', async () => {
    const at = '2026-09-19T10:00:00Z';
    const plain = await keyFor('203.0.113.7', at);
    expect(await keyFor('::ffff:203.0.113.7', at)).toBe(plain);
    expect(await keyFor('::FFFF:cb00:7107', at)).toBe(plain);
    expect(await keyFor('0:0:0:0:0:ffff:203.0.113.7', at)).toBe(plain);
    expect(await keyFor('::ffff:203.0.113.8', at)).not.toBe(plain);
  });

  test('a /64 gets one allowance, however many addresses it rotates through', async () => {
    const use = deps();
    const statuses: number[] = [];
    for (let host = 1; host <= LIMITS.perIpPerDay + 3; host += 1) {
      const response = await caseFileRoute(post(REFUND, `2001:db8:1:2::${host.toString(16)}`), use);
      if (response.status === 200) await readStream(response);
      statuses.push(response.status);
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(LIMITS.perIpPerDay);
    expect(statuses.slice(LIMITS.perIpPerDay).every((status) => status === 429)).toBe(true);
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
      // Against the paste, not against the gate's own fold of it.
      for (const entry of done.caseFile.evidence) expect(sample.text).toContain(entry.quote);
    }
  });
});
