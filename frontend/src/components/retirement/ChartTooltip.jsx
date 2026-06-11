/**
 * ChartTooltip — custom Recharts tooltip for the retirement projection
 * chart.
 *
 * Shows balance plus phase-specific context: during accumulation, just
 * balance; during withdrawal, also the income-stream sum and how much
 * the portfolio had to cover this year. Recharts' default formatter is
 * just one number; this gives the user the staged-income story at
 * every age.
 *
 * Extracted from RetirementProjection.jsx. No state, no side effects.
 */
import { fmtRounded } from './shared'

export function ChartTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null
  const row = payload[0].payload
  if (!row) return null
  const isAccum = row.phase === 'accumulating'
  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: '8px 10px',
      fontSize: 12,
      color: 'var(--text-primary)',
      minWidth: 180,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        Age {row.age}{' '}
        <span style={{
          fontWeight: 400,
          fontSize: 10,
          color: isAccum ? 'var(--accent-green)' : 'var(--accent-orange)',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          marginLeft: 4,
        }}>
          {isAccum ? '· accumulating' : '· withdrawing'}
        </span>
      </div>
      <div style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--accent-blue)' }}>
        Balance: {fmtRounded(row.balance)}
      </div>
      {row.income_streams > 0 && (
        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--accent-green)' }}>
          Fixed income: {fmtRounded(row.income_streams)}/yr
          {isAccum && (
            <span style={{ color: 'var(--text-muted)' }}> · informational</span>
          )}
        </div>
      )}
      {!isAccum && row.portfolio_draw > 0 && (
        <>
          <div style={{ fontSize: 11, color: 'var(--accent-orange)', marginTop: 2 }}>
            Portfolio draw: {fmtRounded(row.portfolio_draw)}/yr
          </div>
          {/* Per-bucket breakdown — only show non-zero buckets so the
              line doesn't get cluttered when the strategy is single-source. */}
          {row.draw_taxable > 0 && (
            <div style={{ fontSize: 10, color: '#fbbf24', marginLeft: 10 }}>
              · Taxable: {fmtRounded(row.draw_taxable)} (LTCG)
            </div>
          )}
          {row.draw_tax_deferred > 0 && (
            <div style={{ fontSize: 10, color: 'var(--accent-orange)', marginLeft: 10 }}>
              · Tax-deferred: {fmtRounded(row.draw_tax_deferred)}
              {row.early_withdrawal_penalty > 0 && (
                <span style={{ color: 'var(--accent-red)' }}>
                  {' '}+ {fmtRounded(row.early_withdrawal_penalty)} penalty
                </span>
              )}
            </div>
          )}
          {row.draw_roth > 0 && (
            <div style={{ fontSize: 10, color: '#92400e', marginLeft: 10 }}>
              · Roth: {fmtRounded(row.draw_roth)} (tax-free)
            </div>
          )}
        </>
      )}
      {!isAccum && row.after_tax_income > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
          After-tax income: {fmtRounded(row.after_tax_income)}/yr
        </div>
      )}
      {!isAccum && row.healthcare_cost > 0 && (
        <div style={{ fontSize: 10, color: 'var(--accent-orange)', marginTop: 2 }}>
          + Healthcare bridge: {fmtRounded(row.healthcare_cost)}/yr
        </div>
      )}
      {!isAccum && row.ltc_cost > 0 && (
        <div style={{ fontSize: 10, color: 'var(--accent-red)', marginTop: 2 }}>
          + LTC: {fmtRounded(row.ltc_cost)}/yr
        </div>
      )}
      {!isAccum && row.tax_paid > 0 && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
          Tax: {fmtRounded(row.tax_paid)}{row.tax_state > 0 ? ` (incl. ${fmtRounded(row.tax_state)} state)` : ''}
        </div>
      )}
      {!isAccum && row.filing_status === 'single' && (
        <div style={{ fontSize: 10, color: '#a855f7', marginTop: 2 }}>
          Filing: Single (post-survivor)
        </div>
      )}
      {!isAccum && row.rmd_required > 0 && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
          RMD required: {fmtRounded(row.rmd_required)}/yr
        </div>
      )}
      {!isAccum && row.effective_spending > 0 && row.effective_spending !== row.income_streams + row.portfolio_draw && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          Spending target: {fmtRounded(row.effective_spending)}/yr
        </div>
      )}
      {row.income_shortfall > 0 && (
        <div style={{ fontSize: 11, color: 'var(--accent-red)', marginTop: 2 }}>
          Income shortfall: {fmtRounded(row.income_shortfall)}/yr (portfolio empty)
        </div>
      )}
    </div>
  )
}
