/**
 * Budget alert evaluation — the pure core of BudgetAlertsMonitor.
 *
 * History: the monitor shipped reading `cat.amount_limit` and
 * `cat.amount_spent` off GET /budgets/, which returns `limit_amount` and
 * no spent figure at all. The guard `if (!cat.amount_limit) continue`
 * therefore skipped every line, and the feature never fired a single
 * notification. It also iterated every month's budget ever saved, not
 * just the current one.
 *
 * The monitor now feeds this function the current month's
 * /transactions/spending-summary rows — `{ category, total, budget_limit }`
 * — which is the same data the Budgets page renders, so an alert and the
 * page can never disagree.
 *
 * Dependency-free so it can be unit-tested and run under plain node.
 */

// Ordered highest first: only the highest newly-crossed tier fires per
// category per check, and each tier fires once per month.
export const TIERS = [
  { pct: 1.0, label: '100%', tone: '⚠ over budget' },
  { pct: 0.9, label: '90%' },
  { pct: 0.75, label: '75%' },
]

/**
 * @param {object}   args
 * @param {Array<{category: string, total: number, budget_limit?: number|null}>} args.categories
 *        spending-summary rows for the CURRENT month.
 * @param {Record<string, number>} args.fired  highest tier already alerted per
 *        category this month (category → pct). Mutated copy is returned.
 * @param {number} args.dayOfMonth
 * @param {number} args.daysInMonth
 * @returns {{ alerts: Array<{category, pct, label, tone, usedPct, limit, spent, body}>,
 *             fired: Record<string, number> }}
 */
export function evaluateBudgetAlerts({ categories = [], fired = {}, dayOfMonth, daysInMonth }) {
  const monthFraction = daysInMonth > 0 ? dayOfMonth / daysInMonth : 1
  const nextFired = { ...fired }
  const alerts = []

  for (const row of categories) {
    const limit = Number(row?.budget_limit)
    if (!Number.isFinite(limit) || limit <= 0) continue        // unbudgeted line
    const spent = Number(row?.total) || 0
    const usedPct = spent / limit
    const already = nextFired[row.category] || 0

    for (const t of TIERS) {
      if (usedPct < t.pct || already >= t.pct) continue
      // 75% at day 23 of 30 is on pace, not alarming — suppress the
      // gentlest tier once the month itself is past 75%.
      if (t.pct === 0.75 && monthFraction > 0.75) continue
      alerts.push({
        category: row.category,
        pct: t.pct,
        label: t.label,
        tone: t.tone || null,
        usedPct,
        limit,
        spent,
        body: `${row.category}: ${t.tone || `at ${t.label}`} (${Math.round(usedPct * 100)}% of $${Math.round(limit).toLocaleString('en-US')} used)`,
      })
      nextFired[row.category] = t.pct
      break   // highest crossed tier only
    }
  }

  return { alerts, fired: nextFired }
}
