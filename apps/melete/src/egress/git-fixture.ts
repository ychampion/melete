/**
 * A git server that speaks smart HTTP, for tests: it answers a client's
 * `info/refs`, `git-upload-pack` and `git-receive-pack` requests from bare
 * repositories under one directory by running git's own pack programs, the
 * way a hosting service does. It checks the account a request carries, so a
 * test sees exactly what reached it. Test code only.
 */
import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

export type GitRequestSeen = {
  method: string;
  path: string;
  authorization: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
};

const ROUTE =
  /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const SERVICES = new Set(['git-upload-pack', 'git-receive-pack']);

function pkt(text: string): string {
  return `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;
}

function run(
  service: string,
  args: string[],
  input: Buffer | null,
  protocol: string | undefined,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [service.replace(/^git-/, ''), ...args], {
      env: { ...process.env, ...(protocol ? { GIT_PROTOCOL: protocol } : {}) },
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.resume();
    child.once('error', reject);
    child.once('close', () => resolve(Buffer.concat(chunks)));
    child.stdin.end(input ?? undefined);
  });
}

/**
 * A request handler for `node:http` or `node:https` that serves the bare
 * repositories under `root` (`<root>/<owner>/<name>.git`). With `account`,
 * a request without exactly that Authorization header is answered 401.
 */
export function gitSmartHttp(options: { root: string; account?: string; seen?: GitRequestSeen[] }) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://fixture');
        let body = Buffer.concat(chunks);
        if (request.headers['content-encoding'] === 'gzip') body = gunzipSync(body);
        options.seen?.push({
          method: request.method ?? '',
          path: `${url.pathname}${url.search}`,
          authorization: request.headers.authorization,
          headers: request.headers,
          body,
        });
        const match = ROUTE.exec(url.pathname);
        if (!match) {
          response.writeHead(404, { 'content-type': 'text/plain' });
          return response.end('Not found\n');
        }
        if (options.account && request.headers.authorization !== options.account) {
          response.writeHead(401, {
            'content-type': 'text/plain',
            'www-authenticate': 'Basic realm="GitHub"',
          });
          return response.end('Authentication required\n');
        }
        const [, owner, name, action] = match;
        const repository = path.join(options.root, owner ?? '', `${name}.git`);
        const protocol = request.headers['git-protocol'] as string | undefined;
        if (action === 'info/refs') {
          const service = url.searchParams.get('service') ?? '';
          if (!SERVICES.has(service)) {
            response.writeHead(403, { 'content-type': 'text/plain' });
            return response.end('Only smart HTTP is served\n');
          }
          const refs = await run(
            service,
            ['--stateless-rpc', '--advertise-refs', repository],
            null,
            protocol,
          );
          response.writeHead(200, {
            'content-type': `application/x-${service}-advertisement`,
            'cache-control': 'no-cache',
          });
          // Protocol v2 has no service line; v0 starts with one and a flush.
          return response.end(
            protocol?.includes('version=2')
              ? refs
              : Buffer.concat([Buffer.from(`${pkt(`# service=${service}\n`)}0000`), refs]),
          );
        }
        const service = action ?? '';
        const result = await run(service, ['--stateless-rpc', repository], body, protocol);
        response.writeHead(200, {
          'content-type': `application/x-${service}-result`,
          'cache-control': 'no-cache',
        });
        response.end(result);
      })().catch(() => {
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('The fixture failed\n');
      });
    });
  };
}
