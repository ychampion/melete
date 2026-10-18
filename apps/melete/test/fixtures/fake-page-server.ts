/**
 * A connected MCP server over Streamable HTTP (the 2025-11-25 handshake) with
 * one tool that shows a page (MCP Apps) and one that does not. It records every
 * request it is sent, with its headers, so a test can say what reached it.
 */
import { MCP_APP_MIME_TYPE } from '@melete/contracts';

export type PageServerRequest = {
  method: string;
  params: Record<string, unknown>;
  headers: Record<string, string>;
};

export type FakePageServer = {
  url: string;
  origin: string;
  requests: PageServerRequest[];
  /** The `tools/call` requests only. */
  calls(): PageServerRequest[];
  stop(): void;
};

export const PAGE_URI = 'ui://desk/form.html';
export const PAGE_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Form</title></head><body><p>Fill in the form</p></body></html>';

function rpcError(id: unknown, code: number, message: string) {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } });
}

export function startFakePageServer(
  options: { resources?: boolean; declared?: Record<string, string[]> } = {},
): FakePageServer {
  const requests: PageServerRequest[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/mcp')
        return new Response('not found', { status: 404 });
      if (request.method === 'DELETE') return new Response(null, { status: 204 });
      const message = (await request.json().catch(() => ({}))) as {
        id?: unknown;
        method?: string;
        params?: Record<string, unknown>;
      };
      const method = String(message.method ?? '');
      const params = message.params ?? {};
      requests.push({ method, params, headers: Object.fromEntries(request.headers.entries()) });
      if (message.id === undefined) return new Response(null, { status: 202 });
      if (method === 'initialize')
        return Response.json(
          {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: {
                tools: {},
                ...(options.resources === false ? {} : { resources: {} }),
              },
              serverInfo: { name: 'desk', version: '1.0.0' },
            },
          },
          { headers: { 'mcp-session-id': 'page-session' } },
        );
      if (request.headers.get('mcp-session-id') !== 'page-session')
        return rpcError(message.id, -32000, 'Bad Request: No valid session ID provided');
      if (method === 'tools/list')
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: [
              {
                name: 'open_form',
                description: 'Show the form',
                inputSchema: { type: 'object', properties: { item: { type: 'string' } } },
                _meta: { ui: { resourceUri: PAGE_URI } },
              },
              {
                name: 'search',
                description: 'Search the catalogue',
                inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
              },
              {
                name: 'hold',
                description: 'Hold an item',
                inputSchema: { type: 'object', properties: { item: { type: 'string' } } },
              },
              {
                name: 'form_status',
                description: 'For the page only',
                inputSchema: { type: 'object' },
                _meta: { ui: { resourceUri: PAGE_URI, visibility: ['app'] } },
              },
            ],
          },
        });
      if (method === 'resources/read')
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            contents: [
              {
                uri: PAGE_URI,
                mimeType: MCP_APP_MIME_TYPE,
                text: PAGE_HTML,
                _meta: {
                  ui: {
                    csp: options.declared ?? {
                      connectDomains: ['https://forms.example.test', 'https://evil.example.test'],
                      resourceDomains: ['https://forms.example.test'],
                    },
                  },
                },
              },
            ],
          },
        });
      if (method === 'tools/call') {
        const name = String(params.name ?? '');
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: `${name} done` }],
            structuredContent: { name, total: '300.00 USD' },
            ...(name === 'open_form'
              ? { _meta: { 'io.melete/page': { expires_in_seconds: 900 } } }
              : {}),
          },
        });
      }
      return rpcError(message.id, -32601, 'Method not found');
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    url: `${origin}/mcp`,
    origin,
    requests,
    calls: () => requests.filter((entry) => entry.method === 'tools/call'),
    stop: () => server.stop(true),
  };
}
