import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API address is the only thing this client needs to be told. Everything
// else it learns from the API itself.
export default defineConfig({
  plugins: [react()],
  server: { port: 5180 },
  // A production bundle carries no source maps: the client's sources are not
  // served beside it. The development server maps as before.
  build: { outDir: 'dist', sourcemap: false },
});
