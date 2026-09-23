/**
 * Conformance 10: stdio MCP servers on a real Docker engine.
 *
 * It runs inside a container that has the Docker socket, as the service does
 * in its Compose stack, because a server with named destinations reaches them
 * through the proxy in the service's own container. CI starts it that way (see
 * `.github/workflows/ci.yml`); by hand:
 *
 *   docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD":/repo -w /repo \
 *     -e MELETE_CONFORMANCE_DOCKER=1 oven/bun:$(cat .bun-version) \
 *     bun test conformance/scenarios/10-stdio-mcp.test.ts --timeout=300000
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { type AddressInfo, createServer, type Server } from 'node:net';
import { type JsonObject, mcpStdioLaunch } from '@melete/contracts';
import {
  DockerStdioLauncher,
  DockerStdioSocket,
} from '../../apps/melete/src/connectors/mcp-stdio-docker.ts';
import {
  MCP_PROTOCOL_VERSION,
  type McpTransport,
  openLineMcpTransport,
} from '../../apps/melete/src/connectors/mcp-transport.ts';
import { DockerError } from '../../apps/melete/src/runtime/docker.ts';
import { dockerEnabled } from '../helpers/compose.ts';

const SOCKET = '/var/run/docker.sock';
const PROJECT = 'melete-conformance';
const TOKEN = 'conformance-sealed-value';
/** The probe runs as an image a person could install: its registry named and its content pinned. */
const PROBE_IMAGE =
  'docker.io/library/node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85';
/** A port on the service's container standing in for its authenticated broker. */
const BROKER_PORT = 8788;
/** Ports the service's container must not answer on: the API, Postgres, SSH, HTTP and Docker's. */
const CLOSED_PORTS = [22, 80, 443, 2375, 5432, 8787];

/** A small MCP server that reports what it can see and reach from inside its container. */
const PROBE = String.raw`
const fs=require('fs'),net=require('net'),os=require('os'),dns=require('dns');
const out=m=>process.stdout.write(JSON.stringify(m)+'\n');
const status=k=>(fs.readFileSync('/proc/self/status','utf8').match(new RegExp('^'+k+':\\s*(.*)$','m'))||[])[1];
const read=p=>{try{return fs.readFileSync(p,'utf8').trim()}catch{return null}};
const canWrite=p=>{try{fs.writeFileSync(p,'x');return true}catch{return false}};
const reach=(host,port)=>new Promise(r=>{const s=net.connect({host,port,timeout:3000});s.on('connect',()=>{s.destroy();r(true)});s.on('error',()=>r(false));s.on('timeout',()=>{s.destroy();r(false)})});
const resolves=name=>dns.promises.lookup(name).then(()=>true,()=>false);
const defaultRoute=()=>(read('/proc/net/route')||'').split('\n').slice(1).some(l=>l.split(/\s+/)[1]==='00000000');
const tunnel=target=>new Promise(r=>{const u=new URL(process.env.HTTPS_PROXY||'http://none:1');const s=net.connect({host:u.hostname,port:+u.port,timeout:8000});let t='';
s.on('connect',()=>s.write('CONNECT '+target+' HTTP/1.1\r\nHost: '+target+'\r\nProxy-Authorization: Basic '+Buffer.from(decodeURIComponent(u.username)+':'+decodeURIComponent(u.password)).toString('base64')+'\r\n\r\n'));
s.on('data',d=>{t+=d;if(t.includes('\r\n')){s.destroy();r(t.split('\r\n')[0])}});s.on('error',()=>r('error'));s.on('timeout',()=>{s.destroy();r('timeout')})});
const tools={
probe:async()=>({uid:process.getuid(),gid:process.getgid(),cap_eff:status('CapEff'),no_new_privs:status('NoNewPrivs'),seccomp:status('Seccomp'),root_write:canWrite('/probe'),data_write:canWrite('/data/home/probe'),docker_socket:fs.existsSync('/var/run/docker.sock'),interfaces:Object.keys(os.networkInterfaces()).sort(),public_tcp:await reach('1.1.1.1',443),external_dns:await resolves('example.com'),default_route:defaultRoute(),env:process.env,memory_max:read('/sys/fs/cgroup/memory.max'),pids_max:read('/sys/fs/cgroup/pids.max')}),
egress:async a=>({allowed:await tunnel(a.allowed),other:await tunnel(a.other),direct:await reach('1.1.1.1',443),external_dns:await resolves('example.com'),default_route:defaultRoute(),gateway:a.gateway?await reach(a.gateway,a.gatewayPort):null,service:Object.fromEntries(await Promise.all(a.ports.map(async p=>[p,await reach('melete-egress',p)])))}),
exit:async()=>{setTimeout(()=>process.exit(3),50);return{}}};
let buf='';process.stdin.on('data',async c=>{buf+=c;let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);const m=JSON.parse(line);if(m.id===undefined||!m.method)continue;let result;
if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}}};
else if(m.method==='tools/list')result={tools:Object.keys(tools).map(name=>({name,inputSchema:{type:'object'}}))};
else if(m.method==='ping')result={};
else if(m.method==='tools/call'){const v=await tools[m.params.name](m.params.arguments||{});result={content:[{type:'text',text:'ok'}],structuredContent:v}}
out({jsonrpc:'2.0',id:m.id,result})}});
`;

const docker = new DockerStdioSocket(SOCKET);
const selfId = process.env.HOSTNAME;
const EGRESS_PORT = 8789;
const launcher = new DockerStdioLauncher({
  project: PROJECT,
  socket: SOCKET,
  selfId,
  egressPort: EGRESS_PORT,
});
const connection = (suffix: string) => `conn_09${suffix}`;
const used: string[] = [];
let broker: Server | undefined;

const INITIALIZE = {
  protocolVersion: MCP_PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: 'melete-conformance', version: '0' },
};

async function start(id: string, launch: Record<string, unknown>) {
  used.push(id);
  const channel = await launcher.start(
    {
      connectionId: id,
      spaceId: 'sp_conformance',
      launch: mcpStdioLaunch.parse({ secret_env_names: ['PROBE_TOKEN'], ...launch }),
      env: { PROBE_TOKEN: TOKEN },
    },
    AbortSignal.timeout(240_000),
  );
  const transport = openLineMcpTransport(channel, { timeoutMs: 60_000 });
  await transport.request('initialize', INITIALIZE);
  await transport.notify('notifications/initialized');
  return { channel, transport };
}
const call = async (transport: McpTransport, name: string, args: JsonObject = {}) =>
  (await transport.request('tools/call', { name, arguments: args })) as JsonObject;
const structured = async (transport: McpTransport, name: string, args: JsonObject = {}) =>
  (await call(transport, name, args)).structuredContent as JsonObject;
const probeLaunch = { runner: 'image', source: PROBE_IMAGE, command: 'node', args: ['-e', PROBE] };
const container = (id: string) => `${PROJECT}-mcp-${id.toLowerCase()}`;
const exists = async (path: string) => {
  try {
    await docker.request('GET', path);
    return true;
  } catch (error) {
    if (error instanceof DockerError && error.status === 404) return false;
    throw error;
  }
};

afterAll(async () => {
  if (!dockerEnabled) return;
  for (const id of used) await launcher.destroy(id).catch(() => {});
  await launcher.close();
  await new Promise((resolve) => (broker ? broker.close(resolve) : resolve(undefined)));
}, 120_000);

describe.skipIf(!dockerEnabled)(
  'conformance 10: a stdio MCP server in a container of its own',
  () => {
    test('with no destination named it is unprivileged, alone with its volume, and reaches nothing', async () => {
      const id = connection('a');
      const { transport } = await start(id, probeLaunch);
      const seen = await structured(transport, 'probe');
      expect(seen).toMatchObject({
        uid: 10001,
        gid: 10001,
        cap_eff: '0000000000000000',
        no_new_privs: '1',
        seccomp: '2',
        root_write: false,
        data_write: true,
        docker_socket: false,
        interfaces: ['lo'],
        public_tcp: false,
        external_dns: false,
        default_route: false,
        memory_max: String(512 * 1024 ** 2),
        pids_max: '128',
      });
      // Its environment is its home and its sealed variable, nothing of this process's.
      const env = seen.env as Record<string, string>;
      expect(env.PROBE_TOKEN).toBe(TOKEN);
      for (const name of Object.keys(process.env).filter((key) =>
        /MELETE|TOKEN|KEY|DATABASE/.test(key),
      ))
        expect(env).not.toHaveProperty(name);
      expect(Object.keys(env).some((name) => /PROXY/i.test(name))).toBe(false);

      const inspected = (await docker.request('GET', `/containers/${container(id)}/json`)) as {
        Config: { User: string };
        HostConfig: {
          NetworkMode: string;
          ReadonlyRootfs: boolean;
          CapDrop: string[];
          SecurityOpt: string[];
          Privileged: boolean;
          LogConfig: { Type: string };
        };
        Mounts: { Type: string; Destination: string; Name?: string; RW: boolean }[];
      };
      expect(inspected.Config.User).toBe('10001:10001');
      expect(inspected.HostConfig).toMatchObject({
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Privileged: false,
        LogConfig: { Type: 'none' },
      });
      expect(
        inspected.Mounts.map((mount) => [mount.Type, mount.Destination, mount.Name, mount.RW]),
      ).toEqual([['volume', '/data', `${container(id)}-data`, true]]);
      await transport.close();
      expect(await exists(`/containers/${container(id)}/json`)).toBe(false);
    }, 300_000);

    test('with one destination named it reaches that one through the proxy, and on the service only the proxy and the broker', async () => {
      // Stands in for the broker: the one authenticated listener besides the proxy that a server
      // on this network can open.
      broker = createServer((socket) => socket.end());
      await new Promise<void>((resolve) => broker?.listen(BROKER_PORT, '0.0.0.0', resolve));
      expect((broker.address() as AddressInfo).port).toBe(BROKER_PORT);
      const self = (await docker.request('GET', `/containers/${selfId}/json`)) as {
        NetworkSettings: { Networks: Record<string, { Gateway: string }> };
      };
      const gateway = Object.values(self.NetworkSettings.Networks).find(
        (network) => network.Gateway,
      )?.Gateway;

      const id = connection('b');
      const { transport } = await start(id, { ...probeLaunch, egress: ['example.com'] });
      const reached = await structured(transport, 'egress', {
        allowed: 'example.com:443',
        other: 'example.org:443',
        gateway: gateway ?? null,
        gatewayPort: 22,
        ports: [EGRESS_PORT, BROKER_PORT, ...CLOSED_PORTS],
      });
      expect(String(reached.allowed)).toContain(' 200');
      expect(String(reached.other)).toContain(' 403');
      expect(reached).toMatchObject({
        direct: false,
        external_dns: false,
        default_route: false,
        service: {
          [EGRESS_PORT]: true,
          [BROKER_PORT]: true,
          ...Object.fromEntries(CLOSED_PORTS.map((port) => [port, false])),
        },
      });
      // The host is not reachable through the gateway of the network this test's container is on.
      if (gateway) expect(reached.gateway).toBe(false);
      const inspected = (await docker.request('GET', `/containers/${container(id)}/json`)) as {
        NetworkSettings: { Networks: Record<string, unknown> };
      };
      expect(Object.keys(inspected.NetworkSettings.Networks)).toEqual([`${container(id)}-net`]);
      const network = (await docker.request('GET', `/networks/${container(id)}-net`)) as {
        Internal: boolean;
        Containers: Record<string, unknown>;
      };
      expect(network.Internal).toBe(true);
      // The server and the proxy's container, nothing else.
      expect(Object.keys(network.Containers)).toHaveLength(2);
      await transport.close();
      expect(await exists(`/networks/${container(id)}-net`)).toBe(false);
    }, 300_000);

    test('a server that exits leaves no container, and removal takes its volume', async () => {
      const id = connection('c');
      const { channel, transport } = await start(id, probeLaunch);
      const ended = new Promise<void>((resolve) => channel.onClose(resolve));
      await call(transport, 'exit').catch(() => {});
      await ended;
      for (
        let index = 0;
        index < 50 && (await exists(`/containers/${container(id)}/json`));
        index++
      )
        await Bun.sleep(200);
      expect(await exists(`/containers/${container(id)}/json`)).toBe(false);
      expect(await exists(`/volumes/${container(id)}-data`)).toBe(true);
      await launcher.destroy(id);
      expect(await exists(`/volumes/${container(id)}-data`)).toBe(false);
    }, 300_000);

    test('an npm package is fetched into a volume the server can only read, then runs with no network', async () => {
      const id = connection('d');
      used.push(id);
      const launch = mcpStdioLaunch.parse({
        runner: 'npx',
        source: '@modelcontextprotocol/server-filesystem@2026.8.31',
        // The package's own directory is offered to it too, to show it cannot be changed.
        args: ['/data/home', '/pkg'],
      });
      const channel = await launcher.start(
        { connectionId: id, spaceId: 'sp_conformance', launch, env: {} },
        AbortSignal.timeout(240_000),
      );
      const transport = openLineMcpTransport(channel, { timeoutMs: 60_000 });
      const initialized = (await transport.request('initialize', INITIALIZE)) as JsonObject;
      expect(initialized.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
      await transport.notify('notifications/initialized');
      const listed = (await transport.request('tools/list', {})) as { tools: { name: string }[] };
      expect(listed.tools.map((tool) => tool.name)).toContain('write_file');

      // Its own volume takes a write; the package it runs from does not, so nothing the server
      // does can change what the next preparation or the next start runs.
      const own = await call(transport, 'write_file', {
        path: '/data/home/note.txt',
        content: 'x',
      });
      expect(own.isError ?? false).toBe(false);
      const packaged = await call(transport, 'write_file', {
        path: '/pkg/npm/node_modules/planted.js',
        content: 'x',
      });
      expect(packaged.isError).toBe(true);

      const inspected = (await docker.request('GET', `/containers/${container(id)}/json`)) as {
        HostConfig: { NetworkMode: string };
        Mounts: { Destination: string; Name?: string; RW: boolean }[];
      };
      expect(inspected.HostConfig.NetworkMode).toBe('none');
      expect(
        inspected.Mounts.map((mount) => [mount.Destination, mount.Name, mount.RW]).sort(),
      ).toEqual([
        ['/data', `${container(id)}-data`, true],
        ['/pkg', `${container(id)}-pkg`, false],
      ]);
      expect(await exists(`/containers/${container(id)}-prepare/json`)).toBe(false);
      await transport.close();
    }, 300_000);
  },
);
