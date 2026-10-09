/**
 * The read-only commands run inside the service image, where the checkout's
 * deploy/ directory is absent. The image's tree is rebuilt from the COPY lines of
 * deploy/Dockerfile.melete, and each command must load and print its report there.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { instructions } from '../../../deploy/scripts/dockerfile-check.ts';
import { reportSchema } from './schema.ts';

const ROOT = resolve(import.meta.dir, '../../..');

/** The repository paths the service image copies, as the Dockerfile names them. */
function imageSources(dockerfile: string): string[] {
  const sources: string[] = [];
  for (const instruction of instructions(dockerfile)) {
    const [keyword = '', ...rest] = instruction.split(/\s+/);
    if (keyword.toUpperCase() !== 'COPY') continue;
    if (rest.some((argument) => argument.startsWith('--from='))) continue;
    sources.push(...rest.filter((argument) => !argument.startsWith('--')).slice(0, -1));
  }
  return sources;
}

let image = '';

beforeAll(() => {
  image = mkdtempSync(join(tmpdir(), 'melete-image-'));
  const dockerfile = readFileSync(join(ROOT, 'deploy/Dockerfile.melete'), 'utf8');
  for (const source of imageSources(dockerfile)) {
    const from = join(ROOT, source);
    if (!existsSync(from)) throw new Error(`deploy/Dockerfile.melete copies ${source}, missing`);
    cpSync(from, join(image, source), {
      recursive: true,
      filter: (path) => !path.split(sep).includes('node_modules'),
    });
  }
  // The image installs each workspace's dependencies; the checkout's stand in for them.
  for (const source of imageSources(dockerfile).filter((path) => path.endsWith('package.json'))) {
    const modules = join(dirname(source), 'node_modules');
    if (existsSync(join(ROOT, modules)) && !existsSync(join(image, modules)))
      symlinkSync(join(ROOT, modules), join(image, modules), 'junction');
  }
}, 120_000);

afterAll(() => {
  if (image && !process.env.KEEP_IMAGE) rmSync(image, { recursive: true, force: true });
});

describe('the read-only commands in the service image', () => {
  test('the image tree holds no deployment files', () => {
    expect(existsSync(join(image, 'deploy/docker-compose.yml'))).toBe(false);
    expect(existsSync(join(image, 'deploy/scripts/upgrade.ts'))).toBe(false);
  });

  const commands: { command: 'doctor' | 'status' | 'check'; flags: string[] }[] = [
    { command: 'doctor', flags: ['--offline'] },
    { command: 'status', flags: [] },
    { command: 'check', flags: [] },
  ];
  for (const { command, flags } of commands) {
    test(`${command} loads and reports`, () => {
      const run = Bun.spawnSync(
        [process.execPath, join(image, 'packages/cli/src/main.ts'), command, ...flags, '--json'],
        { cwd: image, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 },
      );
      const stderr = run.stderr.toString();
      expect(stderr).not.toMatch(/Cannot find (module|package)/);
      expect([0, 1]).toContain(run.exitCode ?? -1);
      const report = reportSchema.parse(JSON.parse(run.stdout.toString()));
      expect(report.command).toBe(command);
    }, 150_000);
  }

  test('browser files, the installer’s half of turning on the browser worker, loads and answers', () => {
    const line = (text: string) => Buffer.from(text, 'utf8').toString('base64');
    const run = Bun.spawnSync(
      [
        process.execPath,
        join(image, 'packages/cli/src/main.ts'),
        'browser',
        'files',
        '--connection',
        'conn_browser1',
      ],
      {
        cwd: image,
        stdin: Buffer.from(`${line('MELETE_IMAGE_TAG=main\n')}\n-\n${line('[]\n')}\n`),
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 120_000,
      },
    );
    expect(run.stderr.toString()).not.toMatch(/Cannot find (module|package)/);
    expect(run.exitCode).toBe(0);
    const [contract = '', connections = ''] = run.stdout.toString().trim().split('\n');
    expect(JSON.parse(Buffer.from(contract, 'base64').toString()).overlays).toEqual(['browser']);
    expect(JSON.parse(Buffer.from(connections, 'base64').toString())).toEqual([
      { kind: 'browser', id: 'conn_browser1' },
    ]);
  }, 150_000);
});
