import { describe, expect, test } from 'bun:test';
import { MCP_APP_MIME_TYPE, PAGE_LIMITS } from '@melete/contracts';
import {
  allowedDomains,
  appOnly,
  connectionOrigins,
  declaredDomains,
  isAppMimeType,
  PAGE_POLICY_PREFIX,
  pagePolicy,
  readPageResource,
  toolPageUri,
} from './mcp-ui.ts';

describe('which tools carry a page', () => {
  test('reads the nested key and the earlier flat one, and only ui:// addresses', () => {
    expect(toolPageUri({ _meta: { ui: { resourceUri: 'ui://desk/a.html' } } })).toBe(
      'ui://desk/a.html',
    );
    expect(toolPageUri({ _meta: { 'ui/resourceUri': 'ui://desk/b.html' } })).toBe(
      'ui://desk/b.html',
    );
    for (const uri of ['https://desk.test/a.html', 'javascript:alert(1)', 'ui://', 'ui://a b', 7])
      expect(toolPageUri({ _meta: { ui: { resourceUri: uri } } })).toBeNull();
    expect(toolPageUri({})).toBeNull();
    expect(toolPageUri(null)).toBeNull();
  });

  test('a tool offered to its page only is not offered to the model', () => {
    expect(appOnly({ _meta: { ui: { visibility: ['app'] } } })).toBe(true);
    expect(appOnly({ _meta: { ui: { visibility: ['model', 'app'] } } })).toBe(false);
    expect(appOnly({ _meta: { ui: {} } })).toBe(false);
  });

  test('the page type is recognised however it is spaced or cased, and nothing else is', () => {
    expect(isAppMimeType('text/html; profile=mcp-app')).toBe(true);
    expect(isAppMimeType('TEXT/HTML;PROFILE=MCP-APP')).toBe(true);
    expect(isAppMimeType('text/html')).toBe(false);
    expect(isAppMimeType(undefined)).toBe(false);
  });
});

describe('what a page may reach', () => {
  test('only declared origins the connection allows, never a path, a wildcard or plain http', () => {
    const declared = declaredDomains({
      ui: {
        csp: {
          connectDomains: [
            'https://forms.example.test',
            'https://forms.example.test/',
            'https://evil.example.test',
            'https://*.example.test',
            'http://forms.example.test',
            'https://forms.example.test/path',
            "'self'",
            '*',
          ],
          resourceDomains: ['https://cdn.example.test'],
          frameDomains: ['http://localhost:4000'],
        },
      },
    });
    expect(declared.connect).toEqual(['https://forms.example.test', 'https://evil.example.test']);
    const allowed = allowedDomains(declared, [
      'https://forms.example.test',
      'http://localhost:4000',
    ]);
    expect(allowed).toEqual({
      connect: ['https://forms.example.test'],
      resource: [],
      frame: ['http://localhost:4000'],
    });
  });

  test('declarations past the limit are dropped', () => {
    const many = Array.from({ length: 100 }, (_, index) => `https://d${index}.example.test`);
    expect(declaredDomains({ ui: { csp: { connectDomains: many } } }).connect).toHaveLength(
      PAGE_LIMITS.domains_max,
    );
  });

  test("a connection's own origin is always allowed", () => {
    expect(connectionOrigins('https://desk.test/mcp', ['https://forms.test'])).toEqual([
      'https://desk.test',
      'https://forms.test',
    ]);
  });

  test('the policy sandboxes without same-origin, and declares nothing it was not given', () => {
    const none = pagePolicy({ connect: [], resource: [], frame: [] });
    expect(none.startsWith(PAGE_POLICY_PREFIX)).toBe(true);
    expect(none).not.toContain('allow-same-origin');
    expect(none).not.toContain('allow-popups');
    expect(none).not.toContain('allow-top-navigation');
    expect(none).toContain("connect-src 'none'");
    expect(none).toContain("frame-src 'none'");
    expect(none).toContain("form-action 'none'");
    expect(none).toContain("frame-ancestors 'self'");
    const some = pagePolicy({
      connect: ['https://forms.test'],
      resource: ['https://cdn.test'],
      frame: [],
    });
    expect(some).toContain('connect-src https://forms.test');
    expect(some).toContain("script-src 'unsafe-inline' https://cdn.test");
  });
});

describe('reading a page from its server', () => {
  const answer = (contents: unknown) => async () => ({ contents });
  const page = { uri: 'ui://desk/a.html', mimeType: MCP_APP_MIME_TYPE, text: '<p>hi</p>' };

  test('the page asked for, of the page type, as text or base64', async () => {
    expect((await readPageResource(answer([page]), page.uri)).html).toBe('<p>hi</p>');
    const blob = {
      uri: page.uri,
      mimeType: page.mimeType,
      blob: Buffer.from('<p>b</p>').toString('base64'),
    };
    expect((await readPageResource(answer([blob]), page.uri)).html).toBe('<p>b</p>');
  });

  test('another resource, another type, nothing, or too much is refused', async () => {
    await expect(
      readPageResource(answer([{ ...page, uri: 'ui://other' }]), page.uri),
    ).rejects.toThrow();
    await expect(
      readPageResource(answer([{ ...page, mimeType: 'text/html' }]), page.uri),
    ).rejects.toThrow();
    await expect(readPageResource(answer([]), page.uri)).rejects.toThrow();
    await expect(
      readPageResource(answer([{ uri: page.uri, mimeType: MCP_APP_MIME_TYPE }]), page.uri),
    ).rejects.toThrow();
    const big = { ...page, text: 'x'.repeat(PAGE_LIMITS.html_max_bytes + 1) };
    await expect(readPageResource(answer([big]), page.uri)).rejects.toThrow('too large');
  });
});
