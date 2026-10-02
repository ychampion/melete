import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { isIsolated, isolated, sealView, VIEW_POLICY, viewHeaders } from './headers.ts';

describe('the isolation headers', () => {
  test('give every framed page an opaque origin and keep it inside its own files', () => {
    const headers = viewHeaders('text/html; charset=utf-8');
    const policy = headers.get('content-security-policy') ?? '';
    expect(policy.startsWith('sandbox allow-scripts allow-forms allow-downloads;')).toBe(true);
    expect(policy).not.toContain('allow-same-origin');
    expect(policy).not.toContain('allow-popups');
    expect(policy).not.toContain('allow-top-navigation');
    for (const directive of [
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-src 'none'",
      "frame-ancestors 'self'",
    ])
      expect(policy).toContain(directive);
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(headers.get('cache-control')).toBe('private, no-store');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(headers.has('set-cookie')).toBe(false);
  });

  test('let only scripts be read across origins, as a sandboxed module script needs', () => {
    expect(viewHeaders('text/javascript; charset=utf-8').get('access-control-allow-origin')).toBe(
      '*',
    );
    for (const type of ['text/html; charset=utf-8', 'application/json', 'image/svg+xml'])
      expect(viewHeaders(type).has('access-control-allow-origin')).toBe(false);
  });

  test('a success without the isolation policy is a 500, and its body is never sent', async () => {
    const sealed = sealView(new Response('<script>steal()</script>', { status: 200 }));
    expect(sealed.status).toBe(500);
    expect(await sealed.text()).not.toContain('steal');
    expect(isIsolated(sealed.headers)).toBe(true);
  });

  test('a success with a weakened policy is a 500 as well', () => {
    const headers = viewHeaders('text/html; charset=utf-8');
    headers.set('content-security-policy', VIEW_POLICY.replace('allow-forms', 'allow-same-origin'));
    expect(sealView(new Response('x', { headers })).status).toBe(500);
  });

  test('a refusal leaves with the policy and without a cookie', async () => {
    const refused = sealView(
      Response.json(
        { error: { code: 'not_found' } },
        { status: 404, headers: { 'set-cookie': 'a=b' } },
      ),
    );
    expect(refused.status).toBe(404);
    expect(isIsolated(refused.headers)).toBe(true);
    expect(refused.headers.has('set-cookie')).toBe(false);
    expect(await refused.json()).toEqual({ error: { code: 'not_found' } });
  });
});

describe('the isolating middleware', () => {
  function service() {
    const app = new Hono();
    app.onError((_error, c) => c.json({ error: { code: 'internal_error' } }, 500));
    app.use('/view/*', isolated);
    // Something outside the route that sets a cookie on every answer.
    app.use('*', async (c, next) => {
      await next();
      c.header('set-cookie', 'melete_session=x');
    });
    app.get('/view/forgot', () => new Response('<p>page</p>'));
    app.get('/view/served', () => new Response('<p>page</p>', { headers: viewHeaders('text/html') }));
    app.get('/view/throws', () => {
      throw new Error('boom');
    });
    return app;
  }

  test('turns a route that forgot the headers into a 500', async () => {
    const response = await service().request('/view/forgot');
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('<p>page</p>');
  });

  test('serves a route that set them, with no cookie from anything else', async () => {
    const response = await service().request('/view/served');
    expect(response.status).toBe(200);
    expect(isIsolated(response.headers)).toBe(true);
    expect(response.headers.has('set-cookie')).toBe(false);
  });

  test('isolates an error the route threw', async () => {
    const response = await service().request('/view/throws');
    expect(response.status).toBe(500);
    expect(isIsolated(response.headers)).toBe(true);
  });
});
