import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Vite swaps a Node module in a browser build for this stub. The stub is in the module graph
// whatever NODE_ENV is; the warning that names the module is logged only in production.
const browserExternal = '__vite-browser-external';

function rejectBrowserExternalization(): Plugin {
  const externalized = new Set<string>();
  return {
    name: 'reject-browser-externalization',
    apply: 'build',
    buildStart() {
      externalized.clear();
    },
    onLog(_level, log) {
      if (log.message.includes('externalized for browser compatibility'))
        externalized.add(log.message);
    },
    buildEnd() {
      if (externalized.size === 0)
        for (const id of this.getModuleIds()) {
          if (!id.startsWith(browserExternal)) continue;
          const info = this.getModuleInfo(id);
          const importers = [...(info?.importers ?? []), ...(info?.dynamicImporters ?? [])];
          const name = id.slice(browserExternal.length + 1) || 'a Node module';
          externalized.add(
            `Module "${name}" has been externalized for browser compatibility, imported by ${importers.map((path) => `"${path}"`).join(', ')}.`,
          );
        }
      // Errors thrown from the resolver's log callback do not stop the build.
      // Fail here before Vite can emit a bundle containing browser stubs.
      if (externalized.size > 0) this.error([...externalized].join('\n'));
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
