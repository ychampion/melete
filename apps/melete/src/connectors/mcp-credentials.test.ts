import { afterAll, describe, expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import { mcpCredentialAccess } from './mcp-credentials.ts';
import { publicOnlyFetch } from './public-fetch.ts';
import type { SealedSecretStore } from './secrets.ts';
import type { ResolvedAddress } from './web.ts';

const binding = {
  connectionId: 'conn_01J000000000000000000000AA',
  spaceId: 'sp_01J000000000000000000000AA',
};

/** Just enough store and database to hold one sealed credential and accept its rotation. */
function held(tokenUrl: string, extra: Record<string, string> = {}) {
  const row = { secret_ref: 'sealed-1', generation: 1, scopes: [], status: 'active' };
  const sql = (async () => [row]) as unknown as Sql;
  const store = {
    withSecret: async (_ref: string, _space: string, use: (value: string) => unknown) =>
      use(
        JSON.stringify({
          access_token: 'old',
          refresh_token: 'refresh-1',
          token_url: tokenUrl,
          ...extra,
        }),
      ),
    put: async (_space: string, value: string) => {
      rotated.push(value);
      return 'sealed-2';
    },
  } as unknown as SealedSecretStore;
  return { sql, store };
}

const rotated: string[] = [];
let hits = 0;
const inside = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: () => {
    hits += 1;
    return Response.json({ access_token: 'stolen', token_type: 'Bearer' });
  },
});
afterAll(() => inside.stop(true));

describe('refreshing an MCP credential', () => {
  test('goes through the fetch it was given, so a private token endpoint is never reached', async () => {
    const { sql, store } = held(`http://127.0.0.1:${inside.port}/token`);
    const access = mcpCredentialAccess(sql, store, binding, undefined, publicOnlyFetch());
    await access.refresh().catch(() => false);
    expect(hits).toBe(0);
  });

  test('refreshes through a public, pinned token endpoint', async () => {
    const sent: { url: string; body: string }[] = [];
    const { sql, store } = held('https://auth.example.test/token');
    const access = mcpCredentialAccess(
      sql,
      store,
      binding,
      undefined,
      publicOnlyFetch({
        resolve: async (): Promise<ResolvedAddress[]> => [{ address: '93.184.216.34', family: 4 }],
        request: async (url, _address, init) => {
          sent.push({ url: url.href, body: String(init.body) });
          return Response.json({ access_token: 'new', token_type: 'Bearer' });
        },
      }),
    );
    expect(await access.refresh()).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://auth.example.test/token');
    expect(sent[0]?.body).toContain('grant_type=refresh_token');
  });

  test('asks for the resource the sign-in was granted for, and keeps it with the new token', async () => {
    const sent: string[] = [];
    const resource = 'https://files.example.test/mcp';
    const { sql, store } = held('https://auth.example.test/token', { resource, client_id: 'c1' });
    const access = mcpCredentialAccess(
      sql,
      store,
      binding,
      'https://configured.example.test/mcp',
      publicOnlyFetch({
        resolve: async (): Promise<ResolvedAddress[]> => [{ address: '93.184.216.34', family: 4 }],
        request: async (_url, _address, init) => {
          sent.push(String(init.body));
          return Response.json({ access_token: 'new', token_type: 'Bearer' });
        },
      }),
    );
    rotated.length = 0;
    expect(await access.refresh()).toBe(true);
    const form = new URLSearchParams(sent[0]);
    expect(form.get('resource')).toBe(resource);
    expect(form.get('client_id')).toBe('c1');
    expect(JSON.parse(rotated[0] ?? '{}')).toMatchObject({ access_token: 'new', resource });
  });
});

describe('a server asking for more access', () => {
  test('the scopes it names are kept with those named before, and nothing malformed is', async () => {
    const writes: string[] = [];
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('').includes('update connection')) {
        writes.push(String(values[0]));
        return [];
      }
      return [{ needed: ['files:read'] }];
    }) as unknown as Sql;
    const access = mcpCredentialAccess(sql, {} as SealedSecretStore, binding);
    await access.onInsufficientScope('files:write files:read bad"scope');
    expect(JSON.parse(writes[0] ?? '[]')).toEqual(['files:read', 'files:write']);
    await access.onInsufficientScope('"only-bad');
    expect(writes).toHaveLength(1);
  });
});
