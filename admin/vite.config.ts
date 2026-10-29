import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// UI de la app local del owner. Se compila a ui/dist y la sirve el servidor Express.
export default defineConfig({
  root: 'ui',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: { '/api': 'http://127.0.0.1:5050' },
  },
});
