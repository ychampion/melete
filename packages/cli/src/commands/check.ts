/**
 * `melete check`: whether the installation's files describe a stack that can
 * start safely, judged from the files alone. It reads deploy/melete.deploy.json,
 * deploy/.env and the Compose files, and asks neither Docker nor the network.
 */
import { readEnv } from '../../../../apps/melete/src/env.ts';
import { type ComposeFile, checkCompose } from '../../../../deploy/scripts/compose-check.ts';
import { judgeModel } from '../../../../deploy/scripts/status.ts';
import type { Context } from '../context.ts';
import {
  BLOBS_S3_FILE,
  DEFAULT_REGISTRY,
  DEPLOY_FILE,
  type DeployConfig,
  EXTERNAL_DB_FILE,
  OVERLAY_FILES,
} from '../deploy-config.ts';
import {
  deployFilePresent,
  envImageTag,
  type Installation,
  isLoopback,
  publishedPorts,
  readInstallation,
  serviceEnvironment,
  settingId,
} from '../installation.ts';
import { EXIT, type ExitCode, type Report, type Result, renderReport, report } from '../schema.ts';

const ADOPT = 'Run bun run melete init --adopt to write it from the running stack.';

/** The contract's own rule: whether the file is there and readable. */
export function judgeContract(installation: Installation): Result {
  const { loaded } = installation;
  if (loaded.kind === 'found')
    return { id: 'deploy.contract', level: 'ok', detail: `${DEPLOY_FILE}, contract 1` };
  if (loaded.kind === 'missing')
    return {
      id: 'deploy.contract',
      level: 'warn',
      detail: `There is no ${DEPLOY_FILE}; judged with what deploy/.env implies.`,
      fix: ADOPT,
    };
  return {
    id: 'deploy.contract',
    level: 'fail',
    detail: `${DEPLOY_FILE} is not valid: ${loaded.issues.join('; ')}`,
    fix: `Correct ${DEPLOY_FILE}; docs/DEPLOYMENT.md lists each key.`,
  };
}

export function judgeCheck(installation: Installation): Result[] {
  const results: Result[] = [judgeContract(installation)];
  const { env } = installation;
  if (env === null) {
    results.push({
      id: 'env.file',
      level: 'fail',
      detail: 'There is no deploy/.env.',
      fix: 'Run bun run melete init.',
    });
    return results;
  }
  results.push({ id: 'env.file', level: 'ok', detail: 'deploy/.env is present.' });
  if (installation.envMode !== null && (installation.envMode & 0o077) !== 0)
    results.push({
      id: 'env.file_private',
      level: 'warn',
      detail: `deploy/.env has mode ${installation.envMode.toString(8)}, so other accounts on this machine can read its keys.`,
      fix: 'Run chmod 600 deploy/.env.',
    });

  const unreadable = installation.compose.filter((read) => read.resolved === null);
  results.push(
    unreadable.length === 0
      ? {
          id: 'compose.files',
          level: 'ok',
          detail: `${installation.compose.length} Compose file(s) read.`,
        }
      : {
          id: 'compose.files',
          level: 'fail',
          detail: unreadable.map((read) => `${read.file}: ${read.error}`).join('; '),
          fix: `Restore the file, or remove its overlay from ${DEPLOY_FILE}.`,
        },
  );

  // A variable Compose requires is one `up` would refuse; each is named, never shown.
  for (const missing of installation.missing)
    results.push({
      id: `env.${settingId(missing.name)}`,
      level: 'fail',
      detail: `${missing.name} is empty in deploy/.env, and Compose will not start the stack without it.`,
      fix: /(KEY|TOKEN|SECRET|PASSWORD)$/.test(missing.name)
        ? `Export it in this terminal and run bun run melete set --from-env ${missing.name}.`
        : `Run bun run melete set ${missing.name}=<value>.`,
    });
  if (/CHANGE_ME/.test(env.DATABASE_URL ?? ''))
    results.push({
      id: 'env.database_url',
      level: 'fail',
      detail: 'DATABASE_URL still holds the template password.',
      fix: 'Run bun run melete init on a fresh deploy/.env, which sets the password and the URL together.',
    });

  results.push(...judgeServiceSettings(installation));
  const model = judgeModel(env);
  results.push({
    id: 'env.model',
    level: model.level,
    detail: model.detail,
    ...(model.fix ? { fix: model.fix } : {}),
  });

  results.push(...judgeContractAgainstEnv(installation));
  results.push(judgePorts(installation));

  const base = installation.compose[0]?.raw;
  if (base) {
    const boundary = checkCompose(base as ComposeFile);
    const failed = boundary.filter((check) => !check.ok);
    results.push(
      failed.length === 0
        ? {
            id: 'compose.boundaries',
            level: 'ok',
            detail: `${boundary.length} boundary checks pass.`,
          }
        : {
            id: 'compose.boundaries',
            level: 'fail',
            detail: failed.map((check) => check.name).join('; '),
            fix: 'Restore deploy/docker-compose.yml from the release, then run this again.',
          },
    );
  }
  return results;
}

/** The service's own schema, given the environment Compose would hand it. */
function judgeServiceSettings(installation: Installation): Result[] {
  const environment = serviceEnvironment(installation, 'melete');
  if (Object.keys(environment).length === 0) return [];
  const parsed = readEnv(environment);
  if (parsed.ok)
    return [{ id: 'env.service', level: 'ok', detail: 'The service accepts its settings.' }];
  const reported = new Set(installation.missing.map((missing) => missing.name));
  return parsed.issues
    .filter((issue) => !reported.has(issue.split(':')[0] ?? ''))
    .map((issue) => {
      const name = issue.split(':')[0] ?? '';
      return {
        id: `env.service.${settingId(name) || 'settings'}`,
        level: 'fail' as const,
        detail: `The service would refuse to start: ${issue}`,
        fix: `Correct ${name} in deploy/.env.`,
      };
    });
}

/** Whether deploy/.env runs what the contract says. */
function judgeContractAgainstEnv(installation: Installation): Result[] {
  const { env, config } = installation;
  if (env === null) return [];
  const results: Result[] = [];
  const project = env.COMPOSE_PROJECT_NAME?.trim() || 'melete';
  results.push(
    project === config.project
      ? { id: 'project.matches_env', level: 'ok', detail: `Compose project ${project}` }
      : {
          id: 'project.matches_env',
          level: 'fail',
          detail: `${DEPLOY_FILE} names project ${config.project}, but deploy/.env runs ${project}.`,
          fix: `Make COMPOSE_PROJECT_NAME and "project" agree.`,
        },
  );

  const tag = envImageTag(env);
  const registrySet = config.images.registry !== null || Boolean(env.MELETE_IMAGE_REGISTRY?.trim());
  if (tag === 'local' && registrySet)
    results.push({
      id: 'images.tag_not_local',
      level: 'fail',
      detail: `A registry is set (${config.images.registry ?? env.MELETE_IMAGE_REGISTRY}), but the image tag is local, which names images built on this machine.`,
      fix: `Run bun run melete set MELETE_IMAGE_TAG=${config.images.tag === 'local' ? 'main' : config.images.tag}.`,
    });
  else {
    results.push(
      tag === config.images.tag
        ? { id: 'images.tag_matches_contract', level: 'ok', detail: `Images at ${tag}` }
        : {
            id: 'images.tag_matches_contract',
            level: 'fail',
            detail: `${DEPLOY_FILE} says ${config.images.tag}, but deploy/.env runs ${tag}.`,
            fix: `Run bun run melete set MELETE_IMAGE_TAG=${config.images.tag === 'local' ? '' : config.images.tag}, or correct ${DEPLOY_FILE}.`,
          },
    );
    if (config.images.registry !== null) {
      const registry = env.MELETE_IMAGE_REGISTRY?.trim() || DEFAULT_REGISTRY;
      results.push(
        registry === config.images.registry
          ? { id: 'images.registry_matches_contract', level: 'ok', detail: `From ${registry}` }
          : {
              id: 'images.registry_matches_contract',
              level: 'fail',
              detail: `${DEPLOY_FILE} names ${config.images.registry}, but deploy/.env pulls from ${registry}.`,
              fix: `Run bun run melete set MELETE_IMAGE_REGISTRY=${config.images.registry}.`,
            },
      );
    }
  }

  if (env.MELETE_SANDBOX_PROVIDER?.trim() === 'docker' && !config.profiles.includes('sandbox'))
    results.push({
      id: 'profiles.sandbox',
      level: 'warn',
      detail:
        'MELETE_SANDBOX_PROVIDER=docker, but the sandbox profile is not listed, so its image is not pulled with the rest.',
      fix: `Add "sandbox" to "profiles" in ${DEPLOY_FILE}.`,
    });

  const overlay = (name: string, file: string, key: string) =>
    results.push(
      deployFilePresent(installation.deployDir, file)
        ? { id: `${key}.supported`, level: 'ok', detail: `${name} is described by ${file}.` }
        : {
            id: `${key}.supported`,
            level: 'fail',
            detail: `${DEPLOY_FILE} asks for ${name}, and this checkout has no deploy/${file} to run it with.`,
            fix: `Update the checkout to a release that has it, or turn it off in ${DEPLOY_FILE}.`,
          },
    );
  if (config.database.external) overlay('an external database', EXTERNAL_DB_FILE, 'database');
  results.push(...judgeDatabaseUrl(config, env));
  if (config.blobs.store === 's3') overlay('an S3-compatible blob store', BLOBS_S3_FILE, 'blobs');
  results.push(...judgeBlobs(config, env));
  if (config.cells.hosts.length > 0)
    overlay('remote cell hosts', 'docker-compose.cells.yml', 'cells');
  for (const name of config.overlays)
    if (!deployFilePresent(installation.deployDir, OVERLAY_FILES[name]))
      results.push({
        id: 'compose.overlays',
        level: 'fail',
        detail: `The ${name} overlay needs deploy/${OVERLAY_FILES[name]}, which is missing.`,
      });
  return results;
}

/** The TLS modes that refuse a connection the server will not encrypt. */
const TLS_MODES = new Set(['require', 'verify-ca', 'verify-full']);

/**
 * Where DATABASE_URL points, judged against `database.external`. Only the host
 * is ever named: the URL holds the password.
 */
export function judgeDatabaseUrl(config: DeployConfig, env: Record<string, string>): Result[] {
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL?.trim() ?? '');
  } catch {
    return config.database.external
      ? [
          {
            id: 'database.external_url',
            level: 'fail',
            detail: 'DATABASE_URL is not a postgres:// URL.',
            fix: 'Export the URL your provider gives in this terminal and run bun run melete set --from-env DATABASE_URL.',
          },
        ]
      : [];
  }
  const bundled = url.hostname === 'postgres';
  if (!config.database.external)
    return bundled
      ? []
      : [
          {
            id: 'database.external_url',
            level: 'warn',
            detail: `DATABASE_URL names ${url.hostname}, but ${DEPLOY_FILE} has database.external false, so the bundled postgres runs beside it unused, and backups read the bundled one.`,
            fix: `Set "database": { "external": true } in ${DEPLOY_FILE}.`,
          },
        ];
  if (bundled)
    return [
      {
        id: 'database.external_url',
        level: 'fail',
        detail: `${DEPLOY_FILE} asks for an external database, but DATABASE_URL still names the bundled postgres, which then stays off.`,
        fix: 'Export the URL your provider gives in this terminal and run bun run melete set --from-env DATABASE_URL.',
      },
    ];
  const mode = url.searchParams.get('sslmode') ?? '';
  return [
    { id: 'database.external_url', level: 'ok', detail: `The database is at ${url.hostname}.` },
    TLS_MODES.has(mode)
      ? { id: 'database.tls', level: 'ok', detail: `DATABASE_URL asks for TLS (sslmode=${mode}).` }
      : {
          id: 'database.tls',
          level: 'fail',
          detail: `DATABASE_URL ${mode ? `has sslmode=${mode}, which` : 'sets no sslmode, so it'} would let the connection to ${url.hostname} go unencrypted.`,
          fix: 'End DATABASE_URL with ?sslmode=require (or verify-full with the provider certificate), then set it again with bun run melete set --from-env DATABASE_URL.',
        },
  ];
}

/** The bucket settings deploy/.env holds, judged against the contract's `blobs`. */
export function judgeBlobs(config: DeployConfig, env: Record<string, string>): Result[] {
  const value = (name: string) => env[name]?.trim() ?? '';
  const store = value('MELETE_BLOB_STORE') || 'local';
  if (config.blobs.store === 'local')
    return store === 'local'
      ? []
      : [
          {
            id: 'blobs.matches_env',
            level: 'fail',
            detail: `deploy/.env sets MELETE_BLOB_STORE=${store}, but ${DEPLOY_FILE} keeps blobs on the artifacts volume.`,
            fix: `Describe the bucket under "blobs" in ${DEPLOY_FILE}, or run bun run melete set MELETE_BLOB_STORE=local.`,
          },
        ];
  const { bucket, endpoint, region } = config.blobs;
  const differs = [
    ['MELETE_BLOB_S3_BUCKET', bucket],
    ['MELETE_BLOB_S3_ENDPOINT', endpoint ?? ''],
    ...(region ? [['MELETE_BLOB_S3_REGION', region] as const] : []),
  ].filter(([name, wanted]) => value(name as string) !== wanted);
  const results: Result[] = [
    differs.length === 0
      ? {
          id: 'blobs.matches_env',
          level: 'ok',
          detail: `Blobs go to the bucket ${bucket}${endpoint ? ` at ${endpoint}` : ''}.`,
        }
      : {
          id: 'blobs.matches_env',
          level: 'fail',
          detail: `${DEPLOY_FILE} and deploy/.env name different buckets: ${differs.map(([name]) => name).join(', ')} differ.`,
          fix: `Run ${differs.map(([name, wanted]) => `bun run melete set ${name}=${wanted}`).join(' and ')}.`,
        },
  ];
  if (endpoint?.startsWith('http://'))
    results.push({
      id: 'blobs.tls',
      level: 'warn',
      detail: `${endpoint} is plain HTTP, so the blobs cross the network unencrypted.`,
      fix: 'Use the https:// address, unless the store runs on this machine or a private network.',
    });
  return results;
}

/** Every published port stays on loopback unless the contract allows otherwise. */
export function judgePorts(installation: Installation): Result {
  const exposed = publishedPorts(installation).filter((port) => !isLoopback(port.hostIp));
  const named = exposed
    .map((port) => `${port.service} on ${port.hostIp ?? 'every address'}:${port.published || '?'}`)
    .join(', ');
  if (exposed.length === 0)
    return {
      id: 'ports.loopback_only',
      level: 'ok',
      detail: 'Every published port is on 127.0.0.1.',
    };
  if (installation.config.public_ports)
    return {
      id: 'ports.loopback_only',
      level: 'warn',
      detail: `Published beyond this machine, as public_ports allows: ${named}.`,
    };
  return {
    id: 'ports.loopback_only',
    level: 'fail',
    detail: `Published beyond this machine: ${named}.`,
    fix: `Bind each to 127.0.0.1 and reach it through a proxy or Tailscale, or set "public_ports": true in ${DEPLOY_FILE} if that is intended.`,
  };
}

export function runCheck(context: Context, json: boolean): ExitCode {
  const installation = readInstallation(context.deployDir, context.machine.platform);
  const value: Report = report('check', judgeCheck(installation));
  context.out(json ? `${JSON.stringify(value, null, 2)}\n` : renderReport(value));
  return value.ok ? EXIT.ok : EXIT.failed;
}
