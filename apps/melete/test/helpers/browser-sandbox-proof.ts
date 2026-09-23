/**
 * Runs inside the browser image, where the renderer sandbox can be seen rather than asserted.
 * It launches Chromium exactly as the worker does — from the image's own copy of the worker, so
 * the options are the shipped ones — and reports, for every renderer the browser started,
 * whether the kernel has it under a seccomp filter, how many filters it has against the worker's
 * own, whether it can gain privileges, whether it sits in a user namespace of its own, and
 * whether it was started with either switch that turns part of the sandbox off.
 *
 * Mounted into a container by `browser-sandbox.test.ts`; never part of the image.
 */
import { readdir, readFile, readlink } from 'node:fs/promises';
import { chromium } from 'playwright';

type Renderer = {
  pid: number;
  /** 2 is SECCOMP_MODE_FILTER. */
  seccomp: number;
  /**
   * Filters stacked on the process. The container's profile gives every process one; Chromium's
   * own sandbox adds its filter on top, so a sandboxed renderer has more than the worker.
   */
  seccomp_filters: number;
  no_new_privs: number;
  user_namespace: string;
  asked_for_no_sandbox: boolean;
  asked_for_no_seccomp_filter: boolean;
};

const field = (status: string, name: string) =>
  Number(new RegExp(`^${name}:\\s*(\\d+)`, 'm').exec(status)?.[1] ?? -1);

// The image's own worker sources, resolved where the container put them.
const worker = (await import(
  `${process.cwd()}/apps/melete/src/workers/browser/sessions.ts`
)) as typeof import('../../src/workers/browser/sessions.ts');

const context = await chromium.launchPersistentContext(
  '/tmp/sandbox-proof',
  worker.browserLaunchOptions(true),
);
const renderers: Renderer[] = [];
try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.setContent('<p>A page needs a renderer.</p>');
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const command = await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '');
    if (!command.includes('--type=renderer')) continue;
    const status = await readFile(`/proc/${entry}/status`, 'utf8').catch(() => '');
    renderers.push({
      pid: Number(entry),
      seccomp: field(status, 'Seccomp'),
      seccomp_filters: field(status, 'Seccomp_filters'),
      no_new_privs: field(status, 'NoNewPrivs'),
      user_namespace: await readlink(`/proc/${entry}/ns/user`).catch(() => ''),
      asked_for_no_sandbox: command.includes('--no-sandbox'),
      asked_for_no_seccomp_filter: command.includes('--disable-seccomp-filter-sandbox'),
    });
  }
} finally {
  await context.close();
}
process.stdout.write(
  JSON.stringify({
    worker_user_namespace: await readlink('/proc/self/ns/user'),
    worker_seccomp_filters: field(await readFile('/proc/self/status', 'utf8'), 'Seccomp_filters'),
    renderers,
  }),
);
