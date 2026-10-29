import { expect, test } from 'bun:test';
import { build } from 'vite';
import config from '../vite.config.ts';

// Vite reads NODE_ENV when a build starts and logs externalized modules only in production,
// so each case names the NODE_ENV it builds under instead of inheriting the process's.
const nodeEnvs = ['production', 'development', 'test', 'unset'] as const;

async function withNodeEnv<T>(nodeEnv: (typeof nodeEnvs)[number], run: () => Promise<T>) {
  const prior = process.env.NODE_ENV;
  if (nodeEnv === 'unset') delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  try {
    return await run();
  } finally {
    if (prior === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior;
  }
}

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

const externalizing = [
  ["import crypto from 'node:crypto'; console.log(crypto);", 'node:crypto'],
  ["import fs from 'fs'; console.log(fs);", 'fs'],
  ["import 'node:crypto'; console.log('loaded');", 'node:crypto'],
  ["import('node:crypto').then(console.log);", 'node:crypto'],
] as const;

test.each(
  nodeEnvs.flatMap((nodeEnv) =>
    externalizing.map(([source, name]) => [nodeEnv, source, name] as const),
  ),
)(
  'with NODE_ENV %s, a browser build fails on an externalized module: %s',
  async (nodeEnv, source, name) => {
    const built = withNodeEnv(nodeEnv, () => buildSource(source));
    await expect(built).rejects.toThrow('externalized for browser compatibility');
    await expect(built).rejects.toThrow(`"${name}"`);
  },
);

test.each([...nodeEnvs])(
  'with NODE_ENV %s, a browser build allows browser code and type-only Node imports',
  async (nodeEnv) => {
    await expect(
      withNodeEnv(nodeEnv, () =>
        buildSource("import type { Stats } from 'node:fs'; console.log('loaded');"),
      ),
    ).resolves.toBeDefined();
  },
);
