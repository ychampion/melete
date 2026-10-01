/**
 * A readable report on one installation, for a person or for the coding agent
 * setting it up: Docker, free space, deploy/.env, the model, the images, each
 * service's health, the API, the owner account and the optional extras.
 *
 *   bun run deploy/scripts/status.ts [--json] [compose options...]
 *
 * Compose options, such as `--profile sandbox` or the `-f` overlay files the
 * stack was started with, are passed to every `docker compose` call. `--json`
 * prints the same checks as one JSON object. It exits 1 while any check fails,
 * so it can be run again until the installation is ready.
 *
 * It changes nothing and prints no secret: a key is only ever reported as set
 * or empty.
 *
 * The facts are gathered in one place and judged in a pure function, so the
 * judgement is tested without a Docker engine.
 */
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type CommandOutput,
  readHostDocker,
  spawnCommand,
} from '../../apps/melete/src/runtime/docker-engine.ts';
import { judgeDockerMachine, readDockerHost } from '../../apps/melete/src/runtime/docker-host.ts';
import { parseEnvFile, providerWarnings } from './provider-settings.ts';

export type Level = 'ok' | 'warn' | 'fail';
export type Check = { level: Level; name: string; detail: string; fix?: string };

export type ServiceState = { service: string; state: string; health: string };

export type StatusFacts = {
  /** Problems with the Docker Engine, Compose or the machine; empty when it can run the stack. */
  docker: string[];
  /** Engine and Compose versions as read, for the report. */
  dockerVersions: string;
  /** deploy/.env, parsed; null when there is none yet. */
  env: Record<string, string> | null;
  /** Free bytes where Docker keeps its images; null when it could not be measured. */
  freeBytes: number | null;
  /** Each image the Compose file names, and whether the engine has it; null when Compose could not be read. */
  images: { name: string; present: boolean }[] | null;
  /** The project's containers; null when Compose could not be asked. */
  services: ServiceState[] | null;
  /** The API's /health answer through the web server; null when nothing answered. */
  health: { status?: string; database?: string } | null;
  /** Whether the owner account still has to be created; null when unknown. */
  setupNeeded: boolean | null;
};

export const SERVICES = ['postgres', 'melete', 'runtime', 'web'] as const;
const GB = 1024 ** 3;
/** The documented minimum for a first install, and the space update.sh refuses to pull below. */
export const MIN_FREE_BYTES = 10 * GB;
export const UPDATE_FREE_BYTES = 4 * GB;

const COMPOSE = 'docker compose -f deploy/docker-compose.yml';

const isSet = (env: Record<string, string>, name: string) => Boolean(env[name]?.trim());

export const webPort = (env: Record<string, string> | null) => env?.WEB_PORT?.trim() || '3101';

/** Whether the docker sandbox, the agents' own computer, is turned on. */
export const sandboxOn = (env: Record<string, string> | null) =>
  env?.MELETE_SANDBOX_PROVIDER?.trim() === 'docker';

export function judgeStatus(facts: StatusFacts): Check[] {
  const checks: Check[] = [];
  const { env } = facts;
  const prebuilt = Boolean(env?.MELETE_IMAGE_TAG?.trim());
  const profile = sandboxOn(env) ? ' --profile sandbox' : '';

  checks.push(
    facts.docker.length === 0
      ? { level: 'ok', name: 'Docker', detail: facts.dockerVersions }
      : {
          level: 'fail',
          name: 'Docker',
          detail: facts.docker.join(' '),
          fix: 'Install or start Docker Engine 28 or newer with Compose 2.33.1 or newer, then run this again.',
        },
  );

  if (facts.freeBytes === null)
    checks.push({
      level: 'warn',
      name: 'Disk',
      detail: 'Could not measure the free space where Docker keeps its images.',
    });
  else {
    const free = `${(facts.freeBytes / GB).toFixed(1)} GB free where Docker keeps its images`;
    checks.push(
      facts.freeBytes >= MIN_FREE_BYTES
        ? { level: 'ok', name: 'Disk', detail: free }
        : {
            level: facts.freeBytes >= UPDATE_FREE_BYTES ? 'warn' : 'fail',
            name: 'Disk',
            detail: `${free}; a first install needs 10 GB.`,
            fix: 'Free space first, for example with docker builder prune -af and docker image prune -f.',
          },
    );
  }

  if (env === null) {
    checks.push({
      level: 'fail',
      name: 'Configuration',
      detail: 'There is no deploy/.env yet.',
      fix: 'Run bun run deploy/scripts/configure.ts --connect-in-app (or with a provider key in the environment).',
    });
    return checks;
  }
  checks.push({
    level: 'ok',
    name: 'Configuration',
    detail: `deploy/.env for project ${env.COMPOSE_PROJECT_NAME?.trim() || 'melete'}, ${
      prebuilt ? `published images at ${env.MELETE_IMAGE_TAG?.trim()}` : 'images built here'
    }`,
  });

  checks.push(judgeModel(env));
  // Everything below asks the engine; without one, the Docker line is the whole story.
  if (facts.docker.length > 0) return checks;

  if (facts.images === null)
    checks.push({
      level: 'fail',
      name: 'Images',
      detail: 'Compose could not read deploy/docker-compose.yml with deploy/.env.',
      fix: `Run ${COMPOSE} config --quiet to see why.`,
    });
  else {
    const missing = facts.images.filter((image) => !image.present).map((image) => image.name);
    checks.push(
      missing.length === 0
        ? { level: 'ok', name: 'Images', detail: `${facts.images.length} present` }
        : {
            level: 'fail',
            name: 'Images',
            detail: `Missing: ${missing.join(', ')}`,
            fix: prebuilt
              ? `Run ${COMPOSE}${profile} pull`
              : `Run ${COMPOSE}${profile} up -d --build --wait --wait-timeout 300, or set MELETE_IMAGE_TAG=main in deploy/.env to pull them instead.`,
          },
    );
  }

  const start = `${COMPOSE}${profile} up -d ${prebuilt ? '--no-build' : '--build'} --wait --wait-timeout 300`;
  if (facts.services === null)
    checks.push({
      level: 'fail',
      name: 'Services',
      detail: 'Compose could not list the containers.',
      fix: `Run ${COMPOSE} ps to see why.`,
    });
  else {
    const byName = new Map(facts.services.map((service) => [service.service, service]));
    const notStarted = SERVICES.filter((name) => !byName.has(name));
    const states = SERVICES.flatMap((name) => {
      const service = byName.get(name);
      return service ? [service] : [];
    });
    const broken = states.filter(
      (service) => service.state !== 'running' || service.health === 'unhealthy',
    );
    const starting = states.filter(
      (service) => service.state === 'running' && service.health === 'starting',
    );
    if (notStarted.length === SERVICES.length)
      checks.push({ level: 'fail', name: 'Services', detail: 'Not started.', fix: `Run ${start}` });
    else if (notStarted.length > 0 || broken.length > 0)
      checks.push({
        level: 'fail',
        name: 'Services',
        detail: [
          ...notStarted.map((name) => `${name} not started`),
          ...broken.map(
            (service) =>
              `${service.service} ${service.health === 'unhealthy' ? 'unhealthy' : service.state}`,
          ),
        ].join(', '),
        fix: `Read ${COMPOSE} logs --tail=100 for the reason, then run ${start}`,
      });
    else if (starting.length > 0)
      checks.push({
        level: 'warn',
        name: 'Services',
        detail: `Still starting: ${starting.map((service) => service.service).join(', ')}`,
        fix: 'Wait a minute and run this again.',
      });
    else checks.push({ level: 'ok', name: 'Services', detail: `${SERVICES.join(', ')} healthy` });
  }

  const address = `http://localhost:${webPort(env)}`;
  if (facts.health === null)
    checks.push({
      level: 'fail',
      name: 'API',
      detail: `Nothing answered at ${address}/api/health.`,
      fix: 'Start the stack, or check WEB_PORT in deploy/.env.',
    });
  else if (facts.health.status !== 'ok')
    checks.push({
      level: 'fail',
      name: 'API',
      detail: `It answers, but reports ${facts.health.status ?? 'no status'} (database ${facts.health.database ?? 'unknown'}).`,
      fix: `Read ${COMPOSE} logs --tail=100 melete postgres`,
    });
  else checks.push({ level: 'ok', name: 'API', detail: `${address} answers` });

  if (facts.setupNeeded === true)
    checks.push({
      level: 'warn',
      name: 'Account',
      detail: 'No account yet.',
      fix: `Open ${address} and create your account.`,
    });
  else if (facts.setupNeeded === false)
    checks.push({ level: 'ok', name: 'Account', detail: 'The owner account exists.' });

  if (sandboxOn(env)) {
    const sandbox = facts.images?.find((image) => /melete-sandbox:/.test(image.name));
    checks.push(
      sandbox?.present
        ? { level: 'ok', name: 'Computer', detail: 'On; its image is present.' }
        : {
            level: 'fail',
            name: 'Computer',
            detail: 'MELETE_SANDBOX_PROVIDER=docker, but the computer image is missing.',
            fix: `Run ${COMPOSE} --profile sandbox ${prebuilt ? 'pull' : 'build sandbox-image'}`,
          },
    );
  } else checks.push({ level: 'ok', name: 'Computer', detail: 'Off (optional).' });

  checks.push({
    level: 'ok',
    name: 'Voice',
    detail: isSet(env, 'ELEVENLABS_API_KEY') ? 'On.' : 'Off (optional).',
  });

  const publicUrl = env.MELETE_PUBLIC_URL?.trim();
  checks.push({
    level: 'ok',
    name: 'Public address',
    detail: publicUrl
      ? `${publicUrl}; other assistants connect at ${publicUrl.replace(/\/$/, '')}/api/mcp`
      : 'None set (optional).',
  });

  return checks;
}

/** The model as deploy/.env sets it. A key pasted into the app is not visible from here. */
export function judgeModel(env: Record<string, string>): Check {
  const provider = env.MELETE_DEFAULT_PROVIDER?.trim() ?? '';
  const model = env.MELETE_DEFAULT_MODEL?.trim() ?? '';
  if (provider === 'fake' && env.MELETE_ENABLE_FAKE_PROVIDER === 'true')
    return {
      level: 'warn',
      name: 'Model',
      detail: 'The practice model is on.',
      fix: 'Connect a real model in Settings › Models, then turn MELETE_ENABLE_FAKE_PROVIDER and MELETE_ENABLE_TEST_CONNECTOR off in deploy/.env.',
    };
  const warnings = providerWarnings(env);
  const fatal = warnings.filter((warning) => warning.includes('will not start'));
  if (fatal.length > 0)
    return { level: 'fail', name: 'Model', detail: fatal.join(' '), fix: 'Fix deploy/.env.' };
  if (warnings.length > 0)
    return {
      level: 'warn',
      name: 'Model',
      detail: `${provider} is the default, with no key in deploy/.env.`,
      fix: 'Connect a model in Settings › Models. A key saved there is not visible to this check.',
    };
  return { level: 'ok', name: 'Model', detail: `${provider}, ${model}, key set` };
}

/** `docker compose ps --format json` prints one object per line, or one array on older releases. */
export function parseComposePs(stdout: string): ServiceState[] {
  const text = stdout.trim();
  if (!text) return [];
  const rows: unknown[] = text.startsWith('[')
    ? JSON.parse(text)
    : text.split(/\r?\n/).flatMap((line) => (line.trim() ? [JSON.parse(line)] : []));
  return rows.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return [];
    const record = row as Record<string, unknown>;
    if (typeof record.Service !== 'string') return [];
    return [
      {
        service: record.Service,
        state: String(record.State ?? ''),
        health: String(record.Health ?? ''),
      },
    ];
  });
}

/** The available kilobytes in the second line of `df -Pk`. */
export function parseDfAvailable(stdout: string): number | null {
  const fields = stdout.trim().split(/\r?\n/)[1]?.trim().split(/\s+/);
  const available = Number(fields?.[3]);
  return Number.isFinite(available) ? available * 1024 : null;
}

export function render(checks: readonly Check[]): string {
  const width = Math.max(...checks.map((check) => check.name.length));
  const lines = checks.flatMap((check) => [
    `  ${check.level.padEnd(4)}  ${check.name.padEnd(width)}  ${check.detail}`,
    ...(check.fix ? [`        ${' '.repeat(width)}  -> ${check.fix}`] : []),
  ]);
  const failed = checks.filter((check) => check.level === 'fail').length;
  const waiting = checks.filter((check) => check.level === 'warn').length;
  lines.push(
    failed > 0
      ? `Not ready: ${failed} check(s) failed.`
      : waiting > 0
        ? `Running, with ${waiting} thing(s) to finish.`
        : 'Ready.',
  );
  return `${lines.join('\n')}\n`;
}

type Run = (command: readonly string[]) => CommandOutput;

function freeSpace(run: Run, images: StatusFacts['images']): number | null {
  const root = run(['docker', 'info', '--format', '{{.DockerRootDir}}']);
  const dir = root.stdout.trim();
  if (root.code !== 0 || !dir) return null;
  if (existsSync(dir)) {
    try {
      const stats = statfsSync(dir);
      return stats.bavail * stats.bsize;
    } catch {
      return null;
    }
  }
  // An engine in a VM or on another machine: measured from a container there,
  // with the stack's own Postgres image when the engine already has it.
  const probe = images?.find((image) => image.present && image.name.startsWith('postgres:'));
  if (!probe) return null;
  const df = run([
    'docker',
    'run',
    '--rm',
    '--network',
    'none',
    '-v',
    `${dir}:/docker-root:ro`,
    '--entrypoint',
    'df',
    probe.name,
    '-Pk',
    '/docker-root',
  ]);
  return df.code === 0 ? parseDfAvailable(df.stdout) : null;
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function gatherStatus(
  root: string,
  composeArgs: readonly string[],
  run: Run = spawnCommand,
): Promise<StatusFacts> {
  const outputs = readHostDocker();
  const docker = judgeDockerMachine(outputs, readDockerHost(spawnCommand, root));
  const dockerVersions = `Engine ${outputs.engine.stdout.trim().split(' ')[1] ?? '?'}, Compose ${outputs.compose.stdout.trim() || '?'}`;
  const envPath = resolve(root, 'deploy/.env');
  const env = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : null;
  const compose = [
    'docker',
    'compose',
    '-f',
    resolve(root, 'deploy/docker-compose.yml'),
    ...(sandboxOn(env) ? ['--profile', 'sandbox'] : []),
    ...composeArgs,
  ];
  let images: StatusFacts['images'] = null;
  let services: StatusFacts['services'] = null;
  if (env !== null && docker.length === 0) {
    const listed = run([...compose, 'config', '--images']);
    if (listed.code === 0)
      images = [...new Set(listed.stdout.split(/\r?\n/).filter(Boolean))].map((name) => ({
        name,
        present: run(['docker', 'image', 'inspect', '--format', '{{.Id}}', name]).code === 0,
      }));
    const ps = run([...compose, 'ps', '--all', '--format', 'json']);
    if (ps.code === 0) {
      try {
        services = parseComposePs(ps.stdout);
      } catch {
        services = null;
      }
    }
  }
  const base = `http://127.0.0.1:${webPort(env)}/api`;
  const health = env === null ? null : await getJson(`${base}/health`);
  const setup = health === null ? null : await getJson(`${base}/setup`);
  return {
    docker,
    dockerVersions,
    env,
    freeBytes: docker.length === 0 ? freeSpace(run, images) : null,
    images,
    services,
    health: health as StatusFacts['health'],
    setupNeeded: typeof setup?.needed === 'boolean' ? setup.needed : null,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const facts = await gatherStatus(
    resolve(import.meta.dir, '../..'),
    args.filter((arg) => arg !== '--json'),
  );
  const checks = judgeStatus(facts);
  const ready = !checks.some((check) => check.level === 'fail');
  process.stdout.write(json ? `${JSON.stringify({ ready, checks }, null, 2)}\n` : render(checks));
  process.exit(ready ? 0 : 1);
}
