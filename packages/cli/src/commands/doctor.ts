/**
 * `melete doctor`: whether this machine can run the installation. It asks the
 * Docker client about the engine and Compose, measures free space where Docker
 * keeps its images in MB against the contract's floor, the engine's memory,
 * whether the ports the stack publishes are free or already the stack's own,
 * whether each image is present, and whether the registry answers. With an
 * external database it asks that server, from the stack's own Postgres client
 * image, for its version and whether the connection is encrypted. It changes
 * nothing. The registry and the external database are its network calls, and
 * `--offline` skips both.
 *
 * It also counts how many more networks Docker's address pools and the
 * service's own network pool (MELETE_NETWORK_POOL, this shell's value before
 * deploy/.env's, as Compose reads it) can give, and
 * lists the agents' computers and networks that sandbox projects no
 * installation on this engine uses have left behind. `--remove-leftovers`
 * removes those, and is the only way doctor changes anything.
 *
 * The test suite's own prerequisites stay in `bun run doctor`.
 */

import { readHostDocker } from '../../../../apps/melete/src/runtime/docker-engine.ts';
import {
  type DockerHostFacts,
  describeDockerHost,
  engineElsewhere,
  judgeDockerMachine,
  MIN_DESKTOP_MEMORY_BYTES,
  readDockerHost,
  remoteEngineHost,
} from '../../../../apps/melete/src/runtime/docker-host.ts';
import {
  formatPool,
  NETWORK_SUBNET_PREFIX,
  type NetworkPool,
  parseNetworkPool,
} from '../../../../apps/melete/src/runtime/network-pool.ts';
import { freeSpace } from '../../../../deploy/scripts/status.ts';
import {
  type AddressPoolFact,
  type AddressPoolFacts,
  type Cidr,
  enginePools,
  judgeAddressPools,
  type Pool,
  type PoolHeadroom,
  parseCidr,
  parseRoutes,
  poolHeadroom,
} from '../address-pools.ts';
import { judgeBrowser } from '../browser.ts';
import { type Context, inServiceImage, type PortProbe, type Run } from '../context.ts';
import { databaseShell } from '../database.ts';
import { composeCommand, type DeployConfig } from '../deploy-config.ts';
import { type Installation, publishedPorts, readInstallation } from '../installation.ts';
import { databaseSecrets, redact } from '../redact.ts';
import {
  judgeLeftovers,
  LEFTOVERS_ID,
  type Leftovers,
  readSandboxLeftovers,
  removeLeftovers,
} from '../sandbox-leftovers.ts';
import { EXIT, type ExitCode, hostOnly, type Result, renderReport, report } from '../schema.ts';
import { judgeContract } from './check.ts';

const MB = 1024 ** 2;

export type PortFact = {
  service: string;
  /** The address Compose publishes on, as declared; `0.0.0.0` for every address. */
  host: string;
  /** A port, or a range too wide to probe one by one. */
  port: string;
  /**
   * What a connection found, or `ours` when one of this project's containers
   * already publishes it, or `range` for a range that was not probed.
   */
  probe: PortProbe | 'ours' | 'range';
};

/** The widest published range probed port by port. */
export const MAX_PROBED_RANGE = 64;

/** `3100` or `3100-3105` as the ports in it; null for a range wider than MAX_PROBED_RANGE or for text that is not a port. */
export function expandPublished(published: string): number[] | null {
  const match = /^(\d+)(?:-(\d+))?$/.exec(published.trim());
  if (!match) return null;
  const first = Number(match[1]);
  const last = match[2] === undefined ? first : Number(match[2]);
  if (first <= 0 || last < first || last > 65_535 || last - first + 1 > MAX_PROBED_RANGE)
    return null;
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

export type DoctorFacts = {
  config: DeployConfig;
  contract: Result;
  /** Whether the browser worker is on, judged from the installation's files; left out, not judged. */
  browser?: Result[];
  /** Problems with the engine, Compose or the machine; empty when it can run the stack. */
  docker: string[];
  dockerVersions: string;
  /** Lines about where the engine is, when that is worth saying. */
  dockerNotes: string[];
  /** The engine is on another machine, so its ports are not this machine's. */
  remoteEngine: string | null;
  freeBytes: number | null;
  memoryBytes: number | null;
  /** null when deploy/.env is missing or the engine did not answer. */
  ports: PortFact[] | null;
  images: { name: string; present: boolean }[] | null;
  /** null when not asked: no registry, or --offline. */
  registry: { url: string; answered: boolean; detail: string } | null;
  /** The external database's answer; null when not asked: the bundled database, no deploy/.env, or --offline. */
  database: DatabaseFact | null;
  /** How many more networks the engine's pools and the service's pool can give; left out when not asked. */
  addressPools?: AddressPoolFacts;
  /** MELETE_NETWORK_POOL as this shell sets it, beside deploy/.env's; left out when the shell sets none. */
  networkPoolShell?: { shell: string; file: string | undefined };
  /** What unused sandbox projects left; null when it could not be listed, left out when not asked. */
  leftovers?: Leftovers[] | null;
  /** What `--remove-leftovers` did, in place of the list. */
  removed?: Result;
};

export type DatabaseFact =
  | { answered: true; versionNum: number | null; encrypted: boolean | null }
  | { answered: false; detail: string };

/** Postgres 17 is the bundled server's version, and the dump client's. */
export const MIN_DATABASE_VERSION = 170_000;
const NEXT_DATABASE_VERSION = 180_000;

/** The server's answer to `show server_version_num` and pg_stat_ssl's `ssl`, one per line. */
export function parseDatabaseAnswer(stdout: string): DatabaseFact {
  const [version, ssl] = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    answered: true,
    versionNum: version && /^\d+$/.test(version) ? Number(version) : null,
    encrypted: ssl === 't' ? true : ssl === 'f' ? false : null,
  };
}

export function judgeDatabase(fact: DatabaseFact): Result[] {
  if (!fact.answered)
    return [
      {
        id: 'database.reachable',
        level: 'fail',
        detail: `The database at DATABASE_URL did not answer: ${fact.detail}`,
        fix: 'Check the address, that this machine is allowed through the provider firewall, and the password, then set it with bun run melete set --from-env DATABASE_URL.',
      },
    ];
  const results: Result[] = [
    { id: 'database.reachable', level: 'ok', detail: 'The database at DATABASE_URL answers.' },
  ];
  const { versionNum } = fact;
  const shown =
    versionNum === null ? 'unknown' : `${Math.floor(versionNum / 10_000)}.${versionNum % 10_000}`;
  results.push(
    versionNum === null || versionNum < MIN_DATABASE_VERSION
      ? {
          id: 'database.version',
          level: 'fail',
          detail: `The server is Postgres ${shown}; Melete needs 17 or newer.`,
          fix: 'Upgrade the server, or create the database on a Postgres 17 server.',
        }
      : versionNum >= NEXT_DATABASE_VERSION
        ? {
            id: 'database.version',
            level: 'warn',
            detail: `The server is Postgres ${shown}; backups use the stack's Postgres 17 client, and pg_dump 17 refuses a newer server.`,
            fix: "Back up with the provider's own snapshots, or keep the server on 17.",
          }
        : { id: 'database.version', level: 'ok', detail: `The server is Postgres ${shown}.` },
  );
  results.push(
    fact.encrypted === true
      ? { id: 'database.tls', level: 'ok', detail: 'The connection is encrypted.' }
      : {
          id: 'database.tls',
          level: 'fail',
          detail:
            fact.encrypted === false
              ? 'The server accepted the connection unencrypted.'
              : 'Whether the connection is encrypted could not be read.',
          fix: 'End DATABASE_URL with ?sslmode=require, and turn on TLS at the provider.',
        },
  );
  return results;
}

export function judgeDoctor(facts: DoctorFacts): Result[] {
  const results: Result[] = [facts.contract, ...(facts.browser ?? [])];
  results.push(
    facts.docker.length === 0
      ? { id: 'docker.engine', level: 'ok', detail: facts.dockerVersions }
      : {
          id: 'docker.engine',
          level: 'fail',
          detail: facts.docker.join(' '),
          fix: 'Install or start Docker Engine 28 or newer with Compose 2.33.1 or newer, then run this again.',
        },
  );
  for (const note of facts.dockerNotes)
    results.push({ id: 'docker.host', level: 'ok', detail: note });
  if (facts.docker.length > 0) return results;

  const floor = facts.config.disk.min_free_mb;
  if (facts.freeBytes === null)
    results.push({
      id: 'disk.free_mb',
      level: 'warn',
      detail: 'Could not measure the free space where Docker keeps its images.',
    });
  else {
    const free = Math.floor(facts.freeBytes / MB);
    results.push(
      free >= floor
        ? {
            id: 'disk.free_mb',
            level: 'ok',
            detail: `${free} MB free where Docker keeps its images; the floor is ${floor} MB.`,
          }
        : {
            id: 'disk.free_mb',
            level: 'fail',
            detail: `${free} MB free where Docker keeps its images, below the floor of ${floor} MB.`,
            fix: 'Free space with docker image prune -f (unused images only), or lower disk.min_free_mb in deploy/melete.deploy.json if this machine runs with less.',
          },
    );
  }

  if (facts.memoryBytes !== null) {
    const memory = Math.floor(facts.memoryBytes / MB);
    results.push(
      facts.memoryBytes >= MIN_DESKTOP_MEMORY_BYTES
        ? { id: 'memory.total_mb', level: 'ok', detail: `${memory} MB for containers.` }
        : {
            id: 'memory.total_mb',
            level: 'warn',
            detail: `${memory} MB for containers; the stack needs about 4 GB, 6 GB with the browser worker.`,
          },
    );
  }

  if (facts.remoteEngine !== null)
    results.push({
      id: 'ports.published',
      level: 'ok',
      detail: `The ports are published on ${facts.remoteEngine}, so they are not probed from here.`,
    });
  else if (facts.ports === null)
    results.push({
      id: 'ports.published',
      level: 'warn',
      detail: 'Without deploy/.env the ports are not known.',
    });
  else for (const port of facts.ports) results.push(judgePort(port));

  if (facts.images === null)
    results.push({
      id: 'images.present',
      level: 'warn',
      detail: 'Compose could not list the images; run bun run melete check for the reason.',
    });
  else {
    const missing = facts.images.filter((image) => !image.present).map((image) => image.name);
    results.push(
      missing.length === 0
        ? { id: 'images.present', level: 'ok', detail: `${facts.images.length} present.` }
        : {
            id: 'images.present',
            level: 'warn',
            detail: `Not on this engine yet: ${missing.join(', ')}`,
            fix:
              facts.config.images.registry === null
                ? 'They are built by docker compose up --build.'
                : 'They are pulled before the stack starts.',
          },
    );
  }

  if (facts.addressPools !== undefined) {
    results.push(...judgeAddressPools(facts.addressPools.engine));
    if (facts.addressPools.melete) results.push(...judgeAddressPools(facts.addressPools.melete));
  }
  if (facts.networkPoolShell) results.push(judgeNetworkPoolShell(facts.networkPoolShell));
  if (facts.removed) results.push(facts.removed);
  else if (facts.leftovers !== undefined) results.push(judgeLeftovers(facts.leftovers));

  if (facts.database !== null) results.push(...judgeDatabase(facts.database));

  if (facts.registry !== null)
    results.push(
      facts.registry.answered
        ? { id: 'images.registry_reachable', level: 'ok', detail: facts.registry.detail }
        : {
            id: 'images.registry_reachable',
            level: 'warn',
            detail: facts.registry.detail,
            fix: 'Check this machine reaches the registry before an update; images already present still run.',
          },
    );
  return results;
}

const poolSetting = (value: string | undefined) =>
  value?.trim() ? `MELETE_NETWORK_POOL=${value.trim()}` : 'MELETE_NETWORK_POOL empty';

/**
 * A MELETE_NETWORK_POOL this shell sets is the one Compose hands the service,
 * whatever deploy/.env says, so it is the one judged; said, and warned about
 * when deploy/.env says otherwise.
 */
function judgeNetworkPoolShell({
  shell,
  file,
}: NonNullable<DoctorFacts['networkPoolShell']>): Result {
  const id = 'docker.network_pool_shell';
  const sets = `This shell sets ${poolSetting(shell)}, which Compose reads before deploy/.env`;
  if (shell.trim() === (file ?? '').trim())
    return { id, level: 'ok', detail: `${sets}; deploy/.env says the same.` };
  return {
    id,
    level: 'warn',
    detail: `${sets} (${file === undefined ? 'which does not set it' : poolSetting(file)}), so a stack started from this shell gets the shell's value, and that is the one judged here.`,
    fix: 'Run unset MELETE_NETWORK_POOL to run and judge what deploy/.env says, or keep this value in deploy/.env: bun run melete set MELETE_NETWORK_POOL=<range>.',
  };
}

function judgePort(port: PortFact): Result {
  const id = `ports.${port.port.replace(/[^0-9]+/g, '_')}`;
  const where = `${port.host}:${port.port}`;
  const setting = port.service === 'web' ? 'WEB_PORT' : 'MELETE_PORT';
  switch (port.probe) {
    case 'ours':
      return { id, level: 'ok', detail: `${where} is ${port.service}'s, already running.` };
    case 'free':
      return { id, level: 'ok', detail: `${where} is free for ${port.service}.` };
    case 'in_use':
      return {
        id,
        level: 'fail',
        detail: `Another program listens on ${where}, which ${port.service} publishes.`,
        fix: `Stop that program, or choose another port with bun run melete set ${setting}=<port>.`,
      };
    case 'no_address':
      return {
        id,
        level: 'fail',
        detail: `${port.host} is not an address of this machine, so ${port.service} cannot be published on ${where}.`,
        fix: 'Publish it on 127.0.0.1 or an address this machine has.',
      };
    case 'range':
      return {
        id,
        level: 'warn',
        detail: `${port.service} publishes the range ${where}, wider than the ${MAX_PROBED_RANGE} ports probed one by one.`,
      };
    default:
      return {
        id,
        level: 'warn',
        detail: `Nothing answered on ${where} in time, so whether it is free is not known.`,
      };
  }
}

/** `docker compose ps --format json` rows' published host ports. */
export function publishedByProject(stdout: string): Set<number> {
  const ports = new Set<number>();
  const text = stdout.trim();
  if (!text) return ports;
  let rows: unknown[];
  try {
    rows = text.startsWith('[')
      ? JSON.parse(text)
      : text.split(/\r?\n/).flatMap((line) => (line.trim() ? [JSON.parse(line)] : []));
  } catch {
    return ports;
  }
  for (const row of rows) {
    const publishers = (row as { Publishers?: { PublishedPort?: number }[] })?.Publishers ?? [];
    for (const publisher of publishers)
      if (typeof publisher.PublishedPort === 'number' && publisher.PublishedPort > 0)
        ports.add(publisher.PublishedPort);
  }
  return ports;
}

/**
 * The pools networks come from, and how many networks each has left, from the
 * subnets of the networks that exist: the engine's own address pools, which
 * every Compose network takes a block of, and the installation's
 * MELETE_NETWORK_POOL (its default when unset), cut into the /28s the service
 * takes, unless it is `off`. A value the service refuses is reported whether
 * or not Docker answers, and so is a `reference` to another setting, which
 * Compose fills in and this does not, in place of judging it. This machine's
 * routes are read only when the engine runs here, on Linux.
 */
export function readAddressPools(
  run: Run,
  host: DockerHostFacts,
  networkPoolSetting?: string,
  reference = false,
): AddressPoolFacts {
  let melete: NetworkPool | null = null;
  let unjudged: AddressPoolFact | undefined;
  if (reference)
    unjudged = { source: 'melete', builtIn: false, pools: [], reference: networkPoolSetting ?? '' };
  else
    try {
      melete = parseNetworkPool(networkPoolSetting);
    } catch (error) {
      unjudged = {
        source: 'melete',
        builtIn: false,
        pools: [],
        invalid: error instanceof Error ? error.message : String(error),
      };
    }
  const unknown: AddressPoolFacts = { engine: null, ...(unjudged ? { melete: unjudged } : {}) };
  const listed = run(['docker', 'network', 'ls', '--quiet']);
  if (listed.code !== 0) return unknown;
  const ids = listed.stdout.split(/\s+/).filter((id) => /^[0-9a-f]{6,64}$/.test(id));
  let taken: Cidr[] = [];
  if (ids.length > 0) {
    const inspected = run([
      'docker',
      'network',
      'inspect',
      '--format',
      '{{range .IPAM.Config}}{{.Subnet}} {{end}}',
      ...ids,
    ]);
    if (inspected.code !== 0) return unknown;
    taken = inspected.stdout.split(/\s+/).flatMap((subnet) => {
      const cidr = parseCidr(subnet);
      return cidr ? [cidr] : [];
    });
  }
  const local = host.platform === 'linux' && !engineElsewhere(host);
  const table = local ? run(['cat', '/proc/net/route']) : null;
  // A route that is exactly a Docker network's subnet is that network's bridge,
  // whatever the bridge is called (com.docker.network.bridge.name).
  const routes = (table?.code === 0 ? parseRoutes(table.stdout) : []).filter(
    (route) => !taken.some((net) => net.start === route.start && net.prefix === route.prefix),
  );
  const headroom = (pools: readonly Pool[]) =>
    pools.flatMap((pool): PoolHeadroom[] => {
      const free = poolHeadroom(pool, taken, routes);
      return free ? [free] : [];
    });
  const { pools, builtIn, ipv6Only } = enginePools(host.info?.defaultAddressPools);
  return {
    engine: {
      source: 'docker',
      builtIn,
      attempts: melete === null && unjudged === undefined,
      ...(ipv6Only ? { ipv6Only } : {}),
      pools: headroom(pools),
    },
    ...(unjudged
      ? { melete: unjudged }
      : melete
        ? {
            melete: {
              source: 'melete' as const,
              builtIn: false,
              ...(networkPoolSetting?.trim() ? {} : { defaultPool: true }),
              pools: headroom([{ base: formatPool(melete), size: NETWORK_SUBNET_PREFIX }]),
            },
          }
        : {}),
  };
}

/** A `$NAME` or `${...}` in a deploy/.env value, which Compose fills in from other settings. */
const COMPOSE_REFERENCE = /\$(?:\{|[A-Za-z_])/;

/** The registry's API root: any HTTP answer, a 401 included, means it is reachable. */
export const registryUrl = (registry: string): string => `https://${registry.split('/')[0]}/v2/`;

export async function gatherDoctor(
  context: Context,
  installation: Installation,
  offline: boolean,
): Promise<DoctorFacts> {
  const { run } = context;
  const outputs = readHostDocker(run);
  const host = readDockerHost(run, context.root, context.machine);
  const docker = judgeDockerMachine(outputs, host);
  const config = installation.config;
  const facts: DoctorFacts = {
    config,
    contract: judgeContract(installation),
    browser: judgeBrowser(installation, context.environment),
    docker,
    dockerVersions: `Engine ${outputs.engine.stdout.trim().split(' ')[1] ?? '?'}, Compose ${outputs.compose.stdout.trim() || '?'}`,
    dockerNotes: describeDockerHost(host),
    remoteEngine: remoteEngineHost(host.endpoint),
    freeBytes: null,
    memoryBytes: host.info?.memTotal || null,
    ports: null,
    images: null,
    registry: null,
    database: null,
  };
  if (docker.length > 0) return facts;

  // Compose takes a value this shell sets over deploy/.env's, and fills in a
  // reference only in deploy/.env's.
  const shellPool = context.environment.MELETE_NETWORK_POOL;
  const filePool = installation.env?.MELETE_NETWORK_POOL;
  facts.addressPools = readAddressPools(
    run,
    host,
    shellPool ?? filePool,
    shellPool === undefined && filePool !== undefined && COMPOSE_REFERENCE.test(filePool),
  );
  if (shellPool !== undefined) facts.networkPoolShell = { shell: shellPool, file: filePool };
  facts.leftovers = readSandboxLeftovers(
    run,
    installation.env?.MELETE_SANDBOX_PROJECT?.trim() || null,
  );

  const compose = composeCommand(context.deployDir, config);
  if (installation.env !== null) {
    const listed = run([...compose, 'config', '--images']);
    if (listed.code === 0)
      facts.images = [...new Set(listed.stdout.split(/\r?\n/).filter(Boolean))].map((name) => ({
        name,
        present: run(['docker', 'image', 'inspect', '--format', '{{.Id}}', name]).code === 0,
      }));
    if (facts.remoteEngine === null) {
      const ps = run([...compose, 'ps', '--format', 'json']);
      const ours = ps.code === 0 ? publishedByProject(ps.stdout) : new Set<number>();
      facts.ports = [];
      for (const port of publishedPorts(installation)) {
        const host = port.hostIp === null || port.hostIp === '' ? '0.0.0.0' : port.hostIp;
        const numbers = expandPublished(port.published);
        if (numbers === null) {
          if (/^\d+-\d+$/.test(port.published.trim()))
            facts.ports.push({ service: port.service, host, port: port.published, probe: 'range' });
          continue;
        }
        for (const number of numbers)
          facts.ports.push({
            service: port.service,
            host,
            port: String(number),
            probe: ours.has(number) ? 'ours' : await context.probePort(host, number),
          });
      }
    }
  }
  facts.freeBytes = freeSpace(run, facts.images);

  // The client runs from the stack's own image, never pulled here: doctor changes nothing.
  if (!offline && config.database.external && installation.env !== null) {
    const client = facts.images?.find((image) => image.name.startsWith('postgres:'));
    if (client?.present) {
      const answer = run(
        databaseShell(
          compose,
          config,
          (db) =>
            `exec psql ${db} -At -c "show server_version_num" -c "select ssl from pg_stat_ssl where pid = pg_backend_pid()"`,
        ),
        90_000,
      );
      facts.database =
        answer.code === 0
          ? parseDatabaseAnswer(answer.stdout)
          : {
              answered: false,
              // libpq can repeat part of the URL in its error; it never reaches output.
              detail: redact(
                answer.stderr.trim().split('\n').at(-1)?.trim() || `exit ${answer.code}`,
                databaseSecrets(installation.env),
              ),
            };
    } else
      facts.database = {
        answered: false,
        detail: `the client image ${client?.name ?? 'postgres:17-alpine'} is not on this engine yet; bun run melete deploy or docker compose pull brings it`,
      };
  }

  if (!offline && config.images.registry !== null) {
    const url = registryUrl(config.images.registry);
    try {
      const response = await context.fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(5_000),
      });
      facts.registry = { url, answered: true, detail: `${url} answers (${response.status}).` };
    } catch (error) {
      facts.registry = {
        url,
        answered: false,
        detail: `${url} did not answer: ${error instanceof Error ? error.message : error}`,
      };
    }
  }
  return facts;
}

/** The rules that judge the host: its engine, disk, memory, networks, ports, images and registry. */
export const HOST_DOCTOR_RULES = [
  'docker.engine',
  'disk.free_mb',
  'memory.total_mb',
  'docker.address_pools',
  'docker.network_pool',
  LEFTOVERS_ID,
  'ports.published',
  'images.present',
  'images.registry_reachable',
] as const;

/**
 * Inside the service image the host's rules are skipped, and the browser
 * worker is judged from the settings and connections file the service runs
 * with. Docker is never asked: the container holds no socket.
 */
export function judgeDoctorInImage(
  installation: Installation,
  environment: Context['environment'],
): Result[] {
  return [
    hostOnly('deploy.contract'),
    ...judgeBrowser(installation, environment),
    ...HOST_DOCTOR_RULES.map(hostOnly),
  ];
}

export async function runDoctor(
  context: Context,
  json: boolean,
  offline: boolean,
  removeLeftoversToo = false,
): Promise<ExitCode> {
  const installation = readInstallation(context.deployDir, context.machine.platform);
  const inImage = inServiceImage(context.environment);
  if (inImage && removeLeftoversToo) {
    context.err('--remove-leftovers needs the Docker engine; run it on the host.\n');
    return EXIT.refused;
  }
  let results: Result[];
  if (inImage) results = judgeDoctorInImage(installation, context.environment);
  else {
    const facts = await gatherDoctor(context, installation, offline);
    if (removeLeftoversToo && facts.leftovers?.length)
      facts.removed = removeLeftovers(context.run, facts.leftovers);
    results = judgeDoctor(facts);
  }
  const value = report('doctor', results);
  context.out(json ? `${JSON.stringify(value, null, 2)}\n` : renderReport(value));
  return value.ok ? EXIT.ok : EXIT.failed;
}
