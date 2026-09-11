import { fileURLToPath } from 'node:url';
import { mcpServerConfig } from '../../src/connectors/mcp.ts';

export const mcpFixtureConfig = () =>
  mcpServerConfig.parse({
    id: 'fixture',
    endpoint: {
      transport: 'stdio',
      command: process.execPath,
      args: [fileURLToPath(new URL('./mcp-server.ts', import.meta.url))],
    },
    allowed_scopes: ['mcp_fixture.read', 'mcp_fixture.write'],
    audience: 'owner',
    tools: [
      { name: 'read', alias: 'read', required_scopes: ['mcp_fixture.read'], effect_class: 'read' },
      { name: 'write', alias: 'write', required_scopes: ['mcp_fixture.write'] },
    ],
  });
