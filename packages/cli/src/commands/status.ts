/**
 * `melete status`: the installation's readable report, from
 * deploy/scripts/status.ts, run with the contract's overlay files and profiles
 * and judged against its disk floor rather than the fixed 4 GB.
 */
import {
  type Check,
  type DiskFloors,
  gatherStatus,
  judgeModel,
  judgeStatus,
  MIN_FREE_BYTES,
  SERVICES,
} from '../../../../deploy/scripts/status.ts';
import { type Context, inServiceImage } from '../context.ts';
import { composeFiles, type DeployConfig } from '../deploy-config.ts';
import { readInstallation } from '../installation.ts';
import { EXIT, type ExitCode, hostOnly, type Result, renderReport, report } from '../schema.ts';
import { judgeContract } from './check.ts';

const MB = 1024 ** 2;

export const diskFloors = (config: DeployConfig): DiskFloors => ({
  failBelowBytes: config.disk.min_free_mb * MB,
  warnBelowBytes: MIN_FREE_BYTES,
});

/** The long-running services the installation runs: postgres only when its database is the bundled one. */
export const statusServices = (config: DeployConfig): string[] =>
  SERVICES.filter((service) => !(config.database.external && service === 'postgres'));

/** The Compose options status.ts adds to its own `-f deploy/docker-compose.yml`. */
export function statusComposeArgs(deployDir: string, config: DeployConfig): string[] {
  return [
    ...composeFiles(deployDir, config)
      .slice(1)
      .flatMap((file) => ['-f', file]),
    ...config.profiles.flatMap((profile) => ['--profile', profile]),
  ];
}

/** A status check as a rule: `Public address` is `status.public_address`. */
export const asResult = (check: Check): Result => ({
  id: `status.${check.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
  level: check.level,
  detail: check.detail,
  ...(check.fix ? { fix: check.fix } : {}),
});

/** The rules that ask the host's engine or read its deploy file and deploy/.env. */
export const HOST_STATUS_RULES = [
  'deploy.contract',
  'status.docker',
  'status.disk',
  'status.configuration',
  'status.images',
  'status.services',
] as const;

export type ImageStatusFacts = {
  /** Where the service listens, as its own health check reaches it. */
  address: string;
  /** The service's /health answer; null when nothing answered. */
  health: { status?: string; database?: string } | null;
  /** Whether the owner account still has to be created; null when unknown. */
  setupNeeded: boolean | null;
};

/** The service's own address inside its container: its API bind name and port. */
export const serviceAddress = (environment: Context['environment']): string =>
  `http://${environment.MELETE_API_BIND?.trim() || 'melete-api'}:${environment.PORT?.trim() || '8787'}`;

/**
 * Inside the service image: the host's rules are skipped; the model is judged
 * from the settings the service runs with, and the API and the account are
 * asked of the service directly.
 */
export function judgeStatusInImage(
  facts: ImageStatusFacts,
  environment: Context['environment'],
): Result[] {
  const settings = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const checks: Check[] = [judgeModel(settings)];
  if (facts.health === null)
    checks.push({
      level: 'fail',
      name: 'API',
      detail: `Nothing answered at ${facts.address}/health.`,
      fix: 'Read docker compose -f deploy/docker-compose.yml logs --tail=100 melete on the host.',
    });
  else if (facts.health.status !== 'ok')
    checks.push({
      level: 'fail',
      name: 'API',
      detail: `It answers, but reports ${facts.health.status ?? 'no status'} (database ${facts.health.database ?? 'unknown'}).`,
      fix: 'Read docker compose -f deploy/docker-compose.yml logs --tail=100 melete postgres on the host.',
    });
  else checks.push({ level: 'ok', name: 'API', detail: `${facts.address} answers` });
  if (facts.setupNeeded === true)
    checks.push({
      level: 'warn',
      name: 'Account',
      detail: 'No account yet.',
      fix: 'Open the web app and create your account.',
    });
  else if (facts.setupNeeded === false)
    checks.push({ level: 'ok', name: 'Account', detail: 'The owner account exists.' });
  return [...HOST_STATUS_RULES.map(hostOnly), ...checks.map(asResult)];
}

async function askService(context: Context, url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await context.fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function gatherStatusInImage(context: Context): Promise<ImageStatusFacts> {
  const address = serviceAddress(context.environment);
  const health = await askService(context, `${address}/health`);
  const setup = health === null ? null : await askService(context, `${address}/setup`);
  return {
    address,
    health: health as ImageStatusFacts['health'],
    setupNeeded: typeof setup?.needed === 'boolean' ? setup.needed : null,
  };
}

export async function runStatus(context: Context, json: boolean): Promise<ExitCode> {
  const installation = readInstallation(context.deployDir, context.machine.platform);
  const results = inServiceImage(context.environment)
    ? judgeStatusInImage(await gatherStatusInImage(context), context.environment)
    : [
        judgeContract(installation),
        ...judgeStatus(
          await gatherStatus(
            context.root,
            statusComposeArgs(context.deployDir, installation.config),
            context.run,
          ),
          diskFloors(installation.config),
          statusServices(installation.config),
        ).map(asResult),
      ];
  const value = report('status', results);
  context.out(
    json ? `${JSON.stringify({ ...value, ready: value.ok }, null, 2)}\n` : renderReport(value),
  );
  return value.ok ? EXIT.ok : EXIT.failed;
}
