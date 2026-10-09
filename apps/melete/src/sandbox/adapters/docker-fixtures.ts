/**
 * An engine in memory for the docker adapter's unit tests: it keeps the
 * containers, volumes and networks the adapter asks for, records every
 * request, and answers each exec from a handler the test supplies. The live
 * suite (docker.live.test.ts) runs the same adapter against a real engine.
 */
import { DockerError } from '../../runtime/docker.ts';
import type { DockerSandboxApi } from './docker.ts';

export type ExecAnswer = {
  stdout?: string | Uint8Array;
  stderr?: string;
  exitCode?: number | null;
  /** Split the output across frames of this size, to exercise reassembly. */
  chunk?: number;
  /** Fail the start request before any answer. */
  failStart?: boolean;
  /** Fail the stream after this many bytes. */
  breakAfter?: number;
};

export type FakeContainer = {
  name: string;
  body: Record<string, unknown>;
  running: boolean;
  networks: Record<string, string>;
  labels: Record<string, string>;
  /** The id of the image it was made from. */
  image: string;
  /** Execs the engine says still run in it. */
  execIds?: string[];
};

const encoder = new TextEncoder();

function frame(kind: 1 | 2, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  out[0] = kind;
  new DataView(out.buffer).setUint32(4, payload.byteLength);
  out.set(payload, 8);
  return out;
}

export class FakeDocker implements DockerSandboxApi {
  readonly calls: { method: string; path: string; body?: unknown }[] = [];
  readonly images = new Set(['melete-sandbox:test']);
  /** The id an image name stands for now; `sha256:image` for any name not set here. */
  readonly imageIds = new Map<string, string>();
  readonly containers = new Map<string, FakeContainer>();
  readonly volumes = new Map<string, Record<string, string>>();
  readonly networks = new Map<string, { labels: Record<string, string>; members: Set<string> }>();
  readonly archives: { container: string; path: string; tar: Uint8Array }[] = [];
  readonly execs = new Map<string, { container: string; cmd: string[]; exitCode: number | null }>();
  /** Answers each exec by its argv; the default answers nothing with exit 0. */
  onExec: (cmd: string[], container: string) => ExecAnswer = () => ({});
  /** Fail the next request to a path matching this, once, with this status. */
  failNext?: { match: RegExp; status: number };
  private next = 0;
  private address = 2;

  private fail(method: string, path: string, status: number): never {
    throw new DockerError(status, method as 'GET', path);
  }

  async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    this.calls.push({ method, path, body });
    if (this.failNext?.match.test(`${method} ${path}`)) {
      const { status } = this.failNext;
      this.failNext = undefined;
      this.fail(method, path, status);
    }
    const [route = '', query = ''] = path.split('?');
    if (method === 'GET' && route === '/version') return { ApiVersion: '1.48', Version: '28.0.0' };
    const image = /^\/images\/([^/]+)\/json$/.exec(route);
    if (image)
      return this.images.has(decodeURIComponent(image[1] ?? ''))
        ? { Id: this.imageIds.get(decodeURIComponent(image[1] ?? '')) ?? 'sha256:image' }
        : this.fail(method, path, 404);
    if (method === 'POST' && route === '/volumes/create') {
      const request = body as { Name: string; Labels: Record<string, string> };
      this.volumes.set(request.Name, request.Labels);
      return { Name: request.Name };
    }
    const volume = /^\/volumes\/([^/]+)$/.exec(route);
    if (volume && method === 'DELETE') {
      if (!this.volumes.delete(volume[1] ?? '')) this.fail(method, path, 404);
      return null;
    }
    if (method === 'GET' && route === '/volumes')
      return {
        Volumes: [...this.volumes].map(([Name, Labels]) => ({ Name, Labels })),
      };
    if (method === 'POST' && route === '/networks/create') {
      const request = body as { Name: string; Labels: Record<string, string> };
      this.networks.set(request.Name, { labels: request.Labels, members: new Set() });
      return { Id: request.Name };
    }
    if (method === 'GET' && route === '/networks')
      return [...this.networks].map(([Name, value]) => ({ Name, Labels: value.labels }));
    const networkRoute = /^\/networks\/([^/]+)(\/(connect|disconnect))?$/.exec(route);
    if (networkRoute) {
      const match = networkRoute;
      const network = this.networks.get(match[1] ?? '');
      if (!network) this.fail(method, path, 404);
      if (method === 'GET')
        return {
          Containers: Object.fromEntries([...network.members].map((id) => [`${id}ffff`, {}])),
        };
      if (method === 'DELETE') {
        this.networks.delete(match[1] ?? '');
        return null;
      }
      const container = (body as { Container: string }).Container;
      if (match[3] === 'connect') network.members.add(container);
      else network.members.delete(container);
      return null;
    }
    if (method === 'POST' && route === '/containers/create') {
      const name = new URLSearchParams(query).get('name') ?? '';
      const request = body as Record<string, unknown> & {
        Labels: Record<string, string>;
        HostConfig: { NetworkMode: string };
      };
      if (this.containers.has(name)) this.fail(method, path, 409);
      const networks: Record<string, string> = {};
      if (request.HostConfig.NetworkMode !== 'none')
        networks[request.HostConfig.NetworkMode] = `172.30.0.${this.address++}`;
      this.containers.set(name, {
        name,
        body: request,
        running: false,
        networks,
        labels: request.Labels,
        image: this.imageIds.get(String(request.Image)) ?? 'sha256:image',
      });
      return { Id: `${name}-id` };
    }
    if (method === 'GET' && route === '/containers/json') {
      const filters = JSON.parse(new URLSearchParams(query).get('filters') ?? '{}') as {
        label?: string[];
        status?: string[];
      };
      return [...this.containers.values()]
        .filter((container) =>
          (filters.label ?? []).every((pair) => {
            const [key = '', value] = pair.split('=');
            return container.labels[key] === value;
          }),
        )
        .filter(
          (container) =>
            !filters.status || (container.running && filters.status.includes('running')),
        )
        .map((container) => ({
          Id: `${container.name}-id`,
          Names: [`/${container.name}`],
          Labels: container.labels,
          State: container.running ? 'running' : 'exited',
        }));
    }
    const containerRoute = /^\/containers\/([^/]+)(\/[a-z]+)?$/.exec(route);
    if (containerRoute) {
      const match = containerRoute;
      const container = this.containers.get(match[1] ?? '');
      if (!container) this.fail(method, path, 404);
      const action = match[2];
      if (method === 'GET' && action === '/json')
        return {
          Name: `/${container.name}`,
          Image: container.image,
          ExecIDs: container.execIds?.length ? container.execIds : null,
          State: {
            Running: container.running,
            Paused: false,
            Status: container.running ? 'running' : 'exited',
          },
          Config: { Labels: container.labels },
          NetworkSettings: {
            Networks: Object.fromEntries(
              Object.entries(container.networks).map(([name, IPAddress]) => [name, { IPAddress }]),
            ),
          },
        };
      if (method === 'POST' && action === '/start') {
        if (container.running) this.fail(method, path, 304);
        container.running = true;
        return null;
      }
      if (method === 'POST' && action === '/stop') {
        if (!container.running) this.fail(method, path, 304);
        container.running = false;
        return null;
      }
      if (method === 'POST' && action === '/exec') {
        if (!container.running) this.fail(method, path, 409);
        const id = (this.next++).toString(16).padStart(64, '0');
        this.execs.set(id, {
          container: container.name,
          cmd: (body as { Cmd: string[] }).Cmd,
          exitCode: null,
        });
        return { Id: id };
      }
      if (method === 'DELETE' && !action) {
        this.containers.delete(container.name);
        return null;
      }
    }
    const execRoute = /^\/exec\/([a-f0-9]{64})\/json$/.exec(route);
    if (execRoute) {
      const match = execRoute;
      const exec = this.execs.get(match[1] ?? '');
      if (!exec) this.fail(method, path, 404);
      return { Running: false, ExitCode: exec.exitCode };
    }
    throw new Error(`the fake engine has no route for ${method} ${path}`);
  }

  async startExec(id: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const exec = this.execs.get(id);
    if (!exec) throw new DockerError(404, 'POST', `/exec/${id}/start`);
    const answer = this.onExec(exec.cmd, exec.container);
    if (answer.failStart) throw new Error('socket hang up');
    exec.exitCode = answer.exitCode === undefined ? 0 : answer.exitCode;
    const stdout =
      typeof answer.stdout === 'string'
        ? encoder.encode(answer.stdout)
        : (answer.stdout ?? new Uint8Array());
    const stderr = encoder.encode(answer.stderr ?? '');
    const parts: Uint8Array[] = [];
    const size = answer.chunk ?? Math.max(1, stdout.byteLength);
    for (let at = 0; at < stdout.byteLength; at += size)
      parts.push(frame(1, stdout.subarray(at, at + size)));
    if (stderr.byteLength) parts.push(frame(2, stderr));
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.byteLength;
    }
    const breakAfter = answer.breakAfter;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (signal.aborted) return controller.error(signal.reason);
        // Frames arrive split mid-header, as a socket may deliver them.
        const cut = breakAfter ?? bytes.byteLength;
        for (let offset = 0; offset < cut; offset += 5)
          controller.enqueue(bytes.slice(offset, Math.min(cut, offset + 5)));
        if (breakAfter !== undefined) controller.error(new Error('connection reset'));
        else controller.close();
      },
    });
  }

  async putArchive(container: string, path: string, tar: Uint8Array): Promise<void> {
    this.calls.push({ method: 'PUT', path: `/containers/${container}/archive?path=${path}` });
    if (!this.containers.has(container)) throw new DockerError(404, 'POST', '/containers/archive');
    this.archives.push({ container, path, tar });
  }
}

/** Reads back what `tarArchive` wrote: names (PAX included), types, owners, modes and bytes. */
export function readTar(tar: Uint8Array) {
  const decoder = new TextDecoder();
  const field = (block: Uint8Array, offset: number, width: number) =>
    decoder.decode(block.subarray(offset, offset + width)).replace(/\0.*$/s, '');
  const entries: {
    name: string;
    type: string;
    uid: number;
    gid: number;
    mode: number;
    bytes: Uint8Array;
  }[] = [];
  let at = 0;
  let longName: string | null = null;
  while (at + 512 <= tar.byteLength) {
    const block = tar.subarray(at, at + 512);
    if (block.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(block, 124, 12) || '0', 8);
    const type = field(block, 156, 1);
    const body = tar.subarray(at + 512, at + 512 + size);
    let sum = 0;
    for (let index = 0; index < 512; index += 1)
      sum += index >= 148 && index < 156 ? 32 : (block[index] as number);
    if (sum !== Number.parseInt(field(block, 148, 8).trim(), 8))
      throw new Error('bad tar checksum');
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const record = decoder.decode(body);
      const [length, rest] = [Number(record.split(' ')[0]), record.slice(record.indexOf(' ') + 1)];
      if (length !== body.byteLength) throw new Error('bad PAX record length');
      longName = rest.replace(/^path=/, '').replace(/\n$/, '');
      continue;
    }
    entries.push({
      name: longName ?? field(block, 0, 100),
      type,
      uid: Number.parseInt(field(block, 108, 8), 8),
      gid: Number.parseInt(field(block, 116, 8), 8),
      mode: Number.parseInt(field(block, 100, 8), 8),
      bytes: body.slice(),
    });
    longName = null;
  }
  return entries;
}
