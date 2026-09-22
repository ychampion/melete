/**
 * Name each missing prerequisite once, before the suite turns it into fifty
 * opaque failures. `bun run doctor` prints the same list on demand. On a host
 * that only runs the stack, `bun run doctor --docker` judges the Docker Engine
 * and Compose alone; `MELETE_CONFORMANCE_COMPOSE=1` judges both, because the
 * deployment scenarios run the suite against that stack.
 *
 * The facts are gathered in one place and judged in a pure function so the
 * judgement can be tested on a machine that has everything installed.
 */
import { accessSync, constants, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  type CommandOutput,
  readHostDocker,
  spawnCommand,
} from '../../src/runtime/docker-engine.ts';
import {
  judgeDockerMachine,
  localMachine,
  type MachineAccess,
  readDockerHost,
} from '../../src/runtime/docker-host.ts';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../../../..');

export type PreflightFacts = {
  platform: NodeJS.Platform;
  uid: number | undefined;
  databaseUrl: string | undefined;
  tmpdirWritable: boolean;
  libpq: boolean;
  uv: boolean;
  /**
   * Problems with the host's Docker Engine and Compose, and with the machine
   * running them: Linux containers, Docker Desktop's memory, and on Windows the
   * named pipe and path lengths. Unset unless the deployment scenarios were
   * requested: nothing else in the suite uses Docker.
   */
  docker?: string[];
  /** `--docker` without the deployment scenarios: the suite's own prerequisites are not judged. */
  dockerOnly?: boolean;
};

const LIBPQ_PATHS = [
  '/usr/lib/x86_64-linux-gnu/libpq.so.5',
  '/usr/lib/aarch64-linux-gnu/libpq.so.5',
  '/usr/lib64/libpq.so.5',
  '/usr/lib/libpq.so.5',
  '/usr/local/lib/libpq.so.5',
];

export function gatherFacts(
  env: Record<string, string | undefined> = process.env,
  args: readonly string[] = process.argv.slice(2),
  runDocker: (command: readonly string[]) => CommandOutput = spawnCommand,
  machine: MachineAccess = { ...localMachine, env },
): PreflightFacts {
  const scenarios = env.MELETE_CONFORMANCE_COMPOSE === '1';
  const wantsDocker = scenarios || args.includes('--docker');
  let tmpdirWritable = true;
  try {
    accessSync(tmpdir(), constants.W_OK);
  } catch {
    tmpdirWritable = false;
  }
  return {
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    databaseUrl: env.DATABASE_URL,
    tmpdirWritable,
    libpq: process.platform !== 'linux' || LIBPQ_PATHS.some((path) => existsSync(path)),
    uv: Bun.which('uv') !== null,
    ...(wantsDocker
      ? {
          docker: judgeDockerMachine(
            readHostDocker(runDocker),
            readDockerHost(runDocker, REPOSITORY_ROOT, machine),
          ),
        }
      : {}),
    ...(wantsDocker && !scenarios ? { dockerOnly: true } : {}),
  };
}

/** One line per missing prerequisite; an empty list means the suite can start. */
export function missingPrerequisites(facts: PreflightFacts): string[] {
  if (facts.dockerOnly) return [...(facts.docker ?? [])];
  const missing: string[] = [];
  const embedded = !facts.databaseUrl;
  if (!facts.tmpdirWritable)
    missing.push(`TMPDIR (${tmpdir()}) is not writable; point TMPDIR at a directory you own.`);
  if (embedded && facts.uid === 0)
    missing.push(
      'tests are running as root; embedded Postgres refuses to start as root. Run as a non-root user, or set DATABASE_URL to a Postgres 17 you control.',
    );
  if (embedded && facts.platform === 'linux')
    missing.push(
      'DATABASE_URL is unset on Linux; the embedded Postgres build needs libpq5 and an ICU 60 runtime that current Debian and Ubuntu do not ship. Set DATABASE_URL to a Postgres 17 (the helpers create disposable databases on it).',
    );
  if (embedded && facts.platform === 'linux' && !facts.libpq)
    missing.push(
      'libpq5 is not installed (initdb fails with libpq.so.5 missing): apt install libpq5.',
    );
  if (!facts.uv)
    missing.push('uv is not on PATH; `bun run test:plugin` needs it (https://docs.astral.sh/uv/).');
  missing.push(...(facts.docker ?? []));
  return missing;
}

export function preflightReport(facts = gatherFacts()): string {
  const missing = missingPrerequisites(facts);
  if (missing.length === 0)
    return facts.dockerOnly
      ? 'doctor: every Docker Engine and Compose requirement is met.\n'
      : 'doctor: every test prerequisite is present.\n';
  return `doctor: ${missing.length} missing prerequisite(s):\n${missing.map((line) => `  - ${line}`).join('\n')}\n`;
}

if (import.meta.main) {
  const report = preflightReport();
  process.stdout.write(report);
  process.exit(report.startsWith('doctor: every') ? 0 : 1);
}
