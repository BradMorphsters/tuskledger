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
  return readOnly === true   // null/false both render edit UI; only true hides
}


/**
 * Tiny dismissible-looking (but not actually dismissible) banner at
 * the top of the page when read-only is active. Tells the user why
 * edit buttons are missing and how to flip back.
 *
 * Why purple: matches the AI/local-LLM accent color so it reads as
 * "system context info" rather than a warning (orange/red would
 * imply something's broken).
 */
export function ReadOnlyBanner({ show }) {
  if (!show) return null
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
        gap: 8,
        zIndex: 5,
      }}
    >
      <Eye size={13} style={{ color: 'var(--accent-purple)' }} />
      <span>
        <strong style={{ color: 'var(--accent-purple)' }}>Read-only.</strong>
        {' '}Edits happen on your laptop. Reload with{' '}
        <code style={{
          background: 'var(--bg-elevated)',
          padding: '1px 5px',
          borderRadius: 3,
          fontSize: 11,
        }}>?view=edit</code>{' '}to switch.
      </span>
    </div>
  )
}
