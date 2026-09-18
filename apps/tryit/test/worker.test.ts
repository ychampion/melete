/**
 * The Worker's own wiring: the routes, the headers the page is served with,
 * and the two decisions `index.ts` makes for itself — which provider runs, and
 * whether the counter it has is one it is allowed to trust.
 */
import { describe, expect, test } from 'bun:test';
import worker from '../src/index.ts';
import { SAMPLES } from '../src/samples.ts';

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const call = (request: Request, env: Record<string, unknown> = {}): Promise<Response> =>
  worker.fetch(request, env as never, ctx);

const ask = (ip: string): Request =>
  new Request('https://tryit.example/api/case-file', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ text: SAMPLES[0]?.text ?? '' }),
  });

describe('the page', () => {
  test('is served with a policy that allows only its own two blocks', async () => {
    const response = await call(new Request('https://tryit.example/'));
    expect(response.status).toBe(200);
    const policy = response.headers.get('content-security-policy') ?? '';
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("'unsafe-inline'");
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-frame-options')).toBe('DENY');

    const html = await response.text();
    const nonce = /nonce-([a-f0-9]+)/.exec(policy)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`nonce="${nonce}"`);
    // Every rule is in the one stylesheet, so the policy can forbid the rest.
    expect(html).not.toContain(' style="');
  });

  test('a fresh nonce each time, so one page cannot lend its policy to another', async () => {
    const first = await call(new Request('https://tryit.example/'));
    const second = await call(new Request('https://tryit.example/'));
    expect(first.headers.get('content-security-policy')).not.toBe(
      second.headers.get('content-security-policy'),
    );
  });

  test('carries the headline, the three samples and the two links', async () => {
    const html = await (await call(new Request('https://tryit.example/'))).text();
    expect(html).toContain('Deals with every company in your life');
    for (const sample of SAMPLES) expect(html).toContain(sample.label);
    expect(html).toContain('https://github.com/ychampion/melete');
    expect(html).toContain('https://melete.axcelner.com');
  });

  test('the landing address is one configuration value', async () => {
    const html = await (
      await call(new Request('https://tryit.example/'), {
        LANDING_URL: 'https://elsewhere.example',
      })
    ).text();
    expect(html).toContain('https://elsewhere.example');
    expect(html).not.toContain('https://melete.axcelner.com');
  });

  test('nothing else is served from here', async () => {
    expect((await call(new Request('https://tryit.example/admin'))).status).toBe(404);
    expect((await call(new Request('https://tryit.example/', { method: 'PUT' }))).status).toBe(405);
  });

  test('says which provider and which counter it is running', async () => {
    const plain = await (await call(new Request('https://tryit.example/healthz'))).json();
    expect(plain).toMatchObject({ provider: 'scripted', limiter: 'isolate' });
  });
});

describe('the day’s turns', () => {
  test('the fallback counter survives between requests', async () => {
    const seen: number[] = [];
    for (let turn = 0; turn < 7; turn += 1) {
      const response = await call(ask('4.4.4.4'));
      seen.push(response.status);
      if (response.body) await response.text();
    }
    // Five case files, then the same answer for the rest of the day.
    expect(seen.filter((status) => status === 200).length).toBe(5);
    expect(seen.filter((status) => status === 429).length).toBe(2);
  });
});

describe('a real key', () => {
  test('will not run behind a counter that only counts one isolate', async () => {
    const response = await call(ask('6.6.6.6'), { OPENAI_API_KEY: 'sk-not-a-real-key' });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, code: 'busy' });
  });
});
