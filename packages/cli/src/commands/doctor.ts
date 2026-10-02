/**
 * `melete doctor`: whether this machine can run the installation. It asks the
 * Docker client about the engine and Compose, measures free space where Docker
 * keeps its images in MB against the contract's floor, the engine's memory,
 * whether the ports the stack publishes are free or already the stack's own,
 * whether each image is present, and whether the registry answers. It changes
 * nothing. The registry is the one network call, and `--offline` skips it.
 *
 * The test suite's own prerequisites stay in `bun run doctor`.
 */

import { readHostDocker } from '../../../../apps/melete/src/runtime/docker-engine.ts';
import {
  describeDockerHost,
  judgeDockerMachine,
  MIN_DESKTOP_MEMORY_BYTES,
  readDockerHost,
  remoteEngineHost,
} from '../../../../apps/melete/src/runtime/docker-host.ts';
import { freeSpace } from '../../../../deploy/scripts/status.ts';
import type { Context } from '../context.ts';
import { composeCommand, type DeployConfig } from '../deploy-config.ts';
import {
  type Installation,
  isLoopback,
  publishedPorts,
  readInstallation,
} from '../installation.ts';
import { EXIT, type ExitCode, type Result, renderReport, report } from '../schema.ts';
import { judgeContract } from './check.ts';

const MB = 1024 ** 2;

export type PortFact = {
  service: string;
  host: string;
  port: number;
  /** Nothing listens there yet. */
  free: boolean;
  /** One of this project's containers publishes it. */
  ours: boolean;
};

export type DoctorFacts = {
  config: DeployConfig;
  contract: Result;
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
};

export function judgeDoctor(facts: DoctorFacts): Result[] {
  const results: Result[] = [facts.contract];
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
  else
    for (const port of facts.ports)
      results.push(
        port.free || port.ours
          ? {
              id: `ports.${port.port}`,
              level: 'ok',
              detail: port.ours
                ? `${port.host}:${port.port} is ${port.service}'s, already running.`
                : `${port.host}:${port.port} is free for ${port.service}.`,
            }
          : {
              id: `ports.${port.port}`,
              level: 'fail',
              detail: `Another program listens on ${port.host}:${port.port}, which ${port.service} publishes.`,
              fix:
                port.service === 'web'
                  ? 'Stop that program, or choose another port with bun run melete set WEB_PORT=<port>.'
                  : 'Stop that program, or choose another port with bun run melete set MELETE_PORT=<port>.',
            },
      );

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
    docker,
    dockerVersions: `Engine ${outputs.engine.stdout.trim().split(' ')[1] ?? '?'}, Compose ${outputs.compose.stdout.trim() || '?'}`,
    dockerNotes: describeDockerHost(host),
    remoteEngine: remoteEngineHost(host.endpoint),
    freeBytes: null,
    memoryBytes: host.info?.memTotal || null,
    ports: null,
    images: null,
    registry: null,
  };
  if (docker.length > 0) return facts;

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
        const number = Number(port.published);
        if (!Number.isInteger(number) || number <= 0) continue;
        const address = isLoopback(port.hostIp) ? (port.hostIp as string) : '0.0.0.0';
        facts.ports.push({
          service: port.service,
          host: address === 'localhost' ? '127.0.0.1' : address,
          port: number,
          ours: ours.has(number),
          free: ours.has(number) ? false : await context.portFree(address, number),
        });
      }
    }
  }
  facts.freeBytes = freeSpace(run, facts.images);

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

export async function runDoctor(
  context: Context,
  json: boolean,
  offline: boolean,
): Promise<ExitCode> {
  const installation = readInstallation(context.deployDir, context.machine.platform);
  const value = report('doctor', judgeDoctor(await gatherDoctor(context, installation, offline)));
  context.out(json ? `${JSON.stringify(value, null, 2)}\n` : renderReport(value));
  return value.ok ? EXIT.ok : EXIT.failed;
}
