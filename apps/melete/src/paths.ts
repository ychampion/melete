/**
 * Paths under a root that a caller names and must not leave: checked component
 * by component, never through a link, and removed only when confined.
 */
import { constants } from 'node:fs';
import { access, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import path, { join, resolve, sep } from 'node:path';

/** Reject both host and portable path syntax, including Windows device/stream names. */
export function segmentsFor(value: string): string[] {
  if (
    !value ||
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.includes('\\') ||
    value.includes(':')
  ) {
    throw new Error('path must be relative to its area');
  }
  if (value === '.') return [];
  const segments = value.split('/');
  if (
    segments.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  ) {
    throw new Error('path traversal or device path is not allowed');
  }
  return segments;
}

const missing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** Inspect every component: checking only the final realpath misses dangling links. */
export async function noLinks(
  base: string,
  segments: string[],
  createParents: boolean,
): Promise<string> {
  let current = base;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) throw new Error('empty path component');
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error('symbolic links are not allowed');
      if (index < segments.length - 1 && !stat.isDirectory()) {
        throw new Error('path parent is not a directory');
      }
    } catch (error) {
      if (!missing(error)) throw error;
      if (createParents && index < segments.length - 1) {
        await mkdir(current);
        const created = await lstat(current);
        if (!created.isDirectory() || created.isSymbolicLink()) {
          throw new Error('unsafe path parent');
        }
      }
    }
  }
  return current;
}

export class PathHeld extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(
      `${path} could not be removed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

export class PathOutsideRoot extends Error {
  constructor(readonly path: string) {
    super(`${path} does not sit under its own root`);
  }
}

const RETRIES = 3;

/**
 * Remove one entry directly under one root, and nothing else. The name must be
 * a single path segment, the entry must not be a link, and where it really
 * leads must be exactly where it is: the same guard the browser profile uses
 * before Chromium is allowed to open one.
 */
export async function removeConfined(
  root: string,
  name: string,
  beforeRetry?: () => Promise<void>,
): Promise<void> {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..')
    throw new PathOutsideRoot(name);
  const base = resolve(root);
  await mkdir(base, { recursive: true });
  const canonicalRoot = await realpath(base);
  const target = join(canonicalRoot, name);
  if (!target.startsWith(canonicalRoot + sep)) throw new PathOutsideRoot(target);
  try {
    await access(target, constants.F_OK);
  } catch {
    return;
  }
  // existsSync follows links, so the link itself is checked before the target.
  if ((await lstat(target)).isSymbolicLink()) throw new PathOutsideRoot(target);
  if ((await realpath(target)) !== target) throw new PathOutsideRoot(target);
  let failure: unknown;
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      failure = error;
      // On Windows the usual cause is a process that still holds the directory
      // open, so whatever stops it runs again before the next try, after a
      // pause that grows with each one.
      await beforeRetry?.();
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  throw new PathHeld(target, failure);
}
