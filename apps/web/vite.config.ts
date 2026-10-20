import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5190,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.HARNESS_PORT || loadEnv(mode, process.cwd(), 'HARNESS_').HARNESS_PORT || '4310'}` },
  },
  build: { outDir: '../../dist/web', emptyOutDir: true },
}));
