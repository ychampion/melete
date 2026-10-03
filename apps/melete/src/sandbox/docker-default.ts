/**
 * What `MELETE_SANDBOX_PROVIDER=docker` sets up: the engine and limits every
 * docker sandbox gets, and the sandbox connection each space is given, so an
 * agent has a shell and a desktop without anyone installing one.
 */
import type { SandboxConnectionConfig } from '@melete/contracts';
import { DOCKER_SANDBOX_DEFAULTS, type DockerSandboxSettings } from './adapters/docker.ts';

export type DockerSandboxEnv = {
  MELETE_RUNTIME_ADAPTER: string;
  MELETE_DOCKER_SOCKET: string;
  MELETE_SANDBOX_PROVIDER?: 'docker';
  MELETE_SANDBOX_PROJECT?: string;
  MELETE_SANDBOX_DOCKER_IMAGE?: string;
  MELETE_SANDBOX_DOCKER_CPUS?: number;
  MELETE_SANDBOX_DOCKER_MEMORY_MB?: number;
  MELETE_SANDBOX_DOCKER_PIDS?: number;
  MELETE_SANDBOX_DOCKER_DISK_MB?: number;
  MELETE_SANDBOX_DOCKER_EGRESS?: 'open' | 'connected_hosts_only' | 'deny_all';
  MELETE_SANDBOX_DOCKER_IDLE_SECONDS?: number;
  MELETE_SANDBOX_EGRESS_PORT?: number;
  MELETE_SANDBOX_EGRESS_EXTRA_HOSTS?: readonly string[];
};

/**
 * The service's own container, when it runs in one on the engine it drives:
 * Docker names a container's host after its short id. Only then can it join a
 * sandbox's network as the one way out.
 */
export function serviceContainerId(
  env: Pick<DockerSandboxEnv, 'MELETE_RUNTIME_ADAPTER'>,
  hostname = process.env.HOSTNAME ?? '',
): string | undefined {
  return env.MELETE_RUNTIME_ADAPTER === 'docker' && /^[a-f0-9]{12,64}$/.test(hostname)
    ? hostname
    : undefined;
}

export function dockerSandboxSettings(
  env: DockerSandboxEnv,
  hostname?: string,
): DockerSandboxSettings {
  const selfId = serviceContainerId(env, hostname);
  return {
    socket: env.MELETE_DOCKER_SOCKET,
    project: env.MELETE_SANDBOX_PROJECT ?? '',
    cpus: env.MELETE_SANDBOX_DOCKER_CPUS ?? DOCKER_SANDBOX_DEFAULTS.cpus,
    memoryMb: env.MELETE_SANDBOX_DOCKER_MEMORY_MB ?? DOCKER_SANDBOX_DEFAULTS.memoryMb,
    pids: env.MELETE_SANDBOX_DOCKER_PIDS ?? DOCKER_SANDBOX_DEFAULTS.pids,
    diskMb: env.MELETE_SANDBOX_DOCKER_DISK_MB ?? DOCKER_SANDBOX_DEFAULTS.diskMb,
    idleSeconds: env.MELETE_SANDBOX_DOCKER_IDLE_SECONDS ?? DOCKER_SANDBOX_DEFAULTS.idleSeconds,
    egressPort: env.MELETE_SANDBOX_EGRESS_PORT ?? DOCKER_SANDBOX_DEFAULTS.egressPort,
    ...(selfId ? { selfId } : {}),
    ...(env.MELETE_SANDBOX_EGRESS_EXTRA_HOSTS?.length
      ? { egressExtraHosts: [...env.MELETE_SANDBOX_EGRESS_EXTRA_HOSTS] }
      : {}),
  };
}

/** How long one default sandbox may run before it is stopped; it starts again when used. */
export const DEFAULT_SANDBOX_LIFETIME_SECONDS = 8 * 3600;

/**
 * The configuration of the sandbox each space is given, or null when the
 * deployment asked for none. Open egress needs the service in a container on
 * the same engine; elsewhere the default is narrowed to no network, never
 * widened.
 */
export function defaultSandboxConfig(
  env: DockerSandboxEnv,
  hostname?: string,
): SandboxConnectionConfig | null {
  if (env.MELETE_SANDBOX_PROVIDER !== 'docker' || !env.MELETE_SANDBOX_PROJECT) return null;
  const wanted = env.MELETE_SANDBOX_DOCKER_EGRESS ?? 'open';
  // Both kinds with a network leave only through the guard in the service's container.
  const egress = wanted !== 'deny_all' && !serviceContainerId(env, hostname) ? 'deny_all' : wanted;
  return {
    adapter: 'docker',
    image: env.MELETE_SANDBOX_DOCKER_IMAGE ?? 'melete-sandbox:local',
    egress,
    persistence: 'pause',
    lifetime_seconds: DEFAULT_SANDBOX_LIFETIME_SECONDS,
  };
}
