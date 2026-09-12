import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { newId } from '../../apps/melete/src/ids.ts';
import {
  approveJob,
  compose,
  composeEnabled,
  createStackJob,
  docker,
  serviceId,
  waitFor,
  waitForJob,
  waitForStack,
} from '../helpers/compose.ts';

type Inspection = {
  Id: string;
  Config: { User: string; Labels: Record<string, string> };
  HostConfig: {
    ReadonlyRootfs: boolean;
    Mounts: { Target: string; VolumeOptions?: { Subpath: string } }[];
  };
  NetworkSettings: {
    Networks: Record<string, { IPAddress: string; Gateway: string; NetworkID: string }>;
  };
};
type Probe = {
  reachable?: boolean;
  errno?: number;
  status?: number;
  checks?: { path: string; reachable?: boolean; errno?: number; status?: number; body?: string }[];
  duration_ms: number;
  default_routes?: string[];
  reads?: { readable: boolean }[];
  own_workspace_writable?: boolean;
  uid?: number;
  root_write?: boolean;
  effective_capabilities?: string;
  no_new_privileges?: string;
  docker_socket_present?: boolean;
};

describe.skipIf(!composeEnabled)('conformance 6: Linux runtime has no route out', () => {
  let runtime: Inspection;
  let postgres: Inspection;
  let melete: Inspection;
  let source: string;
  let hostControl: ReturnType<typeof Bun.serve> | undefined;
  const sibling = newId('job');

  const probe = async (input: Record<string, unknown>, container = runtime.Id): Promise<Probe> => {
    const result = JSON.parse(
      await docker('exec', container, 'python', '-c', source, JSON.stringify(input)),
    ) as Probe;
    process.stdout.write(
      `cell probe ${input.mode}:${input.host ?? input.url ?? ''} ${JSON.stringify(result)}\n`,
    );
    return result;
  };

  const expectControlPlaneDenied = (result: Probe) => {
    expect(result.checks?.map((check) => check.path)).toEqual(['/setup', '/login', '/health']);
    for (const check of result.checks ?? []) {
      if (check.reachable === false) {
        expect(check.errno).toBe(111); // ECONNREFUSED, not a timeout or a DNS failure.
      } else {
        expect(check.status).toBe(403);
        expect(JSON.parse(check.body ?? '')).toEqual({
          error: { code: 'control_plane_forbidden', message: 'Forbidden.' },
        });
      }
    }
  };

  beforeAll(async () => {
    await waitForStack();
    const values = JSON.parse(
      await docker(
        'inspect',
        await serviceId('runtime'),
        await serviceId('postgres'),
        await serviceId('melete'),
      ),
    ) as Inspection[];
    [runtime, postgres, melete] = values as [Inspection, Inspection, Inspection];
    source = await readFile(new URL('../helpers/cell-probe.py', import.meta.url), 'utf8');
    const result = await compose(
      'exec',
      '-T',
      'melete',
      'bun',
      '-e',
      "const fs=await import('node:fs/promises');const p='/work/'+process.argv[1];await fs.mkdir(p,{mode:0o2770});await fs.writeFile(p+'/secret.txt','w6-sibling-canary');if(await fs.readFile(p+'/secret.txt','utf8')!=='w6-sibling-canary')throw Error('fixture absent')",
      sibling,
    );
    expect(result).toBe('');
  }, 190_000);

  afterAll(async () => {
    hostControl?.stop(true);
    if (melete)
      await compose(
        'exec',
        '-T',
        'melete',
        'bun',
        '-e',
        "const fs=await import('node:fs/promises');const p='/work/'+process.argv[1];await fs.unlink(p+'/secret.txt');await fs.rmdir(p)",
        sibling,
      );
  });

  test('internet TCP is denied by lack of a default route', async () => {
    expect((await probe({ mode: 'route' })).default_routes).toEqual([]);
    const result = await probe({ mode: 'connect', host: '1.1.1.1', port: 443 });
    expect(result.reachable).toBe(false);
    expect([101, 113]).toContain(result.errno ?? 0);
    expect(result.duration_ms).toBeLessThan(1000);
  });

  test('Postgres is unreachable by DNS and its actual container IP', async () => {
    expect((await probe({ mode: 'connect', host: 'postgres', port: 5432 })).reachable).toBe(false);
    const ip = Object.values(postgres.NetworkSettings.Networks)[0]?.IPAddress;
    expect(ip).toBeTruthy();
    expect((await probe({ mode: 'connect', host: ip, port: 5432 })).reachable).toBe(false);
  });

  test('the metadata address has no route', async () => {
    const result = await probe({ mode: 'connect', host: '169.254.169.254', port: 80 });
    expect(result.reachable).toBe(false);
    expect([101, 113]).toContain(result.errno ?? 0);
  });

  test('another job is absent from the mounted filesystem', async () => {
    const mount = runtime.HostConfig.Mounts.find((mount) => mount.Target === '/work');
    expect(mount?.VolumeOptions?.Subpath).toBe('_probe');
    const result = await probe({ mode: 'sibling', job: sibling });
    expect(result.own_workspace_writable).toBe(true);
    expect(result.reads).toHaveLength(3);
    expect(result.reads?.every((read) => !read.readable)).toBe(true);
  });

  test('a proven live host listener is unreachable', async () => {
    hostControl = Bun.serve({
      hostname: '0.0.0.0',
      port: 0,
      fetch: () => new Response('w6-host-control'),
    });
    const network = Object.entries(melete.NetworkSettings.Networks).find(([name]) =>
      name.endsWith('_edge'),
    )?.[1];
    expect(network?.Gateway).toBeTruthy();
    expect(await (await fetch(`http://${network?.Gateway}:${hostControl.port}`)).text()).toBe(
      'w6-host-control',
    );
    expect(
      (await probe({ mode: 'connect', host: network?.Gateway, port: hostControl.port })).reachable,
    ).toBe(false);
  });

  test('the web service is unreachable', async () => {
    expect((await probe({ mode: 'connect', host: 'web', port: 3000 })).reachable).toBe(false);
  });

  test('only the broker/gateway peer is attached and both routes answer', async () => {
    const networks = Object.values(runtime.NetworkSettings.Networks);
    expect(networks).toHaveLength(1);
    const network = JSON.parse(
      await docker('network', 'inspect', networks[0]?.NetworkID ?? ''),
    )[0] as {
      Internal: boolean;
      Options: Record<string, string>;
      Containers: Record<string, unknown>;
    };
    expect(network.Internal).toBe(true);
    expect(network.Options['com.docker.network.bridge.gateway_mode_ipv4']).toBe('isolated');
    expect(Object.keys(network.Containers).sort()).toEqual([runtime.Id, melete.Id].sort());
    expect((await probe({ mode: 'http', url: 'http://melete:8788/tools' })).status).toBe(401);
    expect(
      (
        await probe({
          mode: 'http',
          url: 'http://melete:8788/providers/fake/v1/chat/completions',
          post: true,
        })
      ).status,
    ).toBe(401);
  });

  test('non-root, read-only, no capabilities, no privilege escalation or Docker socket', async () => {
    expect(runtime.Config.User).toBe('10001:10001');
    expect(runtime.HostConfig.ReadonlyRootfs).toBe(true);
    const result = await probe({ mode: 'hardening' });
    expect(result.uid).toBe(10001);
    expect(result.root_write).toBe(false);
    expect(result.effective_capabilities).toBe('0000000000000000');
    expect(result.no_new_privileges).toBe('1');
    expect(result.docker_socket_present).toBe(false);
  });

  test('the warm cell cannot reach owner setup, login or health', async () => {
    expectControlPlaneDenied(await probe({ mode: 'control-plane' }));
  });

  test('a claimed attempt cannot reach the owner control plane and retains its job boundary', async () => {
    const { jobId } = await createStackJob({ title: 'Probe an actual isolated attempt' });
    const childId = await waitFor(
      async () => {
        const id = (
          await docker(
            'ps',
            '-q',
            '--no-trunc',
            '--filter',
            'label=com.melete.attempt-supervisor=v1',
            '--filter',
            `label=com.melete.job=${jobId}`,
          )
        ).trim();
        return id || false;
      },
      30_000,
      'the claimed attempt container',
    );
    // Stop only the engine process. Docker exec remains available for the probes;
    // the service continues renewing the claimed attempt's lease.
    await docker('kill', '--signal', 'STOP', childId);
    let controlPlane: Probe | undefined;
    try {
      controlPlane = await probe({ mode: 'control-plane' }, childId);
      const child = JSON.parse(await docker('inspect', childId))[0] as Inspection;
      expect(
        child.HostConfig.Mounts.find((mount) => mount.Target === '/work')?.VolumeOptions?.Subpath,
      ).toBe(jobId);
      expect((await probe({ mode: 'route' }, childId)).default_routes).toEqual([]);
      const pgIp = Object.values(postgres.NetworkSettings.Networks)[0]?.IPAddress;
      const edge = Object.entries(melete.NetworkSettings.Networks).find(([name]) =>
        name.endsWith('_edge'),
      )?.[1];
      if (!hostControl) throw new Error('The positive host listener is absent');
      for (const [host, port] of [
        ['1.1.1.1', 443],
        ['postgres', 5432],
        [pgIp, 5432],
        ['169.254.169.254', 80],
        ['web', 3000],
        [edge?.Gateway, hostControl.port],
      ])
        expect((await probe({ mode: 'connect', host, port }, childId)).reachable).toBe(false);
      const workspace = await probe({ mode: 'sibling', job: sibling }, childId);
      expect(workspace.own_workspace_writable).toBe(true);
      expect(workspace.reads).toHaveLength(3);
      expect(workspace.reads?.every((read) => !read.readable)).toBe(true);
      const networks = Object.values(child.NetworkSettings.Networks);
      expect(networks).toHaveLength(1);
      const network = JSON.parse(
        await docker('network', 'inspect', networks[0]?.NetworkID ?? ''),
      )[0];
      expect(network.Internal).toBe(true);
      expect(network.Options['com.docker.network.bridge.gateway_mode_ipv4']).toBe('isolated');
      expect(Object.keys(network.Containers).sort()).toEqual([child.Id, melete.Id].sort());
      for (const url of [
        'http://melete:8788/tools',
        'http://melete:8788/providers/fake/v1/chat/completions',
      ])
        expect(
          (await probe({ mode: 'http', url, post: url.includes('/providers/') }, childId)).status,
        ).toBe(401);
      const hardening = await probe({ mode: 'hardening' }, childId);
      expect(hardening.uid).toBe(10001);
      expect(hardening.root_write).toBe(false);
      expect(hardening.effective_capabilities).toBe('0000000000000000');
      expect(hardening.no_new_privileges).toBe('1');
      expect(hardening.docker_socket_present).toBe(false);
    } finally {
      await docker('kill', '--signal', 'CONT', childId);
    }
    await waitForJob(jobId, 'waiting_for_approval');
    await approveJob(jobId);
    if (!controlPlane) throw new Error('The claimed-cell control-plane probe did not run');
    expectControlPlaneDenied(controlPlane);
  }, 240_000);
});
