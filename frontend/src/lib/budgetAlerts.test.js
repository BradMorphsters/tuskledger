import { describe, it, expect } from 'vitest'
import { evaluateBudgetAlerts, TIERS } from './budgetAlerts'

const midMonth = { dayOfMonth: 15, daysInMonth: 30 }

describe('evaluateBudgetAlerts', () => {
  it('fires nothing for unbudgeted or zero-limit lines', () => {
    const { alerts } = evaluateBudgetAlerts({
      categories: [
        { category: 'Gov & Taxes', total: 420 },                 // no budget_limit
        { category: 'Other', total: 500, budget_limit: 0 },
        { category: 'Nope', total: 500, budget_limit: null },
      ],
      ...midMonth,
    })
    expect(alerts).toEqual([])
  })

  it('reads spending-summary field names (total / budget_limit)', () => {
    // The old monitor looked for amount_spent / amount_limit and skipped everything.
    const { alerts } = evaluateBudgetAlerts({
      categories: [{ category: 'Services', total: 410.5, budget_limit: 200 }],
      ...midMonth,
    })
    expect(alerts).toHaveLength(1)
    expect(alerts[0].category).toBe('Services')
    expect(alerts[0].pct).toBe(1.0)
  })

  it('fires only the highest crossed tier per category', () => {
    const { alerts, fired } = evaluateBudgetAlerts({
      categories: [{ category: 'Shopping', total: 1120, budget_limit: 1000 }],  // 112%
      ...midMonth,
    })
    expect(alerts).toHaveLength(1)
    expect(alerts[0].tone).toBe('⚠ over budget')
    expect(fired.Shopping).toBe(1.0)
  })

  it('does not re-fire a tier already alerted this month', () => {
    const { alerts } = evaluateBudgetAlerts({
      categories: [{ category: 'Shopping', total: 1120, budget_limit: 1000 }],
      fired: { Shopping: 1.0 },
      ...midMonth,
    })
    expect(alerts).toEqual([])
  })

  it('escalates from an earlier tier to a higher one', () => {
    const { alerts } = evaluateBudgetAlerts({
      categories: [{ category: 'Groceries', total: 460, budget_limit: 500 }],   // 92%
      fired: { Groceries: 0.75 },
      ...midMonth,
    })
    expect(alerts.map(a => a.pct)).toEqual([0.9])
  })

  it('suppresses the 75% tier late in the month (on pace, not alarming)', () => {
    const late = { dayOfMonth: 24, daysInMonth: 30 }   // 80% of the month gone
    const { alerts } = evaluateBudgetAlerts({
      categories: [{ category: 'Groceries', total: 385, budget_limit: 500 }],  // 77%
      ...late,
    })
    expect(alerts).toEqual([])
    // …but 90% still fires late in the month.
    const { alerts: a2 } = evaluateBudgetAlerts({
      categories: [{ category: 'Groceries', total: 460, budget_limit: 500 }],
      ...late,
    })
    expect(a2.map(a => a.pct)).toEqual([0.9])
  })

  it('does not mutate the fired map it was given', () => {
    const fired = {}
    evaluateBudgetAlerts({
      categories: [{ category: 'Shopping', total: 1300, budget_limit: 1000 }],
      fired,
      ...midMonth,
    })
    expect(fired).toEqual({})
  })

  it('formats a readable notification body', () => {
    const { alerts } = evaluateBudgetAlerts({
      categories: [{ category: 'Bills & Utilities', total: 366, budget_limit: 300 }],
      ...midMonth,
    })
    expect(alerts[0].body).toBe('Bills & Utilities: ⚠ over budget (122% of $300 used)')
  })

  it('tiers are ordered highest first', () => {
    expect(TIERS.map(t => t.pct)).toEqual([1.0, 0.9, 0.75])
  })
})
