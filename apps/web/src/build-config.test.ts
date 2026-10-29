import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
      // Rolldown hands Vite's externalization warning to plugins without waiting for it, so
      // the warning can arrive after the build has ended. Holding it back from every other
      // plugin makes each build here the case where it arrived too late.
      {
        name: 'late-externalization-warning',
        onLog: {
          order: 'pre',
          handler(_level, log) {
            if (log.message.includes('externalized for browser compatibility')) return false;
          },
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

// A package may map one of its files, or a Node module it uses, to false in its `browser`
// field. Vite then loads an empty module on purpose, and the build must go through.
const browserFalse = mkdtempSync(
  join(fileURLToPath(new URL('../node_modules', import.meta.url)), 'browser-false-'),
);
afterAll(() => rmSync(browserFalse, { recursive: true, force: true }));
writeFileSync(
  join(browserFalse, 'package.json'),
  JSON.stringify({
    name: basename(browserFalse),
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    browser: { './server.js': false, fs: false },
  }),
);
writeFileSync(
  join(browserFalse, 'index.js'),
  "import fs from 'fs';\nimport server from './server.js';\nexport const value = [fs, server];\n",
);
writeFileSync(join(browserFalse, 'server.js'), 'export default 1;\n');

test.each([...nodeEnvs])(
  "with NODE_ENV %s, a browser build allows a package's browser field to map a module to false",
  async (nodeEnv) => {
    await expect(
      withNodeEnv(nodeEnv, () =>
        buildSource(`import { value } from '${basename(browserFalse)}'; console.log(value);`),
      ),
    ).resolves.toBeDefined();
  },
);

// A key that names a path maps the package's own file, so the Node module it shares a name
// with is still externalized when the package imports it.
const ownFileKeys = ['./fs.js', './fs', 'fs/index.js'] as const;
const ownFile = Object.fromEntries(
  ownFileKeys.map((key) => {
    const dir = mkdtempSync(
      join(fileURLToPath(new URL('../node_modules', import.meta.url)), 'browser-own-file-'),
    );
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: basename(dir),
        version: '1.0.0',
        type: 'module',
        main: 'index.js',
        browser: { [key]: false },
      }),
    );
    writeFileSync(
      join(dir, 'index.js'),
      "import { readFileSync } from 'fs';\nexport const value = readFileSync;\n",
    );
    writeFileSync(join(dir, 'fs.js'), 'export default 1;\n');
    return [key, basename(dir)];
  }),
);
afterAll(() => {
  for (const name of Object.values(ownFile))
    rmSync(join(fileURLToPath(new URL('../node_modules', import.meta.url)), name), {
      recursive: true,
      force: true,
    });
});

test.each(nodeEnvs.flatMap((nodeEnv) => ownFileKeys.map((key) => [nodeEnv, key] as const)))(
  'with NODE_ENV %s, a browser field key %s does not let a package import the Node module',
  async (nodeEnv, key) => {
    const built = withNodeEnv(nodeEnv, () =>
      buildSource(`import { value } from '${ownFile[key]}'; console.log(value);`),
    );
    await expect(built).rejects.toThrow('externalized for browser compatibility');
    await expect(built).rejects.toThrow('"fs"');
  },
);
