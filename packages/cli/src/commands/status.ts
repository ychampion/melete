/**
 * `melete status`: the installation's readable report, from
 * deploy/scripts/status.ts, run with the contract's overlay files and profiles
 * and judged against its disk floor rather than the fixed 4 GB.
 */
import {
  type Check,
  type DiskFloors,
  gatherStatus,
  judgeStatus,
  MIN_FREE_BYTES,
} from '../../../../deploy/scripts/status.ts';
import type { Context } from '../context.ts';
import { composeFiles, type DeployConfig } from '../deploy-config.ts';
import { readInstallation } from '../installation.ts';
import { EXIT, type ExitCode, type Result, renderReport, report } from '../schema.ts';
import { judgeContract } from './check.ts';

const MB = 1024 ** 2;

export const diskFloors = (config: DeployConfig): DiskFloors => ({
  failBelowBytes: config.disk.min_free_mb * MB,
  warnBelowBytes: MIN_FREE_BYTES,
});

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

export async function runStatus(context: Context, json: boolean): Promise<ExitCode> {
  const installation = readInstallation(context.deployDir, context.machine.platform);
  const facts = await gatherStatus(
    context.root,
    statusComposeArgs(context.deployDir, installation.config),
    context.run,
  );
  const results = [
    judgeContract(installation),
    ...judgeStatus(facts, diskFloors(installation.config)).map(asResult),
  ];
  const value = report('status', results);
  context.out(
    json ? `${JSON.stringify({ ...value, ready: value.ok }, null, 2)}\n` : renderReport(value),
  );
  return value.ok ? EXIT.ok : EXIT.failed;
}
