import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  // Vitest configuration. Co-locating test config inside vite.config so
  // there's a single source of truth for build + test settings (Vite's
  // own recommendation). The `test` block is read by Vitest only —
  // `vite build` and `vite dev` ignore it.
  test: {
    // jsdom emulates the DOM so React Testing Library can render
    // components without a real browser. An order of magnitude faster
    // than headless Chrome for unit-scale tests.
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    // Permissive glob: any *.test.{js,jsx} under src/ is picked up.
    // Co-locating tests with code (vs. a parallel tests/ tree) keeps
    // them visible while editing and discoverable in file-tree search.
    include: ['src/**/*.test.{js,jsx}'],
    css: false,
  },
})
