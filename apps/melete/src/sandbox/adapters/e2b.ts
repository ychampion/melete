/**
 * E2B sandboxes behind the `SandboxProvider` seam.
 *
 * Two surfaces, both over plain `fetch`:
 *
 * - The control plane is E2B's documented REST API (`https://api.e2b.app`,
 *   OpenAPI `spec/openapi.yml` in e2b-dev/E2B), authenticated with `X-API-Key`:
 *   create, get, list with a metadata filter, pause, connect, kill.
 * - Commands and files go to `envd`, the daemon inside each sandbox. Commands
 *   and directory listings are Connect RPCs (`spec/envd/process/process.proto`,
 *   `spec/envd/filesystem/filesystem.proto`); `Process.Start` is a server
 *   stream. File bytes use envd's HTTP `/files` endpoint (`spec/envd/envd.yaml`).
 *   Every envd call carries the per-sandbox access token that create or connect
 *   returned, and runs as a named user.
 *
 * The API key is lent to this adapter one call at a time through `credential`,
 * never read from the environment, and scrubbed from every error message. The
 * envd access token is held in memory for the life of the process only.
 *
 * Egress is decided at creation and never afterwards: deny-all is
 * `allow_internet_access: false`, a CIDR allow-list denies 0.0.0.0/0 and allows
 * the listed blocks, and public sandbox URLs always require E2B's traffic
 * token. E2B's domain allow-list is not offered: its own documentation calls it
 * a routing control rather than a security boundary and it opens DNS to
 * 8.8.8.8, so a spec asking for it is refused.
 */
import { markerDirectory, reattachByMarker } from '../marker.ts';
import {
  type EgressPolicy,
  type ExecOutcome,
  type ExecSpec,
  type FileEntry,
  SandboxAdapterRefusal,
  type SandboxCapabilities,
  SandboxFileNotFound,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxSpec,
  SandboxStartRefused,
  SandboxTransportError,
} from '../types.ts';
import {
  CONNECT_STREAM,
  CONNECT_UNARY,
  ConnectError,
  encodeEnvelope,
  readEnvelopes,
  readLimited,
  readPrefix,
} from './connect.ts';

export type E2bCredential = <T>(use: (apiKey: string) => Promise<T>) => Promise<T>;
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type E2bOptions = {
  /** Lends the API key for one call; for example a sealed-secret reader. */
  credential: E2bCredential;
  fetch?: Fetch;
  /** Hobby sandboxes run for at most an hour, Pro for 24 hours. */
  plan?: 'hobby' | 'pro';
  apiUrl?: string;
  /** The sandbox domain when create does not name one. */
  domain?: string;
  /** The sandbox user commands and files run as. */
  user?: string;
  /** How long a resumed sandbox may run before E2B stops it. */
  resumeTimeoutSeconds?: number;
};

const MiB = 1024 * 1024;
const ENVD_PORT = 49983;
/** Hosts E2B routes through `sandbox.<domain>` with the sandbox named in headers. */
const ROUTED_DOMAINS = new Set(['e2b.app', 'e2b.dev', 'e2b.pro', 'e2b-staging.dev']);
/** Raw octet-stream uploads need this envd. */
const MINIMUM_ENVD = [0, 5, 7] as const;
const LIST_DEPTH = 32;
const REQUEST_TIMEOUT_MS = 60_000;
/** Past the command's own timeout, how long the kill may take before the answer is lost. */
const KILL_GRACE_MS = 30_000;
const SANDBOX_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PLAIN = /^[A-Za-z0-9._-]{1,128}$/;

export function e2bCapabilities(plan: 'hobby' | 'pro' = 'hobby'): SandboxCapabilities {
  return {
    adapter: 'e2b',
    isolation: 'microvm',
    egress: ['deny_all', 'cidr_allowlist', 'open'],
    persistence: ['none', 'pause'],
    maxLifetimeSeconds: plan === 'pro' ? 86_400 : 3_600,
    maxIdleSeconds: null,
    streaming: false,
    reattach: 'marker_only',
    ports: 'authenticated',
    image: 'template',
    billing: 'per_second',
    regions: [],
    maxUploadBytes: 8 * MiB,
  };
}

export class E2bApiError extends Error {
  override readonly name = 'E2bApiError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Session = { id: string; token: string; domain: string; envdVersion: string };

type ProcessEvent = {
  event?: {
    start?: { pid?: number };
    data?: { stdout?: string; stderr?: string; pty?: string };
    end?: { exitCode?: number; exited?: boolean; status?: string; error?: string };
    keepalive?: Record<string, never>;
  };
};

type EnvdEntry = {
  name?: string;
  type?: string;
  path?: string;
  size?: string | number;
  mode?: number;
  symlinkTarget?: string;
};

const scrub = (text: string, secrets: readonly (string | undefined)[]) =>
  secrets.reduce<string>(
    (current, secret) => (secret ? current.split(secret).join('[redacted]') : current),
    text,
  );

const describeError = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

function versionAtLeast(version: string, minimum: readonly number[]): boolean {
  const parts = version.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < minimum.length; index += 1) {
    const have = parts[index] ?? 0;
    const want = minimum[index] ?? 0;
    if (!Number.isFinite(have)) return false;
    if (have !== want) return have > want;
  }
  return true;
}

function networkFor(egress: EgressPolicy): {
  allow_internet_access: boolean;
  network: Record<string, unknown>;
} {
  switch (egress.kind) {
    case 'deny_all':
      return { allow_internet_access: false, network: { allowPublicTraffic: false } };
    case 'cidr_allowlist':
      return {
        allow_internet_access: true,
        network: { allowPublicTraffic: false, allowOut: [...egress.cidrs], denyOut: ['0.0.0.0/0'] },
      };
    case 'open':
      return { allow_internet_access: true, network: { allowPublicTraffic: false } };
    case 'domain_allowlist':
      throw new SandboxAdapterRefusal('the e2b adapter does not offer a domain allow-list');
  }
}

function signalName(status: string | undefined): string {
  const named = /signal: (\w+)/.exec(status ?? '')?.[1];
  const known: Record<string, string> = { killed: 'SIGKILL', terminated: 'SIGTERM' };
  return (named && known[named]) ?? named ?? 'unknown';
}

/**
 * A Start the daemon answered with an error before any event. `refused` means
 * the answer says the process was not created; anything else leaves it open.
 */
class StartFailure extends Error {
  override readonly name = 'StartFailure';
  constructor(
    readonly code: string,
    readonly refused: boolean,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

const REFUSAL_CODES = new Set([
  'invalid_argument',
  'failed_precondition',
  'permission_denied',
  'unauthenticated',
  'not_found',
  'already_exists',
  'out_of_range',
  'unimplemented',
  'resource_exhausted',
]);

function connectFailure(error: ConnectError): Error {
  if (error.code === 'not_found') return new SandboxFileNotFound(error.message);
  if (
    ['invalid_argument', 'failed_precondition', 'permission_denied', 'unauthenticated'].includes(
      error.code,
    )
  )
    return new SandboxAdapterRefusal(`envd refused the request: ${error.message}`);
  return new SandboxTransportError(`envd did not complete the request: ${error.message}`);
}

export function createE2bProvider(options: E2bOptions): SandboxProvider {
  const fetchImpl: Fetch = options.fetch ?? fetch;
  const apiUrl = (options.apiUrl ?? 'https://api.e2b.app').replace(/\/$/, '');
  const defaultDomain = options.domain ?? 'e2b.app';
  const user = options.user ?? 'user';
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error('an invalid sandbox user name');
  const capabilities = e2bCapabilities(options.plan);
  const sessions = new Map<string, Session>();

  const sandboxId = (handle: SandboxHandle | string) => {
    const id = typeof handle === 'string' ? handle : handle.providerSandboxId;
    if (!SANDBOX_ID.test(id)) throw new SandboxAdapterRefusal('not an E2B sandbox id');
    return id;
  };

  async function rest(
    method: string,
    path: string,
    body: unknown,
    accept: readonly number[],
    signal: AbortSignal,
  ): Promise<{ status: number; json: unknown; headers: Headers }> {
    return options.credential(async (key) => {
      let response: Response;
      try {
        response = await fetchImpl(`${apiUrl}${path}`, {
          method,
          headers: {
            'X-API-Key': key,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
      } catch (error) {
        throw new SandboxTransportError(
          scrub(`the E2B API did not answer: ${describeError(error)}`, [key]),
        );
      }
      let text: string;
      try {
        text = new TextDecoder().decode(await readLimited(response, 4 * MiB));
      } catch (error) {
        throw new SandboxTransportError(
          scrub(`the E2B API answer could not be read: ${describeError(error)}`, [key]),
        );
      }
      if (!accept.includes(response.status)) {
        let detail = text.slice(0, 300);
        try {
          const parsed = JSON.parse(text) as { message?: unknown };
          if (typeof parsed.message === 'string') detail = parsed.message.slice(0, 300);
        } catch {}
        throw new E2bApiError(
          response.status,
          scrub(`E2B answered ${response.status} to ${method} ${path.split('?')[0]}: ${detail}`, [
            key,
          ]),
        );
      }
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          throw new SandboxTransportError('the E2B API answered with something that is not JSON');
        }
      }
      return { status: response.status, json, headers: response.headers };
    });
  }

  function remember(sandbox: {
    sandboxID?: unknown;
    envdAccessToken?: unknown;
    domain?: unknown;
    envdVersion?: unknown;
  }): Session {
    const id = typeof sandbox.sandboxID === 'string' ? sandbox.sandboxID : '';
    if (!SANDBOX_ID.test(id)) throw new SandboxTransportError('E2B answered without a sandbox id');
    if (typeof sandbox.envdAccessToken !== 'string' || !sandbox.envdAccessToken)
      throw new SandboxAdapterRefusal('the sandbox was not created with secured access');
    const session: Session = {
      id,
      token: sandbox.envdAccessToken,
      domain: typeof sandbox.domain === 'string' && sandbox.domain ? sandbox.domain : defaultDomain,
      envdVersion: typeof sandbox.envdVersion === 'string' ? sandbox.envdVersion : '0.0.0',
    };
    sessions.set(id, session);
    return session;
  }

  async function sessionFor(handle: SandboxHandle, signal: AbortSignal): Promise<Session> {
    const id = sandboxId(handle);
    const known = sessions.get(id);
    if (known) return known;
    const { json } = await rest('GET', `/sandboxes/${id}`, undefined, [200], signal);
    const detail = json as { state?: unknown };
    if (detail.state !== 'running') throw new SandboxAdapterRefusal('the sandbox is not running');
    return remember(json as Record<string, unknown>);
  }

  function envd(session: Session, path: string, root = false) {
    const base = ROUTED_DOMAINS.has(session.domain)
      ? `https://sandbox.${session.domain}`
      : `https://${ENVD_PORT}-${session.id}.${session.domain}`;
    const headers: Record<string, string> = {
      'E2b-Sandbox-Id': session.id,
      'E2b-Sandbox-Port': String(ENVD_PORT),
      'X-Access-Token': session.token,
      Authorization: `Basic ${Buffer.from(`${root ? 'root' : user}:`).toString('base64')}`,
    };
    return { url: `${base}${path}`, headers };
  }

  async function unary<T>(
    session: Session,
    procedure: string,
    message: unknown,
    signal: AbortSignal,
  ): Promise<T> {
    const { url, headers } = envd(session, `/${procedure}`);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': CONNECT_UNARY, 'Connect-Protocol-Version': '1' },
        body: JSON.stringify(message),
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
    } catch (error) {
      throw new SandboxTransportError(
        scrub(`envd did not answer ${procedure}: ${describeError(error)}`, [session.token]),
      );
    }
    const text = new TextDecoder().decode(await readLimited(response, 16 * MiB));
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new SandboxTransportError(`envd answered ${procedure} with something that is not JSON`);
    }
    if (response.status !== 200)
      throw connectFailure(
        new ConnectError(
          typeof parsed.code === 'string' ? parsed.code : 'unknown',
          scrub(String(parsed.message ?? response.status), [session.token]),
        ),
      );
    return parsed as T;
  }

  /** Start a process and read its events until the stream ends. */
  async function* processEvents(
    session: Session,
    request: { cmd: string; args: readonly string[]; cwd: string; stdin: boolean },
    streamTimeoutMs: number,
    root: boolean,
    signal: AbortSignal,
  ): AsyncGenerator<ProcessEvent, void, undefined> {
    const { url, headers } = envd(session, '/process.Process/Start', root);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': CONNECT_STREAM,
          'Connect-Protocol-Version': '1',
          'Connect-Timeout-Ms': String(streamTimeoutMs),
          'Keepalive-Ping-Interval': '50',
        },
        body: encodeEnvelope({
          process: { cmd: request.cmd, args: [...request.args], cwd: request.cwd },
          stdin: request.stdin,
        }),
        signal,
      });
    } catch (error) {
      throw new SandboxTransportError(
        scrub(`envd did not answer Start: ${describeError(error)}`, [session.token]),
      );
    }
    if (response.status !== 200 || !response.body) {
      const text = new TextDecoder().decode(
        await readLimited(response, MiB).catch(() => new Uint8Array()),
      );
      let code = 'unknown';
      let message = String(response.status);
      try {
        const parsed = JSON.parse(text) as { code?: unknown; message?: unknown };
        if (typeof parsed.code === 'string') code = parsed.code;
        if (typeof parsed.message === 'string') message = parsed.message;
      } catch {}
      // A 4xx is an answer that the request was not acted on; a 5xx may come
      // from a proxy that forwarded it and then gave up.
      const refused = response.status >= 400 && response.status < 500 && response.status !== 408;
      throw new StartFailure(code, refused, scrub(message, [session.token]));
    }
    try {
      for await (const message of readEnvelopes(response.body, 16 * MiB))
        yield message as ProcessEvent;
    } catch (error) {
      if (error instanceof ConnectError)
        throw new StartFailure(
          error.code,
          REFUSAL_CODES.has(error.code),
          scrub(error.message, [session.token]),
        );
      throw new SandboxTransportError(
        scrub(`the command stream was cut: ${describeError(error)}`, [session.token]),
      );
    }
  }

  /** Run a short command to completion and return its exit and output. */
  async function runShort(
    session: Session,
    args: readonly string[],
    root: boolean,
    signal: AbortSignal,
  ): Promise<{ exitCode: number | null; output: string }> {
    let output = '';
    let exitCode: number | null = null;
    try {
      for await (const event of processEvents(
        session,
        { cmd: '/bin/sh', args, cwd: '/', stdin: false },
        REQUEST_TIMEOUT_MS,
        root,
        signal,
      )) {
        const data = event.event?.data;
        const chunk = data?.stdout ?? data?.stderr;
        if (chunk) output += Buffer.from(chunk, 'base64').toString('utf8');
        const end = event.event?.end;
        if (end) exitCode = end.exited ? (end.exitCode ?? 0) : null;
      }
    } catch (error) {
      if (error instanceof StartFailure)
        throw connectFailure(new ConnectError(error.code, error.message));
      throw error;
    }
    return { exitCode, output };
  }

  /**
   * Kill the whole process group. envd starts `setsid`, so the command's pid is
   * also its group; its own signal call reaches only the one process.
   */
  async function killGroup(session: Session, pid: number): Promise<void> {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      const result = await runShort(session, ['-c', `kill -KILL -- -${pid}`], false, signal);
      if (result.exitCode === 0) return;
    } catch {}
    await unary(
      session,
      'process.Process/SendSignal',
      { process: { pid }, signal: 'SIGNAL_SIGKILL' },
      signal,
    ).catch(() => {});
  }

  const provider: SandboxProvider = {
    capabilities,

    async create(spec: SandboxSpec, signal: AbortSignal): Promise<SandboxHandle> {
      if (!capabilities.egress.includes(spec.egress.kind))
        throw new SandboxAdapterRefusal(`the e2b adapter cannot enforce ${spec.egress.kind}`);
      if (spec.cpu !== undefined || spec.memoryMb !== undefined || spec.diskMb !== undefined)
        throw new SandboxAdapterRefusal('E2B sizes a sandbox by its template, not per sandbox');
      if (spec.region !== null) throw new SandboxAdapterRefusal('E2B does not place by region');
      if (spec.idleSeconds !== null) throw new SandboxAdapterRefusal('E2B has no idle timeout');
      if (spec.lifetimeSeconds > capabilities.maxLifetimeSeconds || spec.lifetimeSeconds <= 0)
        throw new SandboxAdapterRefusal('the lifetime is outside what E2B allows');
      for (const [key, value] of Object.entries(spec.labels))
        if (!PLAIN.test(key) || !PLAIN.test(value))
          throw new SandboxAdapterRefusal('a label is not plain enough to filter by');
      const { json } = await rest(
        'POST',
        '/sandboxes',
        {
          templateID: spec.image,
          timeout: spec.lifetimeSeconds,
          autoPause: false,
          secure: true,
          ...networkFor(spec.egress),
          metadata: { ...spec.labels },
          envVars: { ...spec.env },
        },
        [201],
        signal,
      );
      const created = json as Record<string, unknown>;
      const id = typeof created.sandboxID === 'string' ? created.sandboxID : '';
      const handle: SandboxHandle = { providerSandboxId: id, imageDigest: null, region: null };
      try {
        const session = remember(created);
        if (!versionAtLeast(session.envdVersion, MINIMUM_ENVD))
          throw new SandboxAdapterRefusal(
            `the template's envd ${session.envdVersion} is older than 0.5.7; rebuild the template`,
          );
        const prepared = await runShort(
          session,
          ['-c', `mkdir -p /work && chown ${user} /work`],
          true,
          signal,
        );
        if (prepared.exitCode !== 0)
          throw new SandboxAdapterRefusal(
            `the workspace could not be prepared: ${prepared.output.slice(0, 200)}`,
          );
        return handle;
      } catch (error) {
        // A sandbox this adapter will not use is not left running.
        if (SANDBOX_ID.test(id))
          await provider.destroy(handle, AbortSignal.timeout(REQUEST_TIMEOUT_MS)).catch(() => {});
        throw error;
      }
    },

    async connect(handle: SandboxHandle, signal: AbortSignal): Promise<void> {
      sessions.delete(sandboxId(handle));
      await sessionFor(handle, signal);
    },

    async exec(handle: SandboxHandle, spec: ExecSpec, signal: AbortSignal): Promise<ExecOutcome> {
      if (spec.stdin && spec.stdin.byteLength > 8 * MiB)
        throw new SandboxAdapterRefusal('stdin above 8 MiB is refused');
      const session = await sessionFor(handle, signal);
      const started = performance.now();
      const stream = new AbortController();
      const abandon = () => stream.abort(signal.reason);
      signal.addEventListener('abort', abandon, { once: true });
      const kept: Uint8Array[] = [];
      let keptBytes = 0;
      let totalBytes = 0;
      let timedOut = false;
      let killing: Promise<void> | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stall = setTimeout(
        () => stream.abort(new Error('the command did not answer after its kill')),
        spec.timeoutMs + KILL_GRACE_MS,
      );
      let outcome: ExecOutcome | null = null;
      let pid: number | null = null;
      try {
        for await (const event of processEvents(
          session,
          { cmd: 'setsid', args: spec.argv, cwd: spec.cwd, stdin: spec.stdin !== undefined },
          spec.timeoutMs + KILL_GRACE_MS,
          false,
          stream.signal,
        )) {
          const body = event.event;
          if (!body || outcome) continue;
          if (pid === null) {
            if (!body.start?.pid)
              throw new SandboxTransportError('envd did not report a process start');
            pid = body.start.pid;
            const group = pid;
            timer = setTimeout(() => {
              timedOut = true;
              killing = killGroup(session, group);
            }, spec.timeoutMs);
            if (spec.stdin !== undefined) {
              await unary(
                session,
                'process.Process/SendInput',
                { process: { pid }, input: { stdin: Buffer.from(spec.stdin).toString('base64') } },
                stream.signal,
              );
              await unary(
                session,
                'process.Process/CloseStdin',
                { process: { pid } },
                stream.signal,
              );
            }
            continue;
          }
          const data = body.data?.stdout ?? body.data?.stderr ?? body.data?.pty;
          if (data) {
            const bytes = new Uint8Array(Buffer.from(data, 'base64'));
            totalBytes += bytes.byteLength;
            const room = spec.maxOutputBytes - keptBytes;
            if (room > 0) {
              const slice = bytes.subarray(0, room);
              kept.push(slice);
              keptBytes += slice.byteLength;
            }
          }
          if (body.end) {
            clearTimeout(timer);
            const output = new Uint8Array(keptBytes);
            let offset = 0;
            for (const chunk of kept) {
              output.set(chunk, offset);
              offset += chunk.byteLength;
            }
            const exited = body.end.exited === true && !timedOut;
            // Kept, and the stream read on to its end-of-stream message.
            outcome = {
              started: 'yes',
              state: exited ? 'exited' : 'killed',
              exitCode: exited ? (body.end.exitCode ?? 0) : null,
              signal: exited ? null : timedOut ? 'SIGKILL' : signalName(body.end.status),
              timedOut,
              durationMs: Math.round(performance.now() - started),
              output,
              totalBytes,
              captureLimited: totalBytes > keptBytes,
            };
          }
        }
        if (!outcome)
          throw new SandboxTransportError('the command stream ended without an exit', 'yes');
        return outcome;
      } catch (error) {
        // What the command's fate can be decided from: whether envd said it
        // started, and whether a failure before that was a refusal.
        const detail = scrub(describeError(error), [session.token]);
        if (pid !== null) {
          if (error instanceof SandboxTransportError && error.started === 'yes') throw error;
          throw new SandboxTransportError(`the command started, then: ${detail}`, 'yes');
        }
        if (error instanceof StartFailure && error.refused)
          throw new SandboxStartRefused(`envd refused to start the command: ${detail}`);
        throw new SandboxTransportError(`no start was reported: ${detail}`, 'unknown');
      } finally {
        clearTimeout(timer);
        clearTimeout(stall);
        signal.removeEventListener('abort', abandon);
        if (killing) await (killing as Promise<void>).catch(() => {});
      }
    },

    reattach(handle: SandboxHandle, marker: string, signal: AbortSignal) {
      markerDirectory(marker);
      return reattachByMarker(provider, handle, marker, signal);
    },

    async putFiles(handle, files, signal): Promise<void> {
      const session = await sessionFor(handle, signal);
      const executable: string[] = [];
      for await (const file of files) {
        if (!file.path.startsWith('/') || file.path.split('/').some((part) => part === '..'))
          throw new SandboxAdapterRefusal('an upload path must be absolute');
        if (file.bytes.byteLength > capabilities.maxUploadBytes)
          throw new SandboxAdapterRefusal('a file above the upload limit');
        const query = new URLSearchParams({ path: file.path, username: user });
        const { url, headers } = envd(session, `/files?${query}`);
        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/octet-stream' },
            body: file.bytes,
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          });
        } catch (error) {
          throw new SandboxTransportError(
            scrub(`envd did not answer an upload: ${describeError(error)}`, [session.token]),
          );
        }
        await readLimited(response, MiB).catch(() => new Uint8Array());
        if (response.status !== 200)
          throw new SandboxTransportError(`envd refused an upload with ${response.status}`);
        if ((file.mode & 0o111) !== 0) executable.push(file.path);
      }
      for (let index = 0; index < executable.length; index += 200) {
        const batch = executable.slice(index, index + 200);
        const quoted = batch.map((item) => `'${item.replaceAll("'", `'\\''`)}'`).join(' ');
        const result = await runShort(session, ['-c', `chmod 0755 -- ${quoted}`], false, signal);
        if (result.exitCode !== 0)
          throw new SandboxTransportError('the executable bit could not be set');
      }
    },

    async listFiles(handle, root, signal): Promise<FileEntry[]> {
      const session = await sessionFor(handle, signal);
      const base = root.replace(/\/+$/, '');
      if (!base.startsWith('/')) throw new SandboxAdapterRefusal('a listing root must be absolute');
      const answer = await unary<{ entries?: EnvdEntry[] }>(
        session,
        'filesystem.Filesystem/ListDir',
        { path: base, depth: LIST_DEPTH },
        signal,
      );
      return (answer.entries ?? []).map((entry) => {
        const full = entry.path ?? '';
        if (!full.startsWith(`${base}/`))
          throw new SandboxAdapterRefusal(
            `envd listed a path outside ${base}: ${JSON.stringify(full)}`,
          );
        const relative = full.slice(base.length + 1);
        const symlink = entry.type === 'FILE_TYPE_SYMLINK' || entry.symlinkTarget !== undefined;
        const directory = entry.type === 'FILE_TYPE_DIRECTORY';
        if (!symlink && !directory && entry.type !== 'FILE_TYPE_FILE')
          throw new SandboxAdapterRefusal(`envd listed an entry of unknown type: ${relative}`);
        if (directory && relative.split('/').length >= LIST_DEPTH)
          throw new SandboxAdapterRefusal('the tree is deeper than the adapter lists');
        return {
          path: relative,
          size: Number(entry.size ?? 0),
          mode: (entry.mode ?? 0) & 0o777,
          symlink,
          directory,
        };
      });
    },

    async getFile(handle, path, maxBytes, signal): Promise<Uint8Array> {
      const session = await sessionFor(handle, signal);
      const query = new URLSearchParams({ path, username: user });
      const { url, headers } = envd(session, `/files?${query}`);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers,
          signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
      } catch (error) {
        throw new SandboxTransportError(
          scrub(`envd did not answer a download: ${describeError(error)}`, [session.token]),
        );
      }
      if (response.status === 404) {
        await response.body?.cancel().catch(() => {});
        throw new SandboxFileNotFound(`no such file: ${path}`);
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        throw new SandboxTransportError(`envd refused a download with ${response.status}`);
      }
      return readPrefix(response, maxBytes);
    },

    async pause(handle, signal): Promise<{ resumeRef: string }> {
      const id = sandboxId(handle);
      await rest('POST', `/sandboxes/${id}/pause`, { memory: true }, [204, 409], signal);
      sessions.delete(id);
      return { resumeRef: id };
    },

    async resume(resumeRef, signal): Promise<SandboxHandle> {
      const id = sandboxId(resumeRef);
      const { json } = await rest(
        'POST',
        `/sandboxes/${id}/connect`,
        { timeout: options.resumeTimeoutSeconds ?? 900 },
        [200, 201],
        signal,
      );
      remember(json as Record<string, unknown>);
      return { providerSandboxId: id, imageDigest: null, region: null };
    },

    async destroy(handle, signal): Promise<void> {
      const id = sandboxId(handle);
      await rest('DELETE', `/sandboxes/${id}`, undefined, [204, 404], signal);
      sessions.delete(id);
    },

    async inspect(handle, signal): Promise<'running' | 'paused' | 'gone'> {
      const id = sandboxId(handle);
      const { status, json } = await rest('GET', `/sandboxes/${id}`, undefined, [200, 404], signal);
      if (status === 404) return 'gone';
      const state = (json as { state?: unknown }).state;
      if (state === 'running' || state === 'paused') return state;
      throw new SandboxTransportError('E2B reported a sandbox state this adapter does not know');
    },

    async reconcile(project, live, signal): Promise<string[]> {
      if (!PLAIN.test(project)) throw new SandboxAdapterRefusal('the project label is not plain');
      const filter = new URLSearchParams({ 'melete.owner': 'v1', 'melete.project': project });
      const destroyed: string[] = [];
      let next: string | null = null;
      for (let page = 0; page < 100; page += 1) {
        const query = `metadata=${encodeURIComponent(filter.toString())}&state=running,paused&limit=100${
          next ? `&nextToken=${encodeURIComponent(next)}` : ''
        }`;
        const { json, headers } = await rest(
          'GET',
          `/v2/sandboxes?${query}`,
          undefined,
          [200],
          signal,
        );
        const listed = Array.isArray(json)
          ? (json as { sandboxID?: unknown; metadata?: unknown }[])
          : [];
        for (const sandbox of listed) {
          const id = typeof sandbox.sandboxID === 'string' ? sandbox.sandboxID : '';
          const metadata = (sandbox.metadata ?? {}) as Record<string, string>;
          // The server's filter is a convenience; ownership is decided here.
          if (!SANDBOX_ID.test(id) || metadata['melete.owner'] !== 'v1') continue;
          if (metadata['melete.project'] !== project) continue;
          const session = metadata['melete.session'];
          if (live.has(id) || (session !== undefined && live.has(session))) continue;
          await provider.destroy(
            { providerSandboxId: id, imageDigest: null, region: null },
            signal,
          );
          destroyed.push(id);
        }
        next = headers.get('x-next-token');
        if (!next) break;
      }
      return destroyed;
    },
  };
  return provider;
}
