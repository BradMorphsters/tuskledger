/**
 * Compact stat tile for a Trend snapshot row. Used by both the Dashboard
 * and Spending & Income pages to show a range total with the per-month
 * average underneath.
 *
 * Props:
 *   label   — short uppercase label (e.g. "Income")
 *   total   — number for currency mode, OR string when isText=true
 *             (used for the "Months counted" tile)
 *   avg     — number for currency mode, OR string when isText=true
 *   color   — primary value color (CSS variable or hex)
 *   isText  — when true, render `total` and `avg` as plain text instead
 *             of currency-formatting them. Used for the coverage tile.
 */
import { formatCurrencyZero } from '../lib/format'

export default function TrendStat({ label, total, avg, color, isText = false }) {
  const fmt = (v) => (isText ? v : formatCurrencyZero(v))
  return (
    <div style={{
      padding: '12px 14px',
      borderRadius: 8,
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid rgba(255,255,255,0.06)',
    }}>
      <div style={{
        fontSize: 11,
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        marginBottom: 6,
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 22,
        fontWeight: 700,
        color,
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1.1,
      }}>
        {fmt(total)}
      </div>
      <div style={{
        fontSize: 11,
        color: 'var(--text-muted)',
        marginTop: 4,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {isText ? avg : `${fmt(avg)} / mo avg`}
      </div>
    </div>
  )
}
