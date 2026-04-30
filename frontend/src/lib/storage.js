/**
 * localStorage helpers.
 *
 * The codebase had 30+ scattered try/catch wrappers around
 * localStorage calls, each handling errors slightly differently
 * (some swallow JSON.parse errors, some return undefined, some
 * return a fallback). Centralising so the behaviour is predictable
 * and the try/catch boilerplate disappears from feature code.
 *
 * Why try/catch at all? Two reasons:
 *   - Safari private browsing / quota-exceeded errors throw on
 *     setItem.
 *   - Stored JSON can be corrupted (manual edits, schema changes)
 *     and a parse error would crash the calling component.
 */

import { useState, useEffect, useCallback } from 'react'

/**
 * Read a JSON-serialisable value from localStorage.
 * Returns `defaultValue` if the key is missing OR the value can't
 * be parsed (corrupted storage). Never throws.
 */
export function loadJSON(key, defaultValue = null) {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null || raw === undefined) return defaultValue
    return JSON.parse(raw)
  } catch {
    return defaultValue
  }
}

/**
 * Write a JSON-serialisable value to localStorage. Returns true on
 * success, false on quota errors / private browsing / etc. Never throws.
 */
export function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

/**
 * Remove a key from localStorage. Never throws.
 */
export function removeKey(key) {
  try {
    localStorage.removeItem(key)
    return true
  } catch {
    return false
  }
}

/**
 * One-time migration: copy every legacy `fintrack.*` / `fintrack-*`
 * localStorage key onto its `tuskledger.*` / `tuskledger-*` equivalent
 * so user UI state (rolling toggles, view modes, pinned IDs, theme,
 * cached scope choices, …) survives the rename. Idempotent — gated by
 * a sentinel key so it only runs the first time.
 *
 * Behavior notes:
 *   - The original `fintrack.*` keys are LEFT IN PLACE so the user can
 *     downgrade to a pre-rename build without losing state. Storage
 *     pressure is negligible (< 50 small JSON values across the app).
 *   - If a target `tuskledger.*` key already exists (e.g. user already
 *     wrote some new state before the migration ran), we don't
 *     overwrite — the new value wins.
 *   - All errors swallowed; localStorage may be unavailable in private
 *     browsing or quota-exceeded states, in which case the migration
 *     silently no-ops and the user just starts fresh.
 *
 * Call this once near the top of App.jsx mount (or main.jsx) so it
 * runs before any feature code reads its keys.
 */
const MIGRATION_FLAG = 'tuskledger.localStorageMigrated.v1'
export function migrateLegacyStorageKeys() {
  try {
    if (localStorage.getItem(MIGRATION_FLAG) === '1') return { migrated: 0, skipped: true }
    let migrated = 0
    // Snapshot keys first because we'll be writing during the loop
    // and Storage iteration is undefined under concurrent mutation.
    // We deliberately look for the LEGACY 'fintrack' prefix here —
    // the source side of the migration. Don't sed this to 'tuskledger'.
    const keys = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      // eslint-disable-next-line no-restricted-syntax -- legacy prefix is the whole point
      if (k && (k.startsWith('fintrack.') || k.startsWith('fintrack-'))) {
        keys.push(k)
      }
    }
    for (const k of keys) {
      // eslint-disable-next-line no-restricted-syntax -- legacy prefix is the whole point
      const newKey = 'tuskledger' + k.slice('fintrack'.length)  // preserves separator (- or .)
      if (localStorage.getItem(newKey) !== null) continue  // don't clobber existing
      const value = localStorage.getItem(k)
      if (value !== null) {
        try {
          localStorage.setItem(newKey, value)
          migrated++
        } catch {
          // quota / private mode — give up on this key but keep going
        }
      }
    }
    localStorage.setItem(MIGRATION_FLAG, '1')
    return { migrated, skipped: false }
  } catch {
    return { migrated: 0, skipped: true, error: true }
  }
}

/**
 * useState backed by localStorage. The initial value is loaded
 * synchronously from storage on mount; updates are persisted on
 * every change. Lazy initialiser keeps the localStorage read out
 * of the render path on subsequent renders.
 *
 * Usage:
 *   const [pinnedIds, setPinnedIds] = useStoredState(
 *     'tuskledger.pinnedTransactions.v1', []
 *   )
 *
 * Pass a function as defaultValue if construction is expensive —
 * it'll only run once on the first mount.
 */
export function useStoredState(key, defaultValue) {
  const [value, setValue] = useState(() => {
    const fallback = typeof defaultValue === 'function' ? defaultValue() : defaultValue
    const stored = loadJSON(key, undefined)
    // Treat both `undefined` (key missing) and `null` (key present but
    // stored as the JSON literal "null") as "no value" — null almost
    // always means "stale/corrupted/cleared" rather than an intentional
    // value the caller wants, and forwarding it caused crashes when
    // callers spread it as an object or array.
    return (stored === undefined || stored === null) ? fallback : stored
  })

  useEffect(() => {
    saveJSON(key, value)
  }, [key, value])

  // Stable setter that mirrors useState's signature, including the
  // function-updater form.
  const set = useCallback((next) => {
    setValue(prev => typeof next === 'function' ? next(prev) : next)
  }, [])

  return [value, set]
}
