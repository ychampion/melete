/**
 * The companion's connection to Melete. It only ever connects out: it waits
 * for work with a long poll, does what policy.ts allows, and posts the answer.
 * Nothing on this computer listens for the service.
 *
 * Every request and its outcome is printed and appended to the activity log
 * in the configuration folder, so the person can see what ran.
 */
import { appendFile } from 'node:fs/promises';
import { hostname, platform } from 'node:os';
import {
  type Capabilities,
  configChangedAt,
  type DeviceConfig,
  type Folder,
  logPath,
  readConfig,
  writeConfig,
} from './config.ts';
import { Refusal } from './policy.ts';
import { runTool, type ToolContext } from './tools.ts';

export const VERSION = '0.1.0-pre';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type DeviceRequest = {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  deadline: number;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const devicePlatform = () =>
  platform() === 'win32'
    ? 'windows'
    : platform() === 'darwin'
      ? 'macos'
      : platform() === 'linux'
        ? 'linux'
        : 'other';

export const defaultName = () => hostname().slice(0, 80) || 'My computer';

async function call<T>(
  fetcher: Fetch,
  url: string,
  init: RequestInit & { token?: string },
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  const response = await fetcher(url, { ...init, headers });
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  if (!response.ok)
    throw new ApiError(
      response.status,
      body?.error?.message ?? `Melete answered ${response.status}`,
    );
  return body as T;
}

/**
 * The API base behind the address the person typed. The web app serves the
 * API under `/api`; a bare API answers `/health` itself.
 */
export async function discoverApi(address: string, fetcher: Fetch = fetch): Promise<string> {
  const base = address.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('The address starts with http:// or https://');
  for (const candidate of [`${base}/api`, base]) {
    try {
      const response = await fetcher(`${candidate}/health`);
      const body = (await response.json().catch(() => null)) as { version?: unknown } | null;
      if (response.ok && body && typeof body.version === 'string') return candidate;
    } catch {
      // Try the next shape.
    }
  }
  throw new Error(`Melete did not answer at ${base}`);
}

export async function pair(
  input: {
    address: string;
    code: string;
    name: string;
    capabilities: Capabilities;
    folders: Folder[];
  },
  options: { fetch?: Fetch; configDir?: string } = {},
): Promise<DeviceConfig> {
  const fetcher = options.fetch ?? fetch;
  const api = await discoverApi(input.address, fetcher);
  const paired = await call<{ device_id: string; token: string; name: string }>(
    fetcher,
    `${api}/device/pair`,
    {
      method: 'POST',
      body: JSON.stringify({
        code: input.code,
        name: input.name,
        platform: devicePlatform(),
        companion_version: VERSION,
        capabilities: input.capabilities,
        folders: input.folders,
      }),
    },
  );
  const config: DeviceConfig = {
    api,
    device_id: paired.device_id,
    token: paired.token,
    name: paired.name,
    capabilities: input.capabilities,
    folders: input.folders,
  };
  await writeConfig(config, options.configDir);
  return config;
}

const describe = (request: DeviceRequest): string => {
  const args = request.arguments;
  const text =
    typeof args.command === 'string'
      ? args.command
      : typeof args.path === 'string'
        ? args.path
        : typeof args.url === 'string'
          ? args.url
          : '';
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
};

export type AgentOptions = {
  configDir?: string;
  fetch?: Fetch;
  /** Replaces the printed log, e.g. in tests. */
  print?: (line: string) => void;
  /** Passed to the tools; tests replace the programs that open pages and capture the screen. */
  tools?: Pick<ToolContext, 'launch' | 'captureScreen'>;
  pollTimeoutMs?: number;
};

export class DeviceAgent {
  private stopped = false;
  private controller = new AbortController();
  private config: DeviceConfig;
  private changedAt = 0;
  private readonly done = new Map<string, Record<string, unknown>>();
  private readonly fetcher: Fetch;
  private readonly print: (line: string) => void;

  constructor(
    config: DeviceConfig,
    private readonly options: AgentOptions = {},
  ) {
    this.config = config;
    this.fetcher = options.fetch ?? fetch;
    this.print = options.print ?? ((line) => process.stdout.write(`${line}\n`));
  }

  private async log(line: string) {
    const stamped = `${new Date().toISOString()}  ${line}`;
    this.print(stamped);
    await appendFile(logPath(this.options.configDir), `${stamped}\n`, { mode: 0o600 }).catch(
      () => {},
    );
  }

  /** Tell Melete what this computer allows now. */
  async hello() {
    await call(this.fetcher, `${this.config.api}/device/hello`, {
      method: 'POST',
      token: this.config.token,
      body: JSON.stringify({
        companion_version: VERSION,
        capabilities: this.config.capabilities,
        folders: this.config.folders,
      }),
    });
    this.changedAt = await configChangedAt(this.options.configDir);
  }

  /** Settings made on this computer in another window take effect at the next poll. */
  private async reloadIfChanged() {
    const changed = await configChangedAt(this.options.configDir);
    if (changed === this.changedAt) return;
    const fresh = await readConfig(this.options.configDir);
    if (!fresh || fresh.token !== this.config.token) {
      this.stop();
      return;
    }
    this.config = fresh;
    await this.hello();
    await this.log('Settings on this computer changed; Melete was told.');
  }

  stop() {
    this.stopped = true;
    this.controller.abort();
  }

  /** Handle one request: refuse it, or do it, and post the answer. */
  async handle(request: DeviceRequest) {
    if (request.deadline < Date.now()) return;
    let body: Record<string, unknown>;
    const cached = this.done.get(request.id);
    if (cached) body = cached;
    else {
      await this.log(`→ ${request.tool} ${describe(request)}`);
      try {
        const result = await runTool(request.tool, request.arguments, {
          capabilities: this.config.capabilities,
          folders: this.config.folders,
          ...this.options.tools,
        });
        body = { ok: true, result };
        const exit =
          request.tool === 'run'
            ? result.timed_out
              ? ' (stopped at its time limit)'
              : ` (exit ${String(result.exit_code)})`
            : '';
        await this.log(`✓ ${request.tool}${exit}`);
      } catch (error) {
        const refusal =
          error instanceof Refusal
            ? error
            : new Refusal('failed', error instanceof Error ? error.message : 'It failed.');
        body = { ok: false, error: { code: refusal.code, message: refusal.message.slice(0, 500) } };
        await this.log(`✗ ${request.tool}: ${refusal.message}`);
      }
      // An answer lost on the way is sent again rather than the work being redone.
      this.done.set(request.id, body);
      if (this.done.size > 200) this.done.delete(this.done.keys().next().value as string);
    }
    await call(
      this.fetcher,
      `${this.config.api}/device/requests/${encodeURIComponent(request.id)}/result`,
      {
        method: 'POST',
        token: this.config.token,
        body: JSON.stringify(body),
      },
    ).catch((error) => this.log(`Could not send the answer: ${(error as Error).message}`));
  }

  /**
   * Poll until stopped or revoked. Resolves with `revoked` when Melete no
   * longer accepts this computer's token.
   */
  async run(): Promise<'stopped' | 'revoked'> {
    let backoff = 1_000;
    let greeted = false;
    await this.log(
      `Connected as "${this.config.name}". Allowed here: ${
        Object.entries(this.config.capabilities)
          .filter(([, on]) => on)
          .map(([name]) => name)
          .join(', ') || 'nothing'
      }. Folders: ${this.config.folders.map((f) => `${f.name} (${f.path})`).join(', ') || 'none'}.`,
    );
    while (!this.stopped) {
      try {
        if (!greeted) {
          await this.hello();
          greeted = true;
        } else await this.reloadIfChanged();
        const signal = AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(this.options.pollTimeoutMs ?? 40_000),
        ]);
        const { requests } = await call<{ requests: DeviceRequest[] }>(
          this.fetcher,
          `${this.config.api}/device/requests`,
          { method: 'GET', token: this.config.token, signal },
        );
        if (backoff > 1_000) await this.log('Connected again.');
        backoff = 1_000;
        for (const request of requests) void this.handle(request);
      } catch (error) {
        if (this.stopped) break;
        if (error instanceof ApiError && error.status === 401) {
          await this.log(
            'Melete no longer accepts this computer: it was disconnected in Settings.',
          );
          return 'revoked';
        }
        if ((error as Error).name === 'TimeoutError') continue;
        await this.log(`Cannot reach Melete (${(error as Error).message}); trying again.`);
        // Say what this computer allows again once Melete answers.
        greeted = false;
        await new Promise((resolve) => setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
    return 'stopped';
  }
}
