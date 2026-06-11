import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // host: true binds Vite to 0.0.0.0 so devices on your LAN (your
    // phone, an iPad, another laptop) can reach the dev server at
    // your laptop's LAN IP — e.g. http://192.168.1.42:3000. Without
    // this, Vite only listens on the loopback interface and the phone
    // gets "connection refused." Production builds aren't affected.
    host: true,
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
    // _disabled holds deliberately-parked tests (see src/_disabled/README).
    // Excluding them keeps the suite green instead of reporting a permanent
    // "1 failed" for files that can't even resolve their imports from there.
    exclude: ['src/_disabled/**', 'node_modules/**'],
    css: false,
  },
})
