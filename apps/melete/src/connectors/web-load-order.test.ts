/**
 * web.ts and web-search.ts import each other, so whichever loads first sees
 * the other half-evaluated. Each entry point is loaded first in a fresh
 * process, so a value read at load time across that cycle fails here rather
 * than when the service starts.
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';

const ENTRIES = [
  'connectors/web-search.ts',
  'connectors/web.ts',
  'broker/paid-meter.ts',
  'connectors/configured.ts',
];

test('the web connector, its search backends and the paid-call meter load in any order', async () => {
  for (const entry of ENTRIES) {
    const path = join(import.meta.dir, '..', entry).replaceAll('\\', '/');
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `const m = await import(${JSON.stringify(path)}); const w = await import(${JSON.stringify(
          join(import.meta.dir, 'web.ts').replaceAll('\\', '/'),
        )}); if (!w.webManifest.tools.length) process.exit(2);`,
      ],
      { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'test' } },
    );
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ entry, code, stderr: stderr.slice(0, 400) }).toEqual({ entry, code: 0, stderr: '' });
  }
}, 60_000);
