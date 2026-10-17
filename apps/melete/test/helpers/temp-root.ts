import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * One temporary directory per test run. Everything the tests make through
 * os.tmpdir() lands inside it, and the returned function removes it, so a run
 * leaves nothing behind in the system temporary directory, passed or failed.
 *
 * Bun does not hand later changes to process.env on to child processes, so a
 * child started without an explicit env still sees the system directory; a test
 * that passes process.env to its child passes this directory along with it.
 *
 * On Windows os.tmpdir() reads TEMP and TMP rather than TMPDIR, so the run keeps
 * the system directory there.
 */
export function useTemporaryRoot(): () => void {
  if (process.platform === 'win32') return () => {};
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'melete-test-'));
  process.env.TMPDIR = root;
  return () => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
