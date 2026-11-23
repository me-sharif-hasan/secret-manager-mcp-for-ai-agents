import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, run `secretmgr dashboard --no-open` (port 7777) and `npm run dev -w dashboard`.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:7777' } },
  build: { outDir: 'dist', sourcemap: false },
});
