import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserFault, type BrowserPolicy, type BrowserSession } from './sessions.ts';

export class BrowserWorkerClient {
  constructor(
    readonly url: string,
    private readonly token: string,
  ) {}
  async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.url), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // Empty or non-JSON refusals (including the body's 413 gate) never reached a commit.
      if (response.status >= 400 && response.status < 500)
        throw new BrowserFault(`worker_http_${response.status}`);
      throw new Error('Browser worker returned an invalid response');
    }
    if (response.status >= 500)
      throw new Error('Browser worker operation failed without a confirmed result');
    if (!response.ok)
      throw new BrowserFault(
        value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
          ? value.error
          : `worker_http_${response.status}`,
      );
    return value as T;
  }
  lease(jobId: string, policy: BrowserPolicy): Promise<BrowserSession> {
    return this.request('/lease', { job_id: jobId, policy });
  }
  takeover(sessionId: string): Promise<BrowserSession> {
    return this.request('/takeover', { session_id: sessionId });
  }
  handback(sessionId: string): Promise<BrowserSession> {
    return this.request('/handback', { session_id: sessionId });
  }
}

/** Only OS essentials cross the child boundary. Database, vault, provider and runtime secrets do not. */
export function browserWorkerEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const allowed = [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'LOCALAPPDATA',
    'PLAYWRIGHT_BROWSERS_PATH',
  ];
  return Object.fromEntries(
    allowed.flatMap((name) => (source[name] ? [[name, source[name] as string]] : [])),
  );
}

type WorkerHandle = { client: BrowserWorkerClient; close: () => Promise<void> };
export type BrowserWorkerEndpoint = { spaceId: string; url: string; token: string };

/** The service owns lifetime, and a failed child never silently inherits the service environment. */
export class BrowserWorkerPool {
  private workers = new Map<string, Promise<WorkerHandle>>();
  constructor(
    readonly options: {
      spacesRoot: string;
      idleMs?: number;
      endpoints?: BrowserWorkerEndpoint[];
      allowLocalProcess?: boolean;
      /** Tests supply their own entry that injects a fixed local fixture; never owner/model configuration. */
      workerEntry?: URL;
      /** Arguments for the trusted worker entry, including fixture-only configuration in tests. */
      workerArguments?: string[];
      headless?: boolean;
    },
  ) {}

  async get(spaceId: string): Promise<BrowserWorkerClient> {
    if (!/^sp_[A-Za-z0-9_-]+$/.test(spaceId)) throw new BrowserFault('invalid_space');
    let worker = this.workers.get(spaceId);
    if (!worker) {
      worker = this.start(spaceId);
      this.workers.set(spaceId, worker);
      worker.catch(() => this.workers.delete(spaceId));
    }
    return (await worker).client;
  }

  private async start(spaceId: string): Promise<WorkerHandle> {
    const endpoint = this.options.endpoints?.find((entry) => entry.spaceId === spaceId);
    if (endpoint) {
      const client = new BrowserWorkerClient(endpoint.url, endpoint.token);
      await client.request('/health');
      return {
        client,
        close: async () => {
          await client.request('/release', {});
        },
      };
    }
    if (!this.options.allowLocalProcess) throw new BrowserFault('isolated_worker_required');
    const spaceRoot = join(this.options.spacesRoot, spaceId);
    await mkdir(spaceRoot, { recursive: true });
    const token = randomBytes(32).toString('base64url');
    const child = Bun.spawn(
      [
        'node',
        '--experimental-transform-types',
        '--disable-warning=ExperimentalWarning',
        fileURLToPath(this.options.workerEntry ?? new URL('./entry.ts', import.meta.url)),
        ...(this.options.workerArguments ?? []),
      ],
      {
        cwd: spaceRoot,
        env: {
          ...browserWorkerEnvironment(process.env),
          MELETE_BROWSER_SPACE: spaceId,
          MELETE_BROWSER_ROOT: spaceRoot,
          MELETE_BROWSER_TOKEN: token,
          MELETE_BROWSER_IDLE_MS: String(this.options.idleMs ?? 300_000),
          MELETE_BROWSER_HEADLESS: String(this.options.headless ?? true),
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        windowsHide: true,
      },
    );
    try {
      const reader = child.stdout.getReader();
      const readiness = (async () => {
        let line = '';
        while (!line.includes('\n')) {
          const part = await reader.read();
          if (part.done) throw new BrowserFault('worker_start_failed');
          line += new TextDecoder().decode(part.value);
          if (line.length > 1024) throw new BrowserFault('invalid_worker_ready');
        }
        reader.releaseLock();
        const ready = JSON.parse(line.split('\n')[0] as string) as { port: number };
        if (!Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535)
          throw new BrowserFault('invalid_worker_ready');
        return ready.port;
      })();
      const port = await Promise.race([
        readiness,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new BrowserFault('worker_start_timeout')), 10_000);
          timer.unref();
        }),
      ]);
      const client = new BrowserWorkerClient(`http://127.0.0.1:${port}`, token);
      return {
        client,
        close: async () => {
          await client.request('/release', {}).catch(() => {});
          child.kill();
          await child.exited;
        },
      };
    } catch (error) {
      child.kill();
      await child.exited;
      throw error;
    }
  }

  async close() {
    const handles = await Promise.allSettled(this.workers.values());
    this.workers.clear();
    await Promise.all(
      handles.flatMap((handle) => (handle.status === 'fulfilled' ? [handle.value.close()] : [])),
    );
  }
}
