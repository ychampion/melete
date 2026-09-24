/**
 * A stand-in for E2B used only to author fixtures before there is an account.
 *
 * It answers the requests the E2B adapter makes in the shapes E2B documents —
 * the REST control plane from `spec/openapi.yml`, envd's Connect services from
 * `spec/envd/{process,filesystem}/*.proto` and its `/files` endpoint from
 * `spec/envd/envd.yaml` — and runs the commands on the in-memory fake engine.
 * It is strict where E2B is: an API call needs `X-API-Key`, an envd call needs
 * the sandbox's access token and the Connect headers, and a stream is framed.
 *
 * Persistence follows `docs.e2b.dev/sandbox/persistence`: a pause keeps memory
 * and files and a paused sandbox never expires; a pause refused while an
 * earlier snapshot finishes answers 503 and leaves the sandbox running; connect
 * resumes a paused sandbox with 201 and restarts its continuous-runtime window,
 * and asks for a timeout within that window.
 *
 * Fixtures written through it are marked `authored-from-documented-api`. They
 * prove the adapter speaks the documented protocol; they are not evidence of
 * how E2B behaves. The live test is, and re-records them.
 */
import { isIP } from 'node:net';
import { type FakeSandbox, FakeSandboxEngine, FsError } from '../fake.ts';
import type { EgressPolicy } from '../types.ts';
import {
  CONNECT_STREAM,
  CONNECT_UNARY,
  decodeEnvelopes,
  encodeEndStream,
  encodeEnvelope,
} from './connect.ts';

export const AUTHORING_KEY = 'e2b_authoring_only_not_a_credential_0000';
export const AUTHORING_ENVD_TOKEN = 'authoring-envd-token-not-a-credential';
export const AUTHORING_TRAFFIC_TOKEN = 'authoring-traffic-token-not-a-credential';

const ENVD_VERSION = '0.6.4';
const STARTED_AT = '2026-09-17T00:00:00Z';
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });

const connectError = (status: number, code: string, message: string) =>
  json(status, { code, message });

function bodyBytes(body: RequestInit['body']): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  throw new Error('the stand-in reads only string and byte bodies');
}

function egressOf(body: {
  allow_internet_access?: boolean;
  network?: { allowOut?: string[]; denyOut?: string[] };
}): EgressPolicy {
  const allowOut = body.network?.allowOut ?? [];
  const denyOut = body.network?.denyOut ?? [];
  const internet = body.allow_internet_access !== false;
  if (!internet || denyOut.includes('0.0.0.0/0')) {
    if (!allowOut.length) return { kind: 'deny_all' };
    const domains = allowOut.filter((entry) => isIP(entry.split('/')[0] ?? '') === 0);
    if (domains.length) return { kind: 'domain_allowlist', domains };
    // With internet access on, a destination matching no rule is reachable, so
    // an allow-list that denies only `0.0.0.0/0` fences IPv4 and leaves every
    // IPv6 address open. The stand-in will not pretend otherwise.
    if (internet && !denyOut.includes('::/0'))
      throw new Error('an allow-list that denies only IPv4 leaves IPv6 egress unmatched');
    return { kind: 'cidr_allowlist', cidrs: allowOut };
  }
  if (denyOut.length) throw new Error('partial deny lists are not modelled by the stand-in');
  return { kind: 'open' };
}

function listed(sandbox: FakeSandbox) {
  return {
    templateID: sandbox.image,
    sandboxID: sandbox.id,
    clientID: '00000000',
    startedAt: STARTED_AT,
    endAt: STARTED_AT,
    cpuCount: 2,
    memoryMB: 512,
    diskSizeMB: 10240,
    metadata: sandbox.labels,
    state: sandbox.state,
    envdVersion: ENVD_VERSION,
  };
}

function created(sandbox: FakeSandbox) {
  return {
    templateID: sandbox.image,
    sandboxID: sandbox.id,
    clientID: '00000000',
    envdVersion: ENVD_VERSION,
    envdAccessToken: AUTHORING_ENVD_TOKEN,
    trafficAccessToken: AUTHORING_TRAFFIC_TOKEN,
    domain: 'e2b.app',
  };
}

const GO_MODE_DIR = 2 ** 31;
const GO_MODE_SYMLINK = 2 ** 27;

export function createE2bStandin(
  options: {
    ignoreMetadataFilter?: boolean;
    /** The plan's maximum continuous runtime; Hobby is one hour. */
    maxContinuousSeconds?: number;
  } = {},
) {
  const engine = new FakeSandboxEngine();
  const maxContinuous = options.maxContinuousSeconds ?? 3_600;
  /** When each sandbox's continuous-runtime window began. */
  const windows = new Map<string, number>();
  let refusePause = false;

  const expireIn = (sandbox: FakeSandbox, seconds: number | null) => {
    if (sandbox.expiry) clearTimeout(sandbox.expiry);
    sandbox.expiry = null;
    if (seconds === null) return;
    sandbox.expiry = setTimeout(() => engine.destroy(sandbox.id), seconds * 1000);
    sandbox.expiry.unref?.();
  };

  function api(method: string, url: URL, init: RequestInit): Response {
    const headers = new Headers(init.headers);
    if (headers.get('x-api-key') !== AUTHORING_KEY)
      return json(401, { code: 401, message: 'Invalid API key' });
    const parts = url.pathname.split('/').filter(Boolean);
    if (method === 'POST' && url.pathname === '/sandboxes') {
      if (headers.get('content-type') !== 'application/json')
        return json(400, { code: 400, message: 'expected a JSON body' });
      const body = JSON.parse(new TextDecoder().decode(bodyBytes(init.body))) as {
        templateID?: unknown;
        timeout?: unknown;
        metadata?: Record<string, string>;
        envVars?: Record<string, string>;
        allow_internet_access?: boolean;
        network?: { allowOut?: string[]; denyOut?: string[] };
      };
      if (typeof body.templateID !== 'string' || typeof body.timeout !== 'number')
        return json(400, { code: 400, message: 'templateID and timeout are required' });
      if (body.timeout > maxContinuous)
        return json(400, { code: 400, message: 'timeout exceeds the maximum continuous runtime' });
      const sandbox = engine.create({
        image: body.templateID,
        egress: egressOf(body),
        labels: body.metadata ?? {},
        env: body.envVars ?? {},
        lifetimeSeconds: body.timeout,
      });
      windows.set(sandbox.id, Date.now());
      return json(201, created(sandbox));
    }
    if (method === 'GET' && url.pathname === '/v2/sandboxes') {
      const wanted = new URLSearchParams(url.searchParams.get('metadata') ?? '');
      const states = (url.searchParams.get('state') ?? 'running,paused').split(',');
      const matches = [...engine.sandboxes.values()].filter(
        (sandbox) =>
          states.includes(sandbox.state) &&
          (options.ignoreMetadataFilter ||
            [...wanted].every(([key, value]) => sandbox.labels[key] === value)),
      );
      return json(200, matches.map(listed));
    }
    if (parts[0] === 'sandboxes' && parts[1]) {
      const sandbox = engine.get(parts[1]);
      if (!sandbox) return json(404, { code: 404, message: `sandbox ${parts[1]} not found` });
      if (parts.length === 2 && method === 'GET')
        return json(200, {
          ...listed(sandbox),
          envdAccessToken: AUTHORING_ENVD_TOKEN,
          domain: 'e2b.app',
        });
      if (parts.length === 2 && method === 'DELETE') {
        engine.destroy(sandbox.id);
        return json(204);
      }
      if (parts[2] === 'pause' && method === 'POST') {
        if (sandbox.state === 'paused') return json(409, { code: 409, message: 'already paused' });
        if (refusePause) {
          refusePause = false;
          return json(503, {
            code: 503,
            message: 'the sandbox is still finishing a previous snapshot; try again',
          });
        }
        sandbox.state = 'paused';
        // A paused sandbox is kept until it is killed.
        expireIn(sandbox, null);
        return json(204);
      }
      if (parts[2] === 'connect' && method === 'POST') {
        const body = JSON.parse(new TextDecoder().decode(bodyBytes(init.body)) || '{}') as {
          timeout?: unknown;
        };
        if (typeof body.timeout !== 'number')
          return json(400, { code: 400, message: 'timeout is required' });
        const resumed = sandbox.state === 'paused';
        if (resumed) {
          if (body.timeout > maxContinuous)
            return json(400, {
              code: 400,
              message: 'timeout exceeds the maximum continuous runtime',
            });
          windows.set(sandbox.id, Date.now());
          sandbox.state = 'running';
          expireIn(sandbox, body.timeout);
        } else {
          // A running sandbox's timeout is only ever extended, and not past its window.
          const begun = windows.get(sandbox.id) ?? Date.now();
          const left = maxContinuous - (Date.now() - begun) / 1000;
          expireIn(sandbox, Math.max(0, Math.min(body.timeout, left)));
        }
        return json(resumed ? 201 : 200, created(sandbox));
      }
    }
    return json(404, { code: 404, message: 'no such route' });
  }

  function envd(method: string, url: URL, init: RequestInit): Response {
    const headers = new Headers(init.headers);
    const sandbox = engine.get(headers.get('e2b-sandbox-id') ?? '');
    if (!sandbox) return new Response('sandbox not found', { status: 502 });
    if (sandbox.state !== 'running' || headers.get('e2b-sandbox-port') !== '49983')
      return new Response('sandbox not running', { status: 502 });
    if (headers.get('x-access-token') !== AUTHORING_ENVD_TOKEN)
      return connectError(401, 'unauthenticated', 'invalid access token');
    const fs = sandbox.fs;
    if (url.pathname === '/files') {
      const target = url.searchParams.get('path') ?? '';
      if (method === 'GET') {
        try {
          return new Response(fs.readFile(target), {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          });
        } catch (error) {
          if (error instanceof FsError && error.code === 'EISDIR')
            return json(400, { code: 400, message: `path '${target}' is a directory` });
          return json(404, { code: 404, message: `path '${target}' does not exist` });
        }
      }
      if (method === 'POST') {
        if (headers.get('content-type') !== 'application/octet-stream')
          return json(400, { code: 400, message: 'expected application/octet-stream' });
        fs.writeFile(target, bodyBytes(init.body), { parents: true });
        return json(200, [{ path: target, name: target.split('/').pop(), type: 'file' }]);
      }
    }
    if (method !== 'POST' || headers.get('connect-protocol-version') !== '1')
      return connectError(400, 'invalid_argument', 'not a Connect request');
    if (url.pathname === '/process.Process/Start') return start(sandbox, init, headers);
    if (headers.get('content-type') !== CONNECT_UNARY)
      return connectError(415, 'invalid_argument', 'expected application/json');
    const message = JSON.parse(new TextDecoder().decode(bodyBytes(init.body)) || '{}') as {
      path?: string;
      depth?: number;
      process?: { pid?: number };
      input?: { stdin?: string };
    };
    const running = sandbox.processes.get(message.process?.pid ?? -1);
    switch (url.pathname) {
      case '/filesystem.Filesystem/ListDir': {
        const base = (message.path ?? '').replace(/\/+$/, '');
        try {
          const entries = fs
            .list(base)
            .filter((entry) => entry.path.split('/').length <= (message.depth || 1))
            .map((entry) => ({
              name: entry.path.split('/').pop(),
              type: entry.symlink
                ? 'FILE_TYPE_SYMLINK'
                : entry.directory
                  ? 'FILE_TYPE_DIRECTORY'
                  : 'FILE_TYPE_FILE',
              path: `${base}/${entry.path}`,
              ...(entry.size ? { size: String(entry.size) } : {}),
              mode:
                entry.mode + (entry.directory ? GO_MODE_DIR : entry.symlink ? GO_MODE_SYMLINK : 0),
              owner: 'user',
              group: 'user',
            }));
          return json(200, entries.length ? { entries } : {});
        } catch (error) {
          if (error instanceof FsError)
            return connectError(404, 'not_found', `path not found: ${base}`);
          throw error;
        }
      }
      case '/process.Process/SendSignal':
        if (!running) return connectError(404, 'not_found', 'process not found');
        running.kill();
        return json(200, {});
      case '/process.Process/SendInput':
        if (!running) return connectError(404, 'not_found', 'process not found');
        running.writeStdin(new Uint8Array(Buffer.from(message.input?.stdin ?? '', 'base64')));
        return json(200, {});
      case '/process.Process/CloseStdin':
        if (!running) return connectError(404, 'not_found', 'process not found');
        running.closeStdin();
        return json(200, {});
      default:
        return connectError(404, 'unimplemented', 'no such procedure');
    }
  }

  function start(sandbox: FakeSandbox, init: RequestInit, headers: Headers): Response {
    if (headers.get('content-type') !== CONNECT_STREAM)
      return connectError(415, 'invalid_argument', 'expected application/connect+json');
    const [first] = decodeEnvelopes(bodyBytes(init.body));
    const request = first?.message as {
      process?: { cmd?: string; args?: string[]; cwd?: string };
      stdin?: boolean;
    };
    const deadline = Number(headers.get('connect-timeout-ms') ?? '0');
    const cmd = request?.process?.cmd ?? '';
    const cwd = request?.process?.cwd ?? '/home/user';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (bytes: Uint8Array) => {
          try {
            controller.enqueue(bytes);
          } catch {}
        };
        if (!sandbox.fs.stat(cwd)) {
          send(
            encodeEndStream({ code: 'invalid_argument', message: `cwd '${cwd}' does not exist` }),
          );
          controller.close();
          return;
        }
        let begun = false;
        const early: Uint8Array[] = [];
        const output = (bytes: Uint8Array) => {
          const event = encodeEnvelope({
            event: { data: { stdout: Buffer.from(bytes).toString('base64') } },
          });
          if (begun) send(event);
          else early.push(event);
        };
        const child = engine.spawn(sandbox, [cmd, ...(request.process?.args ?? [])], {
          cwd,
          stdin: request.stdin ? 'open' : undefined,
          onOutput: output,
        });
        send(encodeEnvelope({ event: { start: { pid: child.pid } } }));
        begun = true;
        for (const event of early) send(event);
        const timer = deadline > 0 ? setTimeout(() => child.kill(), deadline) : undefined;
        void child.done.then((result) => {
          clearTimeout(timer);
          const end = result.killed
            ? { exitCode: -1, status: 'signal: killed', error: 'signal: killed' }
            : result.exitCode === 0
              ? { exited: true, status: 'exit status 0' }
              : {
                  exitCode: result.exitCode,
                  exited: true,
                  status: `exit status ${result.exitCode}`,
                  error: `exit status ${result.exitCode}`,
                };
          send(encodeEnvelope({ event: { end } }));
          send(encodeEndStream());
          try {
            controller.close();
          } catch {}
        });
      },
      // A dropped connection leaves the process running, as envd does.
      cancel() {},
    });
    return new Response(stream, { status: 200, headers: { 'content-type': CONNECT_STREAM } });
  }

  const standinFetch: Fetch = async (input, init = {}) => {
    if (input instanceof Request) throw new Error('the stand-in takes URL requests');
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    init.signal?.throwIfAborted();
    if (url.origin === 'https://api.e2b.app') return api(method, url, init);
    if (url.origin === 'https://sandbox.e2b.app') return envd(method, url, init);
    return new Response('unknown host', { status: 404 });
  };

  return {
    fetch: standinFetch,
    engine,
    /** The next pause is refused the way E2B refuses one during an earlier snapshot. */
    refuseNextPause() {
      refusePause = true;
    },
  };
}
