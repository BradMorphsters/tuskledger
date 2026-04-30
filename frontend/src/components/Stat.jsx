/**
 * Stat — a primary metric card. Used at the top of Dashboard, Net Worth,
 * Investments. Has an accent stripe at the top whose color is set by the
 * `tone` prop. Optional sub-line for delta info.
 *
 *   <Stat label="Net Worth" value="$565,220.04" tone="positive" />
 *   <Stat label="Total Debt" value={fmt(totalDebt)} tone="negative"
 *         sub="3.2% of assets" />
 *
 * Tones: positive (green), negative (red), neutral (gray), default (blue).
 */
export default function Stat({ label, value, tone, sub, icon, valueClassName }) {
  const toneClass = tone ? `tone-${tone}` : ''
  const valueClass = [
    'stat-value',
    tone === 'positive' ? 'positive' : null,
    tone === 'negative' ? 'negative' : null,
    valueClassName,
  ].filter(Boolean).join(' ')
  return (
    <div className={`stat-card ${toneClass}`}>
      <div className="stat-label">
        {icon}
        <span>{label}</span>
      </div>
      <div className={valueClass}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}
