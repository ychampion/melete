import { afterEach, describe, expect, test } from 'bun:test';
import { attachThroughCells } from '../connectors/mcp-stdio-docker.ts';
import { DockerError, DockerSocketApi } from '../runtime/docker.ts';
import { startCellsServer } from './server.ts';

const KEY = 'k'.repeat(64);
const SERVER = 'a'.repeat(64);
const servers: Array<ReturnType<typeof startCellsServer>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** An engine that answers inspections and records every other call it is passed. */
function start() {
  const passed: string[] = [];
  const engine = async (path: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    if (path === '/_ping' || path === '/version') return Response.json({ ApiVersion: '1.48' });
    if (path.endsWith(`/containers/${SERVER}/json`))
      return Response.json({
        Id: SERVER,
        Config: {
          Env: ['DATABASE_PASSWORD=not-for-the-api'],
          Labels: {
            'com.melete.mcp-launcher': 'v1',
            'com.melete.project': 'melete',
          },
        },
      });
    if (path.endsWith('/containers/postgres/json'))
      return Response.json({
        Id: 'postgres',
        Config: {
          Env: ['POSTGRES_PASSWORD=x'],
          Labels: { 'com.docker.compose.service': 'postgres' },
        },
        Mounts: [{ Source: '/var/lib/docker/volumes/melete_pgdata/_data' }],
        NetworkSettings: { Networks: { melete_database: { IPAddress: '172.20.0.2' } } },
        HostConfig: { NetworkMode: 'melete_database' },
      });
    if (/\/containers\/[^/]+\/json$/.test(path) || /\/images\//.test(path))
      return new Response('{}', { status: 404 });
    passed.push(`${method} ${path}`);
    return new Response(null, { status: 204 });
  };
  const server = startCellsServer({
    socket: '/unused.sock',
    key: KEY,
    hostname: '127.0.0.1',
    port: 0,
    project: 'melete',
    runtimeImage: 'melete-runtime:local',
    mcpImages: [],
    workVolume: 'melete_work',
    engine,
    attach: async () => {
      let listener: ((bytes: Uint8Array) => void) | undefined;
      return {
        write: (bytes) =>
          listener?.(
            new TextEncoder().encode(`echo:${new TextDecoder().decode(bytes as Uint8Array)}`),
          ),
        onData: (next) => {
          listener = next;
        },
        onClose: () => {},
        destroy: () => {},
      };
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, passed };
}

describe('the cell service', () => {
  test('answers only a caller with its key', async () => {
    const { url, passed } = start();
    const anonymous = new DockerSocketApi({ url, key: 'x'.repeat(64) });
    await expect(anonymous.request('POST', '/containers/x/start')).rejects.toMatchObject({
      status: 401,
    });
    expect(passed).toEqual([]);
    expect(await new DockerSocketApi({ url, key: KEY }).version()).toEqual({ ApiVersion: '1.48' });
  });

  test('refuses a container request outside the profiles before the engine sees it', async () => {
    const { url, passed } = start();
    const api = new DockerSocketApi({ url, key: KEY });
    const error = await api
      .request('POST', '/containers/create?name=anything', {
        Image: 'alpine',
        HostConfig: { Privileged: true, Binds: ['/:/host'], NetworkMode: 'host' },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DockerError);
    expect((error as DockerError).status).toBe(403);
    expect(passed).toEqual([]);
  });

  test("passes back a container's inspection without its environment", async () => {
    const { url } = start();
    const found = (await new DockerSocketApi({ url, key: KEY }).request(
      'GET',
      `/containers/${SERVER}/json`,
    )) as { Config: Record<string, unknown> };
    expect(found.Config.Env).toBeUndefined();
    expect(found.Config.Labels).toBeDefined();
  });

  test("passes back another service's inspection with its labels and state only", async () => {
    const { url } = start();
    const found = (await new DockerSocketApi({ url, key: KEY }).request(
      'GET',
      '/containers/postgres/json',
    )) as Record<string, unknown>;
    expect(found).toEqual({
      Id: 'postgres',
      Config: { Labels: { 'com.docker.compose.service': 'postgres' } },
    });
  });

  test('forwards the re-serialized body it judged, not the bytes it was sent', async () => {
    const forwarded: Array<{ path: string; body: string }> = [];
    const engine = async (path: string, init: RequestInit) => {
      if (path === '/_ping' || path === '/version') return Response.json({ ApiVersion: '1.48' });
      if (/\/(containers|images)\/[^/]+\/json$/.test(path))
        return new Response('{}', { status: 404 });
      forwarded.push({ path, body: init.body ? String(init.body) : '' });
      return Response.json({ Name: 'ok' });
    };
    const server = startCellsServer({
      socket: '/unused.sock',
      key: KEY,
      hostname: '127.0.0.1',
      port: 0,
      project: 'melete',
      runtimeImage: 'melete-runtime:local',
      mcpImages: [],
      workVolume: 'melete_work',
      engine,
    });
    servers.push(server);
    const labels = { 'com.melete.mcp-launcher': 'v1', 'com.melete.project': 'melete' };
    const parsed = { Name: 'melete-mcp-conn_abc-data', Labels: labels };
    // Hand-crafted bytes: non-canonical spacing the engine must never decode itself.
    const raw = `{"Name" :  "melete-mcp-conn_abc-data" ,  "Labels": ${JSON.stringify(labels)}}`;
    const response = await fetch(`http://127.0.0.1:${server.port}/docker/v1.48/volumes/create`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: raw,
    });
    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    // The engine receives exactly the object the policy judged, re-serialized.
    expect(forwarded[0]?.body).toBe(JSON.stringify(parsed));
    expect(forwarded[0]?.body).not.toBe(raw);
  });

  test("carries a server's attached streams both ways, for a server's container only", async () => {
    const { url } = start();
    const stream = await attachThroughCells({ url, key: KEY }, SERVER);
    const heard = new Promise<string>((resolve) =>
      stream.onData((bytes) => resolve(new TextDecoder().decode(bytes))),
    );
    stream.write('ping');
    expect(await heard).toBe('echo:ping');
    stream.destroy();
    await expect(attachThroughCells({ url, key: KEY }, 'b'.repeat(64))).rejects.toThrow();
    await expect(attachThroughCells({ url, key: 'x'.repeat(64) }, SERVER)).rejects.toThrow();
  });
});
