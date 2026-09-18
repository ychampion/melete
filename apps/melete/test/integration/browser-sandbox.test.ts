/**
 * The renderer sandbox, proved where it matters: inside the worker container, under the shipped
 * seccomp profile and with every capability dropped. This needs a Linux Docker host, so it runs
 * only when asked for:
 *
 *   MELETE_BROWSER_SANDBOX_PROOF=1 bun test apps/melete/test/integration/browser-sandbox.test.ts
 *
 * Without that it reports itself as unproven rather than passing quietly.
 */
import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserLaunchOptions } from '../../src/workers/browser/sessions.ts';

const IMAGE = 'melete-browser-sandbox-proof';
const asked = process.env.MELETE_BROWSER_SANDBOX_PROOF === '1';
const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const proof = join(root, 'apps/melete/test/helpers/browser-sandbox-proof.ts');

type Renderer = {
  pid: number;
  seccomp: number;
  no_new_privs: number;
  user_namespace: string;
  asked_for_no_sandbox: boolean;
};

async function run(command: string[], timeout: number) {
  const child = Bun.spawn(command, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), timeout);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  } finally {
    clearTimeout(timer);
  }
}

test('the worker asks Chromium for its own sandbox', () => {
  const options = browserLaunchOptions();
  // Playwright passes --no-sandbox unless this is exactly true.
  expect(options.chromiumSandbox).toBe(true);
  expect(options.args.some((argument) => argument.includes('sandbox'))).toBe(false);
});

test('nothing in the worker or its container turns the sandbox off again', async () => {
  const worker = join(root, 'apps/melete/src/workers/browser');
  const files = [
    ...(await readdir(worker))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(worker, name)),
    join(root, 'deploy/Dockerfile.browser'),
    join(root, 'deploy/docker-compose.browser.yml'),
  ];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    expect([file, /no-sandbox|disable-setuid-sandbox|seccomp=unconfined/.test(text)]).toEqual([
      file,
      false,
    ]);
  }
  const compose = await readFile(join(root, 'deploy/docker-compose.browser.yml'), 'utf8');
  expect(compose).toContain('seccomp=./config/browser-seccomp.json');
});

if (!asked)
  test.todo(
    'the renderer is sandboxed in the worker container (unproven here: needs a Linux Docker ' +
      'host; run with MELETE_BROWSER_SANDBOX_PROOF=1)',
    () => {},
  );

(asked ? describe : describe.skip)('the worker container under its seccomp profile', () => {
  test('every renderer is under a seccomp filter, in its own user namespace', async () => {
    const built = await run(
      ['docker', 'build', '-f', 'deploy/Dockerfile.browser', '-t', IMAGE, '.'],
      900_000,
    );
    expect([built.code, built.stderr.slice(-400)]).toEqual([0, expect.any(String)]);
    const started = await run(
      [
        'docker',
        'run',
        '--rm',
        '--user=10003:10003',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges:true',
        `--security-opt=seccomp=${join(root, 'deploy/config/browser-seccomp.json')}`,
        '--tmpfs=/tmp:size=256m,mode=1777',
        '--shm-size=256m',
        '--network=none',
        '--pids-limit=384',
        `--volume=${proof}:/app/sandbox-proof.ts:ro`,
        IMAGE,
        'node',
        '--experimental-transform-types',
        '--disable-warning=ExperimentalWarning',
        'sandbox-proof.ts',
      ],
      180_000,
    );
    expect([started.code, started.stderr.slice(-800)]).toEqual([0, expect.any(String)]);
    const seen = JSON.parse(started.stdout) as {
      worker_user_namespace: string;
      renderers: Renderer[];
    };
    expect(seen.renderers.length).toBeGreaterThan(0);
    for (const renderer of seen.renderers)
      expect([renderer.pid, renderer]).toEqual([
        renderer.pid,
        {
          pid: renderer.pid,
          // SECCOMP_MODE_FILTER, no way to gain privileges, and a namespace of its own.
          seccomp: 2,
          no_new_privs: 1,
          user_namespace: expect.not.stringMatching(
            seen.worker_user_namespace.replace(/[[\]]/g, '\\$&'),
          ),
          asked_for_no_sandbox: false,
        },
      ]);
  }, 1_200_000);
});
