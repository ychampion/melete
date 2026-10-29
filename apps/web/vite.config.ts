import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Vite swaps a Node module in a browser build for a stub. Outside production the stub is named
// after the module; in production every stub has the bare id, the same one a package gets when
// its `browser` field maps a module to false, which is an empty module by design. Vite also logs
// a warning that names the module, but Rolldown hands that warning to plugins without waiting,
// so it can arrive after the build has ended. The guard decides from the resolution instead.
const browserExternal = '__vite-browser-external';
const rejected = '\0rejected-browser-external:';

const isNodeBuiltin = (id: string) =>
  id.startsWith('node:') || id.startsWith('bun:') || builtinModules.includes(id);

// Whether the package holding the importer maps this module to false in its `browser` field.
function packageMapsToFalse(id: string, importer: string | undefined) {
  if (!importer || importer.startsWith('\0')) return false;
  let dir = dirname(importer.replace(/[?#].*$/, ''));
  for (;;) {
    let manifest: string | undefined;
    try {
      manifest = readFileSync(join(dir, 'package.json'), 'utf8');
    } catch {}
    if (manifest !== undefined) {
      let browser: unknown;
      try {
        browser = (JSON.parse(manifest) as { browser?: unknown }).browser;
      } catch {
        return false;
      }
      if (typeof browser !== 'object' || browser === null) return false;
      // A relative key such as "./fs.js" maps the package's own file, never the Node module.
      return Object.entries(browser).some(
        ([key, value]) => value === false && (key === id || key === `${id}.js`),
      );
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function rejectBrowserExternalization(): Plugin {
  return {
    name: 'reject-browser-externalization',
    apply: 'build',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!isNodeBuiltin(source)) return;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved?.id.startsWith(browserExternal)) return resolved;
      if (resolved.id === browserExternal && packageMapsToFalse(source, importer)) return resolved;
      return `${rejected}${source}`;
    },
    load(id) {
      if (id.startsWith(rejected)) return 'export default {};';
    },
    buildEnd() {
      const externalized: string[] = [];
      for (const id of this.getModuleIds()) {
        if (!id.startsWith(rejected)) continue;
        const info = this.getModuleInfo(id);
        const importers = [...(info?.importers ?? []), ...(info?.dynamicImporters ?? [])];
        externalized.push(
          `Module "${id.slice(rejected.length)}" has been externalized for browser compatibility, imported by ${importers.map((path) => `"${path}"`).join(', ')}.`,
        );
      }
      // Fail here, before Vite can emit a bundle containing browser stubs.
      if (externalized.length > 0) this.error(externalized.join('\n'));
    },
  };
}

// The API address is the only thing this client needs to be told. Everything
// else it learns from the API itself.
export default defineConfig({
  plugins: [react(), rejectBrowserExternalization()],
  server: { port: 5180 },
  // A production bundle carries no source maps: the client's sources are not
  // served beside it. The development server maps as before.
  build: { outDir: 'dist', sourcemap: false },
});
