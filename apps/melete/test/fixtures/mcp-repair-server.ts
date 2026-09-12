import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const path = process.argv[2];
if (!path) throw new Error('The repair fixture needs an explicit state path');
const state = () =>
  JSON.parse(readFileSync(path, 'utf8')) as {
    initializations: number;
    calls: number;
    authorized?: boolean;
  };
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line) as { id?: number; method: string };
  if (message.id === undefined) return;
  const current = state();
  let result: unknown = {};
  if (message.method === 'initialize') {
    current.initializations++;
    result = { protocolVersion: '2025-11-25', capabilities: { tools: {} } };
  } else if (message.method === 'tools/list') {
    result = { tools: [{ name: 'read', inputSchema: { type: 'object' } }] };
  } else if (message.method === 'tools/call') {
    current.calls++;
    current.authorized = process.env.MELETE_MCP_ACCESS_TOKEN === 'fresh-mcp-token';
    result = {
      content: [{ type: 'text', text: 'stdio-repaired-result' }],
      structuredContent: { authorized: current.authorized },
    };
  }
  writeFileSync(path, JSON.stringify(current));
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
});
