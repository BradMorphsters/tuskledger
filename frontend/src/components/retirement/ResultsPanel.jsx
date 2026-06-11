/**
 * ResultsPanel — the full results section rendered below the form when
 * the API returns data. Contains:
 *   - Headline stat tiles (invested, FI number, projected balance, survival)
 *   - Pension-specific tiles + bridge-years caption
 *   - Social Security tiles (per stream + combined when both active)
 *   - SS claim-age comparison sweep table
 *   - Pre-59½ bridge warning panel
 *   - After-tax stat tiles
 *   - Lifetime totals (taxes, RMDs, healthcare, LTC)
 *   - Monte Carlo probability tiles
 *   - Survivor stress indicator
 *   - Real + Nominal projection charts (with fan chart when MC ran)
 *   - Sensitivity table
 *   - Disclosure / assumptions footer
 *
 * Extracted from RetirementProjection.jsx. No form state; receives the
 * full API response object as `data`.
 */
import {
  ResponsiveContainer, ComposedChart, Area, Bar, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine, ReferenceArea,
} from 'recharts'
import { AlertCircle, CheckCircle } from 'lucide-react'
import { fmtRounded, toNominal } from './shared'
import { StatTile, SSStreamTiles, TaxExposureTile, LegendItem } from './StatTiles'
import { ChartTooltip } from './ChartTooltip'

export function Results({ data }) {
  const onTrack = data.on_track
  const gapColor = onTrack ? 'var(--accent-green)' : 'var(--accent-red)'
  const hasPension = (data.inputs.pension_annual || 0) > 0
  const hasSocialSecurity = (data.inputs.ss_annual || 0) > 0
  const hasSocialSecurity2 = (data.inputs.ss2_annual || 0) > 0
  const hasAnySS = hasSocialSecurity || hasSocialSecurity2
  const hasFixedIncome = hasPension || hasAnySS
  // Combined SS values for tiles/captions that want a household total.
  const ssTotalAtStart = (data.ss_total_at_start ?? data.ss_at_start) || 0
  const ssTotalPv = (data.ss_total_pv ?? data.ss_pv) || 0
  const afterTaxSSTotal =
    (data.after_tax_ss_income || 0) + (data.after_tax_ss2_income || 0)
  // Two-phase sim outputs. last_retirement_user_age is when withdrawals
  // actually start in the household (max of you + spouse retirement).
  // depleted_age is null when the portfolio survives the planning horizon.
  const lastRetireAge = data.last_retirement_user_age ?? data.inputs.retirement_age
  const accumulationYears = data.accumulation_years ?? data.years_to_retirement
  const depletedAge = data.depleted_age
  const endBalance = data.end_balance ?? data.projected_balance

  // Build the chart data — historical (just one point: today's balance)
  // plus year-by-year projection. Carry `phase` so the chart can render
  // accumulation and withdrawal sections distinctly. Income/draw fields
  // are exposed for the tooltip.
  const chartData = [
    {
      year: 0, age: data.inputs.current_age,
      balance: data.current_assets,
      phase: 'accumulating',
      income_streams: 0, portfolio_draw: 0,
    },
    ...data.year_by_year.map(r => ({
      year: r.year, age: r.age, balance: r.balance,
      phase: r.phase,
      income_streams: r.income_streams ?? 0,
      portfolio_draw: r.portfolio_draw ?? 0,
      draw_taxable: r.draw_taxable ?? 0,
      draw_tax_deferred: r.draw_tax_deferred ?? 0,
      draw_roth: r.draw_roth ?? 0,
      after_tax_income: r.after_tax_income ?? 0,
      early_withdrawal_penalty: r.early_withdrawal_penalty ?? 0,
      // RMD, effective spending, healthcare bridge, LTC, tax, and
      // filing status — all surfaced in tooltip when non-zero or
      // worth showing.
      rmd_required: r.rmd_required ?? 0,
      effective_spending: r.effective_spending ?? 0,
      healthcare_cost: r.healthcare_cost ?? 0,
      ltc_cost: r.ltc_cost ?? 0,
      tax_paid: r.tax_paid ?? 0,
      tax_state: r.tax_state ?? 0,
      filing_status: r.filing_status ?? 'mfj',
      income_shortfall: r.income_shortfall ?? 0,
    })),
  ]

  // Compute USER-age at which each income stream first turns on. These
  // become reference-line annotations on the chart so the user can see
  // exactly when income comes online and connect that to the curve's
  // shape (steep drops during pure-portfolio years, flatter once income
  // kicks in). Labels are short (e.g. "Pension @55") so they don't
  // collide horizontally; vertical staggering happens below.
  const incomeOnsets = []
  if (hasPension) {
    const userAgeAtPensionStart = data.inputs.current_age + Math.max(
      0,
      (data.inputs.pension_start_age ?? data.inputs.retirement_age) -
        (data.inputs.pension_holder_age ?? data.inputs.current_age),
    )
    incomeOnsets.push({
      age: userAgeAtPensionStart,
      label: `Pension @${data.inputs.pension_start_age}`,
    })
  }
  if (hasSocialSecurity) {
    const userAgeAtSS1 = data.inputs.current_age + Math.max(
      0,
      data.inputs.ss_start_age - (data.inputs.ss_holder_age ?? data.inputs.current_age),
    )
    incomeOnsets.push({
      age: userAgeAtSS1,
      label: `SS·You @${data.inputs.ss_start_age}`,
    })
  }
  if (hasSocialSecurity2) {
    const userAgeAtSS2 = data.inputs.current_age + Math.max(
      0,
      data.inputs.ss2_start_age - (data.inputs.ss2_holder_age ?? data.inputs.current_age),
    )
    incomeOnsets.push({
      age: userAgeAtSS2,
      label: `SS·Sp @${data.inputs.ss2_start_age}`,
    })
  }

  // ─── Build a single sorted+staggered list of vertical-line annotations.
  // Recharts doesn't auto-arrange labels, so when ages are close together
  // (e.g. pension at 57 + withdrawals at 60 + SS at 67 + spouse-SS at 69)
  // the text labels collide horizontally. We:
  //   1. Collect every vertical line annotation with its color/style.
  //   2. Sort by age so adjacent labels are consecutive in the array.
  //   3. Cycle a `dy` offset across 4 stack rows (0, -14, -28, -42 px),
  //      so even neighbors get stacked vertically and never overlap.
  // The chart's top margin is sized to fit 4 rows of stacked labels.
  const verticalAnnotations = [
    ...incomeOnsets.map(o => ({
      age: o.age, label: o.label, kind: 'income',
      color: 'var(--accent-blue)', dashArray: '2 4', strokeWidth: 1.5,
    })),
    {
      age: lastRetireAge,
      label: `Withdrawals @${lastRetireAge}`,
      kind: 'withdraw',
      color: 'var(--text-secondary)',
      dashArray: '3 3',
      strokeWidth: 1.5,
    },
    ...(data.fi_hit_age != null && data.fi_hit_age >= data.inputs.current_age
      ? [{
          age: data.fi_hit_age,
          label: `FI @${data.fi_hit_age}`,
          kind: 'fi',
          color: 'var(--accent-green)',
          dashArray: '4 4',
          strokeWidth: 1.5,
        }]
      : []),
    // Depletion marker — red, prominent. Only present when the
    // simulation actually drives balance to zero within the horizon.
    // The most actionable single number on the chart: "you run out
    // here." If absent, the portfolio survives the full plan.
    ...(depletedAge != null
      ? [{
          age: depletedAge,
          label: `$0 @${depletedAge}`,
          kind: 'depleted',
          color: 'var(--accent-red)',
          dashArray: '4 2',
          strokeWidth: 2,
        }]
      : []),
  ]
    .sort((a, b) => a.age - b.age)
    .map((ann, i) => ({ ...ann, dy: -(i % 4) * 14 }))

  // FI tile shows the pension-adjusted target when a pension is active.
  // Both numbers stay reachable (the raw FI is still in data.fi_number)
  // but the headline reflects what you actually need to hit.
  const fiTileValue = hasFixedIncome ? data.effective_fi_number : data.fi_number
  const fiTileSubtitle = hasFixedIncome
    ? `${fmtRounded(data.fi_number)} − ${[
        hasPension && `pension ${fmtRounded(data.pension_at_start)}`,
        hasAnySS && `SS ${fmtRounded(ssTotalAtStart)}`,
      ].filter(Boolean).join(' − ')}/yr`
    : `${(data.inputs.desired_annual_income / 1000).toFixed(0)}k/yr ÷ ${(data.inputs.withdrawal_rate * 100).toFixed(1)}%`

  return (
    <>
      {/* Headline stat tiles */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
        gap: 10,
        marginBottom: 16,
      }}>
        <StatTile
          label="Today's invested"
          value={fmtRounded(data.current_assets)}
          // Surface excluded accounts inline — silent exclusion would
          // mislead. Lets the user audit what's actually being counted.
          subtitle={
            (data.excluded_count || 0) > 0
              ? `${fmtRounded(data.excluded_total)} in ${data.excluded_count} account${data.excluded_count !== 1 ? 's' : ''} excluded`
              : 'across investment accounts'
          }
        />
        <StatTile
          label={hasFixedIncome
            ? `FI number (${[hasPension && 'pension', hasAnySS && 'SS']
                .filter(Boolean).join(' + ')})`
            : 'FI number'}
          value={fmtRounded(fiTileValue)}
          subtitle={fiTileSubtitle}
        />
        <StatTile
          label="Projected at retirement"
          value={fmtRounded(data.projected_balance)}
          // Use last_retirement_user_age — when household withdrawals
          // actually start, which differs from your retirement_age
          // when spouse retires later. accumulation_years is your
          // years until that moment.
          subtitle={lastRetireAge !== data.inputs.retirement_age
            ? `age ${lastRetireAge} (last to retire) · ${accumulationYears}y out`
            : `age ${data.inputs.retirement_age} · ${data.years_to_retirement}y out`}
          color="var(--accent-blue)"
        />
        {/* Survival tile — replaces the old "Surplus / Gap" tile.
            "Lasts until" is the most actionable answer the simulation
            gives, since it accounts for staged income onset and the
            stop-contributing-at-last-retirement rule. Falls back to a
            depletion-warning when balance hits zero within horizon. */}
        <StatTile
          label={onTrack ? 'Lasts through plan' : 'Depletes at age'}
          value={onTrack
            ? `age ${chartData[chartData.length - 1].age}+`
            : `${depletedAge}`}
          subtitle={
            onTrack
              ? data.fi_hit_age != null && data.fi_hit_age < data.inputs.retirement_age
                ? `FI reached at age ${data.fi_hit_age} (${data.inputs.retirement_age - data.fi_hit_age}y early) · ends at ${fmtRounded(endBalance)}`
                : `simulation ends at ${fmtRounded(endBalance)}`
              : `add ${fmtRounded(data.monthly_contribution_to_close_gap)}/mo to close static gap`
          }
          color={gapColor}
          icon={onTrack ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
        />
      </div>

      {/* Pension-specific tiles + bridge-years caption — only when active */}
      {hasPension && (
        <>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
            gap: 10,
            marginBottom: 16,
          }}>
            <StatTile
              label="Pension @ start"
              value={`${fmtRounded(data.pension_at_start)}/yr`}
              // Real-terms model: pension at claim = today's-dollars
              // value the user entered (no pre-claim compounding). What
              // matters for sustainability is the post-claim erosion
              // pattern — surface nominal COLA + real (after-inflation)
              // so both perspectives are clear.
              subtitle={(() => {
                const nominal = data.inputs.pension_cola
                const real = (nominal - (data.inputs.inflation_rate || 0.025))
                const realPct = (real * 100).toFixed(1)
                const nominalPct = (nominal * 100).toFixed(1)
                const realLabel = real < 0
                  ? `${realPct}% real (eroded by inflation)`
                  : real === 0
                    ? '0% real (keeps pace)'
                    : `+${realPct}% real growth`
                const ageLabel = data.inputs.pension_holder_age !== data.inputs.current_age
                  ? `spouse retires at ${data.inputs.pension_start_age} (in ${
                      data.inputs.pension_start_age - data.inputs.pension_holder_age
                    }y)`
                  : `at age ${data.inputs.pension_start_age}`
                return `${ageLabel} · ${nominalPct}% nominal · ${realLabel}`
              })()}
              color="var(--accent-blue)"
            />
            <StatTile
              label="Pension lifetime value"
              value={fmtRounded(data.pension_pv)}
              subtitle="present value of 30-yr stream"
              color="var(--accent-blue)"
            />
            {data.bridge_years > 0 && (
              <StatTile
                label="Bridge years"
                value={`${data.bridge_years} yr${data.bridge_years !== 1 ? 's' : ''}`}
                subtitle={`portfolio funds ${fmtRounded(data.bridge_full_income_needed)} of full income before pension starts`}
                color="var(--accent-orange)"
                icon={<AlertCircle size={14} />}
              />
            )}
          </div>
        </>
      )}

      {/* Social Security tiles — render per active stream so each
          spouse's claim age and annual amount stay readable. When two
          streams are active we also surface a "household total" row. */}
      {hasSocialSecurity && (
        <SSStreamTiles
          label="SS · You"
          atStart={data.ss_at_start}
          pv={data.ss_pv}
          afterTax={data.after_tax_ss_income}
          startAge={data.inputs.ss_start_age}
          cola={data.inputs.ss_cola}
          today={data.inputs.ss_annual}
          ordinaryRate={data.inputs.tax_rate_ordinary}
          inflationRate={data.inputs.inflation_rate}
          showLabelSuffix={hasSocialSecurity2}
        />
      )}
      {hasSocialSecurity2 && (
        <SSStreamTiles
          label="SS · Spouse"
          atStart={data.ss2_at_start}
          pv={data.ss2_pv}
          afterTax={data.after_tax_ss2_income}
          startAge={data.inputs.ss2_start_age}
          cola={data.inputs.ss2_cola}
          today={data.inputs.ss2_annual}
          ordinaryRate={data.inputs.tax_rate_ordinary}
          inflationRate={data.inputs.inflation_rate}
          showLabelSuffix
        />
      )}
      {hasSocialSecurity && hasSocialSecurity2 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: 10,
          marginBottom: 16,
        }}>
          <StatTile
            label="SS combined @ claim"
            value={`${fmtRounded(ssTotalAtStart)}/yr`}
            subtitle="both streams stacked"
            color="var(--accent-blue)"
          />
          <StatTile
            label="SS combined lifetime"
            value={fmtRounded(ssTotalPv)}
            subtitle="present value of both 30-yr streams"
            color="var(--accent-blue)"
          />
          <StatTile
            label="SS combined after-tax / yr"
            value={fmtRounded(afterTaxSSTotal)}
            subtitle={`taxed at 85% × ${(data.inputs.tax_rate_ordinary * 100).toFixed(0)}%`}
            color="var(--accent-blue)"
          />
        </div>
      )}

      {/* SS delayed-claiming sweep — show lifetime tax + end balance
          across the standard claim ages (62/65/67/70). The actuarial
          adjustment is built in: 70% at 62, ~87% at 65, 100% at 67,
          124% at 70 (both streams adjusted in lockstep). The "best"
          strategy is whichever maximizes end balance net of lifetime
          tax — usually 67 or 70 for healthy life expectancy, but
          earlier claiming wins if longevity is questionable or you
          need the cash flow sooner. */}
      {data.ss_claim_sweep && (
        <div style={{
          marginBottom: 16,
          padding: '12px 14px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
          borderRadius: 8,
          fontSize: 12,
        }}>
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
            textTransform: 'uppercase', color: 'var(--text-muted)',
            marginBottom: 8,
          }}>
            SS claim-age comparison · current: age {data.ss_claim_sweep.current_claim_age}
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '50px 1fr 1fr 1fr 70px 80px',
            gap: 8,
            fontSize: 11,
            color: 'var(--text-muted)',
            marginBottom: 4,
            paddingBottom: 4,
            borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.08))',
          }}>
            <div>Claim @</div>
            <div>SS combined /yr</div>
            <div>Lifetime tax</div>
            <div>End balance</div>
            <div title="Death age at which delaying becomes cumulatively positive (live past this → delaying wins; die before → earlier wins)">
              Break-even
            </div>
            <div style={{ textAlign: 'right' }}>vs current</div>
          </div>
          {(() => {
            const current = data.ss_claim_sweep.results.find(
              r => r.claim_age === data.ss_claim_sweep.current_claim_age
            )
            const baselineEnd = current ? current.end_balance : 0
            return data.ss_claim_sweep.results.map(row => {
              const delta = row.end_balance - baselineEnd
              const isCurrent = row.claim_age === data.ss_claim_sweep.current_claim_age
              const deltaColor = delta > 1000 ? 'var(--accent-green)'
                : delta < -1000 ? 'var(--accent-orange)'
                : 'var(--text-muted)'
              return (
                <div key={row.claim_age} style={{
                  display: 'grid',
                  gridTemplateColumns: '50px 1fr 1fr 1fr 70px 80px',
                  gap: 8,
                  padding: '6px 0',
                  fontSize: 12,
                  color: 'var(--text-primary)',
                  fontWeight: isCurrent ? 700 : 400,
                  borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.04))',
                }}>
                  <div>
                    {row.claim_age}{isCurrent && (
                      <span style={{ color: 'var(--accent-blue)', fontSize: 10, marginLeft: 4 }}>
                        ✓
                      </span>
                    )}
                  </div>
                  <div>{fmtRounded(row.adjusted_annual_ss_combined)}</div>
                  <div>{fmtRounded(row.lifetime_tax)}</div>
                  <div>{fmtRounded(row.end_balance)}</div>
                  <div style={{
                    color: row.break_even_age != null ? 'var(--accent-blue)' : 'var(--text-muted)',
                    fontWeight: 600,
                  }}>
                    {isCurrent ? '—' : (row.break_even_age != null ? `age ${row.break_even_age}` : '—')}
                  </div>
                  <div style={{ textAlign: 'right', color: deltaColor, fontWeight: 600 }}>
                    {isCurrent ? '—' : (delta >= 0 ? '+' : '') + fmtRounded(delta)}
                  </div>
                </div>
              )
            })
          })()}
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4 }}>
            Actuarial factors built in (62 = 70%, 65 = 87%, 67 = 100%, 70 = 124% of PIA). Both spouse streams adjust in lockstep. Larger end balance = more efficient claim age for your scenario.
            <strong style={{ color: 'var(--accent-blue)' }}> Break-even</strong> = death age where delaying becomes cumulatively positive (live past it → delaying wins; die before → earlier-claim wins). Pure SS-cumulative math, ignores portfolio side-effects.
          </div>
        </div>
      )}

      {/* Pre-59½ bridge warning — applies only when projection says you
          can retire before 60 AND tax-deferred is meaningful. The IRS
          10% early-withdrawal penalty makes 401(k) money mostly
          inaccessible during the bridge years; this tile tells the
          user honestly what's reachable. */}
      {data.bridge_pre_595 && (
        <div style={{
          marginBottom: 16,
          padding: '12px 14px',
          background: data.bridge_pre_595.covered
            ? 'rgba(52, 211, 153, 0.06)'
            : 'rgba(251, 146, 60, 0.08)',
          border: `1px solid ${
            data.bridge_pre_595.covered
              ? 'rgba(52, 211, 153, 0.3)'
              : 'rgba(251, 146, 60, 0.3)'
          }`,
          borderRadius: 8,
          fontSize: 13,
          color: 'var(--text-secondary)',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
            color: data.bridge_pre_595.covered ? 'var(--accent-green)' : 'var(--accent-orange)',
            fontWeight: 600,
            fontSize: 13,
          }}>
            {data.bridge_pre_595.covered ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
            {data.bridge_pre_595.covered
              ? `Pre-59½ bridge IS covered`
              : `Pre-59½ bridge is short ${fmtRounded(data.bridge_pre_595.shortfall)}`}
          </div>
          <div style={{ lineHeight: 1.6 }}>
            FI hits at age <strong>{data.bridge_pre_595.fi_hit_age}</strong>, but tax-deferred
            accounts ({fmtRounded(data.bridge_pre_595.tax_deferred_locked)}) are locked until 59½ without
            a 10% early-withdrawal penalty. To bridge the {data.bridge_pre_595.years_to_595}-year
            gap to age 60, you'd need <strong>{fmtRounded(data.bridge_pre_595.spending_needed)}</strong>{' '}
            in spending. Penalty-free sources during that window:{' '}
            <strong style={{ color: 'var(--text-primary)' }}>
              {fmtRounded(data.bridge_pre_595.total_covered)}
            </strong>{' '}
            ({fmtRounded(data.bridge_pre_595.accessible_liquid)} taxable + Roth
            {data.bridge_pre_595.pension_contribution > 0
              && ` + ${fmtRounded(data.bridge_pre_595.pension_contribution)} pension`}
            {data.bridge_pre_595.ss_contribution > 0
              && ` + ${fmtRounded(data.bridge_pre_595.ss_contribution)} SS`}).
            {!data.bridge_pre_595.covered && (
              <span>
                {' '}Workarounds: <em>Rule of 55</em> (retire at 55 from current employer's plan
                only), <em>72(t) SEPP</em> (locks you into a fixed payment schedule for 5+ years),
                or a Roth conversion ladder. None of these are modeled here.
              </span>
            )}
          </div>
        </div>
      )}

      {/* After-tax stat tiles — show when taxes apply */}
      {data.weighted_withdrawal_tax_rate > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: 10,
          marginBottom: 16,
        }}>
          {/* Headline now uses the SIMULATION-derived average across
              withdrawal years (more accurate than the legacy steady-
              state formula because it accounts for staged income onset,
              taxable-bridge strategy, RMDs, and phase spending). The
              range below shows volatility year-over-year so the user
              isn't surprised by a low-min year. */}
          <StatTile
            label="After-tax avg / yr"
            value={fmtRounded(data.sim_after_tax_avg)}
            subtitle={`range ${fmtRounded(data.sim_after_tax_min)} – ${fmtRounded(data.sim_after_tax_max)} · per-year sim across ${data.year_by_year.filter(r => r.phase === 'withdrawing').length}y`}
            color="var(--accent-blue)"
          />
          {/* Bridge-window after-tax — separate tile because the
              taxable-first strategy makes the bridge years materially
              different from steady-state. Only shown when an SS stream
              creates a meaningful bridge (otherwise = avg). */}
          {data.sim_bridge_after_tax_avg > 0 && data.sim_bridge_after_tax_avg !== data.sim_after_tax_avg && (
            <StatTile
              label="After-tax (bridge yrs)"
              value={fmtRounded(data.sim_bridge_after_tax_avg)}
              subtitle="avg until SS claim — shows benefit of taxable-first strategy"
              color="var(--accent-green)"
            />
          )}
          <StatTile
            label="After-tax FI number"
            value={fmtRounded(data.after_tax_fi_number)}
            subtitle={`vs pre-tax ${fmtRounded(data.fi_number)}`}
            color="var(--text-primary)"
          />
          <TaxExposureTile data={data} />
        </div>
      )}

      {/* Lifetime totals — surface only when something to show. RMDs
          and healthcare are 0 unless those features are active. */}
      {(data.total_taxes_paid > 0 || data.total_rmd_taken > 0 || data.total_healthcare_paid > 0 || data.total_ltc_paid > 0) && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: 10,
          marginBottom: 16,
        }}>
          <StatTile
            label="Lifetime taxes"
            value={fmtRounded(data.total_taxes_paid)}
            subtitle={
              data.total_state_tax > 0
                ? `${fmtRounded(data.total_federal_tax)} fed + ${fmtRounded(data.total_state_tax)} state`
                : 'federal only · across all withdrawal years'
            }
            color="var(--accent-orange)"
          />
          {data.total_rmd_taken > 0 && (
            <StatTile
              label="Lifetime RMDs"
              value={fmtRounded(data.total_rmd_taken)}
              subtitle="forced tax-deferred draws starting at 73"
              color="var(--text-secondary)"
            />
          )}
          {data.total_healthcare_paid > 0 && (
            <StatTile
              label="Pre-Medicare healthcare"
              value={fmtRounded(data.total_healthcare_paid)}
              subtitle="total ACA-bridge spending until both 65"
              color="var(--accent-orange)"
            />
          )}
          {data.total_ltc_paid > 0 && (
            <StatTile
              label="Lifetime LTC"
              value={fmtRounded(data.total_ltc_paid)}
              subtitle={`${data.inputs.ltc_duration_years}y starting at age ${data.inputs.ltc_start_age}`}
              color="var(--accent-red)"
              icon={<AlertCircle size={14} />}
            />
          )}
        </div>
      )}

      {/* Monte Carlo probability tile — shown only when MC ran. Surfaces
          the headline "probability of success" + key percentile balances
          at the planning horizon. The deterministic projection above is
          still shown (the median path); MC adds the distribution context. */}
      {data.monte_carlo && data.monte_carlo.n_runs > 0 && (() => {
        const mc = data.monte_carlo
        const successPct = Math.round(mc.success_probability * 100)
        const successColor = successPct >= 90
          ? 'var(--accent-green)'
          : successPct >= 75
            ? 'var(--accent-blue)'
            : successPct >= 60
              ? 'var(--accent-orange)'
              : 'var(--accent-red)'
        const lastRow = mc.year_by_year_pct[mc.year_by_year_pct.length - 1]
        return (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
            gap: 10,
            marginBottom: 16,
          }}>
            <StatTile
              label={`Probability of success (${mc.n_runs} runs)`}
              value={`${successPct}%`}
              subtitle={
                successPct >= 90
                  ? 'plan survives nearly every simulated path'
                  : successPct >= 75
                    ? 'comfortably likely to succeed'
                    : successPct >= 60
                      ? 'meaningful risk — consider stress-testing'
                      : 'high risk of running out — adjust inputs'
              }
              color={successColor}
              icon={successPct >= 90 ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
            />
            <StatTile
              label="Median end balance"
              value={fmtRounded(mc.median_end_balance)}
              subtitle={`at age ${lastRow ? lastRow.age : '—'} (50th pct)`}
              color="var(--accent-blue)"
            />
            {lastRow && (
              <StatTile
                label="Range at end (10–90 pct)"
                value={`${fmtRounded(lastRow.balance_p10)} – ${fmtRounded(lastRow.balance_p90)}`}
                subtitle="80% of simulated futures land in this range"
                color="var(--text-secondary)"
              />
            )}
            {mc.depletion_ages.length > 0 && (
              <StatTile
                label="Depletion (when it happens)"
                value={(() => {
                  const sorted = [...mc.depletion_ages].sort((a, b) => a - b)
                  const median = sorted[Math.floor(sorted.length / 2)]
                  return `age ${median}`
                })()}
                subtitle={`${mc.depletion_ages.length}/${mc.n_runs} paths deplete · median age shown`}
                color="var(--accent-red)"
                icon={<AlertCircle size={14} />}
              />
            )}
          </div>
        )
      })()}

      {/* Survivor stress test indicator — show prominently when active so
          the user knows the projection above factors in the loss of a
          spouse at the specified age. */}
      {data.inputs.survivor_at_user_age != null && (
        <div style={{
          marginBottom: 16,
          padding: '10px 14px',
          background: 'rgba(168, 85, 247, 0.08)',
          border: '1px solid rgba(168, 85, 247, 0.3)',
          borderRadius: 8,
          fontSize: 12,
          color: 'var(--text-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <span style={{
            display: 'inline-block', padding: '3px 8px',
            background: 'rgba(168, 85, 247, 0.18)',
            color: '#a855f7',
            borderRadius: 4, fontSize: 10, fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: 0.5,
          }}>
            Survivor stress
          </span>
          <span>
            Modeling loss of one spouse at age <strong>{data.inputs.survivor_at_user_age}</strong>:
            smaller SS terminates,
            pension reduces to {Math.round(data.inputs.pension_survivor_pct * 100)}% of original,
            filing flips MFJ → Single (brackets shrink, deduction halves).
          </span>
        </div>
      )}

      {/* Real vs Nominal — two stacked charts.
          Real (today's dollars) is what we use for planning since
          the FI calculation, the 4% rule, and the desired_income
          input are all defined in real terms. Nominal (future
          dollars) shows what your brokerage/SS/pension statements
          will actually say at each age, including the inflation
          tailwind on balance and the spending requirement growing
          to maintain the same real purchasing power. Same underlying
          simulation, just two views.

          Defining renderChart here so we can reuse the entire chart
          block (200+ lines of Recharts JSX) without duplication. The
          function closes over data/lastRetireAge/verticalAnnotations/
          incomeOnsets/depletedAge — everything except the chartData
          input and the mode flag. */}
      {(() => {
        const nominalChartData = toNominal(chartData, data.inputs.inflation_rate || 0.025)
        const renderChart = (rows, mode) => {
          const isNominal = mode === 'nominal'
          const yLabel = isNominal ? 'Nominal $ (future)' : 'Real $ (today)'
          return (
        <div style={{
          marginBottom: 24,
          // Visual separator between the two charts: the nominal chart
          // gets a top border + extra top padding so the eye doesn't
          // confuse it with a continuation of the real chart's legend.
          ...(isNominal ? {
            paddingTop: 20,
            borderTop: '1px solid rgba(255,255,255,0.08)',
            marginTop: 16,
          } : {}),
        }}>
          {/* Section header — badge + title + subtitle. Bigger and
              more prominent than the original inline label so the
              two charts read as distinct views. */}
          <div style={{ marginBottom: 10 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              marginBottom: 4,
            }}>
              <span style={{
                display: 'inline-block',
                padding: '4px 10px',
                background: isNominal
                  ? 'rgba(168, 85, 247, 0.15)'
                  : 'rgba(96, 165, 250, 0.15)',
                color: isNominal ? '#a855f7' : 'var(--accent-blue)',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: 0.6,
              }}>
                {isNominal ? 'Nominal' : 'Real'}
              </span>
              <span style={{
                fontSize: 17,
                fontWeight: 600,
                color: 'var(--text-primary)',
                letterSpacing: 0.1,
              }}>
                {isNominal ? 'Future dollars' : 'Today\'s dollars'}
              </span>
            </div>
            <div style={{
              fontSize: 12,
              color: 'var(--text-muted)',
              lineHeight: 1.45,
              marginLeft: 2,
            }}>
              {isNominal
                ? 'What your brokerage / pension / SS statements will literally say at each age. Inflation grows balances, spending requirements, and SS — pension stays nominally flat.'
                : 'Purchasing power held constant. This is the financial-independence / planning view — the FI number, 4% rule, and your $100k spending target are all defined here.'}
            </div>
          </div>
        <ResponsiveContainer width="100%" height={380}>
          <ComposedChart data={rows} margin={{ top: 70, right: 30, left: 5, bottom: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="age"
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              label={{ value: 'Age', position: 'insideBottom', offset: -5, fill: 'var(--text-muted)', fontSize: 11 }}
            />
            {/* Primary Y axis: portfolio balance (millions). */}
            <YAxis
              yAxisId="balance"
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              tickFormatter={v => `$${(v / 1_000_000).toFixed(1)}M`}
            />
            {/* Secondary Y axis: yearly portfolio draw (thousands).
                Right-side scale lets the draw bars show real dollar
                magnitude without dwarfing the balance area or vice versa. */}
            <YAxis
              yAxisId="draw"
              orientation="right"
              tick={{ fill: 'var(--accent-orange)', fontSize: 10 }}
              tickFormatter={v => v === 0 ? '0' : `$${(v / 1000).toFixed(0)}k`}
              label={{
                value: 'Portfolio draw / yr',
                angle: 90,
                position: 'insideRight',
                fill: 'var(--accent-orange)',
                fontSize: 10,
                offset: 10,
              }}
            />
            <Tooltip
              contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }}
              content={<ChartTooltip desiredIncome={data.inputs.desired_annual_income} />}
            />
            {/* Subtle background shading for the withdrawal phase so
                the eye instantly sees where contributions stop and
                drawdown begins. */}
            {chartData.length > 1 && (
              <ReferenceArea
                yAxisId="balance"
                x1={lastRetireAge}
                x2={chartData[chartData.length - 1].age}
                fill="var(--accent-orange)"
                fillOpacity={0.04}
                stroke="none"
              />
            )}
            {/* All vertical reference lines (withdrawals-begin,
                income onsets, FI-hit). Sorted by age and assigned
                a cyclic dy stack offset so labels don't collide
                horizontally. See verticalAnnotations construction
                above for the staggering logic. */}
            {verticalAnnotations.map((ann, i) => (
              <ReferenceLine
                yAxisId="balance"
                key={`vann-${i}`}
                x={ann.age}
                stroke={ann.color}
                strokeDasharray={ann.dashArray}
                strokeWidth={ann.strokeWidth}
                label={{
                  value: ann.label,
                  fill: ann.color,
                  fontSize: 10,
                  fontWeight: 500,
                  position: 'top',
                  dy: ann.dy,
                }}
              />
            ))}
            {/* Horizontal target line — REAL chart only. The FI number
                is fundamentally a real concept (constant purchasing
                power); in nominal terms the target slopes upward year
                over year, so a single horizontal line is misleading.
                The vertical FI-hit-age line still shows on both charts. */}
            {!isNominal && (
              <ReferenceLine
                yAxisId="balance"
                y={data.effective_fi_number}
                stroke="var(--accent-green)"
                strokeDasharray="4 4"
                label={{
                  value: `Retirement target: ${fmtRounded(data.effective_fi_number)}`,
                  fill: 'var(--accent-green)',
                  fontSize: 11,
                  position: 'insideTopLeft',
                }}
              />
            )}
            {/* Portfolio balance area — main blue curve. Spans both
                phases; the reference area above color-codes the
                withdrawal portion. */}
            <Area
              yAxisId="balance"
              type="monotone"
              dataKey="balance"
              stroke="var(--accent-blue)"
              strokeWidth={2}
              fill="var(--accent-blue)"
              fillOpacity={0.15}
              name="Portfolio balance"
            />
            {/* Active fixed-income bars — green. Visible in BOTH
                phases so the user can see exactly when each spouse's
                pension/SS first pays. During accumulation these are
                informational (the household is receiving the income
                but it's not flowing into the portfolio); during
                withdrawal they directly offset the portfolio draw. */}
            <Bar
              yAxisId="draw"
              dataKey="income_streams"
              fill="var(--accent-green)"
              fillOpacity={0.45}
              name="Active fixed income"
              barSize={6}
            />
            {/* Stacked yearly portfolio draw bars by tax bucket.
                Order matters: taxable on the bottom (drawn first
                during bridge years to capture 0% LTCG bracket),
                tax-deferred on top of that (kicks in once taxable
                runs out, ordinary-income tax rate), Roth at the
                very top (last resort, tax-free). Visually: bridge
                years should be all yellow (taxable), shifting to
                orange (tax-deferred) once taxable depletes, then
                brown (Roth) only if you live long enough. */}
            <Bar
              yAxisId="draw"
              dataKey="draw_taxable"
              stackId="draw"
              fill="#fbbf24"
              fillOpacity={0.7}
              name="Draw: taxable"
              barSize={6}
            />
            <Bar
              yAxisId="draw"
              dataKey="draw_tax_deferred"
              stackId="draw"
              fill="var(--accent-orange)"
              fillOpacity={0.7}
              name="Draw: tax-deferred"
              barSize={6}
            />
            <Bar
              yAxisId="draw"
              dataKey="draw_roth"
              stackId="draw"
              fill="#92400e"
              fillOpacity={0.7}
              name="Draw: Roth"
              barSize={6}
            />
          </ComposedChart>
        </ResponsiveContainer>

        {/* Inline legend explaining the chart marks. Recharts' built-in
            <Legend> doesn't capture ReferenceLine annotations, so this
            is hand-rolled to make the green markings as readable as
            the blue projection curve. */}
        <div style={{
          display: 'flex',
          gap: 18,
          flexWrap: 'wrap',
          marginTop: 4,
          fontSize: 11,
          color: 'var(--text-muted)',
        }}>
          <LegendItem
            color="var(--accent-blue)"
            label="Portfolio balance"
            description="compound growth on investable assets (left axis)"
          />
          <LegendItem
            color="var(--accent-green)"
            label="Active fixed income / yr"
            description="pension + SS flowing in (right axis) — visible in both phases"
          />
          <LegendItem
            color="#fbbf24"
            label="Draw: taxable"
            description="drawn first — LTCG rate (often 0% in bridge years)"
          />
          <LegendItem
            color="var(--accent-orange)"
            label="Draw: tax-deferred"
            description="drawn second — ordinary income tax + 10% if pre-59½"
          />
          <LegendItem
            color="#92400e"
            label="Draw: Roth"
            description="drawn last — tax-free, preserves for heirs / late retirement"
          />
          <LegendItem
            color="var(--accent-orange)"
            faded
            label="Withdrawal phase"
            description="orange-shaded zone after last spouse retires"
          />
          <LegendItem
            color="var(--accent-green)"
            dashed
            label="Retirement target"
            description={
              data.effective_fi_number !== data.fi_number
                ? `${fmtRounded(data.effective_fi_number)} portfolio (after pension/SS reduce ${fmtRounded(data.fi_number)} gross target)`
                : `${fmtRounded(data.fi_number)} = retirement income ÷ withdrawal rate`
            }
          />
          {data.fi_hit_age != null && (
            <LegendItem
              color="var(--accent-green)"
              dashed
              vertical
              label={`FI @ ${data.fi_hit_age}`}
              description="year projected balance crosses the target"
            />
          )}
          <LegendItem
            color="var(--text-secondary)"
            dashed
            vertical
            label={`Withdrawals @ ${lastRetireAge}`}
            description="last spouse retires; contributions stop, conservative rate kicks in"
          />
          {incomeOnsets.length > 0 && (
            <LegendItem
              color="var(--accent-blue)"
              dashed
              vertical
              label="Pension / SS onsets"
              description="each stream marked at its claim age (e.g. SS·You @67)"
            />
          )}
          {depletedAge != null && (
            <LegendItem
              color="var(--accent-red)"
              dashed
              vertical
              label={`$0 @ ${depletedAge}`}
              description="age at which portfolio is fully drawn down"
            />
          )}
        </div>
        </div>
          )
        }
        // Fan chart for Monte Carlo: if MC results are present,
        // render a stacked fan showing 10th/25th/50th/75th/90th
        // percentile balance bands across all simulated paths. Lets
        // the user see distribution rather than single-point estimates.
        const mcRows = data.monte_carlo?.year_by_year_pct
        const renderFanChart = () => {
          if (!mcRows || mcRows.length === 0) return null
          // Recharts can render an Area as a "ranged" band when
          // dataKey returns a [low, high] pair. We compute two bands:
          // the wide 10-90 (lighter) and the narrow 25-75 (darker).
          const fanData = [
            { year: 0, age: data.inputs.current_age,
              band_10_90: [data.current_assets, data.current_assets],
              band_25_75: [data.current_assets, data.current_assets],
              p50: data.current_assets },
            ...mcRows.map(r => ({
              year: r.year, age: r.age,
              band_10_90: [r.balance_p10, r.balance_p90],
              band_25_75: [r.balance_p25, r.balance_p75],
              p50: r.balance_p50,
            })),
          ]
          return (
            <div style={{
              marginBottom: 24, paddingTop: 20,
              borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 16,
            }}>
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                  <span style={{
                    display: 'inline-block', padding: '4px 10px',
                    background: 'rgba(52,211,153,0.15)', color: 'var(--accent-green)',
                    borderRadius: 4, fontSize: 11, fontWeight: 700,
                    textTransform: 'uppercase', letterSpacing: 0.6,
                  }}>
                    Monte Carlo
                  </span>
                  <span style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-primary)' }}>
                    Probability fan ({data.monte_carlo.n_runs} runs)
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>
                  Each year's band shows where balances fall across {data.monte_carlo.n_runs}{' '}
                  random return paths. Inner band = 25th–75th percentile (half of simulated
                  futures). Outer band = 10th–90th. Solid line = median outcome.
                </div>
              </div>
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={fanData} margin={{ top: 30, right: 30, left: 5, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="age" tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                    label={{ value: 'Age', position: 'insideBottom', offset: -5,
                             fill: 'var(--text-muted)', fontSize: 11 }} />
                  <YAxis
                    tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                    tickFormatter={v => `$${(v / 1_000_000).toFixed(1)}M`}
                  />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }}
                    formatter={(v) => Array.isArray(v) ? `${fmtRounded(v[0])} – ${fmtRounded(v[1])}` : fmtRounded(v)}
                    labelFormatter={(age) => `Age ${age}`}
                  />
                  <Area type="monotone" dataKey="band_10_90"
                    fill="var(--accent-green)" fillOpacity={0.10}
                    stroke="none" name="10–90 pct" />
                  <Area type="monotone" dataKey="band_25_75"
                    fill="var(--accent-green)" fillOpacity={0.20}
                    stroke="none" name="25–75 pct" />
                  <Line type="monotone" dataKey="p50"
                    stroke="var(--accent-green)" strokeWidth={2}
                    dot={false} name="Median (50 pct)" />
                  <ReferenceLine x={lastRetireAge}
                    stroke="var(--text-secondary)" strokeDasharray="3 3"
                    strokeWidth={1.5}
                    label={{ value: `Withdrawals @${lastRetireAge}`,
                             fill: 'var(--text-secondary)', fontSize: 11,
                             position: 'top' }} />
                </ComposedChart>
              </ResponsiveContainer>
              <div style={{
                marginTop: 4, fontSize: 11, color: 'var(--text-muted)',
                display: 'flex', gap: 18, flexWrap: 'wrap',
              }}>
                <LegendItem color="var(--accent-green)" label="Median balance"
                  description="50th percentile path" />
                <LegendItem color="var(--accent-green)" faded label="25–75 pct band"
                  description="middle 50% of simulated futures" />
                <LegendItem color="var(--accent-green)" faded label="10–90 pct band"
                  description="80% of simulated futures fall here" />
              </div>
            </div>
          )
        }

        return (
          <>
            {renderChart(chartData, 'real')}
            {renderChart(nominalChartData, 'nominal')}
            {renderFanChart()}
          </>
        )
      })()}

      {/* Sensitivity at three return rates */}
      <div>
        <div style={{
          fontSize: 12, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8,
        }}>
          Sensitivity
        </div>
        <div className="table-wrapper">
          <table style={{ fontSize: 13 }}>
            <thead>
              <tr>
                <th>Return rate</th>
                <th style={{ textAlign: 'right' }}>Projected balance</th>
                <th style={{ textAlign: 'right' }}>Sustainable income</th>
                <th style={{ textAlign: 'right' }}>vs FI number</th>
              </tr>
            </thead>
            <tbody>
              {data.sensitivity.map(s => {
                const surplus = s.gap >= 0
                return (
                  <tr key={s.return_rate}>
                    <td>{(s.return_rate * 100).toFixed(0)}%</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {fmtRounded(s.projected_balance)}
                    </td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                      {fmtRounded(s.sustainable_income)}/yr
                    </td>
                    <td style={{
                      textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                      color: surplus ? 'var(--accent-green)' : 'var(--accent-red)',
                    }}>
                      {surplus ? '+' : ''}{fmtRounded(s.gap)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Disclosure: assumptions + caveats */}
      <div style={{
        marginTop: 14, padding: '10px 12px',
        background: 'rgba(96,165,250,0.06)',
        border: '1px solid rgba(96,165,250,0.2)',
        borderRadius: 8,
        fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5,
      }}>
        <strong style={{ color: 'var(--text-primary)' }}>What this assumes:</strong>{' '}
        Real (inflation-adjusted) returns, end-of-year contributions,
        constant contribution rate. Two-phase simulation: contributions
        run from today until <em>whichever spouse retires last</em>, then
        portfolio enters drawdown. Returns also switch at that boundary —
        the working rate (default 6% real, growth-oriented) gives way to
        the retirement rate (default 1.5% real, CD/bond capital preservation). Each year of drawdown, active income
        streams (pension + each SS, COLA-adjusted) are subtracted from
        desired income, and the portfolio funds the remainder. Streams
        activate when the holder's age reaches their start age.
        Investable assets = sum of investment-type accounts only —
        checking, savings, and home equity are excluded since they don't
        grow at market rates and you don't withdraw from them at 4%/yr.
        Auto-detected contribution misses 401(k) payroll deductions
        (those don't traverse a bank Plaid sees) so it's a floor — enter
        the real number for an accurate projection.
        Pension/SS annuals are in TODAY'S dollars at claim age (you enter
        what the stream pays in today's purchasing-power terms). After claim,
        the COLA you enter is treated as NOMINAL — the simulator subtracts
        your inflation rate to get REAL growth. Examples: SS at 2.5% nominal
        COLA + 2.5% inflation = 0% real (just keeps pace). Pension at 0%
        nominal COLA = -2.5% real (eroded by inflation each year).
        Lifetime PV assumes a 30-year payout starting at the stream start age,
        discounted at the chosen real return rate. Survivor benefits and
        lump-sum options are not modeled.
        After-tax math: per-bucket draw simulation, year by year. Withdrawal
        order is taxable → tax-deferred → Roth (FIRE-standard for tax efficiency).
        Taxable draws taxed at LTCG; tax-deferred at ordinary income (+10% IRS
        penalty if pulled before age 60); Roth tax-free. Accumulation
        contribution flows entirely into tax-deferred. Hover any year on the
        chart for the bucket-by-bucket draw breakdown.
        <br/><br/>
        <strong style={{ color: 'var(--text-primary)' }}>New in v3:</strong>{' '}
        Pre-Medicare healthcare bridge (added to spending while either spouse {'<'} 65),
        tapered contribution (drops to "Contrib after 1st retire" once one spouse retires),
        spending phases (go-go / slow-go / no-go multipliers around the user's
        thresholds), RMDs (forced tax-deferred draws starting at 73 using the
        IRS Uniform Lifetime Table; excess shifts to taxable bucket).
        <br/><br/>
        Doesn't model: MI's partial public-pension exemption, per-share
        cost-basis tracking, 0% LTCG bracket optimization, 457-no-penalty
        carve-out, Roth conversions, sequence-of-returns risk, survivor
        benefits, or surplus income reinvestment when fixed-income exceeds
        desired (surplus stays in portfolio compounding).
      </div>
    </>
  )
}
