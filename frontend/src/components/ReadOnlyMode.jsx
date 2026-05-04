/**
 * Read-only mode plumbing: a hook that resolves the device's view
 * mode (read-only ↔ edit) plus a small banner that renders at the
 * top of the app when read-only is active.
 *
 * Why a hook + banner instead of a context provider: the only thing
 * downstream components need is "should I render edit affordances?"
 * That's a single boolean. A context would force every consumer into
 * the React render tree of a provider, which adds noise; the hook
 * just reads from a cookie + caches in module-local state. No
 * provider, no boilerplate.
 *
 * Wire-up in App.jsx:
 *   const readOnly = useReadOnlyMode()
 *   <ReadOnlyBanner show={readOnly} />
 *   ...
 *   {!readOnly && <QuickAddFab .../>}
 *   {!readOnly && <button onClick={triggerSync}>Sync</button>}
 *
 * Phone activation flow:
 *   1. User loads `https://tunnel.example.com/?view=readonly` once.
 *   2. The hook detects ?view=readonly, calls setViewMode('readonly')
 *      which sets the tuskledger_view cookie via the backend.
 *   3. Banner renders, edit UI hides. Cookie persists 90 days; reload
 *      keeps the device in read-only mode. ?view=edit flips it back.
 *
 * Hardcoding ?view=readonly into the home-screen URL means the
 * activation is one-time per device and survives PWA install.
 */
import { useEffect, useState } from 'react'
import { Eye } from 'lucide-react'
import { getViewMode, setViewMode } from '../api/client'


/**
 * Returns true when this device is in read-only mode.
 *
 * On mount:
 *   - If URL has ?view=readonly or ?view=edit, post that to the backend
 *     to set the cookie (so the choice persists past this page load).
 *   - Otherwise, read the current cookie value via /api/view/.
 *
 * Falls back to "edit" (the safer default — a misfired API call
 * shouldn't silently hide write UI on a laptop). Returns null while
 * still loading so callers can avoid flickering edit→readonly→edit
 * during boot.
 */
export function useReadOnlyMode() {
  const [readOnly, setReadOnly] = useState(null)
  useEffect(() => {
    let cancelled = false
    const url = new URL(window.location.href)
    const param = url.searchParams.get('view')
    const apply = async () => {
      try {
        if (param === 'readonly' || param === 'edit') {
          // The user explicitly asked for a mode via URL — set the
          // cookie, then strip the param so a refresh doesn't re-fire
          // and so screenshots don't have an ugly query string.
          await setViewMode(param)
          url.searchParams.delete('view')
          window.history.replaceState({}, '', url.toString())
          if (!cancelled) setReadOnly(param === 'readonly')
          return
        }
        const data = await getViewMode()
        if (!cancelled) setReadOnly(data?.view === 'readonly')
      } catch {
        if (!cancelled) setReadOnly(false)  // safe default
      }
    }
    apply()
    return () => { cancelled = true }
  }, [])

  // Local helper for the in-banner promote button. Caller has already
  // set the cookie via setViewMode(); this just updates local state so
  // the UI reacts without a reload.
  const setMode = (mode) => setReadOnly(mode === 'readonly')

  return { readOnly: readOnly === true, setMode }
}


/**
 * Banner at the top of the page when read-only is active. Tells the
 * user why edit buttons are missing and offers a one-tap promotion
 * to edit mode for couch-side fixes.
 *
 * Why purple: matches the AI/local-LLM accent color so it reads as
 * "system context info" rather than a warning (orange/red would
 * imply something's broken).
 *
 * Why a button (instead of just instructions): the original copy told
 * the user to reload with `?view=edit` in the URL bar — fine on a
 * laptop, awful on a phone. The button calls setViewMode('edit')
 * directly, no URL gymnastics. Page state updates in place; the
 * banner disappears, edit affordances reappear.
 */
export function ReadOnlyBanner({ show, onModeChange }) {
  const [switching, setSwitching] = useState(false)
  if (!show) return null

  const handlePromote = async () => {
    setSwitching(true)
    try {
      await setViewMode('edit')
      // Notify parent so it can re-render with edit affordances
      // visible. If no callback, fall back to a reload — at minimum
      // the cookie is set and next load will pick it up.
      if (onModeChange) {
        onModeChange('edit')
      } else {
        window.location.reload()
      }
    } catch (err) {
      console.warn('[tuskledger] failed to switch to edit mode:', err)
      setSwitching(false)
    }
  }

  return (
    <div
      role="status"
      style={{
        background: 'rgba(175, 169, 236, 0.12)',
        borderBottom: '1px solid rgba(175, 169, 236, 0.3)',
        color: 'var(--text-secondary)',
        fontSize: 12,
        padding: '6px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        zIndex: 5,
        flexWrap: 'wrap',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Eye size={13} style={{ color: 'var(--accent-purple)' }} />
        <strong style={{ color: 'var(--accent-purple)' }}>Read-only.</strong>
        {' '}Edits hidden on this device.
      </span>
      <button
        type="button"
        onClick={handlePromote}
        disabled={switching}
        style={{
          background: 'rgba(175, 169, 236, 0.2)',
          border: '1px solid rgba(175, 169, 236, 0.4)',
          color: 'var(--accent-purple)',
          fontSize: 11,
          fontWeight: 600,
          padding: '4px 10px',
          borderRadius: 4,
          cursor: switching ? 'wait' : 'pointer',
          opacity: switching ? 0.6 : 1,
          /* 32px min-height keeps the button finger-friendly on phone
             without bloating the banner on desktop. */
          minHeight: 32,
        }}
      >
        {switching ? 'Switching…' : 'Switch to edit mode'}
      </button>
    </div>
  )
}
