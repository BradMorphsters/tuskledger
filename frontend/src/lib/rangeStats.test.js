import { describe, it, expect } from 'vitest'
import {
  RANGE_PRESETS,
  DEFAULT_RANGE_PRESET,
  isValidPreset,
  resolveRangeMonths,
  fetchWindowMonths,
  windowRangeDates,
  splitWindows,
  aggregateWindow,
  periodDeltaPct,
} from './rangeStats'

// ─── Fixtures ─────────────────────────────────────────────────
// Every test pins its own `now` — never the real clock, or the YTD
// cases would pass in August and fail in January.
const AUG_2026 = new Date(2026, 7, 15)   // getMonth() === 7 → YTD = 8 mo
const JAN_2026 = new Date(2026, 0, 3)    // getMonth() === 0 → YTD = 1 mo
const DEC_2026 = new Date(2026, 11, 31)  // getMonth() === 11 → YTD = 12 mo

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function row(year, monthNum, income, spending) {
  return {
    month: `${MONTH_NAMES[monthNum - 1]} ${year}`,
    month_num: monthNum,
    year,
    income,
    spending,
    net: income - spending,
  }
}

/**
 * `count` consecutive rows, oldest→newest, ending at year/month —
 * the exact shape /transactions/income-vs-spending returns.
 * Amounts are deterministic so window boundaries are easy to assert.
 */
function series(count, endYear, endMonth, fill = (i) => ({ income: 100 * (i + 1), spending: 10 * (i + 1) })) {
  const out = []
  for (let i = count - 1; i >= 0; i--) {
    let m = endMonth - i
    let y = endYear
    while (m <= 0) { m += 12; y -= 1 }
    const { income, spending } = fill(count - 1 - i)
    out.push(row(y, m, income, spending))
  }
  return out
}

// ─── resolveRangeMonths ───────────────────────────────────────
describe('resolveRangeMonths', () => {
  it('resolves numeric presets to themselves', () => {
    expect(resolveRangeMonths('1', AUG_2026)).toBe(1)
    expect(resolveRangeMonths('2', AUG_2026)).toBe(2)
    expect(resolveRangeMonths('3', AUG_2026)).toBe(3)
    expect(resolveRangeMonths('4', AUG_2026)).toBe(4)
    expect(resolveRangeMonths('5', AUG_2026)).toBe(5)
    expect(resolveRangeMonths('6', AUG_2026)).toBe(6)
    expect(resolveRangeMonths('12', AUG_2026)).toBe(12)
  })

  it('resolves ytd to the number of months elapsed this year, inclusive', () => {
    expect(resolveRangeMonths('ytd', AUG_2026)).toBe(8)
    expect(resolveRangeMonths('ytd', DEC_2026)).toBe(12)
  })

  it('resolves ytd to 1 in January (the current partial month only)', () => {
    expect(resolveRangeMonths('ytd', JAN_2026)).toBe(1)
  })

  it('falls back to 1 month for an unknown preset', () => {
    expect(resolveRangeMonths('nonsense', AUG_2026)).toBe(1)
    expect(resolveRangeMonths(undefined, AUG_2026)).toBe(1)
  })
})

// ─── fetchWindowMonths ────────────────────────────────────────
describe('fetchWindowMonths', () => {
  it('doubles numeric presets so the comparison window comes along', () => {
    expect(fetchWindowMonths('1', AUG_2026)).toBe(2)
    expect(fetchWindowMonths('2', AUG_2026)).toBe(4)
    expect(fetchWindowMonths('3', AUG_2026)).toBe(6)
    expect(fetchWindowMonths('4', AUG_2026)).toBe(8)
    expect(fetchWindowMonths('5', AUG_2026)).toBe(10)
    expect(fetchWindowMonths('6', AUG_2026)).toBe(12)
  })

  it('caps at the backend le=24 limit', () => {
    expect(fetchWindowMonths('12', AUG_2026)).toBe(24)
    expect(fetchWindowMonths('ytd', DEC_2026)).toBe(24)
  })

  it('asks for ytd + 12 so the same months last year are included', () => {
    expect(fetchWindowMonths('ytd', AUG_2026)).toBe(20)
    expect(fetchWindowMonths('ytd', JAN_2026)).toBe(13)
  })

  it('never exceeds 24 for any preset', () => {
    for (const p of RANGE_PRESETS) {
      for (const now of [JAN_2026, AUG_2026, DEC_2026]) {
        expect(fetchWindowMonths(p.key, now)).toBeLessThanOrEqual(24)
        expect(fetchWindowMonths(p.key, now)).toBeGreaterThanOrEqual(1)
      }
    }
  })
})

// ─── windowRangeDates ─────────────────────────────────────────
describe('windowRangeDates', () => {
  it('spans N months back from the anchor, ending on its last day', () => {
    expect(windowRangeDates('6', AUG_2026)).toEqual({
      start_date: '2026-03-01',
      end_date: '2026-08-31',
    })
    expect(windowRangeDates('3', AUG_2026)).toEqual({
      start_date: '2026-06-01',
      end_date: '2026-08-31',
    })
  })

  it('covers exactly the anchor month for the 1mo preset', () => {
    expect(windowRangeDates('1', AUG_2026)).toEqual({
      start_date: '2026-08-01',
      end_date: '2026-08-31',
    })
    // 30-day month
    expect(windowRangeDates('1', new Date(2026, 8, 12))).toEqual({
      start_date: '2026-09-01',
      end_date: '2026-09-30',
    })
  })

  it('starts at January 1st for ytd', () => {
    expect(windowRangeDates('ytd', AUG_2026)).toEqual({
      start_date: '2026-01-01',
      end_date: '2026-08-31',
    })
  })

  it('collapses to January alone for ytd in January', () => {
    expect(windowRangeDates('ytd', JAN_2026)).toEqual({
      start_date: '2026-01-01',
      end_date: '2026-01-31',
    })
  })

  it('covers the whole year for ytd in December', () => {
    expect(windowRangeDates('ytd', DEC_2026)).toEqual({
      start_date: '2026-01-01',
      end_date: '2026-12-31',
    })
  })

  it('crosses the year boundary (4mo anchored in February)', () => {
    expect(windowRangeDates('4', new Date(2026, 1, 9))).toEqual({
      start_date: '2025-11-01',
      end_date: '2026-02-28',
    })
  })

  it('handles a leap-year February end date', () => {
    expect(windowRangeDates('1', new Date(2028, 1, 3))).toEqual({
      start_date: '2028-02-01',
      end_date: '2028-02-29',
    })
  })

  it('crosses the year boundary for a 12mo window', () => {
    expect(windowRangeDates('12', AUG_2026)).toEqual({
      start_date: '2025-09-01',
      end_date: '2026-08-31',
    })
  })
})

// ─── splitWindows ─────────────────────────────────────────────
describe('splitWindows', () => {
  it('splits a numeric preset into two equal adjacent windows', () => {
    // 6 rows Mar–Aug 2026, preset '3' → current Jun–Aug, prior Mar–May
    const rows = series(6, 2026, 8)
    const { current, prior } = splitWindows(rows, '3', AUG_2026)
    expect(current.map(r => r.month)).toEqual(['Jun 2026', 'Jul 2026', 'Aug 2026'])
    expect(prior.map(r => r.month)).toEqual(['Mar 2026', 'Apr 2026', 'May 2026'])
  })

  it('handles the 1-month preset (current month vs the one before)', () => {
    const rows = series(2, 2026, 8)
    const { current, prior } = splitWindows(rows, '1', AUG_2026)
    expect(current.map(r => r.month)).toEqual(['Aug 2026'])
    expect(prior.map(r => r.month)).toEqual(['Jul 2026'])
  })

  it('crosses the year boundary correctly', () => {
    // 4 rows Nov 2025 – Feb 2026, preset '2'
    const rows = series(4, 2026, 2)
    const { current, prior } = splitWindows(rows, '2', new Date(2026, 1, 10))
    expect(current.map(r => r.month)).toEqual(['Jan 2026', 'Feb 2026'])
    expect(prior.map(r => r.month)).toEqual(['Nov 2025', 'Dec 2025'])
  })

  it('returns a SHORT prior window when the 24-month cap truncates it', () => {
    // 12mo preset asks for 24 but the ledger only has 18 months of rows.
    const rows = series(18, 2026, 8)
    const { current, prior } = splitWindows(rows, '12', AUG_2026)
    expect(current).toHaveLength(12)
    expect(current[0].month).toBe('Sep 2025')
    expect(current[11].month).toBe('Aug 2026')
    expect(prior).toHaveLength(6) // 18 - 12, not the full 12
    expect(prior[0].month).toBe('Mar 2025')
    expect(prior[5].month).toBe('Aug 2025')
  })

  it('returns an empty prior window when there is no history before the range', () => {
    const rows = series(3, 2026, 8)
    const { current, prior } = splitWindows(rows, '6', AUG_2026)
    expect(current).toHaveLength(3) // all we have
    expect(prior).toEqual([])
  })

  it('picks the same months of last year for ytd', () => {
    // 20 rows Jan 2025 – Aug 2026 (what fetchWindowMonths('ytd') asks for)
    const rows = series(20, 2026, 8)
    const { current, prior } = splitWindows(rows, 'ytd', AUG_2026)
    expect(current.map(r => r.month)).toEqual([
      'Jan 2026', 'Feb 2026', 'Mar 2026', 'Apr 2026',
      'May 2026', 'Jun 2026', 'Jul 2026', 'Aug 2026',
    ])
    expect(prior.map(r => r.month)).toEqual([
      'Jan 2025', 'Feb 2025', 'Mar 2025', 'Apr 2025',
      'May 2025', 'Jun 2025', 'Jul 2025', 'Aug 2025',
    ])
    // Sep–Dec 2025 must be excluded from both windows.
    expect(prior.some(r => r.month_num > 8)).toBe(false)
  })

  it('handles ytd in January (one month each side)', () => {
    const rows = series(13, 2026, 1) // Jan 2025 – Jan 2026
    const { current, prior } = splitWindows(rows, 'ytd', JAN_2026)
    expect(current.map(r => r.month)).toEqual(['Jan 2026'])
    expect(prior.map(r => r.month)).toEqual(['Jan 2025'])
  })

  it('returns an empty ytd prior window when last year has no rows', () => {
    const rows = series(8, 2026, 8) // Jan–Aug 2026 only
    const { current, prior } = splitWindows(rows, 'ytd', AUG_2026)
    expect(current).toHaveLength(8)
    expect(prior).toEqual([])
  })

  it('tolerates missing / non-array input', () => {
    expect(splitWindows(undefined, '6', AUG_2026)).toEqual({ current: [], prior: [] })
    expect(splitWindows(null, 'ytd', AUG_2026)).toEqual({ current: [], prior: [] })
    expect(splitWindows([], '3', AUG_2026)).toEqual({ current: [], prior: [] })
  })
})

// ─── aggregateWindow ──────────────────────────────────────────
describe('aggregateWindow', () => {
  it('sums income / spending / net across the window', () => {
    const rows = [
      row(2026, 6, 5000, 3000),
      row(2026, 7, 5000, 4000),
      row(2026, 8, 2000, 1000),
    ]
    const agg = aggregateWindow(rows)
    expect(agg.income).toBe(12000)
    expect(agg.spending).toBe(8000)
    expect(agg.net).toBe(4000)
    expect(agg.monthsWithData).toBe(3)
    expect(agg.avgIncome).toBe(4000)
    expect(agg.avgSpending).toBeCloseTo(8000 / 3, 10)
    expect(agg.avgNet).toBeCloseTo(4000 / 3, 10)
    expect(agg.savingsRate).toBeCloseTo((4000 / 12000) * 100, 10)
  })

  it('excludes fully-empty months from the average denominator', () => {
    const rows = [
      row(2026, 5, 0, 0),      // before the ledger starts
      row(2026, 6, 0, 0),
      row(2026, 7, 6000, 4000),
      row(2026, 8, 0, 500),    // partial current month — counts
    ]
    const agg = aggregateWindow(rows)
    expect(agg.monthsWithData).toBe(2)
    expect(agg.income).toBe(6000)
    expect(agg.spending).toBe(4500)
    expect(agg.avgSpending).toBe(2250)  // 4500 / 2, not / 4
    expect(agg.avgIncome).toBe(3000)
  })

  it('returns savingsRate null when there was no income', () => {
    const agg = aggregateWindow([row(2026, 8, 0, 1200)])
    expect(agg.income).toBe(0)
    expect(agg.spending).toBe(1200)
    expect(agg.net).toBe(-1200)
    expect(agg.monthsWithData).toBe(1)
    expect(agg.savingsRate).toBeNull()
  })

  it('returns a negative savingsRate when spending exceeds income', () => {
    const agg = aggregateWindow([row(2026, 8, 1000, 1500)])
    expect(agg.savingsRate).toBeCloseTo(-50, 10)
  })

  it('zeroes everything for an empty / missing window', () => {
    for (const input of [[], undefined, null]) {
      const agg = aggregateWindow(input)
      expect(agg.income).toBe(0)
      expect(agg.spending).toBe(0)
      expect(agg.net).toBe(0)
      expect(agg.monthsWithData).toBe(0)
      expect(agg.avgIncome).toBe(0)
      expect(agg.avgSpending).toBe(0)
      expect(agg.avgNet).toBe(0)
      expect(agg.savingsRate).toBeNull()
    }
  })

  it('treats missing income/spending fields as 0', () => {
    const agg = aggregateWindow([{ month: 'Aug 2026', month_num: 8, year: 2026 }])
    expect(agg.income).toBe(0)
    expect(agg.spending).toBe(0)
    expect(agg.monthsWithData).toBe(0)
  })
})

// ─── periodDeltaPct ───────────────────────────────────────────
describe('periodDeltaPct', () => {
  const cur = aggregateWindow([row(2026, 8, 12000, 9000)])
  const prior = aggregateWindow([row(2026, 7, 10000, 12000)])

  it('computes percent change against the prior window', () => {
    expect(periodDeltaPct(cur, prior, 'income')).toBeCloseTo(20, 10)
    expect(periodDeltaPct(cur, prior, 'spending')).toBeCloseTo(-25, 10)
  })

  it('uses |prior| so an improving negative net reads positive', () => {
    const a = aggregateWindow([row(2026, 8, 1000, 1100)])   // net -100
    const b = aggregateWindow([row(2026, 7, 1000, 1500)])   // net -500
    expect(periodDeltaPct(a, b, 'net')).toBeCloseTo(80, 10)
  })

  it('returns null when the prior window has no months of data', () => {
    const empty = aggregateWindow([])
    expect(periodDeltaPct(cur, empty, 'spending')).toBeNull()
    expect(periodDeltaPct(cur, aggregateWindow([row(2026, 7, 0, 0)]), 'income')).toBeNull()
  })

  it('returns null when the prior value itself is 0', () => {
    const zeroIncome = aggregateWindow([row(2026, 7, 0, 500)])
    expect(periodDeltaPct(cur, zeroIncome, 'income')).toBeNull()
    // …but a non-zero sibling field on the same window still compares.
    expect(periodDeltaPct(cur, zeroIncome, 'spending')).toBeCloseTo(1700, 10)
  })

  it('returns null when the current window has no active months at all', () => {
    // Aug 1st: the new month exists as a row but has no transactions yet.
    const emptyMonth = aggregateWindow([row(2026, 8, 0, 0)])
    const fullMonth = aggregateWindow([row(2026, 7, 9000, 7000)])
    expect(emptyMonth.monthsWithData).toBe(0)
    expect(periodDeltaPct(emptyMonth, fullMonth, 'spending')).toBeNull()
    expect(periodDeltaPct(emptyMonth, fullMonth, 'income')).toBeNull()
  })

  it('returns null when the two windows cover a different number of active months', () => {
    // Real shape of a Jan–Jul ledger on the 6mo preset: the current
    // window has 5 months of data, the prior only 2 — the rest predate
    // the ledger and are zeros, not genuinely zero-spend months.
    const current = aggregateWindow([
      row(2026, 3, 9000, 6000),
      row(2026, 4, 9000, 6500),
      row(2026, 5, 9000, 6200),
      row(2026, 6, 9000, 7100),
      row(2026, 7, 9000, 6800),
    ])
    const prior = aggregateWindow([
      row(2025, 10, 0, 0),
      row(2025, 11, 0, 0),
      row(2025, 12, 0, 0),
      row(2026, 1, 9000, 5900),
      row(2026, 2, 9000, 6100),
    ])
    expect(current.monthsWithData).toBe(5)
    expect(prior.monthsWithData).toBe(2)
    expect(periodDeltaPct(current, prior, 'spending')).toBeNull()
    expect(periodDeltaPct(current, prior, 'income')).toBeNull()
    expect(periodDeltaPct(current, prior, 'net')).toBeNull()
  })

  it('still compares when multi-month coverage matches on both sides', () => {
    const current = aggregateWindow([
      row(2026, 5, 4000, 2000),
      row(2026, 6, 4000, 2000),
      row(2026, 7, 4000, 2000),
    ])
    const prior = aggregateWindow([
      row(2026, 2, 5000, 2500),
      row(2026, 3, 5000, 2500),
      row(2026, 4, 5000, 2500),
    ])
    expect(current.monthsWithData).toBe(3)
    expect(prior.monthsWithData).toBe(3)
    expect(periodDeltaPct(current, prior, 'spending')).toBeCloseTo(-20, 10)
    expect(periodDeltaPct(current, prior, 'income')).toBeCloseTo(-20, 10)
  })

  it('returns null when the field is undefined or an aggregate is missing', () => {
    expect(periodDeltaPct(cur, prior, 'nope')).toBeNull()
    expect(periodDeltaPct(cur, null, 'income')).toBeNull()
    expect(periodDeltaPct(null, prior, 'income')).toBeNull()
    expect(periodDeltaPct(cur, prior, 'savingsRate')).not.toBeNull()
  })
})

// ─── preset registry ──────────────────────────────────────────
describe('preset registry', () => {
  it('offers 1,2,3,4,5,6,12 and ytd', () => {
    expect(RANGE_PRESETS.map(p => p.key)).toEqual(['1', '2', '3', '4', '5', '6', '12', 'ytd'])
  })

  it('defaults to the current month', () => {
    expect(DEFAULT_RANGE_PRESET).toBe('1')
    expect(isValidPreset(DEFAULT_RANGE_PRESET)).toBe(true)
  })

  it('rejects values that are not known preset keys', () => {
    expect(isValidPreset('9')).toBe(false)
    expect(isValidPreset('YTD')).toBe(false)
    expect(isValidPreset(6)).toBe(false)
    expect(isValidPreset(null)).toBe(false)
  })
})
