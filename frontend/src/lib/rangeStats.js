/**
 * Range math for the Spending & Income page.
 *
 * Everything on that page — the top stat cards, the trend chart, the
 * aggregate tiles and the Top Merchants card — is driven by a single
 * range preset ('1'…'12' or 'ytd'). This module owns *all* of the
 * arithmetic behind that: how many months to ask the API for, how to
 * slice the response into a display window plus a comparison window,
 * how to aggregate a window, and how to compare two windows.
 *
 * Deliberately dependency-free (no React, no formatting helpers) so it
 * can be unit-tested and executed directly under node against buckets
 * derived straight from the database.
 *
 * The row shape it consumes is exactly what
 * `GET /transactions/income-vs-spending?months=N` returns, ordered
 * OLDEST → NEWEST, ending with the current (partial) calendar month:
 *
 *   { month: 'Aug 2026', month_num: 8, year: 2026,
 *     income: 9200.0, spending: 6410.55, net: 2789.45 }
 *
 * Transfers are already excluded server-side; amount < 0 was bucketed
 * as income (absolute value) and amount > 0 as spending, so both
 * `income` and `spending` arrive as non-negative magnitudes.
 */

/**
 * The range presets offered in the UI, in display order.
 * `key` is what we persist to localStorage; `label` is the button text.
 */
export const RANGE_PRESETS = [
  { key: '1', label: '1mo' },
  { key: '2', label: '2mo' },
  { key: '3', label: '3mo' },
  { key: '4', label: '4mo' },
  { key: '5', label: '5mo' },
  { key: '6', label: '6mo' },
  { key: '12', label: '12mo' },
  { key: 'ytd', label: 'YTD' },
]

/** Preset used when nothing (valid) is stored yet. */
export const DEFAULT_RANGE_PRESET = '1'

/** Hard cap enforced by the backend (`months: int = Query(..., le=24)`). */
export const MAX_API_MONTHS = 24

/**
 * True when `preset` is one of the keys in RANGE_PRESETS. Used to
 * validate whatever we read back out of localStorage — a stale value
 * from an older build (e.g. '9') must not leak into an API call.
 *
 * @param {unknown} preset
 * @returns {boolean}
 */
export function isValidPreset(preset) {
  return RANGE_PRESETS.some(p => p.key === preset)
}

/**
 * How many calendar months the selected preset *displays*.
 *
 * 'ytd' means January through the current month inclusive, so it
 * resolves to `now.getMonth() + 1` (1 in January, 12 in December).
 * Numeric presets resolve to themselves.
 *
 * @param {string} preset — '1'…'12' or 'ytd'
 * @param {Date} [now] — injectable clock; tests must always pass this
 * @returns {number} months in the display window (>= 1)
 */
export function resolveRangeMonths(preset, now = new Date()) {
  if (preset === 'ytd') return now.getMonth() + 1
  const n = parseInt(preset, 10)
  // Defensive: an unknown preset shouldn't produce NaN months and blow
  // up the query string. Callers should validate with isValidPreset.
  return Number.isFinite(n) && n > 0 ? n : 1
}

/**
 * How many months to actually REQUEST from the API so we have both the
 * display window and the comparison window in one round-trip.
 *
 *   numeric N → N * 2   (current N months + the N months before them)
 *   'ytd'     → N + 12  (this year so far + the same span last year,
 *                        which sits 12 months earlier)
 *
 * Both are clamped to the backend's `le=24` cap, so 12mo asks for 24
 * (a full prior year of comparison) and YTD never needs clamping —
 * N + 12 <= 24 for every N <= 12.
 *
 * @param {string} preset
 * @param {Date} [now]
 * @returns {number} months to pass to getIncomeVsSpending (1…24)
 */
export function fetchWindowMonths(preset, now = new Date()) {
  const n = resolveRangeMonths(preset, now)
  if (preset === 'ytd') return Math.min(MAX_API_MONTHS, n + 12)
  return Math.min(MAX_API_MONTHS, n * 2)
}

const _pad = n => String(n).padStart(2, '0')

/**
 * The calendar dates the selected window covers, as inclusive ISO
 * 'YYYY-MM-DD' strings — what the date-range endpoints
 * (`category-breakdown`, `spending-patterns`, `export`) and the
 * drill-down drawer filters need.
 *
 * The window always ends on the LAST day of the anchor's month, even
 * when the anchor is the current partial month: the endpoints only see
 * transactions that exist, and a full-month bound keeps the range
 * aligned with the monthly buckets the trend chart draws.
 *
 *   numeric N → start = 1st of (anchor month − (N − 1))
 *   'ytd'     → start = January 1st of the anchor's year
 *
 * Built from local calendar fields (never `toISOString`, which shifts
 * to UTC and can roll the day backwards in US timezones).
 *
 * @param {string} preset
 * @param {Date} [anchor] — the newest month in the window
 * @returns {{ start_date: string, end_date: string }} inclusive ISO dates
 */
export function windowRangeDates(preset, anchor = new Date()) {
  const anchorYear = anchor.getFullYear()
  const anchorMonth = anchor.getMonth() + 1 // 1-12
  const n = resolveRangeMonths(preset, anchor)

  // Day 0 of the following month == last day of the anchor month.
  const lastDay = new Date(anchorYear, anchorMonth, 0).getDate()

  let startYear = anchorYear
  let startMonth = preset === 'ytd' ? 1 : anchorMonth - (n - 1)
  while (startMonth <= 0) {
    startMonth += 12
    startYear -= 1
  }

  return {
    start_date: `${startYear}-${_pad(startMonth)}-01`,
    end_date: `${anchorYear}-${_pad(anchorMonth)}-${_pad(lastDay)}`,
  }
}

/**
 * Split an oldest→newest row list into the display window and its
 * comparison window.
 *
 *   numeric N → current = the last N rows
 *               prior   = the N rows immediately before those
 *   'ytd'     → current = the last N rows (Jan…current month this year)
 *               prior   = last year's rows for the same months
 *                         (year === thisYear - 1 && month_num <= N)
 *
 * The prior window can legitimately come back SHORTER than the current
 * one — the 24-month API cap truncates it for 12mo, and a young ledger
 * simply may not have that much history. Callers must treat a short or
 * empty prior window as "not enough data to compare" rather than
 * assuming symmetry; aggregateWindow + periodDeltaPct already do.
 *
 * @param {Array<object>} rows — oldest→newest income-vs-spending rows
 * @param {string} preset
 * @param {Date} [now]
 * @returns {{ current: Array<object>, prior: Array<object> }}
 */
export function splitWindows(rows, preset, now = new Date()) {
  const list = Array.isArray(rows) ? rows : []
  const n = resolveRangeMonths(preset, now)
  const curStart = Math.max(0, list.length - n)
  const current = list.slice(curStart)

  if (preset === 'ytd') {
    const lastYear = now.getFullYear() - 1
    const prior = list.filter(r => r && r.year === lastYear && r.month_num <= n)
    return { current, prior }
  }

  const prior = list.slice(Math.max(0, curStart - n), curStart)
  return { current, prior }
}

/**
 * Sum a window into the numbers every consumer needs.
 *
 * `monthsWithData` counts rows that saw *any* activity, and is what the
 * averages divide by — a range that reaches back before the user's
 * first transaction (or forward into a barely-started current month)
 * must not deflate the per-month figures with empty denominators.
 *
 * `savingsRate` is a percentage (0–100 scale, may be negative) and is
 * `null` when there was no income at all — 0 income means "undefined",
 * not "0% saved". Nothing is rounded here; formatting is the caller's
 * job.
 *
 * @param {Array<object>} rows
 * @returns {{
 *   income: number, spending: number, net: number,
 *   monthsWithData: number,
 *   avgIncome: number, avgSpending: number, avgNet: number,
 *   savingsRate: number|null
 * }}
 */
export function aggregateWindow(rows) {
  const list = Array.isArray(rows) ? rows : []
  let income = 0
  let spending = 0
  let monthsWithData = 0
  for (const r of list) {
    if (!r) continue
    const i = r.income || 0
    const s = r.spending || 0
    income += i
    spending += s
    if (i > 0 || s > 0) monthsWithData += 1
  }
  const net = income - spending
  const d = monthsWithData
  return {
    income,
    spending,
    net,
    monthsWithData,
    avgIncome: d > 0 ? income / d : 0,
    avgSpending: d > 0 ? spending / d : 0,
    avgNet: d > 0 ? net / d : 0,
    savingsRate: income > 0 ? (net / income) * 100 : null,
  }
}

/**
 * Percent change of one field between two aggregates:
 * `((current - prior) / |prior|) * 100`.
 *
 * The denominator is an absolute value so a *negative* prior net still
 * gives the change the intuitive sign (net going from -500 to -100 is
 * an improvement, i.e. +80%).
 *
 * Returns `null` — meaning "don't render a comparison" — when there is
 * nothing meaningful to divide by: no prior aggregate, a prior window
 * with no months of data at all, or a prior value of 0/undefined.
 *
 * It ALSO returns null when the two windows cover a different number of
 * active months. Comparing raw totals across unequal coverage is
 * mathematically valid but substantively dishonest: months that predate
 * the ledger arrive as zeros, not as "a month where you spent nothing".
 * With a Jan–Jul ledger, a 6mo window (5 active months) against its
 * prior window (2 active months) reads "+170.9% spending" — an artefact
 * of when the data starts, not of behaviour. Same story on the other
 * side: a brand-new current month with no transactions yet against a
 * full prior month reads "-100%". Equal coverage or no badge.
 *
 * @param {object} currentAgg — from aggregateWindow
 * @param {object} priorAgg — from aggregateWindow
 * @param {string} field — 'income' | 'spending' | 'net' | 'avg…'
 * @returns {number|null} percent change, or null when not comparable
 */
export function periodDeltaPct(currentAgg, priorAgg, field) {
  if (!currentAgg || !priorAgg) return null
  if (!priorAgg.monthsWithData) return null
  // Unequal activity coverage → the totals aren't like-for-like.
  if (currentAgg.monthsWithData !== priorAgg.monthsWithData) return null
  const prior = priorAgg[field]
  if (!prior || !Number.isFinite(prior)) return null
  const cur = currentAgg[field] || 0
  return ((cur - prior) / Math.abs(prior)) * 100
}
