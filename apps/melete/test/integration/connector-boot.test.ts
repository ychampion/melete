/**
 * One connection that cannot be opened must not stop the service from starting.
 *
 * An installation that upgrades may already hold a row the current rules refuse,
 * such as another account's MCP server on a private address. Starting must load
 * everything else and mark that one row as failing, the way a failed
 * installation is marked, so testing it again is how it gets another chance.
 */
import { afterAll, expect, test } from 'bun:test';
import { configuredConnectors } from '../../src/connectors/configured.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
// Closing the database waits on the embedded server, which takes longer than the default.
afterAll(async () => {
  await fixture?.close?.();
}, 60_000);

test('a row that cannot be opened is marked failing and the rest still load', async () => {
  if (!fixture) throw new Error('Postgres unavailable');
  const sql = fixture.sql;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const message = (await request.json()) as { id?: number; method: string };
      if (message.id === undefined) return new Response(null, { status: 202 });
      const result =
        message.method === 'initialize'
          ? { protocolVersion: '2025-11-25', capabilities: { tools: {} } }
          : {
              tools: [{ name: 'lookup', description: 'Fixture', inputSchema: { type: 'object' } }],
            };
      return Response.json({ jsonrpc: '2.0', id: message.id, result });
    },
  });
  try {
    const policy = {
      id: 'inside',
      allowed_scopes: ['mcp_inside.lookup'],
      audience: 'owner',
      tools: [
        {
          name: 'lookup',
          alias: 'lookup',
          required_scopes: ['mcp_inside.lookup'],
          effect_class: 'read',
        },
      ],
    };
    const configuration = {
      server: { ...policy, endpoint: { transport: 'http', url: `${server.url}mcp` } },
    };
    await sql`insert into principal (id, email) values
      ('prn_setup', 'setup@example.test'), ('prn_other', 'other@example.test')`;
    await sql`insert into owner (id, email) values ('prn_setup', 'setup@example.test')`;
    await sql`insert into space (id, name, kind, audience, owner_principal_id, git_path) values
      ('sp_setup', 'Setup', 'personal', 'owner', 'prn_setup', '/tmp/boot-setup'),
      ('sp_other', 'Other', 'personal', 'owner', 'prn_other', '/tmp/boot-other')`;
    for (const [id, space] of [
      ['conn_setup', 'sp_setup'],
      ['conn_other', 'sp_other'],
    ] as const)
      await sql`insert into connection (id, space_id, provider, label, scopes, configuration, status, setup_state)
        values (${id}, ${space}, 'mcp', ${id}, '["mcp_inside.lookup"]'::jsonb,
          ${JSON.stringify(configuration)}::jsonb, 'active', 'connected')`;

    const registry = await configuredConnectors({
      sql,
      workRoot: 'unused',
      spacesRoot: 'unused',
      masterKey: '93'.repeat(32),
    });
    try {
      // The setup owner's server loads; the other account's private one does not.
      expect(Boolean(registry.get('conn_setup'))).toBe(true);
      expect(registry.get('conn_other')).toBeUndefined();
    } finally {
      await registry.close();
    }
    const [row] =
      await sql`select status, setup_state, health from connection where id = 'conn_other'`;
    expect(row).toEqual({ status: 'error', setup_state: 'error', health: 'failing' });
  } finally {
    server.stop(true);
  }
}, 120_000);
