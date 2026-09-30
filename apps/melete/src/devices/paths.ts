/**
 * How the agent names a file on a connected computer: the name of a folder the
 * person chose, then a relative path inside it, always with forward slashes.
 * `Projects/notes/todo.md` is `notes/todo.md` inside the folder named
 * `Projects`. Nothing else is a path here: no drive letters, no absolute
 * paths, no `..`, no backslashes, no Windows device names.
 *
 * The service checks this before anything is sent, so a request outside the
 * chosen folders never reaches the computer. The companion checks again on the
 * computer, where it can also see symbolic links; see packages/device.
 */
import type { DeviceFolder } from '@melete/contracts';

export type DevicePath = { folder: DeviceFolder; segments: string[] };

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export class DevicePathError extends Error {}

/** The folder and the segments inside it, or a plain-words refusal. */
export function devicePath(value: unknown, folders: readonly DeviceFolder[]): DevicePath {
  if (typeof value !== 'string' || !value.length || value.length > 1024)
    throw new DevicePathError(
      'A path is a folder name and a relative path, like Projects/notes.md.',
    );
  if (
    value.includes('\0') ||
    value.includes('\\') ||
    value.includes(':') ||
    value.startsWith('/') ||
    value.startsWith('~')
  )
    throw new DevicePathError(
      'Paths start with the name of a shared folder and use forward slashes.',
    );
  const [head, ...rest] = value.replace(/\/+$/, '').split('/');
  const folder = folders.find((entry) => entry.name === head);
  if (!folder)
    throw new DevicePathError(
      folders.length
        ? `That is not one of the shared folders: ${folders.map((entry) => entry.name).join(', ')}.`
        : 'No folders are shared on this computer.',
    );
  for (const part of rest)
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || WINDOWS_DEVICE.test(part))
      throw new DevicePathError('That path leaves the shared folder or names a device.');
  return { folder, segments: rest };
}

/** Only ordinary web addresses are opened; anything else could start a program. */
export function openableUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048)
    throw new DevicePathError('A web address is required.');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DevicePathError('That is not a web address.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new DevicePathError('Only http and https addresses without a password are opened.');
  return parsed.toString();
}
