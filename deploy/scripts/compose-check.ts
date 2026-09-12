/**
 * Reads deploy/docker-compose.yml and checks the properties the release claims
 * about its own boundary. This runs without Docker, so a change that would undo
 * the sandbox fails in CI on any machine rather than at install time on someone
 * else's.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export type ComposeFile = {
  networks?: Record<string, { internal?: boolean; driver_opts?: Record<string, string> } | null>;
  services?: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
};

export type ComposeService = {
  networks?: string[] | Record<string, { aliases?: string[]; gw_priority?: number } | null>;
  environment?: Record<string, string | number | boolean>;
  user?: string;
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  pids_limit?: number;
  mem_limit?: string;
  volumes?: (
    | string
    | {
        type?: string;
        source?: string;
        target?: string;
        read_only?: boolean;
        volume?: { subpath?: string; nocopy?: boolean };
      }
  )[];
  ports?: string[];
  profiles?: string[];
  network_mode?: string;
  privileged?: boolean;
  pid?: string;
  ipc?: string;
};

export type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
};

const RUNTIME = 'runtime';
const networkNames = (service: ComposeService | undefined): string[] =>
  Array.isArray(service?.networks) ? service.networks : Object.keys(service?.networks ?? {});

/** Every property the architecture promises about the runtime container. */
export function checkCompose(compose: ComposeFile): CheckResult[] {
  const results: CheckResult[] = [];
  const say = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });

  const internal = compose.networks?.internal;
  say(
    'the internal network has no route out',
    internal?.internal === true,
    'networks.internal.internal must be true, or the runtime can reach the world',
  );
  say(
    'the runtime network has no host bridge address',
    internal?.driver_opts?.['com.docker.network.bridge.gateway_mode_ipv4'] === 'isolated' &&
      internal?.driver_opts?.['com.docker.network.bridge.gateway_mode_ipv6'] === 'isolated',
    'internal networks also need isolated gateway mode to prevent access to host listeners',
  );

  const runtime = compose.services?.[RUNTIME];
  if (!runtime) {
    say('the runtime service exists', false, 'no service named "runtime"');
    return results;
  }

  const networks = networkNames(runtime);
  say(
    'the runtime is on the internal network only',
    networks.length === 1 && networks[0] === 'internal',
    `runtime.networks is [${networks.join(', ')}]; it must be exactly [internal]`,
  );
  say(
    'the runtime cannot join host namespaces or run privileged',
    !runtime.network_mode && !runtime.privileged && !runtime.pid && !runtime.ipc,
    'network_mode, privileged, pid and ipc overrides are forbidden for runtime cells',
  );

  say(
    'the runtime publishes no ports',
    !runtime.ports || runtime.ports.length === 0,
    'a published port would give the runtime a path the broker does not control',
  );

  say(
    'the runtime does not run as root',
    typeof runtime.user === 'string' && !runtime.user.startsWith('0:') && runtime.user !== 'root',
    `runtime.user is ${runtime.user ?? 'unset'}`,
  );

  say(
    'the runtime root filesystem is read only',
    runtime.read_only === true,
    'runtime.read_only must be true',
  );

  say(
    'the runtime drops every capability',
    Array.isArray(runtime.cap_drop) && runtime.cap_drop.includes('ALL'),
    'runtime.cap_drop must include ALL',
  );

  say(
    'the runtime cannot gain new privileges',
    (runtime.security_opt ?? []).some((o) => o.replace(/\s/g, '') === 'no-new-privileges:true'),
    'runtime.security_opt must include no-new-privileges:true',
  );

  say(
    'the runtime has a process limit',
    typeof runtime.pids_limit === 'number' && runtime.pids_limit > 0,
    'runtime.pids_limit must be set, or one fork bomb takes the host down',
  );

  say(
    'the runtime has a memory limit',
    typeof runtime.mem_limit === 'string' && runtime.mem_limit.length > 0,
    'runtime.mem_limit must be set',
  );

  // Two writable paths and no others. /work is the shared workspace. The Hermes
  // home exists because the API server's run-idempotency reservations are a
  // SQLite file under it, and on a read-only root that store degrades to process
  // memory, reports durable=false, and the adapter refuses to start. Anything
  // else mounted here is a hole in a boundary the release claims.
  const ALLOWED_MOUNTS = ['/work', '/var/lib/hermes'];
  const mounts = runtime.volumes ?? [];
  const targetOf = (mount: (typeof mounts)[number]) =>
    typeof mount === 'string' ? (mount.split(':')[1] ?? '') : (mount.target ?? '');
  const unexpected = mounts.filter((m) => {
    const target = targetOf(m);
    return !ALLOWED_MOUNTS.includes(target);
  });
  say(
    `the runtime mounts nothing but ${ALLOWED_MOUNTS.join(' and ')}`,
    unexpected.length === 0,
    `unexpected mounts: ${unexpected.join(', ')}`,
  );

  const hermesHome = mounts.find((m) => targetOf(m) === '/var/lib/hermes');
  say(
    'the runtime has a writable Hermes home',
    hermesHome !== undefined &&
      (typeof hermesHome === 'string'
        ? !hermesHome.endsWith(':ro') && hermesHome.split(':')[0] === 'runtime-home'
        : hermesHome.type === 'volume' &&
          hermesHome.source === 'runtime-home' &&
          !hermesHome.read_only),
    'without it the run-idempotency store is in-memory and the adapter refuses to start',
  );
  const work = mounts.find((m) => targetOf(m) === '/work');
  say(
    'the runtime sees one workspace subdirectory, never the work volume root',
    typeof work === 'object' &&
      work.type === 'volume' &&
      work.source === 'work' &&
      work.volume?.subpath === '_probe' &&
      work.volume?.nocopy === true,
    'the warm runtime must mount work subpath _probe; the supervisor mounts each attempt job subpath',
  );

  // Postgres must never be reachable from outside the machine, and the runtime
  // must not be able to reach it at all.
  const postgres = compose.services?.postgres;
  const postgresNetworks = networkNames(postgres);
  say(
    'postgres is internal and unpublished',
    Boolean(postgres) &&
      postgresNetworks.length === 1 &&
      postgresNetworks[0] === 'database' &&
      compose.networks?.database?.internal === true &&
      (postgres?.ports ?? []).length === 0,
    'postgres must sit on the separate internal database network and publish no port',
  );
  const peers = Object.entries(compose.services ?? {})
    .filter(([name, service]) => name !== RUNTIME && networkNames(service).includes('internal'))
    .map(([name]) => name);
  say(
    "the broker is the runtime network's only peer",
    peers.length === 1 && peers[0] === 'melete',
    `unexpected runtime peers: ${peers.join(', ')}`,
  );

  const melete = compose.services?.melete;
  const ownerNetworks = Array.isArray(melete?.networks) ? {} : (melete?.networks ?? {});
  const aliasOffEdge = Object.values(compose.services ?? {}).some(
    (service) =>
      !Array.isArray(service.networks) &&
      Object.entries(service.networks ?? {}).some(
        ([name, config]) => name !== 'edge' && config?.aliases?.includes('melete-api'),
      ),
  );
  say(
    'the owner API binds only to its edge network address',
    melete?.environment?.MELETE_API_BIND === 'melete-api' &&
      ownerNetworks.edge?.aliases?.includes('melete-api') === true &&
      ownerNetworks.edge?.gw_priority === 1 &&
      !aliasOffEdge,
    'MELETE_API_BIND must use the edge-only melete-api alias with edge gateway priority',
  );

  return results;
}

export function loadCompose(path: string): ComposeFile {
  return parse(readFileSync(path, 'utf8')) as ComposeFile;
}

export const defaultComposePath = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), '..', 'docker-compose.yml');

if (import.meta.main) {
  const path = process.argv[2] ?? defaultComposePath();
  const results = checkCompose(loadCompose(path));
  for (const result of results) {
    process.stdout.write(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}\n`);
    if (!result.ok) process.stdout.write(`     ${result.detail}\n`);
  }
  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write(
    failed === 0
      ? `compose:check passed (${results.length} checks)\n`
      : `compose:check failed (${failed} of ${results.length})\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}
