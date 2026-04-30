/**
 * Vitest setup — runs once before every test file.
 *
 * - Pulls in @testing-library/jest-dom matchers so tests can use
 *   `expect(el).toBeInTheDocument()` and friends.
 * - Resets localStorage between tests so persistence-backed
 *   components start clean (the storage helpers are pure side-effects).
 * - Stubs `window.matchMedia` because jsdom doesn't ship it and
 *   QuickActions/ThemeToggle calls it on mount.
 * - Stubs `window.confirm` to return true by default. Individual tests
 *   that care about the confirm flow can override with vi.spyOn.
 */
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// ── Auto-cleanup between tests ──────────────────────────────────────
// React Testing Library's cleanup unmounts everything between tests so
// a forgotten unmount in one test can't leak DOM into the next.
afterEach(() => {
  cleanup()
  localStorage.clear()
})

// ── jsdom shims ─────────────────────────────────────────────────────
beforeEach(() => {
  // matchMedia is undefined in jsdom; QuickActions reads it for
  // prefers-color-scheme detection.
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation(query => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),    // legacy
      removeListener: vi.fn(),  // legacy
      dispatchEvent: vi.fn(),
    }))
  }
  // window.confirm — used by the Demo→Real switch guard. Default to
  // true so happy-path tests don't have to stub. Tests that exercise
  // the cancel path should `vi.spyOn(window, 'confirm').mockReturnValueOnce(false)`.
  if (!window.confirm.mockReturnValue) {
    window.confirm = vi.fn(() => true)
  }
})
