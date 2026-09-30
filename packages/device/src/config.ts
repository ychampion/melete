/**
 * What the companion keeps on the computer: where Melete is, the device token,
 * and what the person allows here. It lives in the user's own configuration
 * folder, readable only by them.
 *
 * - Windows: %APPDATA%\melete-device
 * - macOS: ~/Library/Application Support/melete-device
 * - Linux: $XDG_CONFIG_HOME/melete-device, or ~/.config/melete-device
 *
 * `MELETE_DEVICE_CONFIG_DIR` replaces the folder, for a second companion on
 * one computer or for tests.
 */
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { basename, join } from 'node:path';

export type Capabilities = {
  commands: boolean;
  files: boolean;
  open_url: boolean;
  screenshot: boolean;
  /** Let the browser extension carry out browser work in the person's own browser. */
  browser: boolean;
};
export type Folder = { name: string; path: string };

export type DeviceConfig = {
  /** The service's API base, e.g. `https://melete.example/api`. */
  api: string;
  device_id: string;
  token: string;
  name: string;
  capabilities: Capabilities;
  folders: Folder[];
};

/** Running commands and screenshots start off here too; the person turns them on. */
export const DEFAULT_LOCAL_CAPABILITIES: Capabilities = {
  commands: false,
  files: true,
  open_url: true,
  screenshot: false,
  browser: false,
};

export const CAPABILITY_NAMES = ['commands', 'files', 'open_url', 'screenshot', 'browser'] as const;

export function configDir(env: Record<string, string | undefined> = process.env): string {
  if (env.MELETE_DEVICE_CONFIG_DIR) return env.MELETE_DEVICE_CONFIG_DIR;
  const home = homedir();
  if (platform() === 'win32')
    return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'melete-device');
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'melete-device');
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'melete-device');
}

export const configPath = (dir = configDir()) => join(dir, 'config.json');
export const logPath = (dir = configDir()) => join(dir, 'activity.log');

/** Folder names become the first segment of every path the agent uses, so they stay plain. */
export function folderName(path: string, taken: readonly Folder[]): string {
  const base =
    basename(path.replace(/[\\/]+$/, ''))
      .replace(/[^A-Za-z0-9 _.-]/g, '')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 48) || 'Folder';
  let name = base;
  for (let n = 2; taken.some((folder) => folder.name.toLowerCase() === name.toLowerCase()); n++)
    name = `${base}-${n}`;
  return name;
}

export async function readConfig(dir = configDir()): Promise<DeviceConfig | null> {
  try {
    const config = JSON.parse(await readFile(configPath(dir), 'utf8')) as DeviceConfig;
    // Settings saved before a capability existed read it as off.
    config.capabilities = { ...DEFAULT_LOCAL_CAPABILITIES, ...config.capabilities };
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Written whole, then moved into place, with only the owner able to read it. */
export async function writeConfig(config: DeviceConfig, dir = configDir()): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = configPath(dir);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function forgetConfig(dir = configDir()): Promise<void> {
  await rm(configPath(dir), { force: true });
}

export async function configChangedAt(dir = configDir()): Promise<number> {
  try {
    return (await stat(configPath(dir))).mtimeMs;
  } catch {
    return 0;
  }
}
