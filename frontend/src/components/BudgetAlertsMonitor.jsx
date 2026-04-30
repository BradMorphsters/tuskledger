/**
 * BudgetAlertsMonitor — silent component that watches your budget
 * categories and fires browser notifications when you cross 75% / 90%
 * / 100% of any category's monthly limit. No UI of its own — runs
 * in the background once mounted.
 *
 * Mounted at the App level so it polls regardless of which page you're on.
 *
 * State persistence:
 *   - Permission status: Notification.permission (browser-native)
 *   - "Already alerted at threshold X for category Y this month" set:
 *     localStorage so you don't get spammed every 5 minutes
 *
 * Threshold crossing logic:
 *   - 75% → first warning ("you've used 75% of your Dining budget")
 *   - 90% → second warning
 *   - 100% → over-budget alert
 *   - Each fires once per category per month; resets on the 1st
 */
import { useEffect, useState } from 'react'
import { getBudgets } from '../api/client'

const ALERTED_KEY = 'tuskledger-budget-alerts-fired'
const POLL_INTERVAL_MS = 5 * 60 * 1000  // 5 minutes

function loadAlerted() {
  try {
    const raw = JSON.parse(localStorage.getItem(ALERTED_KEY) || '{}')
    // Reset if month rolled over since last save
    const currentMonth = new Date().toISOString().slice(0, 7)
    if (raw.month !== currentMonth) return { month: currentMonth, fired: {} }
    return raw
  } catch { return { month: new Date().toISOString().slice(0, 7), fired: {} } }
}
function saveAlerted(state) {
  try { localStorage.setItem(ALERTED_KEY, JSON.stringify(state)) } catch {}
}

export function BudgetAlertsMonitor() {
  const [enabled, setEnabled] = useState(() => {
    if (typeof Notification === 'undefined') return false
    return Notification.permission === 'granted'
  })

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    let alerted = loadAlerted()

    const checkBudgets = async () => {
      try {
        const budgets = await getBudgets()
        if (cancelled) return
        const today = new Date()
        const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
        const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0)
        const dayOfMonth = today.getDate()
        const totalDays = monthEnd.getDate()
        const monthFraction = dayOfMonth / totalDays

        for (const b of budgets || []) {
          if (!b.categories || !Array.isArray(b.categories)) continue
          for (const cat of b.categories) {
            if (!cat.amount_limit || cat.amount_limit <= 0) continue
            const usedPct = (cat.amount_spent || 0) / cat.amount_limit
            const key = `${b.id}-${cat.category}`
            const fired = alerted.fired[key] || 0  // highest threshold already alerted
            // Threshold tiers (in order). Only fire each once per month.
            const tiers = [
              { pct: 1.0, label: '100%', tone: '⚠ over budget' },
              { pct: 0.9, label: '90%' },
              { pct: 0.75, label: '75%' },
            ]
            for (const t of tiers) {
              if (usedPct >= t.pct && fired < t.pct) {
                // Don't fire 75% if we're early in the month and on pace
                // (e.g., 75% used at day 23 of 30 = on pace, not alarming)
                if (t.pct === 0.75 && monthFraction > 0.75) continue
                new Notification('Tusk Ledger budget alert', {
                  body: `${cat.category}: ${t.tone || `at ${t.label}`} (${Math.round(usedPct * 100)}% of $${cat.amount_limit} used)`,
                  tag: `tuskledger-budget-${key}`,
                })
                alerted.fired[key] = t.pct
                saveAlerted(alerted)
                break  // only highest tier per category per check
              }
            }
          }
        }
      } catch {
        // Network errors are silent — nothing to alert about if backend is down.
      }
    }

    checkBudgets()  // immediate check on mount
    const interval = setInterval(checkBudgets, POLL_INTERVAL_MS)
    return () => { cancelled = true; clearInterval(interval) }
  }, [enabled])

  // Component renders nothing — this is a side-effect-only monitor.
  // The opt-in UI lives in the sidebar (BudgetAlertsToggle below).
  return null
}

/**
 * BudgetAlertsToggle — small button in the sidebar that requests
 * notification permission and toggles the monitor on/off.
 */
export function BudgetAlertsToggle() {
  const [permission, setPermission] = useState(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
  )

  if (permission === 'unsupported') return null

  const request = async () => {
    if (permission === 'granted') {
      // Re-grant via revisit to settings — browsers don't expose programmatic revoke
      alert('Notifications already enabled. To disable, change in browser site settings.')
      return
    }
    if (permission === 'denied') {
      alert('Notifications were blocked. Enable in browser site settings (lock icon → Notifications → Allow).')
      return
    }
    const result = await Notification.requestPermission()
    setPermission(result)
    if (result === 'granted') {
      new Notification('Tusk Ledger alerts enabled', {
        body: 'You\'ll get a heads-up when budget categories hit 75% / 90% / 100%.',
      })
    }
  }

  return (
    <button
      onClick={request}
      title={
        permission === 'granted'
          ? 'Budget alerts: ON'
          : 'Click to enable budget alerts'
      }
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '5px 8px',
        background: permission === 'granted' ? 'rgba(52,211,153,0.12)' : 'transparent',
        color: permission === 'granted' ? 'var(--accent-green)' : 'var(--text-muted)',
        border: '1px solid var(--border)', borderRadius: 4,
        fontSize: 11, cursor: 'pointer',
      }}
    >
      🔔 {permission === 'granted' ? 'Alerts on' : 'Alerts'}
    </button>
  )
}
