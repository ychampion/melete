import { afterAll, beforeAll, expect, test } from 'bun:test';
import { build } from 'vite';
import config from '../vite.config.ts';

const nodeEnv = process.env.NODE_ENV;
beforeAll(() => {
  // Bun sets NODE_ENV=test; Vite reports production externalizations only in production.
  process.env.NODE_ENV = 'production';
});
afterAll(() => {
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
});

test('a production build ships no source maps', () => {
  expect((config as { build?: { sourcemap?: unknown } }).build?.sourcemap).toBe(false);
});

function buildSource(source: string) {
  return build({
    ...config,
    configFile: false,
    root: new URL('..', import.meta.url).pathname,
    logLevel: 'silent',
    plugins: [
      ...(config.plugins ?? []),
      {
        name: 'browser-entry-fixture',
        resolveId(id) {
          if (id === 'virtual:browser-entry') return '\0browser-entry.ts';
        },
        load(id) {
          if (id === '\0browser-entry.ts') return source;
        },
      },
    ],
    build: {
      ...config.build,
      write: false,
      minify: false,
      rolldownOptions: {
        ...config.build?.rolldownOptions,
        input: 'virtual:browser-entry',
      },
    },
  });
}

test.each([
  "import crypto from 'node:crypto'; console.log(crypto);",
  "import fs from 'fs'; console.log(fs);",
  "import 'node:crypto'; console.log('loaded');",
  "import('node:crypto').then(console.log);",
])('a browser build fails on an externalized module: %s', async (source) => {
  await expect(buildSource(source)).rejects.toThrow('externalized for browser compatibility');
});

test('a browser build allows browser code and type-only Node imports', async () => {
  await expect(
    buildSource("import type { Stats } from 'node:fs'; console.log('loaded');"),
  ).resolves.toBeDefined();
});
