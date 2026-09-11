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
    const value = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new BrowserFault(value.error ?? 'worker_unavailable');
    return value;
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
        fileURLToPath(new URL('./entry.ts', import.meta.url)),
      ],
      {
        cwd: spaceRoot,
        env: {
          ...browserWorkerEnvironment(process.env),
          MELETE_BROWSER_SPACE: spaceId,
          MELETE_BROWSER_ROOT: spaceRoot,
          MELETE_BROWSER_TOKEN: token,
          MELETE_BROWSER_IDLE_MS: String(this.options.idleMs ?? 300_000),
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
