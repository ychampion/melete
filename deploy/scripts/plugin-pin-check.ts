/**
 * The runtime image pins the content of the plugin it ships: the Dockerfile
 * declares MELETE_PLUGIN_SHA, and packages/runtime-hermes/build-metadata.py
 * recomputes the same SHA-256 inside the build and refuses a mismatch. Nothing
 * outside a Docker build recomputed it, so a plugin change that left the pin
 * behind surfaced only in the image job, long after the push. This reads the
 * same content without Docker and names the value the pin should carry.
 *
 * The files are the ones git tracks and the bytes are the ones git stores: the
 * repository normalizes text to LF (.gitattributes), so a working tree checked
 * out with CRLF endings on Windows produces the digest the image computes on
 * Linux rather than one nobody else can reproduce.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type CheckResult = { name: string; ok: boolean; detail: string };

/** The directory the image copies and hashes, and the file that pins it. */
export const PLUGIN_DIRECTORY = 'packages/runtime-hermes/melete_plugin';
export const RUNTIME_DOCKERFILE = 'packages/runtime-hermes/Dockerfile';

/** The pin a Dockerfile declares, or undefined when the ARG is absent. */
export function declaredPluginSha(dockerfile: string): string | undefined {
  return /^ARG\s+MELETE_PLUGIN_SHA=([0-9a-f]{64})\s*$/m.exec(dockerfile)?.[1];
}

/**
 * The bytes git stores for a text file: its CRLF pairs written as LF. Git
 * leaves a file holding a NUL byte alone, and so does this.
 */
export function storedBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.includes(0)) return bytes;
  const stored = new Uint8Array(bytes.length);
  let length = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10) continue;
    stored[length] = bytes[index] ?? 0;
    length += 1;
  }
  return stored.subarray(0, length);
}

/**
 * Python compares paths by code point and JavaScript compares UTF-16 code
 * units, which disagree above the basic plane; comparing the UTF-8 encodings
 * restores the order the build sorts its files in.
 */
function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/**
 * build-metadata.py's digest: files sorted by their path relative to the plugin
 * directory, each contributing that path, a NUL, its bytes and another NUL.
 */
export function pluginDigest(files: { path: string; bytes: Uint8Array }[]): string {
  const encoder = new TextEncoder();
  const entries = files
    .map((file) => ({ name: encoder.encode(file.path), bytes: file.bytes }))
    .sort((left, right) => compareBytes(left.name, right.name));
  const digest = createHash('sha256');
  const nul = new Uint8Array([0]);
  for (const entry of entries) {
    digest.update(entry.name);
    digest.update(nul);
    digest.update(entry.bytes);
    digest.update(nul);
  }
  return digest.digest('hex');
}

/**
 * The plugin's tracked files, with the bytes a commit carries. `__pycache__` is
 * skipped because the build's digest skips it, and a compiled file is ignored
 * by this repository anyway.
 */
export function trackedPluginFiles(
  root: string,
  directory: string,
): { path: string; bytes: Uint8Array }[] {
  const listed = Bun.spawnSync(['git', 'ls-files', '-z', '--', directory], { cwd: root });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed for ${directory}`);
  return listed.stdout
    .toString()
    .split('\0')
    .filter(Boolean)
    .filter((file) => !file.split('/').includes('__pycache__'))
    .filter((file) => existsSync(join(root, file)))
    .map((file) => ({
      path: file.slice(`${directory}/`.length),
      bytes: storedBytes(readFileSync(join(root, file))),
    }));
}

/** The digest the image computes over the plugin directory as tracked. */
export function trackedPluginDigest(root: string, directory = PLUGIN_DIRECTORY): string {
  return pluginDigest(trackedPluginFiles(root, directory));
}

/** Whether the Dockerfile's pin still describes the plugin directory. */
export function checkRuntimePluginPin(
  root: string,
  dockerfile = RUNTIME_DOCKERFILE,
  directory = PLUGIN_DIRECTORY,
): CheckResult[] {
  const files = trackedPluginFiles(root, directory);
  const actual = pluginDigest(files);
  const declared = declaredPluginSha(readFileSync(join(root, dockerfile), 'utf8'));
  const empty = files.length === 0 ? `; ${directory} has no tracked file` : '';
  return [
    {
      name: `${dockerfile} pins the content of the plugin it ships`,
      ok: files.length > 0 && declared === actual,
      detail: `ARG MELETE_PLUGIN_SHA=${actual} (declared: ${declared ?? 'no ARG MELETE_PLUGIN_SHA'})${empty}`,
    },
  ];
}
