/**
 * Tests for the TradingTax component's pure display helpers.
 *
 * The component itself is mostly a viewer over server-computed data
 * (the heavy math is unit-tested in test_trading_tax.py). The display
 * helpers — color routing for ST/LT and holding-period formatting —
 * are the only frontend-side logic worth pinning.
 */
import { describe, expect, it } from 'vitest'
import {
  termColor,
  gainLossColor,
  formatHoldingPeriod,
} from './TradingTax'

describe('termColor', () => {
  it('routes LT to green (the calmer accent)', () => {
    expect(termColor('LT')).toBe('var(--accent-green)')
  })

  it('routes ST to orange (the more-taxed term gets attention)', () => {
    expect(termColor('ST')).toBe('var(--accent-orange)')
  })

  it('treats unknown values as ST (conservative — assume the worse term)', () => {
    expect(termColor('???')).toBe('var(--accent-orange)')
    expect(termColor(undefined)).toBe('var(--accent-orange)')
  })
})

describe('gainLossColor', () => {
  it('routes positive amounts to green', () => {
    expect(gainLossColor(100)).toBe('var(--accent-green)')
  })

  it('routes negative amounts to red', () => {
    expect(gainLossColor(-100)).toBe('var(--accent-red)')
  })

  it('routes zero to muted (neither win nor loss)', () => {
    expect(gainLossColor(0)).toBe('var(--text-muted)')
  })
})

describe('formatHoldingPeriod', () => {
  it('renders sub-30-day periods in days', () => {
    expect(formatHoldingPeriod(5)).toBe('5d')
    expect(formatHoldingPeriod(29)).toBe('29d')
  })

  it('renders 1-12 month periods in months (30-day approx)', () => {
    expect(formatHoldingPeriod(30)).toBe('1mo')
    expect(formatHoldingPeriod(90)).toBe('3mo')
    expect(formatHoldingPeriod(364)).toBe('12mo')
  })

  it('renders >1yr periods as years (with months when nonzero)', () => {
    expect(formatHoldingPeriod(365)).toBe('1y')
    expect(formatHoldingPeriod(395)).toBe('1y 1mo')
    expect(formatHoldingPeriod(730)).toBe('2y')
    expect(formatHoldingPeriod(800)).toBe('2y 2mo')
  })

  it('returns 0d for zero days (defensive)', () => {
    expect(formatHoldingPeriod(0)).toBe('0d')
  })
})
