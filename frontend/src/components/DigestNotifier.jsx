import { useEffect } from 'react'
import { getWeeklyDigest } from '../api/client'
import { toLocalISODate } from '../lib/format'

/**
 * DigestNotifier — side-effect-only component, mounted once at the App
 * root next to BudgetAlertsMonitor. Fires at most one browser
 * notification per calendar week pointing the user at the matching /digest
 * query date, so a
 * once-a-week user gets pulled back in without needing to remember the
 * page exists. No UI of its own.
 *
 * Use the most recent Sunday as the reporting boundary. Opening the
 * app later in the week still delivers that digest once.
 */
const STORAGE_KEY = 'tuskledger-digest-fired'

function mostRecentSunday(date) {
  const d = new Date(date)
  d.setDate(d.getDate() - d.getDay())
  return d
}

export default function DigestNotifier() {
  useEffect(() => {
    let cancelled = false

    async function check() {
      try {
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
        const today = new Date()

        const weekKey = toLocalISODate(mostRecentSunday(today))
        let lastFired = null
        try { lastFired = localStorage.getItem(STORAGE_KEY) } catch { /* private mode etc. */ }
        if (lastFired === weekKey) return  // already fired for this week

        const digest = await getWeeklyDigest(weekKey)
        if (cancelled) return

        const spend = digest?.happened?.spend
        const deltaPct = digest?.happened?.spend_delta?.pct
        const body = spend === undefined
          ? 'Your weekly digest is ready.'
          : `You spent $${Math.round(spend).toLocaleString()} this week` +
            (deltaPct != null ? ` (${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(0)}% vs last week).` : '.')

        const notification = new Notification('Your week in money', {
          body,
          tag: `tuskledger-digest-${weekKey}`,
        })
        notification.onclick = () => {
          window.focus()
          window.location.href = `/digest?week_ending=${weekKey}`
        }

        try { localStorage.setItem(STORAGE_KEY, weekKey) } catch { /* best effort */ }
      } catch {
        // Never throw — a flaky fetch or a browser that blocks the
        // Notification API must not break the rest of the app.
      }
    }

    check()
    return () => { cancelled = true }
  }, [])

  return null
}
