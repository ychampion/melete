/**
 * The seam between Melete and a remote sandbox provider.
 *
 * The broker owns every sandbox: it creates it with the egress policy the owner
 * chose, holds the provider credential, and keeps the lease. An adapter behind
 * this interface only translates those decisions into one provider's API. It
 * never decides a policy, never reads its own credential from the environment,
 * and never widens what the service asked for; where it cannot honour a request
 * it refuses.
 */

export type EgressPolicy =
  | { kind: 'deny_all' }
  | { kind: 'domain_allowlist'; domains: readonly string[] }
  | { kind: 'cidr_allowlist'; cidrs: readonly string[] }
  | { kind: 'open' };

export type EgressKind = EgressPolicy['kind'];

/** Static per adapter. The service refuses what this cannot honour; it never degrades. */
export type SandboxCapabilities = {
  readonly adapter: string;
  readonly isolation: 'microvm' | 'gvisor' | 'vm' | 'container' | 'unknown';
  readonly egress: readonly EgressKind[];
  readonly persistence: readonly ('none' | 'pause' | 'snapshot')[];
  readonly maxLifetimeSeconds: number;
  readonly maxIdleSeconds: number | null;
  readonly streaming: boolean;
  readonly reattach: 'process_handle' | 'marker_only';
  readonly ports: 'authenticated' | 'public' | 'none';
  readonly image: 'registry' | 'template' | 'both';
  readonly billing: 'per_second' | 'per_minute' | 'per_hour';
  readonly regions: readonly string[];
  readonly maxUploadBytes: number;
};

export type SandboxSpec = {
  image: string;
  egress: EgressPolicy;
  region: string | null;
  lifetimeSeconds: number;
  idleSeconds: number | null;
  /** Always `/work`. */
  workdir: string;
  /** melete.owner, melete.project, and the space, job, attempt and session the sandbox serves. */
  labels: Readonly<Record<string, string>>;
  /** A fixed allow-list of names; never a credential. */
  env: Readonly<Record<string, string>>;
  cpu?: number;
  memoryMb?: number;
  diskMb?: number;
};

export type SandboxHandle = {
  readonly providerSandboxId: string;
  readonly imageDigest: string | null;
  readonly region: string | null;
};

/** `argv` is already marker-wrapped by the service; `marker` is carried for reattach. */
export type ExecSpec = {
  /** The action id. */
  readonly marker: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  /** The most exec-channel output the adapter keeps in `ExecOutcome.output`. */
  readonly maxOutputBytes: number;
  readonly stdin?: Uint8Array;
};

/**
 * What the exec channel observed. For a marker-wrapped command the command's
 * own output goes to the marker directory, so `output` here is only what the
 * wrapper itself wrote; the service reads the command's output from the file.
 * `durationMs` is 0 when the adapter did not watch the command run.
 */
export type ExecOutcome = {
  state: 'exited' | 'killed' | 'lost';
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  output: Uint8Array;
  totalBytes: number;
  captureLimited: boolean;
};

/**
 * One entry below a listed root. `path` is relative to that root and uses `/`.
 * `mode` carries permission bits only. Anything that is neither a regular file,
 * a directory nor a symbolic link is not representable, and an adapter that
 * meets one refuses the listing rather than leaving it out.
 */
export type FileEntry = {
  path: string;
  size: number;
  mode: number;
  symlink: boolean;
  directory: boolean;
};

export type StreamSpec = {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
};

export type DuplexStream = {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
};

export interface SandboxProvider {
  readonly capabilities: SandboxCapabilities;
  create(spec: SandboxSpec, signal: AbortSignal): Promise<SandboxHandle>;
  connect(handle: SandboxHandle, signal: AbortSignal): Promise<void>;
  exec(handle: SandboxHandle, spec: ExecSpec, signal: AbortSignal): Promise<ExecOutcome>;
  /**
   * Null when the marker was never written: the command provably did not start.
   * A marker without an exit record is `state: 'lost'`; an exit record is
   * `state: 'exited'` with its code. Output is not included: the service reads it.
   */
  reattach(handle: SandboxHandle, marker: string, signal: AbortSignal): Promise<ExecOutcome | null>;
  putFiles(
    handle: SandboxHandle,
    files: AsyncIterable<{ path: string; bytes: Uint8Array; mode: number }>,
    signal: AbortSignal,
  ): Promise<void>;
  listFiles(handle: SandboxHandle, root: string, signal: AbortSignal): Promise<FileEntry[]>;
  /** At most `maxBytes` bytes from the start of the file. Throws `SandboxFileNotFound`. */
  getFile(
    handle: SandboxHandle,
    path: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
  pause?(h: SandboxHandle, s: AbortSignal): Promise<{ resumeRef: string }>;
  resume?(resumeRef: string, s: AbortSignal): Promise<SandboxHandle>;
  snapshot?(h: SandboxHandle, s: AbortSignal): Promise<{ snapshotRef: string }>;
  /** Idempotent: a sandbox that is already gone is destroyed. */
  destroy(handle: SandboxHandle, signal: AbortSignal): Promise<void>;
  /** Asks the provider; `gone` is an authoritative answer, never a guess from a failed call. */
  inspect(handle: SandboxHandle, signal: AbortSignal): Promise<'running' | 'paused' | 'gone'>;
  /**
   * Destroy this installation's sandboxes that the service no longer owns.
   * `live` holds provider sandbox ids and session ids; a sandbox whose id or
   * `melete.session` label is in it is kept. A sandbox without this project's
   * `melete.owner` and `melete.project` labels is never touched.
   */
  reconcile(project: string, live: ReadonlySet<string>, signal: AbortSignal): Promise<string[]>;
  openStream?(h: SandboxHandle, spec: StreamSpec, s: AbortSignal): Promise<DuplexStream>;
}

/**
 * The provider may or may not have acted: the request left, and no answer
 * came back. Callers decide what happened by asking again, never by retrying.
 */
export class SandboxTransportError extends Error {
  override readonly name = 'SandboxTransportError';
}

export class SandboxFileNotFound extends Error {
  override readonly name = 'SandboxFileNotFound';
}

/** An adapter met a request or a provider answer it will not act on. */
export class SandboxAdapterRefusal extends Error {
  override readonly name = 'SandboxAdapterRefusal';
}
