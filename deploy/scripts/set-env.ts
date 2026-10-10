/**
 * Change settings in deploy/.env, in place, without printing a secret.
 *
 *   bun run deploy/scripts/set-env.ts NAME=value [NAME=value ...]
 *   bun run deploy/scripts/set-env.ts --from-env NAME [NAME ...]
 *   bun run deploy/scripts/set-env.ts --clear NAME [NAME ...]
 *
 * The first form is for ordinary settings, such as ports or MELETE_IMAGE_TAG,
 * and refuses a name that holds a secret, so a key never lands on a command
 * line or in a shell history. The second reads each named setting from this
 * command's environment, which is how a key gets in: the person types it
 * hidden, in their own terminal,
 *
 *   read -rs ELEVENLABS_API_KEY && export ELEVENLABS_API_KEY
 *   bun run deploy/scripts/set-env.ts --from-env ELEVENLABS_API_KEY
 *   unset ELEVENLABS_API_KEY
 *
 * Each setting is rewritten where it stands, so the file keeps its comments
 * and order, and the file is replaced in one rename, so an interrupted run
 * never leaves it half written. It works the same on Linux, macOS and Windows,
 * where `sed -i` does not.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ENV_FILE_MODE, fileReplacer, replaceFile } from './tailscale-origin.ts';

export const SET_ENV_USAGE =
  'Usage: bun run deploy/scripts/set-env.ts NAME=value [NAME=value ...], --from-env NAME [NAME ...] for a key, or --clear NAME [NAME ...] to empty settings';

/** A name whose value is a secret: it is only ever taken from the environment, and never printed. */
export const isSecretName = (name: string) =>
  /(KEY|TOKEN|SECRET|PASSWORD)$/.test(name) || name === 'DATABASE_URL';

export class SetEnvRefusal extends Error {}

/** The settings to write, from the arguments and, for --from-env, the environment. */
export function requestedSettings(
  args: readonly string[],
  environment: Record<string, string | undefined>,
): { name: string; value: string; secret: boolean }[] {
  const fromEnv = args[0] === '--from-env';
  const clear = args[0] === '--clear';
  const items = fromEnv || clear ? args.slice(1) : args;
  if (items.length === 0) throw new SetEnvRefusal(SET_ENV_USAGE);
  // Emptying a setting needs no value, so a key is cleared without being typed.
  if (clear)
    return items.map((name) => {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name))
        throw new SetEnvRefusal(`${name} is not a setting name. ${SET_ENV_USAGE}`);
      return { name, value: '', secret: isSecretName(name) };
    });
  return items.map((item) => {
    const [name, ...rest] = fromEnv ? [item] : item.split('=');
    if (!name || !/^[A-Z_][A-Z0-9_]*$/.test(name) || (!fromEnv && rest.length === 0))
      throw new SetEnvRefusal(
        `${item.includes('=') ? name : item} is not NAME=value. ${SET_ENV_USAGE}`,
      );
    const value = fromEnv ? environment[name]?.trim() : rest.join('=');
    if (fromEnv && !value)
      throw new SetEnvRefusal(
        `${name} is empty in this command's environment. Set it with read -rs ${name} && export ${name}, then run this again.`,
      );
    if (!fromEnv && isSecretName(name))
      throw new SetEnvRefusal(
        `${name} holds a secret, so it is not taken from the command line. Use --from-env ${name} with the value exported, as this script's header shows.`,
      );
    // A line break would write a second setting; a space is a mistyped key.
    if (/[\r\n]/.test(value ?? '') || (fromEnv && /\s/.test(value ?? '')))
      throw new SetEnvRefusal(`${name} contains a space or a line break; set it again.`);
    return { name, value: value ?? '', secret: fromEnv || isSecretName(name) };
  });
}

/** The file with `name` set to `value`: rewritten where it stands, or appended. */
export function withSetting(envFile: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const setting = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, 'm');
  if (setting.test(envFile)) return envFile.replace(setting, () => line);
  const separator = envFile === '' || envFile.endsWith('\n') ? '' : '\n';
  return `${envFile}${separator}${line}\n`;
}

/** What was done, one line per setting; a secret is named, never shown. */
export function describe(setting: { name: string; value: string; secret: boolean }): string {
  if (setting.value === '') return `Cleared ${setting.name}.`;
  return setting.secret ? `Set ${setting.name}.` : `Set ${setting.name}=${setting.value}.`;
}

if (import.meta.main) {
  const target = resolve(import.meta.dir, '../../deploy/.env');
  try {
    const settings = requestedSettings(process.argv.slice(2), process.env);
    if (!existsSync(target))
      throw new SetEnvRefusal(
        'There is no deploy/.env yet. Run bun run deploy/scripts/configure.ts first.',
      );
    let text = await readFile(target, 'utf8');
    for (const setting of settings) text = withSetting(text, setting.name, setting.value);
    await replaceFile(target, text, fileReplacer, ENV_FILE_MODE);
    for (const setting of settings) process.stdout.write(`${describe(setting)}\n`);
  } catch (error) {
    if (!(error instanceof SetEnvRefusal)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
