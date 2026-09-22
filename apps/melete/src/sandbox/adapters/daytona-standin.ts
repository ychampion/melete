/**
 * A stand-in for Daytona used only to author fixtures before there is an account.
 *
 * It answers the requests the Daytona adapter makes in the shapes Daytona
 * publishes — the REST API from `libs/api-client-go/api/openapi.yaml` and the
 * toolbox from `libs/toolbox-api-client-go/api/openapi.yaml` in
 * daytonaio/daytona at v0.190.0 — and behaves as that release's source does
 * where the specification is silent:
 *
 * - `/process/execute` hands the command to the sandbox's shell in its own
 *   process group, kills the group at the request's timeout and then answers
 *   408; a finished command answers 200 with `exitCode` and the combined
 *   output as `result` (`apps/daemon/pkg/toolbox/process/execute.go`).
 * - `/files/upload` creates missing parent directories
 *   (`apps/daemon/pkg/toolbox/fs/upload_file.go`, gin v1.10.1), and
 *   `/files/download` answers 404 for a missing path and 400 for a directory.
 * - A sandbox is created `creating` and is `started` when next asked; `stop`
 *   ends its processes and keeps its files; `start` brings it back; stopping a
 *   sandbox that is not started is refused (`apps/api/src/sandbox/services/
 *   sandbox.service.ts`). A deleted sandbox is not found afterwards.
 * - The daemon's environment carries `DAYTONA_SANDBOX_ID`, `_SNAPSHOT`,
 *   `_USER`, `_ORGANIZATION_ID` and `_REGION_ID`, which commands inherit
 *   (`apps/runner/pkg/docker/container_configs.go`).
 * - Egress follows the runner's rules (`apps/runner/pkg/docker/network.go`):
 *   `networkBlockAll` drops everything, `networkAllowList` admits its IPv4
 *   ranges and nothing else. Setting it and `domainAllowList` together is a
 *   400, as the documentation says. The account is taken to be on a tier that
 *   may set a sandbox's egress.
 *
 * Fixtures written through it are marked `authored-from-documented-api`. They
 * prove the adapter speaks the published protocol; they are not evidence of
 * how Daytona behaves. The live test is, and re-records them.
 */
import { type FakeSandbox, FakeSandboxEngine, FsError } from '../fake.ts';
import type { EgressPolicy } from '../types.ts';
import { DAYTONA_API_URL, DAYTONA_TOOLBOX_PROXY_URL } from './daytona.ts';

export const AUTHORING_KEY = 'dtn_authoring_only_not_a_credential_0000';

const STARTED_AT = '2026-09-23T00:00:00.000Z';
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' },
  });

/** NestJS's error body, as the API sends it. */
const apiError = (status: number, message: string, error: string) =>
  json(status, { statusCode: status, message, error });

/** The daemon's error body. */
const toolboxError = (status: number, message: string) =>
  json(status, { statusCode: status, message, code: status === 408 ? 'REQUEST_TIMEOUT' : 'ERROR' });

function bodyBytes(body: RequestInit['body']): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  throw new Error('the stand-in reads only string and byte bodies');
}

/** The one file part of a `multipart/form-data` body. */
function formFile(contentType: string, bytes: Uint8Array): Uint8Array | null {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  if (!boundary) return null;
  const text = Buffer.from(bytes).toString('latin1');
  const start = text.indexOf('\r\n\r\n', text.indexOf('name="file"'));
  const end = text.lastIndexOf(`\r\n--${boundary}--`);
  if (start < 0 || end < start) return null;
  return new Uint8Array(Buffer.from(text.slice(start + 4, end), 'latin1'));
}

type Held = {
  sandbox: FakeSandbox;
  state: string;
  /** What the next read shows, for states Daytona passes through. */
  next: string | null;
  networkBlockAll: boolean;
  networkAllowList: string | null;
  autoStopInterval: number;
  autoDeleteInterval: number;
  snapshot: string;
};

function egressOf(body: {
  networkBlockAll?: boolean;
  networkAllowList?: string;
  domainAllowList?: string;
}): EgressPolicy {
  if (body.networkBlockAll === true) return { kind: 'deny_all' };
  const cidrs = (body.networkAllowList ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (cidrs.length) return { kind: 'cidr_allowlist', cidrs };
  return { kind: 'open' };
}

export function createDaytonaStandin(options: { ignoreLabelFilter?: boolean } = {}) {
  const engine = new FakeSandboxEngine();
  const records = new Map<string, Held>();
  let refuseStop = false;

  const dto = (record: Held) => ({
    id: record.sandbox.id,
    organizationId: 'org_authoring',
    name: record.sandbox.id,
    snapshot: record.snapshot,
    user: 'daytona',
    env: {},
    labels: record.sandbox.labels,
    public: false,
    networkBlockAll: record.networkBlockAll,
    ...(record.networkAllowList ? { networkAllowList: record.networkAllowList } : {}),
    target: 'us',
    cpu: 1,
    gpu: 0,
    memory: 1,
    disk: 3,
    state: record.state,
    desiredState:
      record.state === 'creating' || record.state === 'starting' ? 'started' : record.state,
    backupState: 'None',
    autoStopInterval: record.autoStopInterval,
    autoArchiveInterval: 10080,
    autoDeleteInterval: record.autoDeleteInterval,
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
    sandboxClass: 'container',
    daemonVersion: '0.190.0',
    toolboxProxyUrl: DAYTONA_TOOLBOX_PROXY_URL,
  });

  /** A read moves a sandbox through the state it was passing through. */
  const observe = (record: Held) => {
    const shown = dto(record);
    if (record.next) {
      record.state = record.next;
      record.next = null;
    }
    return shown;
  };

  function api(method: string, url: URL, init: RequestInit): Response {
    const path = url.pathname.slice(new URL(DAYTONA_API_URL).pathname.length);
    const parts = path.split('/').filter(Boolean);
    if (parts[0] !== 'sandbox') return apiError(404, `Cannot ${method} ${path}`, 'Not Found');
    if (method === 'POST' && parts.length === 1) {
      const body = JSON.parse(new TextDecoder().decode(bodyBytes(init.body))) as {
        snapshot?: unknown;
        env?: { [key: string]: string };
        labels?: { [key: string]: string };
        networkBlockAll?: boolean;
        networkAllowList?: string;
        domainAllowList?: string;
        autoStopInterval?: number;
        autoDeleteInterval?: number;
      };
      if (typeof body.snapshot !== 'string')
        return apiError(400, 'the stand-in needs a snapshot name', 'Bad Request');
      if (body.networkAllowList && body.domainAllowList)
        return apiError(
          400,
          'Set at most one of networkAllowList and domainAllowList',
          'Bad Request',
        );
      const allowList = (body.networkAllowList ?? '').split(',').filter((item) => item.trim());
      if (allowList.length > 10)
        return apiError(
          400,
          'Network allow list cannot contain more than 10 networks',
          'Bad Request',
        );
      const sandbox = engine.create({
        image: body.snapshot,
        egress: egressOf(body),
        labels: body.labels ?? {},
        env: {
          ...body.env,
          DAYTONA_SANDBOX_ID: 'pending',
          DAYTONA_SANDBOX_SNAPSHOT: body.snapshot,
          DAYTONA_SANDBOX_USER: 'daytona',
          DAYTONA_ORGANIZATION_ID: 'org_authoring',
          DAYTONA_REGION_ID: 'us',
        },
        // Daytona has no hard lifetime; the stand-in never expires a sandbox itself.
        lifetimeSeconds: 24 * 3600,
      });
      sandbox.env.DAYTONA_SANDBOX_ID = sandbox.id;
      const record: Held = {
        sandbox,
        state: 'creating',
        next: 'started',
        networkBlockAll: body.networkBlockAll === true,
        networkAllowList: body.networkBlockAll === true ? null : (body.networkAllowList ?? null),
        autoStopInterval: body.autoStopInterval ?? 15,
        autoDeleteInterval: body.autoDeleteInterval ?? -1,
        snapshot: body.snapshot,
      };
      records.set(sandbox.id, record);
      return json(200, dto(record));
    }
    if (method === 'GET' && parts.length === 1) {
      const wanted = JSON.parse(url.searchParams.get('labels') ?? '{}') as {
        [key: string]: string;
      };
      const items = [...records.values()]
        .filter(
          (record) =>
            options.ignoreLabelFilter ||
            Object.entries(wanted).every(([key, value]) => record.sandbox.labels[key] === value),
        )
        .map(dto);
      return json(200, { items, nextCursor: null });
    }
    const record = records.get(parts[1] ?? '');
    if (!record) return apiError(404, `Sandbox with ID or name ${parts[1]} not found`, 'Not Found');
    if (parts.length === 2 && method === 'GET') return json(200, observe(record));
    if (parts.length === 2 && method === 'DELETE') {
      engine.destroy(record.sandbox.id);
      records.delete(record.sandbox.id);
      record.state = 'destroying';
      return json(200, dto(record));
    }
    if (parts[2] === 'stop' && method === 'POST') {
      if (refuseStop) {
        refuseStop = false;
        return apiError(409, 'Sandbox state change in progress', 'Conflict');
      }
      if (record.state !== 'started')
        return apiError(400, 'Sandbox is not in a stoppable state', 'Bad Request');
      for (const process of record.sandbox.processes.values()) process.kill();
      record.sandbox.state = 'paused';
      record.state = 'stopping';
      record.next = 'stopped';
      return json(200, dto(record));
    }
    if (parts[2] === 'start' && method === 'POST') {
      if (record.state === 'started') return json(200, dto(record));
      if (record.state !== 'stopped' && record.state !== 'archived')
        return apiError(400, 'Sandbox is not in valid state', 'Bad Request');
      record.sandbox.state = 'running';
      record.state = 'starting';
      record.next = 'started';
      return json(200, dto(record));
    }
    return apiError(404, `Cannot ${method} ${path}`, 'Not Found');
  }

  function toolbox(method: string, url: URL, init: RequestInit): Response | Promise<Response> {
    const prefix = new URL(DAYTONA_TOOLBOX_PROXY_URL).pathname;
    const [id, ...rest] = url.pathname.slice(prefix.length + 1).split('/');
    const record = records.get(id ?? '');
    if (!record) return toolboxError(404, 'sandbox not found');
    if (record.state !== 'started') return toolboxError(400, 'sandbox is not running');
    const route = `/${rest.join('/')}`;
    const headers = new Headers(init.headers);
    const fs = record.sandbox.fs;
    if (route === '/process/execute' && method === 'POST') {
      if (!headers.get('content-type')?.startsWith('application/json'))
        return toolboxError(400, 'invalid request body');
      const body = JSON.parse(new TextDecoder().decode(bodyBytes(init.body))) as {
        command?: unknown;
        cwd?: unknown;
        timeout?: unknown;
      };
      if (typeof body.command !== 'string' || !body.command.trim())
        return toolboxError(400, 'command cannot be empty or whitespace-only');
      return execute(
        record.sandbox,
        body.command,
        typeof body.timeout === 'number' ? body.timeout : 0,
      );
    }
    const target = url.searchParams.get('path') ?? '';
    if (route === '/files/download' && method === 'GET') {
      if (!target) return toolboxError(400, 'path is required');
      if (fs.stat(target)?.kind === 'dir') return toolboxError(400, 'path must be a file');
      try {
        return new Response(fs.readFile(target), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      } catch (error) {
        if (error instanceof FsError)
          return toolboxError(404, `stat ${target}: no such file or directory`);
        throw error;
      }
    }
    if (route === '/files/upload' && method === 'POST') {
      if (!target) return toolboxError(400, 'path is required');
      const file = formFile(headers.get('content-type') ?? '', bodyBytes(init.body));
      if (!file) return toolboxError(400, 'http: no such file');
      fs.writeFile(target, file, { parents: true });
      return new Response(null, { status: 200 });
    }
    return toolboxError(404, 'no such route');
  }

  function execute(sandbox: FakeSandbox, command: string, timeoutSeconds: number) {
    const chunks: Uint8Array[] = [];
    const child = engine.spawn(sandbox, ['sh', '-c', command], {
      cwd: '/',
      onOutput: (bytes) => chunks.push(bytes),
    });
    let timedOut = false;
    const timer =
      timeoutSeconds > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, timeoutSeconds * 1000)
        : undefined;
    return child.done.then((result) => {
      clearTimeout(timer);
      if (timedOut) return toolboxError(408, 'command execution timeout');
      const output = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      return json(200, {
        exitCode: result.killed ? -1 : (result.exitCode ?? -1),
        result: new TextDecoder().decode(output),
      });
    });
  }

  const standinFetch: Fetch = async (input, init = {}) => {
    if (input instanceof Request) throw new Error('the stand-in takes URL requests');
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    init.signal?.throwIfAborted();
    if (new Headers(init.headers).get('authorization') !== `Bearer ${AUTHORING_KEY}`)
      return apiError(401, 'Unauthorized', 'Unauthorized');
    if (url.href.startsWith(`${DAYTONA_API_URL}/`)) return api(method, url, init);
    if (url.href.startsWith(`${DAYTONA_TOOLBOX_PROXY_URL}/`)) return toolbox(method, url, init);
    return new Response('unknown host', { status: 404 });
  };

  return {
    fetch: standinFetch,
    engine,
    /** The next stop is refused the way Daytona refuses one while a state change is in progress. */
    refuseNextStop() {
      refuseStop = true;
    },
  };
}
