import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    allowedHosts: true,
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
});