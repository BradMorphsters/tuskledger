import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.TUSKLEDGER_WEB_PORT) || 3000,
    // Fail instead of silently hopping to 3001 when 3000 is taken. Vite's
    // default auto-increment is convenient for throwaway projects and wrong
    // here: the launcher, the iOS pairing URL and the browser it opens all
    // assume one web port, so a silent hop just moves the confusion.
    strictPort: true,
    // host: true binds Vite to 0.0.0.0 so devices on your LAN (your
    // phone, an iPad, another laptop) can reach the dev server at
    // your laptop's LAN IP — e.g. http://192.168.1.42:3000. Without
    // this, Vite only listens on the loopback interface and the phone
    // gets "connection refused." Production builds aren't affected.
    host: true,
    proxy: {
      '/api': {
        // Backend port comes from TUSKLEDGER_PORT so the whole stack agrees
        // on one number: the launcher passes it to uvicorn, services/bonjour
        // advertises it to the iOS app, and routers/mobile builds the pairing
        // QR from it. Hardcoding it here meant that running the backend
        // anywhere else silently proxied /api to whatever ELSE owned 8000 —
        // which surfaced as a login prompt, not as a proxy error.
        target: `http://127.0.0.1:${process.env.TUSKLEDGER_PORT || 8000}`,
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
