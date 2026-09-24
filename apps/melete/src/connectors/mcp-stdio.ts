/**
 * Stdio MCP servers a space owner installs from a package or an image.
 *
 * The server never runs as a child of the service. A `StdioLauncher` starts it
 * somewhere isolated and hands back only its standard input and output; the
 * local container backend is in `mcp-stdio-docker.ts`, and a remote sandbox can
 * be another backend behind the same seam. Everything else is shared with
 * HTTP servers: the owner's policy decides the tools, and every call goes
 * through the broker's admission, approval and receipt path.
 *
 * A server is started for the first call that is authorized, stopped once it
 * has been idle for a while, and restarted on the next call. A server that
 * keeps crashing is left stopped until its owner tests the connection again.
 */
import {
  type ConnectorHealth,
  type McpStdioLaunch,
  mcpStdioLaunch,
  pluginEntry,
  pluginInstallation,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { ConnectorFaultError } from './faults.ts';
import {
  type McpServerConfig,
  type McpToolDefinition,
  mcpServerConfig,
  mcpToolDefinition,
  openMcpWorker,
} from './mcp.ts';
import { mcpConnector } from './mcp-connector.ts';
import { type McpTransport, openLineMcpTransport, type StdioChannel } from './mcp-transport.ts';
import type { SealedSecretStore } from './secrets.ts';
import type { Connector } from './types.ts';

/** What a backend is asked to run: the owner's launch and the variables sealed for it. */
export type StdioLaunchSpec = {
  connectionId: string;
  spaceId: string;
  launch: McpStdioLaunch;
  /** Opened from the sealed store for this start alone and given only to the server. */
  env: Readonly<Record<string, string>>;
};

/**
 * Starts a stdio MCP server away from the service and connects to its
 * standard input and output. A backend refuses any launch it cannot isolate
 * as asked; it never runs one with less.
 */
export interface StdioLauncher {
  readonly backend: string;
  /** Null when this backend can honour the launch as written; otherwise the reason it cannot. */
  refuses(launch: McpStdioLaunch): string | null;
  /**
   * Start the server. A channel that has already ended calls a close listener
   * as soon as one is registered.
   */
  start(spec: StdioLaunchSpec, signal: AbortSignal): Promise<StdioChannel>;
  /** Remove everything the connection owns, its kept data included. */
  destroy(connectionId: string): Promise<void>;
  /** True when the deployment runs as many servers as it allows; a start would be refused. */
  full?(): boolean;
  /** Remove what earlier service processes left running; `keep` names connections whose data stays. */
  reconcile(keep: ReadonlySet<string>): Promise<void>;
  close(): Promise<void>;
}

/** The deployment is running as many servers as it allows; nothing is wrong with this one. */
export class StdioCapacityError extends Error {
  constructor() {
    super('The service is running as many plugin servers as it allows.');
  }
}

export type StdioLifecycleOptions = {
  /** How long a server may sit unused before it is stopped. */
  idleMs?: number;
  /** How long a start, image pull and package download included, may take. */
  startTimeoutMs?: number;
  /** Crashes within `crashWindowMs` after which the server is left stopped. */
  maxCrashes?: number;
  crashWindowMs?: number;
  /** A single request's limit once the server is running. */
  requestTimeoutMs?: number;
  now?: () => number;
};

export const STDIO_LIFECYCLE_DEFAULTS = {
  idleMs: 10 * 60_000,
  startTimeoutMs: 5 * 60_000,
  maxCrashes: 3,
  crashWindowMs: 10 * 60_000,
  requestTimeoutMs: 30_000,
} as const;

/** The only reasons a stdio call is refused before it reaches the server. */
export const STDIO_REFUSALS = {
  crashLoop: 'The MCP server stopped repeatedly, so it is left stopped until its owner tests it.',
  start: 'The MCP server could not be started.',
  busy: 'Too many plugins are running right now. Try again in a little while.',
} as const;

type State = 'stopped' | 'running' | 'crash_loop' | 'closed';

/** One connection's server: started on demand, stopped when idle, and not restarted in a loop. */
export class StdioServer {
  private state: State = 'stopped';
  private crashes: number[] = [];
  /** Every crash ever counted, so one failed start is not counted twice. */
  private crashTotal = 0;
  private channel?: StdioChannel;
  private idle?: ReturnType<typeof setTimeout>;
  private inflight = 0;
  private starting?: Promise<void>;
  /** The last start was refused for want of room, not because this server failed. */
  private busy = false;
  private readonly limits: Required<Omit<StdioLifecycleOptions, 'now'>>;
  private readonly now: () => number;

  constructor(
    private readonly spec: Omit<StdioLaunchSpec, 'env'>,
    private readonly launcher: StdioLauncher,
    /** Current row authority and sealed variables, read again before every start. */
    private readonly authority: () => Promise<{ env: Record<string, string> } | null>,
    options: StdioLifecycleOptions = {},
  ) {
    const { now, ...limits } = options;
    this.limits = { ...STDIO_LIFECYCLE_DEFAULTS, ...limits };
    this.now = now ?? Date.now;
  }

  get status(): State {
    return this.state;
  }

  private current(): State {
    return this.state;
  }

  /** The worker's transport factory: one start, under the connection's current authority. */
  async open(): Promise<McpTransport> {
    if (this.state === 'closed') throw new Error('MCP server is closed');
    if (this.state === 'crash_loop') throw new Error(STDIO_REFUSALS.crashLoop);
    const granted = await this.authority();
    if (!granted)
      throw new ConnectorFaultError({
        kind: 'revoked_credential',
        detail: 'MCP connection is no longer installed',
      });
    if (this.launcher.full?.()) {
      this.busy = true;
      throw new Error(STDIO_REFUSALS.busy);
    }
    let channel: StdioChannel;
    try {
      channel = await this.launcher.start(
        { ...this.spec, env: granted.env },
        AbortSignal.timeout(this.limits.startTimeoutMs),
      );
    } catch (error) {
      if (error instanceof StdioCapacityError) this.busy = true;
      throw error;
    }
    let requested = false;
    const watched: StdioChannel = {
      write: (text) => channel.write(text),
      onData: (listener) => channel.onData(listener),
      onClose: (listener) =>
        channel.onClose(() => {
          // Only an end nobody asked for is a crash: not an idle stop, a
          // shutdown, or the transport giving up on a request.
          if (!requested && this.channel === watched) this.crashed();
          if (this.channel === watched) {
            this.channel = undefined;
            if (this.state === 'running') this.state = 'stopped';
          }
          listener();
        }),
      close: async () => {
        requested = true;
        if (this.channel === watched) this.channel = undefined;
        await channel.close();
      },
    };
    // The state can change while the launcher works.
    if (this.current() === 'closed') {
      await watched.close();
      throw new Error('MCP server is closed');
    }
    this.channel = watched;
    this.state = 'running';
    return openLineMcpTransport(watched, { timeoutMs: this.limits.requestTimeoutMs });
  }

  /**
   * Bring the server up for a call that is already authorized. `reopen` is the
   * worker's reconnect, which starts a server and checks its catalog is still
   * the pinned one.
   */
  async ready(reopen: () => Promise<void>): Promise<string | undefined> {
    this.inflight += 1;
    this.holdOpen();
    if (this.state === 'crash_loop') return STDIO_REFUSALS.crashLoop;
    if (this.state === 'running' && this.channel) return undefined;
    const before = this.crashTotal;
    this.busy = false;
    this.starting ??= reopen()
      .catch((error: unknown) => {
        // A start that never reached a working session counts against the budget too,
        // once, whether or not the server's own exit was already counted. A deployment
        // with no room left is not this server's failure.
        if (this.current() !== 'closed' && this.crashTotal === before && !this.busy) this.crashed();
        throw error;
      })
      .finally(() => {
        this.starting = undefined;
      });
    try {
      await this.starting;
      return undefined;
    } catch {
      if (this.busy) return STDIO_REFUSALS.busy;
      return this.current() === 'crash_loop' ? STDIO_REFUSALS.crashLoop : STDIO_REFUSALS.start;
    }
  }

  /** A call ended; the idle clock starts once nothing else is running. */
  done(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    if (this.inflight === 0) this.armIdle();
  }

  /**
   * The owner's test. It is the one thing that clears a crash loop, because a
   * person asked for another try; then it starts the server if it is stopped.
   */
  async check(
    reopen: () => Promise<void>,
    ping: () => Promise<ConnectorHealth>,
  ): Promise<ConnectorHealth> {
    if (this.state === 'crash_loop') {
      this.crashes = [];
      this.state = 'stopped';
    }
    const refused = await this.ready(reopen);
    try {
      if (refused)
        return { status: 'failing', detail: refused, checked_at: new Date().toISOString() };
      return await ping();
    } finally {
      this.done();
    }
  }

  /** Stop without counting it as a crash; the next call starts the server again. */
  async stop(): Promise<void> {
    clearTimeout(this.idle);
    const channel = this.channel;
    if (this.state === 'running') this.state = 'stopped';
    await channel?.close();
  }

  /** Final: no start is possible afterwards. */
  async close(): Promise<void> {
    this.state = 'closed';
    clearTimeout(this.idle);
    await this.starting?.catch(() => {});
    await this.channel?.close();
  }

  private crashed() {
    this.crashTotal += 1;
    const now = this.now();
    this.crashes = [...this.crashes.filter((at) => now - at < this.limits.crashWindowMs), now];
    if (this.crashes.length >= this.limits.maxCrashes && this.state !== 'closed') {
      this.state = 'crash_loop';
      void this.channel?.close();
    }
  }

  private holdOpen() {
    clearTimeout(this.idle);
    this.idle = undefined;
  }

  private armIdle() {
    this.holdOpen();
    if (this.state !== 'running') return;
    this.idle = setTimeout(() => {
      if (this.inflight === 0) void this.stop().catch(() => {});
    }, this.limits.idleMs);
    this.idle.unref?.();
  }
}

/**
 * What a stdio connection row keeps: the policy with its launch, the catalog
 * recorded at installation, and, for a plugin, which catalog entry and version
 * it came from.
 */
export const storedStdioConnection = z.object({
  server: mcpServerConfig,
  tools: z.array(mcpToolDefinition).max(256).optional(),
  plugin: z
    .object({
      id: z.string(),
      version: z.string(),
      values: z.record(z.string(), z.string()).default({}),
    })
    .optional(),
});

/**
 * A stored installation's connector. A plugin whose catalog entry now pins
 * another version is moved to it here: the new version is built from the
 * person's recorded choices, started once to record its catalog, and if it
 * will not start the plugin stays on the version it had. An upgrade never
 * widens where a plugin may reach: the new destinations are cut to the ones
 * the installed version already had. The tools, their grants and the sealed
 * variables stay as they were installed.
 */
export async function openStoredStdioConnector(
  row: { id: string; spaceId: string; configuration: Record<string, unknown> | null },
  sql: Sql,
  secrets: SealedSecretStore,
  launcher: StdioLauncher,
  lifecycle: StdioLifecycleOptions = {},
): Promise<Connector> {
  const stored = storedStdioConnection.parse(row.configuration);
  const binding = { connectionId: row.id, spaceId: row.spaceId };
  const entry = stored.plugin ? pluginEntry(stored.plugin.id) : undefined;
  const upgrade =
    entry &&
    stored.plugin &&
    entry.version !== stored.plugin.version &&
    stored.server.endpoint.transport === 'container'
      ? pluginInstallation(entry, {
          ...Object.fromEntries(
            entry.fields
              .filter((field) => !field.secret && stored.plugin?.values[field.name] !== undefined)
              .map((field) => [field.name, stored.plugin?.values[field.name] ?? '']),
          ),
          // Secret values stay sealed and are not needed to build the launch.
          ...Object.fromEntries(
            entry.fields.filter((field) => field.secret).map((field) => [field.name, 'sealed']),
          ),
        })
      : undefined;
  if (entry && upgrade?.ok && stored.plugin && stored.server.endpoint.transport === 'container') {
    const kept = stored.server.endpoint.launch;
    const allowed = new Set(kept.egress);
    const server = mcpServerConfig.parse({
      ...stored.server,
      endpoint: {
        transport: 'container',
        launch: {
          runner: upgrade.config.runner,
          source: upgrade.config.source,
          ...(upgrade.config.command ? { command: upgrade.config.command } : {}),
          args: upgrade.config.args,
          egress: upgrade.config.egress.filter((site) => allowed.has(site)),
          secret_env_names: kept.secret_env_names,
        },
      },
    });
    const { tools: _recorded, ...rest } = row.configuration ?? {};
    const moved = {
      ...rest,
      server,
      plugin: { ...stored.plugin, id: entry.id, version: entry.version },
    };
    const before = JSON.stringify(row.configuration);
    const [changed] =
      await sql`update connection set configuration = ${JSON.stringify(moved)}::jsonb
      where id = ${row.id} and configuration = ${before}::jsonb returning id`;
    if (changed) {
      try {
        return await openStdioMcpConnector(server, binding, sql, secrets, launcher, lifecycle);
      } catch {
        await sql`update connection set configuration = ${before}::jsonb
          where id = ${row.id} and configuration = ${JSON.stringify(moved)}::jsonb`;
      }
    }
  }
  return openStdioMcpConnector(stored.server, binding, sql, secrets, launcher, {
    ...lifecycle,
    pinned: stored.tools,
  });
}

const sealedEnvironment = z.record(z.string(), z.string());

/**
 * The connector for one stdio installation. The first open of a new
 * installation starts the server once, so the owner sees its tools, and
 * records their definitions; after that the service starts with the recorded
 * catalog and runs nothing until a call needs the server.
 */
export async function openStdioMcpConnector(
  input: McpServerConfig,
  binding: { connectionId: string; spaceId: string },
  sql: Sql,
  secrets: SealedSecretStore,
  launcher: StdioLauncher,
  options: StdioLifecycleOptions & { pinned?: McpToolDefinition[] } = {},
): Promise<Connector> {
  const config = mcpServerConfig.parse(input);
  if (config.endpoint.transport !== 'container')
    throw new Error('A stdio MCP connector needs a container endpoint');
  const launch = mcpStdioLaunch.parse(config.endpoint.launch);
  const refusal = launcher.refuses(launch);
  if (refusal) throw new Error(refusal);
  const server = new StdioServer(
    { ...binding, launch },
    launcher,
    async () => {
      const [row] = await sql`select status, secret_ref from connection
        where id = ${binding.connectionId} and space_id = ${binding.spaceId} and provider = 'mcp'`;
      if (!row || row.status === 'revoked') return null;
      if (!launch.secret_env_names.length) return { env: {} };
      if (!row.secret_ref) return null;
      const env = await secrets.withSecret(row.secret_ref, binding.spaceId, async (value) =>
        sealedEnvironment.parse(JSON.parse(value)),
      );
      // The sealed box must hold exactly the variables the row names, no more and no fewer.
      const names = Object.keys(env).sort();
      if (names.join('\n') !== [...launch.secret_env_names].sort().join('\n')) return null;
      return { env };
    },
    options,
  );
  const worker = await openMcpWorker(config, binding, {
    transportFactory: () => server.open(),
    pinned: options.pinned,
  });
  if (!options.pinned) {
    // The catalog the owner saw is the one every later start must reproduce.
    await sql`update connection
      set configuration = configuration || ${JSON.stringify({ tools: worker.definitions })}::jsonb
      where id = ${binding.connectionId} and provider = 'mcp' and not (configuration ? 'tools')`;
    server.done();
  }
  const reopen = () => worker.reconnect();
  const connector = mcpConnector(worker, binding, sql, undefined, {
    ready: () => server.ready(reopen),
    done: () => server.done(),
  });
  return {
    ...connector,
    manifest: {
      ...connector.manifest,
      name: 'Owner-installed MCP server',
      description:
        'A stdio MCP server in its own container, with owner-declared effects and scopes',
    },
    health: () => server.check(reopen, () => worker.health()),
    async close() {
      await server.close();
      await worker.close();
    },
    async retire() {
      await server.close();
      await worker.close();
      await launcher.destroy(binding.connectionId);
    },
  };
}
