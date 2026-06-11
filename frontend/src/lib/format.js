/**
 * Shared formatting helpers.
 *
 * Created during the tech-debt sweep — there were 13 separate
 * `formatCurrency` definitions across pages and components, each
 * subtly different (some handle null/undefined, some don't, some
 * default to USD, some accept currency, etc.). Pages were also
 * allocating a fresh `Intl.NumberFormat` on every render. Centralising
 * here so behaviour is consistent and the formatter instance is
 * reused.
 */

// Cache one NumberFormat per (currency, fractionDigits) tuple so we
// don't allocate on every render. The constructor is surprisingly
// expensive when called inside table-row maps.
const _currencyCache = new Map()
function _getCurrencyFormatter(currency, maximumFractionDigits) {
  const key = `${currency}|${maximumFractionDigits}`
  let f = _currencyCache.get(key)
  if (!f) {
    f = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits,
    })
    _currencyCache.set(key, f)
  }
  return f
}

/**
 * Standard currency formatter. Returns "—" for null/undefined so
 * tables don't show "$NaN" or "$0.00" for missing values. Use
 * formatCurrencyZero if 0 is a valid value worth rendering.
 */
export function formatCurrency(val, currency = 'USD') {
  if (val === null || val === undefined || (typeof val === 'number' && isNaN(val))) {
    return '—'
  }
  return _getCurrencyFormatter(currency, 2).format(val)
}

/**
 * Like formatCurrency, but treats null/undefined as 0 (renders "$0.00").
 * Useful where 0 is the meaningful default — totals, net amounts, etc.
 */
export function formatCurrencyZero(val, currency = 'USD') {
  return _getCurrencyFormatter(currency, 2).format(val || 0)
}

/**
 * Compact format for chart axes / dense tables: $5k, $1.2M, $345.
 * Always returns a value (never "—") since chart ticks need a string.
 */
export function formatCompactCurrency(val) {
  if (val === null || val === undefined || isNaN(val)) return '$0'
  const abs = Math.abs(val)
  if (abs >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `$${Math.round(val / 1_000)}k`
  return `$${Math.round(val)}`
}

// Short alias used by some callers (RecurringCard, etc.) historically
// imported as `fmt`. Re-exported so we can migrate gradually.
export const fmt = formatCurrencyZero

/**
 * MM/DD/YYYY date formatter. Date strings from the API are ISO
 * (YYYY-MM-DD) so we splice them at noon UTC to avoid timezone-
 * induced day shifts in en-US output.
 */
export function formatDate(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * Strip ACH/transfer noise from raw transaction descriptions for
 * display. Mirrors the pattern that was duplicated in Dashboard,
 * SpendingIncome, and Insights so the same paycheck shows up under
 * the same cleaned name everywhere.
 */
/**
 * Returns an ascending array of years centred on the current year.
 * yearsBack=2, yearsAhead=1 from 2026 → [2024, 2025, 2026, 2027].
 */
export function yearOptions(yearsBack = 2, yearsAhead = 1) {
  const thisYear = new Date().getFullYear()
  return Array.from({ length: yearsBack + yearsAhead + 1 }, (_, i) => thisYear - yearsBack + i)
}

export function cleanMerchantName(raw) {
  if (!raw) return raw
  let s = String(raw)
  s = s.replace(/\s+(TYPE:|ID:|DATA:|CO:|PPD|ACH ECC|ACH Trace).*/i, '')
  s = s.replace(/^(DEPOSIT|WITHDRAWAL|TRANSFER|PAYMENT|PURCHASE)\s+/i, '')
  s = s.replace(/\s+/g, ' ').trim()
  if (s === s.toUpperCase() && s.length > 3) {
    s = s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
  }
  return s || raw
}
