import { useEffect, useState, useMemo } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts'
import { Loader2, AlertCircle, Home, Car, GraduationCap, CreditCard, RefreshCw, Calendar, Shield, Zap } from 'lucide-react'
import {
  getLoans, getLoanAmortization,
  getLoanBiweekly, getLoanRefinance, getLoanPmiDropoff,
  getLoanHeloc,
} from '../api/client'
import { useLatestRequest } from '../hooks/useLatestRequest'

/**
 * Loans page — amortization timeline + extra-payment what-if calculator
 * for every loan-type account in the system.
 *
 * UX flow:
 *   1. Sidebar lists all loans, sorted by balance, with a quick "X mo
 *      remaining" badge.
 *   2. Click a loan → detail panel shows the amortization view.
 *   3. Slider drags extra principal up and down → schedule re-renders
 *      live (debounced fetch).
 *   4. Summary tiles at the top show payoff date, lifetime interest,
 *      months saved, total interest saved.
 *
 * For loans without MortgageDetail (auto, manual liability) the user
 * provides rate + payment via inline override fields. State persists
 * to localStorage per loan so they don't have to re-enter every visit.
 */
const OVERRIDES_KEY = 'tuskledger.loanOverrides.v1'

// 0-decimal formatter for loan tiles — whole dollars read better in amortization context
function fmtRounded(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(n || 0)
}

function loadOverrides() {
  try { return JSON.parse(localStorage.getItem(OVERRIDES_KEY) || '{}') }
  catch { return {} }
}
function saveOverrides(o) {
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(o))
}

// Exported for unit tests (also used internally below).
export function iconFor(subtype) {
  if (subtype === 'mortgage') return Home
  if (subtype === 'auto') return Car
  if (subtype === 'student') return GraduationCap
  if (isHelocSubtype(subtype)) return Zap
  return CreditCard
}

// HELOCs come back from Plaid with various subtype labels. Treat any
// "home equity" / "heloc" / "line of credit (home)" string as a HELOC.
// Exported for unit tests + reuse by panels that need to detect HELOCs.
export function isHelocSubtype(subtype) {
  if (!subtype) return false
  const s = String(subtype).toLowerCase()
  return s === 'heloc' || s.includes('home equity') || s.includes('line of credit')
}

export default function Loans() {
  const [loans, setLoans] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState(null)
  const [overrides, setOverrides] = useState(loadOverrides)

  useEffect(() => {
    getLoans()
      .then(d => {
        setLoans(d.loans || [])
        if (d.loans && d.loans.length > 0 && !selectedId) {
          setSelectedId(d.loans[0].id)
        }
      })
      .finally(() => setLoading(false))
  }, [])

  const setOverride = (loanId, key, value) => {
    const next = { ...overrides, [loanId]: { ...overrides[loanId], [key]: value } }
    setOverrides(next)
    saveOverrides(next)
  }

  if (loading) {
    return (
      <div style={{ padding: 20, color: 'var(--text-muted)' }}>
        <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading loans…
      </div>
    )
  }

  if (loans.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
        <h2 style={{ color: 'var(--text-primary)' }}>No loans found</h2>
        <p>Once you have a loan-type account (mortgage, auto, student) — synced via Plaid or added as a manual liability — it shows up here with full amortization tools.</p>
      </div>
    )
  }

  return (
    <div style={{ padding: 16 }}>
      <h1 style={{ marginTop: 0, fontSize: 22, fontWeight: 600 }}>Loans</h1>
      <p style={{ color: 'var(--text-muted)', marginTop: -8, fontSize: 13 }}>
        Amortization schedules and extra-payment what-ifs for each loan.
      </p>

      {/* Multi-loan stacked timeline — only meaningful with 2+ loans
          that have computable schedules. Each loan with rate+payment
          contributes a balance trajectory; user can see which one
          frees up cashflow first. */}
      {loans.filter(l => l.months_remaining).length >= 2 && (
        <MultiLoanTimeline loans={loans} overrides={overrides} />
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: '280px 1fr',
        gap: 16,
        marginTop: 16,
      }}>
        {/* Loan list — left rail */}
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          {loans.map(loan => {
            const Icon = iconFor(loan.subtype)
            const selected = loan.id === selectedId
            return (
              <button
                key={loan.id}
                onClick={() => setSelectedId(loan.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 12px',
                  background: selected ? 'var(--accent-blue-bg)' : 'var(--bg-card)',
                  border: `1px solid ${selected ? 'var(--accent-blue-border)' : 'var(--border-color, rgba(255,255,255,0.08))'}`,
                  borderRadius: 8,
                  cursor: 'pointer',
                  textAlign: 'left',
                  color: 'var(--text-primary)',
                }}
              >
                <Icon size={18} style={{ color: 'var(--accent-blue)' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{loan.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {fmtRounded(loan.balance)}
                    {loan.months_remaining != null && ` · ${loan.months_remaining} mo left`}
                  </div>
                </div>
              </button>
            )
          })}
        </div>

        {/* Detail panel — right */}
        {selectedId && (
          <LoanDetail
            key={selectedId}
            loan={loans.find(l => l.id === selectedId)}
            override={overrides[selectedId] || {}}
            setOverride={(k, v) => setOverride(selectedId, k, v)}
          />
        )}
      </div>
    </div>
  )
}


function LoanDetail({ loan, override, setOverride }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [extraPrincipal, setExtraPrincipal] = useState(0)
  const runAmort = useLatestRequest()

  // Fetch debounced when extra changes.
  useEffect(() => {
    setLoading(true)
    setError(null)
    const params = { extra_principal: extraPrincipal }
    if (override.rate) params.rate_override = override.rate
    if (override.payment) params.payment_override = override.payment
    // The debounce cleared the *timer* on rapid slider drags, but a
    // request already dispatched would still resolve and clobber the
    // current schedule. Guard the resolution with a liveness token.
    return runAmort(token => {
      const t = setTimeout(() => {
        getLoanAmortization(loan.id, params)
          .then(d => { if (token.live) setData(d) })
          .catch(e => { if (token.live) setError(e.message || 'Failed to load amortization') })
          .finally(() => { if (token.live) setLoading(false) })
      }, 250)
      return () => clearTimeout(t)
    })
  }, [loan.id, extraPrincipal, override.rate, override.payment])

  // Build chart data — sample to <= 360 points so 50-yr loans don't
  // murder Recharts. For shorter schedules, every month.
  const chartData = useMemo(() => {
    if (!data?.schedule) return []
    const rows = data.schedule
    const stride = Math.max(1, Math.floor(rows.length / 360))
    return rows.filter((_, i) => i % stride === 0).map(r => ({
      month: r.month,
      year: Math.floor(r.month / 12) + new Date().getFullYear(),
      balance: r.ending_balance,
      principal: r.principal,
      interest: r.interest,
    }))
  }, [data])

  const needsOverrides = error && error.includes('rate_override')

  return (
    <div style={{
      padding: 16,
      background: 'var(--bg-card)',
      border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
      borderRadius: 8,
      minHeight: 400,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{loan.name}</h2>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            Balance: {fmtRounded(loan.balance)}
            {loan.interest_rate != null && ` · Rate ${(loan.interest_rate * 100).toFixed(3)}%`}
            {loan.monthly_payment != null && ` · P+I ${fmtRounded(loan.monthly_payment)}/mo`}
          </div>
        </div>
        {loan.has_pmi && (
          <span style={{
            fontSize: 10, padding: '3px 8px',
            background: 'var(--accent-yellow-bg)',
            color: 'var(--accent-yellow)',
            borderRadius: 10, fontWeight: 600,
          }}>
            PMI ACTIVE
          </span>
        )}
      </div>

      {/* Override inputs — shown when there's no MortgageDetail. */}
      {(!loan.has_mortgage_detail || needsOverrides) && (
        <div style={{
          padding: 10, marginBottom: 12,
          background: 'var(--accent-blue-bg)',
          border: '1px solid var(--accent-blue-border)',
          borderRadius: 6,
        }}>
          <div style={{
            fontSize: 11, color: 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6,
          }}>
            Loan terms (no Plaid data, enter manually)
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Annual rate %{' '}
              <input type="number" min={0} max={30} step={0.01}
                value={override.rate ? Math.round(override.rate * 10000) / 100 : ''}
                onChange={e => setOverride('rate', Number(e.target.value) / 100)}
                style={{
                  width: 80, padding: '4px 6px', fontSize: 12,
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
                  borderRadius: 4, color: 'var(--text-primary)',
                }}
                placeholder="6.875"
              />
            </label>
            <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Monthly P+I $/mo{' '}
              <input type="number" min={0} step={10}
                value={override.payment || ''}
                onChange={e => setOverride('payment', Number(e.target.value))}
                style={{
                  width: 100, padding: '4px 6px', fontSize: 12,
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
                  borderRadius: 4, color: 'var(--text-primary)',
                }}
                placeholder="1971"
              />
            </label>
          </div>
        </div>
      )}

      {error && !needsOverrides && (
        <div style={{
          padding: 10, marginBottom: 12, fontSize: 12,
          background: 'var(--accent-orange-bg)',
          color: 'var(--accent-orange)',
          border: '1px solid var(--accent-orange-border)',
          borderRadius: 6,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {data && (
        <>
          {/* Summary tiles */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 12, marginBottom: 16,
          }}>
            <SummaryTile label="Payoff date" value={data.summary.payoff_date || '—'}
              sub={`${data.summary.months} payments`} />
            <SummaryTile label="Total interest" value={fmtRounded(data.summary.total_interest)}
              sub="over remaining term" tone="warn" />
            <SummaryTile label="Total paid" value={fmtRounded(data.summary.total_paid)}
              sub={`principal ${fmtRounded(data.summary.total_principal)}`} />
            <SummaryTile label="Extra paid" value={fmtRounded(data.summary.total_extra_principal)}
              sub={extraPrincipal > 0 ? `${fmtRounded(extraPrincipal)}/mo extra` : 'none'} />
          </div>

          {/* Comparison block — only when extra > 0 */}
          {data.comparison && (
            <div style={{
              padding: '10px 12px', marginBottom: 16,
              background: 'var(--accent-green-bg)',
              border: '1px solid var(--accent-green-border)',
              borderLeft: '3px solid var(--accent-green)',
              borderRadius: 6,
              fontSize: 12,
            }}>
              <strong style={{ color: 'var(--accent-green)' }}>Extra payment impact: </strong>
              <span style={{ color: 'var(--text-primary)' }}>
                Saves <strong>{Math.floor(data.comparison.months_saved / 12)}y {data.comparison.months_saved % 12}mo</strong>
                {' '}and <strong>{fmtRounded(data.comparison.interest_saved)}</strong> in lifetime interest.
                Payoff jumps from {data.comparison.baseline.payoff_date} to {data.comparison.with_extra.payoff_date}.
              </span>
            </div>
          )}

          {/* Extra-payment slider */}
          <div style={{ marginBottom: 20 }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              fontSize: 12, color: 'var(--text-muted)', marginBottom: 6,
            }}>
              <label htmlFor="extra-slider">Extra principal per month</label>
              <strong style={{ color: 'var(--text-primary)', fontSize: 14 }}>
                {fmtRounded(extraPrincipal)}/mo
              </strong>
            </div>
            <input
              id="extra-slider"
              type="range" min={0} max={2500} step={25}
              value={extraPrincipal}
              onChange={e => setExtraPrincipal(Number(e.target.value))}
              style={{ width: '100%' }}
            />
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              fontSize: 10, color: 'var(--text-muted)', marginTop: 4,
            }}>
              <span>$0</span>
              <span>$1,250</span>
              <span>$2,500</span>
            </div>
          </div>

          {/* Balance trajectory chart */}
          <div style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 5, right: 16, bottom: 5, left: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color, rgba(255,255,255,0.08))" />
                <XAxis
                  dataKey="year"
                  stroke="var(--text-muted)"
                  fontSize={11}
                  type="number" domain={['dataMin', 'dataMax']}
                  tickFormatter={(y) => String(y)}
                />
                <YAxis
                  stroke="var(--text-muted)"
                  fontSize={11}
                  tickFormatter={(v) => `$${Math.round(v / 1000)}k`}
                />
                <Tooltip
                  formatter={(v) => fmtRounded(v)}
                  labelFormatter={(y) => `Year ${y}`}
                  contentStyle={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-color, rgba(255,255,255,0.15))',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                />
                <Area
                  type="monotone" dataKey="balance" name="Remaining balance"
                  stroke="var(--accent-blue)" fill="var(--accent-blue-bg)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {loading && (
        <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 12 }}>
          <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', marginRight: 6 }} />
          Recomputing schedule…
        </div>
      )}

      {/* Bi-weekly + Refinance + PMI + HELOC panels — all consume the
          same override (rate / payment) so they only render once we
          have enough info to compute. Each is self-contained and
          lazily fetches its own data. */}
      {data && (
        <>
          <BiweeklyPanel loan={loan} override={override} />
          <RefinancePanel loan={loan} override={override} />
          {/* PMI is mortgage-only; HELOCs aren't subject to PMI. */}
          {(loan.has_pmi || (loan.subtype === 'mortgage' && !isHelocSubtype(loan.subtype))) && (
            <PmiDropoffPanel loan={loan} override={override} />
          )}
          {isHelocSubtype(loan.subtype) && (
            <HelocPanel loan={loan} override={override} setOverride={setOverride} />
          )}
        </>
      )}
    </div>
  )
}


/* ─────────────────────────── Bi-weekly ─────────────────────────── */

function BiweeklyPanel({ loan, override }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    setLoading(true)
    const params = {}
    if (override.rate) params.rate_override = override.rate
    if (override.payment) params.payment_override = override.payment
    getLoanBiweekly(loan.id, params)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [loan.id, override.rate, override.payment])

  if (loading || !data) return null
  const yrs = Math.floor(data.months_saved / 12)
  const mos = data.months_saved % 12

  return (
    <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1px dashed var(--border-color, rgba(255,255,255,0.06))' }}>
      <div style={{
        fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
        textTransform: 'uppercase', color: 'var(--text-muted)',
        marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <Calendar size={12} /> Bi-weekly comparison
      </div>
      <div style={{
        padding: '12px 14px',
        background: 'var(--accent-green-bg)',
        border: '1px solid var(--accent-green-border)',
        borderLeft: '3px solid var(--accent-green)',
        borderRadius: 6, fontSize: 12, color: 'var(--text-primary)',
      }}>
        Pay <strong>{fmtRounded(data.biweekly_half_payment)}</strong> every 2 weeks
        instead of {fmtRounded(data.monthly_payment)}/mo and you'll{' '}
        <strong style={{ color: 'var(--accent-green)' }}>
          {data.months_saved > 0 ? `pay off ${yrs}y ${mos}mo earlier` : 'see no meaningful change'}
        </strong>
        {data.months_saved > 0 && (
          <> and save <strong style={{ color: 'var(--accent-green)' }}>{fmtRounded(data.interest_saved)}</strong> in lifetime interest.</>
        )}
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
          Mechanic: 26 half-payments/yr = 13 monthly equivalents. The 13th payment lands entirely on principal each year.
          Most banks support setting this up — call to enable, no fees.
        </div>
      </div>
    </div>
  )
}


/* ─────────────────────────── Refinance ─────────────────────────── */

function RefinancePanel({ loan, override }) {
  const [newRate, setNewRate] = useState('')
  const [newTerm, setNewTerm] = useState(360)
  const [closingCosts, setClosingCosts] = useState(8000)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!newRate) { setData(null); return }
    setLoading(true)
    setError(null)
    const params = {
      new_rate: Number(newRate) / 100,
      new_term_months: Number(newTerm),
      closing_costs: Number(closingCosts) || 0,
    }
    if (override.rate) params.rate_override = override.rate
    if (override.payment) params.payment_override = override.payment
    const t = setTimeout(() => {
      getLoanRefinance(loan.id, params)
        .then(setData)
        .catch(e => setError(e.message))
        .finally(() => setLoading(false))
    }, 250)
    return () => clearTimeout(t)
  }, [loan.id, newRate, newTerm, closingCosts, override.rate, override.payment])

  return (
    <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1px dashed var(--border-color, rgba(255,255,255,0.06))' }}>
      <div style={{
        fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
        textTransform: 'uppercase', color: 'var(--text-muted)',
        marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <RefreshCw size={12} /> Refinance modeler
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          New rate %{' '}
          <input type="number" min={0} max={30} step={0.01}
            value={newRate}
            onChange={e => setNewRate(e.target.value)}
            placeholder="5.50"
            style={refiInputStyle} />
        </label>
        <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          New term (months){' '}
          <input type="number" min={12} max={480} step={12}
            value={newTerm}
            onChange={e => setNewTerm(e.target.value)}
            style={refiInputStyle} />
        </label>
        <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Closing costs $${' '}
          <input type="number" min={0} step={500}
            value={closingCosts}
            onChange={e => setClosingCosts(e.target.value)}
            style={refiInputStyle} />
        </label>
      </div>
      {error && (
        <div style={{ fontSize: 11, color: 'var(--accent-orange)', marginBottom: 6 }}>{error}</div>
      )}
      {data && (
        <div style={{
          padding: '12px 14px',
          background: data.monthly_savings > 0
            ? 'var(--accent-green-bg)' : 'var(--accent-orange-bg)',
          border: `1px solid ${data.monthly_savings > 0
            ? 'var(--accent-green-border)' : 'var(--accent-orange-border)'}`,
          borderLeft: `3px solid ${data.monthly_savings > 0
            ? 'var(--accent-green)' : 'var(--accent-orange)'}`,
          borderRadius: 6, fontSize: 12, color: 'var(--text-primary)',
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 8 }}>
            <SummaryTile label="New payment" value={`${fmtRounded(data.refinanced.payment)}/mo`}
              sub={`was ${fmtRounded(data.current.payment)}/mo`} />
            <SummaryTile label="Monthly savings"
              value={`${data.monthly_savings >= 0 ? '+' : '−'}${fmtRounded(Math.abs(data.monthly_savings))}/mo`}
              tone={data.monthly_savings > 0 ? null : 'warn'} />
            <SummaryTile label="Lifetime interest saved" value={fmtRounded(data.lifetime_interest_saved)}
              sub={`net of ${fmtRounded(data.refinanced.closing_costs)} closing`} />
          </div>
          {data.breakeven_months !== null && data.breakeven_months > 0 && (
            <div style={{ fontSize: 12 }}>
              <strong>Break-even on closing costs:</strong>{' '}
              {data.breakeven_months} months{' '}
              ({Math.floor(data.breakeven_months / 12)}y {data.breakeven_months % 12}mo).{' '}
              Lifetime net (incl closing): <strong>{fmtRounded(data.lifetime_total_paid_diff)}</strong>{' '}
              {data.lifetime_total_paid_diff > 0 ? 'saved' : 'cost'}.
            </div>
          )}
          {data.monthly_savings <= 0 && (
            <div style={{ fontSize: 12 }}>
              New payment is higher than current — this likely means a shorter term.
              Whether it's worth it depends on lifetime interest savings vs. cashflow tightening.
            </div>
          )}
        </div>
      )}
    </div>
  )
}


/* ─────────────────────────── PMI drop-off ─────────────────────────── */

function PmiDropoffPanel({ loan, override }) {
  // Stored per-loan in localStorage so the user enters once.
  const [purchasePrice, setPurchasePrice] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`loan-pmi-${loan.id}`) || 'null')?.price || '' }
    catch { return '' }
  })
  const [pmiCost, setPmiCost] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`loan-pmi-${loan.id}`) || 'null')?.cost || 0 }
    catch { return 0 }
  })
  const [data, setData] = useState(null)

  useEffect(() => {
    if (!purchasePrice) { setData(null); return }
    localStorage.setItem(
      `loan-pmi-${loan.id}`,
      JSON.stringify({ price: purchasePrice, cost: pmiCost }),
    )
    const params = {
      original_purchase_price: Number(purchasePrice),
      pmi_monthly_cost: Number(pmiCost) || 0,
    }
    if (override.rate) params.rate_override = override.rate
    if (override.payment) params.payment_override = override.payment
    const t = setTimeout(() => {
      getLoanPmiDropoff(loan.id, params).then(setData).catch(() => {})
    }, 250)
    return () => clearTimeout(t)
  }, [loan.id, purchasePrice, pmiCost, override.rate, override.payment])

  return (
    <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1px dashed var(--border-color, rgba(255,255,255,0.06))' }}>
      <div style={{
        fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
        textTransform: 'uppercase', color: 'var(--text-muted)',
        marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <Shield size={12} /> PMI drop-off
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Original purchase price ${' '}
          <input type="number" min={0} step={1000}
            value={purchasePrice}
            onChange={e => setPurchasePrice(e.target.value)}
            placeholder="320000"
            style={refiInputStyle} />
        </label>
        <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          PMI cost $/mo{' '}
          <input type="number" min={0} step={5}
            value={pmiCost}
            onChange={e => setPmiCost(e.target.value)}
            placeholder="125"
            style={refiInputStyle} />
        </label>
      </div>
      {data && (
        <div style={{
          padding: '12px 14px',
          background: data.already_below
            ? 'var(--accent-green-bg)' : 'var(--accent-blue-bg)',
          border: `1px solid ${data.already_below
            ? 'var(--accent-green-border)' : 'var(--accent-blue-border)'}`,
          borderLeft: `3px solid ${data.already_below
            ? 'var(--accent-green)' : 'var(--accent-blue)'}`,
          borderRadius: 6, fontSize: 12, color: 'var(--text-primary)',
        }}>
          {data.already_below ? (
            <span>
              <strong style={{ color: 'var(--accent-green)' }}>You're already below {Math.round(data.ltv_threshold * 100)}% LTV.</strong>{' '}
              If your bank is still charging PMI, request cancellation in writing —
              federal HPA gives you the right.
            </span>
          ) : (
            <span>
              PMI cancels at month <strong>{data.months_until_dropoff}</strong>{' '}
              (<strong>{data.dropoff_date}</strong>) when balance crosses{' '}
              <strong>{fmtRounded(data.threshold_balance)}</strong> ({Math.round(data.ltv_threshold * 100)}% LTV).
              {data.estimated_monthly_savings > 0 && (
                <> At {fmtRounded(data.estimated_monthly_savings)}/mo, that's{' '}
                  <strong style={{ color: 'var(--accent-green)' }}>{fmtRounded(data.estimated_lifetime_savings)}</strong>{' '}
                  in lifetime savings.
                </>
              )}
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                Banks should auto-cancel at 78% LTV but often miss the 80% borrower-request window. Set a calendar reminder for a few months before the date and request cancellation in writing.
              </div>
            </span>
          )}
        </div>
      )}
    </div>
  )
}


/* ─────────────────────────── HELOC ──────────────────────────────── */

/**
 * HELOC two-phase modeling: surfaces the payment-shock that hits when
 * the interest-only draw period ends and the loan converts to P+I
 * repayment. Most HELOC borrowers don't realize the monthly payment
 * can 2-3× overnight when this happens — that's the whole point of
 * this panel.
 *
 * User inputs (persisted per-loan to localStorage):
 *   draw_period_months_remaining: months left in interest-only phase.
 *     0 = already in repayment.
 *   repayment_period_months: term length after draw ends. Typical
 *     15-20 yrs (180-240 mo) for a HELOC.
 *
 * Payment-shock callout is the headline output. Then a small
 * trajectory chart shows balance over time across both phases with a
 * vertical mark at the phase boundary so the eye reads the transition.
 */
function HelocPanel({ loan, override }) {
  const HELOC_KEY = `loan-heloc-${loan.id}`
  const stored = (() => {
    try { return JSON.parse(localStorage.getItem(HELOC_KEY) || 'null') || {} }
    catch { return {} }
  })()
  const [drawMonths, setDrawMonths] = useState(stored.drawMonths ?? 60)
  const [repayMonths, setRepayMonths] = useState(stored.repayMonths ?? 240)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    localStorage.setItem(HELOC_KEY, JSON.stringify({ drawMonths, repayMonths }))
    setLoading(true)
    setError(null)
    const params = {
      draw_period_months_remaining: Number(drawMonths) || 0,
      repayment_period_months: Number(repayMonths) || 240,
    }
    if (override.rate) params.rate_override = override.rate
    if (override.payment) params.payment_override = override.payment
    const t = setTimeout(() => {
      getLoanHeloc(loan.id, params)
        .then(setData)
        .catch(e => setError(e.message))
        .finally(() => setLoading(false))
    }, 250)
    return () => clearTimeout(t)
  }, [loan.id, drawMonths, repayMonths, override.rate, override.payment])

  const chartData = useMemo(() => {
    if (!data?.schedule) return []
    const stride = Math.max(1, Math.floor(data.schedule.length / 240))
    const today = new Date()
    return data.schedule.filter((_, i) => i % stride === 0).map(r => ({
      month: r.month,
      year: today.getFullYear() + r.month / 12,
      balance: r.ending_balance,
      payment: r.payment,
      phase: r.phase,
    }))
  }, [data])

  // Find the phase-boundary year for the reference line.
  const boundaryYear = useMemo(() => {
    if (!data?.payment_shock) return null
    const drawMo = Number(drawMonths) || 0
    if (drawMo <= 0) return null
    return new Date().getFullYear() + drawMo / 12
  }, [data, drawMonths])

  const shock = data?.payment_shock
  const inDrawNow = (Number(drawMonths) || 0) > 0
  const shockMultiple = shock?.shock_multiple || 1
  const shockTone = shockMultiple >= 2 ? 'orange' : (shockMultiple >= 1.3 ? 'yellow' : 'green')

  return (
    <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1px dashed var(--border-color, rgba(255,255,255,0.06))' }}>
      <div style={{
        fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
        textTransform: 'uppercase', color: 'var(--text-muted)',
        marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <Zap size={12} /> HELOC two-phase modeling
      </div>
      <div style={{
        fontSize: 11, color: 'var(--text-muted)', marginBottom: 10,
      }}>
        HELOCs are interest-only during the draw period (typically 10 yrs from
        origination), then convert to P+I repayment. The payment shock at the
        boundary catches a lot of borrowers off-guard.
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Months left in draw period{' '}
          <input type="number" min={0} max={240} step={1}
            value={drawMonths}
            onChange={e => setDrawMonths(e.target.value)}
            placeholder="60"
            style={refiInputStyle} />
        </label>
        <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Repayment period (months){' '}
          <input type="number" min={12} max={480} step={12}
            value={repayMonths}
            onChange={e => setRepayMonths(e.target.value)}
            placeholder="240"
            style={refiInputStyle} />
        </label>
      </div>
      {error && (
        <div style={{ fontSize: 11, color: 'var(--accent-orange)', marginBottom: 6 }}>{error}</div>
      )}
      {loading && !data && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', marginRight: 6 }} />
          Computing HELOC schedule…
        </div>
      )}
      {data && shock && inDrawNow && (
        <div style={{
          padding: '12px 14px',
          background: `var(--accent-${shockTone}-bg)`,
          border: `1px solid var(--accent-${shockTone}-border)`,
          borderLeft: `3px solid var(--accent-${shockTone})`,
          borderRadius: 6, fontSize: 12, color: 'var(--text-primary)',
          marginBottom: 12,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 6, color: `var(--accent-${shockTone})` }}>
            Payment shock at draw → repayment boundary
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 8 }}>
            <SummaryTile label="Today's payment (interest-only)"
              value={`${fmtRounded(shock.draw_payment)}/mo`}
              sub="while in draw period" />
            <SummaryTile label="After draw ends"
              value={`${fmtRounded(shock.repayment_payment)}/mo`}
              sub={shock.shock_date}
              tone={shockMultiple >= 1.3 ? 'warn' : null} />
            <SummaryTile label="Shock multiple"
              value={`${shockMultiple.toFixed(2)}×`}
              sub={`+${fmtRounded(shock.shock_amount)}/mo`}
              tone={shockMultiple >= 1.3 ? 'warn' : null} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {shockMultiple >= 2 ? (
              <>
                <strong style={{ color: 'var(--accent-orange)' }}>Significant shock.</strong>{' '}
                Plan now: either pay extra during draw to reduce balance, refinance into a HELOAN before the conversion,
                or build cashflow margin to absorb the higher payment.
              </>
            ) : shockMultiple >= 1.3 ? (
              <>
                <strong style={{ color: 'var(--accent-yellow)' }}>Moderate shock.</strong>{' '}
                Worth budgeting for now so it doesn't blindside you when the draw period ends.
              </>
            ) : (
              <>Shock is mild — your draw payment is already close to the future P+I.</>
            )}
          </div>
        </div>
      )}
      {data && !inDrawNow && (
        <div style={{
          padding: '12px 14px',
          background: 'var(--accent-blue-bg)',
          border: '1px solid var(--accent-blue-border)',
          borderLeft: '3px solid var(--accent-blue)',
          borderRadius: 6, fontSize: 12, color: 'var(--text-primary)',
          marginBottom: 12,
        }}>
          Already in repayment phase — schedule below is straight P+I amortization
          over {repayMonths} months.
        </div>
      )}
      {data && (
        <>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 12, marginBottom: 12,
          }}>
            <SummaryTile label="Total payments"
              value={String(data.summary.months)}
              sub={`${Math.floor(data.summary.months / 12)}y ${data.summary.months % 12}mo to payoff`} />
            <SummaryTile label="Lifetime interest"
              value={fmtRounded(data.summary.total_interest)}
              sub="across both phases" tone="warn" />
            <SummaryTile label="Payoff date"
              value={data.summary.payoff_date || '—'}
              sub={data.summary.months > 0 ? 'fully amortized' : 'no schedule'} />
          </div>
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 5, right: 16, bottom: 5, left: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color, rgba(255,255,255,0.08))" />
                <XAxis
                  dataKey="year"
                  type="number" domain={['dataMin', 'dataMax']}
                  stroke="var(--text-muted)" fontSize={11}
                  tickFormatter={(y) => String(Math.round(y))}
                />
                <YAxis
                  stroke="var(--text-muted)" fontSize={11}
                  tickFormatter={(v) => `$${Math.round(v / 1000)}k`}
                />
                <Tooltip
                  formatter={(v, n) => [fmtRounded(v), n === 'balance' ? 'Balance' : n]}
                  labelFormatter={(y) => `Year ${Math.round(y)}`}
                  contentStyle={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-color, rgba(255,255,255,0.15))',
                    borderRadius: 6, fontSize: 12,
                  }}
                />
                <Area
                  type="monotone" dataKey="balance" name="Remaining balance"
                  stroke="var(--accent-purple)" fill="var(--accent-purple-bg, var(--accent-blue-bg))"
                  strokeWidth={2}
                />
                {boundaryYear && (
                  <ReferenceLine
                    x={boundaryYear}
                    stroke="var(--accent-orange)"
                    strokeDasharray="4 3"
                    label={{
                      value: 'Repayment begins',
                      position: 'top',
                      fill: 'var(--accent-orange)',
                      fontSize: 11,
                    }}
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  )
}


const refiInputStyle = {
  width: 100, padding: '4px 6px', fontSize: 12,
  background: 'var(--bg-input)',
  border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
  borderRadius: 4, color: 'var(--text-primary)',
}


/* ─────────────────────── Multi-loan timeline ─────────────────────── */

/**
 * Stacked balance trajectory for every loan with computable
 * amortization (has rate + payment). Renders as a stacked area chart
 * so the eye reads "which loan eats up cashflow over the next N years."
 * Each layer collapses to zero when its loan pays off, dramatically
 * showing the freed-cashflow events.
 *
 * Uses the existing /amortization endpoint per loan, fetched in
 * parallel. Sample-down to <= 240 months for chart performance.
 */
function MultiLoanTimeline({ loans, overrides }) {
  const [series, setSeries] = useState({})  // {loanId: [{month, balance}]}
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const eligibleLoans = loans.filter(l => l.months_remaining && l.monthly_payment)
    if (eligibleLoans.length === 0) {
      setLoading(false)
      return
    }
    Promise.all(eligibleLoans.map(loan => {
      const o = overrides[loan.id] || {}
      const params = {}
      if (o.rate) params.rate_override = o.rate
      if (o.payment) params.payment_override = o.payment
      return getLoanAmortization(loan.id, params)
        .then(d => [loan.id, d.schedule.map(r => ({
          month: r.month, balance: r.ending_balance,
        }))])
        .catch(() => [loan.id, []])
    })).then(results => {
      setSeries(Object.fromEntries(results))
      setLoading(false)
    })
  }, [loans.map(l => l.id).join(','), JSON.stringify(overrides)])

  // Merge into a single time-series for the chart. For each month X
  // present in ANY series, sum each loan's balance (0 if past payoff).
  const chartData = useMemo(() => {
    const maxMonth = Math.max(0, ...Object.values(series).map(s => s.length))
    const stride = Math.max(1, Math.floor(maxMonth / 240))
    const today = new Date()
    const rows = []
    for (let m = 1; m <= maxMonth; m += stride) {
      const row = {
        month: m,
        year: Math.floor(m / 12) + today.getFullYear(),
        total: 0,
      }
      for (const [loanId, sched] of Object.entries(series)) {
        const point = sched[m - 1]
        const bal = point ? point.balance : 0
        row[loanId] = bal
        row.total += bal
      }
      rows.push(row)
    }
    return rows
  }, [series])

  if (loading) return null

  // Color palette — use the existing accent vars cyclically.
  const palette = [
    'var(--accent-blue)', 'var(--accent-green)',
    'var(--accent-yellow)', 'var(--accent-orange)',
    'var(--accent-purple)',
  ]
  const eligibleLoans = loans.filter(l => series[l.id]?.length > 0)

  return (
    <div style={{
      marginTop: 16,
      padding: 16,
      background: 'var(--bg-card)',
      border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
      borderRadius: 8,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 12,
      }}>
        <div>
          <div style={{
            fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
            textTransform: 'uppercase', color: 'var(--text-muted)',
          }}>
            All loans · stacked balance over time
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
            Each layer represents one loan's remaining balance. As loans pay off, layers collapse — visible drops mark freed monthly cashflow.
          </div>
        </div>
      </div>
      <div style={{ height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 5, right: 16, bottom: 5, left: 16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color, rgba(255,255,255,0.08))" />
            <XAxis
              dataKey="year"
              type="number" domain={['dataMin', 'dataMax']}
              stroke="var(--text-muted)" fontSize={11}
              tickFormatter={(y) => String(y)}
            />
            <YAxis
              stroke="var(--text-muted)" fontSize={11}
              tickFormatter={(v) => `$${Math.round(v / 1000)}k`}
            />
            <Tooltip
              formatter={(v) => fmtRounded(v)}
              labelFormatter={(y) => `Year ${y}`}
              contentStyle={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-color, rgba(255,255,255,0.15))',
                borderRadius: 6, fontSize: 12,
              }}
            />
            {eligibleLoans.map((loan, idx) => (
              <Area key={loan.id}
                type="monotone" dataKey={loan.id}
                name={loan.name}
                stackId="loans"
                stroke={palette[idx % palette.length]}
                fill={palette[idx % palette.length]}
                fillOpacity={0.35}
                strokeWidth={1.5}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {/* Legend with totals */}
      <div style={{
        display: 'flex', gap: 16, flexWrap: 'wrap',
        marginTop: 8, fontSize: 11, color: 'var(--text-secondary)',
      }}>
        {eligibleLoans.map((loan, idx) => (
          <div key={loan.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              display: 'inline-block', width: 10, height: 10,
              background: palette[idx % palette.length], borderRadius: 2,
            }} />
            <span>{loan.name}</span>
            <span style={{ color: 'var(--text-muted)' }}>
              ({Math.floor(loan.months_remaining / 12)}y {loan.months_remaining % 12}mo)
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}


function SummaryTile({ label, value, sub, tone }) {
  const valueColor = tone === 'warn' ? 'var(--accent-orange)' : 'var(--text-primary)'
  return (
    <div style={{
      padding: '10px 12px',
      background: 'var(--bg-input)',
      border: '1px solid var(--border-color, rgba(255,255,255,0.06))',
      borderRadius: 6,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
        textTransform: 'uppercase', color: 'var(--text-muted)',
      }}>
        {label}
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color: valueColor, marginTop: 2 }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
          {sub}
        </div>
      )}
    </div>
  )
}
