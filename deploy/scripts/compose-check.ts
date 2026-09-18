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
import { checkDockerfileWorkspaces } from './dockerfile-check.ts';
import { checkRuntimePluginPin } from './plugin-pin-check.ts';

export type ComposeFile = {
  networks?: Record<string, { internal?: boolean; driver_opts?: Record<string, string> } | null>;
  services?: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
};

export type ComposeService = {
  networks?: string[] | Record<string, { aliases?: string[]; gw_priority?: number } | null>;
  environment?: Record<string, string | number | boolean>;
  env_file?: string | (string | { path: string; required?: boolean })[];
  secrets?: (string | { source: string; target?: string })[];
  user?: string;
  group_add?: string[];
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
  image?: string;
  network_mode?: string;
  privileged?: boolean;
  pid?: string;
  ipc?: string;
  entrypoint?: string | string[];
  depends_on?: string[] | Record<string, unknown>;
  logging?: ComposeLogging;
};

export type ComposeLogging = {
  driver?: string;
  options?: Record<string, string | number>;
};

export type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
};

const RUNTIME = 'runtime';

/**
 * Docker's default json-file log has no size limit, so one talkative container
 * fills the disk that Postgres and the volumes share. A bound is a rotated
 * json-file with a positive size and a positive file count; anything else,
 * including a driver whose retention this check cannot read, is refused.
 */
export function boundedLogging(logging: unknown): boolean {
  if (logging === null || typeof logging !== 'object') return false;
  const { driver, options } = logging as ComposeLogging;
  const size = /^([1-9]\d*)([kmg])$/.exec(String(options?.['max-size'] ?? ''));
  const files = /^[1-9]\d*$/.test(String(options?.['max-file'] ?? ''));
  return driver === 'json-file' && size !== null && files;
}

/** Names of the services that would log without a bound. */
export function unboundedServices(services: Record<string, { logging?: unknown }>): string[] {
  return Object.entries(services)
    .filter(([, service]) => !boundedLogging(service.logging))
    .map(([name]) => name);
}
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

  const unbounded = unboundedServices(compose.services ?? {});
  say(
    'every service has bounded logs',
    Object.keys(compose.services ?? {}).length > 0 && unbounded.length === 0,
    `services without a json-file max-size and max-file: ${unbounded.join(', ')}`,
  );

  const runtime = compose.services?.[RUNTIME];
  if (!runtime) {
    say('the runtime service exists', false, 'no service named "runtime"');
    return results;
  }

  const networks = networkNames(runtime);
  // The wiring lane's checks, kept where the deploy lane's verified topology
  // allows: the service must own the Docker socket group explicitly and must
  // supervise attempts itself (the deploy lane's docker adapter, or the wiring
  // lane's hermes adapter with its docker supervisor). Its development-profile
  // check is not needed here: the static cell is a warm probe that the adapter
  // check keeps from ever running a job, and the authority check below keeps
  // credential-free. Its build-only image check is restored further down.
  const service = compose.services?.melete;
  say(
    'the Docker socket group is explicitly required',
    (service?.group_add ?? []).some((entry) => /^\$\{DOCKER_GID:\?/.test(entry)) === true,
    'DOCKER_GID must be explicitly set to the host socket group; no root-group default',
  );
  say(
    'the default service supervises attempts itself',
    service?.environment?.MELETE_RUNTIME_ADAPTER === 'docker' ||
      (service?.environment?.MELETE_RUNTIME_ADAPTER === 'hermes' &&
        service.environment.MELETE_RUNTIME_SUPERVISOR === 'docker'),
    'melete must select the docker adapter, or the hermes adapter with the docker supervisor',
  );
  // The service fetches each attempt's tool catalog from its own broker before
  // the first model call. An address on a port nothing binds fails every attempt.
  const bindPort = /:(\d+)$/.exec(String(service?.environment?.MELETE_BROKER_BIND ?? ''))?.[1];
  const brokerUrl = String(service?.environment?.MELETE_BROKER_URL ?? '');
  say(
    'the service reads its tool catalog from the broker it binds',
    bindPort !== undefined &&
      /^(0\.0\.0\.0|\[::\]):\d+$/.test(String(service?.environment?.MELETE_BROKER_BIND)) &&
      brokerUrl === `http://melete:${bindPort}` &&
      runtime.environment?.MELETE_BROKER_URL === brokerUrl,
    'melete needs MELETE_BROKER_URL=http://melete:<the MELETE_BROKER_BIND port>, the same address the runtime is given, and a bind the runtime network can reach',
  );
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

  // A dependency on a service that is not in the file is refused by Compose
  // before anything starts; a check that reads the YAML has to refuse it too.
  const dangling = Object.entries(compose.services ?? {}).flatMap(([name, entry]) => {
    const dependencies = Array.isArray(entry.depends_on)
      ? entry.depends_on
      : Object.keys(entry.depends_on ?? {});
    return dependencies
      .filter((dependency) => !(dependency in (compose.services ?? {})))
      .map((dependency) => `${name} -> ${dependency}`);
  });
  say(
    'every dependency names a service in the file',
    dangling.length === 0,
    `depends_on names services that do not exist: ${dangling.join(', ')}`,
  );

  // The attempt image is built by a service that runs nothing: no engine, no
  // credential and no network, so a build cannot become a warm cell by accident.
  const image = compose.services?.['runtime-image'];
  const entrypoint = Array.isArray(image?.entrypoint) ? image.entrypoint : [image?.entrypoint];
  say(
    'the supervisor image is built without a running engine',
    image !== undefined &&
      image.network_mode === 'none' &&
      image.image === compose.services?.melete?.environment?.MELETE_RUNTIME_IMAGE &&
      entrypoint[0] === '/bin/true',
    'runtime-image must build the selected image with entrypoint /bin/true and no network',
  );
  // /bin/true needs no runtime inputs. Reject all supplied inputs so a new key
  // name or an opaque file/mount cannot bypass a credential-name denylist.
  say(
    'the build-only service carries no credentials',
    image !== undefined &&
      Object.keys(image.environment ?? {}).length === 0 &&
      image.env_file === undefined &&
      (image.secrets ?? []).length === 0 &&
      (image.volumes ?? []).length === 0,
    'runtime-image must not receive environment entries, env_file, secrets, or volume mounts',
  );

  // The warm cell is a probe: it may carry placeholders, never a minted
  // capability, a substituted secret, or one of the service's own keys.
  const staticEnvironment = runtime.environment ?? {};
  const serviceSecrets = [
    'MELETE_CAPABILITY_KEY',
    'MELETE_APPROVAL_KEY',
    'MELETE_MASTER_KEY',
    'DATABASE_URL',
    'MELETE_DOCKER_SOCKET',
  ].filter((key) => key in staticEnvironment);
  const substituted = ['MELETE_ATTEMPT_TOKEN', 'MELETE_MODEL_KEY'].filter((key) => {
    const value = String(staticEnvironment[key] ?? '');
    return value.includes('${') || /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
  });
  say(
    'the warm cell carries no attempt authority',
    serviceSecrets.length === 0 && substituted.length === 0,
    `attempt credentials are minted per container; the static cell must not carry ${[...serviceSecrets, ...substituted].join(', ')}`,
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

  // Login limits follow the address the web proxy states, so the API must
  // believe that one service only, and that service must sit on edge alone.
  const web = compose.services?.web;
  const webNetworks = Array.isArray(web?.networks)
    ? web.networks
    : Object.keys(web?.networks ?? {});
  say(
    'only the web proxy may state a browser address to the owner API',
    melete?.environment?.MELETE_TRUSTED_PROXY === 'web' &&
      webNetworks.length === 1 &&
      webNetworks[0] === 'edge',
    'MELETE_TRUSTED_PROXY must name the web service, attached to the edge network only',
  );

  return results;
}

/**
 * The engine configuration the attempt image carries. A boundary the release
 * claims is only as good as the settings that hold it up, and three of those
 * are one edited line away from being undone: an engine-side memory store that
 * outlives what the owner forgot, an unlimited run, and a conversation that
 * grows until the provider refuses it.
 *
 * This reads the file the image copies in, so it fails in CI on any machine
 * rather than on someone else's installation. Toolsets and the terminal backend
 * are checked where they are turned on.
 */
export function checkCellConfig(root: string): CheckResult[] {
  const path = join(root, 'packages', 'runtime-hermes', 'config', 'config.yaml');
  const config = parse(readFileSync(path, 'utf8')) as {
    memory?: Record<string, unknown>;
    agent?: { max_turns?: unknown };
    compression?: Record<string, unknown>;
    checkpoints?: { enabled?: unknown };
  };
  const memory = config.memory ?? {};
  const compression = config.compression ?? {};
  const turns = config.agent?.max_turns;
  const threshold = compression.threshold_tokens;
  return [
    {
      name: 'the cell config pins memory keys, turn ceiling and compaction',
      ok:
        memory.memory_enabled === false &&
        memory.user_profile_enabled === false &&
        !('enabled' in memory) &&
        config.checkpoints?.enabled === false &&
        typeof turns === 'number' &&
        turns > 0 &&
        compression.enabled === true &&
        compression.in_place === true &&
        typeof threshold === 'number' &&
        threshold > 0,
      detail:
        'memory.memory_enabled and memory.user_profile_enabled must both be false (memory.enabled is not a key the engine reads), checkpoints must be off, agent.max_turns must be a positive ceiling, and compression must be on in place with a threshold in tokens',
    },
  ];
}

export function loadCompose(path: string): ComposeFile {
  return parse(readFileSync(path, 'utf8')) as ComposeFile;
}

export const defaultComposePath = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), '..', 'docker-compose.yml');

if (import.meta.main) {
  const path = process.argv[2] ?? defaultComposePath();
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const results = [
    ...checkCompose(loadCompose(path)),
    // The images this file builds are read from the repository, not from `path`.
    ...checkDockerfileWorkspaces(root),
    ...checkRuntimePluginPin(root),
    ...checkCellConfig(root),
  ];
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
