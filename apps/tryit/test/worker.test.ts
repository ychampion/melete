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
    // Any spelling of it: quoted either way, or not quoted at all.
    expect(html).not.toMatch(/\sstyle\s*=/i);
  });

  test('a fresh nonce each time, so one page cannot lend its policy to another', async () => {
    const first = await call(new Request('https://tryit.example/'));
    const second = await call(new Request('https://tryit.example/'));
    expect(first.headers.get('content-security-policy')).not.toBe(
      second.headers.get('content-security-policy'),
    );
  });

  test('the line saying what this is rides on the card, not only the footer', async () => {
    const html = await (await call(new Request('https://tryit.example/'))).text();
    // Once inside the case file it draws, once at the foot of the page. The
    // card is the part that gets screenshotted and sent to someone else.
    expect(html.split('not legal advice').length - 1).toBe(2);
  });

  test('no heading tells a visitor that a company owes them anything', async () => {
    const html = await (await call(new Request('https://tryit.example/'))).text();
    expect(html).not.toContain('Why you are owed it');
  });

  /**
   * A quote is cut from the paste, so it carries whatever line break the paste
   * had. Left alone a browser folds that break into a space, which puts the
   * words "word for word" over text laid out differently from the thing it
   * quotes. Both places a quote is drawn keep the break.
   */
  test('a quote keeps the line breaks the paste gave it', async () => {
    const html = await (await call(new Request('https://tryit.example/'))).text();
    const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
    const declarations = (selector: string): string =>
      new RegExp(`(?:^|\\})\\s*${selector}\\s*\\{([^}]*)\\}`, 'm').exec(style)?.[1] ?? '';
    expect(declarations('blockquote q')).toContain('white-space: pre-wrap');
    expect(declarations('\\.srcq')).toContain('white-space: pre-wrap');
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

describe('where a visitor’s address comes from', () => {
  const forwarded = (address: string): Request =>
    new Request('https://tryit.example/api/case-file', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': address },
      body: JSON.stringify({ text: SAMPLES[0]?.text ?? '' }),
    });

  test('a proxy header alone is refused on a deployed Worker', async () => {
    const response = await call(forwarded('7.7.7.7'));
    expect(response.status).toBe(400);
    if (response.body) await response.text();
  });

  test('and believed when the run says it is local', async () => {
    const response = await call(forwarded('7.7.7.8'), { TRYIT_LOCAL: '1' });
    expect(response.status).toBe(200);
    if (response.body) await response.text();
  });
});
