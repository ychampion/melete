/**
 * One answer to "which Python": the plugin's tests and the process supervisor
 * both start an interpreter, and Debian ships `python3` with no `python`.
 *
 * Resolution order: an explicit path or command; `MELETE_PYTHON`; `python3`;
 * `python`. An explicit value that cannot be found fails with its own name
 * rather than surfacing later as ENOENT on the first attempt.
 */
import { existsSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

export class PythonNotFoundError extends Error {
  constructor(detail: string) {
    super(`No Python interpreter: ${detail}. Set MELETE_PYTHON to one, or install python3.`);
    this.name = 'PythonNotFoundError';
  }
}

const found = (candidate: string): string | null => {
  // A path (anything with a separator) is checked on disk; a bare name on PATH.
  if (isAbsolute(candidate) || basename(candidate) !== candidate)
    return existsSync(candidate) ? candidate : null;
  return Bun.which(candidate);
};

export function resolvePython(
  preferred?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (preferred) {
    const path = found(preferred);
    if (!path) throw new PythonNotFoundError(`${preferred} does not exist`);
    return path;
  }
  const configured = env.MELETE_PYTHON;
  if (configured) {
    const path = found(configured);
    if (!path) throw new PythonNotFoundError(`MELETE_PYTHON=${configured} does not exist`);
    return path;
  }
  for (const candidate of ['python3', 'python']) {
    const path = Bun.which(candidate);
    if (path) return path;
  }
  throw new PythonNotFoundError('neither python3 nor python is on PATH');
}
