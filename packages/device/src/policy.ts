/**
 * The companion's own checks, made on the computer whatever the service
 * already checked. A request is refused here when:
 *
 * - the capability it needs is off in this companion's settings;
 * - its path is not a shared folder's name followed by a plain relative path
 *   (no `..`, no absolute path, no drive letter, no backslash, no device name);
 * - any part of the path inside the shared folder is a symbolic link or a
 *   junction, or the resolved path is not inside the folder's real location;
 * - its web address is anything but http or https.
 *
 * Every file operation re-resolves the folder with `realpath` at the time of
 * the call, so a shared folder that was moved or replaced by a link is judged
 * as it is now.
 */
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { Capabilities, Folder } from './config.ts';

export type RefusalCode =
  | 'capability_off'
  | 'outside_folders'
  | 'not_found'
  | 'too_large'
  | 'invalid_request'
  | 'failed';

export class Refusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
  }
}

const TOOL_CAPABILITY: Record<string, keyof Capabilities | null> = {
  list_files: 'files',
  read_file: 'files',
  write_file: 'files',
  run: 'commands',
  open_url: 'open_url',
  screenshot: 'screenshot',
};

const WORDS: Record<keyof Capabilities, string> = {
  commands: 'Running commands',
  files: 'Using files',
  open_url: 'Opening web pages',
  screenshot: 'Taking screenshots',
  browser: 'Using the browser',
};

export function checkCapability(tool: string, capabilities: Capabilities): void {
  if (!(tool in TOOL_CAPABILITY)) throw new Refusal('invalid_request', `Unknown request: ${tool}`);
  const needed = TOOL_CAPABILITY[tool];
  if (needed && !capabilities[needed])
    throw new Refusal('capability_off', `${WORDS[needed]} is turned off on this computer.`);
}

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** The folder a path names and the plain segments inside it. */
export function parsePath(value: unknown, folders: readonly Folder[]) {
  if (typeof value !== 'string' || !value.length || value.length > 1024)
    throw new Refusal('invalid_request', 'A path is a shared folder name and a relative path.');
  if (
    value.includes('\0') ||
    value.includes('\\') ||
    value.includes(':') ||
    value.startsWith('/') ||
    value.startsWith('~')
  )
    throw new Refusal('outside_folders', 'Paths start with a shared folder name.');
  const [head, ...rest] = value.replace(/\/+$/, '').split('/');
  const folder = folders.find((entry) => entry.name === head);
  if (!folder) throw new Refusal('outside_folders', 'That is not a shared folder.');
  for (const part of rest)
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || WINDOWS_DEVICE.test(part))
      throw new Refusal('outside_folders', 'That path leaves the shared folder.');
  return { folder, segments: rest };
}

const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ||
  (error as NodeJS.ErrnoException | undefined)?.code === 'ENOTDIR';

const inside = (root: string, target: string) => {
  const between = relative(root, target);
  return (
    between === '' || (!between.startsWith(`..${sep}`) && between !== '..' && !isAbsolute(between))
  );
};

/**
 * The absolute path a request may touch, checked component by component.
 * With `createParents`, missing folders on the way are made, one at a time,
 * each checked as it is made.
 */
export async function resolveInside(
  value: unknown,
  folders: readonly Folder[],
  options: { createParents?: boolean } = {},
): Promise<string> {
  const { folder, segments } = parsePath(value, folders);
  let root: string;
  try {
    root = await realpath(folder.path);
    if (!(await lstat(root)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Refusal('not_found', `The shared folder ${folder.name} is not there any more.`);
  }
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    current = join(current, segments[index] as string);
    const last = index === segments.length - 1;
    try {
      const entry = await lstat(current);
      // Junctions on Windows are reported as symbolic links too.
      if (entry.isSymbolicLink())
        throw new Refusal('outside_folders', 'Links inside shared folders are not followed.');
      if (!last && !entry.isDirectory())
        throw new Refusal('not_found', 'A folder on that path is a file.');
    } catch (error) {
      if (error instanceof Refusal) throw error;
      if (!missing(error)) throw error;
      if (options.createParents && !last) {
        await mkdir(current);
        const made = await lstat(current);
        if (made.isSymbolicLink() || !made.isDirectory())
          throw new Refusal('outside_folders', 'That path could not be made safely.');
      } else if (!last) throw new Refusal('not_found', 'No such folder.');
    }
  }
  // Belt and braces: whatever exists of the path resolves inside the folder.
  let probe = current;
  while (true) {
    try {
      const real = await realpath(probe);
      if (!inside(root, real))
        throw new Refusal('outside_folders', 'That path leaves the shared folder.');
      break;
    } catch (error) {
      if (error instanceof Refusal) throw error;
      if (!missing(error) || probe === root) throw error;
      probe = join(probe, '..');
    }
  }
  return current;
}

export function checkUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048)
    throw new Refusal('invalid_request', 'A web address is required.');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Refusal('invalid_request', 'That is not a web address.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Refusal('invalid_request', 'Only http and https addresses are opened.');
  return parsed.toString();
}
