import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

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
