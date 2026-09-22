import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');

/** The README removal's line that reads the Compose project name from deploy/.env. */
async function projectNameLine() {
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  const line = readme.split(/\r?\n/).find((text) => /^name=\$\(.*COMPOSE_PROJECT_NAME/.test(text));
  if (!line) throw new Error('README has no project-name line in its removal block');
  return line;
}

async function readName(env: string) {
  const directory = await mkdtemp(join(tmpdir(), 'melete-removal-'));
  try {
    await mkdir(join(directory, 'deploy'));
    await writeFile(join(directory, 'deploy/.env'), env);
    const result = Bun.spawnSync(
      ['bash', '-c', `${await projectNameLine()}; printf '[%s]' "$name"`],
      {
        cwd: directory,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test.skipIf(Bun.which('bash') === null)(
  'the removal reads the project name from deploy/.env saved with LF or CRLF endings',
  async () => {
    expect(await readName('POSTGRES_USER=melete\nCOMPOSE_PROJECT_NAME=assistant\n')).toBe(
      '[assistant]',
    );
    // An editor on Windows may save the file with CRLF; the name must not keep the \r.
    expect(await readName('POSTGRES_USER=melete\r\nCOMPOSE_PROJECT_NAME=assistant\r\n')).toBe(
      '[assistant]',
    );
    expect(await readName('POSTGRES_USER=melete\r\n')).toBe('[]');
  },
);
