/**
 * Tests for the TradingDataFreshness staleness classifier helpers.
 *
 * The component itself is mostly an API+button wrapper; the value
 * worth pinning down is the per-account staleness classification —
 * if the tier boundaries shift, the user-visible color and label go
 * with them. Lock those down here.
 */
import { describe, expect, it } from 'vitest'
import {
  classifyFreshness,
  freshnessColor,
  freshnessLabel,
} from './TradingDataFreshness'

describe('classifyFreshness', () => {
  it('returns "fresh" for 0-1 days stale', () => {
    expect(classifyFreshness(0)).toBe('fresh')
    expect(classifyFreshness(1)).toBe('fresh')
  })

  it('returns "recent" for 2-3 days', () => {
    expect(classifyFreshness(2)).toBe('recent')
    expect(classifyFreshness(3)).toBe('recent')
  })

  it('returns "stale" for 4-7 days', () => {
    expect(classifyFreshness(4)).toBe('stale')
    expect(classifyFreshness(7)).toBe('stale')
  })

  it('returns "very_stale" for >7 days', () => {
    expect(classifyFreshness(8)).toBe('very_stale')
    expect(classifyFreshness(60)).toBe('very_stale')
  })

  it('returns "unknown" when daysStale is null/undefined', () => {
    expect(classifyFreshness(null)).toBe('unknown')
    expect(classifyFreshness(undefined)).toBe('unknown')
  })
})

describe('freshnessColor', () => {
  it('routes each tier to its accent var', () => {
    expect(freshnessColor('fresh')).toBe('var(--accent-green)')
    expect(freshnessColor('recent')).toBe('var(--accent-blue)')
    expect(freshnessColor('stale')).toBe('var(--accent-orange)')
    expect(freshnessColor('very_stale')).toBe('var(--accent-red)')
    expect(freshnessColor('unknown')).toBe('var(--text-muted)')
  })

  it('falls back to muted for unrecognized tiers', () => {
    expect(freshnessColor('???')).toBe('var(--text-muted)')
  })
})

describe('freshnessLabel', () => {
  it('shows "Today" for 0 days', () => {
    expect(freshnessLabel('fresh', 0)).toBe('Today')
  })

  it('shows "Yesterday" for 1 day', () => {
    expect(freshnessLabel('fresh', 1)).toBe('Yesterday')
  })

  it('shows N days ago for older', () => {
    expect(freshnessLabel('recent', 2)).toBe('2 days ago')
    expect(freshnessLabel('very_stale', 30)).toBe('30 days ago')
  })

  it('shows "Never synced" for unknown', () => {
    expect(freshnessLabel('unknown', null)).toBe('Never synced')
  })
})
