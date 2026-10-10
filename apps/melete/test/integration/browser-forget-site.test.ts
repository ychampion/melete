/**
 * Signing out of one site, proved in the browser image the product ships: the worker's own
 * `forgetSite` clears that site's cookies, local storage and IndexedDB from the space's profile,
 * leaves another site's alone, and does so whether the space's browser is running or stopped.
 * This needs a Linux Docker host, so it runs only when asked for:
 *
 *   MELETE_BROWSER_FORGET_PROOF=1 bun test apps/melete/test/integration/browser-forget-site.test.ts
 *
 * Without that it reports itself as unproven rather than passing quietly. Asked for where Docker
 * or the image cannot be had, it fails.
 */
import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const IMAGE = 'melete-browser-forget-proof';
const asked = process.env.MELETE_BROWSER_FORGET_PROOF === '1';
const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const proof = join(root, 'apps/melete/test/helpers/browser-forget-proof.ts');

type Held = { cookie_header: string; local: string | null; indexed: string | null };
type Proof = {
  state: 'running' | 'stopped';
  was_running: boolean;
  still_running: boolean;
  before: { forgotten: Held; kept: Held };
  result: { domain: string; cookies: number; origins: string[] };
  after: { cookies: string[]; forgotten: Held; kept: Held };
};
type Site = { site: string; host: string; secret: string };
type Seen = { forgotten: Site; kept: Site; port: number; proofs: Proof[] };

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

if (!asked)
  test.todo(
    'signing out of a site clears it from the profile (unproven here: needs a Linux Docker ' +
      'host; run with MELETE_BROWSER_FORGET_PROOF=1)',
    () => {},
  );

(asked ? describe : describe.skip)('signing out of a site in the browser image', () => {
  let seen: Seen;

  test('the proof runs in the worker container under its shipped limits', async () => {
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
        // The sites are served inside the container, on its own loopback.
        '--network=none',
        '--pids-limit=384',
        `--volume=${proof}:/app/forget-proof.ts:ro`,
        IMAGE,
        'node',
        '--experimental-transform-types',
        '--disable-warning=ExperimentalWarning',
        'forget-proof.ts',
      ],
      300_000,
    );
    expect([started.code, started.stderr.slice(-1200)]).toEqual([0, expect.any(String)]);
    seen = JSON.parse(started.stdout) as Seen;
    expect(seen.proofs.map((proof) => proof.state)).toEqual(['running', 'stopped']);
    for (const proof of seen.proofs)
      console.log(
        `forgetSite ran in ${IMAGE} with the browser ${proof.state}: cleared ` +
          `${proof.result.cookies} cookies and ${proof.result.origins.length} origins of ` +
          `${proof.result.domain}; ${seen.kept.site} kept ${proof.after.cookies.length} cookies`,
      );
  }, 1_200_000);

  for (const state of ['running', 'stopped'] as const)
    test(`with the browser ${state}, one site's cookies and storage go and the other's stay`, () => {
      const proof = seen?.proofs.find((each) => each.state === state);
      if (!proof) throw new Error(`no proof was reported for a ${state} browser`);
      const { forgotten, kept, port } = seen;
      // The case is the one named: a browser holding the profile open, or none at all.
      expect(proof.was_running).toBe(state === 'running');
      expect(proof.still_running).toBe(false);

      // Both sites were signed in, with a cookie, local storage and a database each.
      for (const [site, held] of [
        [forgotten, proof.before.forgotten],
        [kept, proof.before.kept],
      ] as const)
        expect(held).toEqual({
          cookie_header: `session=${site.secret}; pref=on`,
          local: `local-${site.host}`,
          indexed: `indexed-${site.host}`,
        });

      // The worker names what it cleared, the storage origin with its port among it.
      expect(proof.result.domain).toBe(forgotten.site);
      expect(proof.result.cookies).toBe(2);
      expect(proof.result.origins).toContain(`http://${forgotten.host}:${port}`);
      expect(proof.result.origins.every((origin) => !origin.includes(kept.site))).toBe(true);

      // Read back from a profile opened again: the site signed out of holds nothing.
      expect(proof.after.forgotten).toEqual({ cookie_header: '', local: null, indexed: null });
      expect(proof.after.cookies.filter((cookie) => cookie.includes(forgotten.site))).toEqual([]);
      // The other site is still signed in, with everything it stored.
      expect(proof.after.cookies).toEqual([`.${kept.site} session`, `${kept.host} pref`]);
      expect(proof.after.kept).toEqual(proof.before.kept);
    });
});
