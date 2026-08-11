import { defineConfig } from 'vite';

// GitHub Pages serves a project site from /<repo>/, so the build needs that
// prefix. Overridable for a user/org site or another host: BASE_PATH=/ npm run build
const rawBase = process.env.BASE_PATH || '/change-character-world/';
const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;

export default defineConfig({
  base,
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4188,
    strictPort: true,
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
});
