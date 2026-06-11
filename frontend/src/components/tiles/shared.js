/**
 * shared.js — helpers and constants used by more than one tile.
 * Imported by individual tile files; do not import DashboardTiles here.
 */

// ---------------------------------------------------------------------------
// Currency formatters
// ---------------------------------------------------------------------------

/** Round-dollar formatter used across most tiles. */
export function fmtMoney(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0)
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Shared card style: fills its grid cell height, flex-column layout. */
export const tileCardStyle = {
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
}

// ---------------------------------------------------------------------------
// Payroll / paycheck helpers (HSA + DCFSA)
// ---------------------------------------------------------------------------

/** Paychecks-per-year by frequency. */
export const PAYCHECKS_PER_YEAR = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 }

// ---------------------------------------------------------------------------
// Shared input style (HSA + DCFSA edit forms)
// ---------------------------------------------------------------------------

export const hsaInputStyle = {
  width: '100%', padding: '4px 6px', fontSize: 11,
  border: '1px solid var(--border)', borderRadius: 3,
  background: 'var(--bg-input)', color: 'var(--text-primary)',
  fontFamily: 'inherit', boxSizing: 'border-box',
}
