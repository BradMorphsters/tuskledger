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
import { getSpendingSummary } from '../api/client'
import { evaluateBudgetAlerts } from '../lib/budgetAlerts'

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
        // Current month only, via spending-summary: the same rows the
        // Budgets page renders ({ category, total, budget_limit }), so an
        // alert can never disagree with the page. (The previous version
        // read GET /budgets/ — every month ever saved — and looked for
        // field names that endpoint never returned, so it never fired.)
        const today = new Date()
        const month = today.getMonth() + 1
        const year = today.getFullYear()
        const summary = await getSpendingSummary(month, year, 'personal')
        if (cancelled) return
        const daysInMonth = new Date(year, month, 0).getDate()
        const { alerts, fired } = evaluateBudgetAlerts({
          categories: summary?.categories || [],
          fired: alerted.fired,
          dayOfMonth: today.getDate(),
          daysInMonth,
        })
        if (alerts.length === 0) return
        for (const a of alerts) {
          new Notification('Tusk Ledger budget alert', {
            body: a.body,
            tag: `tuskledger-budget-${year}-${month}-${a.category}`,
          })
        }
        alerted = { ...alerted, fired }
        saveAlerted(alerted)
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
