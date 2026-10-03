/**
 * A folder inside an app's bundle swapped for a link while it is published
 * reaches nothing outside the conversation's workspace: no outside file's
 * bytes are published, and no outside file's name appears in what the agent
 * is told. Linux only: the race needs links and held directory descriptors.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readBundle } from './service.ts';

const linux = process.platform === 'linux';
const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test.if(linux)(
  'a folder swapped for a link during publishing pulls in nothing from outside',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'melete-bundle-links-'));
    roots.push(root);
    const workRoot = path.join(root, 'work');
    const job = 'job_BUNDLELINKS';
    const app = path.join(workRoot, job, 'app');
    await mkdir(path.join(app, 'sub'), { recursive: true });
    await writeFile(path.join(app, 'index.html'), '<!doctype html><title>x</title>');
    await writeFile(path.join(app, 'sub', 'ok.js'), 'export const ok = 1;');
    // Outside every workspace: a file that would be served, and one whose name would be reported.
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'ok.js'), 'export const SECRET_OUTSIDE = 1;');
    await writeFile(path.join(outside, 'secret-outside-name.exe'), 'x');

    // `sub` keeps flipping between its own folder and a link to the outside one,
    // from another process so the flips land between any two steps of the walk.
    const racer = Bun.spawn(
      [
        'python3',
        '-c',
        [
          'import os, sys',
          'while True:',
          "    os.rename('sub', 'sub-kept'); os.symlink(sys.argv[1], 'sub')",
          "    os.unlink('sub'); os.rename('sub-kept', 'sub')",
        ].join('\n'),
        outside,
      ],
      { cwd: app, stdout: 'ignore', stderr: 'ignore' },
    );

    const leaks: string[] = [];
    try {
      for (let round = 0; round < 3000; round += 1) {
        try {
          const files = await readBundle(workRoot, job, 'app');
          for (const file of files)
            if (Buffer.from(file.bytes).toString('utf8').includes('SECRET_OUTSIDE'))
              leaks.push(`published ${file.path} from outside`);
        } catch (error) {
          const message = String((error as Error).message);
          if (message.includes('secret-outside-name'))
            leaks.push(`named an outside file: ${message.slice(0, 200)}`);
        }
      }
    } finally {
      racer.kill();
      await racer.exited;
    }
    expect(leaks).toEqual([]);
  },
  120_000,
);
