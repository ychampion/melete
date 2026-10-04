/**
 * The cell service: the only holder of the Docker socket in a Compose
 * installation. It answers the Melete service on the private `cells` network,
 * for a request that carries its key, with the engine calls `policy.ts`
 * accepts, and refuses everything else with 403 before the engine sees it.
 *
 * Requests arrive as `/docker/<engine path>` and are passed to the socket
 * unchanged once judged; a container's inspection is passed back without its
 * environment. A stdio MCP server's attach, a hijacked HTTP connection the
 * engine makes, is carried both ways on a WebSocket at `/attach/<container>`.
 */
import { timingSafeEqual } from 'node:crypto';
import type { ServerWebSocket } from 'bun';
import { type AttachedStream, attachOverSocket } from '../connectors/mcp-stdio-docker.ts';
import { DOCKER_API_VERSION } from '../runtime/docker-engine.ts';
import { type CellsLookup, type CellsPolicyConfig, judge, redactContainer } from './policy.ts';

export type CellsServerOptions = CellsPolicyConfig & {
  /** The engine's socket path. */
  socket: string;
  /** The key a caller presents as `Authorization: Bearer <key>`. */
  key: string;
  hostname: string;
  port: number;
  /** For tests: the engine reached some other way than `socket`. */
  engine?: (path: string, init: RequestInit) => Promise<Response>;
  /** For tests: the attach made some other way than over `socket`. */
  attach?: (container: string) => Promise<AttachedStream>;
};

const MAX_BODY = 64 * 1024 * 1024;

const json = (status: number, message: string) =>
  new Response(JSON.stringify({ message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function authorized(request: Request, key: string): boolean {
  const presented = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
  const a = Buffer.from(presented);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The engine's own answer to a read, or null for 404, for judging a request. */
export function engineLookup(
  engine: (path: string, init: RequestInit) => Promise<Response>,
): CellsLookup {
  const read = async <T>(path: string): Promise<T | null> => {
    const response = await engine(`/v${DOCKER_API_VERSION}${path}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.ok) throw new Error(`the engine answered ${response.status}`);
    return (await response.json()) as T;
  };
  const named = (value: string) => encodeURIComponent(value);
  return {
    container: (id) => read(`/containers/${named(id)}/json`),
    network: (id) => read(`/networks/${named(id)}`),
    volume: (name) => read(`/volumes/${named(name)}`),
    image: (reference) => read(`/images/${named(reference)}/json`),
    exec: (id) => read(`/exec/${named(id)}/json`),
  };
}

type Attached = { container: string; stream?: AttachedStream; pending: Uint8Array[] };

export function startCellsServer(options: CellsServerOptions) {
  const engine =
    options.engine ??
    ((path: string, init: RequestInit) =>
      fetch(`http://localhost${path}`, { ...init, unix: options.socket }));
  const attach =
    options.attach ?? ((container: string) => attachOverSocket(options.socket, container));
  const lookup = engineLookup(engine);

  return Bun.serve<Attached, never>({
    hostname: options.hostname,
    port: options.port,
    maxRequestBodySize: MAX_BODY,
    // A server's attach and a long wait both stay open.
    idleTimeout: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === '/health') {
        const ping = await engine('/_ping', { signal: AbortSignal.timeout(5_000) }).catch(
          () => null,
        );
        return ping?.ok ? json(200, 'ok') : json(503, 'the engine does not answer');
      }
      if (!authorized(request, options.key)) return json(401, 'a key is required');

      const attachMatch = /^\/attach\/([a-f0-9]{12,64})$/.exec(url.pathname);
      if (attachMatch) {
        const container = attachMatch[1] ?? '';
        const verdict = await judge(
          {
            method: 'POST',
            path: `/containers/${container}/attach`,
            query: new URLSearchParams(),
          },
          options,
          lookup,
        ).catch(() => ({
          allow: false as const,
          status: 502,
          reason: 'the engine did not answer',
        }));
        if (!verdict.allow) return json(verdict.status, verdict.reason);
        return server.upgrade(request, { data: { container, pending: [] } })
          ? undefined
          : json(400, 'an attach is a WebSocket');
      }

      const match = /^\/docker(\/v\d+\.\d+)?(\/[^?]*)$/.exec(url.pathname);
      if (!match) return json(404, 'not found');
      const versioned = match[1] ?? '';
      const path = match[2] ?? '';
      if (!versioned && path !== '/version' && path !== '/_ping')
        return json(404, 'the engine is asked by a versioned path');
      const binary = request.headers.get('content-type') === 'application/x-tar';
      const raw = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
      let body: unknown;
      if (raw?.length && !binary) {
        try {
          body = JSON.parse(new TextDecoder().decode(raw));
        } catch {
          return json(400, 'the body is not JSON');
        }
      }
      let verdict: Awaited<ReturnType<typeof judge>>;
      try {
        verdict = await judge(
          { method: request.method, path, query: url.searchParams, body },
          options,
          lookup,
        );
      } catch {
        return json(502, 'the engine did not answer');
      }
      if (!verdict.allow) {
        process.stderr.write(`cells: refused ${request.method} ${path}: ${verdict.reason}\n`);
        return json(verdict.status, verdict.reason);
      }
      const headers = new Headers();
      const type = request.headers.get('content-type');
      if (type) headers.set('content-type', type);
      const answer = await engine(`${versioned}${path}${url.search}`, {
        method: request.method,
        headers,
        ...(raw?.length ? { body: raw } : {}),
        signal: request.signal,
      });
      if (verdict.redact === 'container' && answer.ok) {
        const value = redactContainer(await answer.json());
        return new Response(JSON.stringify(value), {
          status: answer.status,
          headers: { 'content-type': 'application/json' },
        });
      }
      const out = new Headers();
      const answered = answer.headers.get('content-type');
      if (answered) out.set('content-type', answered);
      return new Response(answer.body, { status: answer.status, headers: out });
    },
    websocket: {
      async open(socket: ServerWebSocket<Attached>) {
        try {
          const stream = await attach(socket.data.container);
          socket.data.stream = stream;
          for (const chunk of socket.data.pending.splice(0)) stream.write(chunk);
          stream.onData((bytes) => socket.sendBinary(bytes));
          stream.onClose(() => socket.close());
        } catch {
          socket.close(1011, 'the engine refused the attach');
        }
      },
      message(socket: ServerWebSocket<Attached>, message: string | Buffer) {
        const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;
        if (socket.data.stream) socket.data.stream.write(bytes);
        else socket.data.pending.push(bytes);
      },
      close(socket: ServerWebSocket<Attached>) {
        socket.data.stream?.destroy();
      },
    },
  });
}
