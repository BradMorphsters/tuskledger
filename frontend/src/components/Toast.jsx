/**
 * Toast — global notification system. Visual feedback for async actions
 * (saves, deletes, errors) and 5-second undo windows for destructive ops.
 *
 * Wire ToastProvider once at App level. Then call useToast() anywhere:
 *
 *   const { toast } = useToast()
 *   toast({ kind: 'success', message: 'Transaction saved' })
 *   toast({ kind: 'undo', message: 'Deleted',
 *           onUndo: () => restoreTransaction(id), timeout: 5000 })
 *
 * For error toasts, the call site can attach context that powers a
 * one-click "copy diagnostic for my assistant" button (rendered
 * automatically when `kind: 'error'`, suppress with `assistant: false`):
 *
 *   toast({
 *     kind: 'error',
 *     message: 'Plaid sync failed',
 *     error: err.message,
 *     location: 'Accounts page',
 *     userAction: 'clicked Sync Now',
 *     context: { itemId: '...', plaidEnv: 'production' },
 *   })
 *
 * That builds a tailored prompt for Claude / Cursor / Cowork with the
 * error, recent state, and explicit safety boundaries — see
 * components/CopyToAssistant.jsx for the exact prompt shape.
 *
 * Stacks toasts at the bottom-right; oldest dismisses first when capped.
 */
import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { CheckCircle, AlertCircle, Info, X, RotateCcw } from 'lucide-react'
import CopyToAssistant from './CopyToAssistant'

const ToastCtx = createContext(null)
const MAX_TOASTS = 5
const DEFAULT_TIMEOUT = 3500

let nextId = 1

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  // Use refs to track timers so we can clear them when a toast is
  // manually dismissed or its onUndo is called (fires before timeout).
  const timers = useRef({})

  const dismiss = useCallback((id) => {
    setToasts(ts => ts.filter(t => t.id !== id))
    if (timers.current[id]) {
      clearTimeout(timers.current[id])
      delete timers.current[id]
    }
  }, [])

  const toast = useCallback((opts) => {
    const id = nextId++
    const t = {
      id,
      kind: 'info',
      timeout: DEFAULT_TIMEOUT,
      ...opts,
    }
    setToasts(ts => [...ts.slice(-(MAX_TOASTS - 1)), t])
    if (t.timeout > 0) {
      timers.current[id] = setTimeout(() => dismiss(id), t.timeout)
    }
    return id
  }, [dismiss])

  return (
    <ToastCtx.Provider value={{ toast, dismiss }}>
      {children}
      <ToastStack toasts={toasts} dismiss={dismiss} />
    </ToastCtx.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastCtx)
  if (!ctx) {
    // No-op fallback so call sites don't crash when used outside a provider.
    return { toast: () => {}, dismiss: () => {} }
  }
  return ctx
}

function ToastStack({ toasts, dismiss }) {
  if (toasts.length === 0) return null
  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24,
      display: 'flex', flexDirection: 'column-reverse', gap: 8,
      zIndex: 200, pointerEvents: 'none',
    }}>
      {toasts.map(t => <ToastItem key={t.id} toast={t} dismiss={dismiss} />)}
    </div>
  )
}

function ToastItem({ toast: t, dismiss }) {
  const colors = {
    success: { bg: 'rgba(52,211,153,0.12)', border: 'rgba(52,211,153,0.4)', fg: 'var(--accent-green)', icon: CheckCircle },
    error:   { bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.4)', fg: 'var(--accent-red)', icon: AlertCircle },
    info:    { bg: 'rgba(96,165,250,0.12)', border: 'rgba(96,165,250,0.4)', fg: 'var(--accent-blue)', icon: Info },
    undo:    { bg: 'rgba(251,146,60,0.12)', border: 'rgba(251,146,60,0.4)', fg: 'var(--accent-orange)', icon: RotateCcw },
  }
  const c = colors[t.kind] || colors.info
  const Icon = c.icon
  // Error toasts get a "copy diagnostic for my assistant" affordance so
  // the user can hand the failure straight to Claude / Cursor / Cowork
  // without having to figure out what to type. Caller can opt out by
  // passing `assistant: false` in the toast options. See AGENTS.md and
  // the agent-friendly section on www.tuskledger.com.
  const showAssistantHelper =
    t.kind === 'error' && t.assistant !== false
  return (
    <div style={{
      pointerEvents: 'auto',
      background: 'var(--bg-card)',
      border: `1px solid ${c.border}`,
      borderRadius: 8, padding: '10px 14px',
      display: 'flex',
      flexDirection: showAssistantHelper ? 'column' : 'row',
      alignItems: showAssistantHelper ? 'stretch' : 'center',
      gap: showAssistantHelper ? 8 : 10,
      minWidth: 280, maxWidth: 420,
      boxShadow: 'var(--shadow-lg)',
      fontSize: 13, color: 'var(--text-primary)',
      animation: 'toastIn 0.15s ease-out',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
        <Icon size={16} style={{ color: c.fg, flexShrink: 0 }} />
        <span style={{ flex: 1 }}>{t.message}</span>
        {t.onUndo && (
          <button
            onClick={() => { t.onUndo(); dismiss(t.id) }}
            style={{
              padding: '3px 10px', fontSize: 11, fontWeight: 600,
              background: c.fg, color: '#0d0e14',
              border: 'none', borderRadius: 4, cursor: 'pointer',
            }}
          >Undo</button>
        )}
        <button onClick={() => dismiss(t.id)} style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--text-muted)', padding: 0,
        }}>
          <X size={14} />
        </button>
      </div>
      {showAssistantHelper && (
        <CopyToAssistant
          title={t.message || 'Tusk Ledger error'}
          error={t.error}
          location={t.location}
          userAction={t.userAction}
          context={t.context}
          size="small"
          variant="block"
        />
      )}
    </div>
  )
}

// Attach a small @keyframes once at module load — harmless if duplicated
// across React strict-mode mounts.
if (typeof document !== 'undefined' && !document.getElementById('toast-keyframes')) {
  const s = document.createElement('style')
  s.id = 'toast-keyframes'
  s.textContent = '@keyframes toastIn { from { transform: translateY(8px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }'
  document.head.appendChild(s)
}
