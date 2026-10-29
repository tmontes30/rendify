import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_BASE lo define el workflow de GitHub Pages (/<nombre-del-repo>/).
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173 },
  build: { sourcemap: false },
});
