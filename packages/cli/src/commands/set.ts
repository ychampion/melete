/**
 * `melete set NAME=value ...` and `melete set --from-env NAME ...`: change
 * settings in deploy/.env in place, with deploy/scripts/set-env.ts's rules: a
 * secret is only taken from the environment and never printed, and the file is
 * replaced in one rename. When the setting is one the deploy contract also
 * records (the image tag, the registry, the project), melete.deploy.json is
 * updated to match, so `check` keeps agreeing with what will run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  DEPLOY_FILE,
  deployConfigSchema,
  parseDeployConfig,
  renderDeployConfig,
} from '../deploy-config.ts';
import { imagesFromEnv } from '../installation.ts';
import { LockRefusal, withLock } from '../lock.ts';
import { EXIT, type ExitCode } from '../schema.ts';

/** Settings the contract records too. */
export const CONTRACT_SETTINGS = [
  'MELETE_IMAGE_TAG',
  'MELETE_IMAGE_REGISTRY',
  'COMPOSE_PROJECT_NAME',
];

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
  try {
    settings = requestedSettings(args, environment);
    if (!existsSync(envPath))
      throw new SetEnvRefusal('There is no deploy/.env yet. Run bun run melete init first.');
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
