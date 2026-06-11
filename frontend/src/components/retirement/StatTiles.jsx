/**
 * StatTiles — presentational tile components used in the Results section
 * of the retirement projection.
 *
 * Extracted from RetirementProjection.jsx. All components are stateless
 * and props-driven. fmtRounded is imported from shared.js.
 *
 * Components:
 *   StatTile            — single labeled metric tile
 *   SSStreamTiles       — three-tile group for one Social Security stream
 *   TaxExposureTile     — bucket allocation breakdown tile
 *   LegendItem          — inline chart legend swatch + label
 *   MaxSustainableCallout — max-sustainable-spending info card with apply CTA
 */
import { fmtRounded } from './shared'

export function StatTile({ label, value, subtitle, color, icon }) {
  return (
    <div style={{
      padding: '12px 14px',
      borderRadius: 8,
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid rgba(255,255,255,0.06)',
    }}>
      <div style={{
        fontSize: 11, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {icon}
        {label}
      </div>
      <div style={{
        fontSize: 20, fontWeight: 700,
        color: color || 'var(--text-primary)',
        fontVariantNumeric: 'tabular-nums', lineHeight: 1.1,
      }}>
        {value}
      </div>
      {subtitle && (
        <div style={{
          fontSize: 11, color: 'var(--text-muted)',
          marginTop: 4, lineHeight: 1.4,
        }}>
          {subtitle}
        </div>
      )}
    </div>
  )
}


/**
 * Per-stream Social Security tile group. Renders the same three tiles
 * (claim-age value, lifetime PV, after-tax) but parameterized so we can
 * call it twice — once per spouse — when both streams are active.
 *
 * showLabelSuffix toggles the " · You" / " · Spouse" suffix on the tile
 * labels: redundant when only one stream is active, helpful for
 * disambiguation when both are.
 */
export function SSStreamTiles({
  label, atStart, pv, afterTax, startAge, cola, today, ordinaryRate,
  showLabelSuffix, inflationRate = 0.025,
}) {
  // Strip the " · You" / " · Spouse" suffix when there's only one stream
  // — the label "SS @ claim" is clearer than "SS · You @ claim" if
  // there's no peer stream to disambiguate against.
  const baseLabel = showLabelSuffix ? label : 'SS'
  // Real cola = nominal - inflation. Surface both so the user can see
  // why claim-age value equals today's value (in real terms) and how
  // SS will behave post-claim.
  const realCola = cola - inflationRate
  const realPct = (realCola * 100).toFixed(1)
  const nominalPct = (cola * 100).toFixed(1)
  const realLabel = realCola < 0
    ? `${realPct}% real (eroded)`
    : realCola === 0
      ? '0% real (keeps pace)'
      : `+${realPct}% real growth`
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
      gap: 10,
      marginBottom: 16,
    }}>
      <StatTile
        label={`${baseLabel} @ claim`}
        value={`${fmtRounded(atStart)}/yr`}
        subtitle={`at age ${startAge} · ${nominalPct}% nominal · ${realLabel}`}
        color="var(--accent-blue)"
      />
      <StatTile
        label={`${baseLabel} lifetime value`}
        value={fmtRounded(pv)}
        subtitle="present value of 30-yr stream"
        color="var(--accent-blue)"
      />
      <StatTile
        label={`${baseLabel} after-tax / yr`}
        value={fmtRounded(afterTax)}
        subtitle={`taxed at 85% × ${(ordinaryRate * 100).toFixed(0)}%`}
        color="var(--accent-blue)"
      />
    </div>
  )
}


export function TaxExposureTile({ data }) {
  // HSA included in the breakdown — it's the 4th first-class bucket
  // since the HSA carve-out went in. Withdrawals on qualified medical
  // come out tax-free (the most efficient bucket of the four).
  const tdBal = data.buckets.tax_deferred || 0
  const rothBal = data.buckets.roth || 0
  const taxBal = data.buckets.taxable || 0
  const hsaBal = data.buckets.hsa || 0
  const totalBuckets = tdBal + rothBal + taxBal + hsaBal

  if (totalBuckets === 0) {
    return (
      <div style={{
        padding: '12px 14px',
        borderRadius: 8,
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
      }}>
        <div style={{
          fontSize: 11, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6,
        }}>
          Tax exposure
        </div>
        <div style={{
          fontSize: 13, color: 'var(--text-muted)',
        }}>
          No investment accounts assigned to tax buckets
        </div>
      </div>
    )
  }

  const pct = (n) => ((n / totalBuckets) * 100).toFixed(0)
  // Only render the HSA stat when there's actually HSA dollars — keeps
  // the tile uncluttered for households without an HSA tagged.
  const showHsa = hsaBal > 0
  const bucketCount = showHsa ? 4 : 3

  return (
    <div style={{
      padding: '12px 14px',
      borderRadius: 8,
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid rgba(255,255,255,0.06)',
    }}>
      <div style={{
        fontSize: 11, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6,
      }}>
        Tax exposure
      </div>
      <div style={{
        fontSize: 12, color: 'var(--text-primary)', marginBottom: 6,
        display: 'flex', gap: 12, flexWrap: 'wrap',
      }}>
        <span>Tax-deferred {pct(tdBal)}%</span>
        <span>·</span>
        <span>Roth {pct(rothBal)}%</span>
        <span>·</span>
        <span>Taxable {pct(taxBal)}%</span>
        {showHsa && <>
          <span>·</span>
          <span>HSA {pct(hsaBal)}%</span>
        </>}
      </div>
      <div style={{
        fontSize: 11, color: 'var(--text-muted)',
      }}>
        {fmtRounded(totalBuckets)} investable across {bucketCount} buckets
      </div>
    </div>
  )
}


/**
 * One row in the inline chart legend. Renders a small swatch (solid bar
 * for filled areas, short dashed line for ReferenceLine annotations,
 * vertical dashed line for the FI-hit-age marker) followed by a bold
 * label and a muted description.
 */
export function LegendItem({ color, label, description, dashed = false, vertical = false, faded = false }) {
  let swatch
  if (faded) {
    // Soft fill block — represents ReferenceArea background shading.
    swatch = (
      <span style={{
        display: 'inline-block', width: 18, height: 12, marginRight: 6,
        background: color, opacity: 0.18,
        borderRadius: 2,
      }} />
    )
  } else if (dashed && vertical) {
    // Tiny vertical dashed bar — represents ReferenceLine x={...}
    swatch = (
      <span style={{
        display: 'inline-block', width: 2, height: 14, marginRight: 6,
        background: `repeating-linear-gradient(0deg, ${color} 0 3px, transparent 3px 6px)`,
      }} />
    )
  } else if (dashed) {
    // Horizontal dashed bar — ReferenceLine y={...}
    swatch = (
      <span style={{
        display: 'inline-block', width: 18, height: 2, marginRight: 6,
        background: `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 8px)`,
      }} />
    )
  } else {
    // Solid bar — Area / Line / Bar series
    swatch = (
      <span style={{
        display: 'inline-block', width: 18, height: 4, marginRight: 6,
        background: color, borderRadius: 1, opacity: 0.85,
      }} />
    )
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 0 }}>
      {swatch}
      <span style={{ color: 'var(--text-secondary)', fontWeight: 500, marginRight: 4 }}>
        {label}
      </span>
      <span style={{ color: 'var(--text-muted)' }}>· {description}</span>
    </span>
  )
}


/**
 * Inline callout shown directly under the Retirement-income input.
 * Compact info card: title + status pill, headline metric, visual
 * progress bar showing current-vs-max, supporting context, apply CTA.
 *
 * Theming: uses the app's CSS variables so it adapts to dark mode.
 * Colors are green (headroom), yellow (tight), orange (over budget) —
 * deliberately NOT red, which reads as harsh-error in this context
 * where over-spend is a planning input, not a system failure.
 *
 * Three states:
 *   ok           — finite max; show amount + headroom + bar
 *   exceeds_max  — pension/SS covers spending above $1M/yr
 *   insufficient — even $1k/yr depletes early
 */
export function MaxSustainableCallout({ result, onApply }) {
  const { status, amount, target_age, current_desired, headroom, note } = result
  const fmtMoney = (n) => new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(Math.abs(n || 0))

  if (status === 'exceeds_max') {
    return (
      <div style={{
        marginTop: 8, fontSize: 12, padding: '8px 12px',
        background: 'var(--accent-green-bg)',
        border: '1px solid var(--accent-green-border)',
        borderRadius: 6, color: 'var(--text-primary)', lineHeight: 1.4,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ color: 'var(--accent-green)', fontSize: 14, fontWeight: 700 }}>✓</span>
        <span>
          <strong style={{ color: 'var(--text-primary)' }}>
            Max @ age {target_age}: &gt;$1M/yr.
          </strong>{' '}
          <span style={{ color: 'var(--text-secondary)' }}>
            {note || 'Pension/SS covers any reasonable spending.'}
          </span>
        </span>
      </div>
    )
  }
  if (status === 'insufficient') {
    return (
      <div style={{
        marginTop: 8, fontSize: 12, padding: '8px 12px',
        background: 'var(--accent-orange-bg)',
        border: '1px solid var(--accent-orange-border)',
        borderRadius: 6, color: 'var(--text-primary)', lineHeight: 1.4,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ color: 'var(--accent-orange)', fontSize: 14, fontWeight: 700 }}>!</span>
        <span>
          <strong style={{ color: 'var(--text-primary)' }}>
            No sustainable max @ age {target_age}.
          </strong>{' '}
          <span style={{ color: 'var(--text-secondary)' }}>
            {note || 'Plan is structurally under-funded.'}
          </span>
        </span>
      </div>
    )
  }

  // Main "ok" state. Color tiers — green / yellow / orange (no red).
  const headroomPct = current_desired > 0
    ? (headroom / current_desired) * 100
    : 0
  let accentVar, accentBgVar, accentBorderVar, headline
  if (headroom >= 0) {
    accentVar = 'var(--accent-green)'
    accentBgVar = 'var(--accent-green-bg)'
    accentBorderVar = 'var(--accent-green-border)'
    headline = 'Headroom'
  } else if (headroomPct > -5) {
    accentVar = 'var(--accent-yellow)'
    accentBgVar = 'var(--accent-yellow-bg)'
    accentBorderVar = 'var(--accent-yellow-border)'
    headline = 'Tight'
  } else {
    accentVar = 'var(--accent-orange)'
    accentBgVar = 'var(--accent-orange-bg)'
    accentBorderVar = 'var(--accent-orange-border)'
    headline = 'Over budget'
  }

  const fillPct = Math.min(100, Math.max(0, (current_desired / amount) * 100))

  return (
    <div style={{
      marginTop: 8,
      padding: '12px 14px',
      background: accentBgVar,
      border: `1px solid ${accentBorderVar}`,
      borderLeft: `3px solid ${accentVar}`,
      borderRadius: 6,
      fontSize: 12,
      lineHeight: 1.4,
      color: 'var(--text-primary)',
    }}>
      {/* Header: label + pill on the left, apply button on the right. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8, marginBottom: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
            textTransform: 'uppercase', color: 'var(--text-muted)',
          }}>
            Max sustainable @ {target_age}
          </span>
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 7px',
            borderRadius: 10, background: accentVar, color: 'var(--bg-card)',
            letterSpacing: 0.3,
          }}>
            {headline}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onApply && onApply(amount)}
          style={{
            padding: '4px 10px', fontSize: 11, fontWeight: 600,
            background: accentVar, color: 'var(--bg-card)', border: 'none',
            borderRadius: 4, cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
          title={`Set Retirement income to ${fmtMoney(amount)}/yr`}
        >
          Apply {fmtMoney(amount)}
        </button>
      </div>

      {/* 3-up metric tiles. Headroom gets the lead position because
          it's the actionable number — "how much can I move?" — while
          max and current are reference points. Headroom uses the
          accent color and the largest font; max and current sit
          quieter. Same anatomy whether positive (headroom) or negative
          (over budget) — only the sign + label flip. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 12,
        marginBottom: 8,
      }}>
        {/* Headroom — the lead metric */}
        <div>
          <div style={{
            fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
            textTransform: 'uppercase', color: 'var(--text-muted)',
            marginBottom: 2,
          }}>
            {headroom >= 0 ? 'Headroom' : 'Over budget'}
          </div>
          <div style={{
            fontSize: 22, fontWeight: 700, color: accentVar, lineHeight: 1.1,
          }}>
            {headroom >= 0 ? '+' : '−'}{fmtMoney(headroom)}
            <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>
              /yr
            </span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
            {Math.abs(Math.round(headroomPct))}% of current spend
          </div>
        </div>

        {/* Max gross — supporting metric */}
        <div>
          <div style={{
            fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
            textTransform: 'uppercase', color: 'var(--text-muted)',
            marginBottom: 2,
          }}>
            Max gross
          </div>
          <div style={{
            fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.1,
          }}>
            {fmtMoney(amount)}
            <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>
              /yr
            </span>
          </div>
          {result.after_tax_avg > 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
              ~{fmtMoney(result.after_tax_avg)} after-tax ({Math.round((1 - result.after_tax_avg / amount) * 100)}%)
            </div>
          )}
        </div>

        {/* Current — reference */}
        <div>
          <div style={{
            fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
            textTransform: 'uppercase', color: 'var(--text-muted)',
            marginBottom: 2,
          }}>
            Current
          </div>
          <div style={{
            fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.1,
          }}>
            {fmtMoney(current_desired)}
            <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>
              /yr
            </span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
            {Math.round((current_desired / amount) * 100)}% of max
          </div>
        </div>
      </div>

      {/* Progress bar — current vs max */}
      <div style={{
        position: 'relative', height: 6, borderRadius: 3,
        background: 'var(--bg-input)', overflow: 'hidden', marginBottom: 4,
      }}>
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${fillPct}%`, background: accentVar,
          transition: 'width 200ms ease',
        }} />
      </div>
      {/* Bar caption — minimal since the 3 metric tiles already show
          the $ values. Just labels the endpoints for visual orientation. */}
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontSize: 10, color: 'var(--text-muted)',
      }}>
        <span>$0</span>
        <span>{Math.round(fillPct)}% of max</span>
      </div>
    </div>
  )
}
