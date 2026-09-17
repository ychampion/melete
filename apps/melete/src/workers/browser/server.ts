import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { z } from 'zod';
import { BrowserFault, type BrowserSessions } from './sessions.ts';

const leaseRequest = z.strictObject({
  job_id: z.string().min(1).max(100),
  policy: z.strictObject({
    public_compartment: z.boolean(),
    allowed_domains: z.array(z.string()).max(100),
  }),
});
const sessionRequest = z.strictObject({ session_id: z.string().min(1) });

/** This listener is only a broker transport; the owner's authenticated routes live in the service. */
export async function startBrowserServer(options: {
  sessions: BrowserSessions;
  token: string;
  port?: number;
  hostname?: string;
  command?: (input: unknown) => Promise<unknown>;
  /** A person's live channel; see live-routes.ts. */
  live?: (path: string, body: unknown) => Promise<unknown>;
}) {
  if (options.token.length < 32) throw new Error('A private worker token is required');
  const secret = Buffer.from(`Bearer ${options.token}`);
  const fetchRequest = async (request: Request) => {
    const supplied = Buffer.from(request.headers.get('authorization') ?? '');
    if (supplied.length !== secret.length || !timingSafeEqual(supplied, secret))
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    // Browser-originated requests cannot use this surface even if a page guesses its address.
    if (request.headers.has('origin') || request.headers.has('sec-fetch-site'))
      return Response.json({ error: 'browser_origin_refused' }, { status: 403 });
    const path = new URL(request.url).pathname;
    try {
      if (path === '/health' && request.method === 'GET') return Response.json({ status: 'ok' });
      if (request.method !== 'POST' || request.headers.get('content-type') !== 'application/json')
        return Response.json({ error: 'unsupported_request' }, { status: 405 });
      const body: unknown = await request.json();
      if (path === '/lease') {
        const input = leaseRequest.parse(body);
        return Response.json(await options.sessions.lease(input.job_id, input.policy));
      }
      if (path === '/takeover')
        return Response.json(
          await options.sessions.takeover(sessionRequest.parse(body).session_id),
        );
      if (path === '/handback')
        return Response.json(
          await options.sessions.handback(sessionRequest.parse(body).session_id),
        );
      if (path === '/release') {
        await options.sessions.close();
        return Response.json({ released: true });
      }
      if (path === '/command' && options.command) return Response.json(await options.command(body));
      if (path.startsWith('/live/') && options.live) {
        const result = await options.live(path, body);
        if (result !== undefined) return Response.json(result);
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    } catch (error) {
      const invalid = error instanceof z.ZodError || error instanceof SyntaxError;
      return Response.json(
        {
          error:
            error instanceof BrowserFault
              ? error.reason
              : invalid
                ? 'invalid_request'
                : 'worker_operation_failed',
        },
        { status: error instanceof BrowserFault ? 409 : invalid ? 400 : 500 },
      );
    }
  };
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 256 * 1024) {
          outgoing.writeHead(413).end();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers))
        if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const response = await fetchRequest(
        new Request(`http://worker${incoming.url ?? '/'}`, {
          method: incoming.method,
          headers,
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        }),
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(400).end();
    }
  });
  server.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.hostname ?? '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Worker did not bind TCP');
  return {
    port: address.port,
    url: new URL(`http://127.0.0.1:${address.port}`),
    stop: async (_force?: boolean) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
