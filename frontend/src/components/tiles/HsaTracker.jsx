import { useEffect, useState } from 'react'
import { Heart, Settings } from 'lucide-react'
import { getHsaStatus } from '../../api/client'
import { SkeletonCard } from '../Skeleton'
import { useStoredState } from '../../lib/storage'
import { formatCurrencyZero as fmtFull } from '../../lib/format'
import { tileCardStyle, PAYCHECKS_PER_YEAR, hsaInputStyle } from './shared'

const HSA_CONFIG_KEY = 'tuskledger.hsaConfig.v1'
// Default combined federal + state marginal rate. Set to a moderate
// midpoint that's typical for many households (e.g. ~22% federal plus
// a low single-digit state rate). User can override per-account.
const DEFAULT_MARGINAL_RATE = 0.2625

function computePayrollYtd(cfg, today = new Date()) {
  const ppy = PAYCHECKS_PER_YEAR[cfg.pay_frequency] || 26
  const perCheck = Number(cfg.per_paycheck_amount) || 0
  if (!perCheck) return { elapsedPaychecks: 0, remainingPaychecks: 0, ytd: 0, projectedEoy: 0 }
  const yearStart = new Date(today.getFullYear(), 0, 1, 12)
  const yearEnd = new Date(today.getFullYear(), 11, 31, 12)
  const start = cfg.payroll_start_date
    ? new Date(cfg.payroll_start_date + 'T12:00:00')
    : yearStart
  const day = (a, b) => Math.max(0, Math.floor((b - a) / (1000 * 60 * 60 * 24)))
  // Proportion of year elapsed since payroll started.
  const elapsedDays = day(start, today)
  const totalEligibleDays = Math.max(1, day(start, yearEnd))
  const elapsedFrac = Math.min(1, elapsedDays / 365)
  const remainingFrac = Math.max(0, day(today, yearEnd) / 365)
  const elapsedPaychecks = Math.floor(elapsedFrac * ppy)
  const remainingPaychecks = Math.ceil(remainingFrac * ppy)
  return {
    elapsedPaychecks,
    remainingPaychecks,
    ytd: elapsedPaychecks * perCheck,
    projectedEoy: (elapsedPaychecks + remainingPaychecks) * perCheck,
  }
}

function HsaField({ label, children, full }) {
  return (
    <label style={{
      display: 'flex', flexDirection: 'column', gap: 2,
      gridColumn: full ? '1 / -1' : undefined,
    }}>
      <span style={{
        fontSize: 9, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: 0.4,
      }}>{label}</span>
      {children}
    </label>
  )
}

/**
 * HsaTracker — surfaces remaining HSA contribution headroom for the
 * current tax year, with dollarized tax savings and an April-15
 * deadline countdown.
 *
 * A common miss for households on a family HDHP: the employer
 * contributes only a portion of the limit and the personal-side gap
 * sits unfunded all year — leaving real federal + state tax savings
 * unclaimed. This tile makes that gap visible year-round instead of
 * surfacing it only at April-14.
 *
 * Two tracking modes:
 *   1. 'manual'  — user enters YTD personal contribution as a number.
 *                  Snapshot value, must be updated whenever they want
 *                  to see fresh numbers.
 *   2. 'payroll' — user enters per-paycheck amount + frequency + start
 *                  date; tile computes YTD live and projects end-of-year.
 *                  Best for the common case where contributions are a
 *                  fixed payroll deduction. Surfaces a "to max, bump
 *                  per-paycheck to $X or add $Y lump sum" recommendation
 *                  when projected EOY falls short of the cap.
 *
 * Data model: backend returns IRS limits + the list of HSA accounts.
 * Per-account YTD contributions (employer + personal) and coverage
 * type live in localStorage — they don't change often enough to merit
 * a DB table, and not all HSA balance growth is contribution (there's
 * investment return too).
 *
 * Storage key: tuskledger.hsaConfig.v1 = {
 *   [accountId]: {
 *     coverage, holder_age, marginal_tax_rate, employer_ytd,
 *     tracking_mode,           // 'manual' (default) | 'payroll'
 *     personal_ytd,            // manual mode only
 *     per_paycheck_amount,     // payroll mode
 *     pay_frequency,           // payroll mode: weekly | biweekly | semimonthly | monthly
 *     payroll_start_date,      // payroll mode: ISO date of first paycheck of the year
 *   }
 * }
 */
export function HsaTracker() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [config, setConfig] = useStoredState(HSA_CONFIG_KEY, {})
  const [editingId, setEditingId] = useState(null)

  useEffect(() => {
    getHsaStatus().then(d => { setData(d); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  if (loading) return <SkeletonCard titleWidth="40%" rows={4} />
  if (!data || !data.accounts || data.accounts.length === 0) {
    // No HSAs detected — silently hide rather than nag. Tile only
    // appears for users who actually have an HSA configured.
    return null
  }

  // Per-account derived values. The personal-YTD value depends on
  // tracking_mode: in 'manual' it's whatever the user typed; in
  // 'payroll' it's computed from the per-paycheck amount × elapsed
  // paychecks. Projected EOY only meaningful in payroll mode.
  const accounts = data.accounts.map(a => {
    const cfg = config[a.id] || {}
    const coverage = cfg.coverage || 'family'
    const limitKey = `${coverage}${cfg.holder_age >= 55 ? '_55_plus' : ''}`
    const limit = data.limits[limitKey] || data.limits[coverage]
    const employer = Number(cfg.employer_ytd) || 0
    const trackingMode = cfg.tracking_mode || 'manual'

    let personal = 0
    let projection = null
    if (trackingMode === 'payroll') {
      projection = computePayrollYtd(cfg)
      personal = projection.ytd
    } else {
      personal = Number(cfg.personal_ytd) || 0
    }

    const contributed = employer + personal
    const remaining = Math.max(0, limit - contributed)
    const rate = Number(cfg.marginal_tax_rate) || DEFAULT_MARGINAL_RATE
    const taxSavingsIfMaxed = remaining * rate

    // "To max" recommendation — only meaningful in payroll mode where
    // we can project EOY. Compute the gap between projected total and
    // the cap, then express it as both a per-paycheck bump and a one-
    // time lump-sum option. Pre-deadline contributions can be either.
    let recommendation = null
    if (projection && projection.remainingPaychecks > 0) {
      const projectedTotal = employer + projection.projectedEoy
      const gap = limit - projectedTotal
      if (gap > 1) {
        recommendation = {
          gap,
          perPaycheckBump: gap / projection.remainingPaychecks,
          newPerPaycheck: (Number(cfg.per_paycheck_amount) || 0) + (gap / projection.remainingPaychecks),
          lumpSum: gap,
        }
      } else if (gap < -1) {
        recommendation = { overshoot: -gap }
      }
    }

    return {
      ...a, coverage, limit, employer, personal, contributed, remaining,
      taxSavingsIfMaxed, rate, trackingMode, projection, recommendation,
    }
  })

  // Roll up across all HSAs in the household.
  const totalRemaining = accounts.reduce((s, a) => s + a.remaining, 0)
  const totalSavings = accounts.reduce((s, a) => s + a.taxSavingsIfMaxed, 0)

  const updateConfig = (accountId, patch) => {
    setConfig(prev => ({ ...prev, [accountId]: { ...(prev[accountId] || {}), ...patch } }))
  }

  return (
    <div className="card" style={tileCardStyle}>
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Heart size={14} style={{ color: 'var(--accent-green)' }} /> HSA headroom
        </span>
        <span style={{
          fontSize: 10, color: 'var(--text-muted)',
          padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 10,
        }}>
          {data.year} · {data.days_remaining}d to file
        </span>
      </div>

      {/* Hero rollup — always visible, summarizes across all HSAs */}
      {totalRemaining > 0 ? (
        <div style={{
          padding: '10px 12px', marginBottom: 10,
          background: 'rgba(52,211,153,0.08)',
          border: '1px solid rgba(52,211,153,0.25)',
          borderRadius: 6,
        }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Tax savings if maxed by {new Date(data.deadline + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </div>
          <div style={{
            fontSize: 22, fontWeight: 700, color: 'var(--accent-green)',
            fontVariantNumeric: 'tabular-nums', marginTop: 2,
          }}>
            ~{fmtFull(totalSavings)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
            Contribute {fmtFull(totalRemaining)} more across {accounts.length} HSA{accounts.length === 1 ? '' : 's'}
          </div>
        </div>
      ) : (
        <div style={{
          padding: '10px 12px', marginBottom: 10,
          background: 'rgba(96,165,250,0.08)',
          border: '1px solid rgba(96,165,250,0.25)',
          borderRadius: 6,
          fontSize: 12, color: 'var(--text-secondary)',
        }}>
          ✓ All HSAs maxed for {data.year}.
        </div>
      )}

      {/* Per-account progress bars + edit-in-place */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
        {accounts.map(a => {
          const pct = Math.min(100, (a.contributed / a.limit) * 100)
          const isEditing = editingId === a.id
          return (
            <div key={a.id}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                fontSize: 12, marginBottom: 4,
              }}>
                <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                  {a.name}
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>
                    · {a.coverage}
                  </span>
                </span>
                <button
                  onClick={() => setEditingId(isEditing ? null : a.id)}
                  title="Edit HSA configuration"
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--text-muted)', padding: 2, display: 'inline-flex',
                  }}
                >
                  <Settings size={12} />
                </button>
              </div>

              {/* Progress bar — segmented to show employer vs personal */}
              <div style={{
                height: 8, background: 'var(--bg-elevated, rgba(255,255,255,0.06))',
                borderRadius: 4, overflow: 'hidden', display: 'flex',
              }}>
                {a.employer > 0 && (
                  <div
                    title={`Employer: ${fmtFull(a.employer)}`}
                    style={{
                      width: `${(a.employer / a.limit) * 100}%`,
                      background: 'var(--accent-blue)',
                      transition: 'width 200ms',
                    }}
                  />
                )}
                {a.personal > 0 && (
                  <div
                    title={`Personal: ${fmtFull(a.personal)}`}
                    style={{
                      width: `${(a.personal / a.limit) * 100}%`,
                      background: 'var(--accent-green)',
                      transition: 'width 200ms',
                    }}
                  />
                )}
              </div>

              <div style={{
                fontSize: 11, color: 'var(--text-muted)', marginTop: 3,
                display: 'flex', justifyContent: 'space-between',
              }}>
                <span>
                  {fmtFull(a.contributed)} of {fmtFull(a.limit)}
                </span>
                <span style={{
                  color: a.remaining > 0 ? 'var(--accent-yellow)' : 'var(--accent-green)',
                }}>
                  {a.remaining > 0
                    ? `${fmtFull(a.remaining)} left`
                    : '✓ maxed'}
                </span>
              </div>

              {/* Payroll-mode projection + recommendation. Only renders
                  when tracking_mode='payroll' and the user is on pace
                  to either fall short or overshoot. The actionable
                  recommendation is the value-add of payroll mode. */}
              {a.projection && a.recommendation?.gap > 1 && (
                <div style={{
                  marginTop: 6, padding: '6px 8px',
                  background: 'rgba(251,191,36,0.08)',
                  border: '1px solid rgba(251,191,36,0.25)',
                  borderRadius: 4, fontSize: 11,
                  color: 'var(--text-secondary)',
                }}>
                  <div style={{ marginBottom: 2 }}>
                    On pace for <strong>{fmtFull(a.employer + a.projection.projectedEoy)}</strong>
                    {' '}by year-end ({a.projection.remainingPaychecks} paychecks left).
                    Short by <strong style={{ color: 'var(--accent-yellow)' }}>{fmtFull(a.recommendation.gap)}</strong>.
                  </div>
                  <div>
                    To max: bump per-paycheck to{' '}
                    <strong style={{ color: 'var(--accent-green)' }}>
                      {fmtFull(a.recommendation.newPerPaycheck)}
                    </strong>{' '}
                    (+{fmtFull(a.recommendation.perPaycheckBump)}), or add a one-time{' '}
                    <strong style={{ color: 'var(--accent-green)' }}>
                      {fmtFull(a.recommendation.lumpSum)}
                    </strong>{' '}
                    by Apr 15.
                  </div>
                </div>
              )}
              {a.projection && a.recommendation?.overshoot > 1 && (
                <div style={{
                  marginTop: 6, padding: '6px 8px',
                  background: 'rgba(248,113,113,0.08)',
                  border: '1px solid rgba(248,113,113,0.25)',
                  borderRadius: 4, fontSize: 11,
                  color: 'var(--text-secondary)',
                }}>
                  ⚠ On pace to overshoot the cap by <strong style={{ color: 'var(--accent-red)' }}>
                  {fmtFull(a.recommendation.overshoot)}</strong>.
                  Lower per-paycheck or excess will be taxed + 6% excise penalty.
                </div>
              )}

              {/* Inline editor — fields adapt to tracking_mode. Manual
                  mode collects a single YTD number; payroll mode collects
                  per-paycheck amount + frequency + start date and
                  computes YTD live. */}
              {isEditing && (
                <div style={{
                  marginTop: 8, padding: 8,
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6,
                  fontSize: 11,
                }}>
                  <HsaField label="Coverage">
                    <select
                      value={a.coverage}
                      onChange={e => updateConfig(a.id, { coverage: e.target.value })}
                      style={hsaInputStyle}
                    >
                      <option value="family">Family</option>
                      <option value="self">Self only</option>
                    </select>
                  </HsaField>
                  <HsaField label="Holder age (for 55+ catch-up)">
                    <input
                      type="number"
                      value={config[a.id]?.holder_age || ''}
                      onChange={e => updateConfig(a.id, { holder_age: Number(e.target.value) || 0 })}
                      placeholder="e.g. 38"
                      style={hsaInputStyle}
                    />
                  </HsaField>
                  <HsaField label="Employer YTD contribution">
                    <input
                      type="number"
                      value={config[a.id]?.employer_ytd || ''}
                      onChange={e => updateConfig(a.id, { employer_ytd: Number(e.target.value) || 0 })}
                      placeholder="from W-2 box 12 code W"
                      style={hsaInputStyle}
                    />
                  </HsaField>
                  <HsaField label="Marginal tax rate" >
                    <input
                      type="number"
                      step="0.01"
                      value={config[a.id]?.marginal_tax_rate || ''}
                      onChange={e => updateConfig(a.id, { marginal_tax_rate: Number(e.target.value) || 0 })}
                      placeholder="0.2625 = 22% fed + ~4% state"
                      style={hsaInputStyle}
                    />
                  </HsaField>

                  {/* Tracking mode toggle — spans full width */}
                  <HsaField label="Personal contribution tracking" full>
                    <select
                      value={a.trackingMode}
                      onChange={e => updateConfig(a.id, { tracking_mode: e.target.value })}
                      style={hsaInputStyle}
                    >
                      <option value="manual">Manual snapshot (enter YTD)</option>
                      <option value="payroll">Payroll deduction (auto-track)</option>
                    </select>
                  </HsaField>

                  {a.trackingMode === 'payroll' ? (
                    <>
                      <HsaField label="Per-paycheck amount">
                        <input
                          type="number"
                          step="0.01"
                          value={config[a.id]?.per_paycheck_amount || ''}
                          onChange={e => updateConfig(a.id, { per_paycheck_amount: Number(e.target.value) || 0 })}
                          placeholder="e.g. 171.66"
                          style={hsaInputStyle}
                        />
                      </HsaField>
                      <HsaField label="Pay frequency">
                        <select
                          value={config[a.id]?.pay_frequency || 'biweekly'}
                          onChange={e => updateConfig(a.id, { pay_frequency: e.target.value })}
                          style={hsaInputStyle}
                        >
                          <option value="weekly">Weekly (52/yr)</option>
                          <option value="biweekly">Bi-weekly (26/yr)</option>
                          <option value="semimonthly">Semi-monthly (24/yr)</option>
                          <option value="monthly">Monthly (12/yr)</option>
                        </select>
                      </HsaField>
                      <HsaField label="First paycheck of year (date)" full>
                        <input
                          type="date"
                          value={config[a.id]?.payroll_start_date || ''}
                          onChange={e => updateConfig(a.id, { payroll_start_date: e.target.value })}
                          style={hsaInputStyle}
                        />
                      </HsaField>
                      {a.projection && (
                        <div style={{
                          gridColumn: '1 / -1', padding: 6,
                          background: 'rgba(96,165,250,0.06)',
                          border: '1px dashed rgba(96,165,250,0.3)',
                          borderRadius: 3, fontSize: 10,
                          color: 'var(--text-muted)',
                        }}>
                          Computed YTD: <strong style={{ color: 'var(--text-primary)' }}>
                          {fmtFull(a.projection.ytd)}</strong>
                          {' '}({a.projection.elapsedPaychecks} paychecks elapsed,{' '}
                          {a.projection.remainingPaychecks} remaining → projected EOY{' '}
                          <strong style={{ color: 'var(--text-primary)' }}>
                          {fmtFull(a.projection.projectedEoy)}</strong>)
                        </div>
                      )}
                    </>
                  ) : (
                    <HsaField label="Personal YTD contribution" full>
                      <input
                        type="number"
                        value={config[a.id]?.personal_ytd || ''}
                        onChange={e => updateConfig(a.id, { personal_ytd: Number(e.target.value) || 0 })}
                        placeholder="0"
                        style={hsaInputStyle}
                      />
                    </HsaField>
                  )}

                  <button
                    onClick={() => setEditingId(null)}
                    style={{
                      gridColumn: '1 / -1',
                      padding: '4px', fontSize: 11,
                      background: 'var(--accent-blue)', color: '#0d0e14',
                      border: 'none', borderRadius: 3, cursor: 'pointer',
                    }}
                  >
                    Done
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
