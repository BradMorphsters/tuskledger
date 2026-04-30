/**
 * Unit tests for the pure budget helpers.
 *
 * priorMonth has a January-wrap edge case that's the easiest place to
 * silently shift to the wrong year. rolloverCredit has a "floor at 0"
 * convention that's worth pinning down so a future change can't
 * silently start carrying negative credit forward (which would be
 * hostile design — punishing one bad month forever). budgetCategoryStatus
 * pins down "red only when over budget" so a future refactor can't
 * silently regress to the old 90%-is-red behavior.
 */
import { describe, expect, it } from 'vitest'
import {
  priorMonth,
  rolloverCredit,
  copyCategoriesFrom,
  budgetCategoryStatus,
} from './Budgets'

describe('priorMonth', () => {
  it('walks back one month within the same year', () => {
    expect(priorMonth(2026, 6)).toEqual({ year: 2026, month: 5 })
  })

  it('handles the January → December year wrap', () => {
    expect(priorMonth(2026, 1)).toEqual({ year: 2025, month: 12 })
  })

  it('handles December correctly (no wrap)', () => {
    expect(priorMonth(2026, 12)).toEqual({ year: 2026, month: 11 })
  })

  it('handles arbitrary years', () => {
    expect(priorMonth(2099, 1)).toEqual({ year: 2098, month: 12 })
  })
})

describe('rolloverCredit', () => {
  it('returns the unspent amount when prior month was under budget', () => {
    expect(rolloverCredit({ priorLimit: 500, priorSpent: 320 })).toBe(180)
  })

  it('returns 0 when prior month exactly hit budget', () => {
    expect(rolloverCredit({ priorLimit: 500, priorSpent: 500 })).toBe(0)
  })

  it('floors at 0 when prior month over-spent (does NOT carry negative)', () => {
    // Industry convention: rolling budgets never punish over-spend
    // forever. The "credit" is always 0 or positive.
    expect(rolloverCredit({ priorLimit: 500, priorSpent: 700 })).toBe(0)
  })

  it('treats null/undefined inputs as 0', () => {
    expect(rolloverCredit({ priorLimit: null, priorSpent: 200 })).toBe(0)
    expect(rolloverCredit({ priorLimit: 500, priorSpent: undefined })).toBe(500)
    expect(rolloverCredit({ priorLimit: undefined, priorSpent: undefined })).toBe(0)
  })

  it('coerces string-ish numeric inputs (forms often emit strings)', () => {
    expect(rolloverCredit({ priorLimit: '500', priorSpent: '320' })).toBe(180)
  })
})

describe('copyCategoriesFrom', () => {
  it('maps prior-month BudgetCategory rows into form-state shape', () => {
    const prior = [
      { id: 1, category: 'Groceries', limit_amount: 600 },
      { id: 2, category: 'Travel', limit_amount: 1050 },
    ]
    expect(copyCategoriesFrom(prior)).toEqual([
      { category: 'Groceries', limit_amount: 600 },
      { category: 'Travel', limit_amount: 1050 },
    ])
  })

  it('returns an empty array when nothing to copy', () => {
    expect(copyCategoriesFrom([])).toEqual([])
  })

  it('returns an empty array for non-array input (e.g. 404 fallback)', () => {
    // The Budgets API returns {} on a 404; be tolerant of that shape.
    expect(copyCategoriesFrom(undefined)).toEqual([])
    expect(copyCategoriesFrom(null)).toEqual([])
    expect(copyCategoriesFrom({})).toEqual([])
  })

  it('drops rows missing a category name (defensive against bad data)', () => {
    const prior = [
      { category: 'Food', limit_amount: 400 },
      { category: '', limit_amount: 100 },     // dropped
      { category: '   ', limit_amount: 200 },  // dropped (whitespace-only)
      { id: 3, limit_amount: 300 },             // dropped (no name)
    ]
    expect(copyCategoriesFrom(prior)).toEqual([
      { category: 'Food', limit_amount: 400 },
    ])
  })

  it('coerces non-numeric limits to 0 instead of crashing the form', () => {
    const prior = [
      { category: 'Bills', limit_amount: 'oops' },
      { category: 'Subscriptions', limit_amount: null },
    ]
    expect(copyCategoriesFrom(prior)).toEqual([
      { category: 'Bills', limit_amount: 0 },
      { category: 'Subscriptions', limit_amount: 0 },
    ])
  })
})

describe('budgetCategoryStatus', () => {
  it('returns "ok" when spending is comfortably below the limit', () => {
    expect(budgetCategoryStatus({ spent: 100, effectiveLimit: 500 })).toBe('ok')
  })

  it('returns "ok" when right at 89% — still under the warning threshold', () => {
    // Just below 90% → still green, no yellow flag.
    expect(budgetCategoryStatus({ spent: 89, effectiveLimit: 100 })).toBe('ok')
  })

  it('returns "approaching" at the 90% threshold (warning)', () => {
    expect(budgetCategoryStatus({ spent: 90, effectiveLimit: 100 })).toBe('approaching')
  })

  it('returns "approaching" at 99% — still under, just barely', () => {
    expect(budgetCategoryStatus({ spent: 99, effectiveLimit: 100 })).toBe('approaching')
  })

  it('returns "approaching" (NOT over) when exactly at the limit', () => {
    // Exactly on budget = under the line, not over. User asked for
    // "red only when over" — at-the-limit doesn't qualify.
    expect(budgetCategoryStatus({ spent: 100, effectiveLimit: 100 })).toBe('approaching')
  })

  it('returns "over" only when spending strictly exceeds the limit', () => {
    expect(budgetCategoryStatus({ spent: 101, effectiveLimit: 100 })).toBe('over')
    expect(budgetCategoryStatus({ spent: 1500, effectiveLimit: 1000 })).toBe('over')
  })

  it('returns "ok" (no signal) when no budget is set, even with spending', () => {
    // effectiveLimit = 0 means user hasn't set a target. Don't flash red
    // at them just for spending — they haven't committed to anything.
    expect(budgetCategoryStatus({ spent: 1000, effectiveLimit: 0 })).toBe('ok')
  })

  it('handles null/undefined inputs without throwing', () => {
    expect(budgetCategoryStatus({ spent: null, effectiveLimit: 100 })).toBe('ok')
    expect(budgetCategoryStatus({ spent: 100, effectiveLimit: null })).toBe('ok')
    expect(budgetCategoryStatus({})).toBe('ok')
  })
})
