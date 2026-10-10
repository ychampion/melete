/**
 * `melete set NAME=value ...`, `melete set --from-env NAME ...` and
 * `melete set --clear NAME ...`: change settings in deploy/.env in place, with
 * deploy/scripts/set-env.ts's rules: a secret is only taken from the
 * environment and never printed, and the file is replaced in one rename. A name
 * Melete does not read is refused, with the closest one it does, unless
 * `--force`; after a change it says which services to recreate. When the setting is one the deploy contract also
 * records (the image tag, the registry, the project), melete.deploy.json is
 * updated to match, so `check` keeps agreeing with what will run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { envSchema } from '../../../../apps/melete/src/env.ts';
import { parseEnvFile } from '../../../../deploy/scripts/provider-settings.ts';
import {
  describe,
  requestedSettings,
  SetEnvRefusal,
  withSetting,
} from '../../../../deploy/scripts/set-env.ts';
import {
  ENV_FILE_MODE,
  type FileReplacer,
  fileReplacer,
  replaceFile,
} from '../../../../deploy/scripts/tailscale-origin.ts';
import type { Context } from '../context.ts';
import {
  composeCommand,
  DEPLOY_FILE,
  deployConfigSchema,
  parseDeployConfig,
  renderDeployConfig,
} from '../deploy-config.ts';
import { type Installation, imagesFromEnv, readInstallation } from '../installation.ts';
import { LockRefusal, withLock } from '../lock.ts';
import { EXIT, type ExitCode } from '../schema.ts';

/** Settings the contract records too. */
export const CONTRACT_SETTINGS = [
  'MELETE_IMAGE_TAG',
  'MELETE_IMAGE_REGISTRY',
  'COMPOSE_PROJECT_NAME',
];

/**
 * Every name a setting may have: the template's, any Compose file's
 * substitutions, the service's own schema, and what deploy/.env already holds.
 */
export function knownSettings(installation: Installation, template: string): Set<string> {
  const names = new Set<string>([
    ...Object.keys(parseEnvFile(template)),
    ...Object.keys(envSchema.in.shape),
    ...Object.keys(installation.env ?? {}),
  ]);
  for (const read of installation.compose)
    for (const match of JSON.stringify(read.raw ?? {}).matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g))
      if (match[1]) names.add(match[1]);
  return names;
}

/** The known name a typo is closest to, when it is close. */
export function closestSetting(name: string, known: Iterable<string>): string | null {
  let best: { name: string; distance: number } | null = null;
  for (const candidate of known) {
    const distance = editDistance(name, candidate);
    if (!best || distance < best.distance) best = { name: candidate, distance };
  }
  return best && best.distance <= Math.max(2, Math.floor(name.length / 6)) ? best.name : null;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1)
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** The services whose definition reads one of the names, in the order Compose lists them. */
export function servicesReading(installation: Installation, names: readonly string[]): string[] {
  const services = new Set<string>();
  for (const read of installation.compose)
    for (const [service, definition] of Object.entries(
      (read.raw as { services?: Record<string, unknown> } | null)?.services ?? {},
    )) {
      const text = JSON.stringify(definition);
      if (names.some((name) => new RegExp(`\\$\\{${name}[:}?+-]`).test(text)))
        services.add(service);
    }
  return [...services];
}

/**
 * How a change reaches the running stack. Compose reads deploy/.env when it
 * creates a container, so `restart` keeps the old values; the services that
 * read a setting are recreated instead.
 */
export function applyHint(installation: Installation, names: readonly string[]): string {
  if (names.some((name) => CONTRACT_SETTINGS.includes(name)))
    return 'Apply it with bun run melete deploy.\n';
  const services = servicesReading(installation, names);
  if (services.length === 0)
    return 'No service reads it from deploy/.env, so nothing needs to restart.\n';
  const compose = composeCommand(installation.deployDir, installation.config)
    .map((part) => (/\s/.test(part) ? `'${part}'` : part))
    .join(' ');
  return `Apply it by recreating ${services.join(', ')} (docker compose restart keeps the old values):\n  ${compose} up -d --force-recreate ${services.join(' ')}\n`;
}

/** The contract's new text after deploy/.env changes, or null when it needs no change. */
export function contractAfter(contractText: string, envText: string): string | null {
  const loaded = parseDeployConfig(contractText);
  if (loaded.kind !== 'found')
    throw new SetEnvRefusal(
      `${DEPLOY_FILE} is not valid (${loaded.kind === 'invalid' ? loaded.issues.join('; ') : 'missing'}); correct it before changing these settings.`,
    );
  const env = parseEnvFile(envText);
  const next = deployConfigSchema.parse({
    ...loaded.config,
    project: env.COMPOSE_PROJECT_NAME?.trim() || 'melete',
    images: imagesFromEnv(env),
  });
  const text = renderDeployConfig(next);
  return text === renderDeployConfig(loaded.config) ? null : text;
}

export async function runSet(
  context: Context,
  args: readonly string[],
  environment: Record<string, string | undefined> = process.env,
  file: FileReplacer = fileReplacer,
): Promise<ExitCode> {
  const envPath = join(context.deployDir, '.env');
  const contractPath = join(context.deployDir, DEPLOY_FILE);
  let settings: ReturnType<typeof requestedSettings>;
  const force = args.includes('--force');
  try {
    settings = requestedSettings(
      args.filter((arg) => arg !== '--force'),
      environment,
    );
    if (!existsSync(envPath))
      throw new SetEnvRefusal('There is no deploy/.env yet. Run bun run melete init first.');
    // A misspelt name would be written and silently do nothing.
    const templatePath = join(context.deployDir, '.env.example');
    if (!force && existsSync(templatePath)) {
      const known = knownSettings(
        readInstallation(context.deployDir, context.machine.platform),
        readFileSync(templatePath, 'utf8'),
      );
      const unknown = settings.filter((setting) => !known.has(setting.name));
      if (unknown.length > 0)
        throw new SetEnvRefusal(
          `${unknown
            .map((setting) => {
              const near = closestSetting(setting.name, known);
              return `${setting.name} is not a setting Melete reads${near ? `; did you mean ${near}?` : '.'}`;
            })
            .join(
              ' ',
            )} Nothing was changed. Pass --force to write a name of your own, for example one an overlay file reads.`,
        );
    }
    // A new project name points every Compose command at a new, empty installation.
    const renamed = settings.find((setting) => setting.name === 'COMPOSE_PROJECT_NAME');
    const current =
      parseEnvFile(readFileSync(envPath, 'utf8')).COMPOSE_PROJECT_NAME?.trim() || 'melete';
    if (renamed && renamed.value.trim() !== current && !force) {
      const listed = context.run([
        'docker',
        'ps',
        '--all',
        '--quiet',
        '--filter',
        `label=com.docker.compose.project=${current}`,
      ]);
      if (listed.code !== 0 || listed.stdout.trim() !== '')
        throw new SetEnvRefusal(
          `Compose project ${current} ${listed.code === 0 ? 'has containers' : 'could not be checked'}; renaming it to ${renamed.value} would leave them running and point every command at a new, empty installation with its own database. Nothing was changed. Stop and remove the old stack first, or pass --force if a new installation is what you want.`,
        );
    }
  } catch (error) {
    if (!(error instanceof SetEnvRefusal)) throw error;
    context.err(
      `${error.message.replace('bun run deploy/scripts/set-env.ts', 'bun run melete set')}\n`,
    );
    return EXIT.refused;
  }
  try {
    return await withLock(context.deployDir, 'set', async () => {
      let text = readFileSync(envPath, 'utf8');
      for (const setting of settings) text = withSetting(text, setting.name, setting.value);
      // The contract is worked out before anything is written, so a refusal changes nothing.
      const touchesContract = settings.some((setting) => CONTRACT_SETTINGS.includes(setting.name));
      const contract =
        touchesContract && existsSync(contractPath)
          ? contractAfter(readFileSync(contractPath, 'utf8'), text)
          : null;
      await replaceFile(envPath, text, file, ENV_FILE_MODE);
      for (const setting of settings) context.out(`${describe(setting)}\n`);
      context.out(
        applyHint(
          readInstallation(context.deployDir, context.machine.platform),
          settings.map((setting) => setting.name),
        ),
      );
      if (contract === null) return EXIT.ok;
      try {
        await replaceFile(contractPath, contract, file, 0o644);
      } catch (error) {
        context.err(
          `deploy/.env was changed, but ${DEPLOY_FILE} could not be updated to match (${error instanceof Error ? error.message : error}). Correct it by hand, then run bun run melete check.\n`,
        );
        return EXIT.partial;
      }
      context.out(`Updated ${DEPLOY_FILE} to match.\n`);
      return EXIT.ok;
    });
  } catch (error) {
    if (error instanceof SetEnvRefusal || error instanceof LockRefusal) {
      context.err(`${error.message}\n`);
      return EXIT.refused;
    }
    throw error;
  }
}
