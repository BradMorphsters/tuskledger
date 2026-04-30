/**
 * Tests for the shared formatting library.
 *
 * These helpers are called from every page that displays money or
 * dates, so a regression here ripples across the entire app. Coverage
 * focus: contract edge cases (null, undefined, NaN, negatives), the
 * NumberFormat instance cache, and the merchant-name cleaner's known
 * patterns.
 */
import { describe, expect, it } from 'vitest'
import {
  formatCurrency,
  formatCurrencyZero,
  formatCompactCurrency,
  formatDate,
  cleanMerchantName,
  fmt,
} from './format'

describe('formatCurrency', () => {
  it('renders standard amounts with USD by default', () => {
    expect(formatCurrency(1234.56)).toBe('$1,234.56')
  })

  it('renders negatives with the standard sign', () => {
    expect(formatCurrency(-99)).toBe('-$99.00')
  })

  it('returns em-dash for null', () => {
    expect(formatCurrency(null)).toBe('—')
  })

  it('returns em-dash for undefined', () => {
    expect(formatCurrency(undefined)).toBe('—')
  })

  it('returns em-dash for NaN (as opposed to "$NaN")', () => {
    // Regression: an earlier version emitted "$NaN" because the guard
    // didn't catch NaN. Tables now show — for missing data.
    expect(formatCurrency(NaN)).toBe('—')
  })

  it('treats zero as a renderable value (not missing)', () => {
    expect(formatCurrency(0)).toBe('$0.00')
  })

  it('supports non-USD currencies', () => {
    expect(formatCurrency(50, 'EUR')).toBe('€50.00')
  })
})

describe('formatCurrencyZero', () => {
  it('treats null as zero (used for totals where 0 is meaningful)', () => {
    expect(formatCurrencyZero(null)).toBe('$0.00')
  })

  it('treats undefined as zero', () => {
    expect(formatCurrencyZero(undefined)).toBe('$0.00')
  })

  it('renders an actual zero', () => {
    expect(formatCurrencyZero(0)).toBe('$0.00')
  })

  it('renders normal amounts unchanged', () => {
    expect(formatCurrencyZero(1234.5)).toBe('$1,234.50')
  })
})

describe('formatCompactCurrency', () => {
  it('renders millions with one decimal', () => {
    expect(formatCompactCurrency(1_500_000)).toBe('$1.5M')
  })

  it('renders thousands rounded to whole', () => {
    expect(formatCompactCurrency(5_400)).toBe('$5k')
  })

  it('renders sub-thousand amounts as raw dollars', () => {
    expect(formatCompactCurrency(345)).toBe('$345')
  })

  it('handles negatives by magnitude (sign preserved)', () => {
    expect(formatCompactCurrency(-2_300_000)).toBe('$-2.3M')
  })

  it('returns "$0" for null/undefined/NaN (charts always need a string)', () => {
    expect(formatCompactCurrency(null)).toBe('$0')
    expect(formatCompactCurrency(undefined)).toBe('$0')
    expect(formatCompactCurrency(NaN)).toBe('$0')
  })

  it('rounds the boundary correctly', () => {
    // 999 → "$999"; 1000 → "$1k"
    expect(formatCompactCurrency(999)).toBe('$999')
    expect(formatCompactCurrency(1000)).toBe('$1k')
  })
})

describe('formatDate', () => {
  it('formats an ISO date in en-US short form', () => {
    expect(formatDate('2026-04-28')).toBe('Apr 28, 2026')
  })

  it('returns em-dash for null', () => {
    expect(formatDate(null)).toBe('—')
  })

  it('returns em-dash for empty string', () => {
    expect(formatDate('')).toBe('—')
  })

  it('avoids the timezone-induced day-shift bug', () => {
    // Bug fixed by appending T12:00:00 — without that, 2026-01-01
    // parsed as UTC midnight rendered as Dec 31 in en-US (negative TZ).
    // With the noon offset, every US timezone resolves to the same day.
    expect(formatDate('2026-01-01')).toBe('Jan 1, 2026')
  })
})

describe('cleanMerchantName', () => {
  it('strips ACH metadata noise', () => {
    expect(cleanMerchantName('CHASE PAYMENT TYPE: ACH ID: 123 PPD'))
      .toBe('Chase Payment')
  })

  it('strips leading transaction-type words', () => {
    expect(cleanMerchantName('DEPOSIT EMPLOYER PAYROLL'))
      .toBe('Employer Payroll')
  })

  it('title-cases all-caps strings (Plaid often returns SHOUTING)', () => {
    expect(cleanMerchantName('STARBUCKS COFFEE')).toBe('Starbucks Coffee')
  })

  it('leaves mixed-case names alone', () => {
    expect(cleanMerchantName('Starbucks Coffee')).toBe('Starbucks Coffee')
  })

  it('collapses internal whitespace', () => {
    expect(cleanMerchantName('costco    wholesale')).toBe('costco wholesale')
  })

  it('returns null/empty input unchanged (defensive)', () => {
    expect(cleanMerchantName('')).toBe('')
    expect(cleanMerchantName(null)).toBe(null)
    expect(cleanMerchantName(undefined)).toBe(undefined)
  })

  it('falls back to the original if cleaning produces an empty string', () => {
    // Pathological input: only noise, nothing left after stripping.
    // The cleaner returns the original rather than '' so the UI still
    // shows something instead of a blank cell.
    const noiseOnly = 'PAYMENT TYPE: ACH'
    const cleaned = cleanMerchantName(noiseOnly)
    expect(cleaned).not.toBe('')
  })
})

describe('fmt alias', () => {
  it('is an alias for formatCurrencyZero (legacy compat)', () => {
    expect(fmt).toBe(formatCurrencyZero)
    expect(fmt(0)).toBe(formatCurrencyZero(0))
    expect(fmt(null)).toBe(formatCurrencyZero(null))
  })
})
