/**
 * Daytona sandboxes behind the `SandboxProvider` seam.
 *
 * Two surfaces, both over plain `fetch` and both authenticated with the same
 * API key as a bearer token:
 *
 * - The control plane is Daytona's REST API (`https://app.daytona.io/api`,
 *   OpenAPI `libs/api-client-go/api/openapi.yaml` in daytonaio/daytona at
 *   v0.190.0): create, get, list by label, stop, start and delete.
 * - Commands and files go to the toolbox inside each sandbox through Daytona's
 *   toolbox proxy (`{toolboxProxyUrl}/{sandboxId}/…`, OpenAPI
 *   `libs/toolbox-api-client-go/api/openapi.yaml`): `/process/execute`,
 *   `/files/upload` and `/files/download`.
 *
 * The proxy is handed the key, so it is fixed by configuration: a sandbox whose
 * record names any other toolbox proxy is refused and destroyed, never called.
 * The key is lent one call at a time through `credential`, never read from the
 * environment, and scrubbed from every error message.
 *
 * Egress is decided at creation: deny-all is `networkBlockAll`, a CIDR
 * allow-list is `networkAllowList` (IPv4 only, at most ten ranges), and open is
 * neither. What Daytona records is read back before the sandbox is used, and a
 * record that differs from the request is refused. Daytona's domain allow-list
 * is not offered: like E2B's and Modal's it matches on the name a client
 * presents rather than on where a connection goes.
 *
 * Every command runs through `/process/execute`, which starts the sandbox's
 * shell in its own process group and, at the request's timeout, kills that
 * group and answers 408. The admitted command starts through a small launcher
 * that enters the working directory — exiting 112, before any marker exists,
 * when it cannot — and removes the `DAYTONA_*` variables the daemon passes on.
 * Which variables to remove is learnt once per sandbox, by a separate command
 * sent before the first admitted one. Files are listed with `find`, because the
 * toolbox's own listing follows symbolic links and leaves out broken ones.
 *
 * A workspace persists by stopping the sandbox and starting it again: its files
 * are kept, its processes are not. Daytona archives a stopped sandbox by itself
 * after its auto-archive interval and restores it on start. A stopped sandbox
 * nobody starts again is deleted by Daytona after `stoppedRetentionMinutes`.
 */
import { createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { LABEL_OWNER, LABEL_PROJECT, LABEL_SESSION, ownedLabels } from '../manifest.ts';
import { reattachByMarker, shellQuote } from '../marker.ts';
import {
  type EgressPolicy,
  type ExecOutcome,
  type ExecSpec,
  type FileEntry,
  SandboxAdapterRefusal,
  type SandboxCapabilities,
  SandboxFileNotFound,
  SandboxGone,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxSpec,
  SandboxStartRefused,
  SandboxTransportError,
} from '../types.ts';
import { readLimited, readPrefix } from './connect.ts';

export type DaytonaCredential = <T>(use: (apiKey: string) => Promise<T>) => Promise<T>;
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type DaytonaOptions = {
  /** Lends the API key for one call; for example a sealed-secret reader. */
  credential: DaytonaCredential;
  fetch?: Fetch;
  apiUrl?: string;
  /** The only toolbox proxy the key is ever sent to. */
  toolboxProxyUrl?: string;
  /**
   * How long Daytona keeps a stopped sandbox before deleting it, in minutes.
   * Keep it at least as long as the workspace retention.
   */
  stoppedRetentionMinutes?: number;
  /** How often a sandbox that is changing state is asked again. */
  pollMs?: number;
};

const MiB = 1024 * 1024;
export const DAYTONA_API_URL = 'https://app.daytona.io/api';
export const DAYTONA_TOOLBOX_PROXY_URL = 'https://proxy.app.daytona.io/toolbox';
/** Daytona's documented limit on `networkAllowList`. */
export const DAYTONA_MAX_CIDRS = 10;
const REQUEST_TIMEOUT_MS = 60_000;
/** How long a sandbox may take to start, stop or be created. */
const STATE_TIMEOUT_MS = 180_000;
/** Past the command's own timeout, how long the answer may take before it is lost. */
const KILL_GRACE_MS = 30_000;
/** How long an adapter command may run. */
const ADAPTER_COMMAND_SECONDS = 120;
const SANDBOX_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PLAIN = /^[A-Za-z0-9._-]{1,128}$/;
const STDIN_ROOT = '/var/tmp/.melete-stdin';
/**
 * Enter the working directory or report, as the wrapper's setup failure does,
 * that nothing ran; then run the command without the provider's variables,
 * reading stdin from a file when one was uploaded.
 */
const LAUNCHER =
  'cd "$1" 2>/dev/null || exit 112; shift; f="$1"; shift; [ "$f" = - ] && exec env "$@"; exec env "$@" < "$f"';
const LIST = '[ -d "$1" ] || exit 3; cd "$1" && exec find . -mindepth 1 -printf "%y %s %m %P\\0"';
/**
 * Create the workspace, as root through `sudo` where the sandbox user cannot,
 * and list the environment so the provider's variables can be left out.
 */
const PREPARE =
  '{ mkdir -p -- "$1" 2>/dev/null || sudo -n sh -c \'mkdir -p -- "$1" && chown "$SUDO_UID:$SUDO_GID" -- "$1"\' melete "$1"; } && [ -d "$1" ] && exec env';
const ENVIRONMENT = 'exec env';
const PROVIDER_VARIABLE = /^(DAYTONA_[A-Za-z0-9_]*)=/;
const NOT_FOUND_EXIT = 3;
const LISTING_LIMIT = 16 * MiB;
/** Thirty days: Daytona's auto-delete interval is in minutes. */
const DEFAULT_STOPPED_RETENTION_MINUTES = 30 * 24 * 60;

export function daytonaCapabilities(): SandboxCapabilities {
  return {
    adapter: 'daytona',
    // Daytona's documentation does not name the isolation technology, and the
    // runner it published runs each sandbox as a container.
    isolation: 'container',
    egress: ['deny_all', 'cidr_allowlist', 'open'],
    persistence: ['none', 'pause'],
    // Daytona stops a sandbox after `autoStopInterval` minutes without
    // activity; the service's lease bounds the rest.
    maxLifetimeSeconds: 86_400,
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

/**
 * Why Daytona cannot hold this egress policy, or null. Its allow-list takes
 * IPv4 ranges only, and at most ten of them.
 */
export function daytonaEgressRefusal(egress: EgressPolicy): string | null {
  if (egress.kind === 'domain_allowlist')
    return 'the daytona adapter does not offer a domain allow-list';
  if (egress.kind !== 'cidr_allowlist') return null;
  if (egress.cidrs.length > DAYTONA_MAX_CIDRS)
    return `Daytona takes at most ${DAYTONA_MAX_CIDRS} ranges in an allow-list`;
  if (egress.cidrs.some((cidr) => !isIPv4(cidr.split('/')[0] ?? '')))
    return 'Daytona takes IPv4 ranges only in an allow-list';
  return null;
}

export class DaytonaApiError extends Error {
  override readonly name = 'DaytonaApiError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type SandboxRecord = {
  id?: unknown;
  state?: unknown;
  errorReason?: unknown;
  labels?: unknown;
  networkBlockAll?: unknown;
  networkAllowList?: unknown;
  domainAllowList?: unknown;
  toolboxProxyUrl?: unknown;
};

const scrub = (text: string, secrets: readonly (string | undefined)[]) =>
  secrets.reduce<string>(
    (current, secret) => (secret ? current.split(secret).join('[redacted]') : current),
    text,
  );

const describeError = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const trimSlash = (value: string) => value.replace(/\/+$/, '');

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', stop, { once: true });
  });

/** The names of the provider's variables in an `env` listing; a value never leaves here. */
export function daytonaVariables(listing: string): string[] {
  const names = new Set<string>();
  for (const line of listing.split('\n')) {
    const name = PROVIDER_VARIABLE.exec(line)?.[1];
    if (name) names.add(name);
  }
  return [...names].sort();
}

/**
 * One file as `multipart/form-data`, with a boundary drawn from its content so
 * the same upload is the same request every time.
 */
function multipart(name: string, bytes: Uint8Array): { body: Uint8Array; type: string } {
  const boundary = `melete-${createHash('sha256').update(name).update(bytes).digest('hex').slice(0, 32)}`;
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name.replaceAll('"', '')}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.byteLength + bytes.byteLength + tail.byteLength);
  body.set(head, 0);
  body.set(bytes, head.byteLength);
  body.set(tail, head.byteLength + bytes.byteLength);
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}

/** What `/sandbox` is sent for an egress policy. */
function networkFor(egress: EgressPolicy): Record<string, unknown> {
  switch (egress.kind) {
    case 'deny_all':
      return { networkBlockAll: true };
    case 'cidr_allowlist':
      return { networkBlockAll: false, networkAllowList: egress.cidrs.join(',') };
    case 'open':
      return { networkBlockAll: false };
    case 'domain_allowlist':
      throw new SandboxAdapterRefusal('the daytona adapter does not offer a domain allow-list');
  }
}

/** Whether Daytona's record holds exactly the policy that was asked for. */
function recordedEgress(record: SandboxRecord, egress: EgressPolicy): boolean {
  const blockAll = record.networkBlockAll === true;
  const allowList = typeof record.networkAllowList === 'string' ? record.networkAllowList : '';
  const domains = typeof record.domainAllowList === 'string' ? record.domainAllowList : '';
  if (domains.trim() !== '') return false;
  switch (egress.kind) {
    case 'deny_all':
      return blockAll;
    case 'cidr_allowlist':
      return (
        !blockAll &&
        allowList
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
          .join(',') === egress.cidrs.join(',')
      );
    case 'open':
      return !blockAll && allowList.trim() === '';
    case 'domain_allowlist':
      return false;
  }
}

type Toolbox = { id: string; hidden: Promise<string[]> | null };

export function createDaytonaProvider(options: DaytonaOptions): SandboxProvider {
  const fetchImpl: Fetch = options.fetch ?? fetch;
  const apiUrl = trimSlash(options.apiUrl ?? DAYTONA_API_URL);
  const proxyUrl = trimSlash(options.toolboxProxyUrl ?? DAYTONA_TOOLBOX_PROXY_URL);
  const pollMs = options.pollMs ?? 500;
  const retention = options.stoppedRetentionMinutes ?? DEFAULT_STOPPED_RETENTION_MINUTES;
  if (!Number.isSafeInteger(retention) || retention <= 0)
    throw new Error('a stopped sandbox is kept a positive whole number of minutes');
  if (!/^https:\/\//.test(proxyUrl)) throw new Error('the toolbox proxy must be an https URL');
  const capabilities = daytonaCapabilities();
  const toolboxes = new Map<string, Toolbox>();

  const sandboxId = (handle: SandboxHandle | string) => {
    const id = typeof handle === 'string' ? handle : handle.providerSandboxId;
    if (!SANDBOX_ID.test(id)) throw new SandboxAdapterRefusal('not a Daytona sandbox id');
    return id;
  };

  /** One authenticated request; the key is in hand only while it runs. */
  function send(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: Uint8Array | string },
    signal: AbortSignal,
    what: string,
  ): Promise<Response> {
    return options.credential(async (key) => {
      try {
        return await fetchImpl(url, {
          method: init.method,
          headers: { Authorization: `Bearer ${key}`, ...init.headers },
          ...(init.body === undefined ? {} : { body: init.body }),
          signal,
        });
      } catch (error) {
        throw new SandboxTransportError(
          scrub(`Daytona did not answer ${what}: ${describeError(error)}`, [key]),
        );
      }
    });
  }

  async function errorText(response: Response): Promise<string> {
    const text = new TextDecoder().decode(
      await readLimited(response, MiB).catch(() => new Uint8Array()),
    );
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === 'string') return parsed.message.slice(0, 300);
      if (Array.isArray(parsed.message)) return parsed.message.join('; ').slice(0, 300);
    } catch {}
    return text.slice(0, 300);
  }

  async function rest(
    method: string,
    path: string,
    body: unknown,
    accept: readonly number[],
    signal: AbortSignal,
  ): Promise<{ status: number; json: unknown }> {
    return options.credential(async (key) => {
      const what = `${method} ${path.split('?')[0]}`;
      const response = await send(
        `${apiUrl}${path}`,
        {
          method,
          headers: {
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        what,
      );
      if (!accept.includes(response.status))
        throw new DaytonaApiError(
          response.status,
          scrub(`Daytona answered ${response.status} to ${what}: ${await errorText(response)}`, [
            key,
          ]),
        );
      let text: string;
      try {
        text = new TextDecoder().decode(await readLimited(response, 4 * MiB));
      } catch (error) {
        throw new SandboxTransportError(
          scrub(`the Daytona answer could not be read: ${describeError(error)}`, [key]),
        );
      }
      if (!text) return { status: response.status, json: null };
      try {
        return { status: response.status, json: JSON.parse(text) as unknown };
      } catch {
        throw new SandboxTransportError('Daytona answered with something that is not JSON');
      }
    });
  }

  const getRecord = async (id: string, signal: AbortSignal): Promise<SandboxRecord | null> => {
    const { status, json } = await rest('GET', `/sandbox/${id}`, undefined, [200, 404], signal);
    return status === 404 ? null : ((json ?? {}) as SandboxRecord);
  };

  /** The key goes to the configured proxy or nowhere. */
  function checkProxy(record: SandboxRecord): void {
    if (
      typeof record.toolboxProxyUrl === 'string' &&
      trimSlash(record.toolboxProxyUrl) !== proxyUrl
    )
      throw new SandboxAdapterRefusal(
        `the sandbox names a toolbox proxy other than ${proxyUrl}; the key is not sent there`,
      );
  }

  /** Ask until the sandbox reaches one of `wanted`, refusing on an error state. */
  async function settle(
    id: string,
    wanted: readonly string[],
    passing: readonly string[],
    signal: AbortSignal,
  ): Promise<SandboxRecord> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(STATE_TIMEOUT_MS)]);
    for (;;) {
      const record = await getRecord(id, deadline);
      if (!record) throw new SandboxGone(`Daytona has no sandbox ${id}`);
      const state = String(record.state);
      if (wanted.includes(state)) return record;
      if (state === 'destroyed' || state === 'destroying')
        throw new SandboxGone(`Daytona has destroyed sandbox ${id}`);
      if (!passing.includes(state))
        throw new SandboxTransportError(
          `the sandbox is ${state}${typeof record.errorReason === 'string' ? `: ${record.errorReason.slice(0, 200)}` : ''}`,
        );
      try {
        await delay(pollMs, deadline);
      } catch {
        throw new SandboxTransportError(`the sandbox did not become ${wanted.join(' or ')}`);
      }
    }
  }

  function toolboxFor(id: string): Toolbox {
    let toolbox = toolboxes.get(id);
    if (!toolbox) {
      toolbox = { id, hidden: null };
      toolboxes.set(id, toolbox);
    }
    return toolbox;
  }

  async function toolboxOf(handle: SandboxHandle, signal: AbortSignal): Promise<Toolbox> {
    const id = sandboxId(handle);
    const known = toolboxes.get(id);
    if (known) return known;
    const record = await getRecord(id, signal);
    if (!record) throw new SandboxGone(`Daytona has no sandbox ${id}`);
    if (record.state !== 'started') throw new SandboxAdapterRefusal('the sandbox is not running');
    checkProxy(record);
    return toolboxFor(id);
  }

  type Executed = { status: number; exitCode: number | null; result: string; elapsedMs: number };

  /** One `/process/execute`. Throws only when no answer came back. */
  async function execute(
    toolbox: Toolbox,
    command: string,
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<Executed> {
    const started = performance.now();
    return options.credential(async (key) => {
      const response = await send(
        `${proxyUrl}/${toolbox.id}/process/execute`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ command, timeout: timeoutSeconds }),
        },
        AbortSignal.any([signal, AbortSignal.timeout(timeoutSeconds * 1000 + KILL_GRACE_MS)]),
        'a command',
      );
      let text: string;
      try {
        text = new TextDecoder().decode(await readLimited(response, LISTING_LIMIT + MiB));
      } catch (error) {
        throw new SandboxTransportError(
          scrub(`the command's answer was cut: ${describeError(error)}`, [key]),
        );
      }
      const elapsedMs = Math.round(performance.now() - started);
      if (response.status !== 200) {
        let detail = text.slice(0, 300);
        try {
          const parsed = JSON.parse(text) as { message?: unknown };
          if (typeof parsed.message === 'string') detail = parsed.message.slice(0, 300);
        } catch {}
        return { status: response.status, exitCode: null, result: scrub(detail, [key]), elapsedMs };
      }
      let parsed: { exitCode?: unknown; result?: unknown };
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        throw new SandboxTransportError('the toolbox answered a command with something not JSON');
      }
      return {
        status: 200,
        exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : 0,
        result: typeof parsed.result === 'string' ? parsed.result : '',
        elapsedMs,
      };
    });
  }

  /** Run an adapter command to the end; not an admitted command, never marker-wrapped. */
  async function run(
    toolbox: Toolbox,
    script: string,
    args: readonly string[],
    signal: AbortSignal,
  ): Promise<{ exitCode: number | null; result: string }> {
    const command = ['exec', '/bin/sh', '-c', script, 'melete', ...args].map((word, index) =>
      index === 0 ? word : shellQuote(word),
    );
    const done = await execute(toolbox, command.join(' '), ADAPTER_COMMAND_SECONDS, signal);
    if (done.status !== 200)
      throw new SandboxTransportError(`the toolbox answered ${done.status}: ${done.result}`);
    return { exitCode: done.exitCode, result: done.result };
  }

  const variablesFrom = (listed: { exitCode: number | null; result: string }) => {
    if (listed.exitCode !== 0)
      throw new SandboxTransportError(`listing the environment exited ${listed.exitCode}`);
    return daytonaVariables(listed.result);
  };

  function hiddenVariables(toolbox: Toolbox, signal: AbortSignal): Promise<string[]> {
    if (!toolbox.hidden) {
      const pending = run(toolbox, ENVIRONMENT, [], signal).then(variablesFrom);
      toolbox.hidden = pending;
      pending.catch(() => {
        if (toolbox.hidden === pending) toolbox.hidden = null;
      });
    }
    return toolbox.hidden;
  }

  /** Check what Daytona recorded, wait for it to run, and prepare the workspace. */
  async function ready(
    id: string,
    spec: SandboxSpec,
    signal: AbortSignal,
    first: SandboxRecord | null,
  ): Promise<SandboxHandle> {
    if (first) {
      checkProxy(first);
      if (!recordedEgress(first, spec.egress))
        throw new SandboxAdapterRefusal(
          `Daytona recorded an egress policy other than ${spec.egress.kind}`,
        );
    }
    const record = await settle(
      id,
      ['started'],
      [
        'creating',
        'restoring',
        'starting',
        'pulling_snapshot',
        'pending_build',
        'building_snapshot',
      ],
      signal,
    );
    checkProxy(record);
    if (!recordedEgress(record, spec.egress))
      throw new SandboxAdapterRefusal(
        `Daytona recorded an egress policy other than ${spec.egress.kind}`,
      );
    const toolbox = toolboxFor(id);
    const prepared = await run(toolbox, PREPARE, [spec.workdir], signal);
    if (prepared.exitCode !== 0)
      throw new SandboxAdapterRefusal('the workspace could not be prepared');
    toolbox.hidden = Promise.resolve(variablesFrom(prepared));
    return { providerSandboxId: id, imageDigest: null, region: null };
  }

  const provider: SandboxProvider = {
    capabilities,

    async create(spec: SandboxSpec, signal: AbortSignal): Promise<SandboxHandle> {
      if (!capabilities.egress.includes(spec.egress.kind))
        throw new SandboxAdapterRefusal(`the daytona adapter cannot enforce ${spec.egress.kind}`);
      const refusal = daytonaEgressRefusal(spec.egress);
      if (refusal) throw new SandboxAdapterRefusal(refusal);
      if (spec.region !== null) throw new SandboxAdapterRefusal('Daytona placement is not offered');
      if (spec.idleSeconds !== null)
        throw new SandboxAdapterRefusal('Daytona idle timeouts are not offered');
      if (
        !Number.isInteger(spec.lifetimeSeconds) ||
        spec.lifetimeSeconds <= 0 ||
        spec.lifetimeSeconds > capabilities.maxLifetimeSeconds
      )
        throw new SandboxAdapterRefusal('the lifetime is outside what Daytona allows');
      if (spec.cpu !== undefined && !Number.isInteger(spec.cpu))
        throw new SandboxAdapterRefusal('Daytona allocates whole cores');
      if (spec.memoryMb !== undefined && spec.memoryMb % 1024 !== 0)
        throw new SandboxAdapterRefusal('Daytona allocates memory in whole GiB');
      if (spec.diskMb !== undefined && spec.diskMb % 1024 !== 0)
        throw new SandboxAdapterRefusal('Daytona allocates disk in whole GiB');
      for (const [key, value] of Object.entries(spec.labels))
        if (!PLAIN.test(key) || !PLAIN.test(value))
          throw new SandboxAdapterRefusal('a label is not plain enough to filter by');
      signal.throwIfAborted();
      // Not raced against the caller's signal alone: a create abandoned
      // mid-flight could still leave a sandbox that nothing knows to stop.
      const { json } = await rest(
        'POST',
        '/sandbox',
        {
          snapshot: spec.image,
          env: { ...spec.env },
          labels: { ...spec.labels },
          public: false,
          ...networkFor(spec.egress),
          ...(spec.cpu === undefined ? {} : { cpu: spec.cpu }),
          ...(spec.memoryMb === undefined ? {} : { memory: spec.memoryMb / 1024 }),
          ...(spec.diskMb === undefined ? {} : { disk: spec.diskMb / 1024 }),
          // Idle minutes, not a hard lifetime: the backstop for a service that
          // stopped renewing its lease.
          autoStopInterval: Math.max(1, Math.ceil(spec.lifetimeSeconds / 60)),
          // Never zero: that would delete the sandbox the moment it stops,
          // and a stopped sandbox is how a workspace is kept.
          autoDeleteInterval: retention,
        },
        [200, 201],
        signal,
      );
      const created = (json ?? {}) as SandboxRecord;
      const id = typeof created.id === 'string' ? created.id : '';
      if (!SANDBOX_ID.test(id))
        throw new SandboxTransportError('Daytona answered without a sandbox id');
      try {
        return await ready(id, spec, signal, created);
      } catch (error) {
        // A sandbox this adapter will not use is not left running.
        toolboxes.delete(id);
        await rest(
          'DELETE',
          `/sandbox/${id}`,
          undefined,
          [200, 404],
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ).catch(() => {});
        throw error;
      }
    },

    async connect(handle: SandboxHandle, signal: AbortSignal): Promise<void> {
      toolboxes.delete(sandboxId(handle));
      await toolboxOf(handle, signal);
    },

    async exec(handle: SandboxHandle, spec: ExecSpec, signal: AbortSignal): Promise<ExecOutcome> {
      if (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs <= 0)
        throw new SandboxAdapterRefusal('a command timeout must be a positive number of ms');
      if (!spec.cwd.startsWith('/'))
        throw new SandboxAdapterRefusal('a working directory must be absolute');
      if (spec.stdin && spec.stdin.byteLength > capabilities.maxUploadBytes)
        throw new SandboxAdapterRefusal('stdin above 8 MiB is refused');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(spec.marker))
        throw new SandboxAdapterRefusal('a marker must be an action id');
      let toolbox: Toolbox;
      let hide: string[];
      let stdinPath = '-';
      // Everything before the command is sent is provably not the command.
      try {
        toolbox = await toolboxOf(handle, signal);
        hide = await hiddenVariables(toolbox, signal);
        if (spec.stdin) {
          stdinPath = `${STDIN_ROOT}/${spec.marker}`;
          await upload(toolbox, stdinPath, spec.stdin, signal);
        }
      } catch (error) {
        if (error instanceof SandboxAdapterRefusal) throw error;
        throw new SandboxStartRefused(`the command was not sent: ${describeError(error)}`);
      }
      const seconds = Math.ceil(spec.timeoutMs / 1000);
      const words = [
        'melete-launch',
        spec.cwd,
        stdinPath,
        ...hide.flatMap((name) => ['-u', name]),
        ...spec.argv,
      ];
      const command = `exec /bin/sh -c ${shellQuote(LAUNCHER)} ${words.map(shellQuote).join(' ')}`;
      let done: Executed;
      try {
        done = await execute(toolbox, command, seconds, signal);
      } catch (error) {
        // The request left: the command may be running.
        throw new SandboxTransportError(
          `no answer to the command: ${describeError(error)}`,
          'unknown',
        );
      }
      if (done.status === 408 && done.elapsedMs >= seconds * 1000 - 50) {
        // The toolbox killed the process group at the deadline.
        return {
          started: 'yes',
          state: 'killed',
          exitCode: null,
          signal: 'SIGKILL',
          timedOut: true,
          durationMs: done.elapsedMs,
          output: new Uint8Array(),
          totalBytes: 0,
          captureLimited: false,
        };
      }
      if (done.status >= 400 && done.status < 500 && done.status !== 408)
        // The proxy or the toolbox turned the request away before the shell
        // started: an unknown sandbox, a bad key, a malformed body.
        throw new SandboxStartRefused(
          `the toolbox refused the command with ${done.status}: ${done.result}`,
        );
      if (done.status !== 200)
        throw new SandboxTransportError(
          `the toolbox answered ${done.status}, and the command may have run: ${done.result}`,
          'unknown',
        );
      if (done.exitCode === -1)
        // The toolbox's answer when its shell could not be started or waited
        // for; which of the two is not said, so the marker decides.
        return {
          started: 'unknown',
          state: 'lost',
          exitCode: null,
          signal: null,
          timedOut: false,
          durationMs: done.elapsedMs,
          output: new Uint8Array(),
          totalBytes: 0,
          captureLimited: false,
        };
      const bytes = new TextEncoder().encode(done.result);
      const output = bytes.slice(0, spec.maxOutputBytes);
      return {
        started: 'yes',
        state: 'exited',
        exitCode: done.exitCode,
        signal: null,
        timedOut: false,
        durationMs: done.elapsedMs,
        output,
        totalBytes: bytes.byteLength,
        captureLimited: bytes.byteLength > output.byteLength,
      };
    },

    reattach(handle: SandboxHandle, marker: string, signal: AbortSignal) {
      return reattachByMarker(provider, handle, marker, signal);
    },

    async putFiles(handle, files, signal): Promise<void> {
      const toolbox = await toolboxOf(handle, signal);
      const executable: string[] = [];
      for await (const file of files) {
        if (!file.path.startsWith('/') || file.path.split('/').some((part) => part === '..'))
          throw new SandboxAdapterRefusal('an upload path must be absolute');
        if (file.bytes.byteLength > capabilities.maxUploadBytes)
          throw new SandboxAdapterRefusal('a file above the upload limit');
        await upload(toolbox, file.path, file.bytes, signal);
        if ((file.mode & 0o111) !== 0) executable.push(file.path);
      }
      for (let index = 0; index < executable.length; index += 200) {
        const batch = executable.slice(index, index + 200);
        const done = await run(toolbox, 'exec chmod 0755 -- "$@"', batch, signal);
        if (done.exitCode !== 0)
          throw new SandboxTransportError('the executable bit could not be set');
      }
    },

    async listFiles(handle, root, signal): Promise<FileEntry[]> {
      const base = root.replace(/\/+$/, '') || '/';
      if (!base.startsWith('/')) throw new SandboxAdapterRefusal('a listing root must be absolute');
      const toolbox = await toolboxOf(handle, signal);
      const listed = await run(toolbox, LIST, [base], signal);
      if (listed.exitCode === NOT_FOUND_EXIT)
        throw new SandboxFileNotFound(`no such directory: ${root}`);
      if (listed.exitCode !== 0)
        throw new SandboxTransportError(`listing ${root} failed with exit ${listed.exitCode}`);
      if (listed.result.length > LISTING_LIMIT)
        throw new SandboxAdapterRefusal('the listing is larger than the adapter reads');
      // The toolbox answers in JSON, which replaces bytes that are not UTF-8.
      if (listed.result.includes('�'))
        throw new SandboxAdapterRefusal('the listing holds a name that is not UTF-8');
      return listed.result
        .split('\0')
        .filter(Boolean)
        .map((record) => {
          const match = /^([a-z]) (\d+) ([0-7]+) (.+)$/s.exec(record);
          if (!match) throw new SandboxAdapterRefusal('the listing could not be read');
          const [, type, size, mode, relative] = match as unknown as [
            string,
            string,
            string,
            string,
            string,
          ];
          if (type !== 'f' && type !== 'd' && type !== 'l')
            throw new SandboxAdapterRefusal(
              `the listing holds an entry of type ${type}: ${relative}`,
            );
          return {
            path: relative,
            size: type === 'f' ? Number(size) : 0,
            mode: Number.parseInt(mode, 8) & 0o777,
            symlink: type === 'l',
            directory: type === 'd',
          };
        });
    },

    async getFile(handle, path, maxBytes, signal): Promise<Uint8Array> {
      const toolbox = await toolboxOf(handle, signal);
      const query = new URLSearchParams({ path });
      const response = await send(
        `${proxyUrl}/${toolbox.id}/files/download?${query}`,
        { method: 'GET' },
        AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        'a download',
      );
      if (response.status === 404) {
        await response.body?.cancel().catch(() => {});
        throw new SandboxFileNotFound(`no such file: ${path}`);
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        throw new SandboxTransportError(`the toolbox refused a download with ${response.status}`);
      }
      return readPrefix(response, maxBytes);
    },

    async pause(handle, signal): Promise<{ resumeRef: string }> {
      const id = sandboxId(handle);
      const record = await getRecord(id, signal);
      if (!record || record.state === 'destroyed' || record.state === 'destroying')
        throw new SandboxGone(`Daytona has no sandbox ${id} to stop`);
      const kept = ['stopped', 'archiving', 'archived'];
      if (!kept.includes(String(record.state))) {
        try {
          await rest('POST', `/sandbox/${id}/stop`, undefined, [200, 201], signal);
        } catch (error) {
          if (error instanceof DaytonaApiError && error.status === 404)
            throw new SandboxGone(`Daytona has no sandbox ${id} to stop`);
          throw error;
        }
        await settle(id, kept, ['stopping', 'started'], signal);
      }
      toolboxes.delete(id);
      return { resumeRef: id };
    },

    async resume(resumeRef, spec, signal): Promise<SandboxHandle> {
      const id = sandboxId(resumeRef);
      const record = await getRecord(id, signal);
      if (!record || record.state === 'destroyed' || record.state === 'destroying')
        throw new SandboxGone(`Daytona has no sandbox ${id} to start`);
      if (record.state !== 'started') {
        try {
          await rest('POST', `/sandbox/${id}/start`, undefined, [200, 201], signal);
        } catch (error) {
          if (error instanceof DaytonaApiError && error.status === 404)
            throw new SandboxGone(`Daytona has no sandbox ${id} to start`);
          throw error;
        }
      }
      toolboxes.delete(id);
      // The policy is checked again: a running sandbox's egress can be changed
      // at Daytona, and a workspace comes back only under the one it was given.
      return ready(id, spec, signal, null);
    },

    async destroy(handle, signal): Promise<void> {
      const id = sandboxId(handle);
      await rest('DELETE', `/sandbox/${id}`, undefined, [200, 404], signal);
      toolboxes.delete(id);
    },

    async inspect(handle, signal): Promise<'running' | 'paused' | 'gone'> {
      const record = await getRecord(sandboxId(handle), signal);
      if (!record) return 'gone';
      switch (record.state) {
        case 'started':
          return 'running';
        case 'stopping':
        case 'stopped':
        case 'archiving':
        case 'archived':
          return 'paused';
        case 'destroying':
        case 'destroyed':
          return 'gone';
        default:
          throw new SandboxTransportError(
            `Daytona reported a sandbox state this adapter does not know: ${String(record.state)}`,
          );
      }
    },

    async reconcile(project, live, signal, connection): Promise<string[]> {
      if (!PLAIN.test(project)) throw new SandboxAdapterRefusal('the project label is not plain');
      const labels = JSON.stringify({ [LABEL_OWNER]: 'v1', [LABEL_PROJECT]: project });
      const destroyed: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 100; page += 1) {
        const query = new URLSearchParams({ labels, limit: '100' });
        if (cursor) query.set('cursor', cursor);
        const { json } = await rest('GET', `/sandbox?${query}`, undefined, [200], signal);
        const answer = (json ?? {}) as { items?: unknown; nextCursor?: unknown };
        const items = Array.isArray(answer.items) ? (answer.items as SandboxRecord[]) : [];
        for (const sandbox of items) {
          const id = typeof sandbox.id === 'string' ? sandbox.id : '';
          const sandboxLabels = (sandbox.labels ?? {}) as Record<string, string>;
          // The server's filter is a convenience; ownership is decided here.
          if (!SANDBOX_ID.test(id) || !ownedLabels(sandboxLabels, project, connection)) continue;
          if (sandbox.state === 'destroyed' || sandbox.state === 'destroying') continue;
          const session = sandboxLabels[LABEL_SESSION];
          if (live.has(id) || (session !== undefined && live.has(session))) continue;
          await provider.destroy(
            { providerSandboxId: id, imageDigest: null, region: null },
            signal,
          );
          destroyed.push(id);
        }
        cursor =
          typeof answer.nextCursor === 'string' && answer.nextCursor ? answer.nextCursor : null;
        if (!cursor) break;
      }
      return destroyed;
    },
  };

  async function upload(
    toolbox: Toolbox,
    path: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    const { body, type } = multipart(path.slice(path.lastIndexOf('/') + 1), bytes);
    const query = new URLSearchParams({ path });
    const response = await send(
      `${proxyUrl}/${toolbox.id}/files/upload?${query}`,
      { method: 'POST', headers: { 'Content-Type': type }, body },
      AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      'an upload',
    );
    await readLimited(response, MiB).catch(() => new Uint8Array());
    if (response.status !== 200)
      throw new SandboxTransportError(`the toolbox refused an upload with ${response.status}`);
  }

  return provider;
}
